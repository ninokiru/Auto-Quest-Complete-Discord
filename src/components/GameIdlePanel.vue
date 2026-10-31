<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  ChevronDown,
  Clock3,
  Gamepad2,
  Loader2,
  MonitorPlay,
  MoreHorizontal,
  Play,
  RotateCcw,
  Search,
  Square,
  TimerReset,
  Trash2,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import DurationSettingInput from '@/components/DurationSettingInput.vue'
import SettingsSwitch from '@/components/settings/SettingsSwitch.vue'
import { useAuthStore } from '@/stores/auth'
import {
  MAX_CONCURRENT_GAMES,
  formatSimulationDuration,
  useGameIdleStore,
} from '@/stores/gameIdle'
import { useQuestsStore } from '@/stores/quests'
import { getSimulationExecutables } from '@/utils/executables'
import type { DetectableGame, GameIdleItem, GameIdleLane, GameIdlePhase } from '@/api/tauri'

const { t } = useI18n()
const auth = useAuthStore()
const idle = useGameIdleStore()
const quests = useQuestsStore()
const stage = ref<HTMLElement | null>(null)
const stageWidth = ref(900)
const now = ref(Date.now())
const contextMenu = ref<{ item: GameIdleItem; x: number; y: number } | null>(null)
let clockTimer: ReturnType<typeof setInterval> | null = null
let resizeObserver: ResizeObserver | null = null
let stopStageWatch: (() => void) | null = null

const active = computed(() => idle.isActive)
const immersive = computed(() => active.value || idle.loading)
const canEditQueue = computed(() => {
  const phase = idle.status?.phase
  return active.value && phase !== 'stopping' && phase !== 'error'
})
const games = computed(() => quests.detectableGames)

// Only the games the picker allows reach the cycle: the picked subset when the
// user narrowed it, otherwise the whole catalog (the page's original behaviour).
const poolGames = computed(() => idle.candidateGames(games.value))
const allGameIds = computed(() => [...new Set(games.value.map(game => game.id))])

/** Executables the process simulator can launch for a game on this host, or
 *  null while the capability descriptor is still loading. */
function compatibleExeCount(game: DetectableGame): number | null {
  const capabilities = quests.platformCapabilities
  if (!capabilities) return null
  return getSimulationExecutables(
    game.executables,
    capabilities.os,
    capabilities.executableOsPriority
  ).length
}

/** Process mode can only spawn a game that ships a native executable; CDP
 *  spoofs the application id, so every catalog entry is usable there. While the
 *  capability descriptor is still loading nothing is ruled out. */
function isSelectable(game: DetectableGame): boolean {
  if (idle.mode === 'cdp') return true
  const count = compatibleExeCount(game)
  return count === null || count > 0
}

const processCandidateCount = computed(() => {
  if (!quests.platformCapabilities) return 0
  return new Set(poolGames.value.filter(game => isSelectable(game)).map(game => game.id)).size
})
const candidateCount = computed(() => idle.mode === 'cdp' ? poolGames.value.length : processCandidateCount.value)

const usingAllGames = computed(() => idle.selectedGameIds.length === 0)
const pickedGameIds = computed(() => new Set(idle.selectedGameIds))
const selectionSummary = computed(() =>
  usingAllGames.value
    ? t('game_idle.all_games', { count: allGameIds.value.length })
    : t('game_idle.picked_games', { picked: poolGames.value.length, total: allGameIds.value.length })
)

const showGamePicker = ref(false)
const gameSearch = ref('')
const gamesLoading = ref(false)
const gamesLoadFailed = ref(false)

// Rendering every detectable game at once costs more than the dialog can show;
// the search box narrows the catalog before the cap applies.
const PICKER_LIMIT = 200

// Each row reads its executable list once here. Calling the helpers from the
// template made every row resolve the same list six times per render.
interface PickerEntry {
  game: DetectableGame
  picked: boolean
  selectable: boolean
  hint: string
  warn: boolean
}

function executableHint(game: DetectableGame, compatible: number | null): string {
  const typeLabel = game.type_name === 'App' ? t('game_sim.type_app') : t('game_sim.type_game')
  if (idle.mode === 'cdp' || compatible === null) return typeLabel
  if (compatible === 0) return t('game_idle.no_compatible_executable')
  return t('game_sim.exe_count', { count: compatible })
}

const visiblePickerGames = computed<PickerEntry[]>(() => {
  const query = gameSearch.value.trim().toLowerCase()
  const matches = query
    ? games.value.filter(game => game.name.toLowerCase().includes(query))
    : [...games.value]
  if (!usingAllGames.value) {
    // A narrowed selection shows the games already in the cycle first, so a
    // game below the cap can still be ticked off.
    const picked = pickedGameIds.value
    matches.sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)))
  }
  const picked = pickedGameIds.value
  const everything = usingAllGames.value
  return matches.slice(0, PICKER_LIMIT).map(game => {
    const compatible = idle.mode === 'cdp' ? null : compatibleExeCount(game)
    const selectable = idle.mode === 'cdp' || compatible === null || compatible > 0
    return {
      game,
      selectable,
      picked: selectable && (everything || picked.has(game.id)),
      hint: executableHint(game, compatible),
      warn: idle.mode === 'process' && compatible === 0,
    }
  })
})

