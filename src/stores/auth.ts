import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DiscordUser, ProgramReward, AuthProgress, AuthProgressHandler, AccountSummary } from '@/api/tauri'
import {
  detectAccounts,
  setToken,
  loginWithAccount,
  autoLoginViaCdp,
  autoFetchSuperProperties,
  getProgramRewards,
  stopAllGameSimulations,
  listAccounts,
  addAccount,
  switchAccount,
  forgetAccount,
} from '@/api/tauri'
import { useQuestsStore } from './quests'
import { useGameIdleStore } from './gameIdle'
import { useNotificationsStore } from './notifications'
import { useI18n } from 'vue-i18n'
import { useNow } from '@vueuse/core'
import { getNitroOrbsClaim } from '@/utils/nitroOrbsCountdown'
import { commandErrorMessage } from '@/utils/commandError'

export const useAuthStore = defineStore('auth', () => {
  const { t } = useI18n()
  const user = ref<DiscordUser | null>(null)
  const token = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** Accounts the local scan validated, as profiles only: the backend keeps each
   *  token, so the page selects one by Discord user id. */
  const detectedAccounts = ref<AccountSummary[]>([])
  /** Every account this run has authenticated. The backend keeps each account's
   *  API client, so switching needs the Discord user id and no second token. */
  const knownAccounts = ref<AccountSummary[]>([])

  // Discord's Program Rewards endpoint owns the monthly Orbs schedule.
  const nitroProgramReward = ref<ProgramReward | null>(null)
  const programRewardLoading = ref(false)
  const programRewardError = ref<string | null>(null)
  const programRewardLoaded = ref(false)
  const currentTime = useNow({ interval: 60_000 })
  let programRewardRequestRevision = 0

  function resetProgramRewardState() {
    programRewardRequestRevision += 1
    nitroProgramReward.value = null
    programRewardLoading.value = false
    programRewardError.value = null
    programRewardLoaded.value = false
  }

  async function tryAutoDetect(
    onProgress?: AuthProgressHandler,
    commitMultipleAccounts?: (accounts: AccountSummary[]) => void | Promise<void>,
  ) {
    loading.value = true
    error.value = null
    detectedAccounts.value = []

    try {
      const accounts = await detectAccounts(onProgress)

      if (accounts.length === 1) {
        // Only one account found, login automatically
        return await loginWithDetectedAccount(accounts[0].user.id, onProgress)
      } else {
        // Multiple accounts, let UI handle selection
        if (commitMultipleAccounts) {
          await commitMultipleAccounts(accounts)
        } else {
          detectedAccounts.value = accounts
        }
      }
      return true
    } catch (e) {
      console.error('Auto detect failed:', e)
      error.value = commandErrorMessage(e)
      return false
    } finally {
      loading.value = false
    }
  }

  async function loginWithToken(tokenValue: string, onProgress?: AuthProgressHandler) {
    return signIn((forward) => setToken(tokenValue, forward), tokenValue, onProgress)
  }

  /** Sign into an account the local scan found, addressed only by its Discord
   *  user id. This is a hard sign-in rather than `switchToAccount`: the scan
   *  leaves nothing active, and the backend still has to establish the fresh
   *  SuperProperties session a login performs. */
  async function loginWithDetectedAccount(userId: string, onProgress?: AuthProgressHandler) {
    return signIn((forward) => loginWithAccount(userId, forward), null, onProgress)
  }

  /** Shared tail of both sign-in paths: stop everything the page owns, publish
   *  the account the backend returned, then refresh the login caches. */
  async function signIn(
    authenticate: (onProgress: AuthProgressHandler) => Promise<DiscordUser>,
    rawToken: string | null,
    onProgress?: AuthProgressHandler,
  ) {
    loading.value = true
    error.value = null
    resetProgramRewardState()
    try {
      const questsStore = useQuestsStore()
      await useGameIdleStore().stopForAccountChange()
      if (user.value) {
        await stopAllGameSimulations()
        await questsStore.stop().catch(() => undefined)
        // A hard login ends every account's backend work, so the quests the
        // page no longer drives are stale the moment the command returns. The
        // panel would otherwise keep offering to stop tasks that are gone.
        questsStore.accountTasks = []
      }
      // The backend status event only reports `stopped`; drop the cached status
      // and per-account history so the UI cannot show the previous account's
      // simulation usage after signing in.
      user.value = await authenticate((progress) => {
        // The store still performs one final SuperProperties synchronization
        // after the backend command. Keep the visible operation running until
        // that existing step has settled.
        if (progress.phase !== 'complete') onProgress?.(progress)
      })
      // A detected account keeps its credential in the backend, exactly like
      // CDP auto-login, so the page has no raw token to remember.
      token.value = rawToken

      // After successful login, wait for SuperProperties fetch to complete
      // This ensures all data is ready before ending the loading state
      try {
        await autoFetchSuperProperties(questsStore.cdpPort)

        bootstrapAfterLogin(questsStore, 'CDP init on login failed:')
      } catch (e) {
        // SuperProperties fetch failure should not block login
        console.warn('Failed to fetch SuperProperties:', e)
      }

      onProgress?.(completeAuthProgress())

      return true
    } catch (e) {
      error.value = commandErrorMessage(e)
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * Log in by capturing the currently running Discord client's session over CDP
   * (the primary login path on Linux). The raw token is never exposed to the
   * frontend: the backend captures, validates, and stores it, returning only the
   * DiscordUser. Requires Discord to be running with CDP enabled.
   */
  async function loginViaCdp(onProgress?: AuthProgressHandler) {
    loading.value = true
    error.value = null
    resetProgramRewardState()
    try {
      const questsStore = useQuestsStore()
      await useGameIdleStore().stopForAccountChange()
      if (user.value) {
        await stopAllGameSimulations()
        await questsStore.stop().catch(() => undefined)
        // A hard login ends every account's backend work, so the quests the
        // page no longer drives are stale the moment the command returns. The
        // panel would otherwise keep offering to stop tasks that are gone.
        questsStore.accountTasks = []
      }
      user.value = await autoLoginViaCdp(questsStore.cdpPort, onProgress)
      // Intentionally leave `token` null: CDP auto-login never surfaces the raw
      // token. Authenticated backend commands use the client in AppState.
      token.value = null

      // CDP is available by definition here (we just used it). Keep the login
      // method and quest execution method aligned so the first quest does not
      // fall back to a previously saved simulation preference.
      questsStore.cdpAvailable = true
      questsStore.gameQuestMode = 'cdp'

      // Refresh the connection state and the rest of the post-login data.
      bootstrapAfterLogin(questsStore, 'CDP init after CDP login failed:')

      return true
    } catch (e) {
      error.value = commandErrorMessage(e)
      return false
    } finally {
      loading.value = false
    }
  }

  function completeAuthProgress(): AuthProgress {
    return {
      phase: 'complete',
      current: null,
      total: null,
      valid_accounts: null,
    }
  }

  /** Re-read the accounts the backend remembers. Only called while logged in:
   *  with no active account there is nothing to switch between. */
  async function refreshKnownAccounts() {
    if (!user.value) {
      knownAccounts.value = []
      return
    }
    knownAccounts.value = await listAccounts()
  }

  /** Sign in another account alongside the current one. Nothing about the active
   *  session changes, so the quests that are running keep running. */
  async function addKnownAccount(tokenValue: string) {
    error.value = null
    try {
      const summary = await addAccount(tokenValue.trim())
      // Re-read rather than append: the backend also stamps how many quests each
      // account is running, and an already-known id must not be listed twice.
      await refreshKnownAccounts()
      return summary
    } catch (e) {
      error.value = commandErrorMessage(e)
      return null
    }
  }

  /**
   * Make a remembered account the one the page works on, without signing out.
   *
   * This is deliberately not `loginWithToken`: that path stops every quest, while
   * a direct-API quest of the account being left keeps posting with the client it
   * captured at start. Only the page's ownership of those slots ends here. A CDP
   * quest is stopped by the backend, because the one desktop client window is
   * signed into one account and cannot drive another's session.
   */
  async function switchToAccount(userId: string) {
    if (!userId || user.value?.id === userId) return false
    loading.value = true
    error.value = null
    const questsStore = useQuestsStore()
    const previousId = user.value?.id ?? null
    try {
      const next = await switchAccount(userId)
      resetProgramRewardState()
      // Released only once the backend accepted the switch: a refusal (game idle
      // mode owns the activity slot) must leave this account's quests listed, since
      // the page is still driving them. Nothing awaits before the reset, so no poll
      // tick can run against the new account with the old account's slots.
      questsStore.resetForAccountSwitch(previousId)
      user.value = next
      // A switch never surfaces a token; the client stays in the backend, exactly
      // as with CDP auto-login.
      token.value = null
      // Home does not remount on a switch, so nothing else would repopulate the
      // list the reset just cleared; `bootstrapAfterLogin` covers the other caches.
      questsStore.fetchQuests().catch(err => {
        console.warn('Quest list fetch after account switch failed:', err)
      })
      bootstrapAfterLogin(questsStore, 'CDP init on account switch failed:')
      return true
    } catch (e) {
      error.value = commandErrorMessage(e)
      return false
    } finally {
      loading.value = false
    }
  }

  /** Stop remembering an account. The backend refuses while its quests are running,
   *  because a task would otherwise post for an account the page cannot name. */
  async function forgetKnownAccount(userId: string) {
    error.value = null
    try {
      await forgetAccount(userId)
      knownAccounts.value = knownAccounts.value.filter(item => item.user.id !== userId)
      return true
    } catch (e) {
      error.value = commandErrorMessage(e)
      return false
    }
  }

  // Keep post-login refresh work non-blocking for both authentication paths.
  function bootstrapAfterLogin(questsStore: ReturnType<typeof useQuestsStore>, cdpWarning: string) {
    refreshKnownAccounts().catch(err => {
      console.warn('Background account list fetch failed:', err)
    })
    questsStore.initCdpMode().catch(err => {
      console.warn(cdpWarning, err)
    })
    questsStore.getDetectableGames().catch(err => {
      console.warn('Background game list fetch failed:', err)
    })
    questsStore.fetchOrbsBalance().catch(err => {
      console.warn('Background Orbs balance fetch failed:', err)
    })
    fetchNitroProgramReward().catch(err => {
      console.warn('Background Nitro program reward fetch failed:', err)
    })
  }

  async function logout() {
    // Invalidate account-scoped requests before awaiting quest shutdown.
    resetProgramRewardState()

    // Stop any in-progress quest before clearing state
    const questsStore = useQuestsStore()
    try {
      await useGameIdleStore().stopForAccountChange()
      await stopAllGameSimulations()
    } catch (cause) {
      error.value = commandErrorMessage(cause)
      return
    }
    try {
      await questsStore.stop()
    } catch (e) {
      console.warn('Failed to stop quest during logout:', e)
    }

    // Clear the idle status and per-account simulation history for the account
    // being signed out. Keep the failed-logout early return above untouched so
    // an unsuccessful stop leaves the current account state intact.
    user.value = null
    token.value = null
    error.value = null
    detectedAccounts.value = []
    // Nothing is switchable to while signed out; the list is re-read from the
    // backend on the next login.
    knownAccounts.value = []

    // Reset quests store to clear all cached data from previous account
    questsStore.resetForLogout()
    useNotificationsStore().resetForAccount()
  }

  async function fetchNitroProgramReward(force = false) {
    // A forced refresh has to win over an in-flight fetch: the revision guard
    // below makes the newest request the only one that can write state, so the
    // older response is discarded instead of the user's click being dropped.
    if (!force && programRewardLoading.value) return
    if (!force && programRewardLoaded.value) return
    // CDP auto-login is authenticated on the backend but exposes no frontend
    // token, so gate on the logged-in user rather than the raw token.
    if (!user.value) return
    const requestToken = token.value
    const requestRevision = ++programRewardRequestRevision
    programRewardLoading.value = true
    programRewardError.value = null
    try {
      const rewards = await getProgramRewards()
      if (requestRevision !== programRewardRequestRevision || token.value !== requestToken) return
      nitroProgramReward.value = rewards.find(reward => {
        const program = reward.reward_program
        // Discord's official ProgramReward enum is NITRO=0, XBOX=1.
        // Keep the string forms for keyed/legacy response normalization.
        return program === 0 || program === '0' || String(program).toUpperCase() === 'NITRO'
      }) ?? null
      programRewardLoaded.value = true
    } catch (e) {
      if (requestRevision !== programRewardRequestRevision || token.value !== requestToken) return
      programRewardError.value = commandErrorMessage(e)
      console.warn('Failed to fetch Nitro program reward:', e)
    } finally {
      if (requestRevision === programRewardRequestRevision && token.value === requestToken) {
        programRewardLoading.value = false
      }
    }
  }

  // Discord supplies the authoritative absolute timestamp, so no local or
  // UTC calendar arithmetic is needed here.
  const nextOrbsClaim = computed<
    { value: number; unit: 'days' | 'hours' | 'minutes' } | null
  >(() => {
    return getNitroOrbsClaim(nitroProgramReward.value?.next_reward_date, currentTime.value)
  })

  // Localized Nitro membership status label + color class (null for non-members).
  const nitroStatus = computed<{ label: string; class: string } | null>(() => {
    const pt = user.value?.premium_type
    if (!pt || pt === 0) return null
    if (pt === 1) return { label: t('user.nitro_classic'), class: 'text-sky-700 dark:text-sky-400' }
    if (pt === 2) return { label: t('user.nitro'), class: 'text-violet-600 dark:text-violet-400' }
    if (pt === 3) return { label: t('user.nitro_basic'), class: 'text-indigo-600 dark:text-indigo-400' }
    return null
  })

  return {
    user,
    token,
    loading,
    error,
    detectedAccounts,
    knownAccounts,
    nitroProgramReward,
    programRewardLoading,
    programRewardError,
    nextOrbsClaim,
    nitroStatus,
    tryAutoDetect,
    loginWithToken,
    loginWithDetectedAccount,
    loginViaCdp,
    refreshKnownAccounts,
    addKnownAccount,
    switchToAccount,
    forgetKnownAccount,
    logout,
    fetchNitroProgramReward
  }
})
