import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { readJson, writeJson, readString, writeString } from '@/utils/safeStorage'

export interface ReleaseInfo {
    tag_name: string
    html_url: string
    published_at: string
    name: string
    /** GitHub release description, i.e. the update log the panel renders. */
    body: string
    prerelease: boolean
}

interface ParsedVersion {
    core: [number, number, number]
    prerelease: string | null
}

/**
 * Parse a version string like "0.9.0-rc1" into its numeric core [0, 9, 0] and an
 * optional pre-release suffix ("rc1"). The pre-release is kept so it can be
 * ordered below the matching stable release.
 */
function parseVersion(version: string): ParsedVersion {
    const cleaned = version.replace(/^v/, '')
    const [coreStr, ...preParts] = cleaned.split('-')
    const parts = coreStr.split('.').map(part => {
        const n = parseInt(part, 10)
        return Number.isNaN(n) ? 0 : n
    })
    return {
        core: [parts[0] || 0, parts[1] || 0, parts[2] || 0],
        prerelease: preParts.length > 0 ? preParts.join('-') : null,
    }
}

/** Compare two dot-separated pre-release identifiers per semver precedence. */
function comparePrerelease(a: string, b: string): -1 | 0 | 1 {
    const as = a.split('.')
    const bs = b.split('.')
    const len = Math.max(as.length, bs.length)
    for (let i = 0; i < len; i++) {
        const x = as[i]
        const y = bs[i]
        if (x === undefined) return y === undefined ? 0 : -1
        if (y === undefined) return 1
        const nx = /^\d+$/.test(x) ? parseInt(x, 10) : null
        const ny = /^\d+$/.test(y) ? parseInt(y, 10) : null
        if (nx !== null && ny !== null) {
            if (nx !== ny) return nx < ny ? -1 : 1
            continue
        }
        // Numeric identifiers always have lower precedence than alphanumeric ones.
        if (nx !== null) return -1
        if (ny !== null) return 1
        if (x !== y) return x < y ? -1 : 1
    }
    return 0
}

/**
 * Compare two semver strings. Returns -1 / 0 / 1.
 * A pre-release (e.g. 1.2.0-rc1) is older than its stable release (1.2.0), while
 * the numeric core still compares numerically (0.10.10 > 0.9.9).
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
    const va = parseVersion(a)
    const vb = parseVersion(b)
    if (va.core[0] !== vb.core[0]) return va.core[0] < vb.core[0] ? -1 : 1
    if (va.core[1] !== vb.core[1]) return va.core[1] < vb.core[1] ? -1 : 1
    if (va.core[2] !== vb.core[2]) return va.core[2] < vb.core[2] ? -1 : 1
    if (va.prerelease === null && vb.prerelease === null) return 0
    if (va.prerelease === null) return 1
    if (vb.prerelease === null) return -1
    return comparePrerelease(va.prerelease, vb.prerelease)
}

const RELEASES_API = 'https://api.github.com/repos/ninokiru/Auto-Quest-Complete-Discord/releases'
const DISMISS_KEY = 'aqc_update_dismissed_tags'
const RELEASE_LOG_LIMIT = 15
// GitHub can hold a request open indefinitely behind a captive portal, which used to
// leave the header spinning on "checking" until the app restarted.
const FETCH_TIMEOUT_MS = 15_000

async function fetchGithubJson(url: string): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        const response = await fetch(url, {
            headers: { 'Accept': 'application/vnd.github.v3+json' },
            signal: controller.signal,
        })
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`)
        return await response.json()
    } catch (error) {
        if (controller.signal.aborted) throw new Error(`GitHub API timed out after ${FETCH_TIMEOUT_MS / 1000}s`)
        throw error
    } finally {
        clearTimeout(timer)
    }
}

/** GitHub's payload is untyped here; anything malformed drops instead of half-loading. */
function toReleaseInfo(value: unknown): ReleaseInfo | null {
    if (value === null || typeof value !== 'object') return null
    const raw = value as Record<string, unknown>
    if (typeof raw.tag_name !== 'string' || !raw.tag_name.trim()) return null
    const text = (candidate: unknown, fallback = ''): string =>
        typeof candidate === 'string' ? candidate : fallback
    return {
        tag_name: raw.tag_name.trim(),
        html_url: text(raw.html_url),
        published_at: text(raw.published_at),
        name: text(raw.name, raw.tag_name.trim()),
        body: text(raw.body),
        prerelease: raw.prerelease === true,
    }
}

function toReleaseList(value: unknown): ReleaseInfo[] {
    if (!Array.isArray(value)) {
        const single = toReleaseInfo(value)
        return single ? [single] : []
    }
    return value
        .map(toReleaseInfo)
        .filter((release): release is ReleaseInfo => release !== null)
}

