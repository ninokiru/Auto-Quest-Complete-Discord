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

function runningIds(store: ReturnType<typeof useQuestsStore>): string[] {
  return store.runningQuests.map(slot => slot.questId)
}

describe('parallel quest slots', () => {
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
    mocks.onQuestComplete.mockResolvedValue(() => undefined)
    mocks.onQuestError.mockResolvedValue(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps every started quest in its own slot', async () => {
    const store = useQuestsStore()
    await store.startVideo('first', 60, 0)
    await store.startVideo('second', 120, 0)

    expect(runningIds(store)).toEqual(['first', 'second'])
    // The single-quest readers follow the first slot, so existing views keep working.
    expect(store.activeQuestId).toBe('first')
    expect(store.activeQuestTargetDuration).toBe(60)
    expect(store.runningQuests[1].targetDuration).toBe(120)
  })

  it('refuses a sixth concurrent quest', async () => {
    const store = useQuestsStore()
    for (let index = 0; index < 5; index++) {
      await store.startVideo(`quest-${index}`, 60, 0)
    }
    expect(runningIds(store)).toHaveLength(5)

    await expect(store.startVideo('quest-5', 60, 0)).rejects.toThrow('At most 5 quests')
    expect(runningIds(store)).toHaveLength(5)
    expect(store.error).toContain('At most 5 quests')
  })

  it('refuses to start a quest that already occupies a slot', async () => {
    const store = useQuestsStore()
    await store.startVideo('first', 60, 0)

    await expect(store.startVideo('first', 60, 0)).rejects.toThrow('already running')
    expect(runningIds(store)).toEqual(['first'])
    expect(mocks.startVideoQuest).toHaveBeenCalledTimes(1)
  })

  it('stops one quest without touching the others', async () => {
    const store = useQuestsStore()
    await store.startVideo('first', 60, 0)
    await store.startVideo('second', 60, 0)

    await store.stopRunningQuest('first')

    expect(mocks.stopQuest).toHaveBeenCalledWith('first')
    expect(runningIds(store)).toEqual(['second'])
    expect(store.activeQuestId).toBe('second')
    expect(store.stopping).toBe(false)
  })

  it('clears every slot on logout without stopping quests again', () => {
    const store = useQuestsStore()
    store.addToQueue({ id: 'queued' } as Quest)
    store.runningQuests.push({
      questId: 'first',
      type: 'video',
      targetDuration: 60,
      serverProgress: 10,
      localProgress: 10,
      gameExe: null,
      simulationAppId: null,
      rpcConnected: false,
      hasBackendTask: true,
    })

    store.resetForLogout()

    expect(store.runningQuests).toEqual([])
    expect(store.questQueue).toEqual([])
    expect(mocks.stopQuest).not.toHaveBeenCalled()
  })
})
