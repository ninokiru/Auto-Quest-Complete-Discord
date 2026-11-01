<script setup lang="ts">
import { computed, ref } from 'vue'
import gameOrbStill from '@/assets/orbs/orb-game.webp'
import gameOrbVideo from '@/assets/orbs/orb-game.webm'
import videoOrbStill from '@/assets/orbs/orb-video.webp'
import videoOrbVideo from '@/assets/orbs/orb-video.webm'
import OrbIcon from './OrbIcon.vue'

/**
 * Discord's Orbs artwork, bundled with the app so nothing here depends on the
 * network: the still is the poster, the animation a short looping clip.
 *
 * `animated` is opt-in: a quest list can hold dozens of orbs, and one looping
 * video per row would cost more than the motion is worth.
 */
const props = withDefaults(defineProps<{ kind?: 'game' | 'video'; animated?: boolean }>(), {
  kind: 'game',
  animated: false,
})

const artwork = {
  game: { still: gameOrbStill, video: gameOrbVideo },
  video: { still: videoOrbStill, video: videoOrbVideo },
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
