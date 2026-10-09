<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import GameSelector from '@/components/GameSelector.vue'
import GameIdlePanel from '@/components/GameIdlePanel.vue'
import type {
  DetectableGame,
  ManualCdpGameSimulation,
  SimulationHistorySegment,
  SimulationHistoryStatus,
} from '@/api/tauri'
import {
  createSimulatedGame,
  runSimulatedGame,
  stopSimulatedGame,
  getRunningSimulatedGames,
  connectToDiscordRpc,
  disconnectFromDiscordRpc,
  startManualCdpGameSimulation,
  stopManualCdpGameSimulation,
  getManualCdpGameSimulation,
  startGameSimulationUsage,
  stopGameSimulationUsage,
  getGameSimulationUsageStatus,
} from '@/api/tauri'
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Play, Square, Hammer, List, Terminal, FolderOpen, ChevronDown, Check, MonitorPlay, WifiOff, RotateCcw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useQuestsStore } from '@/stores/quests'
import { getSimulationExecutables } from '@/utils/executables'
import { formatSimulationDuration, useGameIdleStore } from '@/stores/gameIdle'

const { t } = useI18n()
const store = useQuestsStore()
const idleStore = useGameIdleStore()

// Avoid offering a platform-specific executable until the backend descriptor is
// known; otherwise a failed capability load could silently select win32 on Linux.
const executablePriority = computed(() => store.platformCapabilities?.executableOsPriority ?? [])
const hostOs = computed(() => store.platformCapabilities?.os ?? '')

// Mode: 'select' = pick from detectable games list, 'custom' = enter any process name
const mode = ref<'select' | 'custom' | 'idle'>('select')

const selectedGame = ref<DetectableGame | null>(null)
const selectedExecutable = ref('')
const customExeName = ref('')
const running = ref(false)
const stopping = ref(false)
const stoppingExec = ref<string | null>(null)
const activeCdpSession = ref<ManualCdpGameSimulation | null>(null)
const cdpAppId = ref<string | null>(null)
const cdpHistoryPending = ref(false)
const cdpStarting = ref(false)
const creating = ref(false)
const error = ref<string | null>(null)
const success = ref<string | null>(null)

/** A simulated game this page owns, with its own stop path. */
interface RunningSimulatedGame {
  appId: string
  appName: string
  /** Empty for a play-time segment recovered from disk. */
  execName: string
  /** The native process is stopped; closing its history segment still failed. */
  historyPending: boolean
}

const runningGames = ref<RunningSimulatedGame[]>([])
// Discord RPC carries a single presence, so only the first game owns it; the
// others are detected from their process names.
const rpcAppId = ref<string | null>(null)

// Create dialog state
const showCreateDialog = ref(false)

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

onMounted(async () => {
  // An unreadable idle session must not blank the rest of the panel: the
  // failure is reported and the restore below still runs.
  await idleStore.initialize().catch(e => {
    error.value = errorMessage(e)
  })
  await idleStore.refreshHistory().catch(() => undefined)
  if (idleStore.isActive || idleStore.loading) mode.value = 'idle'
  const capabilities = store.initPlatformCapabilities()
  const cdpStatus = store.initCdpMode().catch(err => {
    console.warn('Failed to refresh CDP status for game simulator:', err)
  })
  const manualSession = getManualCdpGameSimulation().catch(err => {
    console.warn('Failed to restore manual CDP game simulation:', err)
    return null
  })
  const runningProcesses = getRunningSimulatedGames().catch(err => {
    console.warn('Failed to restore process game simulation:', err)
    return []
  })
  const historyStatus = getGameSimulationUsageStatus().catch(err => {
    console.warn('Failed to restore simulation history state:', err)
    return null
  })
  const [session, processes, persistedHistoryStatus] = await Promise.all([manualSession, runningProcesses, historyStatus, capabilities, cdpStatus])

  if (session) {
    activeCdpSession.value = session
    cdpAppId.value = session.appId
    success.value = t('game_sim.cdp_session_restored', { name: session.appName })
    return
  }
  if (store.runningQuests.length > 0 || idleStore.isActive || idleStore.loading) return
  runningGames.value = restoreRunningGames(processes, persistedHistoryStatus)
  if (runningGames.value.length === 0) return
  // A restored process may have been started from list mode. Disconnecting an
  // absent RPC client is harmless, so retain a safe cleanup path for its Stop.
  rpcAppId.value = runningGames.value.find(game => game.appId)?.appId ?? null
  success.value = runningGames.value.some(game => game.historyPending)
    ? t('game_sim.stopped')
    : t('game_sim.run_success')
})

