import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type UiDensity = 'comfortable' | 'compact'

const STORAGE_KEY = 'aqc_ui_density'

export const useUiStore = defineStore('ui', () => {
  const saved = localStorage.getItem(STORAGE_KEY)
  const density = ref<UiDensity>(saved === 'compact' ? 'compact' : 'comfortable')

  watch(density, (value) => {
    localStorage.setItem(STORAGE_KEY, value)
  }, { flush: 'sync' })

  function setDensity(value: UiDensity) {
    density.value = value
  }

  return { density, setDensity }
})
