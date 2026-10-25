<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { DetectableGame } from '@/api/tauri'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Loader2, Gamepad2, Search, RefreshCw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useQuestsStore } from '@/stores/quests'
import { commandErrorMessage } from '@/utils/commandError'
import { getSimulationExecutables } from '@/utils/executables'

const { t } = useI18n()
const store = useQuestsStore()

withDefaults(defineProps<{
  disabled?: boolean
}>(), {
  disabled: false,
})

// Count executables the simulator can actually launch on this platform (Linux:
// native `linux` only; Windows/macOS: win32) so the badge's "0 executables"
// warning matches what the Game Simulator will accept.
function compatibleExeCount(game: DetectableGame): number | null {
  const capabilities = store.platformCapabilities
  if (!capabilities) return null
  return getSimulationExecutables(
    game.executables,
    capabilities.os,
    capabilities.executableOsPriority
  ).length
}

const emit = defineEmits<{
  select: [game: DetectableGame]
}>()

const games = ref<DetectableGame[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const searchQuery = ref('')
const refreshing = ref(false)

// Limit displayed games to avoid performance issues with large lists
const DISPLAY_LIMIT = 50

const filteredGames = computed(() => {
  if (!searchQuery.value) {
    return games.value.slice(0, DISPLAY_LIMIT)
  }

  const query = searchQuery.value.toLowerCase()
  return games.value
    .filter(g => g.name.toLowerCase().includes(query))
    .slice(0, DISPLAY_LIMIT)
})

function pick(game: DetectableGame) {
  emit('select', game)
}

async function loadGames(force = false) {
  loading.value = true
  if (force) refreshing.value = true
  error.value = null
  try {
    games.value = await store.getDetectableGames(force)
  } catch (e) {
    error.value = commandErrorMessage(e)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

onMounted(async () => {
  await loadGames()
})
</script>

<template>
  <Card class="flex h-[600px] max-h-[calc(100vh-11rem)] flex-col bg-card">
    <CardHeader>
       <CardTitle class="text-lg flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <Gamepad2 class="w-5 h-5"/>
          {{ t('game_sim.select_title') }}
        </div>
        <Button 
          variant="ghost" 
          size="icon" 
          class="h-8 w-8" 
          @click="loadGames(true)"
          :disabled="loading || disabled"
          :aria-label="t('general.refresh')"
        >
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': refreshing }" />
        </Button>
      </CardTitle>
      <div class="relative mt-2">
        <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          v-model="searchQuery"
          :placeholder="t('game_sim.search')"
          :aria-label="t('game_sim.search')"
          class="pl-9"
          :disabled="disabled"
        />
      </div>
    </CardHeader>
    
    <CardContent class="flex-1 overflow-hidden p-0 px-6 pb-6">
      <div v-if="loading && games.length === 0" class="flex justify-center py-8">
        <Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
      
      <div v-else-if="error" class="p-3 bg-destructive/10 text-error rounded-md text-sm">
        {{ error }}
      </div>

      <div v-else-if="games.length === 0" class="text-center py-8 text-muted-foreground">
        {{ t('game_sim.no_games_found') }}
      </div>

      <div v-else-if="filteredGames.length === 0" class="text-center py-8 text-muted-foreground">
        {{ t('game_sim.no_match') }}
      </div>

      <div v-else class="space-y-2 h-full overflow-y-auto pr-2">
        <!-- Games this app has been used with, above the alphabetical head of the
             list so a repeat session does not have to search for the same game. -->
        <div v-if="!searchQuery && store.recentGames.length > 0" class="space-y-1.5 pb-1">
          <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            {{ t('game_sim.recent') }}
          </p>
          <div class="flex flex-wrap gap-1.5">
            <Button
              v-for="game in store.recentGames"
              :key="game.id"
              variant="outline"
              size="sm"
              class="h-7 max-w-[14rem] gap-1.5 px-2 text-xs"
              :disabled="disabled"
              :title="game.name"
              @click="pick(game)"
            >
              <img
                v-if="game.icon"
                :src="`https://cdn.discordapp.com/app-icons/${game.id}/${game.icon}.png?size=32`"
                alt=""
                loading="lazy"
                class="h-4 w-4 shrink-0 rounded"
                @error="(e) => (e.target as HTMLImageElement).style.display = 'none'"
              />
              <Gamepad2 v-else class="h-4 w-4 shrink-0 text-muted-foreground/60" />
              <span class="min-w-0 truncate">{{ game.name }}</span>
            </Button>
          </div>
        </div>

        <Button
          v-for="game in filteredGames" 
          :key="game.id"
          variant="secondary"
          class="w-full justify-start h-auto py-3 px-4 items-center gap-3 shrink-0"
          :disabled="disabled"
          @click="pick(game)"
        >
          <!-- Icon -->
          <div class="relative w-10 h-10 rounded-md overflow-hidden bg-muted/50 shrink-0">
             <img 
               v-if="game.icon"
               :src="`https://cdn.discordapp.com/app-icons/${game.id}/${game.icon}.png?size=64`"
               alt=""
               loading="lazy"
               class="w-full h-full object-cover"
               @error="(e) => (e.target as HTMLImageElement).style.display = 'none'"
             />
             <Gamepad2 v-else class="w-5 h-5 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/50" />
          </div>

          <div class="flex flex-col items-start gap-1 flex-1 min-w-0">
            <div class="flex items-center gap-2 w-full">
               <span class="font-bold truncate">{{ game.name }}</span>
               <Badge variant="outline" class="text-[10px] h-5 px-1.5 shrink-0" :class="game.type_name === 'Game' ? 'border-primary/50 text-primary' : 'border-muted-foreground/50 text-muted-foreground'">
                 {{ game.type_name === 'App' ? t('game_sim.type_app') : t('game_sim.type_game') }}
               </Badge>
            </div>
            <div
              v-if="compatibleExeCount(game) !== null"
              class="text-xs font-normal"
              :class="compatibleExeCount(game) === 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'"
            >
              {{ t('game_sim.exe_count', { count: compatibleExeCount(game) }) }}
            </div>
          </div>
        </Button>
        <div v-if="filteredGames.length < games.length && !loading && !searchQuery" class="text-center text-xs text-muted-foreground pt-4">
           {{ t('game_sim.showing_top', { count: DISPLAY_LIMIT }) }}
        </div>
      </div>
    </CardContent>
  </Card>
</template>


