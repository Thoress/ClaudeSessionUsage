import { describe, expect, test } from 'claude-code/testing'

import type { Group, Preview } from '../types'
import { buildReport } from '../hooks/analyze'
import { PREVIEW_CHARS, contentFromIndex, cutTo, firstTurn, hasContent, leadHint, leadOf, turnMarkdown, turnRange } from '../hooks/leads'
import { buildIndex, extendIndex, markOf, rowsFrom, textOf } from '../hooks/transcript-index'

const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const usage = (ctxRead: number, ctxWrite: number, output: number) => ({
  input_tokens: 2,
  cache_creation_input_tokens: ctxWrite,
  cache_read_input_tokens: ctxRead,
  output_tokens: output,
})

let n = 0
const said = (s: number, ctx: number, content: unknown[]) => {
  n++
  return { type: 'assistant', uuid: `m${n}`, timestamp: at(s), message: { id: `msg${n}`, usage: usage(ctx, 2000, 50), content } }
}
const call = (s: number, ctx: number, id: string, name: string, input: unknown) => said(s, ctx, [{ type: 'tool_use', id, name, input }])
const result = (s: number, id: string, content: unknown) => ({
  type: 'user',
  uuid: `r-${id}`,
  timestamp: at(s),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
})

// turn 1: a tagged prompt, thinking and a reply, then a command, a script, a
// search, a skill (its call, then its text as a meta message), a reminder, a
// read and a page; turn 2: thanks
const ROWS = [
  { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: '<command-name>/go</command-name> Build it\nand test it' } },
  said(2, 0, [
    { type: 'thinking', thinking: 'plan   the\nwork' },
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
  ]),
  result(10, 't1', 'ok '.repeat(3000)),
  call(12, 10_000, 't2', 'PowerShell', { command: 'Get-Date' }),
  result(13, 't2', [{ type: 'text', text: 'today' }]),
  call(14, 12_000, 't3', 'Grep', { pattern: 'foo', path: 'src' }),
  result(15, 't3', 'src/a.ts:1: foo'),
  call(16, 14_000, 't4', 'Skill', { skill: 'tidy' }),
  result(17, 't4', 'Launching skill: tidy'),
  { type: 'user', uuid: 'k1', isMeta: true, timestamp: at(17.1), message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x/skills/tidy\n\n# Tidy\nKeep it tidy.' }] } },
  { type: 'attachment', uuid: 'a1', timestamp: at(17.2), attachment: { type: 'todo_reminder' }, rendered: [{ content: 'Remember the todos.' + ' x'.repeat(1500) }] },
  call(18, 16_000, 't5', 'Read', { file_path: 'src/a.ts' }),
  result(19, 't5', 'const a = 1\n'.repeat(300)),
  call(20, 19_000, 't6', 'WebFetch', { url: 'https://example.com/a', prompt: 'x' }),
  result(21, 't6', 'page '.repeat(800)),
  said(25, 23_000, [{ type: 'text', text: 'Done.' }]),
  { type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: at(26) },
  { type: 'user', uuid: 'u2', timestamp: at(100), message: { role: 'user', content: 'thanks' } },
  said(102, 25_000, [{ type: 'text', text: 'You are welcome.' }]),
]

const r = buildReport('s', 'f.jsonl', ROWS, [], T0 + 200_000)
const ix = buildIndex(ROWS)
const entry = (cat: string, ref?: Group['ref'], byTurn: Record<string, number> = { 1: 0.01 }): Group => ({ cat, label: 'Entry', cost: 0.01, tokens: 10, count: 1, byTurn, ref })

// the previews as they were, scanning every row: what the index must answer alike
const scanContent = (rows: any[], g: Group): Preview | undefined => {
  const { messageId, toolUseId } = g.ref ?? {}
  if (messageId && (!toolUseId || g.cat === 'skills')) {
    const row = rows.find(x => x.uuid === messageId)
    const text = textOf(row?.message?.content) || textOf(Array.isArray(row?.rendered) ? row.rendered.map((x: any) => x?.content ?? x) : row?.rendered)
    if (text) {
      const cut = cutTo(text, PREVIEW_CHARS)
      return { title: g.label, source: cut.text, note: cut.note, isMarkdown: true }
    }
  }
  if (!toolUseId) return undefined
  let use: any
  let res: unknown
  for (const x of rows)
    for (const b of Array.isArray(x.message?.content) ? x.message.content : []) {
      if ((b?.type === 'tool_use' || b?.type === 'server_tool_use') && b.id === toolUseId) use = b
      else if (b?.type === 'tool_result' && b.tool_use_id === toolUseId) res = b.content
    }
  if (!use) return undefined
  const input = use.input ?? {}
  const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : undefined
  const output = textOf(res)
  const joinNote = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined
  if (command !== undefined && g.cat !== 'termout') {
    const { text, note } = cutTo(command, PREVIEW_CHARS)
    return { title: g.label, source: text, language: /powershell/i.test(String(use.name)) ? 'powershell' : 'bash', note: joinNote(input.description, note) }
  }
  if (g.cat === 'termout') {
    const { text, note } = cutTo(output || '(no output)', PREVIEW_CHARS)
    return { title: g.label, source: text, language: 'text', note: joinNote(command ? `$ ${command.split('\n')[0]}` : undefined, note) }
  }
  const { text, note } = cutTo(`${use.name} ${JSON.stringify(input, null, 2)}${output ? `\n\n── result ──\n${output}` : ''}`, PREVIEW_CHARS)
  return { title: g.label, source: text, language: 'text', note }
}

