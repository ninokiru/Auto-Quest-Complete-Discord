<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, MonitorPlay } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useQuestsStore } from '@/stores/quests'
import type { AccountQuestTask } from '@/stores/quests'
import type { AccountSummary, DiscordUser } from '@/api/tauri'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const { t } = useI18n()
const authStore = useAuthStore()
const questsStore = useQuestsStore()

/** One quest line: the task its Stop button cancels, and the name to show. */
interface BackgroundRow {
  key: string
  task: AccountQuestTask
  questName: string
}

/** One account's quests, listed under a single avatar line. */
interface BackgroundGroup {
  key: string
  accountName: string
  accountHandle: string
  accountFallback: string
  avatarSrc: string
  rows: BackgroundRow[]
}

// Grouped by first-seen account so one account's quests read as one block instead
// of repeating its avatar. The store replaces the whole list on every tick, so the
// group order is the registry's.
const backgroundTasks = computed(() => questsStore.accountTasks.filter(task => !listedInGroups(task)))

/** A quest the other accounts' panel already lists has its Stop button there, so
 *  this panel keeps only what that one cannot show: a forgotten account, an
 *  account whose list read failed, or a quest that left its list. */
function listedInGroups(task: AccountQuestTask): boolean {
  if (!task.accountId) return false
  return questsStore.foreignQuestGroups.some(
    group =>
      group.account.user.id === task.accountId &&
      group.quests.some(quest => quest.id === task.questId),
  )
}

const groups = computed<BackgroundGroup[]>(() => {
  const byAccount = new Map<string, BackgroundGroup>()
  for (const task of backgroundTasks.value) {
    const key = task.accountId ?? ''
    let group = byAccount.get(key)
    if (!group) {
      const account = accountOf(task.accountId)
      group = {
        key,
        accountName: account?.user.global_name || account?.user.username || '',
        accountHandle: account ? `@${account.user.username}` : '',
        accountFallback: account ? account.user.username.charAt(0).toUpperCase() : '',
        avatarSrc: account ? avatarSrcOf(account.user) : '',
        rows: [],
      }
      byAccount.set(key, group)
    }
    group.rows.push({
      key: `${key}|${task.questId}`,
      task,
      // A background task normally runs a quest this account also sees.
      questName: questsStore.quests.find(quest => quest.id === task.questId)
        ?.config?.messages?.quest_name ?? task.questId,
    })
  }
  return [...byAccount.values()]
})

/** Null for an unknown or forgotten account (`accountId` itself can be null). */
function accountOf(accountId: string | null): AccountSummary | null {
  if (!accountId) return null
  return authStore.knownAccounts.find(account => account.user.id === accountId) ?? null
}

// Empty means "no avatar hash", so no image request is made for it.
function avatarSrcOf(user: DiscordUser): string {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : ''
}

const stoppingKeys = ref(new Set<string>())
const stopErrors = ref(new Map<string, string>())

function isStopping(row: BackgroundRow): boolean {
  return stoppingKeys.value.has(row.key)
}

function stopErrorOf(row: BackgroundRow): string {
  return stopErrors.value.get(row.key) ?? ''
}

// A refused stop is kept on its own row, since the quest stays listed and retryable.
async function handleStop(row: BackgroundRow): Promise<void> {
  const key = row.key
  if (stoppingKeys.value.has(key)) return
  stoppingKeys.value.add(key)
  stopErrors.value.delete(key)
  try {
    await questsStore.stopAccountQuest(row.task)
  } catch (cause) {
    stopErrors.value.set(key, cause instanceof Error ? cause.message : String(cause))
  } finally {
    stoppingKeys.value.delete(key)
  }
}
</script>

<template>
  <Card v-if="backgroundTasks.length > 0" class="overflow-hidden border-border/60">
    <CardHeader class="flex flex-row items-start gap-2.5 p-4 pb-2">
      <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <MonitorPlay class="h-4 w-4 text-primary" />
      </span>
      <div class="min-w-0 flex-1 space-y-0.5">
        <CardTitle class="flex items-center gap-1.5 text-sm">
          {{ t('quest.background_title') }}
          <span class="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold leading-4 text-primary">
            {{ backgroundTasks.length }}
          </span>
        </CardTitle>
        <p class="text-xs leading-relaxed text-pretty text-muted-foreground">
          {{ t('quest.background_hint') }}
        </p>
      </div>
    </CardHeader>

    <CardContent class="p-0">
      <div v-for="group in groups" :key="group.key" class="border-t border-border/60 py-2">
        <div v-if="group.accountName" class="flex items-center gap-2 px-4 pb-1.5">
          <Avatar class="h-5 w-5 shrink-0">
            <AvatarImage v-if="group.avatarSrc" :src="group.avatarSrc" :alt="group.accountName" />
            <AvatarFallback class="text-[10px] font-semibold">{{ group.accountFallback }}</AvatarFallback>
          </Avatar>
          <p class="min-w-0 flex-1 truncate text-[11px] font-semibold text-muted-foreground">
            {{ `${group.accountName} · ${group.accountHandle}` }}
          </p>
        </div>

        <div v-for="row in group.rows" :key="row.key" class="px-4 py-1">
          <div class="flex items-center gap-3">
            <p class="min-w-0 flex-1 truncate text-xs font-semibold">{{ row.questName }}</p>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 shrink-0 gap-1.5 px-2 text-xs text-error hover:bg-destructive/10 hover:text-error"
              :disabled="isStopping(row)"
              @click="handleStop(row)"
            >
              <Loader2 v-if="isStopping(row)" class="h-3.5 w-3.5 animate-spin" />
              {{ t('quest.stop_single') }}
            </Button>
          </div>

          <p v-if="stopErrorOf(row)" class="mt-1 break-words text-[10px] leading-relaxed text-error">
            {{ stopErrorOf(row) }}
          </p>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
