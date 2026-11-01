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
 * A checkpoint Activity (`ACHIEVEMENT_IN_ACTIVITY`): its checkpoints only
 * register while the user keeps the Activity window open, so it needs a human.
 */
function isCheckpointActivityTask(task: QuestTaskView): boolean {
  return isActivityTask(task) && !isPlayActivityTask(task)
}

/**
 * True when a quest's routed task is a real Stream task (`*_STREAM*`), not a
 * desktop-play quest. `getQuestKind` collapses both PLAY and STREAM into the
 * `'stream'` kind, so this distinguishes the manual, non-automatable Stream
 * quests (which require actually broadcasting and cannot run through the
 * game-simulation queue) from automatable Play quests. The routed task decides,
 * not the first task in the list: a quest listing a video task beside a Stream
 * still runs the Stream, so it still needs a broadcast.
 */
export function isManualStreamQuest(quest: Quest): boolean {
  const task = questRunTask(quest)
  return !!task && isStreamTask(task) && !isDesktopPlayTask(task)
}

/**
 * True when the quest's routed task is a cloud-game Activity (`PLAY_ACTIVITY`).
 * Its progress accrues from the backend heartbeat loop alone, so unlike a
 * checkpoint Activity it needs nothing from the user and is fully automatable.
 * A cloud game listed beside a video task is still a cloud game: the routed
 * task is the one the app drives, and it is the one that has to be started
 * through the heartbeat path rather than the local game simulator.
 */
export function isPlayActivityQuest(quest: Quest): boolean {
  const task = questRunTask(quest)
  return !!task && isPlayActivityTask(task)
}

/**
 * True when the quest starts through a game path: a desktop-play quest or a
 * cloud-game Activity. Both publish a game presence for their account, and on
 * the simulated path an executable and a history segment keyed to the title
 * rather than to the quest, so one account runs one of them at a time. Every
 * task is tested, not just the first startable one, because the queue routes on
 * `getQuestKind`, which sends a quest listing a game task beside a video task
 * down the game path as well.
 */
export function isGameQuest(quest: Quest): boolean {
  return getQuestTasks(quest).some(task => isDesktopPlayTask(task) || isPlayActivityTask(task))
}

/**
 * True when the quest's routed task is a checkpoint Activity
 * (`ACHIEVEMENT_IN_ACTIVITY`): its checkpoints only register while the user
 * keeps the Activity window open in the attached Discord client. `getQuestKind`
 * collapses these together with `PLAY_ACTIVITY` into the `'activity'` kind, so
 * batch flows must test this predicate instead of the kind to keep automatable
 * cloud games from disappearing from a batch. The routed task decides, not the
 * first task in the list: a quest listing a video task beside a checkpoint
 * Activity runs the checkpoint, and a checkpoint count is not a duration.
 */