const strip = (p: Preview | undefined) => (p ? JSON.parse(JSON.stringify(p)) : p)

describe('leads', () => {
  test('each kind of entry leads where it is best seen', () => {
    expect(leadOf(entry('code_read', { path: 'src/a.ts', toolUseId: 't5' }))).toBe('file')
    expect(leadOf(entry('instructions', { path: 'C:/x/CLAUDE.md', messageId: 'a1' }))).toBe('file')
    expect(leadOf(entry('web', { url: 'https://example.com/a', toolUseId: 't6' }))).toBe('page')
    for (const cat of ['prompt', 'reply', 'thinking']) expect(leadOf(entry(cat, { messageId: 'u1' }))).toBe('turn')
    expect(leadOf(entry('cmd', { toolUseId: 't1' }))).toBe('show')
    expect(leadOf(entry('skills', { path: '/x/skills/tidy/SKILL.md', messageId: 'k1' }))).toBe('show')
    expect(leadOf(entry('search'))).toBe('turn')
    expect(leadOf(entry('search', undefined, {}))).toBe('none')
    expect(leadOf(entry('prompt', undefined, { 2: 0, 3: 0.5 }))).toBe('turn')
    expect(firstTurn(entry('prompt', undefined, { 2: 0, 3: 0.5 }))).toBe(3)
    expect(leadHint('turn', entry('reply', undefined, { 2: 1 }))).toBe('Click to show turn 2')
    expect(leadHint('none', entry('reply'))).toBe('')
  })

  test('the report’s entries carry what leads them', () => {
    const lead = (cat: string) => r.groups.filter(g => g.cat === cat).map(leadOf)
    expect(lead('code_read')).toEqual(['file'])
    expect(lead('web')).toEqual(['page'])
    expect(lead('cmd')).toEqual(['show', 'show'])
    expect(lead('prompt').every(l => l === 'turn')).toBe(true)
  })
})

describe('content preview', () => {
  test('a command shows the command, in its shell’s language', () => {
    const bash = contentFromIndex(ix, entry('cmd', { toolUseId: 't1' }))!
    expect(bash.source).toBe('npm test')
    expect(bash.language).toBe('bash')
    expect(bash.note).toBe('Run the tests')
    expect(contentFromIndex(ix, entry('cmd', { toolUseId: 't2' }))?.language).toBe('powershell')
  })

  test('terminal output shows the output', () => {
    const out = contentFromIndex(ix, entry('termout', { toolUseId: 't2' }))!
    expect(out.source).toBe('today')
    expect(out.language).toBe('text')
    expect(out.note).toBe('$ Get-Date')
    expect(contentFromIndex(ix, entry('termout', { toolUseId: 't1' }))!.source.startsWith('ok ok')).toBe(true)
  })

  test('a skill shows its text from the meta message', () => {
    const skill = r.groups.find(g => g.cat === 'skills' && g.ref?.messageId === 'k1')!
    const p = contentFromIndex(ix, skill)!
    expect(p.isMarkdown).toBe(true)
    expect(p.source.includes('Keep it tidy.')).toBe(true)
    // the skill's own call carries a tool id too: still its text
    expect(contentFromIndex(ix, entry('skills', { toolUseId: 't4', messageId: 'k1' }))!.source.includes('# Tidy')).toBe(true)
  })

  test('an injected reminder shows its rendered text', () => {
    const reminder = r.groups.find(g => g.ref?.messageId === 'a1')!
    expect(contentFromIndex(ix, reminder)!.source.startsWith('Remember the todos.')).toBe(true)
  })

  test('any other tool shows the call and its result', () => {
    const p = contentFromIndex(ix, entry('search', { toolUseId: 't3' }))!
    expect(p.source).toBe(`Grep ${JSON.stringify({ pattern: 'foo', path: 'src' }, null, 2)}\n\n── result ──\nsrc/a.ts:1: foo`)
    expect(contentFromIndex(ix, entry('search', { toolUseId: 'missing' }))).toBeUndefined()
    expect(contentFromIndex(ix, entry('search'))).toBeUndefined()
  })

  test('content past the cap is cut, with a note saying so', () => {
    const long = buildIndex([call(1, 0, 'tl', 'Bash', { command: 'x'.repeat(PREVIEW_CHARS + 10_000) })])
    const p = contentFromIndex(long, entry('cmd', { toolUseId: 'tl' }))!
    expect(p.source.length).toBe(PREVIEW_CHARS)
    expect(p.note).toBe('first 60k of 70k characters')
  })
})

