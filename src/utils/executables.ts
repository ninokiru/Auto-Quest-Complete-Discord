// Platform-aware selection of a detectable game's executable.
//
// Discord's detectable-game metadata lists executables tagged by OS
// (`win32`, `linux`, `darwin`). Windows historically only ever looked at
// `win32`; these helpers generalize that so Linux can prefer a native `linux`
// executable and fall back to `win32` where it makes sense (CDP mode), while
// refusing to run a `win32`-only game through the Linux process simulator.

export interface DetectableExecutable {
  name: string
  os: string
}

export interface ExecutableCatalogEntry {
  name: string
  executables: DetectableExecutable[]
}

/**
 * Pick the executables that match a platform's OS priority list.
 * Returns the first OS in `priority` that has at least one executable.
 */
export function getCompatibleExecutables(
  executables: DetectableExecutable[],
  priority: string[]
): { sourceOs: string | null; executables: DetectableExecutable[] } {
  for (const os of priority) {
    const matches = executables.filter((executable) => executable.os === os)
    if (matches.length > 0) {
      return { sourceOs: os, executables: matches }
    }
  }
  return { sourceOs: null, executables: [] }
}

/**
 * Executables the *process simulator* can actually launch on this host.
 *
 * Mirrors `resolveSimulationExecutable`'s platform rule: Linux only ever runs a
 * native `linux` executable, so win32 entries must not be offered there even
 * though they stay in `executableOsPriority` for CDP mode. Other hosts keep the
 * plain priority-order behavior.
 */
export function getSimulationExecutables(
  executables: DetectableExecutable[],
  hostOs: string,
  priority: string[]
): DetectableExecutable[] {
  if (hostOs === 'linux') {
    return executables.filter((executable) => executable.os === 'linux')
  }
  return getCompatibleExecutables(executables, priority).executables
}

export type SimulationExecutableResolution =
  | { kind: 'supported'; executable: DetectableExecutable }
  | { kind: 'win32_only_on_linux'; windowsExecutables: DetectableExecutable[] }
  | { kind: 'not_found' }

/**
 * Resolve which executable the *process simulator* should use.
 *
 * On non-Linux hosts this preserves today's behavior (the selected name, or the
 * first `win32` executable). On Linux it only accepts a native `linux`
 * executable; a `win32`-only game yields a recoverable `win32_only_on_linux`
 * result so the caller can surface a soft error and offer CDP mode instead of
 * running a Windows binary through Wine or a fake `.exe`.
 *
 * A `selectedName` that Discord's list does not contain at all is accepted on
 * non-Linux hosts and simulated under that name. That is the case the custom
 * process-name dialog exists for — it opens precisely because the game has no
 * known executable, so requiring a match there could never succeed. A name that
 * *is* listed for another OS stays rejected: Discord says that binary belongs
 * to a different platform, and re-tagging it would silently launch nonsense.
 */
export function resolveSimulationExecutable(
  executables: DetectableExecutable[],
  hostOs: string,
  selectedName?: string
): SimulationExecutableResolution {
  if (hostOs !== 'linux') {
    const custom = selectedName?.trim()
    if (custom) {
      const listed = executables.find((executable) => executable.name === custom)
      if (!listed) {
        return { kind: 'supported', executable: { name: custom, os: hostOs } }
      }
      return listed.os === 'win32'
        ? { kind: 'supported', executable: listed }
        : { kind: 'not_found' }
    }

    const first = executables.find((executable) => executable.os === 'win32')
    return first ? { kind: 'supported', executable: first } : { kind: 'not_found' }
  }

  if (selectedName) {
    const selected = executables.find((executable) => executable.name === selectedName)

    if (selected?.os === 'linux') {
      return { kind: 'supported', executable: selected }
    }

    if (selected?.os === 'win32') {
      return { kind: 'win32_only_on_linux', windowsExecutables: [selected] }
    }
  }

  const linuxExecutable = executables.find((executable) => executable.os === 'linux')
  if (linuxExecutable) {
    return { kind: 'supported', executable: linuxExecutable }
  }

  const windowsExecutables = executables.filter((executable) => executable.os === 'win32')
  if (windowsExecutables.length > 0) {
    return { kind: 'win32_only_on_linux', windowsExecutables }
  }

  return { kind: 'not_found' }
}

const SEPARATOR = /[\\/]/

/**
 * Whether the simulator may write and launch a process under this name.
 *
 * Mirrors `is_inside_simulation_dir` in `src-tauri/src/game_simulator.rs`: the
 * name is joined onto the simulation directory, so anything that escapes it
 * (absolute path, drive prefix, `..`) is refused there. Keeping the check here
 * too lets the UI reject a typed name before it costs a quest start.
 */
