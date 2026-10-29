<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, onUnmounted } from 'vue'
import { useQuestsStore } from '@/stores/quests'
import type { RunningQuest } from '@/stores/quests'
import type { Quest } from '@/api/tauri'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Activity, AlertCircle, ChevronUp, Cloud, Gamepad2, ListChecks, MonitorPlay, Timer, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { formatClockTime, formatSlotProgress } from '@/utils/questProgressDisplay'

const { t } = useI18n()
const questsStore = useQuestsStore()
const expanded = ref(false)
const floatingRef = ref<HTMLElement | null>(null)
const floatingPosition = ref<{ left: number, top: number } | null>(null)
const draggedDuringPointer = ref(false)
const FLOATING_POSITION_KEY = 'questHelper_progressFloatingPosition'
const EDGE_MARGIN = 12

let dragState: {
  pointerId: number
  startX: number
  startY: number
  originLeft: number
  originTop: number
  // Captured at pointerdown: measuring inside pointermove read layout right
  // after writing left/top, which forced a reflow on every move event.
  width: number
  height: number
} | null = null

// Local progress is now managed by the store. Up to `maxParallelQuests` quests
// can run at once; the first entry is the "primary" one the collapsed bubble and
// the animated bar follow.
const runningSlots = computed(() =>
  questsStore.runningQuests.map(slot => {
    const quest = questsStore.quests.find(candidate => candidate.id === slot.questId) ?? null
    return { slot, quest, appIcon: appIconFor(quest) }
  })
)

const runningIds = computed(() => new Set(questsStore.runningQuests.map(slot => slot.questId)))

const activeQuest = computed(() => {
  if (!questsStore.activeQuestId) return null
  return questsStore.quests.find(quest => quest.id === questsStore.activeQuestId) ?? null
})

const hasFloatingContent = computed(() =>
  questsStore.runningQuests.length > 0 || questsStore.questQueue.length > 0 || !!questsStore.error
)

const queuedUpcoming = computed(() =>
  questsStore.questQueue.filter(quest => !runningIds.value.has(quest.id))
)

const queuedBehindCount = computed(() => {
  return queuedUpcoming.value.length
})

const floatingTitle = computed(() => {
  if (questsStore.error && questsStore.runningQuests.length === 0) return t('toast.error')
  if (questsStore.activeQuestId) return t('quest.active_progress')
  return `${t('quest.up_next')} (${questsStore.questQueue.length})`
})

const floatingSubtitle = computed(() => {
  if (questsStore.activeQuestId) {
    return activeQuest.value?.config.messages.quest_name ?? t('quest.active_progress')
  }
  if (questsStore.questQueue.length > 0) {
    return questsStore.questQueue[0]?.config.messages.quest_name ?? t('quest.up_next')
  }
  return questsStore.error ?? ''
})

const floatingStyle = computed(() => {
  if (!floatingPosition.value) return {}
  return {
    left: `${floatingPosition.value.left}px`,
    top: `${floatingPosition.value.top}px`,
    right: 'auto',
    bottom: 'auto',
  }
})

function clampPosition(left: number, top: number, width?: number, height?: number) {
  if (width === undefined || height === undefined) {
    const rect = floatingRef.value?.getBoundingClientRect()
    width = rect?.width ?? 384
    height = rect?.height ?? 80
  }
  const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN)
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN)

  return {
    left: Math.min(maxLeft, Math.max(EDGE_MARGIN, left)),
    top: Math.min(maxTop, Math.max(EDGE_MARGIN, top)),
  }
}

function saveFloatingPosition() {
  if (!floatingPosition.value) return
  localStorage.setItem(FLOATING_POSITION_KEY, JSON.stringify(floatingPosition.value))
}

async function reconcileFloatingPosition() {
  await nextTick()
  const rect = floatingRef.value?.getBoundingClientRect()
  if (!rect) return
  floatingPosition.value = clampPosition(rect.left, rect.top)
  saveFloatingPosition()
}

