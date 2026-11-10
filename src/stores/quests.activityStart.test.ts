import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Quest } from '@/api/tauri'
import { useQuestsStore } from './quests'

const mocks = vi.hoisted(() => ({
  checkCdpStatus: vi.fn(),
  getPlatformCapabilities: vi.fn(),
  getQuestsFull: vi.fn(),
  getQuestTaskStatuses: vi.fn(),
  onQuestComplete: vi.fn(),
  onQuestError: vi.fn(),
  onQuestProgress: vi.fn(),
  startCdpQuest: vi.fn(),
  stopQuest: vi.fn(),
}))

vi.mock('@/api/tauri', () => ({
  checkCdpStatus: mocks.checkCdpStatus,
  getPlatformCapabilities: mocks.getPlatformCapabilities,
  getQuestsFull: mocks.getQuestsFull,
  getQuestTaskStatuses: mocks.getQuestTaskStatuses,
  onQuestComplete: mocks.onQuestComplete,
  onQuestError: mocks.onQuestError,
  onQuestProgress: mocks.onQuestProgress,
  startCdpQuest: mocks.startCdpQuest,
  stopQuest: mocks.stopQuest,
  startVideoQuest: vi.fn(),
  startStreamQuest: vi.fn(),
  createSimulatedGame: vi.fn(),
  runSimulatedGame: vi.fn(),
  stopSimulatedGame: vi.fn(),
  fetchDetectableGames: vi.fn(),
  connectToDiscordRpc: vi.fn(),
  acceptQuest: vi.fn(),
  startGameHeartbeatQuest: vi.fn(),
  startPlayActivityQuest: vi.fn(),
  forceVideoProgress: vi.fn(),
  getVirtualCurrencyBalance: vi.fn(),
  startGameSimulationUsage: vi.fn(),
  stopGameSimulationUsage: vi.fn(),
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

function activityQuest(): Quest {
  return {
    id: 'activity-1',
    config: {
      messages: { quest_name: 'Play a round', game_title: 'Cloud Game' },
      application: { id: 'app-1', name: 'Cloud Game', link: '' },
      task_config_v2: {
        tasks: {
          ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
        },
      },
    },
    user_status: { enrolled_at: '2026-11-01T00:00:00Z', progress: {} },
  } as Quest
}

describe('startActivity', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.onQuestProgress.mockResolvedValue(() => {})
    mocks.onQuestComplete.mockResolvedValue(() => {})
    mocks.onQuestError.mockResolvedValue(() => {})
    mocks.getPlatformCapabilities.mockResolvedValue({
      cdpAvailable: true,
      supportsSimulation: true,
      os: 'windows',
    })
  })

  it('holds the slot while the backend waits for the Activity launch', async () => {
    let release: () => void = () => {}
    mocks.startCdpQuest.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const store = useQuestsStore()
    store.cdpAvailable = true

    const starting = store.startActivity(activityQuest())
    await Promise.resolve()
    await Promise.resolve()

    // The card reads its progress from the slot, so the slot has to exist while
    // the backend is still waiting for the user to open the Activity window.
    expect(store.runningQuests.some(slot => slot.questId === 'activity-1')).toBe(true)

    release()
    await starting
  })

  it('releases the slot when the backend start fails', async () => {
    mocks.startCdpQuest.mockRejectedValue(new Error('no activity target'))
    const store = useQuestsStore()
    store.cdpAvailable = true

    await expect(store.startActivity(activityQuest())).rejects.toThrow('no activity target')
    expect(store.startingQuestId).toBeNull()
    expect(store.runningQuests.some(slot => slot.questId === 'activity-1')).toBe(false)
  })
})
