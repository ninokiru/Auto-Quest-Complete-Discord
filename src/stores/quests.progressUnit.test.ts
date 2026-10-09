import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { DetectableGame, Quest } from '@/api/tauri'
import type { SimulationExecutableResolution } from '@/utils/executables'
import { useQuestsStore } from './quests'

const mocks = vi.hoisted(() => ({
  checkCdpStatus: vi.fn(),
  createSimulatedGame: vi.fn(),
  fetchDetectableGames: vi.fn(),
  forceVideoProgress: vi.fn(),
  getPlatformCapabilities: vi.fn(),
  getQuestsFull: vi.fn(),
  getQuestTaskStatuses: vi.fn(),
  onQuestComplete: vi.fn(),
  onQuestError: vi.fn(),
  onQuestProgress: vi.fn(),
  resolveSimulationExecutable: vi.fn(),
  startCdpQuest: vi.fn(),
  startGameSimulationUsage: vi.fn(),
  startVideoQuest: vi.fn(),
  stopGameSimulationUsage: vi.fn(),
  stopQuest: vi.fn(),
}))

vi.mock('@/api/tauri', () => ({
  checkCdpStatus: mocks.checkCdpStatus,
  createSimulatedGame: mocks.createSimulatedGame,
  fetchDetectableGames: mocks.fetchDetectableGames,
  forceVideoProgress: mocks.forceVideoProgress,
  getPlatformCapabilities: mocks.getPlatformCapabilities,
  getQuestsFull: mocks.getQuestsFull,
  getQuestTaskStatuses: mocks.getQuestTaskStatuses,
  onQuestComplete: mocks.onQuestComplete,
  onQuestError: mocks.onQuestError,
  onQuestProgress: mocks.onQuestProgress,
  runSimulatedGame: vi.fn(),
  startCdpQuest: mocks.startCdpQuest,
  startGameSimulationUsage: mocks.startGameSimulationUsage,
  startVideoQuest: mocks.startVideoQuest,
  stopGameSimulationUsage: mocks.stopGameSimulationUsage,
  stopSimulatedGame: vi.fn(),
  stopQuest: mocks.stopQuest,
}))

vi.mock('@/utils/executables', () => ({
  resolveSimulationExecutable: mocks.resolveSimulationExecutable,
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

function questStatus(progress: Record<string, number>) {
  return {
    enrolled_at: '2026-10-01',
    completed_at: null,
    claimed_at: null,
    progress: Object.fromEntries(
      Object.entries(progress).map(([key, value]) => [key, { value }])
    ),
  }
}

/** Checkpoint Activity quest with `completed` checkpoints already banked server-side. */
function activityQuest(id: string, completed: number): Quest {
  return {
    id,
    config: {
      application: { id: 'app-activity', name: 'Activity Game', link: '' },
      messages: { quest_name: 'Activity Quest' },
      task_config: {
        tasks: { ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 } },
      },
    },
    user_status: questStatus({ ACHIEVEMENT_IN_ACTIVITY: completed }),
  }
}

function desktopPlayQuest(id: string): Quest {
  return {
    id,
    config: {
      application: { id: `app-${id}`, name: id, link: '' },
      messages: { quest_name: id },
      task_config: { tasks: { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 } } },
    },
    user_status: questStatus({}),
  }
}

/** Discord only credits this task for sessions on console hardware. */
function consoleOnlyQuest(id: string): Quest {
  return {
    id,
    config: {
      application: { id: `app-${id}`, name: id, link: '' },
      messages: { quest_name: id },
      task_config: { tasks: { PLAY_ON_XBOX: { type: 'PLAY_ON_XBOX', target: 600 } } },
    },
    user_status: questStatus({}),
  }
}

function videoQuest(id: string): Quest {
  return {
    id,
    config: {
      messages: { quest_name: id },
      task_config: { tasks: { WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 } } },
    },
    user_status: questStatus({}),
  }
}

function questList(...quests: Quest[]) {
  return { quests, excluded_quests: [] }
}

// The store advances its local bars from animation frames only, so the frames are
// queued here and run on demand: one loop then reads a single deterministic delta.
let frameCallbacks: FrameRequestCallback[] = []

function runFrame() {
  const pending = frameCallbacks
  frameCallbacks = []
  pending.forEach(callback => callback(Date.now()))
}

