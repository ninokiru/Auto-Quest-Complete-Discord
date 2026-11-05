import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Quest } from '@/api/tauri'
import { useQuestsStore } from './quests'

const mocks = vi.hoisted(() => ({
  getPlatformCapabilities: vi.fn(),
  getQuestsFull: vi.fn(),
  getQuestTaskStatuses: vi.fn(),
  onQuestComplete: vi.fn(),
  onQuestError: vi.fn(),
  onQuestProgress: vi.fn(),
  startVideoQuest: vi.fn(),
  stopQuest: vi.fn(),
}))

vi.mock('@/api/tauri', () => ({
  getPlatformCapabilities: mocks.getPlatformCapabilities,
  getQuestsFull: mocks.getQuestsFull,
  getQuestTaskStatuses: mocks.getQuestTaskStatuses,
  onQuestComplete: mocks.onQuestComplete,
  onQuestError: mocks.onQuestError,
  onQuestProgress: mocks.onQuestProgress,
  startVideoQuest: mocks.startVideoQuest,
  stopQuest: mocks.stopQuest,
}))

vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }))

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  }
}

function status() {
  return { enrolled_at: '2026-10-01', completed_at: null, claimed_at: null, progress: {} }
}

function videoQuest(id: string): Quest {
  return {
    id,
    config: {
      messages: { quest_name: id },
      task_config: { tasks: { WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 } } },
    },
    user_status: status(),
  } as Quest
}

function gameQuest(id: string): Quest {
  return {
    id,
    config: {
      application: { id: `app-${id}`, name: id, link: '' },
      messages: { quest_name: id },
      task_config: { tasks: { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 } } },
    },
    user_status: status(),
  } as Quest
}

let complete!: () => Promise<void>

async function finishVideo(store: ReturnType<typeof useQuestsStore>, id: string) {
  await store.startVideo(id, 60, 0)
  await complete()
}

describe('video burst pacing', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.getPlatformCapabilities.mockResolvedValue({
      os: 'windows', defaultGameQuestMode: 'simulate', executableOsPriority: ['win32'],
    })
    mocks.getQuestsFull.mockResolvedValue({ quests: [], excluded_quests: [] })
    mocks.getQuestTaskStatuses.mockResolvedValue([])
    mocks.startVideoQuest.mockResolvedValue(undefined)
    mocks.stopQuest.mockResolvedValue(undefined)
    mocks.onQuestProgress.mockResolvedValue(() => undefined)
    mocks.onQuestError.mockResolvedValue(() => undefined)
    mocks.onQuestComplete.mockImplementation(async (callback: () => Promise<void>) => {
      complete = callback
      return () => undefined
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rests one to two minutes after three fast video quests', async () => {
    const store = useQuestsStore()
    store.speedMultiplier = 6

    await finishVideo(store, 'v1')
    await finishVideo(store, 'v2')
    expect(store.videoRestActive).toBe(false)

    await finishVideo(store, 'v3')

    expect(store.videoRestActive).toBe(true)
    expect(store.videoRestWaiting).toBe(true)
    expect(store.videoRestSeconds).toBeGreaterThanOrEqual(60)
    expect(store.videoRestSeconds).toBeLessThanOrEqual(120)
    // Only video work waits for the break; everything else keeps running.
    expect(store.videoPacingBlocksQuest(videoQuest('next'))).toBe(true)
    expect(store.videoPacingBlocksQuest(gameQuest('next'))).toBe(false)

    store.acknowledgeVideoRest()
    expect(store.videoPacingBlocksQuest(videoQuest('next'))).toBe(false)
    // An accepted break holds nothing up, so the countdown chip retires too.
    expect(store.videoRestWaiting).toBe(false)

    await vi.advanceTimersByTimeAsync(121_000)
    expect(store.videoRestActive).toBe(false)
  })

  it('retires the break when the speed drops back under 5x', async () => {
    const store = useQuestsStore()
    store.speedMultiplier = 5
    await finishVideo(store, 'v1')
    await finishVideo(store, 'v2')
    await finishVideo(store, 'v3')
    expect(store.videoRestActive).toBe(true)

    store.speedMultiplier = 3

    expect(store.videoRestActive).toBe(false)
    expect(store.videoPacingBlocksQuest(videoQuest('next'))).toBe(false)
  })

  it('keeps the break under a minute window', async () => {
    const store = useQuestsStore()
    store.speedMultiplier = 10

    await finishVideo(store, 'v1')
    await finishVideo(store, 'v2')
    await vi.advanceTimersByTimeAsync(61_000)
    await finishVideo(store, 'v3')

    expect(store.videoRestActive).toBe(false)
  })

  it('does not pace video quests below 5x', async () => {
    const store = useQuestsStore()
    store.speedMultiplier = 4

    await finishVideo(store, 'v1')
    await finishVideo(store, 'v2')
    await finishVideo(store, 'v3')

    expect(store.videoRestActive).toBe(false)
  })

  it('drops the pacing state when the account signs out', async () => {
    const store = useQuestsStore()
    store.speedMultiplier = 5
    await finishVideo(store, 'v1')
    await finishVideo(store, 'v2')
    await finishVideo(store, 'v3')
    expect(store.videoRestActive).toBe(true)

    store.resetForLogout()

    expect(store.videoRestActive).toBe(false)
    expect(store.videoRestSeconds).toBe(0)
  })
})
