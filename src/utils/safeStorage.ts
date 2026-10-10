/**
 * localStorage access that never throws.
 *
 * A Tauri window can lose its storage (private mode, quota, a corrupted value), and
 * losing that must not take the app down with it. Every read returns a fallback and
 * every write is best-effort, so callers get a value they can trust instead of an
 * exception in the middle of a render or a store action.
 */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as unknown
    return parsed === null || parsed === undefined ? fallback : (parsed as T)
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function readString(key: string, fallback = ''): string {
  try {
    const raw = localStorage.getItem(key)
    return typeof raw === 'string' ? raw : fallback
  } catch {
    return fallback
  }
}

export function writeString(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Storage already unavailable; nothing left to clean.
  }
}
