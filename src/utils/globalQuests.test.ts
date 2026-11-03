import { describe, expect, it } from 'vitest'
import {
  filterGlobalQuests,
  formatGlobalQuestCountdown,
  liveGlobalQuests,
  parseGlobalQuests,
} from './globalQuests'

const now = Date.parse('2026-10-08T00:00:00Z')

function raw(id = '111', extra: Record<string, unknown> = {}) {
  return {
    id,
    config: {
      messages: { quest_name: 'Sample', game_title: 'Game' },
      starts_at: '2026-10-01T00:00:00Z',
      expires_at: '2026-10-10T00:00:00Z',
      ...extra,
    },
  }
}

describe('parseGlobalQuests', () => {
  it('maps rewards with orb and premium quantities', () => {
    const quest = parseGlobalQuests([raw('111', {
      rewards_config: { rewards: [
        { type: 4, orb_quantity: 200, premium_orb_quantity: 250 },
        { type: 1, quantity: 2, messages: { name: 'Orange Buddy' } },
        { type: 5, messages: { name: 'Nitro' } },
      ] },
    })])[0]

    expect(quest.rewards).toEqual([
      { kind: 'orbs', name: '', quantity: 200, premiumQuantity: 250 },
      { kind: 'item', name: 'Orange Buddy', quantity: 2, premiumQuantity: null },
      { kind: 'nitro', name: 'Nitro', quantity: null, premiumQuantity: null },
    ])
  })

  it('maps task kinds and targets, preferring v2 configuration', () => {
    const quest = parseGlobalQuests([raw('111', {
      task_config: { tasks: { STREAM_ON_DESKTOP: {} } },
      task_config_v2: { tasks: {
        WATCH_VIDEO: { target: 900 },
        PLAY_ON_XBOX: {},
        ACHIEVEMENT_IN_ACTIVITY: { target: 3 },
        mystery: {},
      } },
    })])[0]

    expect(quest.tasks).toEqual([
      { type: 'WATCH_VIDEO', kind: 'watch', target: 900 },
      { type: 'PLAY_ON_XBOX', kind: 'play', target: null },
      { type: 'ACHIEVEMENT_IN_ACTIVITY', kind: 'activity', target: 3 },
      { type: 'mystery', kind: 'other', target: null },
    ])
  })

  it('skips malformed rows and keeps one entry per quest ID', () => {
    const quests = parseGlobalQuests([null, {}, raw(), raw(), raw('222')])
    expect(quests.map(quest => quest.id)).toEqual(['111', '222'])
  })

  it('treats an unparseable expiry as not live', () => {
    const quest = parseGlobalQuests([raw('111', { expires_at: 'bad' })])[0]
    expect(quest.expiresAt).toBeNull()
    expect(liveGlobalQuests([quest], now)).toEqual([])
  })
})

describe('expiry filtering', () => {
  it('drops expired, exact-deadline and missing-expiry entries', () => {
    const quests = parseGlobalQuests([
      raw(),
      raw('222', { expires_at: '2026-10-08T00:00:00Z' }),
      raw('333', { expires_at: '2026-10-07T00:00:00Z' }),
      raw('444', { expires_at: null }),
    ])
    expect(liveGlobalQuests(quests, now).map(quest => quest.id)).toEqual(['111'])
  })

  it('applies the same rule inside filterGlobalQuests', () => {
    const quests = parseGlobalQuests([raw(), raw('222', { expires_at: '2026-10-07T00:00:00Z' })])
    expect(filterGlobalQuests(quests, { query: '', tasks: [], rewards: [] }, now).map(quest => quest.id))
      .toEqual(['111'])
  })
})

describe('search matching', () => {
  const quests = parseGlobalQuests([
    raw('111'),
    raw('222', { messages: { quest_name: 'Watch the finals', game_title: 'Rocket League' } }),
  ])
  const filters = (query: string) => ({ query, tasks: [], rewards: [] })

  it('matches either the quest or the game name, case-insensitively and trimmed', () => {
    expect(filterGlobalQuests(quests, filters('  rocket '), now).map(quest => quest.id)).toEqual(['222'])
    expect(filterGlobalQuests(quests, filters('FINAL'), now).map(quest => quest.id)).toEqual(['222'])
  })

  it('requires every active filter group to match', () => {
    expect(filterGlobalQuests(quests, { query: 'rocket', tasks: ['watch'], rewards: [] }, now)).toEqual([])
  })
})

describe('catalogue dedupe', () => {
  it('keeps one row per regional variant unless the reward differs', () => {
    const orb = (amount: number) => ({ rewards_config: { rewards: [{ type: 4, orb_quantity: amount }] } })
    const quests = parseGlobalQuests([raw('111', orb(200)), raw('222', orb(200)), raw('333', orb(700))])
    expect(quests.map(quest => quest.id)).toEqual(['111', '333'])
  })
})

describe('sort order', () => {
  it('sorts by soonest expiry, breaking ties with the newest ID', () => {
    const quests = parseGlobalQuests([
      raw('111', { expires_at: '2026-10-12T00:00:00Z' }),
      raw('222', { expires_at: '2026-10-10T00:00:00Z' }),
      raw('333', { expires_at: '2026-10-10T00:00:00Z' }),
      raw('444', { expires_at: '2026-10-11T00:00:00Z' }),
    ])
    expect(filterGlobalQuests(quests, { query: '', tasks: [], rewards: [] }, now).map(quest => quest.id))
      .toEqual(['333', '222', '444', '111'])
  })
})

describe('formatGlobalQuestCountdown', () => {
  it('renders days and hours, hours and minutes, or minutes', () => {
    expect(formatGlobalQuestCountdown('2026-10-11T04:00:00Z', now)).toBe('3d 4h')
    expect(formatGlobalQuestCountdown('2026-10-08T04:12:00Z', now)).toBe('4h 12m')
    expect(formatGlobalQuestCountdown('2026-10-08T00:12:00Z', now)).toBe('12m')
    expect(formatGlobalQuestCountdown(null, now)).toBe('')
  })
})