function startDrag(event: PointerEvent) {
  if (event.button !== 0) return
  const rect = floatingRef.value?.getBoundingClientRect()
  if (!rect) return

  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originLeft: rect.left,
    originTop: rect.top,
    width: rect.width,
    height: rect.height,
  }
  draggedDuringPointer.value = false

  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  window.addEventListener('pointermove', handleDragMove)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
}

function handleDragMove(event: PointerEvent) {
  if (!dragState) return
  if (event.pointerId !== dragState.pointerId) return
  const dx = event.clientX - dragState.startX
  const dy = event.clientY - dragState.startY

  if (Math.abs(dx) + Math.abs(dy) > 4) {
    draggedDuringPointer.value = true
  }

  floatingPosition.value = clampPosition(
    dragState.originLeft + dx,
    dragState.originTop + dy,
    dragState.width,
    dragState.height
  )
}

function stopDrag(event: PointerEvent) {
  if (dragState && event.pointerId !== dragState.pointerId) return
  if (dragState && event.currentTarget instanceof HTMLElement) {
    try {
      event.currentTarget.releasePointerCapture(dragState.pointerId)
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  dragState = null
  saveFloatingPosition()
  window.removeEventListener('pointermove', handleDragMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
}

function handleCollapsedClick() {
  if (draggedDuringPointer.value) {
    draggedDuringPointer.value = false
    return
  }
  expanded.value = true
}

/**
 * Submitted/required text for one running slot: a `2/3` checkpoint count when the
 * slot counts checkpoints, otherwise the elapsed/total seconds clock.
 */
function slotSubmittedText(slot: RunningQuest): string {
  return formatSlotProgress(slot.serverProgress, slot.targetDuration, slot.progressUnit)
}

/** The app icon of the quest a slot runs, so a row reads like the list it came
 *  from instead of a bare number. */
function appIconFor(quest: Quest | null): string | null {
  const app = quest?.config.application
  if (!app?.icon) return null
  return `https://cdn.discordapp.com/app-icons/${app.id}/${app.icon}.png?size=64`
}

/** The kind of work a slot does, as the icon that says it without a word. */
function slotTypeIcon(slot: RunningQuest) {
  if (slot.type === 'video') return MonitorPlay
  if (slot.type === 'activity') return Activity
  if (slot.type === 'stream') return Cloud
  return Gamepad2
}

function slotTypeIconClass(slot: RunningQuest): string {
  if (slot.type === 'video') return 'text-sky-600 dark:text-sky-400'
  if (slot.type === 'activity') return 'text-amber-600 dark:text-amber-400'
  if (slot.type === 'stream') return 'text-violet-600 dark:text-violet-400'
  return 'text-indigo-600 dark:text-indigo-400'
}

async function handleStop() {
  await questsStore.stop()
}

async function handleStopQuest(questId: string) {
  await questsStore.stopRunningQuest(questId)
}

// Animate the submitted (blue) progress value so it eases forward instead of jumping
const animatedSubmitted = ref(questsStore.activeQuestProgress)

/** Percentage an easing bar should show for one slot. Only the primary quest gets
 *  the animated value; the others follow the backend directly. */
function slotSubmittedPercent(slot: RunningQuest): number {
  return slot.questId === questsStore.activeQuestId ? animatedSubmitted.value : slot.serverProgress
}
let _raf: number | null = null
watch(() => questsStore.activeQuestProgress, (next) => {
  if (_raf !== null) cancelAnimationFrame(_raf)
  const from = animatedSubmitted.value
  const to = next
  const duration = 450
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min((now - t0) / duration, 1)
    const eased = 1 - Math.pow(1 - t, 3) // ease-out cubic
    animatedSubmitted.value = from + (to - from) * eased
    if (t < 1) _raf = requestAnimationFrame(step)
    else { animatedSubmitted.value = to; _raf = null }
  }
  _raf = requestAnimationFrame(step)
})
onUnmounted(() => { if (_raf !== null) cancelAnimationFrame(_raf) })

onMounted(() => {
  const savedPosition = localStorage.getItem(FLOATING_POSITION_KEY)
  if (!savedPosition) return
  try {
    const parsed = JSON.parse(savedPosition) as { left?: unknown, top?: unknown }
    if (typeof parsed.left === 'number' && typeof parsed.top === 'number') {
      floatingPosition.value = clampPosition(parsed.left, parsed.top)
    }
  } catch {
    localStorage.removeItem(FLOATING_POSITION_KEY)
  }
})

watch(hasFloatingContent, (visible) => {
  if (!visible) expanded.value = false
})

watch([expanded, queuedBehindCount], () => {
  if (hasFloatingContent.value) {
    reconcileFloatingPosition()
  }
})

onUnmounted(() => {
  window.removeEventListener('pointermove', handleDragMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
})

// Single-gradient progress bar style: true blue→green color blend
function barStyleFor(local: number, submitted: number): Record<string, string> {
  if (local <= 0) return {}
  const junctionPct = Math.round((submitted / local) * 100)
  const stop1 = Math.max(0, junctionPct - 2)
  const stop2 = Math.min(100, junctionPct + 8)
  const hasPending = local > submitted + 0.5
  const bg = !hasPending
    ? 'hsl(var(--primary))'
    : `linear-gradient(to right, hsl(var(--primary)) ${stop1}%, rgb(74,222,128) ${stop2}%, rgb(74,222,128) 100%)`
  return {
    width: `${local}%`,
    background: bg,
    boxShadow: hasPending
      ? '0 1px 3px hsl(var(--primary) / 0.35), 1px 0 5px rgb(74 222 128 / 0.25)'
      : '0 1px 3px hsl(var(--primary) / 0.35)',
  }
}

const activeBarStyle = computed(() =>
  barStyleFor(questsStore.localProgress, animatedSubmitted.value)
)

function slotBarStyle(slot: RunningQuest): Record<string, string> {
  return barStyleFor(slot.localProgress, slotSubmittedPercent(slot))
}

// Keep-alive countdown: the quest already ended, but its game stays connected
// until the store's delayed teardown fires.
const nowTick = ref(Date.now())
let keepAliveTicker: ReturnType<typeof setInterval> | null = null
watch(() => questsStore.keepAliveEndsAt, (endsAt) => {
  if (endsAt !== null && keepAliveTicker === null) {
    nowTick.value = Date.now()
    keepAliveTicker = setInterval(() => { nowTick.value = Date.now() }, 1000)
  } else if (endsAt === null && keepAliveTicker !== null) {
    clearInterval(keepAliveTicker)
    keepAliveTicker = null
  }
}, { immediate: true })
onUnmounted(() => {
  if (keepAliveTicker !== null) clearInterval(keepAliveTicker)
})
const keepAliveRemainingText = computed(() => {
  const endsAt = questsStore.keepAliveEndsAt
  if (endsAt === null) return ''
  return formatClockTime(Math.max(0, Math.ceil((endsAt - nowTick.value) / 1000)))
})
</script>

<template>
  <div
    ref="floatingRef"
    v-if="hasFloatingContent"
    class="fixed bottom-5 right-5 z-50 w-[calc(100vw-2rem)] max-w-sm"
    :style="floatingStyle"
  >
    <!-- The two states differ a lot in height, so they swap out-and-in rather
         than flashing straight between them. The clamp re-runs once the new
         panel has its final size, otherwise a drag-placed widget can expand
         past the bottom edge. -->
    <Transition name="float-panel" mode="out-in" @after-enter="reconcileFloatingPosition">
      <button
        v-if="!expanded"
        key="collapsed"
        type="button"
        class="relative w-full cursor-grab overflow-hidden rounded-xl border border-border/60 bg-card px-4 py-3 text-left shadow-[0_16px_32px_-24px_hsl(var(--foreground)/0.65)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_20px_38px_-24px_hsl(var(--foreground)/0.75)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @pointerdown="startDrag"
        @click="handleCollapsedClick"
      >
      <span class="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-primary" aria-hidden="true" />
      <div class="flex items-center gap-3">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <AlertCircle v-if="questsStore.error && questsStore.runningQuests.length === 0" class="h-4 w-4" />
          <ListChecks v-else class="h-4 w-4" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-3">
            <p class="truncate text-sm font-semibold">{{ floatingTitle }}</p>
            <div class="flex shrink-0 items-center gap-2">
              <span v-if="questsStore.runningQuests.length > 0" class="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                {{ t('quest.running_count', { count: questsStore.runningQuests.length, max: questsStore.maxParallelQuests }) }}
              </span>
              <span v-if="queuedBehindCount > 0" class="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                {{ t('home.queue_count', { count: queuedBehindCount }) }}
              </span>
              <span v-if="questsStore.activeQuestId" class="text-sm font-semibold">
                {{ Math.floor(questsStore.activeQuestProgress) }}%
              </span>
            </div>
          </div>
          <p class="mt-0.5 truncate text-xs text-muted-foreground">{{ floatingSubtitle }}</p>
          <div v-if="questsStore.activeQuestId" class="mt-2 h-1.5 rounded-full bg-secondary">
            <div
              class="h-full rounded-full transition-all duration-300"
              :style="activeBarStyle"
            />
          </div>
        </div>
        <ChevronUp class="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
    </button>

    <Card v-else key="expanded" class="overflow-hidden border-border/60 shadow-[0_22px_48px_-28px_hsl(var(--foreground)/0.7)]">
      <CardHeader
        class="flex cursor-grab flex-row items-center justify-between space-y-0 border-b border-border/50 px-4 py-3 active:cursor-grabbing"
        @pointerdown="startDrag"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <AlertCircle v-if="questsStore.error && questsStore.runningQuests.length === 0" class="h-3.5 w-3.5 text-error" />
            <ListChecks v-else class="h-3.5 w-3.5 text-primary" />
          </span>
          <CardTitle class="min-w-0 truncate text-sm">
            {{ floatingTitle }}
            <span v-if="queuedBehindCount > 0" class="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
              {{ t('home.queue_count', { count: queuedBehindCount }) }}
            </span>
          </CardTitle>
        </div>
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" @pointerdown.stop @click="expanded = false">
          <X class="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent class="p-3">
        <div v-if="runningSlots.length > 0" class="space-y-2">
          <TransitionGroup name="slot-row" tag="div" class="max-h-[320px] space-y-2 overflow-y-auto pr-1">
            <div
              v-for="entry in runningSlots"
              :key="entry.slot.questId"
              class="relative overflow-hidden rounded-lg border border-border/60 bg-background/60 py-2.5 pl-3.5 pr-3"
            >
              <span class="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-primary" aria-hidden="true" />
              <div class="flex items-center gap-3">
                <div class="relative shrink-0">
                  <img
                    v-if="entry.appIcon"
                    :src="entry.appIcon"
                    class="h-8 w-8 rounded-lg object-cover"
                    alt=""
                  />
                  <div v-else class="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary">
                    <component :is="slotTypeIcon(entry.slot)" class="h-4 w-4 text-muted-foreground" />
                  </div>
                  <span
                    class="absolute -bottom-1 -right-1 flex h-[15px] w-[15px] items-center justify-center rounded border bg-card"
                    :class="slotTypeIconClass(entry.slot)"
                  >
                    <component :is="slotTypeIcon(entry.slot)" class="h-[9px] w-[9px]" />
                  </span>
                </div>

                <div class="min-w-0 flex-1">
                  <p class="truncate text-[13px] font-semibold leading-tight">
                    {{ entry.quest?.config.messages.quest_name ?? entry.slot.questId }}
                  </p>
                  <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {{ entry.quest?.config.messages.game_title }}
                  </p>
                  <div class="mt-1.5 flex items-center gap-2">
                    <div class="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div
                        class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
                        :style="slotBarStyle(entry.slot)"
                      />
                    </div>
                    <span class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {{ slotSubmittedText(entry.slot) }}
                    </span>
                  </div>
                </div>

                <div class="flex shrink-0 flex-col items-end gap-0.5">
                  <span class="font-mono text-sm font-medium tabular-nums">{{ Math.floor(entry.slot.serverProgress) }}%</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-6 shrink-0 px-2 text-[11px] text-error hover:bg-destructive/10 hover:text-error"
                    :disabled="questsStore.stopping"
                    @click="handleStopQuest(entry.slot.questId)"
                  >
                    {{ t('quest.stop_single') }}
                  </Button>
                </div>
              </div>
            </div>
          </TransitionGroup>

          <div class="flex justify-between px-1 text-[10px] text-muted-foreground">
            <div class="flex items-center gap-1.5">
              <div class="h-2 w-2 rounded-full bg-primary"></div>
              <span>{{ t('quest.submitted') }}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <div class="h-2 w-2 rounded-full bg-green-400"></div>
              <span>{{ t('quest.pending') }}</span>
            </div>
          </div>

          <div
            v-if="questsStore.keepAliveEndsAt"
            class="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[13px]"
            role="status"
          >
            <Timer class="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{{ t('quest.keep_alive_active', { time: keepAliveRemainingText }) }}</span>
          </div>

          <Button
            variant="destructive"
            class="w-full"
            :disabled="questsStore.stopping"
            @click="handleStop"
          >
            {{ t('home.stop') }}
          </Button>
        </div>

        <div v-if="queuedUpcoming.length > 0" :class="runningSlots.length > 0 && 'mt-3 border-t border-border/50 pt-3'">
          <div class="mb-2 flex items-center justify-between">
            <h4 class="text-sm font-semibold">{{ t('quest.up_next') }} ({{ queuedUpcoming.length }})</h4>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 shrink-0 gap-1.5 px-2 text-xs text-error hover:bg-destructive/10 hover:text-error"
              @click="questsStore.clearQueue"
            >
              {{ t('general.clear') }}
            </Button>
          </div>

          <div class="max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
            <div
              v-for="(quest, index) in queuedUpcoming"
              :key="quest.id"
              class="flex items-center gap-2.5 rounded-lg border border-border/50 bg-background/60 px-2.5 py-2"
            >
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-secondary text-[10px] font-medium tabular-nums text-muted-foreground">
                {{ index + 1 }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="truncate text-[13px] font-medium leading-tight">{{ quest.config.messages.quest_name }}</div>
                <div class="truncate text-[11px] text-muted-foreground">{{ quest.config.messages.game_title }}</div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="questsStore.error" class="mt-4 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-error">
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
          <span class="break-words">{{ questsStore.error }}</span>
        </div>
      </CardContent>
    </Card>
    </Transition>
  </div>
</template>

<style scoped>
/* A quest slot appearing or finishing should ease in rather than snap the
   panel's height. */
.slot-row-enter-active,
.slot-row-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.slot-row-move {
  transition: transform 0.2s ease;
}
.slot-row-enter-from,
.slot-row-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.float-panel-enter-active {
  transition:
    opacity 160ms ease-out,
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.float-panel-leave-active {
  transition:
    opacity 110ms ease-in,
    transform 110ms ease-in;
}
.float-panel-enter-from,
.float-panel-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
  .slot-row-enter-active,
  .slot-row-leave-active,
  .slot-row-move,
  .float-panel-enter-active,
  .float-panel-leave-active {
    transition: none;
  }
  .slot-row-enter-from,
  .slot-row-leave-to,
  .float-panel-enter-from,
  .float-panel-leave-to {
    transform: none;
  }
}
</style>
