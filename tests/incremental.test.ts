import { describe, expect, test } from 'claude-code/testing'

import { buildReport, chainOf, parseJsonl, reportOf } from '../hooks/analyze'
import { type Reader, follow } from '../hooks/transcripts'

const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const NOW = T0 + 3600_000
const model = 'claude-opus-5-5'

const usage = (read: number, write: number, output: number, thinking = 0) => ({
  input_tokens: 3,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  output_tokens: output,
  output_tokens_details: { thinking_tokens: thinking },
})
const said = (uuid: string, s: number, id: string, u: object, content: object[]) => ({ type: 'assistant', uuid, timestamp: at(s), message: { id, model, usage: u, content } })
const user = (uuid: string, s: number, content: unknown, extra: object = {}) => ({ type: 'user', uuid, timestamp: at(s), message: { role: 'user', content }, ...extra })
const result = (uuid: string, s: number, toolUseId: string, content: string, extra: object = {}) => user(uuid, s, [{ type: 'tool_result', tool_use_id: toolUseId, content }], extra)

// two turns and a woken one: a streamed response over three rows, a
// subagent, a compaction, a stub usage, a skill; text past ASCII throughout
const MAIN = [
  user('u1', 0, 'Look into the bug, bitte: Grüße 🎉'),
  { type: 'attachment', uuid: 'a1', timestamp: at(0.1), attachment: { type: 'instructions', files: [{ path: 'C:/p/CLAUDE.md', content: 'ä'.repeat(900) }] }, rendered: [{ content: 'ä'.repeat(900) }] },
  said('m1a', 4, 'm1', usage(0, 20000, 400, 150), [{ type: 'thinking', thinking: '' }]),
  said('m1b', 5, 'm1', usage(0, 20000, 400, 150), [{ type: 'text', text: 'Let me look — één moment.' }]),
  said('m1c', 6, 'm1', usage(0, 20000, 400, 150), [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
  result('r1', 30, 't1', 'FAIL ✗ '.repeat(400)),
  said('m2', 32, 'm2', usage(20000, 3500, 120), [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Find the cause', prompt: 'Find it' } }]),
  result('r2', 90, 'ag1', 'It is in parse.ts 🐛', { toolUseResult: { agentId: 'sub1' } }),
  said('m3a', 95, 'm3', usage(23500, 600, 900), [{ type: 'text', text: 'Found it.' }]),
  said('m3b', 96, 'm3', usage(23500, 600, 900), [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: 'src/parse.ts', old_string: 'a', new_string: 'b'.repeat(2000) } }]),
  result('r3', 97, 't3', 'File edited'),
  said('m4', 100, 'm4', usage(24100, 300, 30), [{ type: 'text', text: 'Fixed.' }]),
  { type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: at(101) },
  user('u2', 400, 'And the tests?'),
  said('m5', 402, 'm5', usage(24400, 200, 40), [{ type: 'tool_use', id: 't5', name: 'Read', input: { file_path: 'C:/p/README.md' } }]),
  result('r5', 403, 't5', 'Read me ✓ '.repeat(300)),
  { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(404) },
  user('cs', 405, 'Summary of the conversation so far.', { isCompactSummary: true }),
  said('m6', 410, 'm6', usage(12000, 900, 60), [{ type: 'text', text: 'Tests pass.' }]),
  { type: 'system', subtype: 'stop_hook_summary', uuid: 's2', timestamp: at(411) },
  user('n1', 900, '<task-notification>a background task finished</task-notification>'),
  said('m7', 902, 'm7', usage(12900, 100, 1), [{ type: 'text', text: 'The background task finished; its output is fine. '.repeat(4) }]),
  user('k1', 903, 'Base directory for this skill: C:/x/skills/review\n\nReview the change.', { isMeta: true }),
  said('m8', 905, 'm8', usage(13000, 400, 25), [{ type: 'text', text: 'Reviewed.' }]),
]

// the subagent the second request ran, its last response streamed over two rows with a stub usage
const SUB = [
  user('x0', 33, 'Find it'),
  said('x1', 35, 'x1', usage(0, 6000, 50), [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'parse' } }]),
  result('x2', 36, 'g1', 'src/parse.ts:12 ✓\n'.repeat(40)),
  said('x3a', 80, 'x3', usage(6000, 800, 2), [{ type: 'text', text: 'It is in parse.ts, line twelve. ' }]),
  said('x3b', 85, 'x3', usage(6000, 800, 2), [{ type: 'text', text: 'The guard is inverted. '.repeat(5) }]),
]

const jsonl = (rows: object[]) => rows.map(r => JSON.stringify(r) + '\n').join('')
const ts = (r: object) => Date.parse((r as { timestamp: string }).timestamp)