/**
 * Rebuild the running list after navigation. A single process with a single
 * recording can be paired unambiguously; anything wider stays two independent
 * rows because the backend tracks processes by executable name and play time by
 * application ID, and nothing links the two across a page reload.
 */
function restoreRunningGames(
  processes: string[],
  status: SimulationHistoryStatus | null
): RunningSimulatedGame[] {
  const segments: SimulationHistorySegment[] = status?.segments ?? []
  const games: RunningSimulatedGame[] = processes.map(execName => ({
    appId: '',
    appName: execName,
    execName,
    historyPending: false,
  }))
  const paired = games.length === 1 && segments.length === 1
  const game = paired ? games[0] : undefined
  const segment = paired ? segments[0] : undefined
  if (game && segment) {
    game.appId = segment.appId
    game.appName = segment.appName
    game.historyPending = segment.pendingFinish
    return games
  }
  for (const record of segments) {
    if (games.some(existing => existing.appId === record.appId)) continue
    games.push({
      appId: record.appId,
      appName: record.appName,
      execName: '',
      historyPending: record.pendingFinish,
    })
  }
  return games
}

watch(
  () => idleStore.status?.phase,
  async phase => {
    if (phase !== 'stopped') return
    // A recovered segment may have belonged to the Game Idle session that just
    // stopped. Drop the rows whose recording is no longer open so the simulator
    // is not left showing a Stop surface that can never succeed.
    const status = await getGameSimulationUsageStatus().catch(() => null)
    if (!status) return
    const live = new Set(status.segments.map(segment => segment.appId))
    runningGames.value = runningGames.value.filter(
      game => game.execName !== '' || live.has(game.appId)
    )
  }
)

const cdpActive = computed(() => activeCdpSession.value !== null || cdpHistoryPending.value)
const processActive = computed(() => runningGames.value.length > 0)
const hasActiveSimulation = computed(() => cdpActive.value || processActive.value)
// Manual process simulations may overlap each other, but never a CDP session, a
// Game Idle rotation, or a quest.
const processBlocked = computed(
  () => cdpActive.value || idleStore.isActive || idleStore.loading || store.runningQuests.length > 0
)
// The configuration panel keeps one game selected at a time; it only has to
// freeze while another owner (CDP or Game Idle) holds the simulation.
const selectionLocked = computed(() => cdpActive.value || idleStore.isActive || idleStore.loading)
const simulatorBusy = computed(
  () => running.value || creating.value || cdpStarting.value || stopping.value
)

// Executables the simulator can actually launch here: Linux only runs a native
// `linux` binary (a win32 exe is refused by the quest-start path too), while
// Windows/macOS stay win32-only.
const compatibleExecutables = computed(() => {
  if (!selectedGame.value || !store.platformCapabilities) return []
  return getSimulationExecutables(selectedGame.value.executables, hostOs.value, executablePriority.value)
})

const hasCompatibleExecutables = computed(() => compatibleExecutables.value.length > 0)

// On Linux a win32-only game isn't "unknown to Discord" — it just can't be
// process-simulated here, so explain that instead of the generic hint.
const isWin32OnlyOnLinux = computed(
  () =>
    hostOs.value === 'linux' &&
    !hasCompatibleExecutables.value &&
    !!selectedGame.value?.executables.some((exe) => exe.os === 'win32')
)

// In select mode, a custom exe name is provided when the game has no known win32 executables
const selectModeCustomExe = ref('')

