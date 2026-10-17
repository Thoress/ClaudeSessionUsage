import type { EngineInterface } from 'claude-code'

import type { Group, Preview, UsageReport } from '../types'
import { parseJsonl } from './analyze'
import { VIEW_PANE } from './constants'
import { cut, tok } from './format'
import { readText } from './transcripts'

const VIEW = { plugin: 'session-insights', key: 'view' } as const

/// ---------- leading from a details entry to what it was ----------

const FILE_CATS = /^(code|doc)_(read|write)$|^(scratch|instructions)$/
/** Kinds best seen as their turn: what was said, done and answered around them. */
const TURN_CATS = /^(prompt|reply|thinking)$/
const PREVIEW_CHARS = 60_000
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

const cutTo = (s: string, max: number): { text: string; note?: string } =>
  s.length > max ? { text: s.slice(0, max), note: `first ${tok(max)} of ${tok(s.length)} characters` } : { text: s }

/** A file's text, for the pane; undefined when it is gone or not text. */
export async function filePreview($: EngineInterface, path: string): Promise<Preview | undefined> {
  if (!(await $.fs.exists(path).catch(() => false))) return undefined
  const text = await readText($, path).catch(() => undefined)
  if (text === undefined || text.includes('\u0000')) return undefined
  const { text: source, note } = cutTo(text.replace(/\r\n/g, '\n'), PREVIEW_CHARS)
  return { title: path, source, path, note }
}

/** A content value (a string or blocks) as text. */
const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((b: any) =>
            typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : b?.type === 'tool_result' ? textOf(b.content) : '',
          )
          .filter(Boolean)
          .join('\n')
      : ''

/** The entry's first piece, found again in the transcript: a message's text, or a tool call with its result. */
export async function contentPreview($: EngineInterface, raw: UsageReport, g: Group): Promise<Preview | undefined> {
  const rows = parseJsonl(await readText($, raw.file))
  const title = g.label
  const { messageId, toolUseId } = g.ref ?? {}
  // a skill, a message or an injected reminder: its text as the model read it
  if (messageId && (!toolUseId || g.cat === 'skills')) {
    const row = rows.find(r => r.uuid === messageId)
    const text = textOf(row?.message?.content) || textOf(Array.isArray(row?.rendered) ? row.rendered.map((x: any) => x?.content ?? x) : row?.rendered)
    if (text) {
      const { text: source, note } = cutTo(text, PREVIEW_CHARS)
      return { title, source, note, isMarkdown: true }
    }
  }
  if (!toolUseId) return undefined
  let use: any
  let result: unknown
  for (const r of rows) {
    for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
      if ((b?.type === 'tool_use' || b?.type === 'server_tool_use') && b.id === toolUseId) use = b
      else if (b?.type === 'tool_result' && b.tool_use_id === toolUseId) result = b.content
    }
  }
  if (!use) return undefined
  const input = use.input ?? {}
  const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : undefined
  const shell = /powershell/i.test(String(use.name)) ? 'powershell' : 'bash'
  const output = textOf(result)
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

/** One turn as it went: the prompt, Claude's replies, and a line per tool call. */
export async function turnPreview($: EngineInterface, raw: UsageReport, turn: number): Promise<Preview | undefined> {
  const row = raw.turnRows.find(t => t.turn === turn)
  if (!row) return undefined
  const next = raw.turnRows.find(t => t.turn === turn + 1)
  const rows = parseJsonl(await readText($, raw.file)).filter(r => r.isSidechain !== true)
  // from the turn's prompt (else its first moment) to the next turn's
  const at = (r: any) => (typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN)
  let from = row.promptId ? rows.findIndex(r => r.uuid === row.promptId) : -1
  if (from < 0) from = rows.findIndex(r => at(r) >= row.startedAt)
  if (from < 0) return undefined
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
  for (const r of rows.slice(from)) {
    if (next && (r.uuid === next.promptId || at(r) >= next.startedAt)) break
    const content = r.message?.content
    if (r.type === 'user' && !r.isMeta && !r.isCompactSummary) {
      const isResult = Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')
      const text = isResult ? '' : textOf(content).replace(/<[^>]+>/g, '').trim()
      if (text) {
        turnTo('you')
        parts.push(quote(text))
      }
    } else if (r.type === 'assistant') {
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'text' && b.text?.trim()) {
          turnTo('claude')
          parts.push(b.text.trim())
        } else if (b?.type === 'thinking' && b.thinking?.trim()) {
          turnTo('claude')
          parts.push(`*Thinking: ${b.thinking.trim().replace(/\s+/g, ' ')}*`)
        } else if (b?.type === 'tool_use') {
          if (speaker !== 'claude') turnTo('claude')
          const i = b.input ?? {}
          const what = String(i.description ?? i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.skill ?? '').split('\n')[0]!.slice(0, 100)
          calls.push(`- \`${b.name}\`${what ? ` ${what.replace(/[`*_]/g, '')}` : ''}`)
        }
      }
    }
  }
  flushCalls()
  if (parts.length === 0) return undefined
  const { text: source, note } = cutTo(parts.join('\n\n').replace(/^---\n\n/, ''), PREVIEW_CHARS)
  return { title: `Turn ${turn}: ${row.prompt}`, source, note, isMarkdown: true }
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
