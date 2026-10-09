<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { Loader2, RotateCw, SlidersHorizontal } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useQuestsStore } from '@/stores/quests'
import { getSuperPropertiesMode, retrySuperProperties, type SuperPropertiesModeInfo } from '@/api/tauri'
import SettingRow from './SettingRow.vue'
import { navigateToTab } from '@/utils/navigate'
import SettingsSectionCard from './SettingsSectionCard.vue'
import { cn } from '@/lib/utils'
import { settingToneClass, type SettingsTone } from './settingTones'
import { isDebugModeEnabled } from '@/utils/debugMode'

type SuperPropsReadState = 'loading' | 'ready' | 'unavailable'

function goToPortSection() {
  navigateToTab('settings', 'discord_integration')
  nextTick(() => {
    setTimeout(() => {
      document.getElementById('custom-port-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  })
}

const { t } = useI18n()
const questsStore = useQuestsStore()

const superPropsMode = ref<SuperPropertiesModeInfo | null>(null)
const superPropsReadState = ref<SuperPropsReadState>('loading')
const retryingMode = ref(false)
const debugModeEnabled = ref(isDebugModeEnabled())

const superPropsTone = computed<SettingsTone>(() => {
  if (superPropsReadState.value !== 'ready') return 'neutral'
  if (superPropsMode.value?.mode === 'cdp') return 'success'
  if (superPropsMode.value?.mode === 'remote_js') return 'warning'
  return 'danger'
})

const superPropsLabel = computed<string>(() => {
  if (superPropsReadState.value === 'loading') return t('general.loading')
  if (superPropsReadState.value === 'unavailable') return t('settings.super_props_mode_unknown')
  switch (superPropsMode.value?.mode) {
    case 'cdp':
      return 'CDP'
    case 'remote_js':
      return t('settings.remote_js')
    default:
      return t('settings.default_mode')
  }
})

const developerModeTone = computed<SettingsTone>(() => debugModeEnabled.value ? 'success' : 'neutral')

async function loadSuperPropsMode() {
  try {
    superPropsMode.value = await getSuperPropertiesMode()
    superPropsReadState.value = 'ready'
  } catch (e) {
    console.error('Failed to get SuperProperties mode:', e)
    superPropsMode.value = null
    superPropsReadState.value = 'unavailable'
  }
}

async function retrySuperProps() {
  retryingMode.value = true
  try {
    await retrySuperProperties(questsStore.cdpPort)
    await loadSuperPropsMode()
  } catch (e) {
    console.error('Retry failed:', e)
  } finally {
    retryingMode.value = false
  }
}

onMounted(async () => {
  debugModeEnabled.value = isDebugModeEnabled()
  await loadSuperPropsMode()
})
</script>

<template>
  <SettingsSectionCard
    :title="t('settings.advanced_title')"
    :description="t('settings.advanced_desc')"
    :icon="SlidersHorizontal"
    tone="warning"
    content-class="space-y-5"
  >
      <div class="rounded-lg border px-4">
        <SettingRow :label="t('settings.cdp_port')" :description="t('settings.cdp_port_hint')">
          <div class="flex items-center gap-2">
            <Badge variant="outline" class="border-primary/40 bg-primary/10 font-mono text-primary">
              {{ questsStore.cdpPort }}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              :class="settingToneClass.primary.buttonSoft"
              @click="goToPortSection"
            >
              {{ t('settings.edit_port') }}
            </Button>
          </div>
        </SettingRow>

        <SettingRow :label="t('settings.super_props_mode')" :description="t('settings.super_props_mode_desc')">
          <div class="flex items-center gap-2">
            <Badge
              variant="outline"
              :class="settingToneClass[superPropsTone].badge"
            >
              {{ superPropsLabel }}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              :aria-label="t('settings.super_props_mode_desc')"
              :class="cn('h-7 gap-1 px-2', settingToneClass.info.buttonSoft)"
              @click="retrySuperProps"
              :disabled="retryingMode"
            >
              <Loader2 v-if="retryingMode" class="h-3 w-3 animate-spin" />
              <RotateCw v-else class="h-3 w-3" />
            </Button>
          </div>
        </SettingRow>

        <SettingRow :label="t('settings.developer_mode')" :description="t('settings.developer_mode_desc')">
          <Badge variant="outline" :class="settingToneClass[developerModeTone].badge">
            {{ debugModeEnabled ? t('settings.debug_already_unlocked') : t('settings.developer_mode_locked') }}
          </Badge>
        </SettingRow>
      </div>

  </SettingsSectionCard>
</template>