describe('quest progress units', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
    frameCallbacks = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.getPlatformCapabilities.mockResolvedValue({
      os: 'windows', defaultGameQuestMode: 'simulate', executableOsPriority: ['win32'],
    })
    mocks.getQuestsFull.mockResolvedValue(questList())
    mocks.getQuestTaskStatuses.mockResolvedValue([])
    mocks.checkCdpStatus.mockResolvedValue({ connected: true })
    mocks.startCdpQuest.mockResolvedValue(undefined)
    mocks.startVideoQuest.mockResolvedValue(undefined)
    mocks.stopQuest.mockResolvedValue(undefined)
    mocks.stopGameSimulationUsage.mockResolvedValue(undefined)
    mocks.startGameSimulationUsage.mockResolvedValue(undefined)
    mocks.forceVideoProgress.mockResolvedValue(undefined)
    mocks.createSimulatedGame.mockResolvedValue(undefined)
    mocks.fetchDetectableGames.mockResolvedValue([])
    mocks.onQuestProgress.mockResolvedValue(() => undefined)
    mocks.onQuestComplete.mockResolvedValue(() => undefined)
    mocks.onQuestError.mockResolvedValue(() => undefined)
    mocks.resolveSimulationExecutable.mockReturnValue({ kind: 'not_found' } satisfies SimulationExecutableResolution)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('counts a checkpoint Activity slot in checkpoints, not in seconds', async () => {
    const store = useQuestsStore()
    store.cdpAvailable = true

    await store.startActivity(activityQuest('activity', 1))

    const slot = store.runningQuests[0]
    expect(slot.type).toBe('activity')
    expect(slot.progressUnit).toBe('checkpoints')
    // The task target is a checkpoint count, so the slot carries that count.
    expect(slot.targetDuration).toBe(3)
    // Discord already banked one checkpoint, so the bar opens at that third.
    expect(slot.serverProgress).toBeCloseTo(33.33, 2)
    expect(slot.localProgress).toBeCloseTo(33.33, 2)
    // The backend is seeded with the completed checkpoint count, not a duration.
    expect(mocks.startCdpQuest.mock.calls[0][5]).toBe(1)
  })

  it('reads polled Activity progress as checkpoints instead of elapsed seconds', async () => {
    const store = useQuestsStore()
    store.cdpAvailable = true
    await store.startActivity(activityQuest('activity', 0))
    // The refreshed list now reports two of three checkpoints submitted.
    mocks.getQuestsFull.mockResolvedValue(questList(activityQuest('activity', 2)))

    // One polling tick is what drives a lone slot: the quest list plus the registry.
    await vi.advanceTimersByTimeAsync(120_000)

    expect(store.runningQuests[0].serverProgress).toBeCloseTo(66.67, 2)
  })

  it('paces a checkpoint slot by its checkpoint interval, not one percent per second', async () => {
    const store = useQuestsStore()
    store.cdpAvailable = true
    // Keep the polling cadence past the frame window so only the frame runs.
    store.gamePollingInterval = 300
    await store.startActivity(activityQuest('activity', 0))

    // The built-in checkpoint interval averages one checkpoint per 240 s, so one
    // checkpoint's worth of elapsed time moves the bar by exactly one third.
    await vi.advanceTimersByTimeAsync(240_000)
    runFrame()

    expect(store.runningQuests[0].localProgress).toBeCloseTo(33.33, 2)
  })

  it('drives a lone running quest to completion from the task registry', async () => {
    const store = useQuestsStore()
    await store.startVideo('first', 60, 0)
    expect(store.runningQuests).toHaveLength(1)
    mocks.getQuestTaskStatuses.mockResolvedValue([
      { questId: 'first', state: 'finished', error: null },
    ])

    await vi.advanceTimersByTimeAsync(120_000)

    expect(store.runningQuests).toEqual([])
    expect(store.activeQuestId).toBeNull()
    // A later tick must not tear the same quest down a second time.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(store.activeQuestId).toBeNull()
    expect(store.error).toBeNull()
  })

  it('consumes queue items whose start only reports a soft error', async () => {
    const store = useQuestsStore()
    mocks.fetchDetectableGames.mockResolvedValue([
      { id: 'app-first', name: 'First', executables: [] },
      { id: 'app-second', name: 'Second', executables: [] },
    ] satisfies DetectableGame[])
    store.addToQueue(desktopPlayQuest('first'))
    store.addToQueue(desktopPlayQuest('second'))

    await store.startQueue()

    // Each item is attempted exactly once, so a soft failure cannot re-pick it.
    expect(mocks.resolveSimulationExecutable).toHaveBeenCalledTimes(2)
    expect(store.questQueue).toEqual([])
    expect(store.runningQuests).toEqual([])
    expect(store.softError?.code).toBe('SIMULATION_EXECUTABLE_NOT_FOUND')
    expect(store.queuePauseReason).toBe('simulation_incompatible')
  })

  it('skips a console-only quest instead of queueing it', async () => {
    const store = useQuestsStore()
    store.addToQueue(consoleOnlyQuest('console'))
    store.addToQueue(videoQuest('video'))

    await store.startQueue()

    // The console quest never reaches a start attempt, and never holds a slot.
    expect(mocks.resolveSimulationExecutable).not.toHaveBeenCalled()
    expect(mocks.startVideoQuest).toHaveBeenCalledTimes(1)
    expect(store.softError?.questId).toBe('console')
    expect(store.softError?.gameName).toBe('console')
    expect(store.queuePauseReason).toBe('simulation_incompatible')
    expect(store.questQueue.map(item => item.id)).toEqual(['video'])
    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['video'])
  })
})
