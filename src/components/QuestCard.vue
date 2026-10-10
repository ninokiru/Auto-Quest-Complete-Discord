<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import type { Quest } from '@/api/tauri'
import { useQuestsStore } from '@/stores/quests'
import { useAuthStore } from '@/stores/auth'
import QuestDeveloperDetails from '@/components/QuestDeveloperDetails.vue'
import QuestTaskBadges from '@/components/QuestTaskBadges.vue'
import TokenIcon from '@/components/icons/TokenIcon.vue'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Clock, Gift, MonitorPlay, Gamepad2, Activity, Cloud } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import {
  firstProgressValue,
  firstTargetTask,
  getQuestKind,
  getQuestTasks,
  isPlayActivityTask,
} from '@/utils/questTasks'
import {
  clampPercent,
  formatRequiredTarget,
  formatSlotProgress,
  type ProgressUnit,
} from '@/utils/questProgressDisplay'
import { getQuestRewardViews, type QuestRewardView } from '@/utils/questRewards'

const { t } = useI18n()

const props = defineProps<{
  quest: Quest
  questType?: 'video' | 'stream' | 'activity'
  showDeveloperDetails?: boolean
  density?: 'compact' | 'comfortable'
  busy?: boolean
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
  () => questsStore.runningQuests.find(slot => slot.questId === props.quest.id) ?? null
)
const isActiveQuest = computed(() => runningSlot.value !== null)

// Only a running slot knows its own unit, and it only governs numbers read from
// that slot: an idle card, or a slot whose target has not landed yet, falls back to
// the second-based estimates above.
const runningProgressUnit = computed<ProgressUnit>(() => {
  const slot = runningSlot.value
  return slot && slot.targetDuration > 0 ? slot.progressUnit : 'time'
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
    const task = firstTargetTask(props.quest)
    const checkpointCount = task?.target || 3
    const avgCheckpoint = (questsStore.activityCheckpointMin + questsStore.activityCheckpointMax) / 2
    return Math.round(checkpointCount * avgCheckpoint)
  }
  return firstTargetTask(props.quest)?.target || 0
})

