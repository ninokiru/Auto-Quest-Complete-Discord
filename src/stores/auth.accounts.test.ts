import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AccountSummary, DiscordUser } from '@/api/tauri'
import { useAuthStore } from './auth'

const mocks = vi.hoisted(() => ({
  autoDetectToken: vi.fn(),
  autoLoginViaCdp: vi.fn(),
  setToken: vi.fn(),
  autoFetchSuperProperties: vi.fn(),
  getProgramRewards: vi.fn(),
  stopAllGameSimulations: vi.fn(),
  listAccounts: vi.fn(),
  addAccount: vi.fn(),
  switchAccount: vi.fn(),
  forgetAccount: vi.fn(),
  questsStore: {
    cdpPort: 9223,
    cdpAvailable: false,
    gameQuestMode: 'simulate',
    initCdpMode: vi.fn(),
    getDetectableGames: vi.fn(),
    fetchOrbsBalance: vi.fn(),
    // The switch path chains `.catch()` on it, so it has to hand back a promise.
    fetchQuests: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    resetForLogout: vi.fn(),
    resetForAccountSwitch: vi.fn(),
    startIdleRefresh: vi.fn(),
  },
  gameIdleStore: {
    stopForAccountChange: vi.fn(),
  },
}))

vi.mock('@/api/tauri', () => ({
  autoDetectToken: mocks.autoDetectToken,
  autoLoginViaCdp: mocks.autoLoginViaCdp,
  setToken: mocks.setToken,
  autoFetchSuperProperties: mocks.autoFetchSuperProperties,
  getProgramRewards: mocks.getProgramRewards,
  stopAllGameSimulations: mocks.stopAllGameSimulations,
  listAccounts: mocks.listAccounts,
  addAccount: mocks.addAccount,
  switchAccount: mocks.switchAccount,
  forgetAccount: mocks.forgetAccount,
}))

// The real quests store reads `localStorage` during setup, which the node test
// environment does not provide; only the account-switch handover is reached here.
vi.mock('./quests', () => ({
  useQuestsStore: () => mocks.questsStore,
}))

vi.mock('./gameIdle', () => ({
  useGameIdleStore: () => mocks.gameIdleStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@vueuse/core', () => ({
  useNow: () => ({ value: new Date('2026-08-31T00:00:00.000Z') }),
}))

const user: DiscordUser = {
  id: '123',
  username: 'quest-user',
  discriminator: '0',
  avatar: null,
  global_name: 'Quest User',
}

const otherUser: DiscordUser = {
  id: '456',
  username: 'second-user',
  discriminator: '0',
  avatar: null,
  global_name: 'Second User',
}

function summary(of: DiscordUser, runningQuests = 0): AccountSummary {
  return { user: of, active: of === user, runningQuests }
}

