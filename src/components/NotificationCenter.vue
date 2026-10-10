<script setup lang="ts">
import { computed, ref, type Component, type HTMLAttributes } from 'vue'
import { useI18n } from 'vue-i18n'
import { open } from '@tauri-apps/plugin-shell'
import {
  AlertTriangle,
  ArrowUpCircle,
  BadgeCheck,
  Bell,
  CheckCheck,
  ExternalLink,
  ListChecks,
  RefreshCw,
  ScrollText,
  Trash2,
  X,
  XCircle,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useNotificationsStore, type AppNotification, type NotificationKind } from '@/stores/notifications'
import { useVersionStore } from '@/stores/version'
import { formatPublishedDate, formatRelativeTime } from '@/utils/relativeTime'
import ReleaseNotesList from './ReleaseNotesList.vue'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()

const { t, locale } = useI18n()
const notifications = useNotificationsStore()
const versionStore = useVersionStore()

type PanelTab = 'inbox' | 'log'
const panelOpen = ref(false)
const tab = ref<PanelTab>('inbox')

const kindIcon: Record<NotificationKind, Component> = {
  update_available: ArrowUpCircle,
  quest_completed: BadgeCheck,
  quest_failed: XCircle,
  new_quests: ListChecks,
  error: AlertTriangle,
}

const kindTone: Record<NotificationKind, string> = {
  update_available: 'text-primary',
  quest_completed: 'text-green-600 dark:text-green-400',
  quest_failed: 'text-destructive',
  new_quests: 'text-primary',
  error: 'text-amber-600 dark:text-amber-400',
}

const badgeText = computed(() => {
  const count = notifications.unreadCount
  if (count === 0) return ''
  return count > 99 ? '99+' : String(count)
})

const appLocale = computed(() => String(locale.value || 'en'))

/** Each kind hands vue-i18n a literal bag holding exactly the placeholders its own
 *  strings declare. A widened `params` object would not type-check, and translating
 *  here rather than in the store is what makes the bell follow a language switch. */
function titleOf(item: AppNotification): string {
  switch (item.kind) {
    case 'update_available':
      return t('notify.items.update_available.title', { version: item.params.version ?? '' })
    case 'quest_completed':
      return t('notify.items.quest_completed.title')
    case 'quest_failed':
      return t('notify.items.quest_failed.title')
    case 'new_quests':
      return t('notify.items.new_quests.title')
    case 'error':
      return t('notify.items.error.title')
  }
}

function bodyOf(item: AppNotification): string {
  switch (item.kind) {
    case 'update_available':
      return t('notify.items.update_available.body', { current: item.params.current ?? '' })
    case 'quest_completed':
      return t('notify.items.quest_completed.body', { name: item.params.name ?? '' })
    case 'quest_failed':
      return t('notify.items.quest_failed.body', {
        name: item.params.name ?? '',
        error: item.params.error ?? '',
      })
    case 'new_quests':
      return t('notify.items.new_quests.body', { count: item.params.count ?? 0 })
    case 'error':
      return t('notify.items.error.body', { error: item.params.error ?? '' })
  }
}

function timeOf(item: AppNotification): string {
  return formatRelativeTime(item.createdAt, appLocale.value)
}

function openItem(item: AppNotification) {
  notifications.markRead(item.id)
}

function openLink(url: string | undefined) {
  if (!url) return
  // The system browser is outside our window, so a failure only deserves a log line.
  open(url).catch(error => console.error('Could not open the link:', error))
}

function selectTab(next: PanelTab) {
  tab.value = next
  if (next === 'log') void versionStore.loadReleaseLog()
}

const releaseLog = computed(() => versionStore.releaseLog)
const currentTag = computed(() => versionStore.currentVersion.replace(/^v/, ''))
const latestTag = computed(() => versionStore.latestRelease?.tag_name ?? '')
</script>

