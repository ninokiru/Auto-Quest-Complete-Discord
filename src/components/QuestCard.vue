<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Quest } from '@/api/tauri'
import { getQuestRewardCode, type QuestRewardCode } from '@/api/tauri'
import { useQuestsStore } from '@/stores/quests'
import { useAuthStore } from '@/stores/auth'
import QuestDeveloperDetails from '@/components/QuestDeveloperDetails.vue'
import TokenIcon from '@/components/icons/TokenIcon.vue'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Activity, Check, Clock, Cloud, Copy, Gamepad2, Gift, KeyRound, Loader2, MonitorPlay } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import {
  getQuestKind,
  getQuestTasks,
  isPlayActivityTask,
  questProgressPercent,
  questProgressTask,
} from '@/utils/questTasks'
import {
  formatRequiredTarget,
  formatSlotProgress,
  submittedCheckpointCount,
  type ProgressUnit,
} from '@/utils/questProgressDisplay'
import { getQuestRewardViews, type QuestRewardView } from '@/utils/questRewards'
import { formatDateTime } from '@/utils/relativeTime'

const { t, locale } = useI18n()

const props = defineProps<{
  quest: Quest
  questType?: 'video' | 'stream' | 'activity'
  showDeveloperDetails?: boolean
  busy?: boolean
  /**
   * True when the card shows a quest that belongs to another account. Slots are
   * matched by quest id alone, and two accounts can each run the same quest, so a
   * foreign card must not read this account's slot for its progress, unit or
   * target — its own `user_status` is the only truth it has.
   */
  foreign?: boolean
  /** The account that owns this quest, when it is not the signed-in one. */
  accountId?: string
}>()

const questsStore = useQuestsStore()
const authStore = useAuthStore()

const cloudGameActivityTask = computed(() =>
  props.questType === 'activity'
    ? getQuestTasks(props.quest).find(isPlayActivityTask) ?? null
    : null
)
const isCloudGameActivity = computed(() => cloudGameActivityTask.value !== null)

const questTypeLabel = computed(() => {
  if (props.questType === 'video') return t('filter.video')
  if (props.questType === 'activity') {
    return t(isCloudGameActivity.value ? 'filter.activity_cloud_game' : 'filter.activity')
  }
  return t('filter.stream_play')
})

// This quest's own parallel slot, or null when it is not running. Cards must read
// their progress from their own slot: with several quests running, the store's
// primary-quest getters belong to a different quest.
const runningSlot = computed(
  () => props.foreign
    ? null
    : questsStore.runningQuests.find(slot => slot.questId === props.quest.id) ?? null
)
const isActiveQuest = computed(() => runningSlot.value !== null)

// Only a running slot knows its own unit, and it only governs numbers read from
// that slot: an idle card, or a slot whose target has not landed yet, falls back to
// the second-based estimates above.
const runningProgressUnit = computed<ProgressUnit>(() => {
  const slot = runningSlot.value
  return slot && slot.targetDuration > 0 ? slot.progressUnit : 'time'
})

// The task this quest's progress is measured on: the one the app drives. A
// quest can list several tasks, and each one counts in its own unit, so the
// card and the running slot have to agree on which task they read.
const progressTask = computed(() => questProgressTask(props.quest))

// The checkpoint task of the quest the app drives, whose target is a count of
// checkpoints rather than a duration. A quest that lists a checkpoint Activity
// beside a play task runs the game instead, and the game counts in seconds:
// showing that quest's squares would mix the two units.
const checkpointTask = computed(() => {
  const task = progressTask.value
  return task && task.type === 'ACHIEVEMENT_IN_ACTIVITY' ? task : null
})

const targetDuration = computed(() => {
  // For active quests, use the store's target duration (includes calculated checkpoint times)
  if (runningSlot.value && runningSlot.value.targetDuration > 0) {
    return runningSlot.value.targetDuration
  }
  if (cloudGameActivityTask.value) {
    return cloudGameActivityTask.value.target ?? 0
  }
  // For activity quests that haven't started, estimate based on checkpoint settings
  const questKind = getQuestKind(props.quest)
  if (questKind === 'activity') {
    const checkpointCount = checkpointTask.value?.target || 3
    const avgCheckpoint = (questsStore.activityCheckpointMin + questsStore.activityCheckpointMax) / 2
    return Math.round(checkpointCount * avgCheckpoint)
  }
  return progressTask.value?.target || 0
})

const progress = computed(() => {
  if (props.quest.user_status?.completed_at) return 100

  // If this quest is active, use real-time progress from its own slot (0-100)
  if (runningSlot.value) {
    return Math.min(100, runningSlot.value.serverProgress)
  }

  // A quest that is not running keeps the value it has banked. Every task is
  // measured against its own target, so the number belongs to this quest
  // instead of to another task of the same game.
  return questProgressPercent(props.quest)
})