describe('known account management', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mocks.listAccounts.mockResolvedValue([])
    mocks.addAccount.mockResolvedValue(summary(otherUser))
    mocks.switchAccount.mockResolvedValue(otherUser)
    mocks.forgetAccount.mockResolvedValue(undefined)
    mocks.getProgramRewards.mockResolvedValue([])
    mocks.questsStore.initCdpMode.mockResolvedValue(undefined)
    mocks.questsStore.getDetectableGames.mockResolvedValue(undefined)
    mocks.questsStore.fetchOrbsBalance.mockResolvedValue(undefined)
    mocks.questsStore.resetForAccountSwitch.mockResolvedValue(undefined)
  })

  it('re-reads the accounts the backend remembers while signed in', async () => {
    const authStore = useAuthStore()
    authStore.user = user
    mocks.listAccounts.mockResolvedValue([summary(user), summary(otherUser)])

    await authStore.refreshKnownAccounts()

    expect(mocks.listAccounts).toHaveBeenCalled()
    expect(authStore.knownAccounts.map(account => account.user.id)).toEqual(['123', '456'])
  })

  it('clears the account list and skips the backend while signed out', async () => {
    const authStore = useAuthStore()
    authStore.knownAccounts = [summary(user)]

    await authStore.refreshKnownAccounts()

    expect(authStore.knownAccounts).toEqual([])
    expect(mocks.listAccounts).not.toHaveBeenCalled()
  })

  it('returns the added account and re-reads the list instead of appending it', async () => {
    const authStore = useAuthStore()
    authStore.user = user
    const backendList = [summary(user), summary(otherUser, 2)]
    mocks.listAccounts.mockResolvedValue(backendList)

    await expect(authStore.addKnownAccount('  raw-token  ')).resolves.toEqual(summary(otherUser))

    // The backend counts each account's running quests, so the list is re-read.
    expect(mocks.addAccount).toHaveBeenCalledWith('raw-token')
    expect(authStore.knownAccounts).toEqual(backendList)
    expect(authStore.error).toBeNull()
  })

  it('reports an account the backend refuses to add', async () => {
    const authStore = useAuthStore()
    mocks.addAccount.mockRejectedValue({ message: 'That token is already in use.' })

    await expect(authStore.addKnownAccount('duplicate-token')).resolves.toBeNull()

    expect(authStore.error).toBe('That token is already in use.')
    expect(mocks.listAccounts).not.toHaveBeenCalled()
  })

  it('refuses a switch to an empty account id', async () => {
    const authStore = useAuthStore()
    authStore.user = user

    await expect(authStore.switchToAccount('')).resolves.toBe(false)

    expect(mocks.switchAccount).not.toHaveBeenCalled()
    expect(mocks.questsStore.resetForAccountSwitch).not.toHaveBeenCalled()
  })

  it('refuses a switch to the account that is already active', async () => {
    const authStore = useAuthStore()
    authStore.user = user

    await expect(authStore.switchToAccount('123')).resolves.toBe(false)

    expect(mocks.switchAccount).not.toHaveBeenCalled()
    expect(mocks.questsStore.resetForAccountSwitch).not.toHaveBeenCalled()
    expect(authStore.user?.id).toBe('123')
  })

  it('releases the quest slots only after the backend accepts the switch', async () => {
    const authStore = useAuthStore()
    authStore.user = user
    authStore.token = 'active-account-token'
    mocks.listAccounts.mockResolvedValue([summary(user), summary(otherUser)])

    await expect(authStore.switchToAccount('456')).resolves.toBe(true)

    // The handover follows the command: a refused switch must leave this account's
    // quests listed, because the page is still driving them.
    expect(mocks.switchAccount.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.questsStore.resetForAccountSwitch.mock.invocationCallOrder[0])
    expect(mocks.questsStore.resetForAccountSwitch).toHaveBeenCalledWith('123')
    expect(authStore.user?.id).toBe('456')
    // A switch never surfaces a token; the client stays in the backend.
    expect(authStore.token).toBeNull()
    // The reset cleared the quest list, so the switch itself asks for it again.
    expect(mocks.questsStore.fetchQuests).toHaveBeenCalled()
    // The idle refresh belongs to the app, not to one account: it keeps running.
    expect(mocks.questsStore.startIdleRefresh).not.toHaveBeenCalled()
    expect(authStore.knownAccounts.map(account => account.user.id)).toEqual(['123', '456'])
    expect(authStore.loading).toBe(false)
  })

  it('stamps a switch with no previous account as a null leaving id', async () => {
    const authStore = useAuthStore()

    await expect(authStore.switchToAccount('456')).resolves.toBe(true)

    expect(mocks.questsStore.resetForAccountSwitch).toHaveBeenCalledWith(null)
  })

  it('reports a refused switch and keeps the page on its own quests', async () => {
    const authStore = useAuthStore()
    authStore.user = user
    mocks.switchAccount.mockRejectedValue({ message: 'Game idle mode owns the activity slot.' })

    await expect(authStore.switchToAccount('456')).resolves.toBe(false)

    expect(authStore.error).toBe('Game idle mode owns the activity slot.')
    expect(authStore.loading).toBe(false)
    expect(mocks.questsStore.startIdleRefresh).not.toHaveBeenCalled()
    // Nothing was handed over: the slots still belong to the account in place.
    expect(mocks.questsStore.resetForAccountSwitch).not.toHaveBeenCalled()
    expect(mocks.questsStore.fetchQuests).not.toHaveBeenCalled()
    expect(authStore.user?.id).toBe('123')
  })

  it('drops a forgotten account from the list', async () => {
    const authStore = useAuthStore()
    authStore.knownAccounts = [summary(user), summary(otherUser)]

    await expect(authStore.forgetKnownAccount('456')).resolves.toBe(true)

    expect(mocks.forgetAccount).toHaveBeenCalledWith('456')
    expect(authStore.knownAccounts.map(account => account.user.id)).toEqual(['123'])
  })

  it('keeps the row and reports why forgetting was refused', async () => {
    const authStore = useAuthStore()
    authStore.knownAccounts = [summary(user), summary(otherUser, 2)]
    mocks.forgetAccount.mockRejectedValue({ message: 'Stop its running quests first.' })

    await expect(authStore.forgetKnownAccount('456')).resolves.toBe(false)

    expect(authStore.error).toBe('Stop its running quests first.')
    expect(authStore.knownAccounts.map(account => account.user.id)).toEqual(['123', '456'])
  })
})
