import { describe, expect, it } from 'vitest'
import { parseReleaseNotes } from './releaseNotes'

describe('parseReleaseNotes', () => {
  it('returns nothing for an absent or non-string body', () => {
    expect(parseReleaseNotes(undefined)).toEqual([])
    expect(parseReleaseNotes(null)).toEqual([])
    expect(parseReleaseNotes(42)).toEqual([])
    expect(parseReleaseNotes('   \n  ')).toEqual([])
  })

  it('reads headings, bullets, numbered items and paragraphs', () => {
    const blocks = parseReleaseNotes([
      '# What is new',
      '',
      '- Fixed the progress bar',
      '* Added Thai locale',
      '1. Second step',
      'Plain sentence.',
    ].join('\n'))

    expect(blocks.map(block => block.type)).toEqual(['heading', 'bullet', 'bullet', 'bullet', 'text'])
    expect(blocks[0].runs[0].text).toBe('What is new')
    expect(blocks[4].runs[0].text).toBe('Plain sentence.')
  })

  it('splits bold, inline code and links into runs', () => {
    const [block] = parseReleaseNotes('Ships **queue retry** with `startPlay` and [the guide](https://example.com/a).')

    expect(block.runs).toEqual([
      { text: 'Ships ' },
      { text: 'queue retry', bold: true },
      { text: ' with ' },
      { text: 'startPlay', code: true },
      { text: ' and ' },
      { text: 'the guide', href: 'https://example.com/a' },
      { text: '.' },
    ])
  })

  it('keeps only http(s) link targets', () => {
    const [block] = parseReleaseNotes('[click](javascript:alert)')
    expect(block.runs).toEqual([{ text: 'click' }])
  })

  it('renders task-list bullets with their checkbox state', () => {
    const blocks = parseReleaseNotes('- [x] done thing\n- [ ] open thing')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].checked).toBe(true)
    expect(blocks[1].checked).toBe(false)
  })

  it('keeps fenced code verbatim instead of tokenising it', () => {
    const blocks = parseReleaseNotes(['```', '<b>raw</b> **not bold**', '```'].join('\n'))

    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('code')
    expect(blocks[0].runs[0].text).toBe('<b>raw</b> **not bold**')
  })

  it('closes an unterminated fence without losing its content', () => {
    const blocks = parseReleaseNotes('```js\nconsole.log(1)')
    expect(blocks.some(block => block.type === 'code' && block.runs[0].text.includes('console.log'))).toBe(true)
  })

  it('drops separator rules and html comments, and flattens table rows', () => {
    const blocks = parseReleaseNotes([
      '<!-- internal note -->',
      '---',
      '| Column | Value |',
      '| --- | --- |',
      'After the table.',
    ].join('\n'))

    expect(blocks.some(block => JSON.stringify(block).includes('internal note'))).toBe(false)
    expect(blocks.some(block => JSON.stringify(block).includes('---'))).toBe(false)
    expect(blocks.at(-1)?.runs[0].text).toBe('After the table.')
    expect(blocks[0].runs[0].text).toBe('Column Value')
  })

  it('unwraps blockquotes', () => {
    const blocks = parseReleaseNotes('> Note from the release page')
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].runs[0].text).toBe('Note from the release page')
  })

  it('bounds pathological input', () => {
    const manyBlocks = parseReleaseNotes(Array.from({ length: 400 }, (_, index) => `- item ${index}`).join('\n'))
    expect(manyBlocks.length).toBeLessThanOrEqual(200)

    const longLine = parseReleaseNotes(`a${'b'.repeat(5000)}`)
    expect(longLine[0].runs[0].text.length).toBeLessThanOrEqual(600)
  })
})
