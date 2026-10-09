import { describe, expect, it } from 'vitest'
import {
  clampPercent,
  formatCheckpointProgress,
  formatClockTime,
  formatRequiredTarget,
  formatSlotProgress,
  submittedCheckpointCount,
} from './questProgressDisplay'

describe('running quest progress text', () => {
  it('renders a checkpoint slot as a compact count instead of a clock', () => {
    expect(formatSlotProgress(66.66666666666666, 3, 'checkpoints')).toBe('2/3')
    expect(formatSlotProgress(33.33333333333333, 3, 'checkpoints')).toBe('1/3')
    expect(formatSlotProgress(60, 5, 'checkpoints')).toBe('3/5')
    expect(formatSlotProgress(0, 3, 'checkpoints')).toBe('0/3')
    expect(formatSlotProgress(100, 3, 'checkpoints')).toBe('3/3')
  })

  it('never leaks a seconds or remaining-time format into a checkpoint slot', () => {
    const text = formatSlotProgress(66.66666666666666, 3, 'checkpoints')
    expect(text).not.toMatch(/\d+:\d{2}/)
    expect(text).not.toMatch(/\d+s\b/)
    expect(text).not.toMatch(/\d+m\b/)
    expect(text).not.toContain(' / ')
  })

  it('keeps a time slot on the elapsed/total clock it already showed', () => {
    expect(formatSlotProgress(50, 180, 'time')).toBe('1:30 / 3:00')
    expect(formatSlotProgress(25, 600, 'time')).toBe('2:30 / 10:00')
    expect(formatSlotProgress(100, 90, 'time')).toBe('1:30 / 1:30')
    expect(formatSlotProgress(0, 45, 'time')).toBe('0:00 / 0:45')
  })

  it('clamps a derived checkpoint count into the slot total', () => {
    expect(submittedCheckpointCount(120, 3)).toBe(3)
    expect(submittedCheckpointCount(-20, 3)).toBe(0)
    expect(formatCheckpointProgress(50, 0)).toBe('0/0')
    expect(formatCheckpointProgress(50, -5)).toBe('0/0')
  })

  it('labels the required target with a count or a duration according to the unit', () => {
    expect(formatRequiredTarget(3, 'checkpoints')).toBe('3')
    expect(formatRequiredTarget(900, 'time')).toBe('15m')
    expect(formatRequiredTarget(45, 'time')).toBe('45s')
    expect(formatClockTime(75)).toBe('1:15')
    expect(formatClockTime(-5)).toBe('0:00')
  })

  it('pins a derived percentage inside the bar range', () => {
    expect(clampPercent(137)).toBe(100)
    expect(clampPercent(-20)).toBe(0)
    expect(clampPercent(42.5)).toBe(42.5)
    expect(clampPercent(Number.NaN)).toBe(0)
  })
})
