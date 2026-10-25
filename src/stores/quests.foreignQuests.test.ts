import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AccountQuestGroup, Quest } from '@/api/tauri'
import { useNotificationsStore } from './notifications'
import { useQuestsStore } from './quests'

const mocks = vi.hoisted(() => ({
  acceptQuest: vi.fn(),
  announceQuestEnd: vi.fn(),
  cancelAnimationFrame: vi.fn(),
  checkCdpStatus: vi.fn(),
  claimQuestReward: vi.fn(),
  connectToDiscordRpc: vi.fn(),
  createSimulatedGame: vi.fn(),
  fetchDetectableGames: vi.fn(),
  forceVideoProgress: vi.fn(),
  getPlatformCapabilities: vi.fn(),
  getQuestTaskStatuses: vi.fn(),
  getQuestsForAccounts: vi.fn(),
  getQuestsFull: vi.fn(),
  getVirtualCurrencyBalance: vi.fn(),
  onQuestComplete: vi.fn(),
  onQuestError: vi.fn(),
  onQuestProgress: vi.fn(),
  requestAnimationFrame: vi.fn(() => 1),
  runSimulatedGame: vi.fn(),
  startCdpQuest: vi.fn(),
  startGameHeartbeatQuest: vi.fn(),
  startGameSimulationUsage: vi.fn(),
  startPlayActivityQuest: vi.fn(),
  startStreamQuest: vi.fn(),
  startVideoQuest: vi.fn(),
  stopGameSimulationUsage: vi.fn(),
  stopSimulatedGame: vi.fn(),
  stopQuest: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock('@/api/tauri', () => ({
  acceptQuest: mocks.acceptQuest,
  claimQuestReward: mocks.claimQuestReward,
  connectToDiscordRpc: mocks.connectToDiscordRpc,
  createSimulatedGame: mocks.createSimulatedGame,
  checkCdpStatus: mocks.checkCdpStatus,
  fetchDetectableGames: mocks.fetchDetectableGames,
  forceVideoProgress: mocks.forceVideoProgress,
  getPlatformCapabilities: mocks.getPlatformCapabilities,
  getQuestTaskStatuses: mocks.getQuestTaskStatuses,
  getQuestsForAccounts: mocks.getQuestsForAccounts,
  getQuestsFull: mocks.getQuestsFull,
  getVirtualCurrencyBalance: mocks.getVirtualCurrencyBalance,
  onQuestComplete: mocks.onQuestComplete,
  onQuestError: mocks.onQuestError,
  onQuestProgress: mocks.onQuestProgress,
  runSimulatedGame: mocks.runSimulatedGame,
  startCdpQuest: mocks.startCdpQuest,
  startGameHeartbeatQuest: mocks.startGameHeartbeatQuest,
  startGameSimulationUsage: mocks.startGameSimulationUsage,
  startPlayActivityQuest: mocks.startPlayActivityQuest,
  startStreamQuest: mocks.startStreamQuest,
  startVideoQuest: mocks.startVideoQuest,
  stopGameSimulationUsage: mocks.stopGameSimulationUsage,
  stopQuest: mocks.stopQuest,
  stopSimulatedGame: mocks.stopSimulatedGame,
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

/** Build a quest whose single task is `type` with `target`, plus whatever the
 *  heartbeat paths need (an application id) and the progress Discord reported. */
function questWithTask(
  id: string,
  taskKey: string,
  type: string,
  target: number,
  value: number,
  options: { applicationId?: string } = {},
): Quest {
  return {
    id,
    config: {
      messages: { quest_name: id },
      application: options.applicationId
        ? { id: options.applicationId, name: 'Game', link: '' }
        : undefined,
      task_config_v2: { tasks: { [taskKey]: { type, target } } },
    },
    user_status: {
      enrolled_at: '2026-10-01T00:00:00Z',
      completed_at: null,
      progress: { [taskKey]: { value, target } },
    },
  } as unknown as Quest
}

function group(userId: string, quests: Quest[], error: string | null = null): AccountQuestGroup {
  return {
    account: {
      user: { id: userId, username: userId, avatar: null } as never,
      active: false,
      runningQuests: 0,
    },
    quests,
    error,
  }
}

describe('quests of another account', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', storage())
    vi.stubGlobal('requestAnimationFrame', mocks.requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', mocks.cancelAnimationFrame)
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.getPlatformCapabilities.mockResolvedValue({
      os: 'windows', defaultGameQuestMode: 'simulate', executableOsPriority: ['win32'],
    })
    mocks.getQuestsFull.mockResolvedValue({ quests: [], excluded_quests: [] })
    mocks.getQuestTaskStatuses.mockResolvedValue([])
    mocks.getVirtualCurrencyBalance.mockResolvedValue(0)
    mocks.onQuestProgress.mockResolvedValue(mocks.unlisten)
    mocks.onQuestComplete.mockResolvedValue(mocks.unlisten)
    mocks.onQuestError.mockResolvedValue(mocks.unlisten)
    mocks.acceptQuest.mockResolvedValue(undefined)
    mocks.claimQuestReward.mockResolvedValue({})
    mocks.startVideoQuest.mockResolvedValue(undefined)
    mocks.startGameHeartbeatQuest.mockResolvedValue(undefined)
    mocks.startPlayActivityQuest.mockResolvedValue(undefined)
    mocks.stopQuest.mockResolvedValue(undefined)
    mocks.getQuestsForAccounts.mockResolvedValue([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('lists every other account with its own quests', async () => {
    const store = useQuestsStore()
    mocks.getQuestsForAccounts.mockResolvedValue([
      group('acc-b', [questWithTask('b-video', 'WATCH_VIDEO', 'WATCH_VIDEO', 120, 30)]),
      group('acc-c', [], 'token expired'),
    ])

    await Promise.all([store.refreshForeignQuests(), store.refreshForeignQuests()])

    expect(store.foreignQuestGroups.map(item => item.account.user.id)).toEqual(['acc-b', 'acc-c'])
    expect(store.foreignQuestsError).toBeNull()
    // Two callers share the one read that is already awaiting.
    expect(mocks.getQuestsForAccounts).toHaveBeenCalledTimes(1)
  })

  it('keeps the panel usable when the read itself fails', async () => {
    const store = useQuestsStore()
    store.foreignQuestGroups = [group('acc-b', [])]
    mocks.getQuestsForAccounts.mockRejectedValue(new Error('backend is busy'))

    await store.refreshForeignQuests()

    expect(store.foreignQuestsError).toBe('backend is busy')
    expect(store.foreignQuestGroups).toEqual([])
  })

  it('discards a list that arrives after the account changed', async () => {
    const store = useQuestsStore()
    mocks.getQuestsForAccounts.mockResolvedValue([group('acc-b', [])])
    const pending = store.refreshForeignQuests()

    store.resetForAccountSwitch('acc-a')
    await pending

    // The read finished after the switch, so its groups belong to the account
    // that was left and must not be drawn under this one.
    expect(store.foreignQuestGroups).toEqual([])
  })

  it('posts a video quest with the owning account named', async () => {
    const store = useQuestsStore()
    const quest = questWithTask('b-video', 'WATCH_VIDEO', 'WATCH_VIDEO', 120, 30)

    await store.startForeignQuest('acc-b', quest)

    // `initialProgress` is a percentage on this path: 30 of 120 seconds.
    expect(mocks.startVideoQuest).toHaveBeenCalledWith(
      'b-video',
      120,
      25,
      store.speedMultiplier,
      store.heartbeatInterval,
      'acc-b',
    )
    // A foreign run owns no slot: the progress panel stays the active account's.
    expect(store.runningQuests).toEqual([])
  })

  it('drives a desktop-play quest through the direct heartbeat API', async () => {
    const store = useQuestsStore()
    const quest = questWithTask('b-play', 'PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP', 60, 15, {
      applicationId: 'app-1',
    })

    await store.startForeignQuest('acc-b', quest)

    expect(mocks.startGameHeartbeatQuest).toHaveBeenCalledWith('b-play', 'app-1', 60, 25, 'acc-b')
    expect(mocks.startCdpQuest).not.toHaveBeenCalled()
  })

  it('forces the heartbeat transport for a cloud-game activity', async () => {
    const store = useQuestsStore()
    const quest = questWithTask('b-activity', 'PLAY_ACTIVITY', 'PLAY_ACTIVITY', 300, 60, {
      applicationId: 'app-2',
    })

    await store.startForeignQuest('acc-b', quest)

    expect(mocks.startPlayActivityQuest).toHaveBeenCalledWith(
      'b-activity',
      'app-2',
      300,
      60,
      'heartbeat',
      store.cdpPort,
      store.heartbeatInterval,
      store.gamePollingInterval,
      'acc-b',
    )
  })

  it.each([
    ['STREAM_ON_DESKTOP', 'STREAM_ON_DESKTOP', 'stream'],
    ['ACHIEVEMENT_IN_ACTIVITY', 'ACHIEVEMENT_IN_ACTIVITY', 'activity'],
  ])('refuses %s because it needs the desktop client', async (_key, type, label) => {
    const store = useQuestsStore()
    const quest = questWithTask(`b-${label}`, type, type, 60, 0, { applicationId: 'app-3' })

    await expect(store.startForeignQuest('acc-b', quest)).rejects.toThrow(/another account/)

    expect(mocks.startVideoQuest).not.toHaveBeenCalled()
    expect(mocks.startGameHeartbeatQuest).not.toHaveBeenCalled()
    expect(mocks.startPlayActivityQuest).not.toHaveBeenCalled()
  })

  it('names the account on accept, claim and stop', async () => {
    const store = useQuestsStore()
    store.accountTasks.push({ accountId: 'acc-b', questId: 'b-video', state: 'running' })

    await store.acceptForeignQuest('acc-b', 'b-video')
    await store.claimForeignQuest('acc-b', 'b-video')
    expect(store.isForeignQuestRunning('acc-b', 'b-video')).toBe(true)
    // The same quest id on the active account is a different task.
    expect(store.isForeignQuestRunning('acc-a', 'b-video')).toBe(false)

    await store.stopForeignQuest('acc-b', 'b-video')

    expect(mocks.acceptQuest).toHaveBeenCalledWith('b-video', 'acc-b')
    expect(mocks.claimQuestReward).toHaveBeenCalledWith('b-video', undefined, 'acc-b')
    expect(mocks.stopQuest).toHaveBeenCalledWith('b-video', 'acc-b')
    expect(store.isForeignQuestRunning('acc-b', 'b-video')).toBe(false)
  })

  it('reports a foreign ending with the account and the listed quest name', async () => {
    const store = useQuestsStore()
    const quest = questWithTask('b-video', 'WATCH_VIDEO', 'WATCH_VIDEO', 120, 30)
    quest.config.messages.quest_name = 'Watch and earn'
    mocks.getQuestsForAccounts.mockResolvedValue([{
      account: {
        user: {
          id: 'acc-b',
          username: 'bao',
          discriminator: '0',
          avatar: null,
          global_name: 'Bao',
        },
        active: false,
        runningQuests: 1,
      },
      quests: [quest],
      error: null,
    }])
    await store.refreshForeignQuests()
    await store.startVideo('mine', 60, 0)
    store.accountTasks.push({ accountId: 'acc-b', questId: 'b-video', state: 'running' })
    mocks.getQuestTaskStatuses.mockResolvedValue([
      { questId: 'mine', accountId: null, own: true, state: 'running', error: null },
      { questId: 'b-video', accountId: 'acc-b', own: false, state: 'finished', error: null },
    ])

    await vi.advanceTimersByTimeAsync(120_000)

    expect(mocks.announceQuestEnd).toHaveBeenCalledWith('Watch and earn', undefined, 'Bao')
    expect(useNotificationsStore().items[0]?.params).toMatchObject({
      name: 'Watch and earn',
      account: 'Bao',
    })
    expect(store.accountTasks).toEqual([])
  })

  it('reads the registry as soon as another account starts or stops', async () => {
    const store = useQuestsStore()
    const quest = questWithTask('b-video', 'WATCH_VIDEO', 'WATCH_VIDEO', 120, 30)
    mocks.getQuestTaskStatuses.mockResolvedValue([
      { questId: 'b-video', accountId: 'acc-b', own: false, state: 'running', error: null },
    ])

    await store.startForeignQuest('acc-b', quest)

    // Nothing local is tracked before this read, so only the forced poll can mark
    // another account as busy for the event listeners.
    expect(store.accountTasks).toEqual([
      { accountId: 'acc-b', questId: 'b-video', state: 'running' },
    ])

    mocks.getQuestTaskStatuses.mockResolvedValue([])
    await store.stopForeignQuest('acc-b', 'b-video')
    expect(store.accountTasks).toEqual([])
  })

  it('does not read quest events as this page’s while another account works', async () => {
    const store = useQuestsStore()
    let complete!: () => Promise<void>
    let progress!: (value: number) => void
    mocks.onQuestProgress.mockImplementation(async (callback: (value: number) => void) => {
      progress = callback
      return mocks.unlisten
    })
    mocks.onQuestComplete.mockImplementation(async (callback: () => Promise<void>) => {
      complete = callback
      return mocks.unlisten
    })
    await store.startVideo('first', 60, 0)
    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['first'])

    mocks.getQuestTaskStatuses.mockResolvedValue([
      { questId: 'b-video', accountId: 'acc-b', own: false, state: 'running', error: null },
    ])
    await store.startForeignQuest(
      'acc-b',
      questWithTask('b-video', 'WATCH_VIDEO', 'WATCH_VIDEO', 120, 0),
    )

    // The number and the completion can both be the other account's, so neither
    // may touch this account's only slot.
    progress(55)
    expect(store.runningQuests[0]?.serverProgress).toBe(0)
    await complete()
    expect(store.runningQuests.map(slot => slot.questId)).toEqual(['first'])
    expect(mocks.announceQuestEnd).not.toHaveBeenCalled()

    // Idle again, the same events belong to this page.
    mocks.getQuestTaskStatuses.mockResolvedValue([])
    await store.stopForeignQuest('acc-b', 'b-video')
    progress(55)
    expect(store.runningQuests[0]?.serverProgress).toBe(55)
  })
})
