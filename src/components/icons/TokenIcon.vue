<script setup lang="ts">
// Generic "reward token": a ring with a spark. currentColor lets the surrounding
// theme decide the tint, so no purple currency glyph ships inside the bundle.
</script>

<template>
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" />
    <path
      d="M12 7.1l1.5 3.4 3.4 1.5-3.4 1.5-1.5 3.4-1.5-3.4L7.1 12l3.4-1.5z"
      fill="currentColor"
    />
  </svg>
</template>
