<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Loader2, RotateCw, SlidersHorizontal } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useQuestsStore } from '@/stores/quests'
import { useToastStore } from '@/stores/toast'
import { exportSettingsPreset, applySettingsPreset } from '@/utils/settingsPreset'
import { getSuperPropertiesMode, retrySuperProperties, type SuperPropertiesModeInfo } from '@/api/tauri'
import { loadWebhookConfig, saveWebhookConfig } from '@/utils/questWebhook'
import { testQuestWebhook, type WebhookConfig } from '@/api/webhook'
import SettingRow from './SettingRow.vue'
import { navigateToTab } from '@/utils/navigate'
import SettingsSectionCard from './SettingsSectionCard.vue'
import SettingsSwitch from './SettingsSwitch.vue'
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
const toast = useToastStore()
const presetImportInput = ref<HTMLInputElement | null>(null)
const webhookConfig = ref<WebhookConfig>(loadWebhookConfig())
const webhookTesting = ref(false)
const webhookTestResult = ref<string | null>(null)

watch(webhookConfig, (config) => {
  saveWebhookConfig(config)
  webhookTestResult.value = null
}, { deep: true })

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

function downloadPreset() {
  const blob = new Blob([exportSettingsPreset()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'auto-quest-settings.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function promptPresetImport() {
  presetImportInput.value?.click()
}

function handlePresetImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      applySettingsPreset(String(reader.result))
      toast.success({ title: t('settings.preset_imported') })
      setTimeout(() => window.location.reload(), 800)
    } catch (error) {
      toast.error({ title: t('settings.preset_failed'), description: String(error) })
    }
  }
  reader.readAsText(file)
}

async function testWebhook() {
  webhookTesting.value = true
  webhookTestResult.value = null
  try {
    await testQuestWebhook(webhookConfig.value)
    webhookTestResult.value = t('settings.webhook_test_ok')
  } catch (error) {
    webhookTestResult.value = `${t('settings.webhook_test_fail')}: ${String(error)}`
  } finally {
    webhookTesting.value = false
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

        <SettingRow :label="t('settings.preset_export')" :description="t('settings.preset_export_desc')">
          <Button variant="outline" size="sm" :class="settingToneClass.primary.buttonSoft" @click="downloadPreset">
            {{ t('settings.preset_export_action') }}
          </Button>
        </SettingRow>

        <SettingRow :label="t('settings.preset_import')" :description="t('settings.preset_import_desc')">
          <Button variant="outline" size="sm" :class="settingToneClass.info.buttonSoft" @click="promptPresetImport">
            {{ t('settings.preset_import_action') }}
          </Button>
          <input
            ref="presetImportInput"
            type="file"
            accept="application/json"
            class="hidden"
            @change="handlePresetImport"
          />
        </SettingRow>

        <SettingRow :label="t('settings.webhook_enabled')" :description="t('settings.webhook_enabled_desc')">
          <SettingsSwitch v-model="webhookConfig.enabled" :label="t('settings.webhook_enabled')" />
        </SettingRow>

        <template v-if="webhookConfig.enabled">
          <SettingRow :label="t('settings.webhook_url')" :description="t('settings.webhook_url_hint')">
            <Input
              v-model="webhookConfig.url"
              type="url"
              class="h-8 w-72 bg-background font-mono text-xs"
              :placeholder="t('settings.webhook_url_placeholder')"
            />
          </SettingRow>

          <SettingRow :label="t('settings.webhook_token')" :description="t('settings.webhook_token_hint')">
            <Input
              v-model="webhookConfig.bearerToken"
              type="password"
              class="h-8 w-72 bg-background font-mono text-xs"
              :placeholder="t('settings.webhook_token_placeholder')"
            />
          </SettingRow>

          <SettingRow :label="t('settings.webhook_events')" :description="t('settings.webhook_events_desc')">
            <div class="flex items-center gap-4">
              <label class="flex items-center gap-2 text-xs">
                <SettingsSwitch v-model="webhookConfig.onComplete" :label="t('settings.webhook_on_complete')" />
                {{ t('settings.webhook_on_complete') }}
              </label>
              <label class="flex items-center gap-2 text-xs">
                <SettingsSwitch v-model="webhookConfig.onFailure" :label="t('settings.webhook_on_failure')" />
                {{ t('settings.webhook_on_failure') }}
              </label>
            </div>
          </SettingRow>

          <SettingRow :label="t('settings.webhook_test')" :description="t('settings.webhook_test_desc')">
            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                :class="settingToneClass.primary.buttonSoft"
                :disabled="webhookTesting || !webhookConfig.url.trim()"
                @click="testWebhook"
              >
                <Loader2 v-if="webhookTesting" class="h-3 w-3 animate-spin" />
                {{ t('settings.webhook_test_action') }}
              </Button>
              <span v-if="webhookTestResult" class="text-xs text-muted-foreground">{{ webhookTestResult }}</span>
            </div>
          </SettingRow>
        </template>
      </div>

  </SettingsSectionCard>
</template>
