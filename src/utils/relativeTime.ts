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

function absoluteDate(timestamp: number, locale: string, withTime: boolean): string {
  try {
    return new Intl.DateTimeFormat(locale || 'en', withTime
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' })
      .format(new Date(timestamp))
  } catch {
    return ''
  }
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
    try {
      return new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto' })
        .format(-Math.round(elapsedSeconds / step.seconds), step.unit)
    } catch {
      return absoluteDate(timestamp, locale, elapsedSeconds < DAY_SECONDS)
    }
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
