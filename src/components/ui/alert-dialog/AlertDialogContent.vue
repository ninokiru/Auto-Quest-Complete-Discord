<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import {
  AlertDialogContent,
  AlertDialogOverlay,
  AlertDialogPortal,
} from 'radix-vue'
import { cn } from '@/lib/utils'

// Without this the attributes Vue would auto-inherit land on the portal wrapper
// instead of the dialog panel, so `aria-modal` and any consumer attribute is lost.
defineOptions({ inheritAttrs: false })

defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <AlertDialogPortal>
    <AlertDialogOverlay
      class="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1.5px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <AlertDialogContent
      v-bind="$attrs"
      role="alertdialog"
      aria-modal="true"
      :class="
        cn(
          'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-xl',
          $props.class,
        )
      "
    >
      <slot />
    </AlertDialogContent>
  </AlertDialogPortal>
</template>

