<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { settingToneClass, type SettingsTone } from './settingTones'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  defaultOpen?: boolean
  tone?: SettingsTone
}>(), {
  tone: 'neutral',
})

const open = ref(props.defaultOpen ?? false)
</script>

<template>
  <div class="overflow-hidden rounded-lg border bg-card/60">
    <Button
      type="button"
      variant="ghost"
      :aria-expanded="open"
      class="h-auto w-full justify-between gap-3 whitespace-normal rounded-none px-4 py-3 text-left hover:bg-muted/40"
      @click="open = !open"
    >
      <span class="min-w-0">
        <span class="block text-sm font-semibold">{{ title }}</span>
        <span v-if="description" class="mt-1 block text-xs font-normal text-muted-foreground">{{ description }}</span>
      </span>
      <span :class="cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', settingToneClass[tone].icon)">
        <ChevronDown :class="cn('h-4 w-4 transition-transform', open && 'rotate-180')" />
      </span>
    </Button>
    <Transition name="disclosure">
      <div v-if="open" class="disclosure-panel">
        <div class="disclosure-row">
          <div class="border-t border-border/60 bg-background/40 px-4 py-4">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.disclosure-panel {
  display: grid;
  grid-template-rows: 1fr;
}

.disclosure-row {
  min-height: 0;
  overflow: hidden;
}

.disclosure-enter-active,
.disclosure-leave-active {
  overflow: hidden;
  transition:
    grid-template-rows 260ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease;
}

.disclosure-enter-from,
.disclosure-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
</style>