/** Tick or untick one game. "Everything ticked" collapses back to the empty
 *  sentinel so the cycle keeps following Discord's catalog as it changes. */
function toggleGame(game: DetectableGame) {
  if (active.value || !isSelectable(game)) return
  const current = usingAllGames.value ? allGameIds.value : idle.selectedGameIds
  const next = current.includes(game.id)
    ? current.filter(id => id !== game.id)
    : [...current, game.id]
  const nextIds = new Set(next)
  const coversCatalog = allGameIds.value.every(id => nextIds.has(id))
  idle.setSelectedGames(coversCatalog ? [] : next)
}

function resetGameSelection() {
  if (active.value) return
  idle.setSelectedGames([])
  gameSearch.value = ''
}

function openGamePicker() {
  if (active.value || idle.loading) return
  gameSearch.value = ''
  showGamePicker.value = true
}

async function loadGames(force = false) {
  gamesLoading.value = true
  gamesLoadFailed.value = false
  try {
    await quests.getDetectableGames(force)
  } catch {
    gamesLoadFailed.value = true
  } finally {
    gamesLoading.value = false
  }
}

const maxVisibleDistance = computed(() => {
  if (stageWidth.value >= 1050) return 5
  if (stageWidth.value >= 820) return 4
  if (stageWidth.value >= 620) return 3
  return 2
})

const lanes = computed(() => idle.status?.lanes ?? [])
const isMultiLane = computed(() => lanes.value.length > 1)
// The featured lane is the one that started most recently, which is the game
// the reel centers on and the name the readout leads with.
const featuredLane = computed(() =>
  lanes.value.reduce<GameIdleLane | null>(
    (newest, lane) => (!newest || lane.startedAt > newest.startedAt ? lane : newest),
    null
  )
)

const carouselItems = computed(() => {
  const status = idle.status
  if (!status) return []
  // A lane's game is already reported through `recent`, and the backend never
  // queues it in `upcoming` at the same time, so the two lists can be laid out
  // back to back without the old current-item handoff.
  const recent = status.recent.slice(-5)
  const items: Array<{ item: GameIdleItem; offset: number; upcoming: boolean }> = recent.map(
    (item, index) => ({ item, offset: index - recent.length + 1, upcoming: false })
  )
  status.upcoming.forEach((item, index) => {
    items.push({ item, offset: index + 1, upcoming: true })
  })
  return items.filter(entry => Math.abs(entry.offset) <= maxVisibleDistance.value)
})

function laneRemainingSeconds(lane: GameIdleLane) {
  if (lane.endsAt === null) return 0
  return Math.max(0, Math.ceil((lane.endsAt - now.value) / 1000))
}

function lanePhaseKey(phase: GameIdlePhase) {
  if (phase === 'resting') return 'game_idle.resting'
  if (phase === 'starting') return 'game_idle.starting'
  return 'game_idle.lane_playing'
}

// One lane means the phase countdown the panel has always shown; several lanes
// mean the moment the next of them hands its game over.
const phaseRemainingSeconds = computed(() => {
  const ends = lanes.value
    .map(lane => lane.endsAt)
    .filter((value): value is number => value !== null)
  if (ends.length === 0) return 0
  return Math.max(0, Math.ceil((Math.min(...ends) - now.value) / 1000))
})

// Every lane contributes its own playing time, so this is the total simulated
// time across games rather than the elapsed time of the session clock.
const sessionSeconds = computed(() => {
  const status = idle.status
  if (!status) return 0
  const live = status.lanes
    .filter(lane => lane.phase === 'playing')
    .reduce((total, lane) => total + Math.max(0, Math.floor((now.value - lane.startedAt) / 1000)), 0)
  return status.accumulatedPlayedSeconds + live
})

const sessionDuration = computed(() => formatSimulationDuration(sessionSeconds.value))
const configError = computed(() => idle.validateConfig())
const nextGameName = computed(() => idle.status?.upcoming[0]?.name || t('game_idle.preparing'))

// The play window can be a random range, so the readout describes the
// configured spec instead of the length resolved for the current cycle.
const configuredPlaySummary = computed(() => {
  const spec = idle.status?.playDuration ?? idle.playDuration
  if (spec.mode === 'fixed') return t('game_idle.configured_for', { count: spec.fixed })
  return t('game_idle.configured_range', { min: spec.min, max: spec.max })
})

function formatCountdown(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  const base = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  return hours > 0 ? `${hours}:${base}` : base
}

function iconUrl(item: GameIdleItem) {
  return item.icon ? `https://cdn.discordapp.com/app-icons/${item.id}/${item.icon}.png?size=128` : ''
}

async function startIdle() {
  if (configError.value) return
  await idle.start().catch(() => undefined)
}

async function stopIdle() {
  await idle.stop().catch(() => undefined)
}