const progress = computed(() => {
  if (props.quest.user_status?.completed_at) return 100

  // If this quest is active, use real-time progress from its own slot (0-100)
  if (runningSlot.value) {
    return Math.min(100, runningSlot.value.serverProgress)
  }

  const targetTask = firstTargetTask(props.quest)
  const target = targetTask?.target || targetDuration.value
  if (target > 0) {
    return clampPercent((firstProgressValue(props.quest, targetTask?.key) / target) * 100)
  }
  return 0
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

const statusClass = computed(() => {
  if (isNotAccepted.value) return 'border-gray-400/60 bg-gray-500/10 text-gray-600 dark:text-gray-400'
  if (isPendingClaim.value) return 'border-orange-400/60 bg-orange-500/10 text-orange-600 dark:text-orange-400'
  if (isClaimed.value) return 'border-green-500/30 bg-green-500/15 text-green-600 dark:text-green-400'
  return 'border-sky-400/60 bg-sky-500/10 text-sky-600 dark:text-sky-400' // In Progress
})

const rewardViews = computed(() => getQuestRewardViews(props.quest, authStore.user?.premium_type))
const inGameRewards = computed(() => rewardViews.value.filter(reward => reward.kind === 'ingame' && reward.asset))
const discordRewards = computed(() => rewardViews.value.filter(reward => reward.kind !== 'ingame' || !reward.asset))
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

function rewardBadge(reward: QuestRewardView): string | null {
  const badge = reward.badge
  return badge ? t(badge.key, badge.params ?? {}) : null
}

const rewardSummary = computed(() => {
  if (rewardViews.value.length === 0) return t('filter.reward')
  return rewardViews.value.map(reward => rewardAmount(reward)).join(' + ')
})

function formatDate(dateStr: string): string {
  if (!dateStr) return 'N/A'
  const date = new Date(dateStr)
  return date.toLocaleDateString()
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

function rewardKey(reward: QuestRewardView): string {
  return `${reward.skuId}-${reward.type}-${reward.name}`
}

const activeLocalPercent = computed(() => {
  if (runningSlot.value) return Math.min(100, runningSlot.value.localProgress)
  return 0
})

// Animate the submitted (blue) progress value so it eases forward instead of jumping
const animatedSubmitted = ref(progress.value)
let _raf: number | null = null
watch(progress, (next) => {
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

// Single-gradient progress bar style: true blue→green color blend, no transparency tricks
const progressBarStyle = computed(() => {
  const local = activeLocalPercent.value
  const submitted = animatedSubmitted.value
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
      ? '0 0 4px 1px hsl(var(--primary) / 0.6), 0 0 8px 2px hsl(var(--primary) / 0.25), 2px 0 6px 1px rgb(74 222 128 / 0.35)'
      : '0 0 4px 1px hsl(var(--primary) / 0.6), 0 0 8px 2px hsl(var(--primary) / 0.25)',
  }
})

const activeProgressText = computed(() => {
  if (!isActiveQuest.value) return ''
  // Confirmed progress drives the text, same as the submitted (blue) bar.
  return formatSlotProgress(
    runningSlot.value?.serverProgress ?? 0,
    targetDuration.value,
    runningProgressUnit.value
  )
})

const requiredTargetText = computed(() =>
  formatRequiredTarget(targetDuration.value, runningProgressUnit.value)
)
</script>

<template>
  <Card
    :aria-busy="busy || undefined"
    :class="[
      'overflow-hidden border-border/50 transition-all hover:shadow-md',
      density === 'compact' && 'hover:shadow-sm',
      (busy || isActiveQuest) && 'border-primary/50',
    ]"
  >
    <!-- Quest Banner/Hero Image -->
    <div
      v-if="quest.config.assets?.hero"
      :class="density === 'compact' ? 'relative h-12 bg-cover bg-center sm:h-16' : 'relative h-24 bg-cover bg-center'"
      :style="{ backgroundImage: `url(https://cdn.discordapp.com/${quest.config.assets.hero})` }"
    >
      <div class="absolute inset-0 bg-gradient-to-t from-card to-transparent" />
    </div>
    
    <CardHeader :class="density === 'compact' ? 'pb-1.5' : 'pb-3'">
      <div class="flex justify-between items-start gap-4">
        <div class="flex gap-3 items-start">
          <!-- Application Icon -->
          <img 
            v-if="quest.config.application?.icon"
            :src="`https://cdn.discordapp.com/app-icons/${quest.config.application.id}/${quest.config.application.icon}.png?size=64`"
            :alt="quest.config.application?.name"
            :class="density === 'compact' ? 'w-9 h-9 rounded-md flex-shrink-0' : 'w-12 h-12 rounded-lg flex-shrink-0'"
          />
          <div class="min-w-0 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                :class="[
                  density === 'compact' ? 'mb-0.5' : 'mb-1',
                  questType === 'video' && 'border-sky-400/60 bg-sky-500/10 text-sky-600 dark:text-sky-400',
                  questType === 'stream' && 'border-violet-400/60 bg-violet-500/10 text-violet-600 dark:text-violet-400',
                  questType === 'activity' && !isCloudGameActivity && 'border-amber-400/60 bg-amber-500/10 text-amber-600 dark:text-amber-400',
                  isCloudGameActivity && 'border-violet-400/60 bg-violet-500/10 text-violet-600 dark:text-violet-400',
                ]"
              >
                 <MonitorPlay v-if="questType === 'video'" class="w-3 h-3 mr-1" />
                 <Gamepad2 v-else-if="questType === 'stream'" class="w-3 h-3 mr-1" />
                 <Cloud v-else-if="isCloudGameActivity" class="w-3 h-3 mr-1" />
                 <Activity v-else class="w-3 h-3 mr-1" />
                 {{ questTypeLabel }}
              </Badge>
            </div>
            <CardTitle :class="density === 'compact' ? 'truncate text-base text-primary sm:text-lg' : 'text-xl text-primary'">
              <template v-if="density === 'compact'">
                {{ quest.config.messages.quest_name }}
                <span v-if="quest.config.messages.game_title" class="font-normal text-muted-foreground">
                  · {{ quest.config.messages.game_title }}
                </span>
              </template>
              <template v-else>
                {{ quest.config.messages.quest_name }}
              </template>
            </CardTitle>
            <CardDescription v-if="density !== 'compact'" class="truncate">{{ quest.config.messages.game_title }}</CardDescription>
            <QuestTaskBadges v-if="density !== 'compact'" :quest="quest" />
          </div>
        </div>
        <Transition name="quest-status" mode="out-in">
          <Badge :key="statusLabel" variant="outline" :class="['whitespace-nowrap', statusClass]">
            {{ statusLabel }}
          </Badge>
        </Transition>
      </div>
    </CardHeader>
    
    <CardContent :class="density === 'compact' ? 'grid gap-2' : 'grid gap-4'">
      <div v-if="density === 'compact'" class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 items-center gap-2">
          <div v-if="compactRewardViews.length > 0" class="flex shrink-0 -space-x-1">
            <div
              v-for="reward in compactRewardViews"
              :key="rewardKey(reward)"
              class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-md border bg-muted"
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
                class="h-7 w-7 text-primary"
              />
              <Gift v-else class="h-5 w-5 text-pink-400" />
            </div>
          </div>
          <span class="min-w-0 truncate text-xs text-muted-foreground">
            {{ rewardSummary }}
          </span>
        </div>
        <span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Clock class="h-3 w-3" />
          {{ formatExpirySummary(quest.config.expires_at) }}
        </span>
      </div>

      <div class="space-y-2">
        <div class="flex justify-between text-sm">
          <span class="text-muted-foreground">
            {{ t('quest.progress') }}: {{ Math.round(progress) }}%
            <span v-if="isActiveQuest" class="ml-2 font-mono text-xs text-muted-foreground/80">
               ({{ activeProgressText }})
            </span>
          </span>
          <span v-if="targetDuration" class="text-muted-foreground">{{ t('quest.required', { duration: requiredTargetText }) }}</span>
        </div>
        
        <!-- Progress Bar for Active Quest: single gradient div, blue→green -->
        <div v-if="isActiveQuest" class="relative h-1.5 w-full rounded-full bg-secondary">
          <div
            class="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
            :style="progressBarStyle"
          ></div>
        </div>
        
        <!-- Standard Progress Bar for others (with glow) -->
        <div v-else class="relative h-1.5 w-full rounded-full bg-secondary">
          <div
            class="absolute inset-y-0 left-0 rounded-full bg-primary transition-all duration-300"
            :style="{
              width: `${progress}%`,
          boxShadow: progress > 0 ? '0 0 4px 1px hsl(var(--primary) / 0.6), 0 0 8px 2px hsl(var(--primary) / 0.25)' : 'none'
            }"
          />
        </div>
      </div>
      
      <!-- In-Game Rewards (with images) -->
      <div v-if="density !== 'compact' && inGameRewards.length > 0" class="space-y-2">
        <p class="text-xs text-muted-foreground font-medium">{{ t('quest.in_game_rewards') }}</p>
        <div 
          v-for="reward in inGameRewards" 
          :key="rewardKey(reward)"
          class="flex items-center gap-3 p-3 rounded-lg bg-gradient-to-r from-muted/40 to-muted/20 border border-border/50"
        >
          <!-- Video asset (.mp4) -->
          <video 
            v-if="reward.asset?.endsWith('.mp4')"
            :src="`https://cdn.discordapp.com/${reward.asset}`"
            class="w-14 h-14 object-contain rounded-md flex-shrink-0"
            autoplay
            loop
            muted
            playsinline
          />
          <!-- Image asset -->
          <img 
            v-else
            :src="`https://cdn.discordapp.com/${reward.asset}`"
            :alt="rewardName(reward)"
            class="w-14 h-14 object-contain rounded-md flex-shrink-0"
          />
          <span class="text-sm font-medium">{{ rewardAmount(reward) }}</span>
        </div>
      </div>
      
      <!-- Discord Rewards (decorations, orbs etc) -->
      <div v-if="density !== 'compact' && discordRewards.length > 0" class="space-y-2">
        <p class="text-xs text-muted-foreground font-medium">{{ t('quest.discord_rewards') }}</p>
        <div 
          v-for="reward in discordRewards" 
          :key="rewardKey(reward)"
          class="flex items-center gap-3 p-3 rounded-lg bg-gradient-to-r from-muted/40 to-muted/20 border border-border/50"
        >
          <!-- Video asset (Avatar Decoration .mp4) -->
          <video 
            v-if="reward.asset && reward.asset.endsWith('.mp4')"
            :src="`https://cdn.discordapp.com/${reward.asset}`"
            class="w-14 h-14 object-contain rounded-md flex-shrink-0"
            autoplay
            loop
            muted
            playsinline
          />
          <!-- Image asset -->
          <img 
            v-else-if="reward.asset"
            :src="`https://cdn.discordapp.com/${reward.asset}`"
            :alt="rewardName(reward)"
            class="w-14 h-14 object-contain rounded-md flex-shrink-0"
          />
          <!-- Orbs reward -->
          <TokenIcon
            v-else-if="reward.icon === 'orbs'"
            class="h-14 w-14 shrink-0 text-primary"
          />
          <!-- Fallback icon -->
          <Gift v-else class="w-10 h-10 text-pink-400 flex-shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium">{{ rewardAmount(reward) }}</span>
              <Badge v-if="reward.badge" variant="secondary" class="text-[10px]">
                {{ rewardBadge(reward) }}
              </Badge>
            </div>
            <div v-if="rewardAmount(reward) !== rewardName(reward)" class="truncate text-xs text-muted-foreground">
              {{ rewardName(reward) }}
            </div>
          </div>
        </div>
      </div>
      
      <div v-if="density !== 'compact'" class="grid grid-cols-2 gap-4 text-xs text-muted-foreground">
        <div class="flex items-center gap-1">
          <Clock class="w-3 h-3" />
          {{ t('quest.expires') }}: {{ quest.config.expires_at ? formatDate(quest.config.expires_at) : t('quest.na') }}
        </div>
         <!-- Target duration handled above -->
      </div>

      <QuestDeveloperDetails v-if="showDeveloperDetails" :quest="quest" />
    </CardContent>

    <CardFooter
      :class="[
        'flex flex-wrap justify-end gap-2',
        density === 'compact' ? 'min-h-[3.25rem] pt-1.5' : 'min-h-[4.5rem] pt-2',
      ]"
    >
      <slot name="actions"></slot>
    </CardFooter>
  </Card>
</template>

<style scoped>
.quest-status-enter-active,
.quest-status-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.quest-status-enter-from,
.quest-status-leave-to {
  opacity: 0;
  transform: translateY(3px);
}
@media (prefers-reduced-motion: reduce) {
  .quest-status-enter-active,
  .quest-status-leave-active {
    transition: none;
  }
  .quest-status-enter-from,
  .quest-status-leave-to {
    transform: none;
  }
}
</style>

