import { describe, it, expect } from 'vitest'
import {
  getCompatibleExecutables,
  getSimulationExecutables,
  isSimulationSafeExecutableName,
  resolveSimulationExecutable,
  suggestExecutableNames,
  type DetectableExecutable,
  type ExecutableCatalogEntry,
} from './executables'

const win: DetectableExecutable = { name: 'game.exe', os: 'win32' }
const lin: DetectableExecutable = { name: 'game', os: 'linux' }
const mac: DetectableExecutable = { name: 'game.app', os: 'darwin' }

describe('getCompatibleExecutables', () => {
  it('returns an empty result when the priority list is unavailable', () => {
    expect(getCompatibleExecutables([win, lin], [])).toEqual({
      sourceOs: null,
      executables: [],
    })
  })

  it('prefers the first OS in the priority list that has a match', () => {
    const result = getCompatibleExecutables([win, lin], ['linux', 'win32'])
    expect(result.sourceOs).toBe('linux')
    expect(result.executables).toEqual([lin])
  })

  it('falls back to the next OS when the first has no match', () => {
    const result = getCompatibleExecutables([win], ['linux', 'win32'])
    expect(result.sourceOs).toBe('win32')
    expect(result.executables).toEqual([win])
  })

  it('returns an empty result when nothing matches', () => {
    const result = getCompatibleExecutables([mac], ['linux', 'win32'])
    expect(result.sourceOs).toBeNull()
    expect(result.executables).toEqual([])
  })
})

describe('getSimulationExecutables', () => {
  it('Linux never offers win32 executables, matching resolveSimulationExecutable', () => {
    expect(getSimulationExecutables([win, lin], 'linux', ['linux', 'win32'])).toEqual([lin])
    expect(getSimulationExecutables([win], 'linux', ['linux', 'win32'])).toEqual([])
    // The UI and the quest-start path must agree about win32-only games.
    expect(resolveSimulationExecutable([win], 'linux').kind).toBe('win32_only_on_linux')
  })

  it('non-Linux hosts keep the plain priority-order behavior', () => {
    expect(getSimulationExecutables([win, lin], 'win32', ['win32'])).toEqual([win])
    expect(getSimulationExecutables([mac], 'darwin', ['win32'])).toEqual([])
  })
})

describe('resolveSimulationExecutable', () => {
  it('non-Linux hosts keep the win32-first behavior', () => {
    expect(resolveSimulationExecutable([win, lin], 'win32')).toEqual({
      kind: 'supported',
      executable: win,
    })
  })

  it('non-Linux hosts only honor an explicit win32 selection', () => {
    expect(resolveSimulationExecutable([win, lin], 'darwin', 'game.exe')).toEqual({
      kind: 'supported',
      executable: win,
    })
    expect(resolveSimulationExecutable([win, lin], 'darwin', 'game')).toEqual({ kind: 'not_found' })
  })

  it('honors a custom name that Discord has no executable for', () => {
    // The play-quest dialog only opens when the game has no host-compatible
    // executable, so an unlisted name is the expected input, not a failure.
    expect(resolveSimulationExecutable([], 'win32', 'FC27.exe')).toEqual({
      kind: 'supported',
      executable: { name: 'FC27.exe', os: 'win32' },
    })
    expect(resolveSimulationExecutable([lin], 'win32', '  FC27.exe  ')).toEqual({
      kind: 'supported',
      executable: { name: 'FC27.exe', os: 'win32' },
    })
  })

  it('Linux keeps refusing an unlisted custom name', () => {
    expect(resolveSimulationExecutable([], 'linux', 'game.exe')).toEqual({ kind: 'not_found' })
  })

  it('Linux prefers a native linux executable', () => {
    expect(resolveSimulationExecutable([win, lin], 'linux')).toEqual({
      kind: 'supported',
      executable: lin,
    })
  })

  it('Linux reports win32-only games as a recoverable result', () => {
    expect(resolveSimulationExecutable([win], 'linux')).toEqual({
      kind: 'win32_only_on_linux',
      windowsExecutables: [win],
    })
  })

  it('Linux flags an explicitly selected win32 executable', () => {
    expect(resolveSimulationExecutable([win, lin], 'linux', 'game.exe')).toEqual({
      kind: 'win32_only_on_linux',
      windowsExecutables: [win],
    })
  })

  it('reports not_found when there is no usable executable', () => {
    expect(resolveSimulationExecutable([mac], 'linux')).toEqual({ kind: 'not_found' })
    expect(resolveSimulationExecutable([], 'win32')).toEqual({ kind: 'not_found' })
  })
})

function entry(name: string, executables: DetectableExecutable[]): ExecutableCatalogEntry {
  return { name, executables }
}

