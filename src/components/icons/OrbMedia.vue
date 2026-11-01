<script setup lang="ts">
import { computed, ref } from 'vue'
import gameOrbStill from '@/assets/orbs/orb-game.webp'
import videoOrbStill from '@/assets/orbs/orb-video.webp'
import OrbIcon from './OrbIcon.vue'

/**
 * Discord's Orbs artwork. The still is bundled so the icon never depends on the
 * network; the animation streams from Discord's own CDN, which is the same host
 * the quest rows already load app icons from.
 *
 * `animated` is opt-in: a quest list can hold dozens of orbs, and one looping
 * video per row would cost more than the motion is worth.
 */
const props = withDefaults(defineProps<{ kind?: 'game' | 'video'; animated?: boolean }>(), {
  kind: 'game',
  animated: false,
})

const CDN = 'https://cdn.discordapp.com/assets/content'

const artwork = {
  game: {
    still: gameOrbStill,
    video: `${CDN}/864e5841fd9af8da3c50ad6d6220bee54e8c2da2d36d3c85d0a5ae95cdbf095e.webm`,
  },
  video: {
    still: videoOrbStill,
    video: `${CDN}/d4fc1c99b3e3044530f08ede0156d1d43a13bf78f0f539e240b63f2d4dad3554.webm`,
  },
} as const

const still = computed(() => artwork[props.kind ?? 'game'].still)
const video = computed(() => artwork[props.kind ?? 'game'].video)

const mediaFailed = ref(false)
const reduceMotion = typeof window !== 'undefined'
  && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

const showVideo = computed(() => props.animated && !mediaFailed.value && !reduceMotion)
</script>

<template>
  <video
    v-if="showVideo"
    :src="video"
    :poster="still"
    autoplay
    loop
    muted
    playsinline
    preload="metadata"
    aria-hidden="true"
    class="h-full w-full rounded-[26%] object-contain"
    @error="mediaFailed = true"
  />
  <img
    v-else-if="!mediaFailed"
    :src="still"
    alt=""
    aria-hidden="true"
    class="h-full w-full rounded-[26%] object-contain"
    @error="mediaFailed = true"
  />
  <OrbIcon v-else class="h-full w-full" />
</template>
