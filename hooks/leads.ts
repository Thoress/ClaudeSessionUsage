import type { EngineInterface } from 'claude-code'

import type { Group, Preview, UsageReport } from '../types'
import { VIEW_PANE } from './constants'
import { cut, tok } from './format'
import { type TranscriptIndex, textAt, transcriptIndex } from './transcript-index'
import { readText } from './transcripts'

const VIEW = { plugin: 'session-insights', key: 'view' } as const

/// ---------- leading from a details entry to what it was ----------

const FILE_CATS = /^(code|doc)_(read|write)$|^(scratch|instructions)$/
/** Kinds best seen as their turn: what was said, done and answered around them. */
const TURN_CATS = /^(prompt|reply|thinking)$/
export const PREVIEW_CHARS = 60_000
/** Lines a preview shows at once, until "Show all". */
export const PREVIEW_LINES = 12

/** The first turn an entry cost anything in. */
export const firstTurn = (g: Group) =>
  Object.entries(g.byTurn)
    .filter(([, c]) => c > 0)
    .map(([t]) => Number(t))
    .sort((a, b) => a - b)[0]

export type Lead = 'file' | 'page' | 'show' | 'turn' | 'none'

/** Where a click on the entry leads. */
export function leadOf(g: Group): Lead {
  if (g.ref?.path && FILE_CATS.test(g.cat)) return 'file'
  if (g.ref?.url) return 'page'
  if (TURN_CATS.test(g.cat) && firstTurn(g) !== undefined) return 'turn'
  if (g.ref?.toolUseId || g.ref?.messageId) return 'show'
  return firstTurn(g) === undefined ? 'none' : 'turn'
}

export const leadHint = (lead: Lead, g: Group) =>
  ({
    file: 'Click to show the file',
    page: 'Click to open the page in your browser',
    show: 'Click to show it',
    turn: `Click to show turn ${firstTurn(g)}`,
    none: '',
  })[lead]

/** Runs the first of `tries` that exits 0. */
async function runFirst($: EngineInterface, tries: string[][]): Promise<boolean> {
  for (const argv of tries) {
    const r = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => undefined)
    if (r?.exitCode === 0) return true
  }
  return false
}

export async function openPage($: EngineInterface, url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false
  return (await $.env.get('OS')) === 'Windows_NT'
    ? runFirst($, [['rundll32', 'url.dll,FileProtocolHandler', url]])
    : runFirst($, [['open', url], ['xdg-open', url]])
}

/**
 * Shows a file in the app's Files pane. The app opens only files inside the
 * session's folders there; for any other it answers an error.
 */
export async function showInFilesPane($: EngineInterface, path: string): Promise<boolean> {
  const shown = await $.mcp.call('ccd_view', 'show_pane', { pane: 'file', path }).catch(() => undefined)
  return shown !== undefined && !shown.isError
}

export const cutTo = (s: string, max: number): { text: string; note?: string } =>
  s.length > max ? { text: s.slice(0, max), note: `first ${tok(max)} of ${tok(s.length)} characters` } : { text: s }

/** A file's text, for the pane; undefined when it is gone or not text. */
export async function filePreview($: EngineInterface, path: string): Promise<Preview | undefined> {
  if (!(await $.fs.exists(path).catch(() => false))) return undefined
  const text = await readText($, path).catch(() => undefined)
  if (text === undefined || text.includes('\u0000')) return undefined
  const { text: source, note } = cutTo(text.replace(/\r\n/g, '\n'), PREVIEW_CHARS)
  return { title: path, source, path, note }
}

/** The entry's first piece, found in the index: a message's text, or a tool call with its result. */
export function contentFromIndex(ix: TranscriptIndex, g: Group): Preview | undefined {
  const title = g.label
  const { messageId, toolUseId } = g.ref ?? {}
  // a skill, a message or an injected reminder: its text as the model read it
  if (messageId && (!toolUseId || g.cat === 'skills')) {
    const text = textAt(ix, messageId)
    if (text) {
      const { text: source, note } = cutTo(text, PREVIEW_CHARS)
      return { title, source, note, isMarkdown: true }
    }
  }
  if (!toolUseId) return undefined
  const use = ix.uses.get(toolUseId)
  if (!use) return undefined
  const input = use.input ?? {}
  const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : undefined
  const shell = /powershell/i.test(String(use.name)) ? 'powershell' : 'bash'
  const output = ix.results.get(toolUseId) ?? ''
  const joinNote = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined
  // a command or script: the command; its output: the output; else the call and its result
  if (command !== undefined && g.cat !== 'termout') {
    const { text: source, note } = cutTo(command, PREVIEW_CHARS)
    return { title, source, language: shell, note: joinNote(input.description, note) }
  }
  if (g.cat === 'termout') {
    const { text: source, note } = cutTo(output || '(no output)', PREVIEW_CHARS)
    return { title, source, language: 'text', note: joinNote(command ? `$ ${command.split('\n')[0]}` : undefined, note) }
  }
  const call = JSON.stringify(input, null, 2)
  const { text: source, note } = cutTo(`${use.name} ${call}${output ? `\n\n── result ──\n${output}` : ''}`, PREVIEW_CHARS)
  return { title, source, language: 'text', note }
}

