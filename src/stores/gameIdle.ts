import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  GameIdleMode,
  GameIdleItem,
  GameIdleStatus,
  GameSimulationHistoryEntry,
} from '@/api/tauri'
import {
  getGameIdleStatus,
  getGameSimulationHistory,
  onGameIdleStatus,
  onGameSimulationHistoryUpdated,
  removeGameIdleQueueItem,
  startGameIdle,
  stopGameIdle,
} from '@/api/tauri'
import { useQuestsStore } from './quests'

const PLAY_MINUTES_KEY = 'questHelper_gameIdlePlayMinutes'
const REST_MINUTES_KEY = 'questHelper_gameIdleRestMinutes'
const MODE_KEY = 'questHelper_gameIdleMode'
const CONCURRENT_GAMES_KEY = 'questHelper_gameIdleConcurrentGames'

// Mirrors `MAX_CONCURRENT_GAMES` in src-tauri/src/game_idle.rs: Discord has one
// rich-presence slot, so extra lanes are detected only as running processes.
export const MAX_CONCURRENT_GAMES = 36

function savedInteger(
  key: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const raw = localStorage.getItem(key)
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function clearStoppedQueue(value: GameIdleStatus | null): GameIdleStatus | null {
  if (!value || value.phase !== 'stopped') return value
  return {
    ...value,
    lanes: [],
    recent: [],
    upcoming: [],
  }
}

export function formatSimulationDuration(totalSeconds: number): { hours: number; minutes: number } {
  const totalMinutes = Math.floor(Math.max(0, totalSeconds) / 60)
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  }
}

