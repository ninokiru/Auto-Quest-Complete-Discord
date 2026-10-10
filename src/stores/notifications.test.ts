import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNotificationsStore } from './notifications'

const STORAGE_KEY = 'aqc_notifications_v1'

function createMemoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    raw: store,
  }
}

function storageWith(value: unknown) {
  return createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(value) })
}

beforeEach(() => {
  vi.useRealTimers()
  vi.stubGlobal('localStorage', createMemoryStorage())
  setActivePinia(createPinia())
})

describe('notifications store', () => {
  it('keeps the newest item first and counts unread entries', () => {
    const store = useNotificationsStore()

    store.push('quest_completed', { name: 'Watch a video' })
    store.push('new_quests', { count: 3 })

    expect(store.items).toHaveLength(2)
    expect(store.items[0].kind).toBe('new_quests')
    expect(store.unreadCount).toBe(2)
    expect(store.hasUnread).toBe(true)
  })

  it('suppresses the same notification inside the deduplication window', () => {
    const store = useNotificationsStore()

    expect(store.push('quest_failed', { name: 'Play', error: 'boom' })).not.toBeNull()
    expect(store.push('quest_failed', { name: 'Play', error: 'boom' })).toBeNull()
    expect(store.push('quest_failed', { name: 'Play', error: 'different' })).not.toBeNull()
    expect(store.items).toHaveLength(2)
  })

  it('allows a repeat once the deduplication window has passed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T09:00:00Z'))
    const store = useNotificationsStore()

    store.push('quest_completed', { name: 'Daily quest' })
    vi.setSystemTime(new Date('2026-10-10T09:05:00Z'))
    expect(store.push('quest_completed', { name: 'Daily quest' })).not.toBeNull()
    expect(store.items).toHaveLength(2)
    vi.useRealTimers()
  })

  it('restores persisted items and drops malformed records', () => {
    const now = Date.now()
    vi.stubGlobal('localStorage', storageWith([
      { id: 'a', kind: 'quest_completed', params: { name: 'Kept' }, createdAt: now, read: true },
      { id: 'b', kind: 'not_a_kind', params: {}, createdAt: now, read: false },
      { id: 'c', kind: 'error', params: { error: 'x' }, createdAt: 0, read: false },
      null,
      'string entry',
    ]))
    setActivePinia(createPinia())

    const store = useNotificationsStore()
    expect(store.items).toHaveLength(1)
    expect(store.items[0].id).toBe('a')
    expect(store.unreadCount).toBe(0)
  })

  it('survives unparsable storage and a storage that throws', () => {
    vi.stubGlobal('localStorage', storageWith('this is not an array'))
    setActivePinia(createPinia())
    expect(useNotificationsStore().items).toEqual([])

    const hostile = createMemoryStorage()
    hostile.getItem = () => {
      throw new Error('storage disabled')
    }
    hostile.setItem = () => {
      throw new Error('quota exceeded')
    }
    vi.stubGlobal('localStorage', hostile)
    setActivePinia(createPinia())

    const store = useNotificationsStore()
    expect(store.items).toEqual([])
    expect(store.push('error', { error: 'still recorded in memory' })).not.toBeNull()
    expect(store.items).toHaveLength(1)
  })

  it('caps the list at the newest 60 entries', () => {
    const store = useNotificationsStore()
    for (let index = 0; index < 70; index++) {
      // Distinct names keep the deduplication window out of this assertion.
      store.push('quest_completed', { name: `Quest ${index}` })
    }
    expect(store.items).toHaveLength(60)
    expect(store.items[0].params.name).toBe('Quest 69')
  })

  it('trims oversized text and rejects non-web urls', () => {
    const store = useNotificationsStore()
    store.push('quest_failed', {
      name: `  ${'n'.repeat(200)}  `,
      error: 'e'.repeat(400),
      url: 'javascript:alert(1)',
      count: 0,
    })

    const params = store.items[0].params
    expect(params.name).toHaveLength(80)
    expect(params.name?.startsWith('n')).toBe(true)
    expect(params.error).toHaveLength(200)
    expect(params.url).toBeUndefined()
    expect(params.count).toBeUndefined()
  })

  it('marks read state and writes it back to storage', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)
    setActivePinia(createPinia())
    const store = useNotificationsStore()
    const id = store.push('update_available', { version: '0.0.3' })
    expect(id).not.toBeNull()

    store.markRead(id as string)
    expect(store.unreadCount).toBe(0)

    store.push('new_quests', { count: 2 })
    store.markAllRead()
    expect(store.unreadCount).toBe(0)

    const persisted = JSON.parse(storage.raw.get(STORAGE_KEY) as string) as Array<{ read: boolean }>
    expect(persisted.every(entry => entry.read)).toBe(true)
  })

  it('removes a single entry and clears the whole list', () => {
    const store = useNotificationsStore()
    const first = store.push('quest_completed', { name: 'One' }) as string
    store.push('quest_completed', { name: 'Two' })

    store.remove(first)
    expect(store.items.map(item => item.params.name)).toEqual(['Two'])

    store.clearAll()
    expect(store.items).toEqual([])
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string)).toEqual([])
  })

  it('drops account-scoped entries but keeps release notices', () => {
    const store = useNotificationsStore()
    store.push('update_available', { version: '0.0.3' })
    store.push('quest_completed', { name: 'Private quest' })
    store.push('error', { error: 'Private failure' })

    store.resetForAccount()

    expect(store.items.map(item => item.kind)).toEqual(['update_available'])
  })
})
