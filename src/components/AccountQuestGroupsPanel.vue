<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Gift, Loader2, RotateCw, Users } from 'lucide-vue-next'
import type { AccountQuestGroup, Quest } from '@/api/tauri'
import type { ForeignQuestBlocker } from '@/utils/questTasks'
import { foreignQuestBlocker, getQuestKind, isGameQuest } from '@/utils/questTasks'
import { useAuthStore } from '@/stores/auth'
import { useQuestsStore } from '@/stores/quests'
import { useToastStore } from '@/stores/toast'
import QuestCard from '@/components/QuestCard.vue'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const { t } = useI18n()
const authStore = useAuthStore()
const questsStore = useQuestsStore()
const toast = useToastStore()

/** Another account's list costs a request per account, so this ticks far slower
 *  than the active account's ten-second poll — enough to see a quest land. */
const REFRESH_MS = 30_000

/** What a row's single button does, in the order the active account's list uses. */
type RowAction = 'accept' | 'stop' | 'claim' | 'start' | 'completed'

interface ForeignRow {
  key: string
  accountId: string
  quest: Quest
  questType: 'video' | 'stream' | 'activity'
  action: RowAction
  /** Why Start is refused, or why the last attempt failed. Empty means neither. */
  note: string
  noteIsError: boolean
  /** A quest this page cannot drive for another account: Start stays put, greyed. */
  blocked: boolean
  busy: boolean
}

interface ForeignGroupView {
  accountId: string
  name: string
  handle: string
  fallback: string
  avatarSrc: string
  readError: string
  rows: ForeignRow[]
  runningCount: number
  canRunAll: boolean
  runAllBusy: boolean
}

const runningByKey = computed(() => {
  const keys = new Set<string>()
  for (const task of questsStore.accountTasks) {
    keys.add(`${task.accountId ?? ''}|${task.questId}`)
  }
  return keys
})

/** Rows the failure notice of one click still belongs to, keyed by row. */
const attemptErrors = ref(new Map<string, string>())
const busyKeys = ref(new Set<string>())

function isRunning(accountId: string, questId: string): boolean {
  return runningByKey.value.has(`${accountId}|${questId}`)
}

function actionOf(quest: Quest, running: boolean): RowAction {
  const status = quest.user_status
  if (!status?.enrolled_at) return 'accept'
  if (running) return 'stop'
  if (status.completed_at) return status.claimed_at ? 'completed' : 'claim'
  return 'start'
}

/** A quest the page cannot drive for another account stays visible with its reason
 *  under the button: a row that simply vanishes reads as a quest that went missing.
 *  A failed click is a different note — it names what the backend said and leaves
 *  the button working, because the reason to retry is usually a changed Discord side. */
function noteOf(
  blocker: ForeignQuestBlocker | null,
  failure: string | undefined,
  gameBusy: boolean
): {
  note: string
  isError: boolean
} {
  if (failure) return { note: failure, isError: true }
  if (blocker === 'manual') return { note: t('quest.foreign_blocked_manual'), isError: false }
  if (blocker === 'no-task') return { note: t('quest.foreign_blocked_no_task'), isError: false }
  if (gameBusy) return { note: t('quest.foreign_blocked_game'), isError: false }
  return { note: '', isError: false }
}

/** Whether this account already runs a game quest. A game quest holds the
 *  account's single game slot, so a second one is refused by the backend. */
function gameSlotBusy(accountId: string, group: AccountQuestGroup): boolean {
  return group.quests.some(quest => isRunning(accountId, quest.id) && isGameQuest(quest))
}

/** Eligible for the group's Run all: unfinished, not already running and drivable
 *  through the direct API, up to the same per-account cap the backend enforces so
 *  a batch cannot queue starts it would reject. An unenrolled quest counts, because
 *  Run all accepts it first.
 *
 *  One game quest runs at a time per account: the account already running one
 *  leaves no room for another, and a batch that is not already running one starts
 *  exactly one of them. The quests it leaves out are not failures — they wait for
 *  the running game to end. */
