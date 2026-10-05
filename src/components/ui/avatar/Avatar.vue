<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { AvatarRoot } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class']
  shape?: 'circle' | 'square'
}>(), {
  shape: 'circle',
})

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props

  return delegated
})
</script>

<template>
  <AvatarRoot
    v-bind="delegatedProps"
    :class="cn(
      'relative flex h-10 w-10 shrink-0 overflow-hidden',
      shape === 'circle' ? 'rounded-full' : 'rounded-md',
      props.class,
    )"
  >
    <slot />
  </AvatarRoot>
</template>
