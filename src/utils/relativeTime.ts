/**
 * Timestamp formatting that survives a missing or odd locale.
 *
 * `Intl` throws on a malformed tag and the app locale comes from storage, so every
 * call degrades to a plain date and then to an empty string rather than breaking the
 * row that renders it. Relative units are chosen by hand because vue-i18n has no
 * relative-time helper and a dependency for one string is not worth it.
 */
const RELATIVE_STEPS: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: 'second', seconds: 1 },
  { unit: 'minute', seconds: 60 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'day', seconds: 86400 },
]

const DAY_SECONDS = 86_400

// Formatters are expensive to construct and the quest list asks for one per card
// on every render, poll and keystroke; the app ships a handful of locales, so
// they are built once. A malformed tag is cached as null and degrades the same
// way every time.
const dateTimeFormats = new Map<string, Intl.DateTimeFormat | null>()
const relativeFormats = new Map<string, Intl.RelativeTimeFormat | null>()

function dateTimeFormat(locale: string, withTime: boolean): Intl.DateTimeFormat | null {
  const key = `${locale}|${withTime ? 1 : 0}`
  const cached = dateTimeFormats.get(key)
  if (cached !== undefined) return cached
  let format: Intl.DateTimeFormat | null = null
  try {
    format = new Intl.DateTimeFormat(locale || 'en', withTime
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    format = null
  }
  dateTimeFormats.set(key, format)
  return format
}

function relativeFormat(locale: string): Intl.RelativeTimeFormat | null {
  const cached = relativeFormats.get(locale)
  if (cached !== undefined) return cached
  let format: Intl.RelativeTimeFormat | null = null
  try {
    format = new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto' })
  } catch {
    format = null
  }
  relativeFormats.set(locale, format)
  return format
}

function absoluteDate(timestamp: number, locale: string, withTime: boolean): string {
  return dateTimeFormat(locale, withTime)?.format(new Date(timestamp)) ?? ''
}

/** "30 seconds ago", "5 minutes ago", "3 hours ago"; a date once it is a week old. */
export function formatRelativeTime(
  timestamp: number,
  locale: string,
  now: number = Date.now(),
): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''

  const elapsedSeconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (elapsedSeconds < DAY_SECONDS * 7) {
    let step = RELATIVE_STEPS[0]
    for (const candidate of RELATIVE_STEPS) {
      if (elapsedSeconds >= candidate.seconds) step = candidate
    }
    const format = relativeFormat(locale)
    if (format) {
      return format.format(-Math.round(elapsedSeconds / step.seconds), step.unit)
    }
    return absoluteDate(timestamp, locale, elapsedSeconds < DAY_SECONDS)
  }
  return absoluteDate(timestamp, locale, false)
}

/** Release dates come from GitHub as ISO strings; anything else renders nothing. */
export function formatPublishedDate(value: string | null | undefined, locale: string): string {
  if (typeof value !== 'string' || !value) return ''
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return ''
  return absoluteDate(timestamp, locale, false)
}

/**
 * Absolute date, with the time unless `withTime` says otherwise, written the way the
 * interface language writes it. A value that is not a timestamp yields an empty string,
 * so the caller keeps its own placeholder.
 */
export function formatDateTime(
  value: string | number | null | undefined,
  locale: string,
  withTime = true,
): string {
  if (value === null || value === undefined || value === '') return ''
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  return absoluteDate(timestamp, locale, withTime)
}
