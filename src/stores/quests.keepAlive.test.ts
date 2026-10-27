import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Quest } from '@/api/tauri'
import { useQuestsStore } from './quests'
import { useNotificationsStore } from './notifications'

const mocks = vi.hoisted(() => ({
  onQuestComplete: vi.fn(),
  stopGameSimulationUsage: vi.fn(),
  stopSimulatedGame: vi.fn(),
  getPlatformCapabilities: vi.fn(),
  startVideoQuest: vi.fn(),
}))

vi.mock('@/api/tauri', () => ({
  getPlatformCapabilities: mocks.getPlatformCapabilities,
  startVideoQuest: mocks.startVideoQuest,
  stopSimulatedGame: mocks.stopSimulatedGame,
  stopGameSimulationUsage: mocks.stopGameSimulationUsage,
  stopQuest: vi.fn().mockResolvedValue(undefined),
  getQuestsFull: vi.fn().mockResolvedValue({ quests: [], excluded_quests: [] }),
  getQuestTaskStatuses: vi.fn().mockResolvedValue([]),
  onQuestProgress: vi.fn().mockResolvedValue(() => undefined),
  onQuestComplete: mocks.onQuestComplete,
  onQuestError: vi.fn().mockResolvedValue(() => undefined),
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

function videoQuest(id: string): Quest {
  return {
    id,
    config: {
      messages: { quest_name: id },
      task_config: { tasks: { WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 } } },
    },
    user_status: { enrolled_at: '2026-10-01', completed_at: null, claimed_at: null, progress: {} },
  } as Quest
}

describe('post-quest keep-alive', () => {
  let complete!: () => Promise<void>

  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.getPlatformCapabilities.mockResolvedValue({
      os: 'windows', defaultGameQuestMode: 'simulate', executableOsPriority: ['win32'],
    })
    mocks.startVideoQuest.mockResolvedValue(undefined)
    mocks.stopSimulatedGame.mockResolvedValue(undefined)
    mocks.stopGameSimulationUsage.mockResolvedValue(undefined)
    mocks.onQuestComplete.mockImplementation(async (callback: () => Promise<void>) => {
      complete = callback
      return () => undefined
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // The video path is the lightest one that arms the completion listeners; the
  // slot is then reshaped into the state a finished simulate-mode game quest
  // has: a simulated process and a history segment of its own.
  async function runningStore() {
    const store = useQuestsStore()
    await store.startVideo('first', 60, 0)
    const slot = store.runningQuests.find(item => item.questId === 'first')!
    slot.type = 'game'
    slot.gameExe = 'first.exe'
    slot.simulationAppId = 'app-first'
    return store
  }

  it('keeps the game connected after the quest ends and closes it when the wait is over', async () => {
    const store = await runningStore()
    store.postQuestKeepAliveEnabled = true
    store.postQuestKeepAlive = { mode: 'fixed', fixed: 1, min: 1, max: 1 }

    await complete()

    expect(store.keepAliveEndsAt).toBe(Date.now() + 60_000)
    // The teardown waits; the game and the presence it holds stay up.
    expect(mocks.stopSimulatedGame).not.toHaveBeenCalled()
    expect(mocks.stopGameSimulationUsage).not.toHaveBeenCalled()
    expect(store.runningQuests.map(item => item.questId)).toEqual(['first'])

    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
    expect(mocks.stopSimulatedGame).toHaveBeenCalledWith('first.exe')
    expect(mocks.stopGameSimulationUsage).toHaveBeenCalledTimes(1)
    expect(mocks.stopGameSimulationUsage).toHaveBeenCalledWith('app-first')
    expect(store.runningQuests.map(item => item.questId)).toEqual([])
    expect(store.keepAliveEndsAt).toBeNull()
  })

  it('reports the completion while the game is still connected', async () => {
    const store = await runningStore()
    store.postQuestKeepAliveEnabled = true
    store.postQuestKeepAlive = { mode: 'fixed', fixed: 1, min: 1, max: 1 }
    const notifications = useNotificationsStore()

    await complete()

    expect(notifications.items.some(item => item.kind === 'quest_completed')).toBe(true)
    expect(store.runningQuests[0]?.serverProgress).toBe(100)
  })

  it('closes the held game at once when the user stops, and never tears it down twice', async () => {
    const store = await runningStore()
    store.postQuestKeepAliveEnabled = true
    store.postQuestKeepAlive = { mode: 'fixed', fixed: 1, min: 1, max: 1 }
    await complete()
    expect(store.keepAliveEndsAt).not.toBeNull()

    await store.stop()

    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
    expect(mocks.stopGameSimulationUsage).toHaveBeenCalledTimes(1)
    expect(store.keepAliveEndsAt).toBeNull()

    await vi.advanceTimersByTimeAsync(120_000)

    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
    expect(mocks.stopGameSimulationUsage).toHaveBeenCalledTimes(1)
  })

  it('closes the held game at once when only that quest is stopped', async () => {
    const store = await runningStore()
    store.postQuestKeepAliveEnabled = true
    store.postQuestKeepAlive = { mode: 'fixed', fixed: 1, min: 1, max: 1 }
    await complete()

    await store.stopRunningQuest('first')

    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
    expect(mocks.stopGameSimulationUsage).toHaveBeenCalledTimes(1)
    expect(store.keepAliveEndsAt).toBeNull()

    await vi.advanceTimersByTimeAsync(120_000)

    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
  })

  it('tears down at once when keep-alive is disabled', async () => {
    const store = await runningStore()

    await complete()

    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
    expect(mocks.stopGameSimulationUsage).toHaveBeenCalledTimes(1)
    expect(store.keepAliveEndsAt).toBeNull()
    expect(store.runningQuests.map(item => item.questId)).toEqual([])
  })

  it('never holds a quest that owns no simulated game process', async () => {
    const store = await runningStore()
    store.postQuestKeepAliveEnabled = true
    // A CDP or heartbeat quest has no process to keep open.
    store.runningQuests[0].gameExe = null

    await complete()

    expect(store.keepAliveEndsAt).toBeNull()
    expect(mocks.stopSimulatedGame).not.toHaveBeenCalled()
  })

  it('closes the held game when the account changes during the hold', async () => {
    const store = await runningStore()
    store.postQuestKeepAliveEnabled = true
    store.postQuestKeepAlive = { mode: 'fixed', fixed: 1, min: 1, max: 1 }
    await complete()
    expect(store.keepAliveEndsAt).not.toBeNull()

    store.resetForAccountSwitch('account-1')
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
    expect(mocks.stopGameSimulationUsage).toHaveBeenCalledTimes(1)
    expect(store.keepAliveEndsAt).toBeNull()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
  })

  it('lets the queue advance while the finished game is still connected', async () => {
    const store = useQuestsStore()
    store.addToQueue(videoQuest('first'))
    store.addToQueue(videoQuest('second'))
    store.isQueueRunning = true
    await store.startVideo('first', 60, 0)
    const slot = store.runningQuests.find(item => item.questId === 'first')!
    slot.type = 'game'
    slot.gameExe = 'first.exe'
    slot.simulationAppId = 'app-first'
    store.postQuestKeepAliveEnabled = true
    store.postQuestKeepAlive = { mode: 'fixed', fixed: 1, min: 1, max: 1 }

    await complete()

    // The finished item leaves the queue right away — only the teardown waits.
    expect(store.questQueue.map(item => item.id)).toEqual(['second'])
    expect(store.runningQuests.map(item => item.questId)).toEqual(['first'])

    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
    expect(store.runningQuests.map(item => item.questId)).not.toContain('first')
  })

  it('waits out a hold longer than the webview timer limit in chunks', async () => {
    // Re-fake without rAF: the fake rAF machinery keeps a ~16ms internal timer
    // alive, which a multi-billion-ms tick would fire 100M+ times. The store
    // uses no animation frames on this path (the global is stubbed).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(0)
    const store = await runningStore()
    // The polling cadence would tick thousands of times over a hold this long.
    store.gamePollingInterval = 300
    store.postQuestKeepAliveEnabled = true
    store.postQuestKeepAlive = { mode: 'fixed', fixed: 36_000, min: 36_000, max: 36_000 }

    await complete()
    expect(store.keepAliveEndsAt).toBe(2_160_000_000)

    await vi.advanceTimersByTimeAsync(2_147_000_000)
    expect(mocks.stopSimulatedGame).not.toHaveBeenCalled()
    expect(store.keepAliveEndsAt).not.toBeNull()

    await vi.advanceTimersByTimeAsync(13_000_000)
    expect(mocks.stopSimulatedGame).toHaveBeenCalledTimes(1)
    expect(store.keepAliveEndsAt).toBeNull()
  })
})
