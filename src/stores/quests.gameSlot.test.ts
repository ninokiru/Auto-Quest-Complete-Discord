import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Quest } from '@/api/tauri'
import { useQuestsStore, type RunningQuest } from './quests'

const mocks = vi.hoisted(() => ({
  getPlatformCapabilities: vi.fn(),
  getQuestsFull: vi.fn(),
  getQuestTaskStatuses: vi.fn(),
  onQuestComplete: vi.fn(),
  onQuestError: vi.fn(),
  onQuestProgress: vi.fn(),
  startCdpQuest: vi.fn(),
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
  startCdpQuest: mocks.startCdpQuest,
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

describe('game quest slots per account', () => {
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

  it('runs heartbeat game quests in parallel with a video quest', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    store.addToQueue(gameQuest('game-a'))
    store.addToQueue(gameQuest('game-b'))
    store.addToQueue(videoQuest('video'))

    await store.startQueue()

    expect(startedIds(store)).toEqual(['game-a', 'game-b', 'video'])
    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['game-a', 'game-b', 'video'])
    // A queue item leaves only when its quest is finalized.
    expect(store.questQueue.map(item => item.id)).toEqual(['game-a', 'game-b', 'video'])
    expect(store.error).toBeNull()
  })

  it('starts a queued game quest when a shared slot frees up', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    store.maxParallelQuests = 20
    for (let index = 0; index < 21; index += 1) {
      store.addToQueue(gameQuest(`game-${index}`))
    }

    await store.startQueue()
    expect(store.runningQuests).toHaveLength(20)
    expect(startedIds(store)).toHaveLength(20)

    await store.stopRunningQuest('game-0')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(startedIds(store)).toHaveLength(21)
    expect(store.runningQuests.length).toBeLessThanOrEqual(20)
  })

  it('refuses the twenty-first game quest started by hand', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    store.maxParallelQuests = 20
    for (let index = 0; index < 20; index += 1) {
      await store.startPlay(gameQuest(`game-${index}`), 600, 0)
    }

    await expect(store.startPlay(gameQuest('game-20'), 600, 0))
      .rejects.toThrow(/At most 20/)
    expect(store.runningQuests).toHaveLength(20)
  })

  it('lets up to twenty CDP play quests share the account', async () => {
    const store = useQuestsStore()
    // The platform default is applied once capabilities arrive; let it settle
    // first or it overwrites the mode set on the next line.
    await store.initPlatformCapabilities()
    store.gameQuestMode = 'cdp'
    store.maxParallelQuests = 20
    for (let index = 0; index < 20; index += 1) {
      await store.startPlay(gameQuest(`cdp-${index}`), 600, 0)
    }
    expect(store.runningQuests).toHaveLength(20)

    await expect(store.startPlay(gameQuest('cdp-20'), 600, 0))
      .rejects.toThrow(/At most 20/)
    expect(store.runningQuests).toHaveLength(20)
  })

  it('keeps a video quest running alongside a game quest', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    await store.startPlay(gameQuest('game-a'), 600, 0)

    await store.startVideo('video', 60, 0)

    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['game-a', 'video'])
  })

  it('runs simulated quests for different games and queues the same title', () => {
    const store = useQuestsStore()
    const slot = (id: string, patch: Partial<RunningQuest> = {}): RunningQuest => ({
      questId: id,
      type: 'game',
      targetDuration: 600,
      progressUnit: 'time',
      taskKey: 'PLAY_ON_DESKTOP',
      serverProgress: 0,
      localProgress: 0,
      gameExe: null,
      simulationAppId: null,
      rpcConnected: false,
      hasBackendTask: true,
      ...patch,
    })

    expect(store.gameSlotBlockReason('app-a')).toBe('none')

    // A simulated quest occupies its own title, not the whole account.
    store.gameQuestMode = 'simulate'
    store.runningQuests.push(slot('sim-a', { simulationAppId: 'app-a' }))
    expect(store.gameSlotBusy('app-b')).toBe(false)
    expect(store.gameSlotBlockReason('app-b')).toBe('none')
    expect(store.gameSlotBusy('app-a')).toBe(true)
    expect(store.gameSlotBlockReason('app-a')).toBe('same-title')

    // A CDP or heartbeat quest cannot be joined by a simulated one.
    store.runningQuests.splice(0)
    store.runningQuests.push(slot('cdp', { cdpPlay: true }))
    expect(store.gameSlotBlockReason('app-b')).toBe('simulated')

    // A cloud-game activity holds the client on its own.
    store.runningQuests.splice(0)
    store.runningQuests.push(slot('activity', { type: 'activity' }))
    expect(store.gameSlotBlockReason('app-b')).toBe('activity')

    // Twenty shared game quests really is the cap.
    store.gameQuestMode = 'cdp'
    store.runningQuests.splice(0)
    for (let index = 0; index < 20; index += 1) {
      store.runningQuests.push(slot(`game-${index}`, { cdpPlay: true }))
    }
    expect(store.gameSlotBlockReason()).toBe('limit')
  })

  it('uses three parallel quests until the cap is raised', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    expect(store.maxParallelQuests).toBe(3)

    await store.startPlay(gameQuest('game-a'), 600, 0)
    await store.startPlay(gameQuest('game-b'), 600, 0)
    await store.startPlay(gameQuest('game-c'), 600, 0)
    await expect(store.startPlay(gameQuest('game-d'), 600, 0))
      .rejects.toThrow(/At most 3 quests/)

    store.maxParallelQuests = 4
    await store.startPlay(gameQuest('game-d'), 600, 0)
    expect(store.runningQuests).toHaveLength(4)
  })

  it('starts only up to the cap from the queue', async () => {
    const store = useQuestsStore()
    store.gameQuestMode = 'heartbeat'
    for (let index = 0; index < 5; index += 1) {
      store.addToQueue(gameQuest(`game-${index}`))
    }

    await store.startQueue()

    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['game-0', 'game-1', 'game-2'])
    expect(store.questQueue.map(item => item.id)).toHaveLength(5)
  })
})