function runnableQuests(group: AccountQuestGroup): Quest[] {
  const accountId = group.account.user.id
  const running = group.quests.filter(quest => isRunning(accountId, quest.id)).length
  const free = questsStore.maxParallelQuests - running
  if (free <= 0) return []
  const candidates = group.quests
    .filter(quest => !quest.user_status?.completed_at)
    .filter(quest => !isRunning(accountId, quest.id))
    .filter(quest => foreignQuestBlocker(quest) === null)
  let gameTaken = gameSlotBusy(accountId, group)
  const queue: Quest[] = []
  for (const quest of candidates) {
    if (isGameQuest(quest)) {
      if (gameTaken) continue
      gameTaken = true
    }
    queue.push(quest)
    if (queue.length >= free) break
  }
  return queue
}

const groups = computed<ForeignGroupView[]>(() => {
  const views: ForeignGroupView[] = []
  for (const group of questsStore.foreignQuestGroups) {
    if (group.quests.length === 0 && !group.error) continue
    const accountId = group.account.user.id
    const user = group.account.user
    const gameBusy = gameSlotBusy(accountId, group)
    const rows: ForeignRow[] = group.quests.map(quest => {
      const key = `${accountId}|${quest.id}`
      const running = isRunning(accountId, quest.id)
      const action = actionOf(quest, running)
      const blocker = action === 'start' ? foreignQuestBlocker(quest) : null
      const gameBlocked = action === 'start' && blocker === null && gameBusy && isGameQuest(quest)
      const note = noteOf(blocker, attemptErrors.value.get(key), gameBlocked)
      return {
        key,
        accountId,
        quest,
        questType: getQuestKind(quest),
        action,
        note: note.note,
        noteIsError: note.isError,
        blocked: blocker !== null || gameBlocked,
        busy: busyKeys.value.has(key),
      }
    })
    views.push({
      accountId,
      name: user.global_name || user.username,
      handle: `@${user.username}`,
      fallback: user.username.charAt(0).toUpperCase(),
      avatarSrc: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
        : '',
      readError: group.error ?? '',
      rows,
      runningCount: rows.filter(row => row.action === 'stop').length,
      canRunAll: runnableQuests(group).length > 0,
      runAllBusy: busyKeys.value.has(`${accountId}|all`),
    })
  }
  return views
})

const otherAccountCount = computed(() =>
  authStore.knownAccounts.filter(account => !account.active).length
)
// A failed read leaves no groups at all, and hiding the card would hide the only
// error line and the Refresh that can retry it.
const visible = computed(() =>
  otherAccountCount.value > 0 &&
  (groups.value.length > 0 || questsStore.foreignQuestsError !== null)
)

/** One row's action, its failure notice and the list reload that follows it. */
async function runRow(row: ForeignRow, action: () => Promise<void>, failureTitle: string): Promise<void> {
  if (busyKeys.value.has(row.key)) return
  busyKeys.value.add(row.key)
  attemptErrors.value.delete(row.key)
  try {
    await action()
    await questsStore.refreshForeignQuests()
  } catch (cause) {
    attemptErrors.value.set(row.key, cause instanceof Error ? cause.message : String(cause))
    toast.error({ title: failureTitle, description: attemptErrors.value.get(row.key) })
  } finally {
    busyKeys.value.delete(row.key)
  }
}

function handleAccept(row: ForeignRow): Promise<void> {
  return runRow(row, () => questsStore.acceptForeignQuest(row.accountId, row.quest.id), t('toast.failed_accept'))
}

function handleStart(row: ForeignRow): Promise<void> {
  return runRow(row, () => questsStore.startForeignQuest(row.accountId, row.quest), t('toast.failed_start_game'))
}

function handleStop(row: ForeignRow): Promise<void> {
  return runRow(row, () => questsStore.stopForeignQuest(row.accountId, row.quest.id), t('toast.failed_stop_quest'))
}

