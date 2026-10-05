<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { AlertDialogTitle } from 'radix-vue'
import { cn } from '@/lib/utils'

defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <AlertDialogTitle :class="cn('text-lg font-semibold', $props.class)">
    <slot />
  </AlertDialogTitle>
</template>