function openContextMenu(event: MouseEvent | KeyboardEvent, item: GameIdleItem) {
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const mouse = event instanceof MouseEvent
  contextMenu.value = {
    item,
    x: Math.min(window.innerWidth - 232, Math.max(8, mouse && event.clientX ? event.clientX : rect.right - 8)),
    y: Math.min(window.innerHeight - 104, Math.max(8, mouse && event.clientY ? event.clientY : rect.bottom - 8)),
  }
  void nextTick(() => document.querySelector<HTMLElement>('[data-idle-context-action]')?.focus())
}

function handleFutureKeydown(event: KeyboardEvent, item: GameIdleItem) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    openContextMenu(event, item)
  }
}

async function removeContextItem() {
  const item = contextMenu.value?.item
  contextMenu.value = null
  if (item) await idle.removeUpcoming(item).catch(() => undefined)
}

function closeContextMenu(event?: Event) {
  const target = event?.target as HTMLElement | null
  if (target?.closest('[data-idle-context-menu]')) return
  contextMenu.value = null
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') contextMenu.value = null
}

onMounted(async () => {
  clockTimer = setInterval(() => {
    // Only a running session has countdowns on screen; without one the tick would
    // re-render the whole panel every second for nothing.
    if (idle.status) now.value = Date.now()
  }, 1000)
  resizeObserver = new ResizeObserver(entries => {
    stageWidth.value = entries[0]?.contentRect.width ?? stageWidth.value
  })
  stopStageWatch = watch(stage, (element, previous) => {
    if (previous) resizeObserver?.unobserve(previous)
    if (element) resizeObserver?.observe(element)
  }, { immediate: true })
  document.addEventListener('mousedown', closeContextMenu)
  document.addEventListener('keydown', handleDocumentKeydown)
  // A failed init must still leave the editable configuration on screen, so the
  // reason is published through the store's own error surface instead of throwing.
  await idle.initialize().catch(cause => {
    idle.error = cause instanceof Error ? cause.message : String(cause)
  })
  // The catalog feeds both the picker and the start request, so a failed load
  // is kept as a retryable state instead of leaving "0 games" on screen with a
  // disabled Start button and no explanation.
  await loadGames()
})

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer)
  stopStageWatch?.()
  resizeObserver?.disconnect()
  document.removeEventListener('mousedown', closeContextMenu)
  document.removeEventListener('keydown', handleDocumentKeydown)
})
</script>

