import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { formatSimulationDuration, MAX_CONCURRENT_GAMES, useGameIdleStore } from './gameIdle'
import type { GameIdleStatus } from '@/api/tauri'

const mocks = vi.hoisted(() => ({
  getGameIdleStatus: vi.fn(),
  startGameIdle: vi.fn(),
  stopGameIdle: vi.fn(),
  onGameIdleStatus: vi.fn(),
  onGameSimulationHistoryUpdated: vi.fn(),
  quests: {
    cdpAvailable: true,
    cdpPort: 9223,
    initPlatformCapabilities: vi.fn().mockResolvedValue(undefined),
    initCdpMode: vi.fn().mockResolvedValue(undefined),
    getDetectableGames: vi.fn().mockResolvedValue([]),
    initSimulationPath: vi.fn().mockResolvedValue('C:/simulations'),
  },
}))

vi.mock('@/api/tauri', () => ({
  getGameIdleStatus: mocks.getGameIdleStatus,
  getGameSimulationHistory: vi.fn().mockResolvedValue([]),
  onGameIdleStatus: mocks.onGameIdleStatus,
  onGameSimulationHistoryUpdated: mocks.onGameSimulationHistoryUpdated,
  removeGameIdleQueueItem: vi.fn(),
  startGameIdle: mocks.startGameIdle,
  stopGameIdle: mocks.stopGameIdle,
}))

vi.mock('./quests', () => ({
  useQuestsStore: () => mocks.quests,
}))

function idleStatus(overrides: Partial<GameIdleStatus> = {}): GameIdleStatus {
  return {
    sessionId: 'session',
    mode: 'cdp',
    phase: 'stopped',
    playMinutes: 60,
    restMinutes: 0,
    concurrentGames: 1,
    lanes: [],
    recent: [],
    upcoming: [],
    accumulatedPlayedSeconds: 0,
    warning: null,
    ...overrides,
  }
}

