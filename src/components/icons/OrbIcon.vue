<script setup lang="ts">
import { useId } from 'vue'

// A glossy orb: a shaded body lightened towards the upper left, a denser core,
// a specular highlight and a rim. Every layer is tinted by the surrounding text
// colour, so the orb follows the theme instead of shipping a fixed currency
// gradient inside the bundle.
const gradientId = `orb-body-${useId()}`
const coreId = `orb-core-${useId()}`
const rimId = `orb-rim-${useId()}`
</script>

<template>
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true">
    <defs>
      <radialGradient :id="gradientId" cx="34%" cy="28%" r="78%">
        <stop offset="0%" stop-color="currentColor" stop-opacity="0.95" />
        <stop offset="52%" stop-color="currentColor" stop-opacity="0.6" />
        <stop offset="100%" stop-color="currentColor" stop-opacity="0.24" />
      </radialGradient>
      <radialGradient :id="coreId" cx="46%" cy="58%" r="60%">
        <stop offset="0%" stop-color="currentColor" stop-opacity="0.55" />
        <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
      </radialGradient>
      <linearGradient :id="rimId" x1="30%" y1="12%" x2="72%" y2="92%">
        <stop offset="0%" stop-color="currentColor" stop-opacity="0.85" />
        <stop offset="100%" stop-color="currentColor" stop-opacity="0.25" />
      </linearGradient>
    </defs>

    <circle cx="12" cy="12" r="8.7" :fill="`url(#${gradientId})`" />
    <circle cx="12" cy="12" r="7.2" :fill="`url(#${coreId})`" />
    <circle cx="12" cy="12" r="8.7" :stroke="`url(#${rimId})`" stroke-width="0.9" />

    <!-- Specular highlight, then a smaller glint so it reads as glass. -->
    <ellipse
      cx="8.7"
      cy="8.2"
      rx="2.9"
      ry="1.7"
      transform="rotate(-34 8.7 8.2)"
      fill="white"
      fill-opacity="0.72"
    />
    <circle cx="15.6" cy="15.7" r="1.05" fill="white" fill-opacity="0.22" />
  </svg>
</template>