<template>
  <section class="idle-shell space-y-5" :class="immersive && 'is-immersive'" aria-labelledby="game-idle-heading">
    <!-- The header holds only the title and the start/stop action: the duration
         controls need ~1100 px on one line, and a `1fr auto` grid hands the `auto`
         track its max-content first, which collapsed the heading at the app's
         1200 px window. They sit in their own wrapping row below. -->
    <div v-if="!immersive" class="idle-controls grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div>
        <div class="flex items-center gap-2 text-primary">
          <RotateCcw class="h-4 w-4" />
          <span class="text-xs font-semibold tracking-[0.16em] uppercase">{{ t('game_idle.eyebrow') }}</span>
        </div>
        <h3 id="game-idle-heading" class="mt-2 text-2xl font-semibold tracking-tight">
          {{ t('game_idle.title') }}
        </h3>
        <p class="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          {{ t('game_idle.description') }}
        </p>
      </div>

      <div class="flex items-center gap-3">
        <Button
          v-if="!active"
          class="h-10 min-w-28 gap-2"
          :disabled="idle.loading || !!configError || !auth.user || candidateCount === 0 || quests.runningQuests.length > 0"
          @click="startIdle"
        >
          <Loader2 v-if="idle.loading" class="h-4 w-4 animate-spin" />
          <Play v-else class="h-4 w-4 fill-current" />
          {{ idle.loading ? t('game_idle.starting') : t('game_idle.start') }}
        </Button>
        <Button v-else variant="destructive" class="h-10 min-w-28 gap-2" :disabled="idle.stopping" @click="stopIdle">
          <Loader2 v-if="idle.stopping" class="h-4 w-4 animate-spin" />
          <Square v-else class="h-4 w-4 fill-current" />
          {{ idle.stopping ? t('game_idle.stopping') : t('game_idle.stop') }}
        </Button>
      </div>
    </div>

    <div v-if="!immersive" class="flex flex-wrap items-end gap-3">
      <DurationSettingInput
        v-model="idle.playDuration"
        :label="t('game_idle.play_minutes')"
        unit="minutes"
        :min-allowed="1"
        :disabled="active"
        :invalid="configError === 'play_minutes'"
      />
      <DurationSettingInput
        v-model="idle.restDuration"
        :label="t('game_idle.rest_minutes')"
        unit="minutes"
        :min-allowed="0"
        :disabled="active"
        :invalid="configError === 'rest_minutes'"
      />
      <div class="space-y-1.5">
        <Label for="idle-concurrent-games" class="text-xs">{{ t('game_idle.concurrent_games') }}</Label>
        <Input
          id="idle-concurrent-games"
          v-model.number="idle.concurrentGames"
          type="number"
          inputmode="numeric"
          min="1"
          :max="MAX_CONCURRENT_GAMES"
          step="1"
          class="w-28 tabular-nums"
          :disabled="active || idle.mode === 'cdp'"
          :aria-invalid="configError === 'concurrent_games'"
        />
      </div>
      <div class="space-y-1.5">
        <Label class="text-xs">{{ t('game_idle.simulation_mode') }}</Label>
        <div class="flex h-10 rounded-md border bg-background p-1">
          <button
            type="button"
            class="idle-mode-button"
            :class="idle.mode === 'process' && 'is-active'"
            :disabled="active"
            @click="idle.mode = 'process'"
          >
            <Gamepad2 class="h-3.5 w-3.5" />
            {{ t('game_idle.process') }}
          </button>
          <button
            type="button"
            class="idle-mode-button"
            :class="idle.mode === 'cdp' && 'is-active'"
            :disabled="active || !quests.cdpAvailable"
            @click="idle.mode = 'cdp'"
          >
            <MonitorPlay class="h-3.5 w-3.5" />
            CDP
          </button>
        </div>
      </div>
      <div class="space-y-1.5">
        <Label class="text-xs">{{ t('game_idle.games') }}</Label>
        <Button
          variant="outline"
          class="h-10 w-60 justify-between gap-2 px-3"
          :disabled="active || idle.loading"
          :aria-label="selectionSummary"
          @click="openGamePicker"
        >
          <span class="flex min-w-0 items-center gap-2">
            <Gamepad2 class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="truncate text-sm">{{ selectionSummary }}</span>
          </span>
          <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </div>
    </div>

    <div v-if="!immersive" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="max-w-xl space-y-1">
          <Label class="text-xs">{{ t('game_idle.crash_simulation') }}</Label>
          <p class="text-xs text-muted-foreground">{{ t('game_idle.crash_simulation_desc') }}</p>
        </div>
        <SettingsSwitch
          :model-value="idle.crashEnabled"
          :disabled="active"
          :label="t('game_idle.crash_simulation')"
          @update:model-value="idle.crashEnabled = $event"
        />
      </div>
      <div v-if="idle.crashEnabled" class="flex flex-wrap items-end gap-3">
        <DurationSettingInput
          v-model="idle.crashAfterMinutes"
          :label="t('game_idle.crash_after')"
          unit="minutes"
          :min-allowed="1"
          :disabled="active"
          :invalid="configError === 'crash_simulation'"
        />
        <DurationSettingInput
          v-model="idle.reopenDelaySeconds"
          :label="t('game_idle.reopen_delay')"
          unit="seconds"
          :min-allowed="0"
          :disabled="active"
          :invalid="configError === 'crash_simulation'"
        />
      </div>
    </div>

    <div v-if="!immersive" class="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
      <span>{{ t('game_idle.candidate_count', { count: candidateCount }) }}</span>
      <span v-if="!auth.user" class="text-amber-700 dark:text-amber-300">{{ t('game_idle.sign_in_required') }}</span>
      <span v-else-if="configError" class="text-error">{{ t(`game_idle.${configError}_error`, { max: MAX_CONCURRENT_GAMES }) }}</span>
      <span v-else-if="idle.mode === 'cdp' && !quests.cdpAvailable" class="text-amber-700 dark:text-amber-300">{{ t('game_idle.cdp_unavailable') }}</span>
      <span v-else-if="idle.mode === 'cdp' && idle.concurrentGames > 1">{{ t('game_idle.concurrent_games_cdp_hint') }}</span>
      <span v-else-if="idle.mode === 'process' && idle.concurrentGames > candidateCount">{{ t('game_idle.concurrent_games_pool_hint', { count: candidateCount }) }}</span>
    </div>

    <div v-if="gamesLoadFailed" class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
      <span class="text-error">{{ t('game_idle.games_load_failed') }}</span>
      <Button variant="outline" class="h-7 px-2 text-xs" :disabled="gamesLoading" @click="loadGames(true)">
        <Loader2 v-if="gamesLoading" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
        {{ t('toast.retry') }}
      </Button>
    </div>
    <div v-else-if="!usingAllGames && poolGames.length === 0" class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
      <span class="text-error">{{ t('game_idle.picked_games_missing') }}</span>
      <Button variant="outline" class="h-7 px-2 text-xs" :disabled="active" @click="resetGameSelection">
        {{ t('game_idle.reset_all_games') }}
      </Button>
    </div>

    <div v-if="idle.error || idle.status?.warning" class="idle-warning" role="status">
      {{ idle.error || idle.status?.warning }}
    </div>

    <div v-if="idle.status?.lanes.length || idle.status?.upcoming.length" class="idle-machine">
      <div ref="stage" class="idle-stage" :aria-label="t('game_idle.queue_label')">
        <div class="idle-pointer" aria-hidden="true">
          <span>{{ idle.status.phase === 'resting' ? t('game_idle.resting') : idle.status.phase === 'starting' ? t('game_idle.starting') : t('game_idle.current') }}</span>
          <ChevronDown class="h-6 w-6 fill-current" />
        </div>

        <TransitionGroup name="idle-reel">
          <button
            v-for="entry in carouselItems"
            :key="entry.item.occurrenceId"
            type="button"
            class="idle-reel-item"
            :class="[entry.offset === 0 && 'is-current', entry.upcoming && 'is-upcoming']"
            :style="{
              '--idle-offset': entry.offset,
              '--idle-distance': Math.abs(entry.offset),
            }"
            :aria-label="entry.upcoming && canEditQueue ? t('game_idle.upcoming_item', { name: entry.item.name }) : entry.item.name"
            @contextmenu.prevent.stop="entry.upcoming && canEditQueue && openContextMenu($event, entry.item)"
            @keydown="entry.upcoming && canEditQueue && handleFutureKeydown($event, entry.item)"
          >
            <span class="idle-icon-frame">
              <img
                v-if="iconUrl(entry.item)"
                :src="iconUrl(entry.item)"
                :alt="entry.item.name"
                draggable="false"
                @error="($event.target as HTMLImageElement).style.display = 'none'"
              />
              <Gamepad2 class="idle-icon-fallback" aria-hidden="true" />
            </span>
            <span class="idle-icon-name">{{ entry.item.name }}</span>
            <MoreHorizontal v-if="entry.upcoming" class="idle-more h-4 w-4" aria-hidden="true" />
          </button>
        </TransitionGroup>
      </div>

      <div v-if="isMultiLane" class="idle-lanes" role="list" :aria-label="t('game_idle.active_lanes', { count: lanes.length })">
        <div class="idle-lanes-title">{{ t('game_idle.active_lanes', { count: lanes.length }) }}</div>
        <div v-for="lane in lanes" :key="lane.item.occurrenceId" class="idle-lane" role="listitem">
          <span class="idle-lane-name">{{ lane.item.name }}</span>
          <span class="idle-lane-phase">{{ t(lanePhaseKey(lane.phase)) }}</span>
          <strong v-if="lane.endsAt !== null" class="idle-lane-time">
            {{ formatCountdown(laneRemainingSeconds(lane)) }}
          </strong>
        </div>
      </div>

      <div class="idle-readout">
        <div class="idle-primary-readout">
          <span class="idle-readout-label">{{ idle.status.phase === 'resting' ? t('game_idle.resting_after') : idle.status.phase === 'starting' ? t('game_idle.starting') : t('game_idle.now_playing') }}</span>
          <strong>{{ featuredLane?.item.name || idle.status.upcoming[0]?.name || t('game_idle.preparing') }}</strong>
          <span class="idle-next">{{ t('game_idle.next') }} · {{ nextGameName }}</span>
        </div>
        <div class="idle-metric">
          <TimerReset class="h-4 w-4" />
          <span>{{ isMultiLane ? t('game_idle.next_change') : idle.status.phase === 'resting' ? t('game_idle.rest_remaining') : t('game_idle.play_remaining') }}</span>
          <strong>{{ formatCountdown(phaseRemainingSeconds) }}</strong>
          <small>{{ configuredPlaySummary }}</small>
        </div>
        <div class="idle-metric idle-total">
          <Clock3 class="h-4 w-4" />
          <span>{{ t('game_idle.session_total') }}</span>
          <strong>{{ t('game_idle.duration', { hours: sessionDuration.hours, minutes: sessionDuration.minutes }) }}</strong>
          <small>{{ isMultiLane ? t('game_idle.total_across_games') : t('game_idle.active_time_only') }}</small>
        </div>
      </div>

      <div v-if="active" class="idle-immersive-footer">
        <div class="idle-immersive-status">
          <span class="idle-live-dot" aria-hidden="true" />
          <span>{{ idle.status?.phase === 'resting' ? t('game_idle.resting') : t('game_idle.now_playing') }}</span>
        </div>
        <Button variant="destructive" class="idle-stop-button h-11 min-w-36 gap-2" :disabled="idle.stopping" @click="stopIdle">
          <Loader2 v-if="idle.stopping" class="h-4 w-4 animate-spin" />
          <Square v-else class="h-4 w-4 fill-current" />
          {{ idle.stopping ? t('game_idle.stopping') : t('game_idle.stop') }}
        </Button>
      </div>
    </div>

    <div v-else-if="immersive" class="idle-starting-surface">
      <div class="idle-empty-icon"><Loader2 class="h-7 w-7 animate-spin" /></div>
      <div class="idle-starting-copy">
        <h4 class="font-medium">{{ t('game_idle.starting') }}</h4>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('game_idle.preparing') }}</p>
      </div>
      <Button variant="destructive" class="idle-stop-button h-11 min-w-32 gap-2" :disabled="idle.stopping" @click="stopIdle">
        <Loader2 v-if="idle.stopping" class="h-4 w-4 animate-spin" />
        <Square v-else class="h-4 w-4 fill-current" />
        {{ idle.stopping ? t('game_idle.stopping') : t('game_idle.stop') }}
      </Button>
    </div>

    <div v-else class="idle-empty">
      <div class="idle-empty-icon">
        <Loader2 v-if="active" class="h-7 w-7 animate-spin" />
        <RotateCcw v-else class="h-7 w-7" />
      </div>
      <div>
        <h4 class="font-medium">{{ immersive ? t('game_idle.starting') : t('game_idle.ready_title') }}</h4>
        <p class="mt-1 text-sm text-muted-foreground">{{ immersive ? t('game_idle.preparing') : t('game_idle.ready_description') }}</p>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="idle-context">
        <div
          v-if="contextMenu"
          data-idle-context-menu
          class="idle-context-menu"
          :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
          role="menu"
        >
          <div class="idle-context-title">{{ contextMenu.item.name }}</div>
          <button data-idle-context-action type="button" role="menuitem" @click="removeContextItem">
            <Trash2 class="h-4 w-4" />
            {{ t('game_idle.remove_from_cycle') }}
          </button>
        </div>
      </Transition>
    </Teleport>

    <Dialog :open="showGamePicker" @update:open="showGamePicker = $event">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ t('game_idle.pick_games_title') }}</DialogTitle>
          <DialogDescription>{{ t('game_idle.pick_games_desc') }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="flex items-center gap-2">
            <div class="relative min-w-0 flex-1">
              <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                v-model="gameSearch"
                class="pl-9"
                :placeholder="t('game_idle.pick_games_search')"
                :aria-label="t('game_idle.pick_games_search')"
              />
            </div>
            <Button
              variant="outline"
              class="h-9 shrink-0 px-3 text-xs"
              :disabled="usingAllGames"
              @click="resetGameSelection"
            >
              {{ t('game_idle.reset_all_games') }}
            </Button>
          </div>
          <p class="text-xs text-muted-foreground" aria-live="polite">{{ selectionSummary }}</p>
          <div v-if="gamesLoadFailed" class="space-y-2 rounded-md border border-dashed px-3 py-3 text-xs">
            <p class="text-error">{{ t('game_idle.games_load_failed') }}</p>
            <Button variant="outline" class="h-7 px-2 text-xs" :disabled="gamesLoading" @click="loadGames(true)">
              <Loader2 v-if="gamesLoading" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {{ t('toast.retry') }}
            </Button>
          </div>
          <div
            v-else
            class="max-h-72 divide-y overflow-y-auto rounded-md border"
            role="group"
            :aria-label="t('game_idle.pick_games_title')"
          >
            <button
              v-for="entry in visiblePickerGames"
              :key="entry.game.id"
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
              :aria-pressed="entry.picked"
              :disabled="!entry.selectable"
              @click="toggleGame(entry.game)"
            >
              <span class="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md bg-muted/50">
                <img
                  v-if="entry.game.icon"
                  :src="`https://cdn.discordapp.com/app-icons/${entry.game.id}/${entry.game.icon}.png?size=64`"
                  alt=""
                  loading="lazy"
                  class="h-full w-full object-cover"
                  @error="($event.target as HTMLImageElement).style.display = 'none'"
                />
                <Gamepad2 v-else class="h-4 w-4 text-muted-foreground/60" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ entry.game.name }}</span>
                <span
                  class="block text-xs"
                  :class="entry.warn ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'"
                >{{ entry.hint }}</span>
              </span>
              <span
                class="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border"
                :class="entry.picked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'"
                aria-hidden="true"
              >
                <Check v-if="entry.picked" class="h-3 w-3" />
              </span>
            </button>
            <p v-if="visiblePickerGames.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">
              {{ games.length === 0 ? t('game_idle.no_games_available') : t('game_idle.pick_games_no_match') }}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button @click="showGamePicker = false">{{ t('game_idle.picker_done') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<style scoped>
.idle-shell {
  border: 1px solid hsl(var(--border) / 0.7);
  border-radius: 1.15rem;
  padding: clamp(1rem, 2.4vw, 1.75rem);
  background:
    radial-gradient(circle at 18% 0%, hsl(var(--primary) / 0.11), transparent 32rem),
    hsl(var(--card) / 0.76);
  box-shadow: inset 0 1px 0 hsl(var(--foreground) / 0.04), 0 24px 60px -48px hsl(var(--primary) / 0.7);
  overflow: hidden;
}

.idle-shell.is-immersive {
  min-height: calc(100dvh - 2rem);
  display: flex;
  flex-direction: column;
  justify-content: center;
  border: 0;
  border-radius: 0;
  padding: clamp(1rem, 4vw, 4rem);
  background:
    radial-gradient(circle at 50% 38%, hsl(var(--primary) / 0.15), transparent 30rem),
    hsl(var(--background));
  box-shadow: none;
}

.idle-shell.is-immersive .idle-machine {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: min(42rem, 76dvh);
  background: hsl(var(--card) / 0.52);
  box-shadow: inset 0 1px 0 hsl(var(--foreground) / 0.06), 0 32px 80px -56px hsl(var(--primary) / 0.9);
}

.idle-shell.is-immersive .idle-stage {
  height: clamp(18rem, 48dvh, 32rem);
}

.idle-immersive-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-top: 1px solid hsl(var(--border) / 0.55);
  padding: 1rem 1.25rem 1.15rem;
}

.idle-immersive-status {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: hsl(var(--muted-foreground));
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.idle-live-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: hsl(var(--destructive));
  box-shadow: 0 0 0 0.25rem hsl(var(--destructive) / 0.12);
}

.idle-stop-button {
  transition: transform 280ms cubic-bezier(.32,.72,0,1), box-shadow 280ms cubic-bezier(.32,.72,0,1);
}

.idle-stop-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 12px 28px -18px hsl(var(--destructive));
}