function handleClaim(row: ForeignRow): Promise<void> {
  return runRow(row, () => questsStore.claimForeignQuest(row.accountId, row.quest.id), t('toast.failed_claim'))
}

async function handleRunAll(group: ForeignGroupView): Promise<void> {
  const key = `${group.accountId}|all`
  if (group.runAllBusy || busyKeys.value.has(key)) return
  const source = questsStore.foreignQuestGroups.find(
    candidate => candidate.account.user.id === group.accountId
  )
  if (!source) return
  const queue = runnableQuests(source)
  if (queue.length === 0) return
  // The game quests the batch leaves out are not failures: one game quest runs at
  // a time per account, so the rest wait for the one that started.
  const eligible = source.quests
    .filter(quest => !quest.user_status?.completed_at)
    .filter(quest => !isRunning(group.accountId, quest.id))
    .filter(quest => foreignQuestBlocker(quest) === null)
  const waitingGames = eligible.filter(isGameQuest).length - queue.filter(isGameQuest).length
  busyKeys.value.add(key)
  const failures: string[] = []
  try {
    for (const quest of queue) {
      const rowKey = `${group.accountId}|${quest.id}`
      busyKeys.value.add(rowKey)
      try {
        // A quest this account never accepted has nothing to post progress to, so
        // the batch enrolls it first, the same step a lone Accept button does.
        if (!quest.user_status?.enrolled_at) {
          await questsStore.acceptForeignQuest(group.accountId, quest.id)
        }
        await questsStore.startForeignQuest(group.accountId, quest)
      } catch (cause) {
        failures.push(
          `${quest.config?.messages?.quest_name ?? quest.id}: ${cause instanceof Error ? cause.message : String(cause)}`
        )
      } finally {
        busyKeys.value.delete(rowKey)
      }
    }
    await questsStore.refreshForeignQuests()
  } finally {
    busyKeys.value.delete(key)
  }
  if (failures.length > 0) {
    toast.error({
      title: t('quest.foreign_run_all_partial', { count: failures.length }),
      description: failures[0],
    })
  } else if (waitingGames > 0) {
    toast.info({
      title: t('quest.foreign_run_all_waiting', { count: waitingGames }),
    })
  }
}

function refresh(): Promise<void> {
  return questsStore.refreshForeignQuests()
}

let timer: number | null = null

function stopTimer(): void {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}

onMounted(() => {
  if (otherAccountCount.value > 0) void refresh()
  timer = window.setInterval(() => {
    // A hidden window must not spend requests for accounts nobody is looking at.
    if (document.hidden || otherAccountCount.value === 0) return
    void refresh()
  }, REFRESH_MS)
})

// Signing another account in or forgetting one changes whose list should be here,
// so the panel refetches instead of waiting for the next tick. With a single
// account the read comes back empty and costs nothing beyond the reply.
watch(
  () => authStore.knownAccounts.map(account => account.user.id).join('|'),
  () => { void refresh() }
)

onBeforeUnmount(stopTimer)
</script>