<template>
  <DropdownMenu :open="panelOpen" @update:open="panelOpen = $event">
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        class="relative h-9 w-9"
        :title="t('notify.bell')"
        :aria-label="notifications.hasUnread
          ? t('notify.bell_unread', { count: notifications.unreadCount })
          : t('notify.bell')"
        :class="props.class"
      >
        <Bell class="h-4 w-4" />
        <span
          v-if="badgeText"
          class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
        >{{ badgeText }}</span>
      </Button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-[min(24rem,calc(100vw-2rem))] p-0">
      <div class="flex items-center gap-1 border-b border-border/60 p-2">
        <button
          type="button"
          class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
          :class="tab === 'inbox' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/60'"
          @click="selectTab('inbox')"
        >
          <Bell class="h-3.5 w-3.5" />
          {{ t('notify.tab_inbox') }}
          <span v-if="notifications.unreadCount > 0" class="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
            {{ notifications.unreadCount }}
          </span>
        </button>
        <button
          type="button"
          class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
          :class="tab === 'log' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/60'"
          @click="selectTab('log')"
        >
          <ScrollText class="h-3.5 w-3.5" />
          {{ t('notify.tab_log') }}
        </button>
      </div>

      <!-- Inbox -->
      <div v-if="tab === 'inbox'">
        <div class="max-h-[52vh] overflow-y-auto p-1">
          <p v-if="notifications.items.length === 0" class="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
            <Bell class="h-5 w-5 opacity-50" />
            {{ t('notify.empty') }}
          </p>

          <div
            v-for="item in notifications.items"
            :key="item.id"
            class="group relative flex gap-2.5 rounded-md p-2.5 transition-colors hover:bg-muted/60"
            :class="!item.read && 'bg-primary/5'"
          >
            <component :is="kindIcon[item.kind]" class="mt-0.5 h-4 w-4 shrink-0" :class="kindTone[item.kind]" />

            <div class="min-w-0 flex-1">
              <button type="button" class="w-full text-left" @click="openItem(item)">
                <span class="flex items-center gap-1.5">
                  <span class="truncate text-xs font-semibold text-foreground">{{ titleOf(item) }}</span>
                  <span v-if="!item.read" class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" :aria-label="t('notify.unread')" />
                </span>
                <span class="mt-0.5 block break-words text-xs leading-relaxed text-muted-foreground">{{ bodyOf(item) }}</span>
              </button>
              <div class="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/80">
                <span>{{ timeOf(item) }}</span>
                <button
                  v-if="item.params.url"
                  type="button"
                  class="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                  @click="openLink(item.params.url)"
                >
                  <ExternalLink class="h-3 w-3" />
                  {{ t('notify.open_release') }}
                </button>
              </div>
            </div>

            <button
              type="button"
              class="h-5 w-5 shrink-0 self-start text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              :aria-label="t('notify.remove')"
              @click.stop="notifications.remove(item.id)"
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div v-if="notifications.items.length > 0" class="flex items-center justify-between gap-2 border-t border-border/60 p-2">
          <Button
            variant="ghost"
            size="sm"
            class="h-7 gap-1.5 text-xs"
            :disabled="notifications.unreadCount === 0"
            @click="notifications.markAllRead()"
          >
            <CheckCheck class="h-3.5 w-3.5" />
            {{ t('notify.mark_all_read') }}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
            @click="notifications.clearAll()"
          >
            <Trash2 class="h-3.5 w-3.5" />
            {{ t('notify.clear_all') }}
          </Button>
        </div>
      </div>

      <!-- Update log -->
      <div v-else>
        <div class="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <p class="text-xs font-medium text-muted-foreground">{{ t('notify.log_hint') }}</p>
          <Button
            variant="ghost"
            size="sm"
            class="h-7 gap-1.5 text-xs"
            :disabled="versionStore.isReleaseLogLoading"
            @click="versionStore.loadReleaseLog(true)"
          >
            <RefreshCw class="h-3.5 w-3.5" :class="versionStore.isReleaseLogLoading && 'animate-spin'" />
            {{ t('general.refresh') }}
          </Button>
        </div>

        <div class="max-h-[52vh] overflow-y-auto p-3">
          <p v-if="versionStore.isReleaseLogLoading && releaseLog.length === 0" class="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <RefreshCw class="h-4 w-4 animate-spin" />
            {{ t('notify.log_loading') }}
          </p>

          <p v-else-if="versionStore.releaseLogError" class="py-6 text-center text-xs text-destructive">
            {{ t('notify.log_error', { error: versionStore.releaseLogError }) }}
          </p>

          <p v-else-if="releaseLog.length === 0" class="flex flex-col items-center gap-2 py-8 text-center text-xs text-muted-foreground">
            <ScrollText class="h-5 w-5 opacity-50" />
            {{ t('notify.log_empty') }}
          </p>

          <template v-else>
            <div
              v-for="(release, index) in releaseLog"
              :key="release.tag_name"
              class="border-t border-border/50 py-3 first:border-t-0 first:pt-0"
            >
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <h4 class="font-mono text-sm font-semibold text-foreground">{{ release.tag_name }}</h4>
                <Badge v-if="index === 0" variant="outline" class="border-primary/40 text-[10px] text-primary">
                  {{ t('notify.log_latest') }}
                </Badge>
                <Badge v-if="release.tag_name.replace(/^v/, '') === currentTag" variant="outline" class="text-[10px] text-muted-foreground">
                  {{ t('notify.log_current') }}
                </Badge>
                <span v-if="release.prerelease" class="text-[10px] text-amber-500">{{ t('settings.version_prerelease') }}</span>
                <span v-if="formatPublishedDate(release.published_at, appLocale)" class="text-[11px] text-muted-foreground">
                  {{ formatPublishedDate(release.published_at, appLocale) }}
                </span>
                <button
                  v-if="latestTag && release.tag_name === latestTag && versionStore.hasUpdate"
                  type="button"
                  class="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                  @click="openLink(release.html_url)"
                >
                  <ExternalLink class="h-3 w-3" />
                  {{ t('version.download') }}
                </button>
              </div>

              <ReleaseNotesList v-if="release.body" :body="release.body" class="text-xs" />
              <p v-else class="text-xs text-muted-foreground/70">{{ t('notify.log_no_notes') }}</p>
            </div>
          </template>
        </div>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
