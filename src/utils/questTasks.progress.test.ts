import { describe, expect, it } from 'vitest'
import type { Quest } from '@/api/tauri'
import {
  firstProgressValue,
  isBatchCompletableQuest,
  isManualActivityQuest,
  isManualStreamQuest,
  isPlayActivityQuest,
  questProgressPercent,
  questProgressTask,
  questRunTask,
} from './questTasks'

function quest(tasks: Record<string, { type: string, target?: number }>, progress?: Record<string, number>): Quest {
  const entries = Object.entries(tasks).map(([key, task]) => [key, task] as const)
  return {
    id: 'quest',
    config: {
      messages: { quest_name: 'Quest' },
      task_config: { tasks: Object.fromEntries(entries) },
    },
    user_status: {
      enrolled_at: '2026-10-01',
      completed_at: null,
      claimed_at: null,
      progress: progress
        ? Object.fromEntries(Object.entries(progress).map(([key, value]) => [key, { value }]))
        : {},
    },
  }
}

describe('quest progress task', () => {
  it('reads a video quest on its video task', () => {
    const subject = quest({ WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 } })
    expect(questProgressTask(subject)?.key).toBe('WATCH_VIDEO')
  })

  it('reads a game quest on its play task, not on the Activity beside it', () => {
    const subject = quest({
      PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 },
      ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
    })
    // The batch routes this quest down the game path, so its progress is banked
    // on the play task in seconds.
    expect(questProgressTask(subject)?.key).toBe('PLAY_ON_DESKTOP')
  })

  it('reads a cloud game on its PLAY_ACTIVITY task', () => {
    const subject = quest({
      PLAY_ACTIVITY: { type: 'PLAY_ACTIVITY', target: 300 },
    })
    expect(questProgressTask(subject)?.key).toBe('PLAY_ACTIVITY')
  })

  it('reads a checkpoint Activity beside a cloud game on the checkpoint', () => {
    // The checkpoint is the part only a human can finish, so it is what the
    // quest is judged on; the cloud game's seconds would hide it.
    const subject = quest({
      PLAY_ACTIVITY: { type: 'PLAY_ACTIVITY', target: 300 },
      ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
    })
    expect(questProgressTask(subject)?.key).toBe('ACHIEVEMENT_IN_ACTIVITY')
  })

  it('reads a checkpoint Activity on its own task', () => {
    const subject = quest({
      ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
    })
    expect(questProgressTask(subject)?.key).toBe('ACHIEVEMENT_IN_ACTIVITY')
  })
})

describe('quest run task', () => {
  it('drives the game task of a quest that also lists a video task', () => {
    // The batch routes this quest down the game path, so the card's own Start
    // button has to drive the game task too: the video task would start a
    // different run with a different duration and a different progress unit.
    const subject = quest({
      WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 },
      PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 },
    })
    expect(questRunTask(subject)?.key).toBe('PLAY_ON_DESKTOP')
  })

  it('falls back to the first targeted task when the driven task has no duration', () => {
    const subject = quest({
      PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP' },
      WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 },
    })
    expect(questRunTask(subject)?.key).toBe('WATCH_VIDEO')
  })

  it('has no task for a quest without any duration', () => {
    const subject = quest({ PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP' } })
    expect(questRunTask(subject)).toBeNull()
  })
})

describe('what a quest needs', () => {
  it('keeps a checkpoint Activity beside a video task manual', () => {
    // The quest runs the checkpoint, so it needs the Activity window and its
    // checkpoint count is never read as a duration.
    const subject = quest({
      WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 },
      ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
    })
    expect(isManualActivityQuest(subject)).toBe(true)
    expect(isBatchCompletableQuest(subject)).toBe(false)
  })

  it('keeps a cloud game beside a video task automatable', () => {
    const subject = quest({
      WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 },
      PLAY_ACTIVITY: { type: 'PLAY_ACTIVITY', target: 300 },
    })
    expect(isManualActivityQuest(subject)).toBe(false)
    expect(isPlayActivityQuest(subject)).toBe(true)
    expect(isBatchCompletableQuest(subject)).toBe(true)
  })

  it('keeps a real Stream beside a video task manual', () => {
    const subject = quest({
      WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 },
      STREAM_ON_DESKTOP: { type: 'STREAM_ON_DESKTOP', target: 900 },
    })
    expect(isManualStreamQuest(subject)).toBe(true)
    expect(isBatchCompletableQuest(subject)).toBe(false)
  })
})

describe('quest progress percent', () => {
  it('divides the banked value by the task it belongs to', () => {
    const subject = quest(
      { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 } },
      { PLAY_ON_DESKTOP: 300 },
    )
    expect(questProgressPercent(subject)).toBeCloseTo(50, 5)
  })

  it('counts a checkpoint quest in checkpoints', () => {
    const subject = quest(
      { ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 } },
      { ACHIEVEMENT_IN_ACTIVITY: 2 },
    )
    expect(questProgressPercent(subject)).toBeCloseTo(66.67, 1)
  })

  it('measures a quest that lists a video task on its game task', () => {
    const subject = quest(
      {
        WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 },
        PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 },
      },
      { PLAY_ON_DESKTOP: 300 },
    )
    expect(questProgressPercent(subject)).toBeCloseTo(50, 5)
  })

  it('does not borrow another task value when its own task has none', () => {
    // The Activity task holds a checkpoint count and the play task holds
    // seconds: reading the wrong one turns 2 checkpoints into 0.3%.
    const subject = quest(
      {
        PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 },
        ACHIEVEMENT_IN_ACTIVITY: { type: 'ACHIEVEMENT_IN_ACTIVITY', target: 3 },
      },
      { ACHIEVEMENT_IN_ACTIVITY: 2 },
    )
    expect(questProgressPercent(subject)).toBe(0)
  })

  it('keeps a banked value when the quest reports only one task', () => {
    // Discord keys the map by its own task names, which do not always match the
    // config's keys, so a lone entry is the task this quest is running.
    const subject = quest(
      { PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 } },
      { SOME_OTHER_NAME: 300 },
    )
    expect(questProgressPercent(subject)).toBeCloseTo(50, 5)
  })

  it('falls back to the legacy stream counter when no progress map exists', () => {
    const subject = quest({ PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 } })
    subject.user_status!.progress = undefined
    subject.user_status!.stream_progress_seconds = 150
    expect(questProgressPercent(subject)).toBeCloseTo(25, 5)
  })
})

describe('first progress value', () => {
  it('returns zero when several tasks exist and the named one is missing', () => {
    const subject = quest(
      {
        PLAY_ON_DESKTOP: { type: 'PLAY_ON_DESKTOP', target: 600 },
        WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 60 },
      },
      { WATCH_VIDEO: 30 },
    )
    expect(firstProgressValue(subject, 'PLAY_ON_DESKTOP')).toBe(0)
  })
})
