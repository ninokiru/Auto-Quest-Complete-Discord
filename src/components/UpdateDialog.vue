<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { open } from '@tauri-apps/plugin-shell'
import { ArrowDownCircle, ExternalLink, LoaderCircle } from 'lucide-vue-next'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { exitAppNow, startSelfUpdate, type SelfUpdatePhase } from '@/api/tauri'
import { useNotificationsStore } from '@/stores/notifications'
import { useQuestsStore } from '@/stores/quests'
import { useVersionStore } from '@/stores/version'
import { commandErrorMessage } from '@/utils/commandError'
import { formatPublishedDate } from '@/utils/relativeTime'
import ReleaseNotesList from './ReleaseNotesList.vue'

const { t, locale } = useI18n()
const versionStore = useVersionStore()
const notifications = useNotificationsStore()
const questsStore = useQuestsStore()

const visible = ref(false)
const release = computed(() => versionStore.latestRelease)
const publishedText = computed(() =>
  formatPublishedDate(release.value?.published_at, String(locale.value || 'en')),
)

// Only the Windows build has a silent installer to run over itself; everywhere else
// the release page is the whole story, so the Update button must not appear.
const canSelfUpdate = computed(() => questsStore.platformCapabilities?.selfUpdate === true)
const installing = ref(false)
const restarting = ref(false)
const phase = ref<SelfUpdatePhase | null>(null)
const totalBytes = ref(0)
const updateError = ref('')

const sizeText = computed(() => {
  if (phase.value !== 'downloading' || totalBytes.value <= 0) return ''
  return `${(totalBytes.value / 1_048_576).toFixed(1)} MB`
})

const phaseText = computed(() => {
  if (restarting.value) return t('notify.update.restarting')
  switch (phase.value) {
    case 'resolving':
      return t('notify.update.resolving')
    case 'downloading':
      return t('notify.update.downloading')
    case 'verifying':
      return t('notify.update.verifying')
    case 'installing':
      return t('notify.update.installing')
    default:
      return ''
  }
})

function downloadLatest() {
  const url = release.value?.html_url
  if (!url) return
  // The system browser lives outside this window, so a failure is a log line —
  // the dialog stays open and the user can retry or read the notes here.
  open(url).catch(error => console.error('Could not open the release page:', error))
}

/**
 * Hands the update to the backend, then exits so the install helper can replace the
 * files it is waiting on. A new version is running afterwards, so this path records no
 * dismissal: the tag must stay announced if the relaunch never happens.
 */
async function installUpdate() {
  const tag = versionStore.pendingUpdateTag
  if (typeof tag !== 'string' || !tag || installing.value) return

  installing.value = true
  updateError.value = ''
  totalBytes.value = 0
  phase.value = 'resolving'
  try {
    await startSelfUpdate(tag, progress => {
      phase.value = progress.phase
      if (progress.totalBytes > 0) totalBytes.value = progress.totalBytes
    })
  } catch (error) {
    const details = commandErrorMessage(error)
    updateError.value = details
    installing.value = false
    phase.value = null
    notifications.push('error', { error: details })
    return
  }

  restarting.value = true
  // The process ends inside this command, so a rejection only means the window is
  // already going away and there is nothing to report back.
  await exitAppNow().catch(() => undefined)
}

function postpone() {
  const tag = versionStore.pendingUpdateTag
  if (typeof tag === 'string' && tag) versionStore.dismissUpdate(tag)
  visible.value = false
}

/**
 * Every way out of the dialog means "not now": the cancel button, Escape and the
 * overlay. Recording the tag here is what keeps the same release from announcing
 * itself again on the next start, while a newer tag still qualifies. Mid-install the
 * dialog is the only place the progress is visible, so it stays put.
 */
function handleOpenChange(next: boolean) {
  if (next) {
    visible.value = true
    return
  }
  if (installing.value) return
  postpone()
}

// One announcement per tag: the watcher only runs when the tag changes, and a tag the
// user postponed is never announced again until a newer release lands.
watch(() => versionStore.pendingUpdateTag, (tag) => {
  if (typeof tag !== 'string' || !tag) return
  // Reaching here after a postponed-and-restored tag means the dialog is showing
  // again, and a failure line from the previous attempt is no longer true.
  updateError.value = ''
  visible.value = true
  notifications.push('update_available', {
    version: tag,
    current: versionStore.currentVersion,
    url: release.value?.html_url,
  })
})
</script>

<template>
  <AlertDialog :open="visible" @update:open="handleOpenChange">
    <AlertDialogContent class="max-h-[85vh] gap-3 overflow-hidden sm:max-w-xl">
      <AlertDialogHeader class="space-y-2">
        <div class="flex items-start gap-3">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ArrowDownCircle class="h-5 w-5" />
          </div>
          <div class="min-w-0 space-y-1">
            <AlertDialogTitle class="text-base leading-snug">
              {{ t('notify.dialog.title', { version: release?.tag_name ?? '' }) }}
            </AlertDialogTitle>
            <AlertDialogDescription class="text-sm">
              {{ t('notify.dialog.body', { current: versionStore.currentVersion }) }}
            </AlertDialogDescription>
            <p v-if="publishedText" class="text-xs text-muted-foreground">
              {{ t('notify.dialog.published', { date: publishedText }) }}
            </p>
          </div>
        </div>
      </AlertDialogHeader>

      <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/60 bg-muted/30 p-3">
        <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {{ t('notify.dialog.notes') }}
        </p>
        <ReleaseNotesList v-if="release?.body" :body="release.body" />
        <p v-else class="text-sm text-muted-foreground">{{ t('notify.log_no_notes') }}</p>
      </div>

      <p v-if="installing" class="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle class="h-4 w-4 shrink-0 animate-spin" />
        <span>{{ phaseText }}</span>
        <span v-if="sizeText" class="text-xs">· {{ sizeText }}</span>
      </p>
      <p v-else-if="updateError" class="text-sm text-destructive">
        {{ t('notify.update.failed', { error: updateError }) }}
      </p>
      <p v-else class="text-xs text-muted-foreground">{{ t('notify.dialog.hint') }}</p>

      <AlertDialogFooter class="flex-row flex-wrap gap-2 sm:space-x-0">
        <AlertDialogCancel :disabled="installing" class="border-border/70">
          {{ t('notify.dialog.later') }}
        </AlertDialogCancel>
        <Button
          v-if="release?.html_url"
          variant="outline"
          class="gap-2"
          :disabled="installing"
          @click="downloadLatest"
        >
          <ExternalLink class="h-4 w-4" />
          {{ t('version.download') }}
        </Button>
        <Button v-if="canSelfUpdate" :disabled="installing" @click="installUpdate">
          {{ t('notify.update.button') }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
