import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Quest, DetectableGame, DesktopClientArg, ExcludedQuest, GameQuestMode, PlatformCapabilities, QuestTaskStatus } from '@/api/tauri'
import {
  firstProgressValue,
  firstStartableTask,
  getQuestKind,
  getQuestTasks,
  isManualActivityQuest,
  isManualStreamQuest,
  isPlayActivityQuest,
  playActivityProgressPercentage,
} from '@/utils/questTasks'
import { resolveSimulationExecutable } from '@/utils/executables'
import { announceQuestEnd } from '@/utils/questNotifier'

/** Clamp a 0..100 percentage so no consumer renders a value outside its range. */
function clampProgressPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** Quest with optional pre-selected executable name for batch game quest processing */
interface QueueItem extends Quest {
  selectedExeName?: string
}

export type RunningQuestType = 'video' | 'stream' | 'game' | 'activity'

/**
 * One quest occupying a parallel slot. Each slot owns its progress, its
 * simulated executable and its history segment, so finishing one quest can
 * never tear down another quest's work.
 */
export interface RunningQuest {
  questId: string
  type: RunningQuestType
  targetDuration: number
  /**
   * Unit of `targetDuration` and of both progress counters. Activity quests are
   * counted in checkpoints, every other kind in seconds, so the same number
   * means different things and the unit travels with the slot instead of being
   * re-derived at render time.
   */
  progressUnit: 'time' | 'checkpoints'
  /** Percentage reported by the backend (events or quest-list polling). */
  serverProgress: number
  /** Percentage from the local animation loop, never below `serverProgress`. */
  localProgress: number
  gameExe: string | null
  simulationAppId: string | null
  /**
   * True once this quest published a Discord presence. There is one RPC client
   * per account, so only the first running quest connects; a slot that never
   * connected must not disconnect somebody else's presence when it ends.
   */
  rpcConnected: boolean
  /**
   * False for simulate-mode game quests: those have no backend task, so their
   * completion only shows up in the quest list, never in a quest event or the
   * task-status registry.
   */
  hasBackendTask: boolean
}

/** The unit a slot counts its target and its polled progress in. */
type SlotProgressUnit = RunningQuest['progressUnit']

/**
 * A recoverable, non-fatal quest condition surfaced to the UI.
 *
 * Unlike a thrown Error, a soft error does not abort the queue or read as a
 * system failure — it drives a dialog that can steer the user to a working mode
 * (e.g. CDP) without losing quest context.
 */
export interface QuestSoftError {
  code:
    | 'SIMULATION_EXECUTABLE_OS_UNSUPPORTED'
    | 'SIMULATION_EXECUTABLE_NOT_FOUND'
    | 'SIMULATION_PLATFORM_UNSUPPORTED'
  /** English fallback message; the UI localizes by `code` using `gameName`. */
  message: string
  /** Detectable-game name, so the dialog can render a localized message. */
  gameName: string
  questId: string
  recommendedMode?: 'cdp'
  recoverable: true
}

/** Why the quest queue is currently paused. */
export type QueuePauseReason =
  | 'user'
  | 'simulation_incompatible'
  | 'cdp_restart_required'
  | 'authentication_required'
import {
  getQuestsFull,
  startVideoQuest,
  startStreamQuest,
  stopQuest,
  onQuestProgress,
  onQuestComplete,
  onQuestError,
  createSimulatedGame,
  runSimulatedGame,
  stopSimulatedGame,
  fetchDetectableGames,
  connectToDiscordRpc,
  acceptQuest,
  startGameHeartbeatQuest,
  startPlayActivityQuest,
  forceVideoProgress,
  startCdpQuest,
  checkCdpStatus,
  getVirtualCurrencyBalance,
  getPlatformCapabilities,
  startGameSimulationUsage,
  stopGameSimulationUsage,
  getQuestTaskStatuses,
} from '@/api/tauri'
import { appLocalDataDir, join } from '@tauri-apps/api/path'
import { emit } from '@tauri-apps/api/event'


// localStorage keys
const STORAGE_SPEED_KEY = 'questHelper_speedMultiplier'
const STORAGE_SIMULATION_PATH_KEY = 'questHelper_simulationPath'