/** UTF-8 length, written out: the fake disk counts bytes as a real one does. */
const utf8 = (s: string) => {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** The character index of a byte offset; a byte inside a character is an error. */
function charIndex(s: string, bytes: number): number {
  let b = 0
  let i = 0
  for (const ch of s) {
    if (b === bytes) return i
    b += utf8(ch)
    i += ch.length
    if (b > bytes) throw new Error(`byte ${bytes} is inside a character`)
  }
  if (b === bytes) return i
  throw new Error(`byte ${bytes} is past the end`)
}

/** A disk in memory: files by path, each write a new time; it counts the reads from the start. */
function disk() {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let clock = 0
  // `tiny`: reads from the start again of a file read before while what was
  // read of it was shorter than the proof window each read begins with
  const counts = { whole: 0, parts: 0, tiny: 0 }
  const seen = new Map<string, number>()
  const reader: Reader = {
    stat: async path => {
      const f = files.get(path)
      return f && { size: utf8(f.text), mtimeMs: f.mtimeMs }
    },
    list: async dir =>
      [...files]
        .filter(([path]) => path.startsWith(`${dir}/`) && path.endsWith('.jsonl'))
        .map(([path, f]) => ({ name: path.slice(dir.length + 1), size: utf8(f.text), mtimeMs: f.mtimeMs })),
    readFrom: async (path, from) => {
      const f = files.get(path)
      if (!f) throw new Error(`no file ${path}`)
      const i = charIndex(f.text, from.bytes)
      if (i !== from.chars) throw new Error(`byte ${from.bytes} is character ${i}, not ${from.chars}`)
      if (from.bytes === 0) {
        counts.whole++
        if ((seen.get(path) ?? Infinity) < 256) counts.tiny++
      } else counts.parts++
      seen.set(path, f.text.length)
      return f.text.slice(i)
    },
  }
  const write = (path: string, text: string) => {
    if (files.get(path)?.text !== text) files.set(path, { text, mtimeMs: ++clock })
  }
  const remove = (path: string) => files.delete(path)
  return { reader, write, remove, counts, files }
}

const subPath = (file: string, id: string) => `${file.replace(/\.jsonl$/, '')}/subagents/agent-${id}.jsonl`

/** The full analysis of what the disk holds now: the reference every refresh must equal. */
function fullOf(d: ReturnType<typeof disk>, file: string) {
  const dir = `${file.replace(/\.jsonl$/, '')}/subagents`
  const subs = [...d.files]
    .filter(([path]) => path.startsWith(`${dir}/`))
    .map(([path, f]) => ({ id: path.slice(dir.length + 1).replace(/^agent-/, '').replace(/\.jsonl$/, ''), rows: parseJsonl(f.text) }))
  return buildReport('s', file, parseJsonl(d.files.get(file)?.text ?? ''), subs, NOW)
}

const same = (a: object, b: object) => expect({ ...a, generatedAt: 0 }).toEqual({ ...b, generatedAt: 0 })

let files = 0
const freshFile = () => `C:/t/p/session-${++files}.jsonl`

/** Shows the disk the main rows up to `n` (and `cut` characters of the next), the subagent's rows up to then. */
function showUpTo(d: ReturnType<typeof disk>, file: string, n: number, cut = 0) {
  const shown = MAIN.slice(0, n)
  const next = MAIN[n]
  d.write(file, jsonl(shown) + (next && cut > 0 ? JSON.stringify(next).slice(0, cut) : ''))
  const until = shown.length > 0 ? ts(shown[shown.length - 1]!) : -Infinity
  const sub = SUB.filter(r => ts(r) <= until)
  if (sub.length > 0) d.write(subPath(file, 'sub1'), jsonl(sub))
}

describe('following a transcript', () => {
  test('the fixture covers what a resumed analysis must carry over', () => {
    const r = fullOf((() => {
      const d = disk()
      showUpTo(d, 'C:/t/p/check.jsonl', MAIN.length)
      return d
    })(), 'C:/t/p/check.jsonl')
    expect(r.turns).toBe(3)
    expect(r.agents.length).toBe(1)
    expect(r.notes.some(n => n.includes('estimated'))).toBe(true)
    expect(r.groups.some(g => g.cat === 'skills')).toBe(true)
  })

  test('a refresh after every row equals a full analysis of the rows so far', async () => {
    const d = disk()
    const file = freshFile()
    for (let n = 1; n <= MAIN.length; n++) {
      showUpTo(d, file, n)
      same(await follow(d.reader, 's', file, NOW), fullOf(d, file))
    }
    // the main file and the subagent's read once each from the start, then only
    // what was added: every refresh after the first reads the main file's new part
    expect(d.counts.whole - d.counts.tiny).toBe(2)
    expect(d.counts.parts + d.counts.tiny).toBeGreaterThanOrEqual(MAIN.length - 1)
  })

  test('two reads split anywhere give the full analysis, and the first is right on its own', async () => {
    // among the cuts: inside the streamed response (after m1a, m1b), between
    // a tool call and its result (after m1c, m2), mid-turn, after the compaction
    for (let n = 0; n <= MAIN.length; n++) {
      const d = disk()
      const file = freshFile()
      showUpTo(d, file, n)
      if (n > 0) same(await follow(d.reader, 's', file, NOW), fullOf(d, file))
      showUpTo(d, file, MAIN.length)
      same(await follow(d.reader, 's', file, NOW), fullOf(d, file))
    }
  })

  test('a row cut mid-write is left for the next read', async () => {
    const d = disk()
    const file = freshFile()
    for (const n of [3, 5, 7, 9, 14, 21]) {
      const line = JSON.stringify(MAIN[n])
      // halfway, just before its newline, and inside a character past ASCII
      for (const cut of [Math.floor(line.length / 2), line.length - 1, line.indexOf('🎉') + 1 || 10]) {
        showUpTo(d, file, n, cut)
        same(await follow(d.reader, 's', file, NOW), fullOf(d, file))
      }
      showUpTo(d, file, n + 1)
      same(await follow(d.reader, 's', file, NOW), fullOf(d, file))
    }
  })

  test('nothing changed, nothing is read', async () => {
    const d = disk()
    const file = freshFile()
    showUpTo(d, file, 12)
    const first = await follow(d.reader, 's', file, NOW)
    const reads = d.counts.whole + d.counts.parts
    const again = await follow(d.reader, 's', file, NOW)
    expect(d.counts.whole + d.counts.parts).toBe(reads)
    same(again, first)
  })

  test('a report taken mid-stream is not changed by the rows after it', async () => {
    const d = disk()
    const file = freshFile()
    showUpTo(d, file, 4)
    const early = await follow(d.reader, 's', file, NOW)
    const copy = JSON.parse(JSON.stringify(early))
    showUpTo(d, file, MAIN.length)
    await follow(d.reader, 's', file, NOW)
    expect(JSON.parse(JSON.stringify(early))).toEqual(copy)
  })

  test('a subagent appearing later is read from its start', async () => {
    const d = disk()
    const file = freshFile()
    showUpTo(d, file, 20)
    await follow(d.reader, 's', file, NOW)
    const later = SUB.map(r => ({ ...r, uuid: `late-${(r as { uuid: string }).uuid}`, timestamp: at(ts(r) / 1000 - T0 / 1000 + 870) }))
    d.write(subPath(file, 'sub2'), jsonl(later))
    showUpTo(d, file, MAIN.length)
    const r = await follow(d.reader, 's', file, NOW)
    same(r, fullOf(d, file))
    expect(r.agents.length).toBe(2)
  })
})

describe('falling back to a full analysis', () => {
  test('a file cut short is analyzed again from the start', async () => {
    const d = disk()
    const file = freshFile()
    showUpTo(d, file, MAIN.length)
    await follow(d.reader, 's', file, NOW)
    const whole = d.counts.whole
    // rewritten shorter: an earlier state of it, with a prompt of its own
    d.write(file, jsonl([user('v1', 0, 'Another start'), ...MAIN.slice(1, 6)]))
    const r = await follow(d.reader, 's', file, NOW)
    expect(d.counts.whole).toBe(whole + 2)
    same(r, fullOf(d, file))
    expect(r.turnRows[0]!.prompt).toBe('Another start')
  })

  test('a file replaced by a longer one is noticed by what came before the new part', async () => {
    const d = disk()
    const file = freshFile()
    showUpTo(d, file, 8)
    await follow(d.reader, 's', file, NOW)
    const whole = d.counts.whole
    const other = MAIN.map(r => (r === MAIN[7] ? result('r2', 90, 'ag1', 'Something else entirely, and longer than before', { toolUseResult: { agentId: 'sub1' } }) : r))
    d.write(file, jsonl(other))
    const r = await follow(d.reader, 's', file, NOW)
    expect(d.counts.whole).toBeGreaterThan(whole)
    same(r, fullOf(d, file))
  })

  test('a subagent file gone, or another session in the same file, starts over', async () => {
    const d = disk()
    const file = freshFile()
    showUpTo(d, file, MAIN.length)
    await follow(d.reader, 's', file, NOW)
    d.remove(subPath(file, 'sub1'))
    const whole = d.counts.whole
    same(await follow(d.reader, 's', file, NOW), fullOf(d, file))
    expect(d.counts.whole).toBe(whole + 1)
    const r = await follow(d.reader, 'other', file, NOW)
    expect(r.sessionId).toBe('other')
    expect(d.counts.whole).toBe(whole + 2)
  })
})

describe('a resumable chain', () => {
  test('fed in pieces, settled between them, it ends as one fed at once', () => {
    const rows = MAIN.filter(r => (r as { isSidechain?: boolean }).isSidechain !== true)
    const whole = buildReport('s', 'f.jsonl', rows, [], NOW)
    for (const pieces of [[2, 3, 4, 5, 7], [1, 6, 9, 10, 17], [4, 8, 13, 16, 22]]) {
      const c = chainOf()
      let from = 0
      for (const to of [...pieces, rows.length]) {
        c.feed(rows.slice(from, to))
        from = to
        const open = c.settle()
        same(reportOf('s', 'f.jsonl', c.res, [], NOW), buildReport('s', 'f.jsonl', rows.slice(0, to), [], NOW))
        open()
      }
      const open = c.settle()
      same(reportOf('s', 'f.jsonl', c.res, [], NOW), whole)
      open()
    }
  })
})
