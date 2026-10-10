<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { parseReleaseNotes, type NoteBlock, type NoteRun } from '@/utils/releaseNotes'
import { cn } from '@/lib/utils'

// Renders parsed release notes without ever treating the text as markup: each run is
// interpolated, so a release body cannot inject elements into the window.
const props = defineProps<{
  body: string
  class?: HTMLAttributes['class']
}>()

const blocks = computed(() => parseReleaseNotes(props.body))

function blockClass(block: NoteBlock): string {
  if (block.type === 'heading') return 'pt-2 text-sm font-semibold text-foreground first:pt-0'
  if (block.type === 'bullet') return 'flex gap-2 pl-1 text-sm text-muted-foreground'
  if (block.type === 'code') {
    return 'overflow-x-auto rounded-md border border-border/60 bg-muted/60 p-2 font-mono text-xs text-foreground'
  }
  return 'text-sm leading-relaxed text-muted-foreground'
}

function runClass(run: NoteRun): string {
  if (run.code) return 'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground'
  if (run.bold) return 'font-semibold text-foreground'
  if (run.href) return 'font-medium text-primary underline underline-offset-2'
  return ''
}
</script>

<template>
  <div v-if="blocks.length > 0" :class="cn('space-y-1 break-words', props.class)">
    <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
      <p v-if="block.type === 'heading'" :class="blockClass(block)">
        <template v-for="(run, runIndex) in block.runs" :key="runIndex">
          <a v-if="run.href" :href="run.href" target="_blank" rel="noopener noreferrer" :class="runClass(run)">{{ run.text }}</a>
          <code v-else-if="run.code" :class="runClass(run)">{{ run.text }}</code>
          <strong v-else-if="run.bold" :class="runClass(run)">{{ run.text }}</strong>
          <span v-else>{{ run.text }}</span>
        </template>
      </p>

      <div v-else-if="block.type === 'bullet'" :class="blockClass(block)">
        <span class="shrink-0 text-primary" aria-hidden="true">{{ block.checked === undefined ? '•' : (block.checked ? '☑' : '☐') }}</span>
        <span class="min-w-0">
          <template v-for="(run, runIndex) in block.runs" :key="runIndex">
            <a v-if="run.href" :href="run.href" target="_blank" rel="noopener noreferrer" :class="runClass(run)">{{ run.text }}</a>
            <code v-else-if="run.code" :class="runClass(run)">{{ run.text }}</code>
            <strong v-else-if="run.bold" :class="runClass(run)">{{ run.text }}</strong>
            <span v-else>{{ run.text }}</span>
          </template>
        </span>
      </div>

      <pre v-else-if="block.type === 'code'" :class="blockClass(block)"><template v-for="(run, runIndex) in block.runs" :key="runIndex">{{ run.text }}</template></pre>

      <p v-else :class="blockClass(block)">
        <template v-for="(run, runIndex) in block.runs" :key="runIndex">
          <a v-if="run.href" :href="run.href" target="_blank" rel="noopener noreferrer" :class="runClass(run)">{{ run.text }}</a>
          <code v-else-if="run.code" :class="runClass(run)">{{ run.text }}</code>
          <strong v-else-if="run.bold" :class="runClass(run)">{{ run.text }}</strong>
          <span v-else>{{ run.text }}</span>
        </template>
      </p>
    </template>
  </div>
</template>
