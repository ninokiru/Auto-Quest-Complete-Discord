<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, X, Copy } from 'lucide-vue-next'
import { useVersionStore } from '@/stores/version'

const appWindow = getCurrentWindow()
const versionStore = useVersionStore()
const isMaximized = ref(false)
let unlisten: (() => void) | null = null

onMounted(async () => {
  isMaximized.value = await appWindow.isMaximized()
  unlisten = await appWindow.listen('tauri://resize', async () => {
    isMaximized.value = await appWindow.isMaximized()
  })
})

onUnmounted(() => {
  if (unlisten) unlisten()
})

async function handleMinimize() {
  await appWindow.minimize()
}

async function handleToggleMaximize() {
  await appWindow.toggleMaximize()
}

async function handleClose() {
  await appWindow.close()
}

// Manual drag implementation per Tauri v2 docs
async function handleDragStart(e: MouseEvent) {
  // Only start dragging on left mouse button (primary)
  if (e.buttons === 1) {
    if (e.detail === 2) {
      // Double click to toggle maximize
      await appWindow.toggleMaximize()
    } else {
      // Start dragging
      await appWindow.startDragging()
    }
  }
}
</script>

<template>
  <div 
    class="h-[32px] w-full flex justify-between items-center bg-background select-none fixed top-0 left-0 z-50 border-b border-border/40"
  >
    <div 
      class="flex-1 flex items-center gap-2 px-3 h-full cursor-default"
      @mousedown="handleDragStart"
    >
        <img src="/icons/logo.png" alt="logo" class="w-4 h-4 pointer-events-none" />
        <span class="text-xs font-medium text-muted-foreground pointer-events-none">
          Discord Quest Helper <span class="opacity-70 ml-1">v{{ versionStore.currentVersion }}</span>
        </span>
    </div>

    <div class="flex h-full">
      <button 
        @click="handleMinimize" 
        class="titlebar-button hover:bg-accent hover:text-accent-foreground inline-flex items-center justify-center h-full w-[46px] transition-colors"
        tabindex="-1"
      >
        <Minus class="w-4 h-4" />
      </button>

      <button 
        @click="handleToggleMaximize" 
        class="titlebar-button hover:bg-accent hover:text-accent-foreground inline-flex items-center justify-center h-full w-[46px] transition-colors"
        tabindex="-1"
      >
        <Copy v-if="isMaximized" class="w-4 h-4 rotate-180" />
        <Square v-else class="w-3.5 h-3.5" />
      </button>

      <button 
        @click="handleClose" 
        class="titlebar-button hover:bg-destructive hover:text-white inline-flex items-center justify-center h-full w-[46px] transition-colors"
        tabindex="-1"
      >
        <X class="w-4 h-4" />
      </button>
    </div>
  </div>
  <!-- Spacer to prevent content from going under titlebar -->
  <div class="h-[32px] w-full shrink-0"></div>
</template>

<style scoped>
/* No specific styles needed thanks to tailwind */
</style>

