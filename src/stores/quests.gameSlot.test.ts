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
  startGameHeartbeatQuest: vi.fn(),
  startPlayActivityQuest: vi.fn(),
  startGameSimulationUsage: vi.fn(),
  startVideoQuest: vi.fn(),
  stopGameSimulationUsage: vi.fn(),
  stopQuest: vi.fn(),
}))

vi.mock('@/api/tauri', () => ({
  getPlatformCapabilities: mocks.getPlatformCapabilities,
  getQuestsFull: mocks.getQuestsFull,
  getQuestTaskStatuses: mocks.getQuestTaskStatuses,
  onQuestComplete: mocks.onQuestComplete,
  onQuestError: mocks.onQuestError,
  onQuestProgress: mocks.onQuestProgress,
  startGameHeartbeatQuest: mocks.startGameHeartbeatQuest,
  startPlayActivityQuest: mocks.startPlayActivityQuest,
  startGameSimulationUsage: mocks.startGameSimulationUsage,
  startVideoQuest: mocks.startVideoQuest,
  stopGameSimulationUsage: mocks.stopGameSimulationUsage,
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

function questStatus() {
  return { enrolled_at: '2026-10-01', completed_at: null, claimed_at: null, progress: {} }
}

function gameQuest(id: string): Quest {
  return {
    id,
    config: {
      application: { id: `app-${id}`, name: id, link: '' },
      messages: { quest_name: id },
      task_config: { tasks: { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 } } },
    },
    user_status: questStatus(),
  } as Quest
}

function cloudGameQuest(id: string): Quest {
  return {
    id,
    config: {
      application: { id: `app-${id}`, name: id, link: '' },
      messages: { quest_name: id },
      task_config: { tasks: { PLAY_ACTIVITY: { type: 'PLAY_ACTIVITY', target: 900 } } },
    },
    user_status: questStatus(),
  } as Quest
}

function videoQuest(id: string): Quest {
  return {
    id,
    config: {
      messages: { quest_name: id },
      task_config: { tasks: { WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 } } },
    },
    user_status: questStatus(),
  } as Quest
}

function startedIds(store: ReturnType<typeof useQuestsStore>): string[] {
  return mocks.startGameHeartbeatQuest.mock.calls.map(call => String(call[0]))
    .concat(store.runningQuests.filter(slot => slot.type === 'video').map(slot => slot.questId))
}

describe('one game quest at a time per account', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.getPlatformCapabilities.mockResolvedValue({
      os: 'windows', defaultGameQuestMode: 'heartbeat', executableOsPriority: ['win32'],
    })
    mocks.getQuestsFull.mockResolvedValue({ quests: [], excluded_quests: [] })
    mocks.getQuestTaskStatuses.mockResolvedValue([])
    mocks.startGameHeartbeatQuest.mockResolvedValue(undefined)
    mocks.startPlayActivityQuest.mockResolvedValue(undefined)
    mocks.startGameSimulationUsage.mockResolvedValue(true)
    mocks.stopGameSimulationUsage.mockResolvedValue(undefined)
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

  it('runs one game quest and leaves the next one queued instead of failing it', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    store.addToQueue(gameQuest('game-a'))
    store.addToQueue(gameQuest('game-b'))
    store.addToQueue(videoQuest('video'))

    await store.startQueue()

    expect(startedIds(store)).toEqual(['game-a', 'video'])
    // A video quest is not a game quest, so the running one does not hold it back.
    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['game-a', 'video'])
    // Deferred, not dropped: the item is still there for the next pass.
    expect(store.questQueue.map(item => item.id)).toEqual(['game-a', 'game-b', 'video'])
    expect(store.error).toBeNull()
  })

  it('starts the deferred game quest once the running one finishes', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    store.addToQueue(gameQuest('game-a'))
    store.addToQueue(gameQuest('game-b'))

    await store.startQueue()
    expect(startedIds(store)).toEqual(['game-a'])

    mocks.getQuestTaskStatuses.mockResolvedValue([
      { questId: 'game-a', accountId: null, own: true, state: 'finished', error: null },
    ])
    // One polling tick ends `game-a`; its completion re-triggers the queue.
    await vi.advanceTimersByTimeAsync(120_000)

    expect(startedIds(store)).toEqual(['game-a', 'game-b'])
    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['game-b'])
    expect(store.questQueue.map(item => item.id)).toEqual(['game-b'])
  })

  it('refuses a game quest started by hand while another one runs', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    await store.startPlay(gameQuest('game-a'), 600, 0)

    await expect(store.startPlay(gameQuest('game-b'), 600, 0))
      .rejects.toThrow('One game quest runs at a time')
    // A cloud-game Activity plays a game too, so it waits on the same slot.
    await expect(store.startPlayActivity(cloudGameQuest('cloud'), 900, 0))
      .rejects.toThrow('One game quest runs at a time')

    expect(startedIds(store)).toEqual(['game-a'])
    expect(mocks.startPlayActivityQuest).not.toHaveBeenCalled()
    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['game-a'])
  })

  it('keeps a video quest running alongside a game quest', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    await store.startPlay(gameQuest('game-a'), 600, 0)

    await store.startVideo('video', 60, 0)

    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['game-a', 'video'])
  })
})