<template>
  <Card v-if="visible || questsStore.foreignQuestsLoading" class="overflow-hidden border-border/60">
    <CardHeader class="flex flex-row items-start gap-2.5 p-4 pb-2">
      <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Users class="h-4 w-4 text-primary" />
      </span>
      <div class="min-w-0 flex-1 space-y-0.5">
        <CardTitle class="flex items-center gap-1.5 text-sm">
          {{ t('quest.foreign_title') }}
          <span class="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold leading-4 text-primary">
            {{ groups.length }}
          </span>
        </CardTitle>
        <p class="text-xs leading-relaxed text-pretty text-muted-foreground">
          {{ t('quest.foreign_hint') }}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        class="h-7 shrink-0 gap-1.5 px-2 text-xs"
        :disabled="questsStore.foreignQuestsLoading"
        @click="refresh"
      >
        <RotateCw class="h-3.5 w-3.5" :class="questsStore.foreignQuestsLoading ? 'animate-spin' : ''" />
        {{ t('general.refresh') }}
      </Button>
    </CardHeader>

    <p v-if="questsStore.foreignQuestsError" class="border-t border-border/60 px-4 py-2 text-[11px] leading-relaxed text-error">
      {{ questsStore.foreignQuestsError }}
    </p>

    <CardContent class="p-0">
      <section v-for="group in groups" :key="group.accountId" class="border-t border-border/60 py-3">
        <div class="flex items-center gap-2.5 px-4">
          <Avatar class="h-7 w-7 shrink-0">
            <AvatarImage v-if="group.avatarSrc" :src="group.avatarSrc" :alt="group.name" />
            <AvatarFallback class="text-xs font-semibold">{{ group.fallback }}</AvatarFallback>
          </Avatar>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-semibold">{{ group.name }}</p>
            <p class="truncate text-[11px] text-muted-foreground">
              {{ `${group.handle} · ${t('quest.foreign_running', { count: group.runningCount })}` }}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            class="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
            :disabled="!group.canRunAll || group.runAllBusy"
            @click="handleRunAll(group)"
          >
            <Loader2 v-if="group.runAllBusy" class="h-3.5 w-3.5 animate-spin" />
            {{ t('quest.foreign_run_all') }}
          </Button>
        </div>

        <p v-if="group.readError" class="mt-2 break-words px-4 text-[11px] leading-relaxed text-error">
          {{ `${t('quest.foreign_read_failed')}: ${group.readError}` }}
        </p>

        <div class="mt-2.5 grid gap-2.5 px-4 sm:grid-cols-2">
          <QuestCard
            v-for="row in group.rows"
            :key="row.key"
            :quest="row.quest"
            :quest-type="row.questType"
            foreign
            :account-id="group.account.user.id"
            :busy="row.busy"
          >
            <template #actions>
              <div class="flex flex-col items-end gap-1">
                <Button
                  v-if="row.action === 'accept'"
                  variant="default"
                  :disabled="row.busy"
                  @click="handleAccept(row)"
                >
                  <Loader2 v-if="row.busy" class="mr-2 h-4 w-4 animate-spin" />
                  {{ t('home.accept_quest') }}
                </Button>

                <Button
                  v-else-if="row.action === 'stop'"
                  variant="destructive"
                  :disabled="row.busy"
                  @click="handleStop(row)"
                >
                  <Loader2 v-if="row.busy" class="mr-2 h-4 w-4 animate-spin" />
                  {{ t('home.stop') }}
                </Button>

                <Button
                  v-else-if="row.action === 'claim'"
                  class="gap-1.5 bg-green-600 text-white hover:bg-green-700"
                  :disabled="row.busy"
                  @click="handleClaim(row)"
                >
                  <Loader2 v-if="row.busy" class="h-4 w-4 animate-spin" />
                  <Gift v-else class="h-4 w-4" />
                  {{ t('home.claim_reward') }}
                </Button>

                <span
                  v-else-if="row.action === 'completed'"
                  class="px-2 text-sm font-medium text-green-700 dark:text-green-400"
                >
                  {{ t('home.completed') }}
                </span>

                <Button
                  v-else
                  variant="default"
                  :disabled="row.busy || row.blocked"
                  @click="handleStart(row)"
                >
                  <Loader2 v-if="row.busy" class="mr-2 h-4 w-4 animate-spin" />
                  {{ t('quest.foreign_start') }}
                </Button>

                <p
                  v-if="row.note"
                  class="max-w-[15rem] break-words text-right text-[10px] leading-relaxed"
                  :class="row.noteIsError ? 'text-error' : 'text-muted-foreground'"
                >
                  {{ row.note }}
                </p>
              </div>
            </template>
          </QuestCard>
        </div>
      </section>
    </CardContent>
  </Card>
</template>
