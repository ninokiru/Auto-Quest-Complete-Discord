<script setup lang="ts">
import { Monitor, Moon, Palette, Sun } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useQuestsStore } from '@/stores/quests'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import OrbMedia from '@/components/icons/OrbMedia.vue'
import SettingsSectionCard from './SettingsSectionCard.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import { settingToneClass } from './settingTones'

const { t } = useI18n()
const questsStore = useQuestsStore()
const themeStore = useThemeStore()

// System follows the operating system and keeps following it while the window
// is open; the other two pin the palette until the user changes it.
const themeOptions: { value: ThemeMode; icon: typeof Sun; label: string }[] = [
  { value: 'system', icon: Monitor, label: 'settings.theme_system' },
  { value: 'light', icon: Sun, label: 'settings.theme_light' },
  { value: 'dark', icon: Moon, label: 'settings.theme_dark' },
]
</script>

<template>
  <SettingsSectionCard
    :title="t('settings.display')"
    :description="t('settings.display_desc')"
    :icon="Palette"
    tone="primary"
  >
    <div class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/40">
      <div class="flex min-w-0 items-start gap-3">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
          <Palette class="h-5 w-5 text-primary" />
        </div>
        <div class="min-w-0">
          <p class="text-sm font-semibold">{{ t('settings.theme') }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ t('settings.theme_desc') }}</p>
        </div>
      </div>

      <div
        class="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
        role="group"
        :aria-label="t('settings.theme')"
      >
        <Button
          v-for="option in themeOptions"
          :key="option.value"
          size="sm"
          variant="ghost"
          class="h-8 gap-1.5 px-2.5 text-xs"
          :class="themeStore.mode === option.value
            ? 'bg-background text-foreground shadow-sm hover:bg-background'
            : 'text-muted-foreground hover:text-foreground'"
          :aria-pressed="themeStore.mode === option.value"
          @click="themeStore.setMode(option.value)"
        >
          <component :is="option.icon" class="h-3.5 w-3.5" />
          {{ t(option.label) }}
        </Button>
      </div>
    </div>

    <div class="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/40">
      <div class="flex min-w-0 items-start gap-3">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
          <OrbMedia kind="game" animated class="h-8 w-8" />
        </div>
        <div class="min-w-0">
          <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {{ t('settings.show_orbs_balance') }}
            <Badge
              variant="outline"
              :class="questsStore.showOrbsBalance ? settingToneClass.success.badge : settingToneClass.neutral.badge"
            >
              {{ questsStore.showOrbsBalance ? t('settings.status_ok') : t('settings.status_attention') }}
            </Badge>
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ t('settings.show_orbs_balance_desc') }}
          </p>
        </div>
      </div>

      <SettingsSwitch v-model="questsStore.showOrbsBalance" />
    </div>
  </SettingsSectionCard>
</template>
