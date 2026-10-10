/**
 * Minimal, safe renderer for GitHub release bodies.
 *
 * Release notes are markdown, and the obvious implementation is `v-html` with a
 * markdown library — that would need a new dependency and would inject whatever the
 * release author wrote straight into the page. Instead the body is parsed into a flat
 * list of blocks whose text is rendered by Vue interpolation, so nothing is ever
 * treated as markup, and links only become clickable when they are http(s).
 */
export interface NoteRun {
  text: string
  bold?: boolean
  code?: boolean
  href?: string
}

export interface NoteBlock {
  /** `code` keeps its runs untokenised so a fenced snippet stays verbatim. */
  type: 'heading' | 'bullet' | 'text' | 'code'
  runs: NoteRun[]
  checked?: boolean
}

const MAX_BLOCKS = 200
const MAX_LINE = 600
const MAX_CODE_LENGTH = 4000
const INLINE_RE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g
const HEADING_RE = /^(#{1,3})\s+(.*)$/
const BULLET_RE = /^[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/
const ORDERED_RE = /^\d+[.)]\s+(.*)$/
const RULE_RE = /^([-*_])(?:\s*\1){2,}$/
const FENCE_RE = /^\s*```/
const QUOTE_RE = /^>\s?(.*)$/

function externalLink(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed.slice(0, 300) : undefined
}

/** Split one line into plain / bold / inline-code / link runs. */
function parseInline(value: string): NoteRun[] {
  const source = value.replace(/<!--[\s\S]*?-->/g, '').slice(0, MAX_LINE)
  const runs: NoteRun[] = []
  let cursor = 0

  // The shared regex is stateful, so rewind it before every line.
  INLINE_RE.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = INLINE_RE.exec(source)) !== null) {
    if (match.index > cursor) runs.push({ text: source.slice(cursor, match.index) })

    const [full, bold, code, linkText, linkUrl] = match
    if (bold !== undefined) {
      runs.push({ text: bold, bold: true })
    } else if (code !== undefined) {
      runs.push({ text: code, code: true })
    } else if (linkText !== undefined) {
      const href = externalLink(linkUrl)
      runs.push(href === undefined ? { text: linkText } : { text: linkText, href })
    }
    cursor = match.index + full.length
  }

  if (cursor < source.length) runs.push({ text: source.slice(cursor) })
  return runs.filter(run => run.text !== '')
}

/** A markdown table reads badly as bullets, so each row becomes one flat line. */
function tableLineBlock(line: string): NoteBlock {
  const text = line.replace(/[`*_]/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim()
  // `| --- | :-: |` is the separator under a table header, not content worth showing.
  if (!text || /^[-: ]+$/.test(text)) return { type: 'text', runs: [] }
  return { type: 'text', runs: [{ text }] }
}

function codeBlock(lines: string[]): NoteBlock {
  return { type: 'code', runs: [{ text: lines.join('\n').slice(0, MAX_CODE_LENGTH), code: true }] }
}

/** Turn a release body into blocks the panel can render with plain text nodes. */
export function parseReleaseNotes(body: unknown): NoteBlock[] {
  if (typeof body !== 'string' || !body.trim()) return []

  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const blocks: NoteBlock[] = []
  let codeLines: string[] | null = null

  for (const rawLine of lines) {
    // Checked before any branch, because closing a fence pushes a block too.
    if (blocks.length >= MAX_BLOCKS) break

    const line = rawLine.slice(0, MAX_LINE)

    if (FENCE_RE.test(line)) {
      if (codeLines === null) {
        codeLines = []
      } else {
        blocks.push(codeBlock(codeLines))
        codeLines = null
      }
      continue
    }

    if (codeLines !== null) {
      codeLines.push(line)
      if (codeLines.join('\n').length > MAX_CODE_LENGTH) {
        blocks.push(codeBlock(codeLines))
        codeLines = null
      }
      continue
    }

    const trimmed = line.trim()
    if (!trimmed || RULE_RE.test(trimmed)) continue

    if (/^\|/.test(trimmed)) {
      blocks.push(tableLineBlock(trimmed))
      continue
    }

    const heading = HEADING_RE.exec(trimmed)
    if (heading) {
      blocks.push({ type: 'heading', runs: parseInline(heading[2]) })
      continue
    }

    const bullet = BULLET_RE.exec(trimmed)
    if (bullet) {
      const checked = bullet[1] === undefined ? undefined : bullet[1].toLowerCase() === 'x'
      blocks.push(checked === undefined
        ? { type: 'bullet', runs: parseInline(bullet[2]) }
        : { type: 'bullet', runs: parseInline(bullet[2]), checked })
      continue
    }

    const ordered = ORDERED_RE.exec(trimmed)
    if (ordered) {
      blocks.push({ type: 'bullet', runs: parseInline(ordered[1]) })
      continue
    }

    const quoted = QUOTE_RE.exec(trimmed)
    blocks.push({ type: 'text', runs: parseInline(quoted ? quoted[1] : trimmed) })
  }

  // An unterminated fence still needs its content shown.
  if (codeLines !== null && codeLines.length > 0 && blocks.length < MAX_BLOCKS) {
    blocks.push(codeBlock(codeLines))
  }

  // A line that was only a markdown comment or only link markup leaves nothing behind,
  // and an empty paragraph would still take vertical space in the panel.
  return blocks.filter(block => block.type === 'code' || block.runs.length > 0)
}