export const useQuestsStore = defineStore('quests', () => {
  const quests = ref<Quest[]>([])
  const excludedQuests = ref<ExcludedQuest[]>([])
  const questEnrollmentBlockedUntil = ref<string | null>(null)
  const lastQuestsFetchTime = ref(0)
  const loading = ref(false)
  const refreshing = ref(false)
  const hasLoadedQuests = ref(false)
  const startingQuestId = ref<string | null>(null)
  const stopping = ref(false)
  const error = ref<string | null>(null)
  const orbsBalance = ref<number | null>(null)
  const orbsBalanceFetchedAt = ref<string | null>(null)
  const orbsBalanceLoading = ref(false)
  const orbsBalanceError = ref<string | null>(null)

  // Single source of truth for every process-simulation entry point. The
  // asynchronous default is resolved lazily by initSimulationPath().
  const simulationPath = ref(localStorage.getItem(STORAGE_SIMULATION_PATH_KEY) ?? '')
  let simulationPathRevision = 0

  /** Upper bound on concurrently running quests. The backend enforces the same
   *  cap; this only keeps the UI from issuing starts it would reject. */
  const MAX_PARALLEL_QUESTS = 5
  const runningQuests = ref<RunningQuest[]>([])

  function questSlot(questId: string | null): RunningQuest | null {
    if (!questId) return null
    return runningQuests.value.find(slot => slot.questId === questId) ?? null
  }

  /** Reserve a slot before the start command runs, so a second click on the same
   *  quest cannot slip past the duplicate check while the first start is still
   *  awaiting the backend. */
  function openQuestSlot(
    questId: string,
    type: RunningQuestType,
    targetDuration: number,
    progressUnit: SlotProgressUnit,
    serverProgress: number,
    hasBackendTask: boolean
  ): RunningQuest {
    const existing = questSlot(questId)
    if (existing) {
      existing.type = type
      existing.targetDuration = targetDuration
      existing.progressUnit = progressUnit
      existing.serverProgress = serverProgress
      existing.hasBackendTask = hasBackendTask
      return existing
    }
    runningQuests.value.push({
      questId,
      type,
      targetDuration,
      progressUnit,
      serverProgress,
      localProgress: serverProgress,
      gameExe: null,
      simulationAppId: null,
      rpcConnected: false,
      hasBackendTask,
    })
    // Return the reactive proxy, not the plain object that was pushed.
    return questSlot(questId)!
  }

  function closeQuestSlot(questId: string) {
    const index = runningQuests.value.findIndex(slot => slot.questId === questId)
    if (index !== -1) runningQuests.value.splice(index, 1)
  }

  /**
   * Reject a start the UI cannot track: the same quest already running, or the
   * parallel cap already reached. The backend enforces both again for its own
   * registry, so this only saves a doomed round trip.
   */
  function ensureLocalQuestSlot(questId: string) {
    if (questSlot(questId)) {
      const message = `Quest ${questId} is already running; stop it before starting it again`
      error.value = message
      throw new Error(message)
    }
    if (runningQuests.value.length >= MAX_PARALLEL_QUESTS) {
      const message = `At most ${MAX_PARALLEL_QUESTS} quests can run at the same time`
      error.value = message
      throw new Error(message)
    }
  }

  // Single-quest readers (progress panel, quest cards, simulator page) follow the
  // first running quest. `runningQuests` is the source of truth.
  const primaryQuest = computed(() => runningQuests.value[0] ?? null)
  const activeQuestId = computed(() => primaryQuest.value?.questId ?? null)
  const activeQuestType = computed<RunningQuestType | null>(() => primaryQuest.value?.type ?? null)
  const activeQuestProgress = computed(() => primaryQuest.value?.serverProgress ?? 0)
  const activeQuestTargetDuration = computed(() => primaryQuest.value?.targetDuration ?? 0)
  const localProgress = computed(() => primaryQuest.value?.localProgress ?? 0)
  const activeGameExe = computed(() => primaryQuest.value?.gameExe ?? null)
  // Application whose history segment the primary quest owns. Simulated games can
  // run alongside manually started ones, so cleanup must finish only the quest's
  // own segment instead of every recorded application.
  const activeSimulationAppId = computed({
    get: () => primaryQuest.value?.simulationAppId ?? null,
    set: appId => {
      if (primaryQuest.value) primaryQuest.value.simulationAppId = appId
    },
  })

  // Speed multiplier - read from localStorage, default 1, range 0.1 - 2.0
  const savedSpeed = localStorage.getItem(STORAGE_SPEED_KEY)
  let initialSpeed = savedSpeed ? parseFloat(savedSpeed) : 1.0
  // Validate range (0.1 to 2.0)
  if (isNaN(initialSpeed) || initialSpeed < 0.1 || initialSpeed > 2.0) {
    initialSpeed = 1.0
  }
  const speedMultiplier = ref(initialSpeed)

  // Heartbeat interval (seconds) - for Video quests API heartbeat requests
  const STORAGE_INTERVAL_KEY = 'questHelper_heartbeatInterval'
  const savedInterval = localStorage.getItem(STORAGE_INTERVAL_KEY)
  let initialInterval = savedInterval ? parseInt(savedInterval) : 15
  // Validate range (10 to 30)
  if (isNaN(initialInterval) || initialInterval < 10 || initialInterval > 30) {
    initialInterval = 15
  }
  const heartbeatInterval = ref(initialInterval)

  // Game polling interval (seconds) - for Play/Game quests progress detection
  const STORAGE_GAME_POLLING_KEY = 'questHelper_gamePollingInterval'
  const savedGamePolling = localStorage.getItem(STORAGE_GAME_POLLING_KEY)
  let initialGamePolling = savedGamePolling ? parseInt(savedGamePolling) : 120
  // Validate range (30 to 300)
  if (isNaN(initialGamePolling) || initialGamePolling < 30 || initialGamePolling > 300) {
    initialGamePolling = 120
  }
  const gamePollingInterval = ref(initialGamePolling)

  // Game Quest Mode - 'simulate' runs a fake game exe, 'heartbeat' sends direct API heartbeats, 'cdp' injects via CDP
  const STORAGE_GAME_QUEST_MODE_KEY = 'questHelper_gameQuestMode'
  const savedGameQuestMode = localStorage.getItem(STORAGE_GAME_QUEST_MODE_KEY)
  const gameQuestMode = ref<GameQuestMode>(
    savedGameQuestMode === 'heartbeat' ? 'heartbeat'
    : savedGameQuestMode === 'cdp' ? 'cdp'
    : 'simulate'
  )

  // Read-only platform capability descriptor (loaded once from the backend).
  const platformCapabilities = ref<PlatformCapabilities | null>(null)
  // True once the first load attempt has settled (success or failure), so the UI
  // can avoid rendering platform-dependent affordances against a null descriptor.
  const platformCapabilitiesReady = ref(false)
  // In-flight load, so the fire-and-forget call at store creation and the
  // awaiting callers (startPlay, the Home pre-selection flows) share one fetch.
  let platformCapabilitiesInFlight: Promise<PlatformCapabilities | null> | null = null

  /**
   * Load the platform capability descriptor. On first run (no saved mode) this
   * applies the platform's default Play-Quest mode — 'cdp' on Linux, 'simulate'
   * on Windows/macOS — without ever overriding a preference the user has set.
   * Safe to call more than once and from several callers concurrently; only the
   * first call fetches, and later ones resolve from the cached descriptor.
   */
  async function initPlatformCapabilities(): Promise<PlatformCapabilities | null> {
    if (platformCapabilities.value) return platformCapabilities.value
    if (platformCapabilitiesInFlight) return platformCapabilitiesInFlight

    platformCapabilitiesInFlight = (async () => {
      try {
        const caps = await getPlatformCapabilities()
        platformCapabilities.value = caps
        // Re-read at resolve time rather than trusting `savedGameQuestMode`,
        // which is a store-setup snapshot. If the user picked a mode from
        // Settings while this fetch was in flight, the `gameQuestMode` watcher
        // has already persisted it, and applying the platform default here
        // would silently clobber that fresh choice.
        const currentSavedMode = localStorage.getItem(STORAGE_GAME_QUEST_MODE_KEY)
        if (
          currentSavedMode === null &&
          (caps.defaultGameQuestMode === 'simulate' ||
            caps.defaultGameQuestMode === 'heartbeat' ||
            caps.defaultGameQuestMode === 'cdp')
        ) {
          gameQuestMode.value = caps.defaultGameQuestMode
        }
        return caps
      } catch (error) {
        console.warn('Failed to load platform capabilities:', error)
        return null
      } finally {
        platformCapabilitiesReady.value = true
        platformCapabilitiesInFlight = null
      }
    })()

    return platformCapabilitiesInFlight
  }

  // Recoverable soft error (e.g. win32-only game on Linux simulate mode) that
  // the UI surfaces as an actionable dialog rather than a fatal error.
  const softError = ref<QuestSoftError | null>(null)
  const queuePauseReason = ref<QueuePauseReason | null>(null)
  // Remember the last Play-Quest request so "switch to CDP and retry" can resume it.
  const lastPlayRequest = ref<{ quest: Quest; secondsNeeded: number; initialProgress: number; selectedExeName?: string } | null>(null)

  // CDP availability status
  const cdpAvailable = ref(false)

  // CDP Port - default 9223, user configurable
  const STORAGE_CDP_PORT_KEY = 'questHelper_cdpPort'
  const savedCdpPort = localStorage.getItem(STORAGE_CDP_PORT_KEY)
  // The port is sent to the backend as an `u16` IPC argument, so reject NaN and
  // anything outside the valid TCP range before storing it (mirrors the other
  // numeric settings).
  let initialCdpPort = savedCdpPort ? parseInt(savedCdpPort, 10) : 9223
  if (isNaN(initialCdpPort) || initialCdpPort < 1 || initialCdpPort > 65535) {
    initialCdpPort = 9223
  }
  const cdpPort = ref(initialCdpPort)

  const STORAGE_DESKTOP_CLIENT_KEY = 'questHelper_desktopClient'
  const savedDesktopClient = localStorage.getItem(STORAGE_DESKTOP_CLIENT_KEY)
  const desktopClient = ref<DesktopClientArg>(
    savedDesktopClient === 'official' || savedDesktopClient === 'vesktop' || savedDesktopClient === 'auto'
      ? savedDesktopClient
      : 'auto',
  )

  // Optional display: account Orbs balance. Disabled by default to avoid extra requests.
  const STORAGE_SHOW_ORBS_BALANCE_KEY = 'questHelper_showOrbsBalance'
  const savedShowOrbsBalance = localStorage.getItem(STORAGE_SHOW_ORBS_BALANCE_KEY)
  const showOrbsBalance = ref(savedShowOrbsBalance === null ? true : savedShowOrbsBalance === 'true')

  async function getDefaultSimulationPath(): Promise<string> {
    try {
      const base = await appLocalDataDir()
      return await join(base, 'GameRuntime')
    } catch {
      throw new Error('Failed to resolve the default game simulation directory.')
    }
  }

  async function initSimulationPath(): Promise<string> {
    const configuredPath = simulationPath.value
    if (configuredPath.trim()) {
      return configuredPath
    }

    const defaultPath = await getDefaultSimulationPath()

    // Do not overwrite a path selected while the asynchronous Tauri calls
    // above were in flight.
    const latestConfiguredPath = simulationPath.value
    if (latestConfiguredPath.trim()) return latestConfiguredPath

    simulationPath.value = defaultPath
    return defaultPath
  }

  function setSimulationPath(path: string): void {
    if (!path.trim()) {
      throw new Error('Simulation path cannot be empty')
    }
    simulationPathRevision += 1
    simulationPath.value = path
  }

  async function resetSimulationPath(): Promise<string> {
    const revisionBeforeReset = simulationPathRevision
    const defaultPath = await getDefaultSimulationPath()

    // A later directory selection wins over this in-flight reset.
    if (simulationPathRevision !== revisionBeforeReset && simulationPath.value.trim()) {
      return simulationPath.value
    }

    simulationPathRevision += 1
    simulationPath.value = defaultPath
    return defaultPath
  }

  // Activity quest checkpoint interval (seconds) - min/max time between checkpoints
  const STORAGE_ACTIVITY_CHECKPOINT_MIN_KEY = 'questHelper_activityCheckpointMin'
  const savedCheckpointMin = localStorage.getItem(STORAGE_ACTIVITY_CHECKPOINT_MIN_KEY)
  let initialCheckpointMin = savedCheckpointMin ? parseInt(savedCheckpointMin) : 180
  if (isNaN(initialCheckpointMin) || initialCheckpointMin < 30 || initialCheckpointMin > 600) {
    initialCheckpointMin = 180
  }

  const STORAGE_ACTIVITY_CHECKPOINT_MAX_KEY = 'questHelper_activityCheckpointMax'
  const savedCheckpointMax = localStorage.getItem(STORAGE_ACTIVITY_CHECKPOINT_MAX_KEY)
  let initialCheckpointMax = savedCheckpointMax ? parseInt(savedCheckpointMax) : 300
  if (isNaN(initialCheckpointMax) || initialCheckpointMax < 60 || initialCheckpointMax > 900) {
    initialCheckpointMax = 300
  }

  // A stored min above max makes the checkpoint random range
  // `Math.random() * (max - min + 1) + min` degenerate (zero-width or negative).
  // The runtime watchers enforce ordering only on change, so reconcile here too.
  if (initialCheckpointMin > initialCheckpointMax) {
    initialCheckpointMin = 180
    initialCheckpointMax = 300
  }

  const activityCheckpointMin = ref(initialCheckpointMin)
  const activityCheckpointMax = ref(initialCheckpointMax)

  // Persist speed changes to localStorage
  watch(speedMultiplier, (newSpeed) => {
    localStorage.setItem(STORAGE_SPEED_KEY, String(newSpeed))
  })

  // Persist heartbeat interval changes
  watch(heartbeatInterval, (newInterval) => {
    localStorage.setItem(STORAGE_INTERVAL_KEY, String(newInterval))
  })

  // Persist game polling interval changes
  watch(gamePollingInterval, (newInterval) => {
    localStorage.setItem(STORAGE_GAME_POLLING_KEY, String(newInterval))
  })

  // Persist game quest mode changes
  watch(gameQuestMode, (newMode) => {
    localStorage.setItem(STORAGE_GAME_QUEST_MODE_KEY, newMode)
  })

  // Persist CDP port changes
  watch(cdpPort, (newPort) => {
    localStorage.setItem(STORAGE_CDP_PORT_KEY, String(newPort))
  })

  watch(desktopClient, (client) => {
    localStorage.setItem(STORAGE_DESKTOP_CLIENT_KEY, client)
  })

  watch(showOrbsBalance, (enabled) => {
    localStorage.setItem(STORAGE_SHOW_ORBS_BALANCE_KEY, String(enabled))
    if (enabled && orbsBalance.value == null) {
      fetchOrbsBalance().catch(err => {
        console.warn('Background Orbs balance fetch failed:', err)
      })
    }
  })

  watch(simulationPath, (path) => {
    if (path.trim()) {
      localStorage.setItem(STORAGE_SIMULATION_PATH_KEY, path)
    }
  }, { flush: 'sync' })

  function normalizeCheckpoint(value: number, fallback: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return fallback
    const n = Math.round(value)
    return Math.min(max, Math.max(min, n))
  }

  // Persist activity checkpoint interval changes
  watch(activityCheckpointMin, (newMin) => {
    const normalizedMin = normalizeCheckpoint(newMin, 180, 30, 600)
    if (normalizedMin !== newMin) {
      activityCheckpointMin.value = normalizedMin
      return
    }
    localStorage.setItem(STORAGE_ACTIVITY_CHECKPOINT_MIN_KEY, String(normalizedMin))
    // Ensure max >= min
    if (activityCheckpointMax.value < normalizedMin) {
      activityCheckpointMax.value = normalizedMin
    }
  }, { flush: 'sync' })

  watch(activityCheckpointMax, (newMax) => {
    const normalizedMax = normalizeCheckpoint(newMax, 300, 60, 900)
    if (normalizedMax !== newMax) {
      activityCheckpointMax.value = normalizedMax
      return
    }
    localStorage.setItem(STORAGE_ACTIVITY_CHECKPOINT_MAX_KEY, String(normalizedMax))
    // Ensure min <= max
    if (activityCheckpointMin.value > normalizedMax) {
      activityCheckpointMin.value = normalizedMax
    }
  }, { flush: 'sync' })

  let progressUnlisten: (() => void) | null = null
  let completeUnlisten: (() => void) | null = null
  let errorUnlisten: (() => void) | null = null
  let pollingTimer: ReturnType<typeof setInterval> | null = null
  // Guards against overlapping interval callbacks. `setInterval` keeps firing
  // while an async tick is still awaiting cleanup, and two ticks observing the
  // same completed queue item would each shift the shared queue and schedule
  // `processQueue()`, skipping a never-started quest and starting another
  // concurrently.
  let pollingInFlight = false
  // Cadence the live `pollingTimer` was created with, so `syncPolling()` only
  // rebuilds the interval when the number of running quests changes it.
  let pollingTimerCadence = 0
  // Re-entrancy lock for `processQueue()`. Two overlapping passes would each pick
  // the same not-yet-started queue head and start it twice; the backend rejects
  // the duplicate, but the rejection would drop a quest that never ran.
  let queueFillInFlight = false
  // Epoch for listener registration. `listen()` resolves its `unlisten`
  // asynchronously; a second `setupListeners()` before an earlier one's promises
  // settle would otherwise leak the old handlers (a stale `quest-progress`
  // handler has no quest-id guard and clobbers the next quest's progress bar).
  // Every setup/cleanup bumps this so late resolutions discard and unregister
  // themselves.
  let listenerGeneration = 0
  // Bumped on logout/reset so in-flight queue work can detect the account switch
  // and stop touching state that no longer belongs to the previous session.
  let queueGeneration = 0

  // Simulation internal vars
  let simAnimationFrame: number | null = null
  let simLastTime = 0

  let questsFetchGeneration = 0
  let questsFetchInFlight: Promise<void> | null = null

  async function fetchQuests(silent = false, force = false) {
    // Manual refresh and polling share a request, so an older response cannot
    // replace newer data or finish another request's loading indicator.
    if (questsFetchInFlight) {
      if (!silent) {
        loading.value = !hasLoadedQuests.value && quests.value.length === 0
        refreshing.value = !loading.value
      }
      return questsFetchInFlight
    }
    if (!force && quests.value.length > 0) {
      const now = Date.now()
      // 30 minutes cache
      if (now - lastQuestsFetchTime.value < 30 * 60 * 1000) {
        console.log('Using cached quests list')
        return
      }
    }

    const generation = questsFetchGeneration
    if (!silent) {
      loading.value = !hasLoadedQuests.value && quests.value.length === 0
      refreshing.value = !loading.value
    }
    error.value = null
    const request = (async () => {
      try {
        console.log('Fetching quests from API...')
        const response = await getQuestsFull()
        if (generation !== questsFetchGeneration) return
        // Keep unchanged quest props stable; keyed cards retain their local state
        // and only cards whose server data changed need to update.
        const previous = new Map(quests.value.map(quest => [quest.id, quest]))
        const next = response.quests.map(quest => {
          const existing = previous.get(quest.id)
          return existing && JSON.stringify(existing) === JSON.stringify(quest) ? existing : quest
        })
        if (next.length !== quests.value.length || next.some((quest, index) => quest !== quests.value[index])) {
          quests.value = next
        }
        excludedQuests.value = response.excluded_quests || []
        questEnrollmentBlockedUntil.value = response.quest_enrollment_blocked_until || null
        lastQuestsFetchTime.value = Date.now()
        hasLoadedQuests.value = true
      } catch (e) {
        if (generation === questsFetchGeneration) {
          error.value = e instanceof Error ? e.message : String(e)
        }
      } finally {
        if (generation === questsFetchGeneration) {
          loading.value = false
          refreshing.value = false
        }
      }
    })()
    questsFetchInFlight = request
    try {
      await request
    } finally {
      if (questsFetchInFlight === request) questsFetchInFlight = null
    }
  }

  let orbsFetchGeneration = 0

  async function fetchOrbsBalance(force = false) {
    const generationAtStart = orbsFetchGeneration
    if (!showOrbsBalance.value && !force) return
    if (orbsBalanceLoading.value) return
    if (!force && orbsBalance.value != null) return

    orbsBalanceLoading.value = true
    orbsBalanceError.value = null
    try {
      const balance = await getVirtualCurrencyBalance()
      if (generationAtStart !== orbsFetchGeneration) return
      orbsBalance.value = balance
      orbsBalanceFetchedAt.value = new Date().toISOString()
    } catch (e) {
      if (generationAtStart !== orbsFetchGeneration) return
      orbsBalanceError.value = e as string
      throw e
    } finally {
      if (generationAtStart === orbsFetchGeneration) {
        orbsBalanceLoading.value = false
      }
    }
  }

  /** Quests whose end is being finalized. Claiming per id keeps a duplicate
   *  completion event, a quest-list tick and a task-status tick from each tearing
   *  down the same quest — or another quest's work. */
  const claimedCompletions = new Set<string>()

  function errorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  /** Finalize the history segment one quest owns. A quest that never began a
   *  segment must not finish somebody else's recording — that would silently
   *  freeze the play time of a game the user expects to keep counting. */
  async function finishSlotSimulationUsage(slot: RunningQuest) {
    const appId = slot.simulationAppId
    if (!appId) return
    // Keep the ownership on a failed save so a retried Stop can finish the
    // same segment instead of leaving it recording forever.
    await stopGameSimulationUsage(appId)
    slot.simulationAppId = null
  }

  /**
   * Tear down one quest's own native activity: the process it started, the
   * presence it claimed, and the history segment it opened.
   */
  async function finalizeQuestActivity(slot: RunningQuest) {
    if (slot.gameExe) {
      const executable = slot.gameExe
      await stopSimulatedGame(executable)
      slot.gameExe = null
    }
    if (slot.rpcConnected) await emit('event_disconnect')
    await finishSlotSimulationUsage(slot)
  }

  function releaseQuestSlot(questId: string) {
    closeQuestSlot(questId)
    claimedCompletions.delete(questId)
  }

  /**
   * Read the backend's per-quest outcomes. Quest events carry no quest id and
   * can be missed entirely (a completion that lands while a stop is in flight),
   * so every running quest is reconciled here by id — with several quests this
   * registry is the only way to tell which one finished or failed.
   */
  async function pollQuestTaskStatuses() {
    const tracked = runningQuests.value.filter(slot => slot.hasBackendTask)
    if (tracked.length === 0) return
    let statuses: QuestTaskStatus[]
    try {
      statuses = await getQuestTaskStatuses()
    } catch (statusError) {
      console.error('Failed to read quest task statuses:', statusError)
      return
    }
    for (const status of statuses) {
      if (status.state === 'running') continue
      if (!tracked.some(slot => slot.questId === status.questId)) continue
      await handleQuestEnd(
        status.questId,
        status.state === 'failed' ? status.error ?? undefined : undefined
      )
    }
  }

  /**
   * Route one ended quest. `failedWith` is the backend error text when the quest
   * ended with an error instead of completing.
   */
  async function handleQuestEnd(questId: string, failedWith?: string) {
    if (!questSlot(questId) || claimedCompletions.has(questId)) return
    if (isQueueRunning.value && questQueue.value.some(item => item.id === questId)) {
      await finishQueuedQuest(questId, failedWith)
      return
    }
    await finishStandaloneQuest(questId, failedWith)
  }

  /** A running slot only carries the quest id, so a notification reads the name
   *  from whichever list still holds the quest at the moment it ends. */
  function questDisplayName(questId: string): string {
    const quest =
      questQueue.value.find(item => item.id === questId) ??
      quests.value.find(item => item.id === questId)
    return quest?.config?.messages?.quest_name ?? questId
  }

  async function finishQueuedQuest(questId: string, failedWith?: string) {
    const slot = questSlot(questId)
    if (!slot || claimedCompletions.has(questId)) return
    const questName = questDisplayName(questId)
    claimedCompletions.add(questId)
    if (failedWith !== undefined) {
      await failQuest(questId, failedWith)
      return
    }
    try {
      await finalizeQuestActivity(slot)
    } catch (cleanupError) {
      // Keep the queue in place until both native activity and its history
      // segment have been finalized. The user can retry cleanup with Stop.
      claimedCompletions.delete(questId)
      error.value = errorMessage(cleanupError)
      isQueueRunning.value = false
      if (runningQuests.value.length === 0) {
        stopProgressSimulation()
        cleanupListeners()
        stopPolling()
      }
      return
    }

    releaseQuestSlot(questId)
    announceQuestEnd(questName)
    questQueue.value = questQueue.value.filter(item => item.id !== questId)
    syncPolling()
    if (runningQuests.value.length === 0) cleanupListeners()
    void fetchQuests(true, true)
    setTimeout(() => {
      if (isQueueRunning.value) void processQueue()
    }, 2000)
  }

  async function finishStandaloneQuest(questId: string, failedWith?: string) {
    const slot = questSlot(questId)
    if (!slot || claimedCompletions.has(questId)) return
    const questName = questDisplayName(questId)
    claimedCompletions.add(questId)
    if (failedWith !== undefined) {
      await failQuest(questId, failedWith)
      return
    }
    try {
      await finalizeQuestActivity(slot)
    } catch (cleanupError) {
      claimedCompletions.delete(questId)
      error.value = errorMessage(cleanupError)
      if (runningQuests.value.length === 0) {
        stopProgressSimulation()
        cleanupListeners()
        stopPolling()
      }
      return
    }
    releaseQuestSlot(questId)
    announceQuestEnd(questName)
    syncPolling()
    if (runningQuests.value.length === 0) cleanupListeners()
    void fetchQuests(true, true)
  }

  /**
   * End one failed quest and free its slot. `stopQuest(questId)` cancels nothing
   * when the task already ended; it only releases the backend registry entry.
   */
  async function failQuest(questId: string, message: string) {
    const slot = questSlot(questId)
    if (!slot) return
    const questName = questDisplayName(questId)
    const wasQueued = isQueueRunning.value && questQueue.value.some(item => item.id === questId)
    if (slot.gameExe) {
      const executable = slot.gameExe
      await stopSimulatedGame(executable).catch(() => undefined)
      slot.gameExe = null
    }
    if (slot.rpcConnected) await emit('event_disconnect').catch(() => undefined)
    await finishSlotSimulationUsage(slot).catch(() => undefined)
    await stopQuest(questId).catch(() => undefined)
    releaseQuestSlot(questId)
    if (wasQueued) questQueue.value = questQueue.value.filter(item => item.id !== questId)
    error.value = message
    announceQuestEnd(questName, message)
    syncPolling()
    if (runningQuests.value.length === 0) cleanupListeners()
    if (wasQueued) {
      setTimeout(() => {
        if (isQueueRunning.value) void processQueue()
      }, 2000)
    }
  }

  /** Submit the seconds a video quest watched, so a Stop does not lose them. */
  async function forceSubmitVideoProgress(slot: RunningQuest) {
    if (slot.type !== 'video' || slot.targetDuration <= 0 || gameQuestMode.value === 'cdp') return
    const currentSeconds = (slot.localProgress / 100) * slot.targetDuration
    if (currentSeconds <= 0) return
    console.log(`Force submitting video progress: ${currentSeconds.toFixed(1)}s (ID: ${slot.questId})`)
    try {
      await forceVideoProgress(slot.questId, currentSeconds)
    } catch (e) {
      console.error('Failed to force submit progress on stop:', e)
    }
  }

  /**
   * Stop exactly one running quest and leave the others untouched. Used by the
   * per-quest Stop in the progress panel.
   */
  async function stopRunningQuest(questId: string) {
    const slot = questSlot(questId)
    if (!slot) return
    stopping.value = true
    const failures: string[] = []
    try {
      await forceSubmitVideoProgress(slot)
      if (isQueueRunning.value) {
        questQueue.value = questQueue.value.filter(item => item.id !== questId)
      }
      // Release the backend task first: its loop must stop emitting progress
      // for a quest the UI has already torn down.
      try {
        await stopQuest(questId)
      } catch (e) {
        failures.push(errorMessage(e))
      }
      try {
        await finalizeQuestActivity(slot)
      } catch (e) {
        failures.push(errorMessage(e))
      }
      releaseQuestSlot(questId)
      if (failures.length > 0) error.value = failures.join('; ')
      syncPolling()
      if (runningQuests.value.length === 0) cleanupListeners()
      await fetchQuests(true, true)
    } finally {
      stopping.value = false
    }
  }

  async function checkActiveQuestStatus() {
    for (const slot of [...runningQuests.value]) {
      if (claimedCompletions.has(slot.questId)) continue
      const quest = quests.value.find(q => q.id === slot.questId)
      if (!quest) continue

      if (quest.user_status?.completed_at) {
        console.log(`Quest ${quest.id} completed detected via polling.`)
        await handleQuestEnd(quest.id)
        continue
      }

      // The quest list reports the task this slot runs, so read that task's own
      // value and divide it by the target in the same unit: checkpoint counts
      // for Activity quests, seconds for everything else.
      const polledProgress = firstProgressValue(quest, firstStartableTask(quest)?.key) ||
        quest.user_status?.stream_progress_seconds ||
        0
      if (slot.targetDuration > 0) {
        slot.serverProgress = playActivityProgressPercentage(polledProgress, slot.targetDuration)
      }
    }
  }

  /** Cadence for parallel quests: one shared `/quests` request plus the local
   *  task registry every 20 s. A single quest keeps the user's interval. */
  const PARALLEL_POLLING_MS = 20000

  function pollingIntervalMs(): number {
    const configured = gamePollingInterval.value * 1000
    if (runningQuests.value.length <= 1) return configured
    return Math.min(configured, PARALLEL_POLLING_MS)
  }

  function startPolling() {
    if (pollingTimer) clearInterval(pollingTimer)
    pollingTimerCadence = pollingIntervalMs()
    pollingTimer = setInterval(async () => {
      // Serialize ticks: when a previous tick is still awaiting `fetchQuests`
      // or completion cleanup, skip this one instead of overlapping it. A stop in
      // flight owns every teardown, so reconciling here would finalize the same
      // quest a second time alongside it.
      if (pollingInFlight || stopping.value) return
      pollingInFlight = true
      try {
        await fetchQuests(true, true)
        await checkActiveQuestStatus()
        await pollQuestTaskStatuses()
      } finally {
        pollingInFlight = false
      }
    }, pollingTimerCadence)
  }

  function stopPolling() {
    if (pollingTimer) {
      clearInterval(pollingTimer)
      pollingTimer = null
    }
    pollingTimerCadence = 0
    pollingInFlight = false
  }

  /**
   * One polling loop serves every running quest, including a lone one: a quest
   * with no backend task (a simulate-mode game) has only the quest list to tell
   * it finished, and a quest event can be missed altogether — a completion that
   * arrives while a stop is in flight is dropped by the listeners — so the list
   * plus the backend task registry are what close a slot.
   */
  function syncPolling() {
    if (runningQuests.value.length === 0) {
      stopPolling()
      return
    }
    const wanted = pollingIntervalMs()
    if (!pollingTimer || pollingTimerCadence !== wanted) startPolling()
  }

  // --- Local Progress Simulation ---
  /**
   * One animation loop advances every running slot, so parallel quests each get
   * their own bar instead of overwriting the first quest's. The speed is derived
   * per slot: only a direct-API video quest runs at the user's multiplier, while
   * the backend paces everything else in real time.
   */
  function startProgressSimulation() {
    simLastTime = Date.now()
    if (simAnimationFrame !== null) return

    const loop = () => {
      if (runningQuests.value.length === 0) {
        simAnimationFrame = null
        return
      }

      const now = Date.now()
      const deltaSeconds = (now - simLastTime) / 1000
      simLastTime = now
      const averageCheckpointSeconds =
        (activityCheckpointMin.value + activityCheckpointMax.value) / 2

      for (const slot of runningQuests.value) {
        // Never trail the blue (server) bar and never pass 100%.
        if (slot.targetDuration <= 0) {
          slot.localProgress = Math.max(slot.localProgress, slot.serverProgress)
          continue
        }
        const speed = slot.type === 'video' && gameQuestMode.value !== 'cdp'
          ? speedMultiplier.value
          : 1.0
        // A checkpoint-unit slot counts checkpoints, not seconds: its whole run
        // is one average checkpoint interval per checkpoint, so dividing the raw
        // checkpoint count by elapsed seconds would finish the bar in seconds.
        const slotDurationSeconds = slot.progressUnit === 'checkpoints'
          ? slot.targetDuration * averageCheckpointSeconds
          : slot.targetDuration
        const addedPercent = (deltaSeconds * speed / slotDurationSeconds) * 100
        slot.localProgress = Math.min(
          100,
          Math.max(slot.localProgress + addedPercent, slot.serverProgress)
        )
      }

      simAnimationFrame = requestAnimationFrame(loop)
    }

    simAnimationFrame = requestAnimationFrame(loop)
  }

  function stopProgressSimulation() {
    if (simAnimationFrame !== null) {
      cancelAnimationFrame(simAnimationFrame)
      simAnimationFrame = null
    }
  }

  // Update a quest's enrollment status locally (no full refresh)
  function updateQuestEnrollment(questId: string, enrolledAt: string) {
    const questIndex = quests.value.findIndex(q => q.id === questId)
    if (questIndex !== -1) {
      const quest = quests.value[questIndex]
      // Create new user_status or update existing one
      quests.value[questIndex] = {
        ...quest,
        user_status: {
          ...quest.user_status,
          enrolled_at: enrolledAt,
          completed_at: quest.user_status?.completed_at || null,
          claimed_at: quest.user_status?.claimed_at || null,
          progress: quest.user_status?.progress || {}
        }
      }
    }
  }

  async function startVideo(questId: string, secondsNeeded: number, initialProgress: number) {
    ensureLocalQuestSlot(questId)
    startingQuestId.value = questId
    try {
      const progressPct = (secondsNeeded > 0) ? (initialProgress / secondsNeeded) * 100 : 0

      if (gameQuestMode.value === 'cdp') {
        // CDP mode: use Discord's internal api.post() for video progress
        await startCdpQuest(questId, 'video', '', '', secondsNeeded, initialProgress, cdpPort.value)
      } else {
        console.log(`[startVideo] mode=${gameQuestMode.value} speed=${speedMultiplier.value}x interval=${heartbeatInterval.value}s`)
        await startVideoQuest(questId, secondsNeeded, progressPct, speedMultiplier.value, heartbeatInterval.value)
      }

      openQuestSlot(questId, 'video', secondsNeeded, 'time', progressPct, true)

      // CDP video progress is server-enforced real-time; don't inflate local simulation
      startProgressSimulation()
      setupListeners()
      syncPolling()
    } catch (e) {
      error.value = errorMessage(e)
      throw e
    } finally {
      startingQuestId.value = null
    }
  }

  async function startStream(questId: string, streamKey: string, secondsNeeded: number, initialProgress: number) {
    ensureLocalQuestSlot(questId)
    startingQuestId.value = questId
    try {
      const progressPct = (secondsNeeded > 0) ? (initialProgress / secondsNeeded) * 100 : 0
      await startStreamQuest(questId, streamKey, secondsNeeded, progressPct)
      openQuestSlot(questId, 'stream', secondsNeeded, 'time', progressPct, true)

      startProgressSimulation()
      setupListeners()
      syncPolling()
    } catch (e) {
      error.value = errorMessage(e)
      throw e
    } finally {
      startingQuestId.value = null
    }
  }

  async function startPlay(quest: Quest, secondsNeeded: number, initialProgress: number, selectedExeName?: string) {
    ensureLocalQuestSlot(quest.id)
    startingQuestId.value = quest.id
    error.value = null
    // Remember the request so a soft error can offer "switch to CDP and retry".
    lastPlayRequest.value = { quest, secondsNeeded, initialProgress, selectedExeName }
    const progressPct = (secondsNeeded > 0) ? (initialProgress / secondsNeeded) * 100 : 0
    try {
      // 1. Get Application ID
      const appId = quest.config.application?.id
      if (!appId) throw new Error('Quest missing application ID')
      const appName = quest.config.application?.name || quest.config.messages.game_title || 'Game'

      // Check mode: 'cdp' uses CDP injection, 'heartbeat' uses direct API calls, 'simulate' runs fake game
      if (gameQuestMode.value === 'cdp') {
        // CDP mode - inject into Discord client, no game simulation needed
        console.log(`Starting game quest via CDP for AppID: ${appId}`)
        await startCdpQuest(
          quest.id,
          'play',
          appId,
          appName,
          secondsNeeded,
          initialProgress,
          cdpPort.value
        )

        openQuestSlot(quest.id, 'game', secondsNeeded, 'time', progressPct, true)
        startProgressSimulation()
        setupListeners()
        syncPolling()

      } else if (gameQuestMode.value === 'heartbeat') {
        // [LEGACY] Direct heartbeat mode - no game simulation needed
        console.log(`Starting game quest via direct heartbeat for AppID: ${appId}`)

        await startGameHeartbeatQuest(
          quest.id,
          appId,
          secondsNeeded,
          progressPct
        )

        openQuestSlot(quest.id, 'game', secondsNeeded, 'time', progressPct, true)
        startProgressSimulation()

        // Setup listeners for progress/complete/error events
        setupListeners()
        syncPolling()

      } else {
        // Simulate mode - original behavior
        // 2. Fetch detectable games to find executable name
        // Use cached list if available
        const gamesList = await getDetectableGames()
        const game = gamesList.find(g => g.id === appId)
        if (!game) throw new Error(`Game not found in Discord's detectable list (AppID: ${appId})`)

        // Resolve a platform-compatible executable. On Windows/macOS this stays
        // win32-first; on Linux a native `linux` executable is preferred and a
        // win32-only game raises a recoverable soft error steering the user to
        // CDP mode (a Windows binary can't be process-simulated on Linux).
        // Await rather than reading the ref: capabilities load fire-and-forget
        // at store creation, and a null descriptor here would fall back to
        // 'win32' and happily accept a Windows executable on Linux — exactly
        // the case the soft error below exists to prevent. Resolves instantly
        // once loaded.
        const caps = await initPlatformCapabilities()
        if (!caps) {
          throw new Error('Unable to determine platform capabilities. Please try again.')
        }
        const hostOs = caps.os
        const resolution = resolveSimulationExecutable(game.executables, hostOs, selectedExeName)
        if (resolution.kind === 'win32_only_on_linux') {
          softError.value = {
            code: 'SIMULATION_EXECUTABLE_OS_UNSUPPORTED',
            message: `"${game.name}" only provides a Windows executable, which cannot be process-simulated on Linux. Switch to CDP mode to complete this quest.`,
            gameName: game.name,
            questId: quest.id,
            recommendedMode: 'cdp',
            recoverable: true,
          }
          if (isQueueRunning.value) queuePauseReason.value = 'simulation_incompatible'
          return
        }
        if (resolution.kind === 'not_found') {
          softError.value = {
            code: 'SIMULATION_EXECUTABLE_NOT_FOUND',
            message: `No compatible executable definition for game ${game.name}. Switch to CDP mode to complete this quest.`,
            gameName: game.name,
            questId: quest.id,
            recommendedMode: 'cdp',
            recoverable: true,
          }
          if (isQueueRunning.value) queuePauseReason.value = 'simulation_incompatible'
          return
        }
        const exeName = resolution.executable.name

        console.log(`Starting simulated game for ${game.name} (${exeName})...`)

        // Claim the slot before any process exists, so a second click on this
        // quest cannot start a duplicate while the first is still launching.
        const slot = openQuestSlot(quest.id, 'game', secondsNeeded, 'time', progressPct, false)

        // 3. Resolve the configured simulation directory once so create and
        // run always use the same path for this quest.
        const installPath = await initSimulationPath()

        // 4. Create simulated game executable
        await createSimulatedGame(installPath, exeName, appId)
        slot.gameExe = exeName

        // 5. Run simulated game
        await runSimulatedGame(game.name, installPath, exeName, appId)

        // 6. Connect RPC. There is one RPC client per account and connecting a
        // second presence drops the first, so only the quest that has not yet
        // got a presence on screen claims it. The others still show up in
        // Discord through their running simulated process.
        const presenceTaken = runningQuests.value.some(other => other.rpcConnected)
        if (!presenceTaken) {
          const activity = {
            app_id: appId,
            state: "In Game",
            details: `Playing ${game.name}`,
            largeImageKey: "logo",
            largeImageText: game.name,
            // Discord RPC reads the presence start time in epoch seconds, so a
            // millisecond value would render as a date decades away.
            timestamp: Math.floor(Date.now() / 1000)
          }

          await connectToDiscordRpc(JSON.stringify(activity), 'connect')
          slot.rpcConnected = true
        }

        startProgressSimulation()

        // Simulated game quests have no backend task: progress and completion
        // are read from the quest list.
        setupListeners()
        syncPolling()
      }
      const slot = questSlot(quest.id)
      if (!slot) return
      try {
        const recording = await startGameSimulationUsage(appId, appName)
        if (recording) slot.simulationAppId = appId
      } catch (historyError) {
        // A quest must not keep running without its account-scoped history
        // segment: roll back the started work and fail the start so the UI does
        // not report success for a simulation that cannot be recorded.
        await rollbackQuestSimulation(slot)
        throw new Error(`Failed to start game simulation history: ${errorMessage(historyError)}`)
      }
    } catch (e) {
      error.value = errorMessage(e)
      // Clean up if started (only for simulate mode)
      const slot = questSlot(quest.id)
      if (slot?.gameExe) {
        const executable = slot.gameExe
        try {
          await stopSimulatedGame(executable)
          slot.gameExe = null
        } catch (cleanupError) {
          console.error('Failed to clean up simulated game after start error:', cleanupError)
        }
      }
      if (slot?.rpcConnected) {
        await emit('event_disconnect').catch(() => undefined)
        slot.rpcConnected = false
      }
      if (slot) {
        releaseQuestSlot(quest.id)
        syncPolling()
        if (runningQuests.value.length === 0) cleanupListeners()
      }
      throw e
    } finally {
      startingQuestId.value = null
    }
  }

  async function startActivity(quest: Quest) {
    ensureLocalQuestSlot(quest.id)
    startingQuestId.value = quest.id
    error.value = null
    try {
      // Activity quests require CDP mode
      if (!cdpAvailable.value) {
        throw new Error('Activity quests require CDP mode. Please start Discord with --remote-debugging-port and enable CDP in Settings.')
      }

      // Get checkpoint count from task config (default 3)
      const tasks = quest.config.task_config_v2?.tasks ?? quest.config.task_config?.tasks
      const activityTaskEntry = tasks ? Object.entries(tasks).find(([key, task]) =>
        (task.type || key) === 'ACHIEVEMENT_IN_ACTIVITY'
      ) : null
      const activityTaskKey = activityTaskEntry?.[0]
      const activityTask = activityTaskEntry?.[1] ?? null
      if (!activityTaskEntry || !activityTask) {
        throw new Error('Quest does not contain a supported checkpoint Activity task')
      }
      const checkpointCount = activityTask?.target || 3
      const completedCheckpoints = Math.min(
        checkpointCount,
        Math.max(0, Math.floor(firstProgressValue(quest, activityTaskKey)))
      )
      const remainingCheckpointCount = Math.max(0, checkpointCount - completedCheckpoints)

      if (remainingCheckpointCount === 0) {
        throw new Error('Activity quest already has all checkpoints submitted. Refresh quests or claim the reward in Discord.')
      }

      // Generate random checkpoint times within [min, max] range
      const min = activityCheckpointMin.value
      const max = activityCheckpointMax.value
      const allCheckpointTimes: number[] = []
      for (let i = 0; i < checkpointCount; i++) {
        allCheckpointTimes.push(Math.floor(Math.random() * (max - min + 1)) + min)
      }
      const checkpointTimes = allCheckpointTimes.slice(completedCheckpoints)
      const totalSeconds = allCheckpointTimes.reduce((sum, t) => sum + t, 0)
      const remainingSeconds = checkpointTimes.reduce((sum, t) => sum + t, 0)
      // The server's own checkpoint count is the only honest seed: a resumed
      // quest must open its bar there, not at zero.
      const progressPct = playActivityProgressPercentage(completedCheckpoints, checkpointCount)

      console.log(`Starting activity quest via CDP: completed=${completedCheckpoints}/${checkpointCount}, remaining=${remainingCheckpointCount}, times=[${checkpointTimes.join(', ')}], remaining=${remainingSeconds}s, estimatedTotal=${totalSeconds}s`)

      const appId = quest.config.application?.id || ''
      const appName = quest.config.application?.name || quest.config.messages?.quest_name || 'Activity'

      await startCdpQuest(
        quest.id,
        'activity',
        appId,
        appName,
        totalSeconds,
        completedCheckpoints,
        cdpPort.value,
        checkpointTimes
      )

      openQuestSlot(quest.id, 'activity', checkpointCount, 'checkpoints', progressPct, true)

      startProgressSimulation()
      setupListeners()
      syncPolling()

    } catch (e) {
      error.value = errorMessage(e)
      throw e
    } finally {
      startingQuestId.value = null
    }
  }

  async function startPlayActivity(quest: Quest, secondsNeeded: number, initialProgress: number) {
    ensureLocalQuestSlot(quest.id)
    startingQuestId.value = quest.id
    error.value = null
    let preserveActiveState = false
    try {
      const appId = quest.config.application?.id
      if (!appId) throw new Error('Cloud game Activity quest is missing an application ID')

      if (gameQuestMode.value === 'cdp' && !cdpAvailable.value) {
        throw new Error('CDP mode is selected but Discord CDP is not available')
      }

      const progressPct = playActivityProgressPercentage(initialProgress, secondsNeeded)

      console.log(
        `Starting PLAY_ACTIVITY quest: mode=${gameQuestMode.value}, progress=${initialProgress}/${secondsNeeded}s, heartbeat=${heartbeatInterval.value}s, polling=${gamePollingInterval.value}s`
      )

      // A cloud-game Activity quest is paced in seconds, unlike a checkpoint
      // Activity quest, so its slot keeps the time unit its target is written in.
      const slot = openQuestSlot(quest.id, 'activity', secondsNeeded, 'time', progressPct, true)
      startProgressSimulation()
      setupListeners()
      syncPolling()

      await startPlayActivityQuest(
        quest.id,
        appId,
        secondsNeeded,
        initialProgress,
        gameQuestMode.value,
        cdpPort.value,
        heartbeatInterval.value,
        gamePollingInterval.value
      )
      const appName = quest.config.application?.name || quest.config.messages.game_title || 'Activity'
      try {
        const recording = await startGameSimulationUsage(appId, appName)
        if (recording) slot.simulationAppId = appId
      } catch (historyError) {
        // Roll back the already-started activity simulation; running it without
        // an account-scoped history segment would silently break accounting.
        const detail = errorMessage(historyError)
        try {
          await rollbackQuestSimulation(slot)
        } catch (cleanupError) {
          preserveActiveState = true
          const cleanupDetail = errorMessage(cleanupError)
          throw new Error(`Failed to start activity simulation history: ${detail}. Cleanup also failed: ${cleanupDetail}`)
        }
        throw new Error(`Failed to start activity simulation history: ${detail}`)
      }
    } catch (e) {
      if (!preserveActiveState && questSlot(quest.id)) {
        releaseQuestSlot(quest.id)
        syncPolling()
        if (runningQuests.value.length === 0) {
          stopProgressSimulation()
          cleanupListeners()
        }
      }
      error.value = errorMessage(e)
      throw e
    } finally {
      startingQuestId.value = null
    }
  }

  /**
   * Roll back work started by a `startPlay`/`startPlayActivity` step that failed
   * later, without touching any other running quest. Used by the history-tracking
   * failure path, where a process/CDP session and Discord presence may already
   * be live for a start that is about to report an error.
   */
  async function rollbackQuestSimulation(slot: RunningQuest) {
    const failures: string[] = []
    try {
      await stopQuest(slot.questId)
    } catch (cleanupError) {
      failures.push(errorMessage(cleanupError))
    }
    try {
      await finalizeQuestActivity(slot)
    } catch (cleanupError) {
      failures.push(errorMessage(cleanupError))
    }
    if (failures.length > 0) {
      // Keep the slot so a retried Stop can finish tearing the activity down;
      // dropping it here would lose track of a live process or presence.
      throw new Error(failures.join('; '))
    }
    releaseQuestSlot(slot.questId)
    syncPolling()
    if (runningQuests.value.length === 0) {
      stopProgressSimulation()
      cleanupListeners()
    }
  }

  /** Recover the executable name a simulate-mode game quest should be running
   *  when its start failed before recording one, so Stop can still kill the
   *  process. CDP and heartbeat modes never create a real process. */
  async function recoverExecutableName(questId: string): Promise<string | null> {
    console.warn(`No executable recorded for ${questId}, recovering it from the quest list...`)
    const quest = quests.value.find(q => q.id === questId)
    const appId = quest?.config.application?.id
    if (!appId) return null
    try {
      const games = await fetchDetectableGames()
      const game = games.find(g => g.id === appId)
      return game?.executables.find(e => e.os === 'win32')?.name ?? null
    } catch (err) {
      console.error('Failed to recover executable name:', err)
      return null
    }
  }

  /** Stop everything: every running quest, the queue, and the manual CDP game
   *  simulation. Use `stopRunningQuest` to end a single quest in parallel. */
  async function stop() {
    stopping.value = true
    console.log('questsStore.stop() called')

    stopProgressSimulation()

    try {
      // Force Save Logic for Video Quests (skip in CDP mode — progress is server-managed)
      for (const slot of [...runningQuests.value]) {
        await forceSubmitVideoProgress(slot)
      }

      // If manually stopping, ensure queue is also stopped/cleared
      if (isQueueRunning.value || questQueue.value.length > 0) {
        isQueueRunning.value = false
        questQueue.value = [] // Clear queue on manual stop
      }

      for (const slot of [...runningQuests.value]) {
        if (!slot.gameExe && slot.type === 'game' && gameQuestMode.value === 'simulate') {
          slot.gameExe = await recoverExecutableName(slot.questId)
        }
      }

      // Backend cleanup can fail (e.g. the simulated process or the history
      // segment refuses to stop). Record those failures but always run the rest
      // of the stop sequence — the user pressed Stop, so the heartbeat/CDP tasks,
      // listeners, polling and active state must be torn down regardless.
      const stopFailures: string[] = []

      // Cancel every backend task and the manual CDP session in one call, before
      // the processes go away, so no quest loop re-publishes an activity that is
      // already being torn down.
      try {
        await stopQuest()
      } catch {
        // Ignore error if no quest running
      }

      for (const slot of [...runningQuests.value]) {
        try {
          await finalizeQuestActivity(slot)
        } catch (e) {
          stopFailures.push(errorMessage(e))
        }
        releaseQuestSlot(slot.questId)
      }

      if (stopFailures.length > 0) {
        error.value = stopFailures.join('; ')
      }

      cleanupListeners()

      // Refresh quests to get latest status
      await fetchQuests(true, true)

    } finally {
      stopping.value = false
    }
  }

  /**
   * The only quest an event can be attributed to, or null when several run.
   * Quest events carry no quest id, so with more than one running quest every
   * event is ambiguous and the polling loop attributes progress, completion and
   * errors per quest id instead.
   */
  function soleRunningQuest(): RunningQuest | null {
    return runningQuests.value.length === 1 ? runningQuests.value[0] ?? null : null
  }

  function setupListeners() {
    cleanupListeners()
    // Capture the generation created by the cleanup above. Any `listen()`
    // promise that resolves after a newer setup/cleanup has bumped the epoch is
    // discarded (unsubscribed immediately) instead of overwriting the stored
    // `unlisten` and orphaning the current handler.
    const epoch = listenerGeneration

    console.log('Setting up quest progress listeners...')

    onQuestProgress((progress) => {
      console.log('Received quest-progress event:', progress)
      // The event payload is a bare number with no quest identifier, so the
      // only way to reject a leaked handler from a previous setup is the epoch,
      // and the only safe moment to apply it is while one quest runs.
      if (epoch !== listenerGeneration) return
      const slot = soleRunningQuest()
      if (!slot) return
      slot.serverProgress = clampProgressPercent(progress)
      // For Play quests, update local state or log since no direct feedback loop? 
      // Discord RPC is one-way, but we might listen to Discord Gateway for activity updates if needed.
      // But user_status updates come from backend polling or events.
    }).then((unlisten) => {
      if (epoch !== listenerGeneration) {
        unlisten()
        return
      }
      progressUnlisten = unlisten
      console.log('Quest progress listener ready')
    })

    onQuestComplete(async () => {
      console.log('Received quest-complete event')
      if (stopping.value) return
      const slot = soleRunningQuest()
      if (!slot) return
      await handleQuestEnd(slot.questId)
    }).then((unlisten) => {
      if (epoch !== listenerGeneration) {
        unlisten()
        return
      }
      completeUnlisten = unlisten
      console.log('Quest complete listener ready')
    })

    onQuestError(async (err) => {
      console.log('Received quest-error event:', err)
      // Without a quest id in the payload an error can only be attributed while
      // a single quest runs; `pollQuestTaskStatuses` reports the failing id when
      // several run.
      const slot = soleRunningQuest()
      if (!slot) return
      await handleQuestEnd(slot.questId, err)
    }).then((unlisten) => {
      if (epoch !== listenerGeneration) {
        unlisten()
        return
      }
      errorUnlisten = unlisten
      console.log('Quest error listener ready')
    })
  }

  function cleanupListeners() {
    stopPolling()
    // Invalidate in-flight `setupListeners()` resolutions so a listener whose
    // `listen()` promise resolves after this point unsubscribes itself.
    listenerGeneration++
    if (progressUnlisten) {
      progressUnlisten()
      progressUnlisten = null
    }
    if (completeUnlisten) {
      completeUnlisten()
      completeUnlisten = null
    }
    if (errorUnlisten) {
      errorUnlisten()
      errorUnlisten = null
    }
  }

  function setSpeedMultiplier(speed: number) {
    speedMultiplier.value = speed
  }

  async function acceptQuestWrapper(questId: string) {
    try {
      await acceptQuest(questId)
      // Optimistic update
      updateQuestEnrollment(questId, new Date().toISOString())
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  async function acceptAllQuests(questIds: string[]) {
    error.value = null
    let successCount = 0
    let failCount = 0
    try {
      for (const id of questIds) {
        try {
          await acceptQuest(id)
          updateQuestEnrollment(id, new Date().toISOString())
          successCount++
          // Small delay to be nice to API
          await new Promise(r => setTimeout(r, 500))
        } catch (e) {
          console.error(`Failed to accept quest ${id}:`, e)
          failCount++
        }
      }
    } finally {
      if (failCount > 0) {
        error.value = `Accepted ${successCount} quests, failed ${failCount}`
      }
    }
  }


  // Refined Complete All Video:
  // We can't blocking-wait in the UI thread for 15 mins x N quests.
  // But we can start a "Queue Mode".
  const questQueue = ref<QueueItem[]>([])
  const isQueueRunning = ref(false)

  /** Task types that only ever progress on console hardware. */
  const CONSOLE_ONLY_TASK_TYPES = ['PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION']

  function dropQueueItem(questId: string): void {
    questQueue.value = questQueue.value.filter(item => item.id !== questId)
  }

  /**
   * True when nothing in this quest can be played from this client: no video,
   * desktop-play or Activity task, but a console-only play task. Discord credits
   * those tasks only for sessions on the console, so no heartbeat, simulated
   * process or CDP injection can ever finish them.
   */
  function requiresUnsupportedPlatform(quest: Quest): boolean {
    if (firstStartableTask(quest)) return false
    return getQuestTasks(quest).some(task => CONSOLE_ONLY_TASK_TYPES.includes(task.type))
  }

  /**
   * Drop a queue item that can never complete and record the reason the same way
   * a simulation-incompatible start does, so the dialog and the paused queue stay
   * the visible explanation.
   */
  function skipUnstartableQuest(quest: Quest): void {
    const gameName = quest.config.application?.name || quest.config.messages.quest_name || quest.id
    softError.value = {
      code: 'SIMULATION_PLATFORM_UNSUPPORTED',
      message: `"${gameName}" only counts play on a console platform, which this client cannot satisfy. Skipped.`,
      gameName,
      questId: quest.id,
      recoverable: true,
    }
    if (isQueueRunning.value) queuePauseReason.value = 'simulation_incompatible'
    dropQueueItem(quest.id)
  }

  /**
   * Fill every free parallel slot from the queue. A queue item stays in the list
   * until its quest is finalized, so the candidate for the next slot is the first
   * item that does not already occupy one. `queueFillInFlight` keeps two
   * completion callbacks from starting the same candidate twice.
   */
  async function processQueue() {
    if (stopping.value) return
    if (questQueue.value.length === 0) {
      isQueueRunning.value = false
      return
    }
    if (queueFillInFlight) return

    queueFillInFlight = true
    // Snapshot the logout generation. If the account is switched mid-flight, any
    // state the in-flight start commits belongs to a dead session and is undone.
    const generation = queueGeneration

    try {
      isQueueRunning.value = true
      while (!stopping.value
        && questQueue.value.length > 0
        && runningQuests.value.length < MAX_PARALLEL_QUESTS) {
        const queueItem = questQueue.value.find(item => !questSlot(item.id))
        if (!queueItem) return
        console.log(`Queue processing: ${queueItem.id}`)

        // The task this quest can run locally decides both its target and the
        // progress already banked on it, so another task's target — a console
        // requirement or a checkpoint count — is never read as a duration.
        const startableTask = firstStartableTask(queueItem)
        const seconds = startableTask?.target ?? 0
        const progress = firstProgressValue(queueItem, startableTask?.key)

        // Skip without occupying a slot: already done, a real Stream quest,
        // which needs actual broadcasting, or a checkpoint Activity, whose
        // progress only comes from checkpoints in the activity window the user
        // launched. A cloud-game Activity (`PLAY_ACTIVITY`) is NOT in that
        // group: the backend drives it from heartbeats alone, so dropping it
        // here would silently discard a quest Home legitimately batch-queued.
        const questKind = getQuestKind(queueItem)
        if (queueItem.user_status?.completed_at || isManualStreamQuest(queueItem)
          || isManualActivityQuest(queueItem)) {
          dropQueueItem(queueItem.id)
          continue
        }

        // A console-only task needs hardware this client cannot play on, so the
        // quest can never complete: report why and consume the item instead of
        // holding a slot until it times out.
        if (requiresUnsupportedPlatform(queueItem)) {
          skipUnstartableQuest(queueItem)
          continue
        }

        console.log(`Queue item type: ${questKind}`)
        try {
          if (questKind === 'video') {
            await startVideo(queueItem.id, seconds, progress)
          } else if (isPlayActivityQuest(queueItem)) {
            // Cloud-game Activities complete on backend heartbeats, not on the
            // game-simulation executable, so they must not take the startPlay path.
            await startPlayActivity(queueItem, seconds, progress)
          } else {
            // Game (play) quests — use startPlay with optional pre-selected exe
            await startPlay(queueItem, seconds, progress, queueItem.selectedExeName)
          }
        } catch (e) {
          console.error('Queue item failed to start:', e)
          if (generation !== queueGeneration) return
          // The errored quest must leave the queue or the batch stalls silently
          // with the item still queued and Home's bulk buttons stuck disabled.
          dropQueueItem(queueItem.id)
          continue
        }

        // Logout/account switch landed while this quest was starting: the active
        // state, listeners and polling just committed belong to the previous
        // session. Undo them and stop; resetForLogout already cleared the queue.
        if (generation !== queueGeneration) {
          const slot = questSlot(queueItem.id)
          if (slot) {
            await stopQuest(queueItem.id).catch(() => undefined)
            await finalizeQuestActivity(slot).catch(() => undefined)
            releaseQuestSlot(queueItem.id)
          }
          stopProgressSimulation()
          cleanupListeners()
          return
        }

        // Every iteration has to consume its item. A start that reports a soft
        // error returns without throwing *and* without a slot; leaving that item
        // queued would let the next iteration pick the same candidate forever.
        if (!questSlot(queueItem.id)) {
          dropQueueItem(queueItem.id)
          if (softError.value?.questId === queueItem.id) {
            queuePauseReason.value = 'simulation_incompatible'
          }
          continue
        }

        // A stop started while this quest was launching owns the teardown; the
        // remaining items are cleared by it, so the queue must not refill here.
        if (stopping.value) return
      }
    } finally {
      queueFillInFlight = false
    }

    // Now each running quest waits for its own completion: quest events while one
    // quest runs, otherwise the quest list plus the backend task registry.
  }

  // We need to modify `onQuestComplete` to trigger next in queue.
  // See `setupListeners`.

  // --- Detectable Games Caching ---
  const detectableGames = ref<DetectableGame[]>([])
  const fetchingGames = ref(false)

  async function getDetectableGames(force = false): Promise<DetectableGame[]> {
    if (!force && detectableGames.value.length > 0) {
      console.log('Returning cached detectable games')
      return detectableGames.value
    }

    if (fetchingGames.value) {
      // If already fetching, wait for it (simple poll)
      while (fetchingGames.value) {
        await new Promise(r => setTimeout(r, 100))
      }
      return detectableGames.value
    }

    fetchingGames.value = true
    try {
      console.log('Fetching detectable games from API...')
      detectableGames.value = await fetchDetectableGames()
      console.log(`Fetched ${detectableGames.value.length} detectable games successfully.`)
      return detectableGames.value
    } catch (e) {
      console.error('Failed to fetch detectable games:', e)
      throw e
    } finally {
      fetchingGames.value = false
    }
  }

  function resetForLogout() {
    orbsFetchGeneration++
    questsFetchGeneration++
    // Invalidate any in-flight `processQueue()` so it stops committing active
    // state for the previous account's quest when its start resolves.
    queueGeneration++
    questsFetchInFlight = null
    quests.value = []
    excludedQuests.value = []
    questEnrollmentBlockedUntil.value = null
    lastQuestsFetchTime.value = 0
    loading.value = false
    refreshing.value = false
    hasLoadedQuests.value = false
    startingQuestId.value = null
    error.value = null
    orbsBalance.value = null
    orbsBalanceFetchedAt.value = null
    orbsBalanceLoading.value = false
    orbsBalanceError.value = null
    runningQuests.value = []
    claimedCompletions.clear()
    questQueue.value = []
    isQueueRunning.value = false
    stopping.value = false
    detectableGames.value = []
    fetchingGames.value = false
    cdpAvailable.value = false
    // Recoverable-error state is per-session: a dialog left open (or a queued
    // retry) must not reappear against the next account's quests.
    softError.value = null
    queuePauseReason.value = null
    lastPlayRequest.value = null
    stopProgressSimulation()
    cleanupListeners()
    stopPolling()
  }

  // Check CDP availability and auto-fallback if mode is 'cdp' but CDP isn't reachable
  async function initCdpMode() {
    try {
      const status = await checkCdpStatus(cdpPort.value)
      cdpAvailable.value = status.connected
      if (gameQuestMode.value === 'cdp' && !status.connected) {
        console.warn('CDP mode selected but CDP not available — falling back to simulate mode')
        gameQuestMode.value = 'simulate'
      }
    } catch {
      cdpAvailable.value = false
      if (gameQuestMode.value === 'cdp') {
        console.warn('CDP check failed — falling back to simulate mode')
        gameQuestMode.value = 'simulate'
      }
    }
  }

  /**
   * Recover from a recoverable soft error (e.g. a win32-only game on Linux) by
   * switching to CDP mode and retrying the same quest / resuming the queue.
   * Falls back to a clear error if CDP can't be reached.
   */
  async function switchToCdpAndRetry(): Promise<void> {
    const req = lastPlayRequest.value
    gameQuestMode.value = 'cdp'

    // Confirm the CDP port is actually reachable; initCdpMode flips back to
    // simulate when it isn't, so re-check availability afterward. The soft
    // error and pause reason are only cleared once CDP is confirmed: dropping
    // them on a failed check would leave a paused queue reporting "running"
    // with no active quest and no way to retry from the dialog.
    await initCdpMode()
    if (!cdpAvailable.value) {
      error.value =
        'CDP mode is not available. Start Discord with CDP enabled (Settings → Discord integration), then try again.'
      return
    }

    error.value = null
    softError.value = null
    queuePauseReason.value = null

    if (isQueueRunning.value) {
      await processQueue()
    } else if (req) {
      try {
        await startPlay(req.quest, req.secondsNeeded, req.initialProgress, req.selectedExeName)
      } catch (error) {
        // startPlay already records the user-facing error; do not let the
        // dialog action become an unhandled rejection.
        console.warn('CDP retry failed:', error)
      }
    }
  }

  /**
   * Dismiss a soft error without switching modes. If a queue was paused because
   * the current item is simulation-incompatible, the user's cancel means
   * "skip it" — drop the head item and continue the queue.
   */
  function dismissSoftError(): void {
    const wasSimIncompatible = queuePauseReason.value === 'simulation_incompatible'
    const incompatibleQuestId = softError.value?.questId ?? null
    softError.value = null
    queuePauseReason.value = null

    if (wasSimIncompatible && isQueueRunning.value && questQueue.value.length > 0) {
      // Drop the quest that could not be simulated, not whatever happens to sit at
      // the front — with parallel slots the front item may already be running.
      if (incompatibleQuestId) {
        questQueue.value = questQueue.value.filter(item => item.id !== incompatibleQuestId)
      } else {
        questQueue.value.shift()
      }
      void processQueue()
    }
  }

  // Load platform capabilities on store creation so the Linux CDP-first default
  // and platform-aware executable resolution are ready before any quest runs.
  // Fire-and-forget; failure is handled inside the action.
  void initPlatformCapabilities()

  return {
    quests,
    excludedQuests,
    questEnrollmentBlockedUntil,
    loading,
    refreshing,
    hasLoadedQuests,
    startingQuestId,
    error,
    orbsBalance,
    orbsBalanceFetchedAt,
    orbsBalanceLoading,
    orbsBalanceError,
    showOrbsBalance,
    simulationPath,
    initSimulationPath,
    setSimulationPath,
    resetSimulationPath,
    activityCheckpointMin,
    activityCheckpointMax,
    activeQuestId,
    activeQuestType,
    activeQuestProgress,
    activeQuestTargetDuration,
    localProgress, // Export local progress
    runningQuests,
    maxParallelQuests: MAX_PARALLEL_QUESTS,
    speedMultiplier,
    heartbeatInterval,
    gamePollingInterval,
    gameQuestMode,
    cdpPort,
    desktopClient,
    cdpAvailable,
    stopping,
    activeGameExe,
    activeSimulationAppId,
    questQueue, // Export queue
    isQueueRunning,
    fetchQuests,
    fetchOrbsBalance,
    updateQuestEnrollment,
    startVideo,
    startStream,
    startPlay,
    startActivity,
    startPlayActivity,
    stop,
    stopRunningQuest,
    setSpeedMultiplier,
    acceptQuest: acceptQuestWrapper,
    acceptAllQuests,
    // Add to queue logic needs integration with listeners
    addToQueue: (q: Quest, selectedExeName?: string) => {
      if (!questQueue.value.find(x => x.id === q.id)) {
        const item: QueueItem = { ...q, selectedExeName }
        questQueue.value.push(item)
      }
    },
    startQueue: processQueue,
    clearQueue: () => {
      questQueue.value = []
      isQueueRunning.value = false
      stop()
    },
    // Game Process Caching
    detectableGames,
    getDetectableGames,
    resetForLogout,
    initCdpMode,
    // Platform capabilities + Linux soft-error recovery
    platformCapabilities,
    platformCapabilitiesReady,
    initPlatformCapabilities,
    softError,
    queuePauseReason,
    lastPlayRequest,
    switchToCdpAndRetry,
    dismissSoftError
  }
})
