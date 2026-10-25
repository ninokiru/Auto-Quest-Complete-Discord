<script setup lang="ts">
import { onMounted } from 'vue'
import AccountSettings from '@/components/settings/AccountSettings.vue'
import AdvancedSettings from '@/components/settings/AdvancedSettings.vue'
import AppearanceSettings from '@/components/settings/AppearanceSettings.vue'
import AboutSettings from '@/components/settings/AboutSettings.vue'
import DiagnosticsSettings from '@/components/settings/DiagnosticsSettings.vue'
import DiscordIntegrationSettings from '@/components/settings/DiscordIntegrationSettings.vue'
import QuestBehaviorSettings from '@/components/settings/QuestBehaviorSettings.vue'
import SettingsNav from '@/components/settings/SettingsNav.vue'
import SettingsOverview from '@/components/settings/SettingsOverview.vue'
import { useSettingsNavigation } from '@/composables/useSettingsNavigation'
import { useQuestsStore } from '@/stores/quests'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const questsStore = useQuestsStore()
const { selectedSection, setSection } = useSettingsNavigation()

const emit = defineEmits<{
  'navigate-to-home': []
  'debug-unlocked': []
  'debug-disabled': []
}>()

onMounted(() => {
  questsStore.initCdpMode().catch(err => {
    console.warn('CDP init failed:', err)
  })
})
</script>

<template>
  <div class="settings-view fade-in space-y-6 select-none">
    <div class="space-y-2">
      <h2 class="text-2xl font-bold tracking-tight">{{ t('settings.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('settings.control_center_desc') }}</p>
    </div>

    <SettingsOverview @select-section="setSection" />

    <div class="grid gap-6 lg:grid-cols-[220px_1fr] lg:items-start">
      <SettingsNav :selected="selectedSection" @update:selected="setSection" />

      <div class="min-w-0">
        <div class="settings-section-swap" :key="selectedSection">
          <AccountSettings
            v-if="selectedSection === 'account'"
            key="account"
            @navigate-to-home="emit('navigate-to-home')"
          />
          <QuestBehaviorSettings v-else-if="selectedSection === 'quest_behavior'" key="quest_behavior" />
          <DiscordIntegrationSettings v-else-if="selectedSection === 'discord_integration'" key="discord_integration" />
          <AppearanceSettings v-else-if="selectedSection === 'appearance'" key="appearance" />
          <DiagnosticsSettings v-else-if="selectedSection === 'diagnostics'" key="diagnostics" />
          <AdvancedSettings v-else-if="selectedSection === 'advanced'" key="advanced" />
          <AboutSettings
            v-else
            key="about"
            @debug-unlocked="emit('debug-unlocked')"
            @debug-disabled="emit('debug-disabled')"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The section swap used to be a keyed <Transition mode="out-in">. Vue measures
   the outgoing node through its root element, and DiscordIntegrationSettings is
   fragment-rooted (AlertDialog + card), so leaving that section never reported a
   finished transition and the content column stayed empty for every section
   after it. A CSS animation on the re-keyed wrapper cannot stall: the panel is
   painted as soon as it exists. */
.settings-section-swap {
  animation: settings-section-in 160ms ease-out both;
}

@keyframes settings-section-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-section-swap {
    animation: none;
  }
}
</style>
