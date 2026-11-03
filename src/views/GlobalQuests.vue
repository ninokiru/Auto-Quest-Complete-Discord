<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useNow } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { open } from '@tauri-apps/plugin-shell'
import { AlertCircle, ExternalLink, Globe2, Loader2, RotateCw, Search, SearchX } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import GlobalQuestTaskBadges from '@/components/GlobalQuestTaskBadges.vue'
import { useGlobalQuestsStore } from '@/stores/globalQuests'
import { useQuestsStore } from '@/stores/quests'
import { navigateDiscordSpa } from '@/api/tauri'
import { cn } from '@/lib/utils'
import {
  filterGlobalQuests,
  formatGlobalQuestCountdown,
  liveGlobalQuests,
  type GlobalQuest,
  type GlobalQuestReward,
  type GlobalRewardKind,
  type GlobalTaskKind,
} from '@/utils/globalQuests'

const { t, locale } = useI18n()
const store = useGlobalQuestsStore()
const questsStore = useQuestsStore()
const { quests, loading, hasLoaded, error } = storeToRefs(store)
const now = useNow({ interval: 30_000 })

const query = ref('')
const selectedTasks = ref<GlobalTaskKind[]>([])
const selectedRewards = ref<GlobalRewardKind[]>([])
const openingId = ref<string | null>(null)

const taskOptions: Array<{ kind: GlobalTaskKind; label: string }> = [
  { kind: 'watch', label: 'global_quests.task_video' },
  { kind: 'play', label: 'global_quests.task_play' },
  { kind: 'activity', label: 'global_quests.task_activity' },
  { kind: 'stream', label: 'global_quests.task_stream' },
]

const rewardOptions: Array<{ kind: GlobalRewardKind; label: string }> = [
  { kind: 'orbs', label: 'global_quests.reward_orbs' },
  { kind: 'nitro', label: 'global_quests.reward_nitro' },
  { kind: 'role', label: 'global_quests.reward_role' },
  { kind: 'item', label: 'global_quests.reward_item' },
]

const chipBase = 'inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const chipOn = 'border-primary bg-primary/10 text-primary hover:bg-primary/15'
const chipOff = 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'

const liveQuests = computed(() => liveGlobalQuests(quests.value, now.value.getTime()))
const visibleQuests = computed(() => filterGlobalQuests(liveQuests.value, {
  query: query.value,
  tasks: selectedTasks.value,
  rewards: selectedRewards.value,
}, now.value.getTime()))

function chipClass(active: boolean): string {
  return cn(chipBase, active ? chipOn : chipOff)
}

function toggleTask(kind: GlobalTaskKind) {
  const index = selectedTasks.value.indexOf(kind)
  if (index === -1) selectedTasks.value.push(kind)
  else selectedTasks.value.splice(index, 1)
}

function toggleReward(kind: GlobalRewardKind) {
  const index = selectedRewards.value.indexOf(kind)
  if (index === -1) selectedRewards.value.push(kind)
  else selectedRewards.value.splice(index, 1)
}

function resetFilters() {
  query.value = ''
  selectedTasks.value = []
  selectedRewards.value = []
}

function rewardLabel(reward: GlobalQuestReward): string {
  if (reward.kind === 'orbs') {
    return reward.quantity === null
      ? t('global_quests.reward_orbs')
      : t('global_quests.orbs_amount', { count: reward.quantity.toLocaleString(locale.value) })
  }
  const name = reward.name || t(`global_quests.reward_${reward.kind}`)
  return reward.quantity === null ? name : t('global_quests.quantity', { name, count: reward.quantity })
}

function rewardLine(quest: GlobalQuest): string {
  return quest.rewards.map(rewardLabel).join(' · ')
}

/** Half the catalogue repeats the game inside the quest name. */
function showGameName(quest: GlobalQuest): boolean {
  return Boolean(quest.gameName)
    && !quest.name.toLocaleLowerCase().includes(quest.gameName.toLocaleLowerCase())
}

function countdown(quest: GlobalQuest): string {
  return formatGlobalQuestCountdown(quest.expiresAt, now.value.getTime())
}

async function openQuest(quest: GlobalQuest) {
  if (openingId.value) return
  openingId.value = quest.id
  try {
    if (questsStore.cdpAvailable) await navigateDiscordSpa(`/quest-home#${quest.id}`, questsStore.cdpPort)
    else await open(`https://discord.com/quests/${quest.id}`)
  } catch (openError) {
    console.error('Could not open the global quest:', openError)
  } finally {
    openingId.value = null
  }
}

onMounted(() => store.initialize())
</script>

