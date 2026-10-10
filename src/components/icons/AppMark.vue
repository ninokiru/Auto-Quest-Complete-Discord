<script setup lang="ts">
import { useId } from 'vue'

// Original mark for this app: a rounded tile, a check, one spark. It deliberately
// traces no third-party logo, unlike the artwork it replaced.
const gradientId = `aqc-mark-${useId().replace(/[^\w-]/g, '')}`

withDefaults(
  defineProps<{
    label?: string
  }>(),
  { label: 'Auto Quest Complete Discord' }
)
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    fill="none"
  >
    <defs>
      <linearGradient :id="gradientId" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
        <stop stop-color="#2563eb" />
        <stop offset="1" stop-color="#1e3a8a" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="20" height="20" rx="6" :fill="`url(#${gradientId})`" />
    <path
      d="M6.8 12.4l3.1 3.1 7.3-7.3"
      stroke="#fff"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path d="M17.4 4.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" fill="#bfdbfe" />
  </svg>
</template>