.idle-stop-button:active:not(:disabled) { transform: translateY(0) scale(.98); }

.idle-controls { position: relative; z-index: 2; }
.idle-mode-button { display: inline-flex; align-items: center; gap: .35rem; border-radius: .28rem; padding: 0 .7rem; font-size: .75rem; color: hsl(var(--muted-foreground)); transition: color 180ms ease, background 180ms ease, transform 120ms ease; }
.idle-mode-button:hover:not(:disabled) { color: hsl(var(--foreground)); }
.idle-mode-button:active:not(:disabled) { transform: translateY(1px); }
.idle-mode-button:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
.idle-mode-button.is-active { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); box-shadow: 0 5px 16px -10px hsl(var(--primary)); }
.idle-mode-button:disabled { cursor: not-allowed; opacity: .5; }
.idle-warning { border-left: 3px solid hsl(38 92% 55%); background: hsl(38 92% 55% / .09); padding: .75rem 1rem; color: hsl(var(--foreground)); font-size: .8rem; }

.idle-machine { border-radius: 1rem; background: hsl(var(--background) / .48); box-shadow: inset 0 0 0 1px hsl(var(--border) / .5); overflow: hidden; }
.idle-stage { position: relative; height: clamp(14rem, 28vw, 18.5rem); isolation: isolate; overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, black 11%, black 89%, transparent); mask-image: linear-gradient(90deg, transparent, black 11%, black 89%, transparent); }
.idle-stage::before { content: ''; position: absolute; inset: 20% 0 0; background: radial-gradient(ellipse at 50% 45%, hsl(var(--primary) / .13), transparent 36%); pointer-events: none; }
.idle-pointer { position: absolute; z-index: 4; top: clamp(2.1rem, 14%, 4.2rem); left: 50%; display: flex; flex-direction: column; align-items: center; color: hsl(var(--primary)); transform: translateX(-50%); }
.idle-pointer span { font-size: clamp(.82rem, 1.4vw, 1.05rem); font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }

.idle-reel-item { --item-gap: clamp(9rem, 16vw, 13rem); position: absolute; z-index: calc(5 - var(--idle-distance)); top: 50%; left: 50%; display: grid; justify-items: center; gap: .55rem; width: clamp(5.3rem, 9vw, 7.5rem); color: hsl(var(--foreground)); opacity: calc(1 - var(--idle-distance) * .16); transform: translate3d(calc(-50% + var(--idle-offset) * var(--item-gap)), -43%, 0) scale(calc(1 - var(--idle-distance) * .1)); filter: saturate(calc(1 - var(--idle-distance) * .1)); transition: transform 440ms cubic-bezier(.22,1,.36,1), opacity 360ms ease, filter 360ms ease; }
.idle-reel-item:focus-visible { outline: none; }
.idle-reel-item:focus-visible .idle-icon-frame { box-shadow: 0 0 0 3px hsl(var(--ring)); }
.idle-icon-frame { position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: 1; border-radius: clamp(.8rem, 1.5vw, 1.3rem); overflow: hidden; background: linear-gradient(145deg, hsl(var(--secondary)), hsl(var(--muted))); box-shadow: inset 0 1px 0 hsl(var(--foreground) / .12), 0 20px 32px -24px hsl(var(--foreground) / .65); transition: box-shadow 220ms ease, transform 220ms ease; }
.idle-icon-frame img { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; }
.idle-icon-fallback { position: absolute; width: 38%; height: 38%; color: hsl(var(--muted-foreground) / .58); }
.idle-icon-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .72rem; font-weight: 600; }
.idle-reel-item.is-current { z-index: 3; opacity: 1; filter: none; transform: translate3d(-50%, -40%, 0) scale(1.22); }
/* The compact, non-immersive stopped preview has less vertical room than the
   running reel. Lower its centered tile slightly so the pointer remains
   visually attached without overlapping the icon. */