<template>
  <div class="fade-in space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <Globe2 class="h-6 w-6 shrink-0 text-primary" :stroke-width="1.7" />
        <h2 class="truncate text-2xl font-bold tracking-tight">{{ t('global_quests.title') }}</h2>
        <Badge v-if="hasLoaded" variant="secondary" class="shrink-0 tabular-nums">
          {{ t('global_quests.count', { count: liveQuests.length }) }}
        </Badge>
      </div>
      <Button variant="outline" size="sm" class="gap-2" :disabled="loading" @click="store.refresh(true)">
        <RotateCw class="h-4 w-4" :class="loading && 'animate-spin'" />
        {{ t('global_quests.refresh') }}
      </Button>
    </div>

    <div class="space-y-3 rounded-xl border border-border/60 bg-card p-3">
      <div class="relative">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          v-model="query"
          class="pl-9"
          :placeholder="t('global_quests.search')"
          :aria-label="t('global_quests.search')"
        />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="min-w-0 space-y-1.5">
          <p class="text-xs font-medium text-muted-foreground">{{ t('global_quests.task_filter') }}</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              type="button"
              :class="chipClass(selectedTasks.length === 0)"
              :aria-pressed="selectedTasks.length === 0"
              @click="selectedTasks = []"
            >
              {{ t('global_quests.all') }}
            </button>
            <button
              v-for="option in taskOptions"
              :key="option.kind"
              type="button"
              :class="chipClass(selectedTasks.includes(option.kind))"
              :aria-pressed="selectedTasks.includes(option.kind)"
              @click="toggleTask(option.kind)"
            >
              {{ t(option.label) }}
            </button>
          </div>
        </div>

        <div class="min-w-0 space-y-1.5">
          <p class="text-xs font-medium text-muted-foreground">{{ t('global_quests.reward_filter') }}</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              type="button"
              :class="chipClass(selectedRewards.length === 0)"
              :aria-pressed="selectedRewards.length === 0"
              @click="selectedRewards = []"
            >
              {{ t('global_quests.all') }}
            </button>
            <button
              v-for="option in rewardOptions"
              :key="option.kind"
              type="button"
              :class="chipClass(selectedRewards.includes(option.kind))"
              :aria-pressed="selectedRewards.includes(option.kind)"
              @click="toggleReward(option.kind)"
            >
              {{ t(option.label) }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <p
      v-if="error && hasLoaded"
      role="alert"
      class="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn"
    >
      {{ t('global_quests.error') }}
    </p>

    <div v-if="loading && !hasLoaded" class="space-y-2" role="status">
      <div
        v-for="row in 4"
        :key="row"
        class="animate-pulse rounded-xl border border-border/60 bg-card p-3 motion-reduce:animate-none"
        :style="{ animationDelay: `${(row - 1) * 120}ms` }"
        aria-hidden="true"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0 flex-1 space-y-2">
            <div class="h-3.5 rounded-full bg-muted" :class="row % 2 === 0 ? 'w-1/2' : 'w-2/3'" />
            <div class="h-2.5 w-1/3 rounded-full bg-muted/70" />
          </div>
          <div class="h-8 w-28 shrink-0 rounded-md bg-muted" />
        </div>
      </div>
      <p class="pt-1 text-center text-xs text-muted-foreground">{{ t('global_quests.loading') }}</p>
    </div>

    <div v-else-if="error && !hasLoaded" class="rounded-xl border border-dashed px-4 py-12 text-center">
      <AlertCircle class="mx-auto h-6 w-6 text-error" />
      <p class="mt-3 text-sm font-medium">{{ t('global_quests.error') }}</p>
      <Button variant="outline" size="sm" class="mt-4" @click="store.refresh(true)">
        {{ t('global_quests.retry') }}
      </Button>
    </div>

    <div v-else-if="liveQuests.length === 0" class="rounded-xl border border-dashed px-4 py-12 text-center">
      <Globe2 class="mx-auto h-6 w-6 text-muted-foreground/60" />
      <p class="mt-3 text-sm font-medium">{{ t('global_quests.no_live') }}</p>
    </div>

    <div v-else-if="visibleQuests.length === 0" class="rounded-xl border border-dashed px-4 py-12 text-center">
      <SearchX class="mx-auto h-6 w-6 text-muted-foreground/60" />
      <p class="mt-3 text-sm font-medium">{{ t('global_quests.empty') }}</p>
      <Button variant="ghost" size="sm" class="mt-3" @click="resetFilters">
        {{ t('general.clear') }}
      </Button>
    </div>

    <ul v-else class="max-h-[70vh] space-y-2 overflow-y-auto pr-1" :aria-label="t('global_quests.title')">
      <li
        v-for="quest in visibleQuests"
        :key="quest.id"
        class="rounded-xl border border-border/60 bg-card p-3"
      >
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1 space-y-1.5">
            <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h3 class="min-w-0 truncate text-sm font-semibold" :title="quest.name">{{ quest.name }}</h3>
              <span v-if="showGameName(quest)" class="min-w-0 truncate text-xs text-muted-foreground">
                {{ quest.gameName }}
              </span>
            </div>
            <GlobalQuestTaskBadges :tasks="quest.tasks" />
            <p v-if="quest.rewards.length" class="text-xs text-muted-foreground">{{ rewardLine(quest) }}</p>
          </div>

          <div class="flex shrink-0 items-center gap-2 self-center">
            <span class="font-mono text-xs tabular-nums text-muted-foreground">{{ countdown(quest) }}</span>
            <Button
              variant="outline"
              size="sm"
              class="gap-1.5"
              :disabled="openingId === quest.id"
              @click="openQuest(quest)"
            >
              <Loader2 v-if="openingId === quest.id" class="h-3.5 w-3.5 animate-spin" />
              <ExternalLink v-else class="h-3.5 w-3.5" />
              {{ t('global_quests.open_discord') }}
            </Button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
