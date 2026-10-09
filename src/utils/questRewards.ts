import type { Quest, QuestReward, QuestUserStatus } from '@/api/tauri'

export type QuestRewardKind = 'orbs' | 'collectible' | 'ingame' | 'discord'

/**
 * Locale key plus its interpolation values. Numbers arrive pre-formatted so the
 * grouping separators stay stable across the several call sites that resolve it.
 */
export interface QuestRewardLocalizedText {
  key: string
  params?: Record<string, string>
}

/**
 * The reward's amount line. `name` renders the Discord-supplied reward name,
 * `quantity` that name with a count, `text` a localized orb string. Nothing here
 * is English prose: the render site owns the wording.
 */
export type QuestRewardAmount =
  | { type: 'name' }
  | { type: 'quantity'; quantity: number }
  | { type: 'text'; text: QuestRewardLocalizedText }

export interface QuestRewardView {
  kind: QuestRewardKind
  /** Discord-supplied label; empty when the payload carries no name. */
  name: string
  asset: string | null
  skuId: string
  type: number
  amount: QuestRewardAmount
  badge: QuestRewardLocalizedText | null
  claimed: boolean
  icon: 'orbs' | 'asset' | 'gift'
}

export function isOrbReward(reward: QuestReward): boolean {
  return reward.type === 4 || reward.orb_quantity != null
}

export function isCollectibleReward(reward: QuestReward): boolean {
  const name = (reward.messages?.name || '').toLowerCase()
  return reward.type === 3
    || name.includes('decoration')
    || name.includes('avatar')
    || name.includes('profile')
}

export function isInGameReward(reward: QuestReward): boolean {
  return reward.type === 2 || (!!reward.asset && !isOrbReward(reward) && !isCollectibleReward(reward))
}

export function getPremiumMultiplier(reward: QuestReward): number | null {
  if (!reward.orb_quantity || !reward.premium_orb_quantity) return null
  if (reward.premium_orb_quantity <= reward.orb_quantity) return null
  return reward.premium_orb_quantity / reward.orb_quantity
}

function formatMultiplier(multiplier: number): string {
  return Number(multiplier.toFixed(2)).toString()
}

function formatOrbCount(count: number): string {
  return count.toLocaleString()
}

export function formatQuestReward(reward: QuestReward, userStatus?: QuestUserStatus | null, userPremiumType?: number | null): QuestRewardView {
  const name = reward.messages?.name || ''
  const hasNitro = !!userPremiumType && userPremiumType > 0
  const multiplier = hasNitro ? getPremiumMultiplier(reward) : null
  const claimedOrbs = userStatus?.orb_quantity_claimed
  const claimed = !!userStatus?.claimed_at

  if (isOrbReward(reward)) {
    const base = reward.orb_quantity
    const premium = reward.premium_orb_quantity
    const amount: QuestRewardAmount = claimed && claimedOrbs != null
      ? { type: 'text', text: { key: 'quest.reward_orbs_claimed', params: { count: formatOrbCount(claimedOrbs) } } }
      : hasNitro && base != null && premium != null && premium > base
        ? { type: 'text', text: { key: 'quest.reward_orbs_premium', params: { base: formatOrbCount(base), premium: formatOrbCount(premium) } } }
        : base != null
          ? { type: 'text', text: { key: 'quest.reward_orbs', params: { count: formatOrbCount(base) } } }
          : { type: 'name' }

    return {
      kind: 'orbs',
      name,
      asset: reward.asset || null,
      skuId: reward.sku_id,
      type: reward.type,
      amount,
      badge: multiplier
        ? { key: 'quest.reward_nitro_multiplier', params: { multiplier: formatMultiplier(multiplier) } }
        : null,
      claimed,
      icon: reward.asset ? 'asset' : 'orbs',
    }
  }

  const kind: QuestRewardKind = isInGameReward(reward)
    ? 'ingame'
    : isCollectibleReward(reward)
      ? 'collectible'
      : 'discord'

  const amount: QuestRewardAmount = reward.quantity != null
    ? { type: 'quantity', quantity: reward.quantity }
    : { type: 'name' }

  return {
    kind,
    name,
    asset: reward.asset || null,
    skuId: reward.sku_id,
    type: reward.type,
    amount,
    badge: null,
    claimed,
    icon: reward.asset ? 'asset' : 'gift',
  }
}

export function getQuestRewardViews(quest: Quest, userPremiumType?: number | null): QuestRewardView[] {
  return (quest.config.rewards_config?.rewards || []).map(reward => formatQuestReward(reward, quest.user_status, userPremiumType))
}

export function getQuestRewardCategory(quest: Quest): 'orbs' | 'avatar' | 'ingame' {
  const rewards = quest.config.rewards_config?.rewards || []
  if (rewards.some(isOrbReward)) return 'orbs'
  if (rewards.some(isCollectibleReward)) return 'avatar'
  return 'ingame'
}