export const useVersionStore = defineStore('version', () => {
    const currentVersion = ref<string>('Dev')
    const latestRelease = ref<ReleaseInfo | null>(null)
    const checkError = ref<string | null>(null)
    const isChecking = ref(false)
    const hasChecked = ref(false)
    const checkPreRelease = ref(readString('checkPreRelease') === 'true')

    // Bumped on every request so a slower response from an earlier request can
    // never overwrite state that a newer request already committed.
    let versionInfoGeneration = 0
    let updateCheckGeneration = 0
    let releaseLogGeneration = 0

    const releaseLog = ref<ReleaseInfo[]>([])
    const releaseLogError = ref<string | null>(null)
    const isReleaseLogLoading = ref(false)
    const releaseLogLoaded = ref(false)

    // Tags the user chose "not now" for. A newer tag is never silenced, so the
    // dialog keeps working without anyone clearing storage. The stored value comes
    // from disk, so it is re-validated rather than trusted to be an array of strings.
    const storedDismissedTags = readJson<unknown>(DISMISS_KEY, [])
    const dismissedUpdateTags = ref<string[]>(Array.isArray(storedDismissedTags)
      ? storedDismissedTags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag))
      : [])

    const isPreRelease = computed(() =>
        currentVersion.value !== 'Dev' && currentVersion.value.toLowerCase().includes('rc'),
    )

    const hasUpdate = computed(() => {
        if (!latestRelease.value || currentVersion.value === 'Dev') return false
        const current = currentVersion.value.replace(/^v/, '')
        const latest = latestRelease.value.tag_name.replace(/^v/, '')
        return compareSemver(latest, current) > 0
    })

    const isLatest = computed(() => {
        return hasChecked.value && !hasUpdate.value && !checkError.value
    })

    /**
     * The tag the update dialog should announce, or null when there is nothing to
     * show. A tag the user postponed is announced once per session at most, while a
     * later release always qualifies again.
     */
    const pendingUpdateTag = computed(() => {
        if (!hasUpdate.value || !latestRelease.value) return null
        const tag = latestRelease.value.tag_name
        return dismissedUpdateTags.value.includes(tag) ? null : tag
    })

    async function loadCurrentVersion() {
        const generation = ++versionInfoGeneration
        try {
            const res = await fetch('/version.txt')
            if (res.ok) {
                const text = await res.text()
                if (text && generation === versionInfoGeneration) {
                    currentVersion.value = text.trim()
                }
            }
        } catch {
            // Keep 'Dev' as default
        }
    }

    async function checkForUpdate() {
        const generation = ++updateCheckGeneration
        // Snapshot the channel so the response is parsed with the same mode that
        // built the URL, even if the toggle flips while this request is running.
        const includePreRelease = checkPreRelease.value

        isChecking.value = true
        checkError.value = null

        try {
            const url = includePreRelease ? RELEASES_API : `${RELEASES_API}/latest`
            const data = await fetchGithubJson(url)
            if (generation !== updateCheckGeneration) return

            // The list endpoint is newest-first, the /latest endpoint is one object.
            const release = includePreRelease ? toReleaseList(data)[0] : toReleaseInfo(data)
            if (!release) throw new Error('No releases found')
            latestRelease.value = release
            hasChecked.value = true
        } catch (e) {
            if (generation !== updateCheckGeneration) return
            checkError.value = e instanceof Error ? e.message : 'Failed to check for updates'
            console.error('Version check failed:', e)
        } finally {
            if (generation === updateCheckGeneration) {
                isChecking.value = false
            }
        }
    }

    function setCheckPreRelease(value: boolean) {
        checkPreRelease.value = value
        writeString('checkPreRelease', String(value))
        hasChecked.value = false
        latestRelease.value = null
        checkForUpdate()
    }

    /**
     * Fetch the release list that backs the update log. Cached after the first
     * success because the panel can be opened repeatedly in one session.
     */
    async function loadReleaseLog(force = false) {
        if (!force && (releaseLogLoaded.value || isReleaseLogLoading.value)) return
        const generation = ++releaseLogGeneration

        isReleaseLogLoading.value = true
        releaseLogError.value = null
        try {
            const data = await fetchGithubJson(`${RELEASES_API}?per_page=${RELEASE_LOG_LIMIT}`)
            if (generation !== releaseLogGeneration) return

            const releases = toReleaseList(data)
            releaseLog.value = releases
            releaseLogLoaded.value = true

            // The list is newest-first, so it can also correct a stale /latest result —
            // but only within the channel the user asked for.
            const newest = releases.find(release => !release.prerelease || checkPreRelease.value)
            if (newest && (!latestRelease.value
              || compareSemver(newest.tag_name, latestRelease.value.tag_name) > 0)) {
                latestRelease.value = newest
                hasChecked.value = true
            }
        } catch (e) {
            if (generation !== releaseLogGeneration) return
            releaseLogError.value = e instanceof Error ? e.message : String(e)
        } finally {
            if (generation === releaseLogGeneration) isReleaseLogLoading.value = false
        }
    }

    function dismissUpdate(tag: string) {
        if (!tag || dismissedUpdateTags.value.includes(tag)) return
        dismissedUpdateTags.value = [...dismissedUpdateTags.value, tag].slice(-20)
        writeJson(DISMISS_KEY, dismissedUpdateTags.value)
    }

    /** Settings escape hatch for someone who postponed an update and changed their mind. */
    function restoreUpdateReminder() {
        if (dismissedUpdateTags.value.length === 0) return
        dismissedUpdateTags.value = []
        writeJson(DISMISS_KEY, [])
    }

    async function initialize() {
        await loadCurrentVersion()
        // Force pre-release update checks when running an RC build,
        // without persisting the user's original setting.
        if (isPreRelease.value) {
            checkPreRelease.value = true
        }
        await checkForUpdate()
    }

    return {
        currentVersion,
        latestRelease,
        checkError,
        isChecking,
        hasChecked,
        hasUpdate,
        isLatest,
        isPreRelease,
        checkPreRelease,
        releaseLog,
        releaseLogError,
        isReleaseLogLoading,
        releaseLogLoaded,
        dismissedUpdateTags,
        pendingUpdateTag,
        loadCurrentVersion,
        checkForUpdate,
        loadReleaseLog,
        dismissUpdate,
        restoreUpdateReminder,
        setCheckPreRelease,
        initialize
    }
})
