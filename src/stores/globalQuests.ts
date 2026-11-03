import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchGlobalQuestCatalog } from '@/api/globalQuests'
import type { GlobalQuest } from '@/utils/globalQuests'

export const GLOBAL_QUEST_CACHE_TTL = 5 * 60_000

export const useGlobalQuestsStore = defineStore('globalQuests', () => {
  const quests = ref<GlobalQuest[]>([])
  const loading = ref(false)
  const hasLoaded = ref(false)
  const error = ref(false)
  const updatedAt = ref<number | null>(null)
  let inFlight: Promise<void> | null = null

  function initialize(): void {
    void refresh()
  }

  function refresh(force = false): Promise<void> {
    if (inFlight) return inFlight
    if (!force && updatedAt.value !== null && Date.now() - updatedAt.value < GLOBAL_QUEST_CACHE_TTL) {
      return Promise.resolve()
    }
    loading.value = true
    inFlight = fetchGlobalQuestCatalog()
      .then(data => {
        quests.value = data
        hasLoaded.value = true
        updatedAt.value = Date.now()
        error.value = false
      })
      .catch(() => {
        // A failed refresh keeps the previous catalogue; only the notice appears.
        error.value = true
      })
      .finally(() => {
        loading.value = false
        inFlight = null
      })
    return inFlight
  }

  return { quests, loading, hasLoaded, error, updatedAt, initialize, refresh }
})
