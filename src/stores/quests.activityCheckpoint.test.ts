import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useQuestsStore } from './quests'

const mocks = vi.hoisted(() => ({
  getPlatformCapabilities: vi.fn(),
}))

vi.mock('@/api/tauri', () => ({
  getPlatformCapabilities: mocks.getPlatformCapabilities,
}))

function createMemoryStorage(): Storage {
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

describe('quests Activity checkpoint settings', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage())
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.getPlatformCapabilities.mockResolvedValue({
      os: 'windows',
      defaultGameQuestMode: 'simulate',
      executableOsPriority: ['win32'],
    })
  })

  it('restores saved checkpoint values instead of the built-in defaults', () => {
    localStorage.setItem('questHelper_activityCheckpointMin', '240')
    localStorage.setItem('questHelper_activityCheckpointMax', '480')

    const store = useQuestsStore()

    expect(store.activityCheckpointMin).toBe(240)
    expect(store.activityCheckpointMax).toBe(480)
  })

  it('opens at the fast checkpoint cadence when nothing is saved', () => {
    const store = useQuestsStore()

    expect(store.activityCheckpointMin).toBe(90)
    expect(store.activityCheckpointMax).toBe(150)
  })

  it('persists checkpoint changes synchronously', () => {
    const store = useQuestsStore()

    store.activityCheckpointMin = 240
    store.activityCheckpointMax = 480

    expect(localStorage.getItem('questHelper_activityCheckpointMin')).toBe('240')
    expect(localStorage.getItem('questHelper_activityCheckpointMax')).toBe('480')
  })

  it('persists linked values when enforcing min/max ordering', () => {
    const store = useQuestsStore()

    store.activityCheckpointMin = 420

    expect(store.activityCheckpointMax).toBe(420)
    expect(localStorage.getItem('questHelper_activityCheckpointMin')).toBe('420')
    expect(localStorage.getItem('questHelper_activityCheckpointMax')).toBe('420')
  })

  it('shortens the checkpoint cadence with the Activity speed', () => {
    const store = useQuestsStore()

    expect(store.activitySpeedMultiplier).toBe(1)
    expect(store.activitySpeedBounds).toEqual({ min: 1, max: 5 })
    expect(store.activityCheckpointRange).toEqual({ min: 90, max: 150 })

    store.activitySpeedMultiplier = 3
    expect(store.activityCheckpointRange).toEqual({ min: 30, max: 50 })
    expect(localStorage.getItem('questHelper_activitySpeedMultiplier')).toBe('3')

    store.activitySpeedMultiplier = 5
    expect(store.activityCheckpointRange.min).toBeGreaterThanOrEqual(15)
  })

  it('falls back to 1x for a saved Activity speed outside the range', () => {
    for (const stored of ['0.5', '5.1', 'nine']) {
      localStorage.setItem('questHelper_activitySpeedMultiplier', stored)
      setActivePinia(createPinia())

      expect(useQuestsStore().activitySpeedMultiplier).toBe(1)
    }
  })
})