describe('turn preview', () => {
  const t1 = turnMarkdown(ix, r, 1)!
  const parts = t1.source.split('\n\n')

  test('speakers head their stretches: you quoted, Claude plain, calls a list', () => {
    expect(t1.isMarkdown).toBe(true)
    expect(t1.title.startsWith('Turn 1: ')).toBe(true)
    expect(parts[0]).toBe('#### You')
    expect(parts[1]).toBe('> /go Build it\n> and test it')
    expect(parts[2]).toBe('#### Claude')
    expect(parts[3]).toBe('*Thinking: plan the work*')
    expect(parts[4]).toBe('On it.')
    expect(parts[5]!.split('\n')).toEqual([
      '- `Bash` Run the tests',
      '- `PowerShell` Get-Date',
      '- `Grep` foo',
      '- `Skill` tidy',
      '- `Read` src/a.ts',
      '- `WebFetch` https://example.com/a',
    ])
    expect(parts[6]).toBe('Done.')
    // the skill's text and the reminder are not your words
    expect(t1.source.includes('Keep it tidy')).toBe(false)
    expect(t1.source.includes('<command-name>')).toBe(false)
  })

  test('a turn stops where the next begins', () => {
    expect(t1.source.includes('thanks')).toBe(false)
    expect(t1.source.includes('welcome')).toBe(false)
    expect(turnMarkdown(ix, r, 2)!.source).toBe('#### You\n\n> thanks\n\n#### Claude\n\nYou are welcome.')
    expect(turnMarkdown(ix, r, 3)).toBeUndefined()
    expect(turnRange(ix, r, 1)!.isWhole).toBe(true)
    expect(turnRange(ix, r, 2)!.isWhole).toBe(false)
  })
})

describe('index', () => {
  test('answers as a scan of every row does', () => {
    expect(r.groups.length).toBeGreaterThan(5)
    for (const g of r.groups) expect(strip(contentFromIndex(ix, g))).toEqual(strip(scanContent(ROWS, g)))
  })

  test('grown a line at a time, it is the index built at once', () => {
    const grown = buildIndex([])
    for (const row of ROWS) extendIndex(grown, [row])
    for (const g of r.groups) expect(strip(contentFromIndex(grown, g))).toEqual(strip(contentFromIndex(ix, g)))
    for (const turn of [1, 2]) expect(turnMarkdown(grown, r, turn)?.source).toBe(turnMarkdown(ix, r, turn)?.source)
  })

  test('knows when it holds an entry whole, so a grown file need not be read', () => {
    const early = buildIndex(ROWS.slice(0, 2))
    expect(hasContent(early, entry('cmd', { toolUseId: 't1' }))).toBe(false)
    expect(hasContent(ix, entry('cmd', { toolUseId: 't1' }))).toBe(true)
    expect(hasContent(ix, entry('skills', { messageId: 'k1' }))).toBe(true)
    expect(turnRange(buildIndex(ROWS.slice(0, 5)), r, 1)!.isWhole).toBe(false)
  })

  test('reads on past the lines it has, and again a line cut mid-write', () => {
    const lines = ROWS.map(x => JSON.stringify(x))
    const text = `${lines.slice(0, 3).join('\n')}\n${lines[3]!.slice(0, 20)}`
    const first = rowsFrom(text, 0)
    expect(first.rows.length).toBe(3)
    expect(first.consumed).toBe(text.length - 20)
    const more = `${lines.slice(0, 3).join('\n')}\n${lines.slice(3).join('\n')}\n`
    expect(markOf(more, first.consumed)).toBe(markOf(text, first.consumed))
    const rest = rowsFrom(more, first.consumed)
    expect(rest.rows.length).toBe(ROWS.length - 3)
    expect(rest.consumed).toBe(more.length)
    // a last line written whole but without its newline counts
    expect(rowsFrom(lines.slice(0, 2).join('\n'), 0).rows.length).toBe(2)
  })
})