// Status detection
const isNotAccepted = computed(() => !props.quest.user_status?.enrolled_at)
const isCompleted = computed(() => !!props.quest.user_status?.completed_at)
const isPendingClaim = computed(() => isCompleted.value && !props.quest.user_status?.claimed_at)
const isClaimed = computed(() => isCompleted.value && !!props.quest.user_status?.claimed_at)

const statusLabel = computed(() => {
  if (isNotAccepted.value) return t('filter.not_accepted')
  if (isPendingClaim.value) return t('filter.pending_claim')
  if (isClaimed.value) return t('filter.claimed')
  return t('filter.in_progress')
})

// The state reads on a dot and a word, not on a filled pill: a list of pills is
// what makes a quest list look like every other quest list.
const statusTextClass = computed(() => {
  if (isNotAccepted.value) return 'text-muted-foreground'
  if (isPendingClaim.value) return 'text-amber-700 dark:text-amber-400'
  if (isClaimed.value) return 'text-green-700 dark:text-green-400'
  return 'text-primary'
})

const statusDotClass = computed(() => {
  if (isNotAccepted.value) return 'bg-muted-foreground/40'
  if (isPendingClaim.value) return 'bg-amber-500'
  if (isClaimed.value) return 'bg-green-600 dark:bg-green-500'
  return 'bg-primary'
})

// The rail on the left edge carries the state, so the row can be scanned down
// the column instead of reading every badge.
const railClass = computed(() => {
  if (isActiveQuest.value) return 'bg-primary'
  if (isPendingClaim.value) return 'bg-amber-500'
  if (isClaimed.value) return 'bg-green-600 dark:bg-green-500'
  if (isNotAccepted.value) return 'bg-border'
  return 'bg-sky-500 dark:bg-sky-400'
})

const typeIcon = computed(() => {
  if (props.questType === 'video') return MonitorPlay
  if (isCloudGameActivity.value) return Cloud
  if (props.questType === 'activity') return Activity
  return Gamepad2
})

const typeIconClass = computed(() => {
  if (props.questType === 'video') return 'text-sky-600 dark:text-sky-400'
  if (isCloudGameActivity.value) return 'text-violet-600 dark:text-violet-400'
  if (props.questType === 'activity') return 'text-amber-600 dark:text-amber-400'
  return 'text-indigo-600 dark:text-indigo-400'
})

const rewardViews = computed(() => getQuestRewardViews(props.quest, authStore.user?.premium_type, locale.value))
const compactRewardViews = computed(() => rewardViews.value.slice(0, 3))

// Reward wording lives in the locale files: the reward module only says which key
// and which values to interpolate, so nothing here can leak English into the card.
function rewardName(reward: QuestRewardView): string {
  return reward.name || t('filter.reward')
}

function rewardAmount(reward: QuestRewardView): string {
  const { amount } = reward
  if (amount.type === 'name') return rewardName(reward)
  if (amount.type === 'quantity') {
    return t('quest.reward_quantity', { name: rewardName(reward), quantity: String(amount.quantity) })
  }
  return t(amount.text.key, amount.text.params ?? {})
}

const rewardSummary = computed(() => {
  if (rewardViews.value.length === 0) return t('filter.reward')
  return rewardViews.value.map(reward => rewardAmount(reward)).join(' + ')
})

function formatDate(dateStr: string): string {
  if (!dateStr) return t('quest.na')
  return formatDateTime(dateStr, locale.value, false) || t('quest.na')
}

function formatExpirySummary(dateStr: string | null | undefined): string {
  if (!dateStr) return t('quest.no_expiry')

  const expires = new Date(dateStr)
  const now = new Date()
  const diff = expires.getTime() - now.getTime()
  if (diff < 0) return t('quest.expired')

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

  if (days > 0) return t('quest.time_left_days', { date: formatDate(dateStr), days, hours })
  return t('quest.time_left_hours', { date: formatDate(dateStr), hours })
}

/**
 * A checkpoint quest counts in checkpoints, so its progress reads as filled
 * squares: one square is one checkpoint, and an empty square is one still to
 * submit. A bar would hide how many are left.
 */
const checkpointSteps = computed(() => {
  const slot = runningSlot.value
  if (slot && slot.progressUnit === 'checkpoints' && slot.targetDuration > 0) {
    return {
      total: slot.targetDuration,
      done: submittedCheckpointCount(slot.serverProgress, slot.targetDuration),
    }
  }
  const task = checkpointTask.value
  if (!task?.target) return null
  const total = Math.floor(task.target)
  if (total <= 0) return null
  const done = Math.min(total, Math.max(0, Math.round((progress.value / 100) * total)))
  return { total, done }
})

