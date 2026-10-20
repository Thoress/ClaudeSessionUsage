import type { EngineInterface } from 'claude-code'

import type { UsageReport } from '../types'
import { type Chain, chainOf, parseJsonl, reportOf, turnAt } from './analyze'

const FS_READ_LIMIT = 4 * 1024 * 1024

// ---------- finding and reading transcripts ----------

export async function configDir($: EngineInterface): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}/.claude`
}

export async function findTranscript($: EngineInterface, id: string): Promise<string | undefined> {
  const projects = `${await configDir($)}/projects`
  const guesses = [await $.session.root(), await $.session.cwd()].map(p => p.replace(/[^a-zA-Z0-9]/g, '-'))
  for (const g of guesses) {
    const f = `${projects}/${g}/${id}.jsonl`
    if (await $.fs.exists(f)) return f
  }
  for (const d of await $.fs.list(projects).catch(() => [])) {
    if (d.kind !== 'dir') continue
    const f = `${projects}/${d.name}/${id}.jsonl`
    if (await $.fs.exists(f)) return f
  }
  return undefined
}

const isWindows = async ($: EngineInterface, path: string) => /^[A-Za-z]:/.test(path) || (await $.env.get('OS')) === 'Windows_NT'

/** What a child writes to standard output; undefined when it cannot start or fails. */
async function output($: EngineInterface, argv: string[]): Promise<string | undefined> {
  try {
    const child = $.process.spawn({ argv })
    let text = ''
    for await (const chunk of child) if (chunk.stream === 'stdout') text += chunk.text
    return (await child.result).code === 0 ? text : undefined
  } catch {
    return undefined
  }
}

// Windows ships curl (since 10 1803); it reads a file:// URL, a byte range
// of it too, far faster than `type` pipes a large file
const curl = async ($: EngineInterface) => `${(await $.env.get('SystemRoot')) ?? 'C:\\Windows'}\\System32\\curl.exe`
const fileUrl = (path: string) =>
  'file:///' +
  path
    .replace(/\\/g, '/')
    .split('/')
    .map((part, k) => (k === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join('/')

/** Reads a text file of any size: past $.fs.read's 4 MiB, through a child. */
export async function readText($: EngineInterface, path: string): Promise<string> {
  const { size } = await $.fs.stat(path)
  if (size <= FS_READ_LIMIT) return $.fs.read(path)
  const text = (await isWindows($, path))
    ? ((await output($, [await curl($), '-sS', fileUrl(path)])) ?? (await output($, ['cmd', '/d', '/c', 'type', path.replace(/\//g, '\\')])))
    : await output($, ['cat', path])
  if (text === undefined) throw new Error(`Could not read ${path}.`)
  return text
}

/** The text from a point on: `bytes` into the file, the same point `chars` into its text. */
async function readFrom($: EngineInterface, path: string, at: Offset, size: number): Promise<string> {
  if (at.bytes <= 0) return readText($, path)
  if (size <= FS_READ_LIMIT) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text !== undefined) return text.slice(at.chars)
  }
  const part = (await isWindows($, path))
    ? await output($, [await curl($), '-sS', '-r', `${at.bytes}-`, fileUrl(path)])
    : await output($, ['tail', '-c', `+${at.bytes + 1}`, path])
  return part ?? (await readText($, path)).slice(at.chars)
}

// ---------- following a transcript as it grows ----------

/** A point in a file: in bytes, and in characters of its text. */
type Offset = { bytes: number; chars: number }

/** What following a transcript needs of the file system; tests hand in their own. */
export type Reader = {
  /** The file's size and time; undefined when it is gone. */
  stat: (path: string) => Promise<{ size: number; mtimeMs: number } | undefined>
  /** A folder's .jsonl files in listing order, with size and time; none when it is missing. */
  list: (dir: string) => Promise<{ name: string; size: number; mtimeMs: number }[]>
  /** The text from `at` on; `size` is the file's as last seen. */
  readFrom: (path: string, at: Offset, size: number) => Promise<string>
}

const readerOf = ($: EngineInterface): Reader => ({
  stat: path => $.fs.stat(path).then(
    s => ({ size: s.size, mtimeMs: s.mtimeMs }),
    () => undefined,
  ),
  list: async dir => ((await $.fs.exists(dir)) ? (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl')) : []),
  readFrom: (path, at, size) => readFrom($, path, at, size),
})

/** One file read up to `bytes`, into its chain. */
type Followed = Offset & {
  chain: Chain
  /** The text just before `bytes`: read again first, it proves the file is the one read before. */
  end: string
  /** The file as last read: unchanged, there is nothing to read (a row half written waits for more). */
  size: number
  mtimeMs: number
}

type Session = {
  sessionId: string
  file: string
  main: Followed
  /** By file name, and the names in listing order. */
  subs: Map<string, Followed>
  order: string[]
  /** The latest moment a subagent's row was placed in a main turn. */
  asked: number
}

// the transcripts followed: the running session's and one looked at besides.
// Module memory, never state (every state read copies); a hot reload empties
// it, and the next analysis reads everything again.
const sessions = new Map<string, Session>()
const KEEP = 2
const END_CHARS = 256

const followed = (chain: Chain): Followed => ({ chain, bytes: 0, chars: 0, end: '', size: -1, mtimeMs: NaN })

/** UTF-8 length of a text decoded from UTF-8. */
function utf8Length(s: string): number {
  let n = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) continue
    if (c < 0x800) n += 1
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      // a surrogate pair: two units, four bytes
      n += 2
      i++
    } else n += 2
  }
  return n
}

/** The text up to its last whole row: a row cut mid-write waits for the next read. */
function wholeRows(text: string): string {
  const cut = text.lastIndexOf('\n') + 1
  const rest = text.slice(cut).trim()
  if (!rest) return text
  try {
    // a whole row only its newline is missing from: a full read takes it too
    JSON.parse(rest)
    return text
  } catch {
    return text.slice(0, cut)
  }
}

/** The new rows of a file, or undefined when it is not the file read before (cut short, replaced). */
async function grow(reader: Reader, path: string, f: Followed, st: { size: number; mtimeMs: number }) {
  if (st.size < f.bytes) return undefined
  if (st.size === f.size && st.mtimeMs === f.mtimeMs) return []
  const text = await reader.readFrom(path, { bytes: f.bytes - utf8Length(f.end), chars: f.chars - f.end.length }, st.size)
  if (!text.startsWith(f.end)) return undefined
  const used = wholeRows(text.slice(f.end.length))
  f.bytes += utf8Length(used)
  f.chars += used.length
  let end = used.length >= END_CHARS ? used.slice(-END_CHARS) : (f.end + used).slice(-END_CHARS)
  // never half a surrogate pair: its byte length would be wrong
  if (/^[\udc00-\udfff]/.test(end)) end = end.slice(1)
  f.end = end
  f.size = st.size
  f.mtimeMs = st.mtimeMs
  return parseJsonl(used)
}

/** Reads what was appended since the last time; false when only a full analysis can be right. */
async function advance(reader: Reader, s: Session): Promise<boolean> {
  const st = await reader.stat(s.file)
  if (!st) throw new Error(`No transcript found for session ${s.sessionId}.`)
  const rows = await grow(reader, s.file, s.main, st)
  if (!rows) return false
  const turns = s.main.chain.res.turns
  const before = turns.length
  s.main.chain.feed(rows.filter(r => r.isSidechain !== true))
  // a new turn that started before a moment a subagent already placed: it moves to that turn
  for (let k = before; k < turns.length; k++) if (turns[k]!.startedAt <= s.asked) return false
  const dir = `${s.file.replace(/\.jsonl$/, '')}/subagents`
  const files = await reader.list(dir)
  if (s.order.some(name => !files.some(f => f.name === name))) return false
  for (const f of files) {
    let sub = s.subs.get(f.name)
    if (!sub) {
      sub = followed(
        chainOf(at => {
          if (at > s.asked) s.asked = at
          return turnAt(turns, at)
        }),
      )
      s.subs.set(f.name, sub)
    }
    const rows = await grow(reader, `${dir}/${f.name}`, sub, f)
    if (!rows) return false
    sub.chain.feed(rows)
  }
  s.order = files.map(f => f.name)
  return true
}

/** The report of everything read, as a full analysis of the same rows makes it. */
function reportNow(s: Session, now: number): UsageReport {
  const subs = s.order.map(name => ({ id: name.replace(/^agent-/, '').replace(/\.jsonl$/, ''), chain: s.subs.get(name)!.chain }))
  const reopen = [s.main.chain, ...subs.map(x => x.chain)].map(c => c.settle())
  try {
    return reportOf(
      s.sessionId,
      s.file,
      s.main.chain.res,
      subs.map(x => ({ id: x.id, r: x.chain.res })),
      now,
    )
  } finally {
    for (const open of reopen) open()
  }
}

async function update(reader: Reader, sessionId: string, file: string, now: number): Promise<UsageReport> {
  let s = sessions.get(file)
  sessions.delete(file)
  if (s?.sessionId === sessionId) {
    // a failed read leaves the chains half fed: start over
    const isAdvanced = await advance(reader, s).catch(() => false)
    if (isAdvanced) {
      sessions.set(file, s)
      return reportNow(s, now)
    }
  }
  s = { sessionId, file, main: followed(chainOf()), subs: new Map(), order: [], asked: -Infinity }
  if (!(await advance(reader, s))) throw new Error(`The transcript of session ${sessionId} changed while it was read.`)
  sessions.set(file, s)
  for (const key of sessions.keys()) if (sessions.size > KEEP) sessions.delete(key)
  return reportNow(s, now)
}

// one analysis at a time: two would feed the same chains at once
let queue: Promise<unknown> = Promise.resolve()

/**
 * Analyzes a transcript and its subagents', reading only what was appended
 * since the last call for the same file; a file cut short or replaced, or a
 * subagent's file gone, is analyzed again from the start.
 */
export function follow(reader: Reader, sessionId: string, file: string, now: number): Promise<UsageReport> {
  const run = queue.then(() => update(reader, sessionId, file, now))
  queue = run.catch(() => undefined)
  return run
}

export async function analyze($: EngineInterface, sessionId: string): Promise<UsageReport> {
  const file = await findTranscript($, sessionId)
  if (!file) throw new Error(`No transcript found for session ${sessionId}.`)
  return follow(readerOf($), sessionId, file, await $.clock.now())
}

/** Rounds every fraction to 5 significant digits: the state stays small. */
export const compact = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(5)) : v)))