export const useGameIdleStore = defineStore('gameIdle', () => {
  const quests = useQuestsStore()
  const playMinutes = ref(savedInteger(PLAY_MINUTES_KEY, 60, 1))
  const restMinutes = ref(savedInteger(REST_MINUTES_KEY, 0, 0))
  const concurrentGames = ref(savedInteger(CONCURRENT_GAMES_KEY, 1, 1, MAX_CONCURRENT_GAMES))
  const savedMode = localStorage.getItem(MODE_KEY)
  const mode = ref<GameIdleMode>(savedMode === 'process' || savedMode === 'cdp' ? savedMode : 'process')
  const status = ref<GameIdleStatus | null>(null)
  const history = ref<Record<string, GameSimulationHistoryEntry>>({})
  const loading = ref(false)
  const stopping = ref(false)
  const stopRequested = ref(false)
  const error = ref<string | null>(null)
  let initialized = false
  let initialization: Promise<void> | null = null
  let accountGeneration = 0
  let pendingStart: Promise<void> | null = null
  let statusUnlisten: (() => void) | null = null
  let historyUnlisten: (() => void) | null = null

  const isActive = computed(() => {
    const phase = status.value?.phase
    return phase !== undefined && phase !== 'stopped'
  })

  // A CDP spoof is written into the Discord client one game at a time, so the
  // requested lane count only applies to process simulation.
  const effectiveConcurrentGames = computed(() =>
    mode.value === 'cdp' ? 1 : concurrentGames.value
  )

  function persistConfig() {
    localStorage.setItem(PLAY_MINUTES_KEY, String(playMinutes.value))
    localStorage.setItem(REST_MINUTES_KEY, String(restMinutes.value))
    localStorage.setItem(CONCURRENT_GAMES_KEY, String(concurrentGames.value))
    localStorage.setItem(MODE_KEY, mode.value)
  }

  function validateConfig(): string | null {
    if (!Number.isSafeInteger(playMinutes.value) || playMinutes.value <= 0) {
      return 'play_minutes'
    }
    if (!Number.isSafeInteger(restMinutes.value) || restMinutes.value < 0) {
      return 'rest_minutes'
    }
    if (
      mode.value === 'process' &&
      (!Number.isSafeInteger(concurrentGames.value) ||
        concurrentGames.value < 1 ||
        concurrentGames.value > MAX_CONCURRENT_GAMES)
    ) {
      return 'concurrent_games'
    }
    return null
  }

  async function refreshHistory() {
    const entries = await getGameSimulationHistory()
    history.value = Object.fromEntries(entries.map(entry => [entry.appId, entry]))
  }

  async function initialize() {
    if (initialized) return
    // Concurrent mounts share one handshake: a second caller waits for the
    // first instead of resolving against a half-populated store.
    if (initialization) return initialization
    const pending = initializeOnce()
    initialization = pending
    try {
      await pending
    } finally {
      if (initialization === pending) initialization = null
    }
  }

  async function initializeOnce() {
    try {
      await Promise.all([quests.initPlatformCapabilities(), quests.initCdpMode().catch(() => undefined)])
      if (savedMode === null) {
        mode.value = quests.cdpAvailable ? 'cdp' : 'process'
      }
      const [activeStatus] = await Promise.all([
        getGameIdleStatus(),
        refreshHistory().catch(error => console.warn('Failed to load game history:', error)),
      ])
      status.value = clearStoppedQueue(activeStatus)
      if (activeStatus && activeStatus.phase !== 'stopped') {
        playMinutes.value = activeStatus.playMinutes
        restMinutes.value = activeStatus.restMinutes
        concurrentGames.value = activeStatus.concurrentGames
        mode.value = activeStatus.mode
      }
      statusUnlisten = await onGameIdleStatus(next => {
        status.value = clearStoppedQueue(next)
      })
      historyUnlisten = await onGameSimulationHistoryUpdated(entry => {
        history.value = { ...history.value, [entry.appId]: entry }
      })
      // Only a completed handshake may block a later attempt; a failure stays
      // retryable and never leaves its listeners bound to a dead store.
      initialized = true
    } catch (cause) {
      statusUnlisten?.()
      historyUnlisten?.()
      statusUnlisten = null
      historyUnlisten = null
      throw cause
    }
  }

  async function start() {
    const validation = validateConfig()
    if (validation) throw new Error(validation)
    if (loading.value || isActive.value) return
    const generation = accountGeneration
    loading.value = true
    stopRequested.value = false
    error.value = null
    const task = (async () => {
      try {
        const [games, simulationPath] = await Promise.all([
          quests.getDetectableGames(),
          quests.initSimulationPath(),
        ])
        if (generation !== accountGeneration) return
        persistConfig()
        status.value = await startGameIdle(
          {
            mode: mode.value,
            playMinutes: playMinutes.value,
            restMinutes: restMinutes.value,
            concurrentGames: effectiveConcurrentGames.value,
            cdpPort: quests.cdpPort,
            simulationPath,
          },
          games
        )
        // A stop click can arrive while candidates/path are still being loaded.
        // The backend session is created by the time this resolves, so finish
        // the requested stop immediately instead of leaving a detached worker.
        if (stopRequested.value) await stop()
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
        throw cause
      } finally {
        loading.value = false
        if (!isActive.value) stopRequested.value = false
      }
    })()
    pendingStart = task
    try {
      await task
    } finally {
      if (pendingStart === task) pendingStart = null
    }
  }

  async function stop() {
    if (stopping.value) return
    stopRequested.value = true
    if (loading.value && !isActive.value) return
    stopRequested.value = false
    stopping.value = true
    error.value = null
    try {
      // A stopped session will be rebuilt from a fresh shuffle bag on the
      // next start. Do not leave the old reel on screen as if it were still
      // actionable; clear it before rendering the stopped state.
      status.value = clearStoppedQueue(await stopGameIdle())
      await refreshHistory()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      stopping.value = false
    }
  }

  async function removeUpcoming(item: GameIdleItem) {
    const current = status.value
    if (!current) return
    // After a session is stopped the backend manager is released, but the
    // final queue remains useful as a preview for the next run. Allow it to be
    // edited locally instead of sending a request to a manager that no longer
    // exists; the next start will build a fresh queue from the candidates.
    if (current.phase === 'stopped') {
      status.value = {
        ...current,
        upcoming: current.upcoming.filter(entry => entry.occurrenceId !== item.occurrenceId),
      }
      return
    }
    const sessionId = current.sessionId
    if (!sessionId) return
    status.value = await removeGameIdleQueueItem(sessionId, item.id, item.occurrenceId)
  }

  async function stopForAccountChange() {
    accountGeneration++
    stopRequested.value = true
    await pendingStart?.catch(() => undefined)
    if (isActive.value) {
      await stop()
    }
    status.value = null
    history.value = {}
  }

  return {
    playMinutes,
    restMinutes,
    concurrentGames,
    mode,
    status,
    history,
    loading,
    stopping,
    stopRequested,
    error,
    isActive,
    effectiveConcurrentGames,
    initialize,
    refreshHistory,
    start,
    stop,
    removeUpcoming,
    stopForAccountChange,
    validateConfig,
  }
})
