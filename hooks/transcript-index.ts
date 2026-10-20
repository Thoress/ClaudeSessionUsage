import type { EngineInterface } from 'claude-code'

import { parseJsonl } from './analyze'
import { readText } from './transcripts'

// ---------- a transcript, indexed for the previews ----------
//
// a click shows one call, message or turn. Scanning the whole transcript for
// it took seconds on a big one, every click; the index is built once per file
// and keeps only what the previews show, found by id. The parsed rows and the
// raw text go once it is built: the index holds their strings, not them.

type Row = Record<string, any>

/** A piece of what Claude said in a turn: its text, its thinking, a tool call. */
export type Block = { kind: 'text'; text: string } | { kind: 'thinking'; text: string } | { kind: 'call'; tool: string; what: string }

/** A main-chain row as a turn shows it: your words, or Claude's blocks. */
export type Said = { kind: 'you'; text: string } | { kind: 'claude'; blocks: Block[] }

export type TranscriptIndex = {
  /** A row's uuid → its text as the model read it, in pieces; the first row with the uuid wins. */
  texts: Map<string, string | string[]>
  /** A tool_use id → the call; the last block with the id wins. */
  uses: Map<string, { name: string; input: any }>
  /** A tool_use id → its result as text; the last wins. */
  results: Map<string, string>
  /** The main chain (no subagent's rows), in order: each row's uuid, time and what a turn shows of it. */
  ids: unknown[]
  ats: number[]
  said: (Said | undefined)[]
  /** A uuid → its first place in the main chain. */
  places: Map<string, number>
}

/** A content value (a string or blocks) in pieces, as `textOf` joins them. */
const piecesOf = (c: unknown, resultOf: (b: any) => string = b => textOf(b.content)): string[] =>
  typeof c === 'string'
    ? [c]
    : Array.isArray(c)
      ? c.map((b: any) =>
          typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : b?.type === 'tool_result' ? resultOf(b) : '',
        )
      : []

const join = (pieces: string[]) => pieces.filter(Boolean).join('\n')

/** A content value (a string or blocks) as text. */
export const textOf = (c: unknown): string => (typeof c === 'string' ? c : join(piecesOf(c)))

/** A row's text, kept in pieces: a tool result's piece is the very string `results` holds. */
export const textAt = (ix: TranscriptIndex, uuid: string): string => {
  const t = ix.texts.get(uuid)
  return t === undefined ? '' : typeof t === 'string' ? t : join(t)
}

/** What a tool call is about, in a line: its description, file, command... */
export const callWhat = (input: any): string => {
  const i = input ?? {}
  return String(i.description ?? i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.skill ?? '')
    .split('\n')[0]!
    .slice(0, 100)
}

export const emptyIndex = (): TranscriptIndex => ({ texts: new Map(), uses: new Map(), results: new Map(), ids: [], ats: [], said: [], places: new Map() })

