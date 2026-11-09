import { describe, expect, it } from 'vitest'
import type { Quest } from '@/api/tauri'
import { collapseQuestVariants, questVariantKey } from './questVariants'

function makeQuest(id: string, overrides: Partial<Quest['config']> = {}, status: Partial<NonNullable<Quest['user_status']>> = {}): Quest {
  return {
    id,
    config: {
      messages: { quest_name: 'Watch the trailer', game_title: 'Same Game' },
      rewards_config: { rewards: [{ type: 4, sku_id: 'sku', messages: { name: 'Orbs' }, approximate_count: 120 }] },
      expires_at: '2026-12-01T00:00:00Z',
      ...overrides,
    },
    user_status: { enrolled_at: '2026-11-01T00:00:00Z', ...status },
  } as Quest
}

describe('questVariantKey', () => {
  it('matches regional variants that differ only by id', () => {
    expect(questVariantKey(makeQuest('a'))).toBe(questVariantKey(makeQuest('b')))
  })

  it('separates quests whose reward differs', () => {
    const other = makeQuest('b', {
      rewards_config: { rewards: [{ type: 4, sku_id: 'sku', messages: { name: 'Orbs' }, approximate_count: 300 }] },
    })
    expect(questVariantKey(makeQuest('a'))).not.toBe(questVariantKey(other))
  })
})

describe('collapseQuestVariants', () => {
  it('collapses identical run-ready variants into one representative', () => {
    const { list, groups } = collapseQuestVariants([makeQuest('a'), makeQuest('b'), makeQuest('c')])
    expect(list.map(quest => quest.id)).toEqual(['a'])
    expect(groups.get('a')?.map(quest => quest.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps every card once a variant is completed or claimed', () => {
    const { list, groups } = collapseQuestVariants([
      makeQuest('a'),
      makeQuest('b', {}, { completed_at: '2026-11-02T00:00:00Z' }),
    ])
    expect(list.map(quest => quest.id)).toEqual(['a', 'b'])
    expect(groups.size).toBe(0)
  })

  it('leaves distinct offers alone', () => {
    const different = makeQuest('z', { messages: { quest_name: 'Another quest' } })
    const { list } = collapseQuestVariants([makeQuest('a'), different])
    expect(list.map(quest => quest.id)).toEqual(['a', 'z'])
  })
})