// The task and its target, as one line under the title.
const taskMetaText = computed(() => {
  const task = progressTask.value
  if (!task) return ''
  return task.targetText ? `${task.label} · ${task.targetText}` : task.label
})

const gameTitleText = computed(() => props.quest.config.messages.game_title ?? '')

const activeLocalPercent = computed(() => {
  if (runningSlot.value) return Math.min(100, runningSlot.value.localProgress)
  return 0
})

// Single-gradient progress bar style: true blue→green color blend, no transparency tricks.
// The bar's own width transition already eases every step, so the submitted
// value feeds it directly instead of driving a second per-card animation frame.
const progressBarStyle = computed(() => {
  const local = activeLocalPercent.value
  const submitted = progress.value
  if (local <= 0) return {}
  // Compute gradient stops as % within the bar's own width
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
})

// A quest that is not running shows the value it has banked: a flat bar in the
// theme's blue, with no shadow to keep the resting list quiet.
const idleBarStyle = computed(() => ({
  width: `${progress.value}%`,
  background: 'hsl(var(--primary) / 0.85)',
}))

const activeProgressText = computed(() => {
  if (!isActiveQuest.value) return ''
  // Confirmed progress drives the text, same as the submitted (blue) bar.
  return formatSlotProgress(
    runningSlot.value?.serverProgress ?? 0,
    targetDuration.value,
    runningProgressUnit.value
  )
})

// The text next to the bar: the running slot's own clock, or the checkpoint count
// of a quest that waits for its next submission.
const progressText = computed(() => {
  if (isActiveQuest.value) return activeProgressText.value
  const steps = checkpointSteps.value
  if (steps) return formatSlotProgress(progress.value, steps.total, 'checkpoints')
  return ''
})

const requiredTargetText = computed(() =>
  formatRequiredTarget(targetDuration.value, runningProgressUnit.value)
)

// A claimed quest can carry a redeemable code. It is read on demand: the
// endpoint only answers for a claimed quest, and one request per row of a
// long list would cost more than the code is worth.
const rewardCode = ref<QuestRewardCode | null>(null)
const rewardCodeLoading = ref(false)
const rewardCodeFailed = ref(false)
const rewardCodeCopied = ref(false)

async function loadRewardCode() {
  if (rewardCodeLoading.value) return
  rewardCodeLoading.value = true
  rewardCodeFailed.value = false
  try {
    const response = await getQuestRewardCode(props.quest.id, props.accountId ?? null)
    const code = response?.code?.trim() ?? ''
    if (!code) {
      rewardCodeFailed.value = true
      return
    }
    rewardCode.value = { ...response, code }
  } catch (error) {
    console.warn('Failed to read the quest reward code:', error)
    rewardCodeFailed.value = true
  } finally {
    rewardCodeLoading.value = false
  }
}

async function copyRewardCode() {
  const code = rewardCode.value?.code
  if (!code) return
  try {
    await navigator.clipboard.writeText(code)
    rewardCodeCopied.value = true
    setTimeout(() => { rewardCodeCopied.value = false }, 2000)
  } catch (error) {
    console.error('Failed to copy the quest reward code:', error)
  }
}
</script>