.idle-shell:not(.is-immersive) .idle-reel-item.is-current { transform: translate3d(-50%, -27%, 0) scale(1.22); }
.idle-reel-item.is-current .idle-icon-frame { box-shadow: 0 0 0 1px hsl(var(--primary) / .55), 0 25px 45px -26px hsl(var(--primary)); }
.idle-reel-item.is-upcoming:hover .idle-icon-frame { transform: translateY(-3px); box-shadow: inset 0 1px 0 hsl(var(--foreground) / .14), 0 24px 36px -24px hsl(var(--primary)); }
.idle-more { position: absolute; right: .2rem; top: -.1rem; opacity: 0; color: hsl(var(--muted-foreground)); transition: opacity 180ms ease; }
.idle-reel-item.is-upcoming:hover .idle-more, .idle-reel-item.is-upcoming:focus-visible .idle-more { opacity: 1; }
.idle-reel-enter-active, .idle-reel-leave-active { transition: opacity 260ms ease, transform 440ms cubic-bezier(.22,1,.36,1), filter 440ms cubic-bezier(.22,1,.36,1); }
.idle-reel-enter-from { opacity: 0; transform: translate3d(calc(-50% + (var(--idle-offset) + 1) * var(--item-gap)), -43%, 0) scale(.65); }
.idle-reel-leave-to { opacity: 0; filter: blur(4px); transform: translate3d(calc(-50% + var(--idle-offset) * var(--item-gap)), -43%, 0) scale(.3); }

