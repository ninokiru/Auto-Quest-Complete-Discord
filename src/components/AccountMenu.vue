<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useQuestsStore } from '@/stores/quests'
import type { AccountSummary, DiscordUser } from '@/api/tauri'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Check, ChevronDown, Loader2, LogOut, Search, UserPlus, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const authStore = useAuthStore()
const questsStore = useQuestsStore()
const emit = defineEmits<{ logout: [] }>()

const user = computed(() => authStore.user)
const open = ref(false)
const switching = ref(false)
const removingId = ref<string | null>(null)
const adding = ref(false)
const addingAccount = ref(false)
const scanning = ref(false)
const newToken = ref('')
const menuError = ref<string | null>(null)
const containerRef = ref<HTMLElement | null>(null)

const accounts = computed(() => authStore.knownAccounts)
const busy = computed(() => switching.value || authStore.loading)

// The scan reads the desktop clients' local profiles, which the backend only
// reports as `full` where that is possible. The login screen hides its
// auto-detect button under the same rule, so the switcher must not offer a scan
// that can only fail.
const canScan = computed(() => questsStore.platformCapabilities?.tokenAutoDetection === 'full')

function avatarUrlFor(target: DiscordUser): string | null {
  if (!target.avatar) return null
  return `https://cdn.discordapp.com/avatars/${target.id}/${target.avatar}.png?size=128`
}

const triggerAvatar = computed(() => (user.value ? avatarUrlFor(user.value) : null))

function nameOf(summary: AccountSummary): string {
  return summary.user.global_name || summary.user.username
}

function runningLabel(summary: AccountSummary): string {
  return summary.runningQuests > 0
    ? t('account.running_quests', { count: summary.runningQuests })
    : t('account.idle')
}

function toggleOpen() {
  open.value = !open.value
  menuError.value = null
  if (!open.value) return
  // Each row's running count is the backend's, not this page's: a quest of an
  // account that is not shown keeps advancing in the background.
  void authStore.refreshKnownAccounts().catch(() => undefined)
}

async function handleSwitch(summary: AccountSummary) {
  if (summary.active || busy.value) return
  switching.value = true
  menuError.value = null
  const switched = await authStore.switchToAccount(summary.user.id)
  switching.value = false
  if (switched) {
    open.value = false
    return
  }
  // A refused switch (game idle mode owns the activity slot) is only actionable
  // while the account list is still on screen, so the menu stays open.
  menuError.value = authStore.error
}

async function handleForget(summary: AccountSummary) {
  removingId.value = summary.user.id
  menuError.value = null
  const removed = await authStore.forgetKnownAccount(summary.user.id)
  removingId.value = null
  if (!removed) menuError.value = authStore.error
}

async function handleScan() {
  if (scanning.value || busy.value) return
  scanning.value = true
  menuError.value = null
  const found = await authStore.scanKnownAccounts()
  scanning.value = false
  if (!found) menuError.value = authStore.error
}

async function handleAdd() {
  const tokenValue = newToken.value.trim()
  if (!tokenValue || addingAccount.value) return
  addingAccount.value = true
  menuError.value = null
  const added = await authStore.addKnownAccount(tokenValue)
  addingAccount.value = false
  if (!added) {
    menuError.value = authStore.error
    return
  }
  newToken.value = ''
  adding.value = false
}

function closeAddForm() {
  adding.value = false
  newToken.value = ''
  menuError.value = null
}

