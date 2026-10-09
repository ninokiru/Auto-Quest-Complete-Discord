<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { message } from '@tauri-apps/plugin-dialog'
import { useI18n } from 'vue-i18n'
import { LoaderCircle } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { createAppExitGuard, type ExitGuardState, type RunningCdpSession } from '@/composables/appExitGuard'
import {
  listRunningDesktopCdpSessions,
  restoreDesktopClientSession,
  exitAppNow,
  prepareAppExit,
  startDiscordNormalRestoreHelper,
} from '@/api/tauri'

const { t } = useI18n()
const appWindow = getCurrentWindow()
const state = ref<ExitGuardState>({ checking: false, dialogOpen: false, closing: false })
const hasExternalSessions = computed(() => state.value.sessions?.some(session => session.ownership !== 'managed') ?? false)
let unlisten: UnlistenFn | undefined

const guard = createAppExitGuard({
  listSessions: () => listRunningDesktopCdpSessions() as Promise<RunningCdpSession[]>,
  restoreSession: async (session, confirmExternal) => {
    if (!session.installationId) {
      throw new Error(t('exit_cdp.installation_unidentified', {
        client: session.providerId ?? t('settings.desktop_client'),
        port: session.port,
      }))
    }
    await restoreDesktopClientSession(session.installationId, session.port, confirmExternal)
  },
  startRestoreHelper: startDiscordNormalRestoreHelper,
  prepareExit: prepareAppExit,
  exitApplication: exitAppNow,
  showError: async error => {
    await message(`${t('exit_cdp.helper_error')}\n\n${error}`, {
      title: t('exit_cdp.title'),
      kind: 'error',
    })
  },
  logError: error => console.error('[app-exit]', error),
  onStateChange: next => { state.value = next },
})

function handleDialogOpenChange(open: boolean) {
  if (!open) guard.cancelClose()
}

onMounted(async () => {
  unlisten = await appWindow.onCloseRequested(event => guard.requestClose(event))
})

onUnmounted(() => unlisten?.())
</script>

<template>
  <AlertDialog :open="state.dialogOpen" @update:open="handleDialogOpenChange">
    <AlertDialogContent class="max-w-[560px]">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('exit_cdp.title') }}</AlertDialogTitle>
        <AlertDialogDescription>{{ t('exit_cdp.description') }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="state.checking || state.closing">
          {{ t('dialog.cancel') }}
        </AlertDialogCancel>
        <Button variant="outline" :disabled="state.checking || state.closing" @click="guard.closeOnly">
          {{ t('exit_cdp.close_only') }}
        </Button>
        <Button
          v-if="hasExternalSessions"
          variant="outline"
          :disabled="state.checking || state.closing"
          @click="guard.restoreManagedAndClose"
        >
          {{ t('desktop_clients.restore_managed_and_close') }}
        </Button>
        <Button :disabled="state.checking || state.closing" @click="guard.restoreAndClose">
          <LoaderCircle v-if="state.checking" class="mr-2 h-4 w-4 animate-spin" />
          {{ hasExternalSessions ? t('desktop_clients.restore_all_and_close') : t('exit_cdp.restore_and_close') }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
