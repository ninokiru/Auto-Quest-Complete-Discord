import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type ThemeMode = 'system' | 'light' | 'dark'

/** Where the mode lives. `theme` is the key older builds wrote. */
const MODE_KEY = 'theme_mode'
const LEGACY_KEY = 'theme'

function storedMode(): ThemeMode {
  const saved = localStorage.getItem(MODE_KEY)
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  const legacy = localStorage.getItem(LEGACY_KEY)
  if (legacy === 'light' || legacy === 'dark') return legacy
  return 'system'
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

/**
 * The one owner of the light/dark class on the document.
 *
 * Three modes: `system` follows the operating system and keeps following it
 * while the window stays open, while `light` and `dark` pin the palette until
 * the user changes it. The header toggle pins a mode; Settings offers the
 * explicit choice, including going back to `system`.
 */
export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(storedMode())
  const systemDark = ref(systemPrefersDark())

  const isDark = computed(() =>
    mode.value === 'system' ? systemDark.value : mode.value === 'dark',
  )

  function apply() {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(isDark.value ? 'dark' : 'light')
  }

  function setMode(next: ThemeMode) {
    mode.value = next
    localStorage.setItem(MODE_KEY, next)
    // Older builds read this key, so keep it aligned for a downgrade.
    localStorage.setItem(LEGACY_KEY, isDark.value ? 'dark' : 'light')
    apply()
  }

  /** The header button flips the palette the window is showing right now. */
  function toggle() {
    setMode(isDark.value ? 'light' : 'dark')
  }

  /** Keep following the operating system while the mode is `system`. */
  function watchSystem() {
    if (!window.matchMedia) return
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
      systemDark.value = event.matches
      if (mode.value === 'system') apply()
    })
  }

  return { mode, isDark, apply, setMode, toggle, watchSystem }
})
