// Settings that make sense to carry between machines. Runtime caches (detectable
// games, recent games) and secrets stay out of a preset file.
const PRESET_KEYS: readonly string[] = [
  'questHelper_gameQuestMode',
  'questHelper_speedMultiplier',
  'questHelper_heartbeatInterval',
  'questHelper_gamePollingInterval',
  'questHelper_cdpPort',
  'questHelper_showOrbsBalance',
  'questHelper_activityCheckpointMin',
  'questHelper_activityCheckpointMax',
  'questHelper_postQuestKeepAliveEnabled',
  'questHelper_postQuestKeepAlive',
  'questHelper_autoClaimRewards',
  'questHelper_simulationPath',
  'theme_mode',
  'aqc_ui_density',
]

interface PresetFile {
  app: 'auto-quest-complete-discord'
  version: 1
  exportedAt: string
  values: Record<string, string>
}

export function exportSettingsPreset(): string {
  const values: Record<string, string> = {}
  for (const key of PRESET_KEYS) {
    const value = localStorage.getItem(key)
    if (value !== null) values[key] = value
  }
  const preset: PresetFile = {
    app: 'auto-quest-complete-discord',
    version: 1,
    exportedAt: new Date().toISOString(),
    values,
  }
  return JSON.stringify(preset, null, 2)
}

/** Returns the number of settings applied. Throws on a malformed file. */
export function applySettingsPreset(json: string): number {
  const parsed = JSON.parse(json) as Partial<PresetFile>
  if (parsed?.app !== 'auto-quest-complete-discord' || parsed.version !== 1) {
    throw new Error('Not a settings preset from this app')
  }
  const values = parsed.values
  if (!values || typeof values !== 'object') throw new Error('Preset has no values')
  let applied = 0
  for (const key of PRESET_KEYS) {
    const value = values[key]
    if (typeof value !== 'string') continue
    localStorage.setItem(key, value)
    applied += 1
  }
  return applied
}