<template>
  <Card
    :aria-busy="busy || undefined"
    class="group relative flex h-full flex-col overflow-hidden rounded-xl border-border/60 transition-[border-color,box-shadow] duration-200 hover:border-primary/30 hover:shadow-[0_10px_24px_-20px_hsl(var(--foreground)/0.65)]"
    :class="(busy || isActiveQuest) && 'border-primary/45'"
  >
    <!-- The state rail: one glance down the column tells which rows are live. -->
    <span class="pointer-events-none absolute inset-y-0 left-0 w-[3px]" :class="railClass" aria-hidden="true" />

    <!-- items-start keeps the icon block at its own height: a stretched block
         would push the type chip down to the bottom of a tall title. -->
    <div class="flex flex-1 items-start gap-3 px-4 pb-3 pt-3.5">
      <div class="relative shrink-0">
        <img
          v-if="quest.config.application?.icon"
          :src="`https://cdn.discordapp.com/app-icons/${quest.config.application.id}/${quest.config.application.icon}.png?size=64`"
          :alt="quest.config.application?.name"
          class="h-10 w-10 rounded-xl object-cover shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.45)]"
        />
        <div
          v-else
          class="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary"
        >
          <component :is="typeIcon" class="h-5 w-5 text-muted-foreground" />
        </div>
        <span
          class="absolute -bottom-1.5 -right-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-md border bg-card shadow-sm"
          :class="typeIconClass"
          :title="questTypeLabel"
        >
          <component :is="typeIcon" class="h-[11px] w-[11px]" />
        </span>
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold leading-tight">
              {{ quest.config.messages.quest_name }}
            </p>
            <p class="mt-0.5 truncate text-xs text-muted-foreground">
              <span v-if="gameTitleText">{{ gameTitleText }}</span>
              <span v-if="gameTitleText && taskMetaText"> · </span>
              <span>{{ taskMetaText }}</span>
            </p>
          </div>
          <span class="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] font-medium" :class="statusTextClass">
            <span class="h-1.5 w-1.5 rounded-full" :class="statusDotClass" aria-hidden="true" />
            {{ statusLabel }}
          </span>
        </div>

        <div class="mt-2.5 flex items-center gap-2">
          <!-- Checkpoint quests count steps, so they read as squares. -->
          <div v-if="checkpointSteps" class="flex items-center gap-1">
            <span
              v-for="step in checkpointSteps.total"
              :key="step"
              class="h-2.5 w-5 rounded-[3px] border transition-colors duration-300"
              :class="step <= checkpointSteps.done ? 'border-primary/40 bg-primary' : 'border-border bg-secondary'"
            />
          </div>
          <div v-else class="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              v-if="isActiveQuest"
              class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
              :style="progressBarStyle"
            />
            <div
              v-else
              class="absolute inset-y-0 left-0 rounded-full bg-primary/70 transition-[width] duration-300"
              :style="idleBarStyle"
            />
          </div>
          <span class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {{ Math.round(progress) }}%
          </span>
          <span
            v-if="progressText"
            class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/80"
          >
            {{ progressText }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-4 py-2">
      <div class="flex min-w-0 items-center gap-2">
        <div v-if="compactRewardViews.length > 0" class="flex shrink-0 -space-x-1">
          <div
            v-for="reward in compactRewardViews"
            :key="`${reward.skuId}-${reward.type}-${reward.name}`"
            class="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md border bg-card"
          >
            <video
              v-if="reward.asset && reward.asset.endsWith('.mp4')"
              :src="`https://cdn.discordapp.com/${reward.asset}`"
              class="h-full w-full object-contain"
              autoplay
              loop
              muted
              playsinline
            />
            <img
              v-else-if="reward.asset"
              :src="`https://cdn.discordapp.com/${reward.asset}`"
              :alt="rewardName(reward)"
              class="h-full w-full object-contain"
            />
            <TokenIcon
              v-else-if="reward.icon === 'orbs'"
              class="h-5 w-5 text-primary"
            />
            <Gift v-else class="h-4 w-4 text-pink-400" />
          </div>
        </div>
        <span class="min-w-0 truncate text-[11px] text-muted-foreground">{{ rewardSummary }}</span>
        <span class="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground/80 sm:flex">
          <Clock class="h-3 w-3" />
          {{ formatExpirySummary(quest.config.expires_at) }}
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <span
          v-if="isActiveQuest && requiredTargetText"
          class="hidden text-[11px] text-muted-foreground/80 lg:inline"
        >
          {{ t('quest.required', { duration: requiredTargetText }) }}
        </span>
        <slot name="actions"></slot>
      </div>
    </div>

    <!-- A claimed quest can carry a redeemable code. The code is read on
         demand, so a list of quests never spends a request per row. -->
    <div v-if="isClaimed" class="border-t border-border/40 px-4 py-2">
      <button
        v-if="!rewardCode"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        :disabled="rewardCodeLoading"
        @click="loadRewardCode"
      >
        <Loader2 v-if="rewardCodeLoading" class="h-3 w-3 animate-spin" />
        <KeyRound v-else class="h-3 w-3" />
        {{ rewardCodeFailed ? t('quest.reward_code_retry') : t('quest.reward_code_show') }}
      </button>
      <div v-else class="flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded-md bg-secondary px-2 py-1 font-mono text-[11px] text-foreground">{{ rewardCode.code }}</code>
        <Button
          variant="ghost"
          size="sm"
          class="h-7 shrink-0 px-2 text-[11px]"
          @click="copyRewardCode"
        >
          <Check v-if="rewardCodeCopied" class="h-3 w-3" />
          <Copy v-else class="h-3 w-3" />
          {{ rewardCodeCopied ? t('quest.reward_code_copied') : t('quest.reward_code_copy') }}
        </Button>
      </div>
      <p v-if="rewardCodeFailed" class="mt-1 text-[11px] text-error">
        {{ t('quest.reward_code_failed') }}
      </p>
    </div>

    <QuestDeveloperDetails v-if="showDeveloperDetails" class="mx-4 mb-3.5" :quest="quest" />
  </Card>
</template>