export function isSimulationSafeExecutableName(name: string): boolean {
  const value = name.trim()

  if (!value) return false
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  if (/[<>:"|?*]/.test(value)) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(value)) return false

  return value.split(SEPARATOR).every((part) => part !== '' && part !== '.' && part !== '..')
}

function normalizeTitle(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

interface TitledName {
  stem: string
  version: string | null
}

/** `"EA Sports FC 26"` → stem `"EA Sports FC"`, version `"26"`. */
function splitTrailingVersion(name: string): TitledName {
  const match = /^(.*?)[\s\-_:.]+(\d{1,4})$/.exec(name.trim())
  if (!match) return { stem: name.trim(), version: null }

  return { stem: match[1].trim(), version: match[2] }
}

/** Retarget one path segment, `"fc26.exe"` (26 → 27) → `"fc27.exe"`. */
function retargetSegment(segment: string, from: string, to: string): string {
  return segment.replace(/(\d+)(\D*$)/, (matched, digits: string, tail: string) =>
    digits === from ? to + tail : matched
  )
}

function retargetExecutableName(name: string, from: string | null, to: string | null): string {
  if (!from || !to) return name

  return name
    .split(SEPARATOR)
    .map((segment) => retargetSegment(segment, from, to))
    .join('/')
}

/** Trial and demo builds share a series' naming but are not the process a quest
 *  waits for, so the plain build is always offered first. */
function buildOrder(name: string): number {
  return /(trial|demo|showcase|beta|launcher|benchmark)/.test(name) ? 1 : 0
}

/** `"Minecraft"` is a word-prefix of `"Minecraft Java Edition"`, so the two are
 *  the same product family: the shorter title is the base game and the longer
 *  one is an edition of it, which makes the registered process name evidence.
 *  The reverse direction is not evidence — `"Minecraft Dungeons"` beside
 *  `"Minecraft"` is a different game, and offering its process name would send
 *  the user after a binary Discord attributes to another title. */
function isEditionOf(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length >= long.length) return false
  return short.every((word, index) => word === long[index])
}

/**
 * Process names worth offering for a game Discord lists no executable for.
 *
 * Discord leaves `executables` empty for more than half of its detectable
 * games, which leaves the user guessing a process name. A title's siblings in
 * the same list are real evidence, in two strengths: a numbered installment
 * (`"EA Sports FC 27"` ← FC 24-26, whose `fc26.exe` becomes `fc27.exe`) and an
 * edition of a base game (`"Minecraft: Java Edition"` ← `"Minecraft"`, whose
 * registered name is offered unchanged). At most three candidates come back,
 * best evidence first. Nothing is invented here — exe names are abbreviations
 * (`mgv.exe`, `etg.exe`), so guessing from the title alone hits the real name
 * about once in ten tries and would only send the user after a process Discord
 * never detects.
 *
 * Empty result means "no evidence", and the caller should say so rather than
 * list plausible-looking nonsense.
 */
export function suggestExecutableNames(
  game: ExecutableCatalogEntry,
  catalog: ExecutableCatalogEntry[],
  hostOs: string
): string[] {
  // A native Linux/macOS process name comes from the game's own build, not from
  // its series, and Linux cannot simulate a Windows-named process at all.
  if (hostOs !== 'win32' && hostOs !== 'darwin') return []

  const target = splitTrailingVersion(game.name)
  const targetTitle = normalizeTitle(game.name)
  const targetStem = normalizeTitle(target.stem)

  const targetWords = targetTitle.split(' ')

  const ranked: Array<{
    name: string
    version: string | null
    distance: number
    retarget: boolean
    executables: DetectableExecutable[]
  }> = []
  for (const entry of catalog) {
    if (entry.name === game.name) continue

    const executables = entry.executables.filter((exe) => exe.os === hostOs)
    if (executables.length === 0) continue

    const sibling = splitTrailingVersion(entry.name)
    const title = normalizeTitle(entry.name)
    const sameTitle = title === targetTitle
    const sameSeries =
      !!target.version &&
      !!sibling.version &&
      targetStem.length > 2 &&
      normalizeTitle(sibling.stem) === targetStem

    const siblingWords = title.split(' ')
    let distance: number
    if (sameTitle) {
      distance = 0
    } else if (sameSeries) {
      distance = Math.abs(Number(sibling.version) - Number(target.version)) || 999
    } else if (isEditionOf(siblingWords, targetWords)) {
      // Weaker than a numbered sibling: an edition can easily ship its own
      // process, so this only reaches the list when nothing better matched.
      distance = 1000 + targetWords.length - siblingWords.length
    } else {
      continue
    }

    ranked.push({
      name: entry.name,
      version: sibling.version,
      distance,
      retarget: sameSeries,
      executables,
    })
  }

  ranked.sort((a, b) => a.distance - b.distance || a.name.length - b.name.length)

  const suggestions: string[] = []
  for (const source of ranked.slice(0, 3)) {
    const ordered = [...source.executables].sort(
      (a, b) => buildOrder(a.name) - buildOrder(b.name)
    )

    for (const executable of ordered.slice(0, 3)) {
      // A family match has no version to move across, so its registered name is
      // offered exactly as Discord wrote it.
      const bumped = source.retarget
        ? retargetExecutableName(executable.name, source.version, target.version)
        : executable.name
      const basename = bumped.split(SEPARATOR).pop() ?? ''

      for (const candidate of [bumped, basename]) {
        if (!candidate || !isSimulationSafeExecutableName(candidate)) continue
        if (!suggestions.includes(candidate)) suggestions.push(candidate)
      }
    }
  }

  return suggestions.slice(0, 3)
}
