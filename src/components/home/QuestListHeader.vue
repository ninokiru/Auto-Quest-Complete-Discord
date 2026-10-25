<script setup lang="ts">
import { Filter, RotateCw, Search } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import BatchActionsMenu from './BatchActionsMenu.vue'

const { t } = useI18n()

defineProps<{
  query: string
  activeFilterCount: number
  showFilters: boolean
  loading?: boolean
  refreshDisabled?: boolean
  batchDisabled?: boolean
  acceptCount: number
  completeAllCount: number
  videoCount: number
  gameCount: number
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  toggleFilters: []
  refresh: []
  acceptAll: []
  completeAll: []
  completeVideo: []
  completeGame: []
}>()
</script>

<template>
  <div class="rounded-xl border border-border/70 bg-card/72 p-3.5 shadow-[0_10px_28px_-28px_hsl(var(--foreground)/0.45)]">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative min-w-0 flex-1">
        <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          id="quest-search"
          :model-value="query"
          type="text"
          :placeholder="t('home.search_placeholder')"
          :aria-label="t('home.search_placeholder')"
          class="pl-9 pr-9"
          @update:model-value="emit('update:query', String($event))"
        />
        <!-- The Home view binds "/" to this field; the hint is what teaches it. -->
        <kbd class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground" aria-hidden="true">/</kbd>
      </div>

        <Button
          variant="outline"
          :class="cn(
            'gap-2',
            (showFilters || activeFilterCount > 0)
              ? 'border-primary/50 bg-primary/[0.06] text-primary hover:bg-primary/[0.1] hover:text-primary'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )"
          @click="emit('toggleFilters')"
        >
          <Filter class="h-4 w-4" />
          {{ t('home.advanced_filters') }}
          <span
            v-if="activeFilterCount > 0"
            class="ml-0.5 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold leading-4 text-primary tabular-nums"
          >
            {{ activeFilterCount }}
          </span>
        </Button>

        <Button
          variant="outline"
          class="gap-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          :disabled="refreshDisabled"
          @click="emit('refresh')"
        >
          <RotateCw :class="cn('h-4 w-4', loading && 'animate-spin')" />
          {{ t('general.refresh') }}
        </Button>
    </div>

    <BatchActionsMenu
      :accept-count="acceptCount"
      :complete-all-count="completeAllCount"
      :video-count="videoCount"
      :game-count="gameCount"
      :disabled="batchDisabled"
      @accept-all="emit('acceptAll')"
      @complete-all="emit('completeAll')"
      @complete-video="emit('completeVideo')"
      @complete-game="emit('completeGame')"
    />
  </div>
</template>
