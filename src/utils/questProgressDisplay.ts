import type { RunningQuest } from '@/stores/quests'
import { formatDuration } from '@/utils/questTasks'

/** Unit a running slot counts its target in; drives how its progress reads. */
export type ProgressUnit = RunningQuest['progressUnit']

/**
 * A slot only carries a percentage, so the checkpoint count is recovered by
 * multiplying it back out. Store percentages are exact `done/total * 100` values,
 * and float noise (`66.666…% * 3 = 1.999…`) would otherwise drop a submitted
 * checkpoint, hence the tolerance before flooring.
 */
const CHECKPOINT_TOLERANCE = 1e-6

/** A percentage pinned to the 0..100 range a progress bar can render. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** `m:ss` clock text for an amount of seconds. */
export function formatClockTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safeSeconds / 60)
  const secs = Math.floor(safeSeconds % 60)
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/** Checkpoints already submitted, never below 0 or above the slot total. */
export function submittedCheckpointCount(progressPercent: number, totalCheckpoints: number): number {
  const total = checkpointTotal(totalCheckpoints)
  const done = Math.floor((clampPercent(progressPercent) / 100) * total + CHECKPOINT_TOLERANCE)
  return Math.min(total, Math.max(0, done))
}

/** Compact `2/3` checkpoint text for a slot counted in checkpoints. */
export function formatCheckpointProgress(progressPercent: number, totalCheckpoints: number): string {
  const total = checkpointTotal(totalCheckpoints)
  return `${submittedCheckpointCount(progressPercent, total)}/${total}`
}

/**
 * Submitted/required text for one running slot: `2/3` when the slot counts
 * checkpoints, otherwise the existing `1:05 / 3:00` elapsed/total clock.
 */
export function formatSlotProgress(progressPercent: number, target: number, unit: ProgressUnit): string {
  if (unit === 'checkpoints') return formatCheckpointProgress(progressPercent, target)
  return `${formatClockTime((progressPercent / 100) * target)} / ${formatClockTime(target)}`
}

/** Target label text: a bare checkpoint count, otherwise the localized duration. */
export function formatRequiredTarget(target: number, unit: ProgressUnit): string {
  if (unit === 'checkpoints') return String(checkpointTotal(target))
  return formatDuration(target)
}

function checkpointTotal(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}
