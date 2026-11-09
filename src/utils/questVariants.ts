import type { Quest } from '@/api/tauri'

/**
 * Regional variants of one quest share a name, game, expiry and reward but carry
 * different ids, so Home lists them as identical cards. This mirrors the
 * catalogue's collapse key (utils/globalQuests.ts) so both surfaces agree on what
 * "the same offer" means; a differing reward stays a separate group.
 */
export function questVariantKey(quest: Quest): string {
  const messages = quest.config.messages
  const rewards = quest.config.rewards_config?.rewards ?? []
  return [
    messages.quest_name,
    messages.game_title || quest.config.application?.name || '',
    quest.config.expires_at || '',
    rewards.map(reward => `${reward.type}:${reward.approximate_count ?? ''}`).join(','),
  ].join('|')
}

/**
 * Collapse identical, still-run offers into one representative card. A group is
 * only collapsed while none of its variants is completed or claimed, so every
 * claimable reward keeps its own visible card and its own Claim button.
 */
export function collapseQuestVariants(quests: Quest[]): {
  list: Quest[]
  groups: Map<string, Quest[]>
} {
  const byKey = new Map<string, Quest[]>()
  for (const quest of quests) {
    const key = questVariantKey(quest)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(quest)
    else byKey.set(key, [quest])
  }

  const list: Quest[] = []
  const groups = new Map<string, Quest[]>()
  for (const variants of byKey.values()) {
    const collapsible = variants.length > 1
      && variants.every(variant => !variant.user_status?.completed_at && !variant.user_status?.claimed_at)
    if (collapsible) {
      list.push(variants[0])
      groups.set(variants[0].id, variants)
    } else {
      list.push(...variants)
    }
  }
  return { list, groups }
}