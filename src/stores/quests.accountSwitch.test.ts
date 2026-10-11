import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { DetectableGame, Quest } from '@/api/tauri'
import type { AccountQuestTask, RunningQuest } from './quests'
import { useQuestsStore } from './quests'

const mocks = vi.hoisted(() => ({
  announceQuestEnd: vi.fn(),
  cancelAnimationFrame: vi.fn(),
  getPlatformCapabilities: vi.fn(),
  getQuestsFull: vi.fn(),
  getQuestTaskStatuses: vi.fn(),
  getVirtualCurrencyBalance: vi.fn(),
  onQuestComplete: vi.fn(),
  onQuestError: vi.fn(),
  onQuestProgress: vi.fn(),
  requestAnimationFrame: vi.fn(() => 1),
  startVideoQuest: vi.fn(),
  stopGameSimulationUsage: vi.fn(),
  stopQuest: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock('@/api/tauri', () => ({
  getPlatformCapabilities: mocks.getPlatformCapabilities,
  getQuestsFull: mocks.getQuestsFull,
  getQuestTaskStatuses: mocks.getQuestTaskStatuses,
  getVirtualCurrencyBalance: mocks.getVirtualCurrencyBalance,
  onQuestComplete: mocks.onQuestComplete,
  onQuestError: mocks.onQuestError,
  onQuestProgress: mocks.onQuestProgress,
  startVideoQuest: mocks.startVideoQuest,
  stopGameSimulationUsage: mocks.stopGameSimulationUsage,
  stopQuest: mocks.stopQuest,
}))

vi.mock('@/utils/questNotifier', () => ({ announceQuestEnd: mocks.announceQuestEnd }))

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

function slot(questId: string, hasBackendTask: boolean): RunningQuest {
  return {
    questId,
    type: 'video',
    targetDuration: 60,
    progressUnit: 'time',
    serverProgress: 0,
    localProgress: 0,
    gameExe: null,
    simulationAppId: null,
    rpcConnected: false,
    hasBackendTask,
  }
}

function accountTask(accountId: string | null, questId: string): AccountQuestTask {
  return { accountId, questId, state: 'running' }
}

/** Read as `account/quest/state`, because tasks are addressed by that pair. */
function carried(store: ReturnType<typeof useQuestsStore>): string[] {
  return store.accountTasks.map(task => `${task.accountId ?? 'none'}/${task.questId}/${task.state}`)
}

/** A registry record. A task with no account predates signing in, so the backend
 *  marks it as the active account's; a named account is only this page's own
 *  work when the caller says so, which is what `own` reports. */
function taskStatus(
  questId: string,
  accountId: string | null,
  state: 'running' | 'finished' | 'failed',
  error: string | null = null,
  own: boolean = accountId === null,
) {
  return { questId, accountId, own, state, error }
}

function runningIds(store: ReturnType<typeof useQuestsStore>): string[] {
  return store.runningQuests.map(task => task.questId)
}

describe('quest tasks across an account switch', () => {
  beforeEach(() => {
    // Fake timers first: they replace requestAnimationFrame, so a stub installed
    // before them would be shadowed and the store would cancel the fake's frame.
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', storage())
    vi.stubGlobal('requestAnimationFrame', mocks.requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', mocks.cancelAnimationFrame)
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.getPlatformCapabilities.mockResolvedValue({
      os: 'windows', defaultGameQuestMode: 'simulate', executableOsPriority: ['win32'],
    })
    mocks.getQuestsFull.mockResolvedValue({ quests: [], excluded_quests: [] })
    mocks.getQuestTaskStatuses.mockResolvedValue([])
    mocks.getVirtualCurrencyBalance.mockResolvedValue(120)
    mocks.startVideoQuest.mockResolvedValue(undefined)
    mocks.stopQuest.mockResolvedValue(undefined)
    mocks.stopGameSimulationUsage.mockResolvedValue(undefined)
    mocks.onQuestProgress.mockResolvedValue(mocks.unlisten)
    mocks.onQuestComplete.mockResolvedValue(mocks.unlisten)
    mocks.onQuestError.mockResolvedValue(mocks.unlisten)
  })

  afterEach(() => {
    // Unwind in the order the globals were layered on: the stubs, then the fake timers.
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('hands every locally tracked backend task to the account being left', () => {
    const store = useQuestsStore()
    store.runningQuests.push(slot('video-quest', true), slot('simulated-game', false))

    store.resetForAccountSwitch('leaving-account')

    // A simulate-mode game has no backend task, so nothing keeps running for it.
    expect(carried(store)).toEqual(['leaving-account/video-quest/running'])
    expect(store.runningQuests).toEqual([])
  })

  it('keeps a foreign task and never lists the same account and quest twice', () => {
    const store = useQuestsStore()
    store.accountTasks.push(accountTask('other-account', 'other-quest'))
    // The registry already reported this quest for the account being left.
    store.accountTasks.push(accountTask('leaving-account', 'video-quest'))
    store.runningQuests.push(slot('video-quest', true))

    store.resetForAccountSwitch('leaving-account')

    expect(carried(store)).toEqual([
      'other-account/other-quest/running',
      'leaving-account/video-quest/running',
    ])
  })

  it('drops the caches of the account being left and keeps the carried tasks', () => {
    const store = useQuestsStore()
    store.accountTasks.push(accountTask('leaving-account', 'video-quest'))
    store.quests = [{ id: 'cached-quest' } as Quest]
    store.excludedQuests = [{ id: 'excluded-quest' }]
    store.orbsBalance = 900
    store.orbsBalanceFetchedAt = '2026-10-04T00:00:00.000Z'
    store.orbsBalanceLoading = true
    store.orbsBalanceError = 'stale failure'
    store.hasLoadedQuests = true
    store.startingQuestId = 'starting-quest'
    store.addToQueue({ id: 'queued-quest' } as Quest)
    store.isQueueRunning = true
    store.softError = {
      code: 'SIMULATION_EXECUTABLE_NOT_FOUND',
      message: 'No compatible executable definition for game Game.',
      gameName: 'Game',
      questId: 'queued-quest',
      recoverable: true,
    }
    store.queuePauseReason = 'simulation_incompatible'
    store.lastPlayRequest = {
      quest: { id: 'queued-quest' } as Quest,
      secondsNeeded: 60,
      initialProgress: 0,
    }
    store.detectableGames = [{ id: 'app', name: 'Game', executables: [] }] satisfies DetectableGame[]
    store.cdpAvailable = true
    store.error = 'previous account failure'

    store.resetForAccountSwitch('leaving-account')

    expect(store.quests).toEqual([])
    expect(store.excludedQuests).toEqual([])
    expect(store.orbsBalance).toBeNull()
    expect(store.orbsBalanceFetchedAt).toBeNull()
    expect(store.orbsBalanceLoading).toBe(false)
    expect(store.orbsBalanceError).toBeNull()
    expect(store.hasLoadedQuests).toBe(false)
    expect(store.startingQuestId).toBeNull()
    expect(store.questQueue).toEqual([])
    expect(store.isQueueRunning).toBe(false)
    expect(store.softError).toBeNull()
    expect(store.queuePauseReason).toBeNull()
    expect(store.lastPlayRequest).toBeNull()
    expect(store.detectableGames).toEqual([])
    expect(store.cdpAvailable).toBe(false)
    expect(store.error).toBeNull()
    // The carried tasks survive the reset: they are the other account's work.
    expect(carried(store)).toEqual(['leaving-account/video-quest/running'])
  })

  it('leaves no polling tick or quest listener running', async () => {
    const store = useQuestsStore()
    await store.startVideo('video-quest', 60, 0)

    store.resetForAccountSwitch('leaving-account')

    expect(mocks.unlisten).toHaveBeenCalledTimes(3)
    expect(mocks.cancelAnimationFrame).toHaveBeenCalled()
    // Two whole polling windows later, the account being left must stay silent.
    await vi.advanceTimersByTimeAsync(240_000)
    expect(mocks.getQuestTaskStatuses).not.toHaveBeenCalled()
    expect(mocks.getQuestsFull).not.toHaveBeenCalled()
  })

  it('forgets the other account tasks on logout', () => {
    const store = useQuestsStore()
    store.accountTasks.push(accountTask('leaving-account', 'video-quest'))

    store.resetForLogout()

    expect(store.accountTasks).toEqual([])
  })

  it('stops one other-account quest under its own account id', async () => {
    const store = useQuestsStore()
    store.accountTasks.push(accountTask('account-a', 'shared-quest'))
    store.accountTasks.push(accountTask('account-b', 'shared-quest'))

    await store.stopAccountQuest(accountTask('account-a', 'shared-quest'))

    expect(mocks.stopQuest).toHaveBeenCalledWith('shared-quest', 'account-a')
    expect(carried(store)).toEqual(['account-b/shared-quest/running'])
  })

  it('skips the registry read while nothing is tracked here or abroad', async () => {
    const store = useQuestsStore()
    store.startIdleRefresh()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.getQuestTaskStatuses).not.toHaveBeenCalled()

    store.accountTasks.push(accountTask('account-a', 'other-quest'))

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.getQuestTaskStatuses).toHaveBeenCalledTimes(1)
    // An empty registry is authoritative: a row with no task behind it is dropped.
    expect(store.accountTasks).toEqual([])
  })

  it('lists a running quest owned by another account without touching this one', async () => {
    const store = useQuestsStore()
    await store.startVideo('mine', 60, 0)
    mocks.getQuestTaskStatuses.mockResolvedValue([
      taskStatus('mine', null, 'running'),
      taskStatus('theirs', 'account-b', 'running'),
    ])

    await vi.advanceTimersByTimeAsync(120_000)

    expect(carried(store)).toEqual(['account-b/theirs/running'])
    expect(runningIds(store)).toEqual(['mine'])
    expect(mocks.stopQuest).not.toHaveBeenCalled()
    expect(mocks.announceQuestEnd).not.toHaveBeenCalled()
  })

  it('ends a locally tracked quest from the record stamped with its own account', async () => {
    const store = useQuestsStore()
    await store.startVideo('shared', 60, 0)
    // The backend credits the task to the account the page is on: naming that
    // account is what makes the record this slot's ending, not the missing name.
    mocks.getQuestTaskStatuses.mockResolvedValue([
      taskStatus('shared', 'account-a', 'failed', 'heartbeat rejected', true),
    ])

    await vi.advanceTimersByTimeAsync(120_000)

    expect(store.error).toBe('heartbeat rejected')
    expect(store.runningQuests).toEqual([])
    expect(mocks.stopQuest).toHaveBeenCalledWith('shared')
    // A slot this page owns is never reported as another account's work.
    expect(store.accountTasks).toEqual([])
  })

  it('leaves its own slot running when the ended record names another account', async () => {
    const store = useQuestsStore()
    await store.startVideo('shared', 60, 0)
    // Two accounts on the same quest id, so the registry lists two records that
    // differ by nothing but ownership. Listing the other account's copy first is
    // the case an id-only match got wrong: it tore this slot down abroad.
    mocks.getQuestTaskStatuses.mockResolvedValueOnce([
      taskStatus('shared', 'account-b', 'running', null, false),
      taskStatus('shared', 'account-a', 'running', null, true),
    ])
    mocks.getQuestTaskStatuses.mockResolvedValue([
      taskStatus('shared', 'account-b', 'failed', 'ended abroad', false),
      taskStatus('shared', 'account-a', 'running', null, true),
    ])

    await vi.advanceTimersByTimeAsync(240_000)

    expect(runningIds(store)).toEqual(['shared'])
    expect(store.error).toBeNull()
    expect(mocks.stopQuest).not.toHaveBeenCalled()
    // The other account's copy is listed while it runs, and its ending is
    // announced rather than tearing this page's quest down.
    expect(mocks.announceQuestEnd).toHaveBeenCalledWith('shared', 'ended abroad')
    expect(carried(store)).toEqual([])
  })

  it('announces the ending of an account task it saw running on a previous tick', async () => {
    const store = useQuestsStore()
    await store.startVideo('mine', 60, 0)
    store.accountTasks.push(accountTask('account-b', 'theirs'))
    mocks.getQuestTaskStatuses.mockResolvedValue([
      taskStatus('mine', null, 'running'),
      taskStatus('theirs', 'account-b', 'finished'),
    ])

    await vi.advanceTimersByTimeAsync(120_000)

    expect(mocks.announceQuestEnd).toHaveBeenCalledWith('theirs', undefined)
    expect(carried(store)).toEqual([])
    expect(runningIds(store)).toEqual(['mine'])
  })

  it('stays silent for a finished record it never saw running', async () => {
    const store = useQuestsStore()
    await store.startVideo('mine', 60, 0)
    mocks.getQuestTaskStatuses.mockResolvedValue([
      taskStatus('mine', null, 'running'),
      taskStatus('stale', 'account-b', 'failed', 'old failure'),
    ])

    await vi.advanceTimersByTimeAsync(120_000)

    expect(mocks.announceQuestEnd).not.toHaveBeenCalled()
    expect(store.accountTasks).toEqual([])
    expect(store.error).toBeNull()
  })
})
