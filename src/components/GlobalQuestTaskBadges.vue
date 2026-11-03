<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, Gamepad2, ListChecks, MonitorPlay, Radio } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/utils/questTasks'
import type { GlobalQuestTask, GlobalTaskKind } from '@/utils/globalQuests'

const props = defineProps<{
  tasks: GlobalQuestTask[]
}>()

const { t } = useI18n()

/** The catalogue lists a desktop and a mobile task for the same goal, and this
 *  row shows neither platform, so an identical goal appears once. */
const uniqueTasks = computed(() => {
  const seen = new Set<string>()
  return props.tasks.filter(task => {
    const key = `${task.kind}|${task.target ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const labelKeys: Record<GlobalTaskKind, string> = {
  watch: 'global_quests.task_video',
  play: 'global_quests.task_play',
  activity: 'global_quests.task_activity',
  stream: 'global_quests.task_stream',
  other: 'global_quests.task_other',
}

const toneClass: Record<GlobalTaskKind, string> = {
  watch: 'border-info/30 bg-info/10 text-info',
  stream: 'border-info/30 bg-info/10 text-info',
  play: 'border-primary/30 bg-primary/10 text-primary',
  activity: 'border-warn/30 bg-warn/10 text-warn',
  other: 'border-border bg-muted text-muted-foreground',
}

const icons: Record<GlobalTaskKind, Component> = {
  watch: MonitorPlay,
  stream: Radio,
  play: Gamepad2,
  activity: Activity,
  other: ListChecks,
}

function labelFor(task: GlobalQuestTask): string {
  if (task.kind !== 'other') return t(labelKeys[task.kind])
  return task.type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, char => char.toUpperCase())
}

function targetFor(task: GlobalQuestTask): string {
  if (task.target === null) return ''
  // Achievement targets count tasks; every timed task uses the duration formatter.
  return task.kind === 'activity' ? `×${task.target}` : formatDuration(task.target)
}
</script>

<template>
  <div v-if="tasks.length" class="flex flex-wrap gap-1.5">
    <Badge
      v-for="(task, index) in uniqueTasks"
      :key="`${task.type}-${index}`"
      variant="outline"
      :class="['gap-1 px-1.5 py-0 text-[11px] font-normal leading-4', toneClass[task.kind]]"
    >
      <component :is="icons[task.kind]" class="h-3 w-3" />
      <span>{{ labelFor(task) }}</span>
      <span v-if="targetFor(task)" class="opacity-70 font-mono tabular-nums">· {{ targetFor(task) }}</span>
    </Badge>
  </div>
</template>