/** Adds rows, in the transcript's order, to the index. */
export function extendIndex(ix: TranscriptIndex, rows: Row[]): TranscriptIndex {
  for (const r of rows) {
    const content = r.message?.content
    const blocks: any[] = Array.isArray(content) ? content : []
    let hasResult = false
    // each result's text once: the row's pieces share it
    const resultOf = (b: any) => {
      const t = textOf(b.content)
      ix.results.set(b.tool_use_id, t)
      hasResult = true
      return t
    }
    const pieces = piecesOf(content, resultOf)
    for (const b of blocks) if ((b?.type === 'tool_use' || b?.type === 'server_tool_use') && b.id !== undefined) ix.uses.set(b.id, { name: b.name, input: b.input })
    if (typeof r.uuid === 'string' && !ix.texts.has(r.uuid)) {
      let kept = pieces.filter(Boolean)
      if (kept.length === 0) kept = piecesOf(Array.isArray(r.rendered) ? r.rendered.map((x: any) => x?.content ?? x) : r.rendered).filter(Boolean)
      ix.texts.set(r.uuid, kept.length === 1 ? kept[0]! : kept.length === 0 ? '' : kept)
    }
    if (r.isSidechain === true) continue
    let said: Said | undefined
    if (r.type === 'user' && !r.isMeta && !r.isCompactSummary) {
      const text = hasResult ? '' : join(pieces).replace(/<[^>]+>/g, '').trim()
      if (text) said = { kind: 'you', text }
    } else if (r.type === 'assistant') {
      const out: Block[] = []
      for (const b of blocks) {
        if (b?.type === 'text' && b.text?.trim()) out.push({ kind: 'text', text: b.text })
        else if (b?.type === 'thinking' && b.thinking?.trim()) out.push({ kind: 'thinking', text: b.thinking })
        else if (b?.type === 'tool_use') out.push({ kind: 'call', tool: String(b.name), what: callWhat(b.input) })
      }
      if (out.length > 0) said = { kind: 'claude', blocks: out }
    }
    if (typeof r.uuid === 'string' && !ix.places.has(r.uuid)) ix.places.set(r.uuid, ix.ids.length)
    ix.ids.push(r.uuid)
    ix.ats.push(typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN)
    ix.said.push(said)
  }
  return ix
}

export const buildIndex = (rows: Row[]): TranscriptIndex => extendIndex(emptyIndex(), rows)

/**
 * The rows of `text` from `start` on, and where the next read picks up: past
 * the last whole line, or the end when the line after it parses already.
 */
export function rowsFrom(text: string, start: number): { rows: Row[]; consumed: number } {
  const end = Math.max(start, text.lastIndexOf('\n') + 1)
  const rows = parseJsonl(text.slice(start, end))
  const rest = text.slice(end).trim()
  if (!rest) return { rows, consumed: text.length }
  try {
    rows.push(JSON.parse(rest))
    return { rows, consumed: text.length }
  } catch {
    // a line cut mid-write: read it again once it is whole
    return { rows, consumed: end }
  }
}

/** A cheap fingerprint of the text just before `end`: it tells whether the file only grew. */
export function markOf(text: string, end: number): number {
  let h = 0
  for (let i = Math.max(0, end - 256); i < end; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0
  return h
}

type Cached = { size: number; mtimeMs: number; index: TranscriptIndex; consumed: number; mark: number }

// the indexes of the last few transcripts clicked, by path; a transcript is
// appended to, so a grown one is read whole (there are no range reads) but
// only its new lines parsed
const indexes = new Map<string, Cached>()
const building = new Map<string, Promise<TranscriptIndex>>()
const KEEP = 2

/**
 * The transcript's index, built once and kept while the file stays as it was.
 * `isAnswered` says the index already holds what is asked: rows once written
 * stay as they are, so a grown file need not be read again for it.
 */
export async function transcriptIndex($: EngineInterface, path: string, isAnswered?: (ix: TranscriptIndex) => boolean): Promise<TranscriptIndex> {
  const pending = building.get(path)
  if (pending) await pending.catch(() => undefined)
  const { size, mtimeMs } = await $.fs.stat(path)
  const had = indexes.get(path)
  if (had) {
    indexes.delete(path)
    indexes.set(path, had)
    if (size === had.size && mtimeMs === had.mtimeMs) return had.index
    if (size >= had.size && isAnswered?.(had.index)) return had.index
  }
  const build = (async () => {
    const text = await readText($, path)
    const isGrown = had !== undefined && size >= had.size && had.consumed <= text.length && markOf(text, had.consumed) === had.mark
    const { rows, consumed } = rowsFrom(text, isGrown ? had.consumed : 0)
    const index = isGrown ? extendIndex(had.index, rows) : buildIndex(rows)
    indexes.delete(path)
    indexes.set(path, { size, mtimeMs, index, consumed, mark: markOf(text, consumed) })
    for (const k of indexes.keys()) if (indexes.size > KEEP) indexes.delete(k)
    return index
  })()
  building.set(path, build)
  try {
    return await build
  } finally {
    building.delete(path)
  }
}