describe('suggestExecutableNames', () => {
  const fc26 = entry('EA Sports FC 26', [
    { name: 'ea sports fc 26/fc26.exe', os: 'win32' },
    { name: 'ea sports fc 26/fc26_trial.exe', os: 'win32' },
  ])

  it('retargets a series sibling onto the unknown game', () => {
    const suggestions = suggestExecutableNames(
      entry('EA Sports FC 27', []),
      [entry('EA Sports FC 27', []), fc26],
      'win32'
    )

    expect(suggestions).toContain('ea sports fc 27/fc27.exe')
    expect(suggestions).toContain('fc27.exe')
  })

  it('uses a second entry for the same title even without a series number', () => {
    const alias = entry('SILENT HILL 2', [{ name: 'win64/sh2.exe', os: 'win32' }])
    const suggestions = suggestExecutableNames(
      entry('Silent Hill 2', []),
      [entry('Silent Hill 2', []), alias],
      'win32'
    )

    expect(suggestions).toEqual(['win64/sh2.exe', 'sh2.exe'])
  })

  it('prefers the closest installment', () => {
    const suggestions = suggestExecutableNames(
      entry('EA Sports FC 27', []),
      [
        entry('EA Sports FC 27', []),
        entry('EA Sports FC 24', [{ name: 'fc24.exe', os: 'win32' }]),
        fc26,
      ],
      'win32'
    )

    expect(suggestions[0]).toBe('ea sports fc 27/fc27.exe')
  })

  it('offers an edition the process name registered for its base game', () => {
    const suggestions = suggestExecutableNames(
      entry('Minecraft: Java Edition', []),
      [
        entry('Minecraft: Java Edition', []),
        entry('Minecraft', [{ name: 'minecraft/minecraft.windows.exe', os: 'win32' }]),
      ],
      'win32'
    )

    expect(suggestions).toEqual(['minecraft/minecraft.windows.exe', 'minecraft.windows.exe'])
  })

  it('refuses the reverse direction, where the longer sibling is another game', () => {
    const suggestions = suggestExecutableNames(
      entry('Minecraft', []),
      [
        entry('Minecraft', []),
        entry('Minecraft Dungeons', [{ name: 'win64/dungeons-win64-shipping.exe', os: 'win32' }]),
      ],
      'win32'
    )

    expect(suggestions).toEqual([])
  })

  it('ranks a numbered installment above an edition match', () => {
    const suggestions = suggestExecutableNames(
      entry('EA Sports FC 27', []),
      [
        entry('EA Sports FC 27', []),
        entry('EA Sports FC', [{ name: 'easportsfc.exe', os: 'win32' }]),
        entry('EA Sports FC 26', [{ name: 'fc26.exe', os: 'win32' }]),
      ],
      'win32'
    )

    expect(suggestions).toEqual(['fc27.exe', 'easportsfc.exe'])
  })

  it('returns nothing when no sibling carries an executable for this host', () => {
    const catalog = [
      entry('EA Sports FC 27', []),
      entry('Palworld', [{ name: 'palworld.exe', os: 'win32' }]),
    ]

    expect(suggestExecutableNames(entry('EA Sports FC 27', []), catalog, 'win32')).toEqual([])
    expect(suggestExecutableNames(fc26, [fc26], 'win32')).toEqual([])
  })

  it('never suggests on Linux, where a Windows process name cannot be simulated', () => {
    const unknown = entry('EA Sports FC 27', [])

    expect(suggestExecutableNames(unknown, [unknown, fc26], 'linux')).toEqual([])
  })

  it('drops candidates the simulator would refuse to write', () => {
    const suggestions = suggestExecutableNames(
      entry('EA Sports FC 27', []),
      [
        entry('EA Sports FC 27', []),
        entry('EA Sports FC 26', [
          { name: '../../windows/system32/fc26.exe', os: 'win32' },
          { name: 'fc26.exe', os: 'win32' },
        ]),
      ],
      'win32'
    )

    expect(suggestions).toEqual(['fc27.exe'])
  })
})

describe('isSimulationSafeExecutableName', () => {
  it('accepts plain and relative-subdirectory process names', () => {
    for (const name of [
      'FC27.exe',
      'ea sports fc 27/fc27.exe',
      'Binaries\\Win64\\wrc.exe',
      'game.app',
    ]) {
      expect(isSimulationSafeExecutableName(name)).toBe(true)
    }
  })

  it('rejects anything that can leave the simulation directory', () => {
    for (const name of [
      '',
      '   ',
      '../evil.exe',
      'a/../../evil.exe',
      '/abs/game.exe',
      '\\abs\\game.exe',
      'C:\\Windows\\game.exe',
      'c:/windows/game.exe',
      'game/',
      './game.exe',
      'game|other.exe',
      'game\u0000.exe',
    ]) {
      expect(isSimulationSafeExecutableName(name)).toBe(false)
    }
  })
})
