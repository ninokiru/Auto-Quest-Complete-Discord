import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
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

describe('quests video speed setting', () => {
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

  it('starts every fresh install at 1x', () => {
    const store = useQuestsStore()

    expect(store.speedMultiplier).toBe(1)
  })

  it('keeps a saved speed inside the range', () => {
    localStorage.setItem('questHelper_speedMultiplier', '1.2')

    expect(useQuestsStore().speedMultiplier).toBe(1.2)

    for (const stored of ['5', '10']) {
      localStorage.setItem('questHelper_speedMultiplier', stored)
      setActivePinia(createPinia())

      expect(useQuestsStore().speedMultiplier).toBe(Number(stored))
    }
  })

  it('drops a saved speed outside the range back to 1x', () => {
    for (const stored of ['10.1', '50', '0.9', '0', '-1', 'abc']) {
      localStorage.setItem('questHelper_speedMultiplier', stored)
      setActivePinia(createPinia())

      expect(useQuestsStore().speedMultiplier).toBe(1)
    }
  })

  it('lets the slider read the same bounds the store validates', () => {
    const store = useQuestsStore()

    expect(store.videoSpeedBounds).toEqual({ min: 1, max: 10 })
  })

  it('persists a speed change', async () => {
    const store = useQuestsStore()

    store.speedMultiplier = 7
    // The speed watcher persists on the default pre flush, unlike the
    // checkpoint watchers, so the write lands after a tick.
    await nextTick()

    expect(localStorage.getItem('questHelper_speedMultiplier')).toBe('7')
  })
})
