export type GlobalTaskKind = 'watch' | 'play' | 'activity' | 'stream' | 'other'
export type GlobalRewardKind = 'orbs' | 'nitro' | 'role' | 'item'

export interface GlobalQuestTask {
  type: string
  kind: GlobalTaskKind
  target: number | null
}

export interface GlobalQuestReward {
  kind: GlobalRewardKind
  name: string
  quantity: number | null
  premiumQuantity: number | null
}

/** Public catalogue entries carry no account status and cannot be executed here. */
export interface GlobalQuest {
  id: string
  name: string
  gameName: string
  description: string
  expiresAt: string | null
  thumbnailUrl: string | null
  tasks: GlobalQuestTask[]
  rewards: GlobalQuestReward[]
}

export interface GlobalQuestFilters {
  query: string
  tasks: GlobalTaskKind[]
  rewards: GlobalRewardKind[]
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function date(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function collection(value: unknown): unknown[] {
  const items = Array.isArray(value) ? value : object(value).quests
  if (!Array.isArray(items)) throw new Error('Invalid quest dataset')
  return items
}

export function questAssetUrl(value: unknown, questId: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  // Older entries use a filename; newer entries use a CDN-relative path.
  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return url.hostname === 'cdn.discordapp.com' ? url.href : null
    } catch {
      return null
    }
  }
  if (/[:?#\\]/.test(value) || value.split('/').includes('..')) return null
  const path = value.replace(/^\/+/, '')
  return `https://cdn.discordapp.com/${path.includes('/') ? path : `quests/${questId}/${path}`}`
}

export function globalTaskKind(type: string): GlobalTaskKind {
  if (type.includes('VIDEO')) return 'watch'
  if (type.includes('ACTIVITY') || type.includes('ACHIEVEMENT')) return 'activity'
  if (type.includes('STREAM')) return 'stream'
  if (type.includes('PLAY')) return 'play'
  return 'other'
}

function rewardKind(reward: Record<string, unknown>): GlobalRewardKind {
  if (reward.type === 4 || count(reward.orb_quantity) !== null) return 'orbs'
  if (reward.type === 5) return 'nitro'
  // The catalogue has no numeric role type, so only the reward name identifies one.
  if (/\brole\b/.test(text(object(reward.messages).name).toLocaleLowerCase())) return 'role'
  return 'item'
}

export function parseGlobalQuests(value: unknown): GlobalQuest[] {
  const quests = new Map<string, GlobalQuest>()
  for (const item of collection(value)) {
    const raw = object(item)
    const config = object(raw.config)
    const messages = object(config.messages)
    const id = text(raw.id)
    if (!/^\d+$/.test(id) || !text(messages.quest_name)) continue

    const tasks = object(object(config.task_config_v2).tasks ?? object(config.task_config).tasks)
    const rewards = object(config.rewards_config).rewards

    quests.set(id, {
      id,
      name: text(messages.quest_name),
      gameName: text(messages.game_title) || text(object(config.application).name),
      description: text(messages.task_description),
      expiresAt: date(config.expires_at),
      thumbnailUrl: questAssetUrl(object(config.assets).hero, id),
      tasks: Object.entries(tasks).map(([key, task]) => {
        const entry = object(task)
        const type = text(entry.type) || text(entry.event_name) || key
        return { type, kind: globalTaskKind(type), target: count(entry.target) }
      }),
      rewards: (Array.isArray(rewards) ? rewards : []).map(item => {
        const reward = object(item)
        const kind = rewardKind(reward)
        return {
          kind,
          name: text(object(reward.messages).name),
          quantity: count(kind === 'orbs' ? reward.orb_quantity : reward.quantity),
          premiumQuantity: count(reward.premium_orb_quantity),
        }
      }),
    })
  }
  // The catalogue lists one row per regional variant, so the same quest can
  // appear several times. Keep one row unless the reward differs, which is a
  // genuinely different offer.
  const seen = new Set<string>()
  return [...quests.values()].filter(quest => {
    const identity = [
      quest.name,
      quest.gameName,
      quest.expiresAt,
      quest.rewards.map(reward => `${reward.kind}${reward.quantity ?? ''}`).join(','),
    ].join('|')
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export function isLiveGlobalQuest(quest: GlobalQuest, now: number): boolean {
  const expiresAt = quest.expiresAt ? Date.parse(quest.expiresAt) : Number.NaN
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function liveGlobalQuests(quests: GlobalQuest[], now: number): GlobalQuest[] {
  return quests.filter(quest => isLiveGlobalQuest(quest, now))
}

export function matchesGlobalQuest(quest: GlobalQuest, filters: GlobalQuestFilters): boolean {
  const query = filters.query.trim().toLocaleLowerCase()
  if (query && !`${quest.name} ${quest.gameName}`.toLocaleLowerCase().includes(query)) return false
  if (filters.tasks.length && !filters.tasks.some(kind => quest.tasks.some(task => task.kind === kind))) return false
  if (filters.rewards.length && !filters.rewards.some(kind => quest.rewards.some(reward => reward.kind === kind))) return false
  return true
}

/** Soonest deadline first; the ID breaks ties so a refresh keeps rows stable. */
export function sortGlobalQuests(quests: GlobalQuest[]): GlobalQuest[] {
  return [...quests].sort((a, b) => {
    const byExpiry = Date.parse(a.expiresAt ?? '') - Date.parse(b.expiresAt ?? '')
    return (Number.isFinite(byExpiry) ? byExpiry : 0) || b.id.localeCompare(a.id)
  })
}

export function filterGlobalQuests(
  quests: GlobalQuest[],
  filters: GlobalQuestFilters,
  now: number,
): GlobalQuest[] {
  return sortGlobalQuests(quests.filter(quest => isLiveGlobalQuest(quest, now) && matchesGlobalQuest(quest, filters)))
}

export function formatGlobalQuestCountdown(expiresAt: string | null, now: number): string {
  const expires = expiresAt ? Date.parse(expiresAt) : Number.NaN
  if (!Number.isFinite(expires)) return ''
  const minutes = Math.ceil((expires - now) / 60_000)
  if (minutes <= 0) return ''
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}