// The executable name that will actually be used for run/create
const effectiveExecutable = computed(() => {
  if (mode.value === 'custom') return customExeName.value
  if (hasCompatibleExecutables.value) return selectedExecutable.value
  return selectModeCustomExe.value
})

// Custom exe dropdown state
const exeDropdownOpen = ref(false)
const exeDropdownRef = ref<HTMLElement | null>(null)

function toggleExeDropdown() {
  exeDropdownOpen.value = !exeDropdownOpen.value
}

function selectExe(name: string) {
  selectedExecutable.value = name
  exeDropdownOpen.value = false
}

function handleClickOutsideExeDropdown(e: MouseEvent) {
  if (exeDropdownRef.value && !exeDropdownRef.value.contains(e.target as Node)) {
    exeDropdownOpen.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', handleClickOutsideExeDropdown))
onUnmounted(() => document.removeEventListener('mousedown', handleClickOutsideExeDropdown))

// Whether the footer action buttons should be shown
const canProceed = computed(() => {
  if (hasActiveSimulation.value) return true
  if (mode.value === 'custom') return !!customExeName.value
  // CDP simulation only needs the selected Discord application ID, so keep
  // the footer available even when no local executable can be simulated.
  if (!selectedGame.value) return false
  return true
})

function switchMode(m: 'select' | 'custom' | 'idle') {
  // While CDP or Game Idle holds the simulation the panel is the only reachable
  // surface, so switching away would orphan it. Parallel process games keep
  // their own rows in the running list and are safe to navigate away from.
  if (selectionLocked.value || simulatorBusy.value) return
  mode.value = m
  error.value = null
  success.value = null
}

// The Start button must not offer a second instance of an executable Discord
// already reports as running.
const selectedAlreadyRunning = computed(() => {
  const exeName = effectiveExecutable.value
  if (!exeName) return false
  return runningGames.value.some(game => game.execName === exeName)
})

const selectedHistoryDuration = computed(() => {
  const seconds = selectedGame.value ? idleStore.history[selectedGame.value.id]?.totalSeconds ?? 0 : 0
  return formatSimulationDuration(seconds)
})

function selectGame(game: DetectableGame) {
  if (selectionLocked.value || simulatorBusy.value) return
  selectedGame.value = game
  const compatible = store.platformCapabilities
    ? getSimulationExecutables(game.executables, hostOs.value, executablePriority.value)
    : []
  selectedExecutable.value = compatible[0]?.name ?? ''
  selectModeCustomExe.value = ''
  error.value = null
  success.value = null
}

async function openCreateDialog() {
  error.value = null
  try {
    await store.initSimulationPath()
    showCreateDialog.value = true
  } catch {
    error.value = t('settings.simulation_directory_resolve_error')
  }
}

async function handleCreateGame() {
  const exeName = effectiveExecutable.value
  if (!exeName) return

  creating.value = true
  error.value = null
  success.value = null

  try {
    const simulationPath = await store.initSimulationPath()
    const appId = mode.value === 'custom' ? '' : (selectedGame.value?.id ?? '')
    await createSimulatedGame(simulationPath, exeName, appId)
    showCreateDialog.value = false
    success.value = t('game_sim.create_success')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    creating.value = false
  }
}

function dropGame(game: RunningSimulatedGame): void {
  const index = runningGames.value.indexOf(game)
  if (index !== -1) runningGames.value.splice(index, 1)
  if (game.appId && rpcAppId.value === game.appId) rpcAppId.value = null
}

/**
 * Tear down a game whose start failed after the process was already live.
 * `historyBegan` says whether this page owns a recording segment: closing one
 * that belongs to another running row would silently freeze that game's play
 * time, so it is only finished when this start created it.
 */
async function rollbackStartedGame(game: RunningSimulatedGame, historyBegan: boolean): Promise<void> {
  const failures: string[] = []
  if (game.execName) {
    await stopSimulatedGame(game.execName).catch(e => failures.push(errorMessage(e)))
  }
  if (game.appId && historyBegan) {
    await stopGameSimulationUsage(game.appId).catch(e => failures.push(errorMessage(e)))
  }
  dropGame(game)
  if (failures.length > 0) {
    throw new Error(t('game_sim.history_rollback_failed', { error: failures.join('; ') }))
  }
}

async function rollbackCdpSession(): Promise<void> {
  try {
    await stopManualCdpGameSimulation()
    activeCdpSession.value = null
    cdpAppId.value = null
  } catch (e) {
    throw new Error(t('game_sim.history_rollback_failed', { error: errorMessage(e) }))
  }
}

/**
 * Stop one game's process and close its recording. A row is only removed once
 * both landed, so a failed history write keeps a retryable Stop surface.
 */
async function stopOneGame(game: RunningSimulatedGame): Promise<void> {
  if (!game.historyPending) {
    if (game.appId && rpcAppId.value === game.appId) {
      await disconnectFromDiscordRpc()
      rpcAppId.value = null
    }
    if (game.execName) {
      await stopSimulatedGame(game.execName)
      game.historyPending = game.appId !== ''
    }
  }
  if (game.appId) {
    await stopGameSimulationUsage(game.appId)
    game.historyPending = false
  }
  dropGame(game)
}

async function handleRunGame() {
  // Resolve which exe name to use
  const exeName = effectiveExecutable.value
  if (!exeName || creating.value || processBlocked.value || selectedAlreadyRunning.value) return

  const appId = mode.value === 'custom' ? '' : (selectedGame.value?.id ?? '')
  const displayName = mode.value === 'custom' ? customExeName.value : (selectedGame.value?.name ?? '')
  const game: RunningSimulatedGame = {
    appId,
    appName: displayName,
    execName: exeName,
    historyPending: false,
  }

  running.value = true
  error.value = null
  success.value = null

  try {
    const simulationPath = await store.initSimulationPath()
    await runSimulatedGame(displayName, simulationPath, exeName, appId)
    runningGames.value.push(game)

    // Play-time tracking is mandatory, so it begins first and a failure rolls
    // the process back. Starting it before the presence also means a Discord
    // connection error cannot leave an uncounted game running.
    if (appId) {
      try {
        await startGameSimulationUsage(appId, displayName)
      } catch (historyError) {
        try {
          await rollbackStartedGame(game, false)
        } catch (cleanupError) {
          throw new Error(`${t('game_sim.history_start_failed', { error: errorMessage(historyError) })} ${errorMessage(cleanupError)}`)
        }
        throw new Error(t('game_sim.history_start_failed', { error: errorMessage(historyError) }))
      }
    }

    // Discord carries a single RPC presence, so only the first simulated game
    // claims it. The others are detected from their process names, while every
    // one of them keeps its own play-time recording.
    const ownsRpc = appId !== '' && rpcAppId.value === null
    if (ownsRpc) {
      const activity = {
        app_id: appId,
        state: 'In Game',
        details: `Playing ${displayName}`,
        largeImageKey: 'logo',
        largeImageText: displayName,
        timestamp: Math.floor(Date.now() / 1000),
      }
      try {
        await connectToDiscordRpc(JSON.stringify(activity), 'connect')
        rpcAppId.value = appId
      } catch (rpcError) {
        // The presence is the only thing that failed, so the recorded process
        // stays running and only the connection is rewound.
        error.value = errorMessage(rpcError)
      }
    }
    success.value = ownsRpc && !error.value ? t('game_sim.run_success_rpc') : t('game_sim.run_success')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    running.value = false
  }
}

async function handleRunCdpGame() {
  const game = selectedGame.value
  if (!game || creating.value || cdpStarting.value || hasActiveSimulation.value || store.runningQuests.length > 0) return

  cdpStarting.value = true
  error.value = null
  success.value = null

  try {
    // Refresh immediately before mutation so a stale connected flag cannot
    // enable an injection after Discord has been closed or restarted.
    await store.initCdpMode()
    if (!store.cdpAvailable) {
      throw new Error(t('game_sim.cdp_unavailable'))
    }

    const session = await startManualCdpGameSimulation(game.id, game.name, store.cdpPort)
    activeCdpSession.value = session
    cdpAppId.value = session.appId
    try {
      await startGameSimulationUsage(game.id, game.name)
    } catch (historyError) {
      // Remove the CDP injection before reporting the failure; otherwise Discord
      // keeps showing activity that this app no longer accounts for.
      try {
        await rollbackCdpSession()
      } catch (cleanupError) {
        throw new Error(`${t('game_sim.history_start_failed', { error: errorMessage(historyError) })} ${errorMessage(cleanupError)}`)
      }
      throw new Error(t('game_sim.history_start_failed', { error: errorMessage(historyError) }))
    }
    success.value = t('game_sim.cdp_started', { name: game.name })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    cdpStarting.value = false
  }
}

async function handleStopGame() {
  if (stopping.value) return
  if (!cdpActive.value && !processActive.value) {
    error.value = t('game_sim.no_active_process')
    return
  }

  stopping.value = true
  error.value = null
  success.value = null

  try {
    if (cdpActive.value) {
      if (!cdpHistoryPending.value) {
        await stopManualCdpGameSimulation()
        activeCdpSession.value = null
        cdpHistoryPending.value = true
      }
      await stopGameSimulationUsage(cdpAppId.value ?? undefined)
      cdpHistoryPending.value = false
      cdpAppId.value = null
      success.value = t('game_sim.cdp_stopped')
      return
    }

    const failures: string[] = []
    for (const game of [...runningGames.value]) {
      try {
        await stopOneGame(game)
      } catch (e) {
        failures.push(errorMessage(e))
      }
    }
    if (runningGames.value.length === 0) {
      // Close any recording this page could not pair with a process, such as
      // after a reload that restored several games and segments. Another owner
      // (Game Idle rotation or a quest) keeps its own segments — finishing all
      // of them here would silently freeze a recording this page does not own.
      if (!idleStore.isActive && !idleStore.loading && store.runningQuests.length === 0) {
        if (rpcAppId.value) {
          await disconnectFromDiscordRpc().catch(() => undefined)
          rpcAppId.value = null
        }
        await stopGameSimulationUsage().catch(e => failures.push(errorMessage(e)))
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '))
    success.value = t('game_sim.stopped')
  } catch (e) {
    const detail = errorMessage(e)
    error.value = cdpHistoryPending.value
      ? t('game_sim.history_stop_failed', { error: detail })
      : cdpActive.value
      ? t('game_sim.cdp_cleanup_failed', { error: detail })
      : detail
  } finally {
    stopping.value = false
  }
}

async function stopRunningGame(game: RunningSimulatedGame): Promise<void> {
  if (stopping.value) return
  stopping.value = true
  stoppingExec.value = game.execName || game.appId
  error.value = null
  success.value = null
  try {
    await stopOneGame(game)
    success.value = t('game_sim.stopped')
  } catch (e) {
    const detail = errorMessage(e)
    error.value = game.historyPending
      ? t('game_sim.history_stop_failed', { error: detail })
      : detail
  } finally {
    stopping.value = false
    stoppingExec.value = null
  }
}
</script>

<template>
  <div class="game-simulator-view fade-in space-y-6" :class="mode === 'idle' && (idleStore.isActive || idleStore.loading) && 'is-idle-immersive'">
    <div v-if="!(mode === 'idle' && (idleStore.isActive || idleStore.loading))" class="flex justify-between items-center flex-wrap gap-3">
      <h2 class="text-2xl font-bold tracking-tight">{{ t('game_sim.title') }}</h2>
      <!-- Mode toggle -->
      <div class="flex rounded-lg border p-1 gap-1 bg-muted/50">
        <Button
          size="sm"
          :variant="mode === 'select' ? 'default' : 'ghost'"
          class="gap-1.5 h-7 px-3 text-xs"
          :disabled="selectionLocked || simulatorBusy"
          @click="switchMode('select')"
        >
          <List class="w-3.5 h-3.5" />
          {{ t('game_sim.mode_from_list') }}
        </Button>
        <Button
          size="sm"
          :variant="mode === 'custom' ? 'default' : 'ghost'"
          class="gap-1.5 h-7 px-3 text-xs"
          :disabled="selectionLocked || simulatorBusy"
          @click="switchMode('custom')"
        >
          <Terminal class="w-3.5 h-3.5" />
          {{ t('game_sim.mode_custom') }}
        </Button>
        <Button
          size="sm"
          :variant="mode === 'idle' ? 'default' : 'ghost'"
          class="gap-1.5 h-7 px-3 text-xs"
          :disabled="(hasActiveSimulation && !idleStore.isActive) || simulatorBusy"
          @click="switchMode('idle')"
        >
          <RotateCcw class="w-3.5 h-3.5" />
          {{ t('game_idle.nav') }}
        </Button>
      </div>
    </div>

    <Card v-if="processActive && mode !== 'idle'">
      <CardHeader>
        <CardTitle class="text-base">{{ t('game_sim.running_title') }}</CardTitle>
      </CardHeader>
      <CardContent class="space-y-2">
        <div
          v-for="game in runningGames"
          :key="game.execName || game.appId"
          class="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2"
        >
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{{ game.appName || game.execName }}</div>
            <div class="truncate font-mono text-xs text-muted-foreground">
              <span v-if="game.execName">{{ game.execName }}</span>
              <span v-else>{{ t('game_sim.history_only') }}</span>
              <span v-if="game.appId" class="ml-2">App ID: {{ game.appId }}</span>
              <span v-if="game.appId === rpcAppId" class="ml-2">RPC</span>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            class="gap-1.5 shrink-0"
            :disabled="stopping"
            @click="stopRunningGame(game)"
          >
            <Loader2
              v-if="stoppingExec === (game.execName || game.appId)"
              class="w-3.5 h-3.5 animate-spin"
            />
            <Square v-else class="w-3.5 h-3.5" />
            {{ t('game_sim.stop_game') }}
          </Button>
        </div>
      </CardContent>
      <CardFooter>
        <Button variant="destructive" class="w-full" :disabled="stopping" @click="handleStopGame">
          <Square v-if="!stopping" class="w-4 h-4 mr-2" />
          <Loader2 v-else class="w-4 h-4 mr-2 animate-spin" />
          {{ stopping ? t('game_sim.stopping') : t('game_sim.stop_all') }}
        </Button>
      </CardFooter>
    </Card>

    <GameIdlePanel v-if="mode === 'idle'" />

    <div v-else class="grid grid-cols-1 gap-6" :class="mode === 'select' ? 'lg:grid-cols-2' : ''">
      <GameSelector v-if="mode === 'select'" :disabled="selectionLocked || simulatorBusy" @select="selectGame" />

      <Card>
        <CardHeader>
          <CardTitle>{{ t('game_sim.config_title') }}</CardTitle>
          <CardDescription>{{ mode === 'custom' ? t('game_sim.custom_config_desc') : t('game_sim.config_desc') }}</CardDescription>
        </CardHeader>

        <CardContent>
          <div
            v-if="activeCdpSession"
            class="mb-6 p-3 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 rounded-md text-sm border border-emerald-500/20"
          >
            {{ t('game_sim.cdp_active', { name: activeCdpSession.appName }) }}
          </div>

          <!-- ── SELECT MODE ─────────────────────────── -->
          <template v-if="mode === 'select'">
            <div v-if="!selectedGame" class="text-center py-8 text-muted-foreground border-2 border-dashed rounded-lg">
              {{ t('game_sim.select_game') }}
              <p v-if="error" class="mt-3 mx-3 p-3 bg-destructive/10 text-destructive rounded-md text-sm text-left">
                {{ error }}
              </p>
            </div>

            <div v-else class="space-y-6">
              <div class="p-4 bg-muted/50 rounded-lg space-y-1">
                <div class="font-bold text-lg text-primary">{{ selectedGame.name }}</div>
                <div class="text-xs text-muted-foreground font-mono">App ID: {{ selectedGame.id }}</div>
                <div class="pt-2 text-sm font-medium text-foreground">
                  {{ t('game_idle.history_duration', {
                    hours: selectedHistoryDuration.hours,
                    minutes: selectedHistoryDuration.minutes,
                  }) }}
                </div>
              </div>

              <div v-if="!store.platformCapabilitiesReady" class="text-center py-4 text-muted-foreground">
                {{ t('general.loading') }}
              </div>

              <div v-else-if="!store.platformCapabilities" class="p-3 bg-destructive/10 text-destructive rounded-md text-sm">
                {{ t('game_sim.platform_capabilities_unavailable') }}
              </div>

              <!-- No simulator-compatible executables — let user enter a custom name -->
              <template v-else-if="!hasCompatibleExecutables">
                <div class="p-3 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-md text-sm border border-yellow-500/20 space-y-1">
                  <p>{{ isWin32OnlyOnLinux ? t('game_sim.no_linux_exe_hint') : t('game_sim.no_exe_hint') }}</p>
                  <p>{{ t('game_sim.no_exe_custom_warning') }}</p>
                </div>

                <div class="space-y-2">
                  <Label>{{ t('game_sim.custom_exe_label') }}</Label>
                  <Input
                    v-model="selectModeCustomExe"
                    :placeholder="t('game_sim.custom_exe_placeholder')"
                  />
                </div>

              </template>

              <template v-else>
                <div class="space-y-2">
                  <Label>{{ t('game_sim.select_exe') }}</Label>
                  <div ref="exeDropdownRef" class="relative">
                    <button
                      type="button"
                      class="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      @click="toggleExeDropdown"
                    >
                      <span :class="selectedExecutable ? 'text-foreground' : 'text-muted-foreground'">
                        {{ selectedExecutable || t('game_sim.select_exe') }}
                      </span>
                      <ChevronDown class="w-4 h-4 text-muted-foreground shrink-0 transition-transform" :class="exeDropdownOpen && 'rotate-180'" />
                    </button>

                    <Transition
                      enter-active-class="transition ease-out duration-100"
                      enter-from-class="opacity-0 -translate-y-1"
                      enter-to-class="opacity-100 translate-y-0"
                      leave-active-class="transition ease-in duration-75"
                      leave-from-class="opacity-100 translate-y-0"
                      leave-to-class="opacity-0 -translate-y-1"
                    >
                      <div
                        v-if="exeDropdownOpen"
                        class="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md overflow-hidden"
                      >
                        <div class="max-h-48 overflow-y-auto p-1">
                          <button
                            v-for="exe in compatibleExecutables"
                            :key="exe.name"
                            type="button"
                            class="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                            :class="selectedExecutable === exe.name && 'bg-accent/50'"
                            @click="selectExe(exe.name)"
                          >
                            <Check v-if="selectedExecutable === exe.name" class="w-4 h-4 shrink-0 text-primary" />
                            <span v-else class="w-4 shrink-0" />
                            <span class="font-mono truncate">{{ exe.name }}</span>
                          </button>
                        </div>
                      </div>
                    </Transition>
                  </div>
                </div>

              </template>

              <div v-if="error" class="p-3 bg-destructive/10 text-destructive rounded-md text-sm">{{ error }}</div>
              <div v-if="success" class="p-3 bg-green-500/10 text-green-600 rounded-md text-sm">{{ success }}</div>
            </div>
          </template>

          <!-- ── CUSTOM MODE ─────────────────────────── -->
          <template v-else>
            <div class="space-y-6">
              <div class="space-y-2">
                <Label>{{ t('game_sim.custom_exe_label') }}</Label>
                <Input
                  v-model="customExeName"
                  :placeholder="t('game_sim.custom_exe_placeholder')"
                />
                <p class="text-xs text-muted-foreground">{{ t('game_sim.custom_exe_hint') }}</p>
              </div>

              <div v-if="error" class="p-3 bg-destructive/10 text-destructive rounded-md text-sm">{{ error }}</div>
              <div v-if="success" class="p-3 bg-green-500/10 text-green-600 rounded-md text-sm">{{ success }}</div>
            </div>
          </template>
        </CardContent>

        <CardFooter v-if="canProceed" class="flex flex-col gap-2">
          <p v-if="selectedAlreadyRunning" class="text-xs text-muted-foreground">
            {{ t('game_sim.already_running') }}
          </p>
          <div class="grid grid-cols-2 gap-2 w-full">
            <Button
              v-if="!cdpActive"
              @click="handleRunGame"
              class="w-full bg-green-600 hover:bg-green-700 text-white"
              :disabled="!effectiveExecutable || simulatorBusy || processBlocked || selectedAlreadyRunning"
            >
              <Play v-if="!running" class="w-4 h-4 mr-2" />
              <Loader2 v-else class="w-4 h-4 mr-2 animate-spin" />
              {{ running ? t('game_sim.starting') : t('game_sim.run_game') }}
            </Button>

            <Button
              v-if="mode === 'select' && !cdpActive"
              @click="handleRunCdpGame"
              variant="outline"
              class="w-full border-emerald-500/50 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
              :disabled="!selectedGame || !store.cdpAvailable || simulatorBusy || processActive || idleStore.isActive || store.runningQuests.length > 0"
              :title="store.cdpAvailable ? t('game_sim.cdp_button_hint') : t('game_sim.cdp_unavailable')"
            >
              <MonitorPlay v-if="store.cdpAvailable && !cdpStarting" class="w-4 h-4 mr-2" />
              <WifiOff v-else-if="!store.cdpAvailable && !cdpStarting" class="w-4 h-4 mr-2" />
              <Loader2 v-else class="w-4 h-4 mr-2 animate-spin" />
              {{ cdpStarting ? t('game_sim.cdp_starting') : t('game_sim.run_cdp_game') }}
            </Button>

            <Button
              v-if="cdpActive"
              @click="handleStopGame"
              variant="destructive"
              class="w-full"
              :disabled="stopping"
            >
              <Square v-if="!stopping" class="w-4 h-4 mr-2" />
              <Loader2 v-else class="w-4 h-4 mr-2 animate-spin" />
              {{ stopping ? t('game_sim.stopping') : t('game_sim.stop_game') }}
            </Button>

            <Button
              @click="openCreateDialog"
              variant="outline"
              class="w-full"
              :disabled="!effectiveExecutable || selectionLocked || simulatorBusy"
            >
              <Hammer class="w-4 h-4 mr-2" />
              {{ t('game_sim.create_game') }}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>

    <!-- Create Simulated Game Dialog -->
    <Dialog v-model:open="showCreateDialog">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('game_sim.create_dialog_title') }}</DialogTitle>
          <DialogDescription>{{ t('game_sim.create_dialog_desc') }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-4 py-2">
          <div v-if="store.simulationPath" class="space-y-2">
            <Label class="flex items-center gap-1.5">
              <FolderOpen class="w-3.5 h-3.5" />
              {{ t('settings.simulation_directory') }}
            </Label>
            <div class="rounded-md border bg-muted/40 px-3 py-2">
              <code class="break-all text-xs font-mono">{{ store.simulationPath }}</code>
            </div>
            <p class="text-xs text-muted-foreground">{{ t('settings.simulation_directory_desc') }}</p>
          </div>

          <div v-if="error" class="p-3 bg-destructive/10 text-destructive rounded-md text-sm">{{ error }}</div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="showCreateDialog = false">
            {{ t('dialog.cancel') }}
          </Button>
          <Button
            @click="handleCreateGame"
            :disabled="creating"
          >
            <Hammer v-if="!creating" class="w-4 h-4 mr-2" />
            <Loader2 v-else class="w-4 h-4 mr-2 animate-spin" />
            {{ creating ? t('game_sim.creating') : t('game_sim.create_game') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.is-idle-immersive {
  min-height: 100%;
  width: 100%;
  gap: 0;
}
</style>