/** Whether the index holds all an entry shows: then a grown transcript need not be read again. */
export function hasContent(ix: TranscriptIndex, g: Group): boolean {
  const { messageId, toolUseId } = g.ref ?? {}
  if (messageId && (!toolUseId || g.cat === 'skills') && textAt(ix, messageId)) return true
  return toolUseId !== undefined && ix.uses.has(toolUseId) && ix.results.has(toolUseId)
}

/** The entry's first piece, found again in the transcript: a message's text, or a tool call with its result. */
export async function contentPreview($: EngineInterface, raw: UsageReport, g: Group): Promise<Preview | undefined> {
  return contentFromIndex(await transcriptIndex($, raw.file, ix => hasContent(ix, g)), g)
}

/**
 * A turn's rows in the index's main chain: from its prompt (else its first
 * moment) up to the next turn's; `isWhole` once that next turn is in it.
 */
export function turnRange(ix: TranscriptIndex, raw: UsageReport, turn: number): { from: number; to: number; isWhole: boolean } | undefined {
  const row = raw.turnRows.find(t => t.turn === turn)
  if (!row) return undefined
  const next = raw.turnRows.find(t => t.turn === turn + 1)
  let from = row.promptId ? (ix.places.get(row.promptId) ?? -1) : -1
  if (from < 0) from = ix.ats.findIndex(a => a >= row.startedAt)
  if (from < 0) return undefined
  let to = from
  if (next) while (to < ix.ids.length && ix.ids[to] !== next.promptId && !(ix.ats[to]! >= next.startedAt)) to++
  else to = ix.ids.length
  return { from, to, isWhole: to < ix.ids.length }
}

/** One turn as Markdown: the prompt, Claude's replies, and a line per tool call. */
export function turnMarkdown(ix: TranscriptIndex, raw: UsageReport, turn: number): Preview | undefined {
  const range = turnRange(ix, raw, turn)
  if (!range) return undefined
  // who speaks heads each stretch: your words quoted under "You", Claude's
  // text plain under "Claude", its tool calls a list in between
  const parts: string[] = []
  let speaker: 'you' | 'claude' | undefined
  let calls: string[] = []
  const flushCalls = () => {
    if (calls.length > 0) parts.push(calls.join('\n'))
    calls = []
  }
  const turnTo = (who: 'you' | 'claude') => {
    flushCalls()
    if (who !== speaker) parts.push(who === 'you' ? '---\n\n#### You' : '#### Claude')
    speaker = who
  }
  const quote = (s: string) =>
    s
      .split('\n')
      .map(l => `> ${l}`)
      .join('\n')
  for (let i = range.from; i < range.to; i++) {
    const said = ix.said[i]
    if (said?.kind === 'you') {
      turnTo('you')
      parts.push(quote(said.text))
    } else if (said?.kind === 'claude') {
      for (const b of said.blocks) {
        if (b.kind === 'text') {
          turnTo('claude')
          parts.push(b.text.trim())
        } else if (b.kind === 'thinking') {
          turnTo('claude')
          parts.push(`*Thinking: ${b.text.trim().replace(/\s+/g, ' ')}*`)
        } else {
          if (speaker !== 'claude') turnTo('claude')
          calls.push(`- \`${b.tool}\`${b.what ? ` ${b.what.replace(/[`*_]/g, '')}` : ''}`)
        }
      }
    }
  }
  flushCalls()
  if (parts.length === 0) return undefined
  const { text: source, note } = cutTo(parts.join('\n\n').replace(/^---\n\n/, ''), PREVIEW_CHARS)
  return { title: `Turn ${turn}: ${raw.turnRows.find(t => t.turn === turn)!.prompt}`, source, note, isMarkdown: true }
}

/** One turn as it went: the prompt, Claude's replies, and a line per tool call. */
export async function turnPreview($: EngineInterface, raw: UsageReport, turn: number): Promise<Preview | undefined> {
  if (!raw.turnRows.some(t => t.turn === turn)) return undefined
  return turnMarkdown(await transcriptIndex($, raw.file, ix => turnRange(ix, raw, turn)?.isWhole === true), raw, turn)
}

/** Opens a preview whole in a tab of its own, which scrolls. */
export async function openView($: EngineInterface, p: Preview) {
  await $.state.set(VIEW, p)
  const name = p.path ? (p.path.split(/[\\/]/).pop() ?? p.title) : p.title
  await $.ui.open({ id: VIEW_PANE, title: cut(name, 40), columns: 110 })
}

// the prompts' rows as the chat draws them: their text → the id a scroll takes
export const promptRows = new Map<string, string>()
export const promptKey = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

/** Scrolls the chat to a turn's prompt; the reason when it cannot. */
export async function jumpToTurn($: EngineInterface, raw: UsageReport, turn: number): Promise<string | undefined> {
  const row = raw.turnRows.find(t => t.turn === turn)
  if (!row) return `turn ${turn} is not in the report`
  const ids = [promptRows.get(promptKey(row.prompt)), row.promptId].filter((id): id is string => Boolean(id))
  if (ids.length === 0) return 'its prompt has not been drawn in the chat'
  let reason = ''
  for (const requestId of ids) {
    const r = await $.ui.scroll({ to: { requestId }, block: 'start' }).catch((err: unknown) => ({ deny: (err as Error)?.message ?? String(err) }))
    if (!r.deny) return undefined
    reason = r.deny
  }
  return reason
}