export function isManualActivityQuest(quest: Quest): boolean {
  const task = questRunTask(quest)
  return !!task && isCheckpointActivityTask(task)
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
 * task check, an Activity quest whose checkpoint target is missing would look
 * automatable and be queued with a zero duration.
 */
export function isBatchCompletableQuest(quest: Quest): boolean {
  return questRunTask(quest) !== null && !isManualQuest(quest)
}

/** Why a quest cannot be started for an account the page is not on. */
export type ForeignQuestBlocker = 'manual' | 'no-task'

/**
 * Whether this page can start a quest that belongs to another account. Only the
 * direct-API paths can, because they post with that account's own token: a
 * checkpoint Activity needs the attached desktop window and a real Stream needs
 * an actual broadcast, and both of those can only be the account the one client
 * on this machine is signed into.
 */
export function foreignQuestBlocker(quest: Quest): ForeignQuestBlocker | null {
  const task = questRunTask(quest)
  if (!task) return 'no-task'
  if (isManualQuest(quest)) return 'manual'
  return null
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

  // A named task's own value, or nothing. Every task counts in its own unit —
  // checkpoints against seconds — so another task's value is not a substitute:
  // it is a number that belongs to a task this quest is not running.
  if (taskKey) {
    const own = progress[taskKey]?.value
    if (own != null) return own
    // Discord keys the map by its own task names, which do not always match the
    // config's keys. A quest that runs a single task can still be read: the lone
    // entry has to be that task. A quest listing several tasks cannot — the
    // entry may belong to a task counting in another unit, and a checkpoint
    // count read as seconds is the number that made a card jump.
    const entries = Object.values(progress)
    if (entries.length === 1 && getQuestTasks(quest).length === 1) {
      return entries[0]?.value ?? 0
    }
    return 0
  }

  const first = Object.values(progress)[0]
  return first?.value ?? 0
}

/**
 * The task whose progress this quest is measured on: the one the app actually
 * drives. The batch routes on `getQuestKind`, so a quest that lists a game task
 * beside a video task runs through the game path and banks its progress on the
 * game task — reading the video task here would report a quest that is halfway
 * through as one that never started.
 */
export function questProgressTask(quest: Quest): QuestTaskView | null {
  const tasks = getQuestTasks(quest)
  const kind = getQuestKind(quest)
  if (kind === 'video') {
    return tasks.find(isVideoTask) ?? null
  }
  // Every quest that is not a video quest runs down the game path, and that path
  // drives the play task when the quest lists one: a play task next to a
  // checkpoint Activity runs the game, and a game counts in seconds while the
  // Activity counts in checkpoints.
  const play = tasks.find(isDesktopPlayTask)
  if (play) return play
  // A checkpoint Activity comes before the cloud game: the checkpoint is the
  // part only a human can finish, so it is what the quest is judged on — and
  // what keeps the quest out of the automatic batch. A cloud game next to it
  // would otherwise hide the checkpoint behind a duration in seconds.
  const checkpoint = tasks.find(isCheckpointActivityTask)
  if (checkpoint) return checkpoint
  const cloudGame = tasks.find(isPlayActivityTask)
  if (cloudGame) return cloudGame
  const stream = tasks.find(isStreamTask)
  if (stream) return stream
  return tasks.find(isActivityTask) ?? null
}

/**
 * How far along a quest is, as a percentage of its own target. The value is
 * read from the task the app drives and divided by that task's own target: a
 * checkpoint count divided by a duration is not a percentage, and that mismatch
 * is what made a card jump between numbers while the quest kept its progress.
 */
export function questProgressPercent(quest: Quest): number {
  const progress = quest.user_status?.progress
  const hasMap = !!progress && typeof progress === 'object' && Object.keys(progress).length > 0
  const task = questProgressTask(quest)
  const target = task?.target ?? 0
  if (target <= 0) return 0

  if (!hasMap) {
    // A quest that reports no progress map at all still carries the legacy
    // stream counter, which counts seconds like the time-based tasks do.
    const seconds = quest.user_status?.stream_progress_seconds ?? 0
    return Math.min(100, Math.max(0, (seconds / target) * 100))
  }

  const value = firstProgressValue(quest, task?.key)
  return Math.min(100, Math.max(0, (value / target) * 100))
}

/**
 * The task the app runs for a quest, with the duration it needs. The driven
 * task wins when it carries a target; otherwise the first targeted task does,
 * so a quest whose driven task has no duration can still be started.
 */
export function questRunTask(quest: Quest): QuestTaskView | null {
  const driven = questProgressTask(quest)
  if (driven?.target != null && driven.target > 0) return driven
  return firstStartableTask(quest)
}

export function firstStartableTask(quest: Quest): QuestTaskView | null {
  const tasks = getQuestTasks(quest)
  return tasks.find(task => isVideoTask(task) && task.target != null && task.target > 0)
    ?? tasks.find(task => isDesktopPlayTask(task) && task.target != null && task.target > 0)
    ?? tasks.find(task => isStreamTask(task) && task.target != null && task.target > 0)
    ?? tasks.find(task => isActivityTask(task) && task.target != null && task.target > 0)
    ?? null
}

/**
 * The application a quest belongs to. `config.application.id` is the legacy
 * home; taskConfigV2 moved the id onto the task itself, so newer quests carry
 * it only at `tasks[KEY].applications[0].id`. Prefer the task actually being
 * driven, since a quest can list several tasks with different applications.
 */
export function questApplicationId(quest?: Quest | null): string | undefined {
  const fromConfig = quest?.config.application?.id
  if (fromConfig) return fromConfig
  if (!quest) return undefined
  const routed = questRunTask(quest)
  return routed?.applications?.[0]?.id
    ?? getQuestTasks(quest).find(task => task.applications?.[0]?.id)?.applications?.[0]?.id
}
