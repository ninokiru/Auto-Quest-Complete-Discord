import { describe, expect, it } from 'vitest'
import { compareVersions, formatVersionLabel } from './version'

describe('compareVersions', () => {
  it('orders numerical cores numerically', () => {
    expect(compareVersions('0.10.10', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v0.0.4', '0.0.5')).toBe(-1)
  })

  it('keeps pre-releases below the bare core', () => {
    expect(compareVersions('0.0.5-rc1', '0.0.5')).toBe(-1)
    expect(compareVersions('0.0.5-rc2', '0.0.5-rc1')).toBe(1)
  })

  it('sorts patch labels above the bare core and numerically', () => {
    expect(compareVersions('0.0.5-L1.1', '0.0.5')).toBe(1)
    expect(compareVersions('0.0.5-L2.1', '0.0.5-L1.1')).toBe(1)
    expect(compareVersions('0.0.5-L10.1', '0.0.5-L9.1')).toBe(1)
    expect(compareVersions('0.0.5-L1.2', '0.0.5-L1.1')).toBe(1)
    expect(compareVersions('0.0.5-L3.1', '0.0.5-L3.1')).toBe(0)
  })

  it('keeps a patch of an older core below the next core', () => {
    expect(compareVersions('0.0.6', '0.0.5-L99.9')).toBe(1)
  })

  it('ranks pre-release < bare core < patch label', () => {
    const ordered = ['0.0.5-rc1', '0.0.5', '0.0.5-L1.1', '0.0.5-L2.1']
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i], ordered[i - 1])).toBe(1)
    }
  })
})

describe('formatVersionLabel', () => {
  it('renders the patch label with L and #', () => {
    expect(formatVersionLabel('0.0.5-L123.1')).toBe('0.0.5 L123#1')
    expect(formatVersionLabel('v0.0.5-L2.3')).toBe('0.0.5 L2#3')
  })

  it('leaves plain and pre-release versions untouched', () => {
    expect(formatVersionLabel('0.0.5')).toBe('0.0.5')
    expect(formatVersionLabel('v0.0.5-rc1')).toBe('0.0.5-rc1')
  })
})
