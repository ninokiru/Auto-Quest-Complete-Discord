import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { readJson, writeJson } from '@/utils/safeStorage'

/**
 * What the bell can hold. Each kind maps to a `notify.items.<kind>` title/body pair,
 * so the panel can translate on render instead of freezing a language into storage.
 */
export type NotificationKind =
  | 'update_available'
  | 'quest_completed'
  | 'quest_failed'
  | 'new_quests'
  | 'error'

export interface NotificationParams {
  name?: string
  error?: string
  version?: string
  current?: string
  count?: number
  url?: string
}

export interface AppNotification {
  id: string
  kind: NotificationKind
  params: NotificationParams
  createdAt: number
  read: boolean
}

const STORAGE_KEY = 'aqc_notifications_v1'
const MAX_ITEMS = 60
const MAX_NAME = 80
const MAX_ERROR = 200
const MAX_VERSION = 32
// The same quest can report a failure twice (event listener plus status poll), and a
// refresh can re-detect one new quest. Inside this window the duplicate is dropped.
const DEDUPE_WINDOW_MS = 120_000

const KINDS = new Set<string>([
  'update_available',
  'quest_completed',
  'quest_failed',
  'new_quests',
  'error',
])

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** Only web links are useful here, and they are opened in the system browser. */
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return undefined
  return trimmed.slice(0, 500)
}

function sanitizeParams(value: unknown): NotificationParams {
  if (value === null || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const params: NotificationParams = {}
  const name = clampText(raw.name, MAX_NAME)
  if (name !== undefined) params.name = name
  const error = clampText(raw.error, MAX_ERROR)
  if (error !== undefined) params.error = error
  const version = clampText(raw.version, MAX_VERSION)
  if (version !== undefined) params.version = version
  const current = clampText(raw.current, MAX_VERSION)
  if (current !== undefined) params.current = current
  if (typeof raw.count === 'number' && Number.isFinite(raw.count) && raw.count > 0) {
    params.count = Math.min(Math.floor(raw.count), 9999)
  }
  const url = safeUrl(raw.url)
  if (url !== undefined) params.url = url
  return params
}

function fingerprint(kind: NotificationKind, params: NotificationParams): string {
  return [kind, params.name ?? '', params.version ?? '', params.current ?? '', params.count ?? '', params.error ?? ''].join('|')
}

function toNotification(value: unknown): AppNotification | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0
  if (createdAt <= 0) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `restored-${createdAt}`,
    kind: raw.kind as NotificationKind,
    params: sanitizeParams(raw.params),
    createdAt,
    read: raw.read === true,
  }
}

function loadItems(): AppNotification[] {
  const stored = readJson<unknown>(STORAGE_KEY, [])
  if (!Array.isArray(stored)) return []
  return stored
    .map(toNotification)
    .filter((item): item is AppNotification => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_ITEMS)
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const useNotificationsStore = defineStore('notifications', () => {
  // Newest first: the panel renders the array in order, so no template reverse is needed.
  const items = ref<AppNotification[]>(loadItems())

  const unreadCount = computed(() => items.value.filter(item => !item.read).length)
  const hasUnread = computed(() => unreadCount.value > 0)
  const lastUpdateNotification = computed(() =>
    items.value.find(item => item.kind === 'update_available') ?? null,
  )

  function persist() {
    writeJson(STORAGE_KEY, items.value)
  }

  function isDuplicate(kind: NotificationKind, params: NotificationParams): boolean {
    const marker = fingerprint(kind, params)
    const now = Date.now()
    return items.value.some(item =>
      item.createdAt > now - DEDUPE_WINDOW_MS && fingerprint(item.kind, item.params) === marker,
    )
  }

  /** Returns the new id, or null when the notification was suppressed as a duplicate. */
  function push(kind: NotificationKind, params: NotificationParams = {}): string | null {
    const clean = sanitizeParams(params)
    if (isDuplicate(kind, clean)) return null

    const item: AppNotification = {
      id: createId(),
      kind,
      params: clean,
      createdAt: Date.now(),
      read: false,
    }
    items.value = [item, ...items.value].slice(0, MAX_ITEMS)
    persist()
    return item.id
  }

  function markRead(id: string) {
    const item = items.value.find(entry => entry.id === id)
    if (!item || item.read) return
    item.read = true
    persist()
  }

  function markAllRead() {
    if (items.value.every(item => item.read)) return
    items.value.forEach(item => {
      item.read = true
    })
    persist()
  }

  function remove(id: string) {
    const index = items.value.findIndex(item => item.id === id)
    if (index === -1) return
    items.value.splice(index, 1)
    persist()
  }

  function clearAll() {
    if (items.value.length === 0) return
    items.value = []
    persist()
  }

  /**
   * Sign-in and logout swap accounts, so quest names and quest errors from the
   * previous user must not stay readable in the panel. Release notices are about the
   * app, not the account, and survive.
   */
  function resetForAccount() {
    const kept = items.value.filter(item => item.kind === 'update_available')
    if (kept.length === items.value.length) return
    items.value = kept
    persist()
  }

  return {
    items,
    unreadCount,
    hasUnread,
    lastUpdateNotification,
    push,
    markRead,
    markAllRead,
    remove,
    clearAll,
    resetForAccount,
  }
})
