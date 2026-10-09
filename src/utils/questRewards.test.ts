import { describe, expect, it } from 'vitest'
import type { QuestReward, QuestUserStatus } from '@/api/tauri'
import { formatQuestReward, type QuestRewardLocalizedText, type QuestRewardView } from './questRewards'

function reward(overrides: Partial<QuestReward>): QuestReward {
  return {
    type: 4,
    sku_id: 'sku',
    messages: { name: 'Reward' },
    ...overrides,
  }
}

/** Orb amounts are locale keys, never English prose, so the UI can translate them. */
function orbText(view: QuestRewardView): QuestRewardLocalizedText {
  const { amount } = view
  if (amount.type !== 'text') throw new Error(`expected a localized amount, got ${amount.type}`)
  return amount.text
}

describe('formatQuestReward', () => {
  it('shows Nitro multiplier when user has Nitro and premium Orbs exceed base', () => {
    const view = formatQuestReward(reward({ orb_quantity: 700, premium_orb_quantity: 840 }), null, 2)

    expect(view.kind).toBe('orbs')
    expect(orbText(view)).toEqual({ key: 'quest.reward_orbs_premium', params: { base: '700', premium: '840' } })
    expect(view.badge).toEqual({ key: 'quest.reward_nitro_multiplier', params: { multiplier: '1.2' } })
  })

  it('hides Nitro multiplier when user has no Nitro even if premium data exists', () => {
    const view = formatQuestReward(reward({ orb_quantity: 700, premium_orb_quantity: 840 }), null, 0)

    expect(orbText(view)).toEqual({ key: 'quest.reward_orbs', params: { count: '700' } })
    expect(view.badge).toBeNull()
  })

  it('hides Nitro multiplier when premium_type is not provided', () => {
    const view = formatQuestReward(reward({ orb_quantity: 700, premium_orb_quantity: 840 }), null)

    expect(orbText(view)).toEqual({ key: 'quest.reward_orbs', params: { count: '700' } })
    expect(view.badge).toBeNull()
  })

  it('shows only base Orbs when premium quantity is missing', () => {
    const view = formatQuestReward(reward({ orb_quantity: 700, premium_orb_quantity: null }), null, 2)

    expect(orbText(view)).toEqual({ key: 'quest.reward_orbs', params: { count: '700' } })
    expect(view.badge).toBeNull()
  })

  it('uses claimed Orbs before estimated reward text', () => {
    const status: QuestUserStatus = {
      claimed_at: '2026-06-16T00:00:00.000Z',
      orb_quantity_claimed: 840,
    }

    const view = formatQuestReward(reward({ orb_quantity: 700, premium_orb_quantity: 840 }), status, 2)

    expect(orbText(view)).toEqual({ key: 'quest.reward_orbs_claimed', params: { count: '840' } })
  })

  it('recognizes Orbs by structured type even when the name does not contain Orb', () => {
    const view = formatQuestReward(reward({
      type: 4,
      messages: { name: 'Premium currency' },
      orb_quantity: 200,
    }), null)

    expect(view.kind).toBe('orbs')
    expect(orbText(view)).toEqual({ key: 'quest.reward_orbs', params: { count: '200' } })
    expect(view.name).toBe('Premium currency')
  })

  it('falls back to the reward name key when an Orb reward carries no quantity', () => {
    const view = formatQuestReward(reward({ type: 4, orb_quantity: null }), null)

    expect(view.amount).toEqual({ type: 'name' })
  })

  it('keeps a named reward with a quantity as name plus count, not as text', () => {
    const view = formatQuestReward(reward({
      type: 2,
      asset: 'a/b.png',
      messages: { name: 'Skin' },
      quantity: 3,
    }), null)

    expect(view.kind).toBe('ingame')
    expect(view.amount).toEqual({ type: 'quantity', quantity: 3 })
    expect(view.badge).toBeNull()
  })

  it('leaves the localized name fallback to the render site', () => {
    const view = formatQuestReward(reward({ type: 1, messages: { name: '' } }), null)

    expect(view.name).toBe('')
    expect(view.amount).toEqual({ type: 'name' })
  })
})
