<script setup lang="ts">
// An orb drawn from three shapes: a wide base, a denser core and a specular
// highlight. Every layer uses the surrounding text colour, so the orb follows
// the theme and never ships a fixed currency tint inside the bundle.
</script>

<template>
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.6" fill="currentColor" fill-opacity="0.2" />
    <circle cx="12" cy="12" r="6.1" fill="currentColor" fill-opacity="0.45" />
    <circle cx="12" cy="12" r="3.6" fill="currentColor" fill-opacity="0.75" />
    <ellipse
      cx="8.9"
      cy="8.4"
      rx="2.9"
      ry="1.75"
      transform="rotate(-32 8.9 8.4)"
      fill="white"
      fill-opacity="0.55"
    />
    <circle cx="12" cy="12" r="8.6" stroke="currentColor" stroke-opacity="0.5" />
  </svg>
</template>