function handleClickOutside(e: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

function handleLogout() {
  open.value = false
  emit('logout')
}

onMounted(() => document.addEventListener('mousedown', handleClickOutside))
onUnmounted(() => document.removeEventListener('mousedown', handleClickOutside))
</script>

<template>
  <div v-if="user" ref="containerRef" class="relative">
    <!-- Trigger button — pure HTML, no Radix wrapper -->
    <button
      class="h-10 px-2 rounded-lg inline-flex items-center gap-2 hover:bg-muted/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <Avatar class="w-8 h-8 shrink-0">
        <AvatarImage v-if="triggerAvatar" :src="triggerAvatar" :alt="user.username" />
        <AvatarFallback>{{ user.username[0].toUpperCase() }}</AvatarFallback>
      </Avatar>

      <span class="hidden md:inline-flex flex-col items-start min-w-0 leading-tight">
        <span class="text-sm font-medium max-w-[120px] truncate">
          {{ user.global_name || user.username }}
        </span>
        <span class="text-xs text-muted-foreground max-w-[120px] truncate">
          @{{ user.username }}
        </span>
      </span>

      <ChevronDown
        class="w-4 h-4 text-muted-foreground shrink-0 hidden md:block transition-transform"
        :class="open && 'rotate-180'"
      />
    </button>

    <!-- Dropdown content — positioned absolutely, no Radix portal -->
    <Transition
      enter-active-class="transition ease-out duration-150"
      enter-from-class="opacity-0 -translate-y-1 scale-[0.98]"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition ease-in duration-100"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 -translate-y-1 scale-[0.98]"
    >
      <div
        v-if="open"
        class="absolute right-0 top-full mt-2 z-50 w-[17rem] origin-top-right overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
      >
        <div class="max-h-[min(60vh,20rem)] overflow-y-auto p-1">
          <p class="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            {{ t('account.switch_title') }}
          </p>

          <div
            v-for="summary in accounts"
            :key="summary.user.id"
            class="group flex items-center gap-2.5 rounded-md p-2 transition-colors"
            :class="summary.active ? 'bg-primary/5' : 'hover:bg-muted/60'"
          >
            <Avatar class="h-7 w-7 shrink-0">
              <AvatarImage
                v-if="avatarUrlFor(summary.user)"
                :src="avatarUrlFor(summary.user)!"
                :alt="summary.user.username"
              />
              <AvatarFallback class="text-[11px] font-semibold">
                {{ summary.user.username[0].toUpperCase() }}
              </AvatarFallback>
            </Avatar>

            <button
              class="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :disabled="summary.active || busy"
              @click="handleSwitch(summary)"
            >
              <span class="flex items-center gap-1.5">
                <span class="truncate text-xs font-semibold">{{ nameOf(summary) }}</span>
                <Check v-if="summary.active" class="h-3.5 w-3.5 shrink-0 text-primary" />
              </span>
              <span
                class="mt-0.5 block truncate text-[10px] text-muted-foreground/80"
                :class="summary.active && 'text-primary/80'"
              >
                {{ summary.active ? t('account.active') : runningLabel(summary) }}
              </span>
            </button>

            <button
              v-if="!summary.active"
              class="h-6 w-6 shrink-0 rounded text-muted-foreground/70 opacity-0 transition-all hover:bg-destructive/10 hover:text-error focus-visible:opacity-100 group-hover:opacity-100"
              :aria-label="t('account.remove')"
              :disabled="removingId === summary.user.id || busy"
              @click="handleForget(summary)"
            >
              <Loader2 v-if="removingId === summary.user.id" class="mx-auto h-3.5 w-3.5 animate-spin" />
              <X v-else class="mx-auto h-3.5 w-3.5" />
            </button>
          </div>

          <button
            v-if="!adding"
            class="mt-1 flex w-full items-center gap-2.5 rounded-md p-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            @click="adding = true"
          >
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-border">
              <UserPlus class="h-3.5 w-3.5" />
            </span>
            {{ t('account.add') }}
          </button>

          <div v-else class="mt-1 rounded-md bg-muted/50 p-2">
            <p class="text-[10px] leading-relaxed text-pretty text-muted-foreground">
              {{ t('account.add_hint') }}
            </p>
            <form class="mt-2 space-y-1.5" @submit.prevent="handleAdd">
              <Input
                v-model="newToken"
                type="password"
                :placeholder="t('auth.enter_token')"
                :disabled="addingAccount"
                class="h-8 bg-background text-xs"
              />
              <div class="flex items-center gap-1.5">
                <Button
                  type="submit"
                  size="sm"
                  class="h-7 flex-1 gap-1.5 text-xs"
                  :disabled="!newToken.trim() || addingAccount"
                >
                  <Loader2 v-if="addingAccount" class="h-3.5 w-3.5 animate-spin" />
                  {{ t('account.add_action') }}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  class="h-7 px-2 text-xs"
                  @click="closeAddForm"
                >
                  {{ t('dialog.cancel') }}
                </Button>
              </div>
            </form>
          </div>

          <!-- Sits after the v-if/v-else add-form pair: inserting it between them
             would retarget the v-else and open the token input on its own. -->
          <button
            v-if="!adding && canScan"
            class="mt-1 flex w-full items-center gap-2.5 rounded-md p-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            :disabled="scanning || busy"
            @click="handleScan"
          >
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-border">
              <Loader2 v-if="scanning" class="h-3.5 w-3.5 animate-spin" />
              <Search v-else class="h-3.5 w-3.5" />
            </span>
            {{ scanning ? t('account.scanning') : t('account.scan') }}
          </button>
        </div>

        <p
          v-if="menuError"
          class="border-t bg-destructive/5 px-2.5 py-1.5 text-[11px] leading-relaxed break-words text-error"
        >
          {{ menuError }}
        </p>

        <!-- Logout -->
        <div class="border-t border-border/60 p-1">
          <button
            class="flex w-full items-center gap-2.5 rounded-md p-2 text-left text-xs font-medium text-error outline-none transition-colors hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
            @click="handleLogout"
          >
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <LogOut class="h-3.5 w-3.5" />
            </span>
            {{ t('general.logout') }}
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
