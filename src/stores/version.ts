import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

export interface ReleaseInfo {
    tag_name: string
    html_url: string
    published_at: string
    name: string
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

export const useVersionStore = defineStore('version', () => {
    const currentVersion = ref<string>('Dev')
    const latestRelease = ref<ReleaseInfo | null>(null)
    const checkError = ref<string | null>(null)
    const isChecking = ref(false)
    const hasChecked = ref(false)
    const checkPreRelease = ref(localStorage.getItem('checkPreRelease') === 'true')

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

    async function loadCurrentVersion() {
        try {
            const res = await fetch('/version.txt')
            if (res.ok) {
                const text = await res.text()
                if (text) {
                    currentVersion.value = text.trim()
                }
            }
        } catch {
            // Keep 'Dev' as default
        }
    }

    async function checkForUpdate() {
        if (isChecking.value) return

        isChecking.value = true
        checkError.value = null

        try {
            const url = checkPreRelease.value
              ? 'https://api.github.com/repos/ninokiru/Auto-Quest-Complete-Discord/releases'
              : 'https://api.github.com/repos/ninokiru/Auto-Quest-Complete-Discord/releases/latest'

            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/vnd.github.v3+json'
                }
            })

            if (!res.ok) {
                throw new Error(`GitHub API returned ${res.status}`)
            }

            const data = await res.json()

            if (checkPreRelease.value) {
                // Array of releases — pick the first one (newest, including pre-releases)
                const release = Array.isArray(data) ? data[0] : data
                if (!release) throw new Error('No releases found')
                latestRelease.value = {
                    tag_name: release.tag_name,
                    html_url: release.html_url,
                    published_at: release.published_at,
                    name: release.name
                }
            } else {
                latestRelease.value = {
                    tag_name: data.tag_name,
                    html_url: data.html_url,
                    published_at: data.published_at,
                    name: data.name
                }
            }
            hasChecked.value = true
        } catch (e) {
            checkError.value = e instanceof Error ? e.message : 'Failed to check for updates'
            console.error('Version check failed:', e)
        } finally {
            isChecking.value = false
        }
    }

    function setCheckPreRelease(value: boolean) {
        checkPreRelease.value = value
        localStorage.setItem('checkPreRelease', String(value))
        hasChecked.value = false
        latestRelease.value = null
        checkForUpdate()
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
        loadCurrentVersion,
        checkForUpdate,
        setCheckPreRelease,
        initialize
    }
})
