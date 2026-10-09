import { describe, expect, it } from 'vitest'
import type { Quest } from '@/api/tauri'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import {
  firstProgressValue,
  firstStartableTask,
  getQuestKind,
  getQuestTasks,
  isBatchCompletableQuest,
  isManualActivityQuest,
  isManualQuest,
  isPlayActivityQuest,
  isPlayActivityTask,
  playActivityProgressPercentage,
} from './questTasks'

function playActivityQuest(): Quest {
  return {
    id: 'cloud-activity',
    config: {
      messages: { quest_name: 'Cloud Activity' },
      task_config_v2: {
        tasks: {
          PLAY_ACTIVITY: { type: 'PLAY_ACTIVITY', target: 900 },
        },
      },
    },
    user_status: {
      enrolled_at: '2026-08-04T00:00:00.000Z',
      progress: {
        PLAY_ACTIVITY: { value: 48 },
      },
    },
  }
}

function singleTaskQuest(id: string, type: string, target?: number): Quest {
  return {
    id,
    config: {
      messages: { quest_name: id },
      task_config_v2: {
        tasks: {
          task: target === undefined ? { type } : { type, target },
        },
      },
    },
    user_status: {
      enrolled_at: '2026-08-04T00:00:00.000Z',
      progress: {
        task: { value: 0 },
      },
    },
  }
}

function mixedActivityQuest(): Quest {
  return {
    id: 'mixed-activity',
    config: {
      messages: { quest_name: 'Mixed Activity' },
      task_config_v2: {
        tasks: {
          ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
          PLAY_ACTIVITY: { type: 'PLAY_ACTIVITY', target: 900 },
        },
      },
    },
    user_status: { enrolled_at: '2026-08-04T00:00:00.000Z' },
  }
}

describe('PLAY_ACTIVITY task helpers', () => {
  it('keeps cloud games in the Activity kind with a distinct task predicate', () => {
    const quest = playActivityQuest()
    const task = firstStartableTask(quest)

    expect(getQuestKind(quest)).toBe('activity')
    expect(task?.type).toBe('PLAY_ACTIVITY')
    expect(task && isPlayActivityTask(task)).toBe(true)
    expect(getQuestTasks(quest)[0].label).toBe('Activity - Cloud Game')
  })

  it('restores PLAY_ACTIVITY progress as elapsed seconds', () => {
    const quest = playActivityQuest()

    expect(firstProgressValue(quest, 'PLAY_ACTIVITY')).toBe(48)
  })

  it('does not report completion before Discord sets completed_at', () => {
    expect(playActivityProgressPercentage(450, 900)).toBe(50)
    expect(playActivityProgressPercentage(900, 900)).toBe(99)
    expect(playActivityProgressPercentage(-1, 900)).toBe(0)
    expect(playActivityProgressPercentage(900, 0)).toBe(0)
    expect(playActivityProgressPercentage(900, 900, true)).toBe(100)
  })

  it('provides localized cloud-game badge labels', () => {
    expect(en.filter.activity_cloud_game).toBe('Activity - Cloud Game')
    expect(zh.filter.activity_cloud_game).toBe('活动 - 云游戏')
  })

  it('scores cloud-game progress in seconds and checkpoint progress in counts', () => {
    expect(getQuestTasks(playActivityQuest())[0].targetText).toBe('15m')
    expect(getQuestTasks(singleTaskQuest('checkpoint', 'ACHIEVEMENT_IN_ACTIVITY', 3))[0].targetText).toBe('3 tasks')
  })
})

describe('manual versus batch-eligible quest kinds', () => {
  it('keeps the store-startable cloud game out of the manual set', () => {
    const quest = playActivityQuest()

    expect(getQuestKind(quest)).toBe('activity')
    expect(isPlayActivityQuest(quest)).toBe(true)
    expect(isManualActivityQuest(quest)).toBe(false)
    expect(isManualQuest(quest)).toBe(false)
  })

  it('marks checkpoint activities and real streams manual', () => {
    const checkpoint = singleTaskQuest('checkpoint', 'ACHIEVEMENT_IN_ACTIVITY', 3)
    const stream = singleTaskQuest('stream', 'STREAM_ON_DESKTOP', 900)

    expect(isManualActivityQuest(checkpoint)).toBe(true)
    expect(isManualQuest(checkpoint)).toBe(true)
    expect(isManualActivityQuest(stream)).toBe(false)
    expect(isManualQuest(stream)).toBe(true)
  })

  it('keeps video and desktop-play quests batch-eligible', () => {
    expect(isManualQuest(singleTaskQuest('video', 'WATCH_VIDEO', 300))).toBe(false)
    expect(isManualQuest(singleTaskQuest('play', 'PLAY_ON_DESKTOP', 600))).toBe(false)
  })

  it('routes a quest mixing activity task types by its startable task', () => {
    const quest = mixedActivityQuest()

    expect(firstStartableTask(quest)?.type).toBe('ACHIEVEMENT_IN_ACTIVITY')
    expect(isPlayActivityQuest(quest)).toBe(false)
    expect(isManualQuest(quest)).toBe(true)
  })

  it('keeps every store-startable quest batch-eligible', () => {
    expect(isBatchCompletableQuest(playActivityQuest())).toBe(true)
    expect(isBatchCompletableQuest(singleTaskQuest('video', 'WATCH_VIDEO', 300))).toBe(true)
    expect(isBatchCompletableQuest(singleTaskQuest('play', 'PLAY_ON_DESKTOP', 600))).toBe(true)
    expect(isBatchCompletableQuest(mixedActivityQuest())).toBe(false)
  })

  it('keeps manual and undispatchable quests out of the batch', () => {
    const withoutTarget = singleTaskQuest('checkpoint-no-target', 'ACHIEVEMENT_IN_ACTIVITY')

    expect(isBatchCompletableQuest(singleTaskQuest('checkpoint', 'ACHIEVEMENT_IN_ACTIVITY', 3))).toBe(false)
    expect(isBatchCompletableQuest(singleTaskQuest('stream', 'STREAM_ON_DESKTOP', 900))).toBe(false)
    expect(isManualQuest(withoutTarget)).toBe(false)
    expect(isBatchCompletableQuest(withoutTarget)).toBe(false)
  })
})