describe('game idle store', () => {
  let storage: Map<string, string>

  beforeEach(() => {
    setActivePinia(createPinia())
    storage = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    vi.clearAllMocks()
    mocks.getGameIdleStatus.mockResolvedValue(null)
    mocks.stopGameIdle.mockResolvedValue(null)
    mocks.quests.getDetectableGames.mockResolvedValue([])
    mocks.quests.initSimulationPath.mockResolvedValue('C:/simulations')
    mocks.onGameIdleStatus.mockResolvedValue(() => undefined)
    mocks.onGameSimulationHistoryUpdated.mockResolvedValue(() => undefined)
    mocks.quests.cdpAvailable = true
  })

  it('defaults to 60/0 and chooses CDP when it is available', async () => {
    const store = useGameIdleStore()
    await store.initialize()

    expect(store.playMinutes).toBe(60)
    expect(store.restMinutes).toBe(0)
    expect(store.concurrentGames).toBe(1)
    expect(store.mode).toBe('cdp')
  })

  it('restores valid values and rejects fractional input', () => {
    storage.set('questHelper_gameIdlePlayMinutes', '90')
    storage.set('questHelper_gameIdleRestMinutes', '5')
    storage.set('questHelper_gameIdleConcurrentGames', '3')
    storage.set('questHelper_gameIdleMode', 'process')
    const store = useGameIdleStore()

    expect(store.playMinutes).toBe(90)
    expect(store.restMinutes).toBe(5)
    expect(store.concurrentGames).toBe(3)
    expect(store.mode).toBe('process')
    store.playMinutes = 1.5
    expect(store.validateConfig()).toBe('play_minutes')
    store.playMinutes = 1
    store.restMinutes = -1
    expect(store.validateConfig()).toBe('rest_minutes')
    store.restMinutes = 0
    store.concurrentGames = 1.5
    expect(store.validateConfig()).toBe('concurrent_games')
    store.concurrentGames = MAX_CONCURRENT_GAMES + 1
    expect(store.validateConfig()).toBe('concurrent_games')
    store.concurrentGames = 0
    expect(store.validateConfig()).toBe('concurrent_games')
  })

  it('drops a saved lane count that is out of range', () => {
    storage.set('questHelper_gameIdleConcurrentGames', '99')
    expect(useGameIdleStore().concurrentGames).toBe(1)
  })

  it('sends one lane for CDP but the requested count for process mode', async () => {
    const store = useGameIdleStore()
    store.concurrentGames = 3

    store.mode = 'cdp'
    await store.start()
    expect(mocks.startGameIdle.mock.calls[0][0]).toMatchObject({
      mode: 'cdp',
      concurrentGames: 1,
    })

    store.mode = 'process'
    await store.start()
    expect(mocks.startGameIdle.mock.calls[1][0]).toMatchObject({
      mode: 'process',
      concurrentGames: 3,
    })
  })

  it('restores the lane count of a session that is already running', async () => {
    mocks.getGameIdleStatus.mockResolvedValue(
      idleStatus({ phase: 'playing', mode: 'process', concurrentGames: 4 })
    )
    const store = useGameIdleStore()
    await store.initialize()

    expect(store.concurrentGames).toBe(4)
    expect(store.effectiveConcurrentGames).toBe(4)
  })

  it('can retry initialization after an API failure', async () => {
    mocks.getGameIdleStatus
      .mockRejectedValueOnce(new Error('temporary status failure'))
      .mockResolvedValueOnce(null)
    const store = useGameIdleStore()

    await expect(store.initialize()).rejects.toThrow('temporary status failure')
    await expect(store.initialize()).resolves.toBeUndefined()

    expect(mocks.getGameIdleStatus).toHaveBeenCalledTimes(2)
    expect(mocks.onGameIdleStatus).toHaveBeenCalledOnce()
    expect(mocks.onGameSimulationHistoryUpdated).toHaveBeenCalledOnce()
  })

  it('clears the stopped queue so the next run starts with a fresh preview', async () => {
    const stopped = idleStatus({
      mode: 'cdp',
      accumulatedPlayedSeconds: 12,
      lanes: [
        {
          item: { id: 'current', name: 'Current', occurrenceId: 'current-1' },
          phase: 'playing',
          startedAt: 0,
          endsAt: null,
        },
      ],
      recent: [{ id: 'recent', name: 'Recent', occurrenceId: 'recent-1' }],
      upcoming: [{ id: 'next', name: 'Next', occurrenceId: 'next-1' }],
    })
    mocks.stopGameIdle.mockResolvedValue(stopped)
    const store = useGameIdleStore()
    store.status = stopped

    await store.stop()

    expect(store.status?.phase).toBe('stopped')
    expect(store.status?.lanes).toEqual([])
    expect(store.status?.recent).toEqual([])
    expect(store.status?.upcoming).toEqual([])
  })

  it('cancels a pending start before an account change', async () => {
    let releaseGames!: (games: []) => void
    mocks.quests.getDetectableGames.mockReturnValueOnce(new Promise<[]>(resolve => {
      releaseGames = resolve
    }))
    const store = useGameIdleStore()
    const pendingStart = store.start()
    const accountChange = store.stopForAccountChange()
    releaseGames([])

    await Promise.all([pendingStart, accountChange])
    expect(mocks.startGameIdle).not.toHaveBeenCalled()
    expect(store.status).toBeNull()
  })

  it('waits for an admitted start and stops it before changing accounts', async () => {
    let admitSession!: (status: GameIdleStatus) => void
    mocks.startGameIdle.mockReturnValueOnce(new Promise<GameIdleStatus>(resolve => {
      admitSession = resolve
    }))
    const active = idleStatus({
      sessionId: 'new-session',
      mode: 'process',
      phase: 'starting',
    })
    mocks.stopGameIdle.mockResolvedValue({ ...active, phase: 'stopped' })
    const store = useGameIdleStore()
    const pendingStart = store.start()
    await vi.waitFor(() => expect(mocks.startGameIdle).toHaveBeenCalledOnce())

    const accountChange = store.stopForAccountChange()
    admitSession(active)
    await Promise.all([pendingStart, accountChange])

    expect(mocks.stopGameIdle).toHaveBeenCalledOnce()
    expect(store.status).toBeNull()
  })
})

describe('game idle duration formatting', () => {
  it('floors partial minutes and carries complete hours', () => {
    expect(formatSimulationDuration(59)).toEqual({ hours: 0, minutes: 0 })
    expect(formatSimulationDuration(3_719)).toEqual({ hours: 1, minutes: 1 })
  })

  it('never exposes negative history values', () => {
    expect(formatSimulationDuration(-120)).toEqual({ hours: 0, minutes: 0 })
  })
})
