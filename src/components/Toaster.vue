<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useToastStore } from '@/stores/toast'
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-vue-next'

const { t } = useI18n()
const toastStore = useToastStore()

const iconMap = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const styleMap = {
  success: 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400',
  error: 'border-destructive/30 bg-destructive/10 text-error',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
}
</script>

<template>
  <Teleport to="body">
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      class="fixed bottom-4 right-4 z-[100] w-[380px] max-w-[calc(100vw-2rem)] pointer-events-none"
    >
      <TransitionGroup
        tag="div"
        class="flex flex-col-reverse gap-2"
        enter-active-class="transition ease-out duration-200"
        enter-from-class="opacity-0 translate-y-2 scale-[0.98]"
        enter-to-class="opacity-100 translate-y-0 scale-100"
        leave-active-class="transition ease-in duration-150 absolute inset-x-0"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 translate-y-1 scale-[0.98]"
        move-class="transition duration-200 ease-out"
      >
        <div
          v-for="toast in toastStore.toasts"
          :key="toast.id"
          class="pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border bg-popover/95 p-3 shadow-lg backdrop-blur-sm"
          :class="styleMap[toast.type]"
        >
          <component
            :is="iconMap[toast.type]"
            class="mt-0.5 h-5 w-5 shrink-0"
          />

          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium leading-snug text-foreground">{{ toast.title }}</p>
            <p v-if="toast.description" class="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{{ toast.description }}</p>

            <div v-if="toast.actions && toast.actions.length > 0" class="mt-2 flex gap-2">
              <button
                v-for="(action, idx) in toast.actions"
                :key="idx"
                class="rounded border border-current/25 px-2 py-1 text-xs font-medium outline-none transition-colors hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-ring"
                @click="action.onClick(); toastStore.dismiss(toast.id)"
              >
                {{ action.label }}
              </button>
            </div>
          </div>

          <button
            type="button"
            :aria-label="t('general.dismiss')"
            class="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            @click="toastStore.dismiss(toast.id)"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
