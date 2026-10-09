import type { Quest, QuestTaskConfigEntry } from '@/api/tauri'

export interface QuestTaskView {
  key: string
  type: string
  target?: number
  targetText: string
  label: string
  applications?: Array<{ id: string }>
  externalIds?: string[]
  assets?: unknown
  messages?: Record<string, string>
  eventName?: string
}

export type QuestKind = 'video' | 'stream' | 'activity'

const TASK_LABELS: Record<string, string> = {
  WATCH_VIDEO: 'Desktop Video',
  WATCH_VIDEO_ON_MOBILE: 'Mobile Video',
  PLAY_ON_DESKTOP: 'Desktop Play',
  PLAY_ON_XBOX: 'Xbox',
  PLAY_ON_PLAYSTATION: 'PlayStation',
  STREAM_ON_DESKTOP: 'Stream',
  ACHIEVEMENT_IN_ACTIVITY: 'Activity Achievement',
  PLAY_ACTIVITY: 'Activity - Cloud Game',
}

export function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60

  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }

  if (minutes === 0) return `${secs}s`
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`
}

function taskLabel(type: string): string {
  return TASK_LABELS[type] ?? type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, char => char.toUpperCase())
}

function targetText(type: string, target?: number): string {
  if (target == null) return ''
  if (type === 'ACHIEVEMENT_IN_ACTIVITY') {
    return `${target} task${target === 1 ? '' : 's'}`
  }
  return formatDuration(target)
}

function toTaskView(key: string, task: QuestTaskConfigEntry): QuestTaskView {
  const type = task.type || key
  return {
    key,
    type,
    target: task.target,
    targetText: targetText(type, task.target),
    label: taskLabel(type),
    applications: task.applications,
    externalIds: task.external_ids,
    assets: task.assets,
    messages: task.messages,
    eventName: task.event_name,
  }
}

export function getQuestTasks(quest: Quest): QuestTaskView[] {
  const tasks = quest.config.task_config_v2?.tasks ?? quest.config.task_config?.tasks
  if (!tasks) return []
  return Object.entries(tasks).map(([key, task]) => toTaskView(key, task))
}

export function getQuestKind(quest: Quest): QuestKind {
  const tasks = getQuestTasks(quest)
  if (tasks.some(task => task.type.includes('ACTIVITY') || task.type.includes('ACHIEVEMENT'))) {
    return 'activity'
  }
  if (tasks.some(task => task.type.includes('STREAM') || task.type.includes('PLAY'))) {
    return 'stream'
  }
  return 'video'
}

export function isVideoTask(task: QuestTaskView): boolean {
  return task.type === 'WATCH_VIDEO' || task.type === 'WATCH_VIDEO_ON_MOBILE' || task.type.includes('VIDEO')
}

export function isDesktopPlayTask(task: QuestTaskView): boolean {
  return task.type === 'PLAY_ON_DESKTOP'
}

export function isStreamTask(task: QuestTaskView): boolean {
  return task.type.includes('STREAM')
}

export function isActivityTask(task: QuestTaskView): boolean {
  return task.type.includes('ACTIVITY') || task.type.includes('ACHIEVEMENT')
}

export function isPlayActivityTask(task: QuestTaskView): boolean {
  return task.type === 'PLAY_ACTIVITY'
}

/**
 * True when a quest's startable task is a real Stream task (`*_STREAM*`), not a
 * desktop-play quest. `getQuestKind` collapses both PLAY and STREAM into the
 * `'stream'` kind, so this distinguishes the manual, non-automatable Stream
 * quests (which require actually broadcasting and cannot run through the
 * game-simulation queue) from automatable Play quests.
 */
export function isManualStreamQuest(quest: Quest): boolean {
  const task = firstStartableTask(quest)
  return !!task && isStreamTask(task) && !isDesktopPlayTask(task)
}

/**
 * True when the quest's routed task is a cloud-game Activity (`PLAY_ACTIVITY`).
 * Its progress accrues from the backend heartbeat loop alone, so unlike a
 * checkpoint Activity it needs nothing from the user and is fully automatable.
 */
export function isPlayActivityQuest(quest: Quest): boolean {
  const task = firstStartableTask(quest)
  return !!task && isPlayActivityTask(task)
}

/**
 * True when the quest's routed task is a checkpoint Activity
 * (`ACHIEVEMENT_IN_ACTIVITY`): its checkpoints only register while the user
 * keeps the Activity window open in the attached Discord client. `getQuestKind`
 * collapses these together with `PLAY_ACTIVITY` into the `'activity'` kind, so
 * batch flows must test this predicate instead of the kind to keep automatable
 * cloud games from disappearing from a batch.
 */
export function isManualActivityQuest(quest: Quest): boolean {
  const task = firstStartableTask(quest)
  return !!task && isActivityTask(task) && !isPlayActivityTask(task)
}

/**
 * True when completing the quest requires a human: a real Stream (actual
 * broadcasting) or a checkpoint Activity (the launched Activity window).
 * Anything else the store can start on its own, so batch flows must keep it
 * eligible instead of dropping it silently.
 */
export function isManualQuest(quest: Quest): boolean {
  return isManualStreamQuest(quest) || isManualActivityQuest(quest)
}

/**
 * The batch rule Home's bulk actions apply: a quest belongs in a batch only when
 * the store has a task it can drive, and driving it needs no human. Without the
 * startable-task check, an Activity quest whose checkpoint target is missing
 * would look automatable and be queued with a zero duration.
 */
export function isBatchCompletableQuest(quest: Quest): boolean {
  return firstStartableTask(quest) !== null && !isManualQuest(quest)
}

/**
 * Percentage for a slot whose progress and target are written in the SAME unit:
 * elapsed seconds for a `PLAY_ACTIVITY` cloud game, checkpoint counts for an
 * `ACHIEVEMENT_IN_ACTIVITY`. Never mix the two units across a call — a
 * checkpoint count divided by a duration is the bug this helper used to hide.
 * Mirrors the backend's `PlayActivityHeartbeatStatus::progress_percentage`:
 * a completed quest is 100, otherwise the ratio stays capped at 99 while
 * Discord has not written `completed_at`.
 */
export function playActivityProgressPercentage(
  progressValue: number,
  targetValue: number,
  completed = false
): number {
  if (completed) return 100
  if (targetValue <= 0) return 0
  return Math.min(99, Math.max(0, progressValue / targetValue * 100))
}

export function firstProgressValue(quest: Quest, taskKey?: string): number {
  const progress = quest.user_status?.progress
  if (!progress || typeof progress !== 'object') return 0

  if (taskKey && progress[taskKey]?.value != null) {
    return progress[taskKey].value ?? 0
  }

  const first = Object.values(progress)[0]
  return first?.value ?? 0
}

export function firstTargetTask(quest: Quest): QuestTaskView | null {
  return getQuestTasks(quest).find(task => task.target != null && task.target > 0) ?? null
}

export function firstStartableTask(quest: Quest): QuestTaskView | null {
  const tasks = getQuestTasks(quest)
  return tasks.find(task => isVideoTask(task) && task.target != null && task.target > 0)
    ?? tasks.find(task => isDesktopPlayTask(task) && task.target != null && task.target > 0)
    ?? tasks.find(task => isStreamTask(task) && task.target != null && task.target > 0)
    ?? tasks.find(task => isActivityTask(task) && task.target != null && task.target > 0)
    ?? null
}