.idle-lanes { display: grid; gap: .5rem; max-height: 18rem; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid hsl(var(--border) / .55); background: hsl(var(--card) / .45); padding: .9rem 1.2rem 1rem; }
.idle-lanes-title { color: hsl(var(--muted-foreground)); font-size: .68rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.idle-lane { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: baseline; gap: .75rem; font-size: .8rem; }
.idle-lane-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.idle-lane-phase { color: hsl(var(--muted-foreground)); font-size: .68rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.idle-lane-time { min-width: 4.2rem; text-align: right; color: hsl(var(--primary)); font-variant-numeric: tabular-nums; }

.idle-readout { display: grid; grid-template-columns: minmax(0, 1.5fr) repeat(2, minmax(10rem, .75fr)); border-top: 1px solid hsl(var(--border) / .55); background: hsl(var(--card) / .65); }
.idle-primary-readout, .idle-metric { min-width: 0; padding: 1rem 1.2rem 1.15rem; }
.idle-primary-readout { display: flex; flex-direction: column; }
.idle-readout-label, .idle-metric span { color: hsl(var(--muted-foreground)); font-size: .68rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.idle-primary-readout strong { margin-top: .2rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: clamp(1.2rem, 2vw, 1.75rem); letter-spacing: -.03em; }
.idle-next { margin-top: .3rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: hsl(var(--muted-foreground)); font-size: .75rem; }
.idle-metric { display: grid; grid-template-columns: auto 1fr; align-items: center; column-gap: .45rem; border-left: 1px solid hsl(var(--border) / .55); }
.idle-metric > svg { color: hsl(var(--primary)); }
.idle-metric strong, .idle-metric small { grid-column: 1 / -1; }
.idle-metric strong { margin-top: .42rem; font-variant-numeric: tabular-nums; font-size: 1.32rem; letter-spacing: -.025em; }
.idle-metric small { margin-top: .12rem; color: hsl(var(--muted-foreground)); font-size: .68rem; }
.idle-empty { display: flex; min-height: 12rem; align-items: center; justify-content: center; gap: 1rem; border: 1px dashed hsl(var(--border)); border-radius: 1rem; background: hsl(var(--muted) / .18); }
.idle-empty-icon { display: grid; place-items: center; width: 3.4rem; height: 3.4rem; border-radius: 1rem; background: hsl(var(--primary) / .11); color: hsl(var(--primary)); }
.idle-starting-surface { display: flex; min-height: 12rem; align-items: center; justify-content: center; gap: 1rem; border-radius: 1rem; background: hsl(var(--card) / .52); }
.idle-starting-copy { min-width: 0; }

.idle-context-menu { position: fixed; z-index: 80; width: 14rem; overflow: hidden; border: 1px solid hsl(var(--border)); border-radius: .65rem; background: hsl(var(--popover)); color: hsl(var(--popover-foreground)); box-shadow: 0 18px 50px -20px hsl(var(--foreground) / .45); transform: translateY(3px); }
.idle-context-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid hsl(var(--border) / .65); padding: .65rem .75rem; color: hsl(var(--muted-foreground)); font-size: .7rem; }
.idle-context-menu button { display: flex; width: 100%; align-items: center; gap: .55rem; padding: .65rem .75rem; font-size: .8rem; transition: background 150ms ease, color 150ms ease; }
.idle-context-menu button:hover, .idle-context-menu button:focus-visible { outline: none; background: hsl(var(--destructive) / .12); color: hsl(var(--destructive)); }
.idle-context-enter-active, .idle-context-leave-active { transition: opacity 150ms ease, transform 180ms cubic-bezier(.22,1,.36,1); }
.idle-context-enter-from, .idle-context-leave-to { opacity: 0; transform: translateY(-2px) scale(.97); }

@media (max-width: 860px) {
  .idle-readout { grid-template-columns: 1fr 1fr; }
  .idle-primary-readout { grid-column: 1 / -1; border-bottom: 1px solid hsl(var(--border) / .55); }
  .idle-metric:first-of-type { border-left: 0; }

  .idle-shell.is-immersive { min-height: calc(100dvh - 1rem); padding: 0.75rem; }
  .idle-shell.is-immersive .idle-machine { min-height: min(38rem, 78dvh); }
}

@media (max-width: 560px) {
  .idle-immersive-footer { align-items: stretch; flex-direction: column; }
  .idle-stop-button { width: 100%; }
  .idle-starting-surface { align-items: stretch; flex-direction: column; padding: 2rem 1rem; }
}

@media (prefers-reduced-motion: reduce) {
  .idle-reel-item, .idle-reel-enter-active, .idle-reel-leave-active, .idle-context-enter-active, .idle-context-leave-active { transition-duration: 1ms !important; }
}
</style>
