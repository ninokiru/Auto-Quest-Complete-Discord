import { describe, expect, it } from 'vitest'
import type { Quest } from '@/api/tauri'
import { deriveHomeQuestBuckets, getRecommendedQuests } from './useHomeQuestState'

function quest(overrides: Partial<Quest> & { id: string }): Quest {
  return {
    id: overrides.id,
    config: {
      messages: {
        quest_name: overrides.config?.messages?.quest_name ?? overrides.id,
        game_title: overrides.config?.messages?.game_title ?? 'Game',
      },
      expires_at: overrides.config?.expires_at ?? '2026-06-22T00:00:00.000Z',
      task_config_v2: overrides.config?.task_config_v2 ?? {
        tasks: {
          task: { type: 'WATCH_VIDEO', target: 60 },
        },
      },
      ...overrides.config,
    },
    user_status: overrides.user_status ?? null,
  }
}

describe('deriveHomeQuestBuckets', () => {
  const now = new Date('2026-06-21T00:00:00.000Z')

  it('groups quests by next user-facing action', () => {
    const buckets = deriveHomeQuestBuckets([
      quest({ id: 'accept' }),
      quest({ id: 'run', user_status: { enrolled_at: '2026-06-20T00:00:00.000Z' } }),
      quest({ id: 'claim', user_status: { enrolled_at: '2026-06-20T00:00:00.000Z', completed_at: '2026-06-20T01:00:00.000Z' } }),
      quest({ id: 'done', user_status: { enrolled_at: '2026-06-20T00:00:00.000Z', completed_at: '2026-06-20T01:00:00.000Z', claimed_at: '2026-06-20T02:00:00.000Z' } }),
      quest({ id: 'expired', config: { messages: { quest_name: 'Expired' }, expires_at: '2026-06-20T00:00:00.000Z' } }),
    ], { now })

    expect(buckets.toAccept.map(item => item.id)).toEqual(['accept'])
    expect(buckets.readyToRun.map(item => item.id)).toEqual(['run'])
    expect(buckets.readyToClaim.map(item => item.id)).toEqual(['claim'])
    expect(buckets.completed.map(item => item.id)).toEqual(['claim', 'done'])
    expect(buckets.expired.map(item => item.id)).toEqual(['expired'])
  })

  it('marks activity quests as needing attention when CDP is unavailable', () => {
    const activityQuest = quest({
      id: 'activity',
      user_status: { enrolled_at: '2026-06-20T00:00:00.000Z' },
      config: {
        messages: { quest_name: 'Activity' },
        task_config_v2: {
          tasks: {
            task: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
          },
        },
      },
    })

    const unavailable = deriveHomeQuestBuckets([activityQuest], { now, cdpAvailable: false })
    const available = deriveHomeQuestBuckets([activityQuest], { now, cdpAvailable: true })

    expect(unavailable.attentionNeeded.map(item => item.id)).toEqual(['activity'])
    expect(unavailable.readyToRun).toHaveLength(0)
    expect(available.readyToRun.map(item => item.id)).toEqual(['activity'])
  })

  it('keeps PLAY_ACTIVITY in Activity while allowing it to run without CDP', () => {
    const cloudActivity = quest({
      id: 'cloud-activity',
      user_status: {
        enrolled_at: '2026-06-20T00:00:00.000Z',
        progress: { PLAY_ACTIVITY: { value: 48 } },
      },
      config: {
        messages: { quest_name: 'Cloud Activity' },
        task_config_v2: {
          tasks: {
            PLAY_ACTIVITY: { type: 'PLAY_ACTIVITY', target: 900 },
          },
        },
      },
    })

    const buckets = deriveHomeQuestBuckets([cloudActivity], { now, cdpAvailable: false })

    expect(buckets.readyToRun.map(item => item.id)).toEqual(['cloud-activity'])
    expect(buckets.attentionNeeded).toHaveLength(0)
    expect(getRecommendedQuests(buckets).map(item => item.id)).toContain('cloud-activity')
    expect(Object.keys(buckets)).not.toContain('activityManual')
  })

  it('uses the routed task when a quest contains multiple Activity task types', () => {
    const mixedActivity = quest({
      id: 'mixed-activity',
      user_status: { enrolled_at: '2026-06-20T00:00:00.000Z' },
      config: {
        messages: { quest_name: 'Mixed Activity' },
        task_config_v2: {
          tasks: {
            ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
            PLAY_ACTIVITY: { type: 'PLAY_ACTIVITY', target: 900 },
          },
        },
      },
    })

    const buckets = deriveHomeQuestBuckets([mixedActivity], { now, cdpAvailable: false })

    expect(buckets.readyToRun).toHaveLength(0)
    expect(buckets.attentionNeeded.map(item => item.id)).toEqual(['mixed-activity'])
    expect(getRecommendedQuests(buckets).map(item => item.id)).toContain('mixed-activity')
  })

  it('drops the enrollment block once its deadline has passed', () => {
    const blocked = deriveHomeQuestBuckets([], { now, blockedUntil: '2026-06-21T00:05:00.000Z' })
    const lifted = deriveHomeQuestBuckets([], { now, blockedUntil: '2026-06-20T23:55:00.000Z' })

    expect(blocked.blockedUntil).toBe('2026-06-21T00:05:00.000Z')
    expect(lifted.blockedUntil).toBeNull()
  })
})
