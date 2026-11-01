<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
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

// The still and the clip fail independently: a codec the WebView refuses must
// fall back to the bundled image, not all the way to the drawn icon.
const videoFailed = ref(false)
const stillFailed = ref(false)

const reduceMotion = ref(false)
const motionQuery = typeof window !== 'undefined'
  ? window.matchMedia?.('(prefers-reduced-motion: reduce)')
  : undefined
if (motionQuery) {
  reduceMotion.value = motionQuery.matches
  const onChange = (event: MediaQueryListEvent) => {
    reduceMotion.value = event.matches
  }
  motionQuery.addEventListener('change', onChange)
  onUnmounted(() => motionQuery.removeEventListener('change', onChange))
}

const showVideo = computed(
  () => props.animated && !reduceMotion.value && !videoFailed.value,
)
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
    @error="videoFailed = true"
  />
  <img
    v-else-if="!stillFailed"
    :src="still"
    alt=""
    aria-hidden="true"
    class="h-full w-full rounded-[26%] object-contain"
    @error="stillFailed = true"
  />
  <OrbIcon v-else class="h-full w-full" />
</template>
