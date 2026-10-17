import type { EngineInterface, Register } from 'claude-code'

import type { Filter, Group, LimitWindow, LiveUsage, Measure, Preview, UsageReport } from '../types'
import { BUCKETS, CATS, buildReport, parseJsonl } from './analyze'
import {
  TURN_INFO,
  agentsTable,
  contextChart,
  costChart,
  cumulativeChart,
  fits,
  infoIcon,
  legendStrip,
  miniBar,
  overviewTop,
  setChartWidth,
  summaryCard,
  svgSize,
  timeChart,
  toolsTable,
  turnCosts,
} from './charts'
import { NO_FILTER, applyFilter, detailsOf, topGroups, viewOf } from './filter'
import { bar, cachingStory, cut, dur, mdAgentTable, mdCostTable, money, pct, tok, toMarkdown } from './format'
import { type CachedFile, type CostPoint, WINDOW_MS, pack, requestCosts, scanLine, unpack, windowShare } from './limits'

const PLUGIN = 'session-insights'
const PANE = 'session-insights'
// a pane an earlier version opened from the footer; closed when the mod loads
const SUMMARY = 'session-insights-summary'
const COMMAND = 'session-usage'
const REPORT = { plugin: 'session-insights', key: 'report' } as const
const CURRENT = { plugin: 'session-insights', key: 'current' } as const
const TAB = { plugin: 'session-insights', key: 'tab' } as const
const STATUS = { plugin: 'session-insights', key: 'status' } as const
const FILTER = { plugin: 'session-insights', key: 'filter' } as const
const MEASURE = { plugin: 'session-insights', key: 'measure' } as const
const POPOVER = { plugin: 'session-insights', key: 'popover' } as const
const PREVIEW = { plugin: 'session-insights', key: 'preview' } as const

const FS_READ_LIMIT = 4 * 1024 * 1024

/**
 * About how many CSS pixels one column is on the surfaces that draw SVG: a
 * remote surface counts columns in the advance of its code font.
 */
const PX_PER_COLUMN = 7.6

const TABS: [string, string][] = [
  ['overview', 'Overview'],
  ['timeline', 'Timeline'],
  ['content', 'Content'],
  ['time', 'Time'],
  ['top', 'Top items'],
  ['agents', 'Agents'],
]
// tab ids an earlier version stored
const OLD_TABS: Record<string, string> = { tokens: 'content', turns: 'timeline' }

const CONTENT_INFO =
  'Content sent once keeps being re-sent with every later request, so a big file read or command output early on costs again and again (as cheap cache reads). Output is charged once, at the highest rate. The growth of the context between two requests is exact; it is shared out over the content added in between by character count, so the split per kind is a close estimate. Click a row to filter everything to that kind and see what it was made of.'

// ---------- finding and reading transcripts ----------

async function configDir($: EngineInterface): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}/.claude`
}

async function findTranscript($: EngineInterface, id: string): Promise<string | undefined> {
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

/** Reads a text file of any size: past $.fs.read's 4 MiB, through a child. */
async function readText($: EngineInterface, path: string): Promise<string> {
  const { size } = await $.fs.stat(path)
  if (size <= FS_READ_LIMIT) return $.fs.read(path)
  const isWindows = /^[A-Za-z]:/.test(path) || (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['cmd', '/d', '/c', 'type', path.replace(/\//g, '\\')] : ['cat', path]
  let text = ''
  for await (const chunk of $.process.spawn({ argv })) if (chunk.stream === 'stdout') text += chunk.text
  return text
}

async function analyze($: EngineInterface, sessionId: string): Promise<UsageReport> {
  const file = await findTranscript($, sessionId)
  if (!file) throw new Error(`No transcript found for session ${sessionId}.`)
  const main = parseJsonl(await readText($, file))
  const dir = `${file.replace(/\.jsonl$/, '')}/subagents`
  const subagents: { id: string; rows: ReturnType<typeof parseJsonl> }[] = []
  if (await $.fs.exists(dir)) {
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      subagents.push({ id: f.name.replace(/^agent-/, '').replace(/\.jsonl$/, ''), rows: parseJsonl(await readText($, `${dir}/${f.name}`)) })
    }
  }
  return compact(buildReport(sessionId, file, main, subagents, await $.clock.now()))
}

/** Rounds every fraction to 5 significant digits: the state stays small. */
const compact = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(5)) : v)))

// ---------- every local session's requests, for the limits' shares ----------

// each transcript's request costs, by path, kept in $.store across sessions
// (a finished session's file never changes, so it is scanned once)
const COSTS_KEY = 'costs'
let costCache: Record<string, CachedFile> | undefined
let measuring: Promise<void> | undefined

type Transcript = { path: string; size: number; mtimeMs: number; session: string }

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/** Every local transcript, main conversation or subagent, written to since `since`. */
async function recentTranscripts($: EngineInterface, since: number): Promise<Transcript[]> {
  const projects = `${await configDir($)}/projects`
  const out: Transcript[] = []
  for (const d of await $.fs.list(projects).catch(() => [])) {
    if (d.kind !== 'dir') continue
    const dir = `${projects}/${d.name}`
    for (const f of await $.fs.list(dir).catch(() => [])) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs < since) continue
      const session = f.name.slice(0, -'.jsonl'.length)
      out.push({ path: `${dir}/${f.name}`, size: f.size, mtimeMs: f.mtimeMs, session })
      const sub = `${dir}/${session}/subagents`
      for (const s of await $.fs.list(sub).catch(() => [])) {
        if (s.kind === 'file' && s.name.endsWith('.jsonl') && s.mtimeMs >= since) {
          out.push({ path: `${sub}/${s.name}`, size: s.size, mtimeMs: s.mtimeMs, session })
        }
      }
    }
  }
  return out
}

/**
 * The model responses in these files, by normalized path. A native search
 * reads the files (a week of them runs to hundreds of MB, mostly tool output)
 * and hands over only the responses' usage: PowerShell's Select-String on
 * Windows, grep elsewhere.
 */
async function scan($: EngineInterface, paths: string[]): Promise<Map<string, CostPoint[]>> {
  const out = new Map<string, CostPoint[]>()
  const put = (file: string, p: CostPoint) => {
    const key = norm(file)
    const list = out.get(key)
    if (list) list.push(p)
    else out.set(key, [p])
  }
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const tmp = (await $.env.get('TEMP')) ?? (await configDir($))
    const list = `${tmp}\\session-insights-scan.txt`
    await $.fs.write(list, paths.map(p => p.replace(/\//g, '\\')).join('\r\n'))
    const script = `${$.plugin.root}/hooks/scan.ps1`.replace(/\//g, '\\')
    let rest = ''
    const argv = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, list]
    for await (const chunk of $.process.spawn({ argv })) {
      if (chunk.stream !== 'stdout') continue
      const lines = (rest + chunk.text).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        const s = scanLine(line)
        if (s) put(s.file, s.point)
      }
    }
    const s = scanLine(rest)
    if (s) put(s.file, s.point)
  } else {
    for (let k = 0; k < paths.length; k += 50) {
      let text = ''
      const argv = ['grep', '-F', '-H', '--null', '"output_tokens"', ...paths.slice(k, k + 50)]
      for await (const chunk of $.process.spawn({ argv })) if (chunk.stream === 'stdout') text += chunk.text
      const byFile = new Map<string, string[]>()
      for (const line of text.split('\n')) {
        const i = line.indexOf('\0')
        if (i > 0) byFile.set(line.slice(0, i), [...(byFile.get(line.slice(0, i)) ?? []), line.slice(i + 1)])
      }
      for (const [file, lines] of byFile) for (const p of requestCosts(lines.join('\n'))) put(file, p)
    }
  }
  // a response is written as several rows, each with the same usage: once each
  for (const [key, list] of out) {
    const seen = new Set<string>()
    out.set(
      key,
      list.filter(p => !seen.has(p.id) && Boolean(seen.add(p.id))),
    )
  }
  return out
}

/** Each local session's requests since `since`, scanning only files the cache does not hold as they are. */
async function sessionCosts($: EngineInterface, since: number): Promise<Map<string, CostPoint[]>> {
  if (!costCache) {
    const stored = await $.store.get(COSTS_KEY).catch(() => undefined)
    costCache = stored && typeof stored === 'object' ? (stored as Record<string, CachedFile>) : {}
  }
  const cache = costCache
  const files = await recentTranscripts($, since)
  const stampOf = (f: Transcript) => `${f.size}:${f.mtimeMs}`
  const stale = files.filter(f => cache[norm(f.path)]?.stamp !== stampOf(f))
  let isChanged = false
  if (stale.length > 0) {
    await $.state.set(MEASURE, { state: 'measuring', files: stale.length })
    const scanned = await scan($, stale.map(f => f.path))
    for (const f of stale) cache[norm(f.path)] = { stamp: stampOf(f), mtimeMs: f.mtimeMs, points: pack(scanned.get(norm(f.path)) ?? []) }
    isChanged = true
  }
  // files a day older than the longest window are of no use any more
  for (const [path, v] of Object.entries(cache)) {
    if (v.mtimeMs < since - 86_400_000) {
      delete cache[path]
      isChanged = true
    }
  }
  if (isChanged) await $.store.set(COSTS_KEY, cache).catch(() => undefined)
  const bySession = new Map<string, CostPoint[]>()
  for (const f of files) {
    const points = unpack(cache[norm(f.path)]?.points ?? [])
    const list = bySession.get(f.session)
    if (list) list.push(...points)
    else bySession.set(f.session, points)
  }
  return bySession
}

const windowStart = (l: LimitWindow) => {
  const span = WINDOW_MS[l.kind]
  const end = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  return span !== undefined && Number.isFinite(end) ? end - span : NaN
}

// the newest reading of the limits, by any session: they are the account's,
// and the API reports them only with a reply, so a session resumed or just
// started has none until its next one
const LIMITS_KEY = 'last-limits'
type StoredLimits = { at: number; limits: LimitWindow[] }

/** What only the running session knows: the context fill and the rate limits, as the API reports them. */
async function liveUsage($: EngineInterface): Promise<LiveUsage> {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  let limits: LimitWindow[] = usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
  if (limits.length > 0) {
    await $.store.set(LIMITS_KEY, { at: now, limits } satisfies StoredLimits).catch(() => undefined)
  } else {
    const stored = (await $.store.get(LIMITS_KEY).catch(() => undefined)) as StoredLimits | undefined
    // a reading whose window has reset since says nothing any more
    limits = (stored?.limits ?? [])
      .filter(l => !l.resetsAt || Date.parse(l.resetsAt) > now)
      .map(l => ({ ...l, readAt: stored!.at }))
  }
  return {
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    contextPercent: usage.context.percent,
    limits,
  }
}

/** A measured share, rescaled to the newest reading of the window's percentage. */
function pickShare(measured: LimitWindow | undefined, percentUsed: number): Partial<LimitWindow> {
  if (!measured || measured.totalUsd === undefined || measured.sessionUsd === undefined) return {}
  return {
    session: measured.totalUsd > 0 ? (percentUsed * measured.sessionUsd) / measured.totalUsd : 0,
    sessionUsd: measured.sessionUsd,
    totalUsd: measured.totalUsd,
    sessions: measured.sessions,
  }
}

const withShares = (r: UsageReport, from: LimitWindow[]): UsageReport => {
  if (!r.live) return r
  const byKind = new Map(from.map(l => [l.kind, l]))
  return { ...r, live: { ...r.live, limits: r.live.limits.map(l => ({ ...l, ...pickShare(byKind.get(l.kind), l.percentUsed) })) } }
}

/** Adds this session's part to each limit and redraws; the first run scans the week's transcripts. */
async function measureShares($: EngineInterface): Promise<void> {
  const { value: r } = await $.state.get(CURRENT)
  if (!r?.live) return
  const starts = r.live.limits.map(windowStart).filter(Number.isFinite)
  if (starts.length === 0) return
  try {
    const bySession = await sessionCosts($, Math.min(...starts))
    const measured = r.live.limits.map(l => {
      const start = windowStart(l)
      return Number.isFinite(start) ? { ...l, ...windowShare(l.percentUsed, start, r.sessionId, bySession) } : l
    })
    // the reports may have been replaced meanwhile: add the shares to the newest
    const { value: now } = await $.state.get(CURRENT)
    if (now) await $.state.set(CURRENT, withShares(now, measured))
    const { value: pane } = await $.state.get(REPORT)
    if (pane && pane.sessionId === r.sessionId) await $.state.set(REPORT, withShares(pane, measured))
    await $.state.set(MEASURE, { state: 'idle' })
  } catch (err) {
    await $.state.set(MEASURE, { state: 'error', error: (err as Error)?.message ?? String(err) })
  }
}

// ---------- keeping the reports current ----------

/** Analyzes the running session for the footer, and for the pane when it shows this session. */
async function refreshCurrent($: EngineInterface): Promise<UsageReport | undefined> {
  const sessionId = await $.session.id()
  const r = await analyze($, sessionId).catch(() => undefined)
  if (!r) return undefined
  r.live = await liveUsage($).catch(() => undefined)
  // keep the shares of the last measurement until the new one lands
  const { value: before } = await $.state.get(CURRENT)
  const report = before?.live && before.sessionId === sessionId ? withShares(r, before.live.limits) : r
  await $.state.set(CURRENT, report)
  const { value: pane } = await $.state.get(REPORT)
  if (!pane || pane.sessionId === sessionId) await $.state.set(REPORT, report)
  // work that outlives this dispatch runs from a timer
  if (report.live && !measuring) {
    $.clock.after(0, () => {
      if (measuring) return
      measuring = measureShares($)
        .catch(() => undefined)
        .finally(() => {
          measuring = undefined
        })
    })
  }
  return report
}

/** Analyzes a session for the pane: the running one, or an earlier one by id. */
async function refreshPane($: EngineInterface, sessionId: string): Promise<UsageReport | undefined> {
  await $.state.set(STATUS, 'Analyzing…')
  try {
    let r: UsageReport | undefined
    if (sessionId === (await $.session.id())) {
      r = await refreshCurrent($)
      if (r) await $.state.set(REPORT, r)
    } else {
      r = await analyze($, sessionId)
      await $.state.set(REPORT, r)
      await $.state.set(FILTER, NO_FILTER)
      await $.state.set(PREVIEW, null)
    }
    if (!r) throw new Error(`No transcript found for session ${sessionId}.`)
    await $.state.set(STATUS, '')
    return r
  } catch (err) {
    await $.state.set(STATUS, `Could not analyze: ${(err as Error)?.message ?? String(err)}`)
    return undefined
  }
}

// a footer drawn before any report (a session the mod joined midway) asks
// for one; at most every few seconds, so a session with no transcript yet
// does not ask on every draw
let warmedAt = -Infinity
function warmUp($: EngineInterface) {
  $.clock.after(0, async () => {
    const now = await $.clock.now()
    if (now - warmedAt < 5000) return
    warmedAt = now
    await refreshCurrent($)
  })
}

async function closePopover($: EngineInterface) {
  const { value: isOpen = false } = await $.state.get(POPOVER)
  if (isOpen) await $.state.set(POPOVER, false)
}

/// ---------- leading from a details entry to what it was ----------

const FILE_CATS = /^(code|doc)_(read|write)$|^(scratch|instructions)$/
/** Kinds best seen as their turn: what was said, done and answered around them. */
const TURN_CATS = /^(prompt|reply|thinking)$/
const PREVIEW_CHARS = 60_000
/** Lines a preview shows at once, until "Show all". */
const PREVIEW_LINES = 30

/** The first turn an entry cost anything in. */
const firstTurn = (g: Group) =>
  Object.entries(g.byTurn)
    .filter(([, c]) => c > 0)
    .map(([t]) => Number(t))
    .sort((a, b) => a - b)[0]

type Lead = 'file' | 'page' | 'show' | 'turn' | 'none'

/** Where a click on the entry leads. */
function leadOf(g: Group): Lead {
  if (g.ref?.path && FILE_CATS.test(g.cat)) return 'file'
  if (g.ref?.url) return 'page'
  if (TURN_CATS.test(g.cat) && firstTurn(g) !== undefined) return 'turn'
  if (g.ref?.toolUseId || g.ref?.messageId) return 'show'
  return firstTurn(g) === undefined ? 'none' : 'turn'
}

const leadHint = (lead: Lead, g: Group) =>
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

async function openPage($: EngineInterface, url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false
  return (await $.env.get('OS')) === 'Windows_NT'
    ? runFirst($, [['rundll32', 'url.dll,FileProtocolHandler', url]])
    : runFirst($, [['open', url], ['xdg-open', url]])
}

/**
 * Shows a file in the app's Files pane. The app opens only files inside the
 * session's folders there; for any other it answers an error.
 */
async function showInFilesPane($: EngineInterface, path: string): Promise<boolean> {
  const shown = await $.mcp.call('ccd_view', 'show_pane', { pane: 'file', path }).catch(() => undefined)
  return shown !== undefined && !shown.isError
}

const cutTo = (s: string, max: number): { text: string; note?: string } =>
  s.length > max ? { text: s.slice(0, max), note: `first ${tok(max)} of ${tok(s.length)} characters` } : { text: s }

/** A file's text, for the pane; undefined when it is gone or not text. */
async function filePreview($: EngineInterface, path: string): Promise<Preview | undefined> {
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
async function contentPreview($: EngineInterface, raw: UsageReport, g: Group): Promise<Preview | undefined> {
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
async function turnPreview($: EngineInterface, raw: UsageReport, turn: number): Promise<Preview | undefined> {
  const row = raw.turnRows.find(t => t.turn === turn)
  if (!row) return undefined
  const next = raw.turnRows.find(t => t.turn === turn + 1)
  const rows = parseJsonl(await readText($, raw.file)).filter(r => r.isSidechain !== true)
  // from the turn's prompt (else its first moment) to the next turn's
  const at = (r: any) => (typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN)
  let from = row.promptId ? rows.findIndex(r => r.uuid === row.promptId) : -1
  if (from < 0) from = rows.findIndex(r => at(r) >= row.startedAt)
  if (from < 0) return undefined
  const parts: string[] = []
  for (const r of rows.slice(from)) {
    if (next && (r.uuid === next.promptId || at(r) >= next.startedAt)) break
    const content = r.message?.content
    if (r.type === 'user' && !r.isMeta && !r.isCompactSummary) {
      const isResult = Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')
      const text = isResult ? '' : textOf(content).trim()
      if (text) parts.push(`**You:** ${text}`)
    } else if (r.type === 'assistant') {
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'text' && b.text?.trim()) parts.push(b.text.trim())
        else if (b?.type === 'tool_use') {
          const i = b.input ?? {}
          const what = String(i.description ?? i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.skill ?? '').split('\n')[0]!.slice(0, 100)
          parts.push(`\`→ ${b.name}${what ? `: ${what}` : ''}\``)
        } else if (b?.type === 'thinking' && b.thinking?.trim()) parts.push(`*Thinking:* ${b.thinking.trim()}`)
      }
    }
  }
  if (parts.length === 0) return undefined
  const { text: source, note } = cutTo(parts.join('\n\n'), PREVIEW_CHARS)
  return { title: `Turn ${turn}: ${row.prompt}`, source, note, isMarkdown: true }
}

// the prompts' rows as the chat draws them: their text → the id a scroll takes
const promptRows = new Map<string, string>()
const promptKey = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

/** Scrolls the chat to a turn's prompt; the reason when it cannot. */
async function jumpToTurn($: EngineInterface, raw: UsageReport, turn: number): Promise<string | undefined> {
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

const activeMsOf = (r: UsageReport) => r.time.filter(t => t.id !== 'idle').reduce((s, t) => s + t.ms, 0)

/** One line per figure, for the footer's hover. */
function summaryText(r: UsageReport): string {
  const lines = [`Session usage: ${money(r.cost.total)} at API prices (${money(r.cost.noCache)} without caching)`]
  for (const [kind, name] of [
    ['five_hour', '5-hour limit'],
    ['seven_day', 'Weekly limit'],
  ] as const) {
    const l = r.live?.limits.find(x => x.kind === kind)
    if (l) lines.push(`${name}: this session ${l.session === undefined ? 'measuring…' : `≈ ${l.session.toFixed(1)}%`} (${Math.round(l.percentUsed)}% used in all)`)
  }
  if (r.live) {
    const ctx = r.live.contextPercent ?? (100 * (r.live.contextTokens ?? r.contextNow)) / Math.max(1, r.live.contextWindow)
    lines.push(`Context: ${Math.round(ctx)}% · ${tok(r.live.contextTokens ?? r.contextNow)} of ${tok(r.live.contextWindow)}`)
  }
  lines.push(`Active ${dur(activeMsOf(r))} · ${r.turns} turns`, 'Click for more')
  return lines.join('\n')
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Break this session’s tokens, cost and time down by content and activity',
      argumentHint: '[session-id] [export]',
      immediate: true,
    })
    // an earlier version kept weekly-limit readings here; nothing reads them now
    for (const key of await $.store.keys()) if (key.startsWith('limits:')) await $.store.delete(key)
    void $.ui.close({ id: SUMMARY })
    // a resumed session has turns already: show them in the footer
    $.clock.after(300, () => void refreshCurrent($))
    return next(e)
  })

  // the popover closes as a popover does: when the person turns to something
  // else (types, sends, presses anything but the popover's own buttons). The
  // app tells a plugin of no click elsewhere, so these stand in for one.
  on('prompt.edit', async ($, e, next) => {
    void closePopover($)
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    void closePopover($)
    return next(e)
  })
  on('ui.press', async ($, e, next) => {
    const isOwn = e.plugin === PLUGIN && (e.element === 'usage-toggle' || e.element === 'usage-details')
    if (!isOwn) void closePopover($)
    return next(e)
  })

  // learn each prompt's row id as the chat draws it, for a jump to its turn;
  // the drawing itself is the engine's, untouched
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!e.props.from && !e.props.task) promptRows.set(promptKey(e.props.text), e.requestId)
    return next(e)
  })

  // keep the footer and the pane current: once a turn of the main
  // conversation ends, analyze again, a moment later so the transcript has
  // its last rows
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) $.clock.after(1500, () => void refreshCurrent($))
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const wantsExport = words.includes('export')
    const sessionId = words.find(w => w !== 'export') ?? (await $.session.id())
    void $.ui.open({ id: PANE, title: 'Session usage', columns: 110 })
    const r = await refreshPane($, sessionId)
    if (!r) return { text: (await $.state.get(STATUS)).value || 'Could not analyze the session.' }
    if (wantsExport) {
      const path = `${await $.session.cwd()}/session-usage-${sessionId.slice(0, 8)}.md`
      await $.fs.write(path, toMarkdown(r))
      return { text: `Session usage report written to ${path}` }
    }
    return {
      text: `Session usage: ${money(r.cost.total)} at API prices (${money(r.cost.noCache)} without caching), ${tok(r.output.total)} output, ${dur(activeMsOf(r))} active. Details in the Session usage pane.`,
    }
  })

  // the footer: one button whose name is the figure itself (the desktop draws
  // a footer button by its label alone: no pictures, nothing floating). Its
  // ring glyph fills with this session's part of the 5-hour limit, else the
  // context's fill. A click opens the short summary in the band above the
  // prompt, the nearest place to the button that draws a card.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface === 'terminal') return next(e)
    const { value: r } = await $.state.get(CURRENT)
    // no report yet, or one of the session before a /clear: ask for one now
    // rather than at the end of the next turn
    if (!r || r.sessionId !== (await $.session.id())) {
      warmUp($)
      if (!r) return next(e)
    }
    const { value: isOpen = false } = await $.state.get(POPOVER)
    const { Box, Text, Button } = $.ui.resolve(e)
    const five = r.live?.limits.find(l => l.kind === 'five_hour')
    const ctx = r.live ? (r.live.contextPercent ?? (100 * (r.live.contextTokens ?? r.contextNow)) / Math.max(1, r.live.contextWindow)) : 0
    const percent = five?.session ?? ctx
    const glyph = percent < 12.5 ? '○' : percent < 37.5 ? '◔' : percent < 62.5 ? '◑' : percent < 87.5 ? '◕' : '●'
    const figure = five?.session !== undefined ? `${glyph} ${Math.round(five.session)}% of 5h · ${money(r.cost.total)}` : `${glyph} ${money(r.cost.total)}`
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {e.props.modes.length > 0 ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : null}
        {/* the footer draws a button's label alone, no chrome: no-break spaces pad it */}
        <Button plain key="usage-toggle" label={`  ${figure}${isOpen ? ' ▴' : ' ▾'}  `} onPress={() => void $.state.set(POPOVER, !isOpen)} />
      </Box>
    )
  })

  // the short summary, in the band above the prompt while the footer's button has it open
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const { value: isOpen = false } = await $.state.get(POPOVER)
    const { value: r } = await $.state.get(CURRENT)
    if (!isOpen || !r) return next(e)
    const { value: measure } = await $.state.get(MEASURE)
    const { Box, Button, Svg } = $.ui.resolve(e)
    // as wide as the app's own context card, narrower only in a narrow window
    const card = summaryCard(r, measure, Math.min(380, Math.max(260, e.props.bodyColumns * PX_PER_COLUMN - 24)))
    const { width, height } = svgSize(card)
    const openDetails = async () => {
      await $.state.set(POPOVER, false)
      await $.ui.open({ id: PANE, title: 'Session usage', columns: 110 })
      const { value: pane } = await $.state.get(REPORT)
      if (!pane || pane.sessionId !== r.sessionId) await refreshPane($, r.sessionId)
    }
    // the band is the app's, as wide as the prompt; the card sits in its middle
    return (
      <Box flexDirection="column" alignItems="center" width="100%">
        <Box flexDirection="column" gap={1} width={Math.ceil(width / PX_PER_COLUMN) + 1}>
          <Svg source={card} alt={summaryText(r)} width={width} height={height} isInteractive />
          <Box flexDirection="row">
            <Button key="usage-details" onPress={() => void openDetails()}>
              Show the full breakdown
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { value: raw = null } = await $.state.get(REPORT)
    const { value: stored = 'overview' } = await $.state.get(TAB)
    const { value: note = '' } = await $.state.get(STATUS)
    const { value: filter = NO_FILTER } = await $.state.get(FILTER)
    const { value: measure } = await $.state.get(MEASURE)
    const { value: preview = null } = await $.state.get(PREVIEW)
    const cols = Math.max(50, Math.min(160, e.props.bodyColumns ?? e.viewport?.columns ?? 100))
    const setTab = (id: string) => () => void $.state.set(TAB, id)
    const setFilter = (next: Filter) => void $.state.set(FILTER, next)

    if (!raw) {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text dimColor>{note || `Run /${COMMAND} to analyze this session.`}</Text>
        </Box>
      )
    }

    const v = viewOf(filter)
    const r = applyFilter(raw, filter)
    const tabs = TABS.filter(([id]) => id !== 'agents' || raw.agents.length > 0)
    const wanted = OLD_TABS[stored] ?? stored
    const current = tabs.some(([id]) => id === wanted) ? wanted : 'overview'
    const activeMs = activeMsOf(r)
    const idleMs = r.time.find(t => t.id === 'idle')?.ms ?? 0
    const exportReport = async () => {
      const path = `${await $.session.cwd()}/session-usage-${raw.sessionId.slice(0, 8)}.md`
      await $.fs.write(path, toMarkdown(raw))
      $.ui.toast(`Written to ${path}`)
    }
    const refreshNow = () => void refreshPane($, raw.sessionId)
    const isLive = raw.sessionId === (await $.session.id())

    // a details entry's click: a file in the Files pane (else here), a page in
    // the browser, a command, output or skill here, anything else its turn in
    // the chat; nothing filters, and a step that cannot says why
    const show = async (p: Preview | undefined, what: string) => {
      if (!p) return $.ui.toast(`Could not find ${what}.`)
      await $.state.set(PREVIEW, p)
      void $.ui.scroll({ in: PANE, to: { key: 'preview-close' }, block: 'start' }).catch(() => undefined)
    }
    const goTo = async (g: Group) => {
      const lead = leadOf(g)
      const turn = firstTurn(g)
      if (lead === 'file' && g.ref?.path) {
        if (await showInFilesPane($, g.ref.path)) return
        // outside the session's folders the Files pane opens nothing: show it here
        return show((await filePreview($, g.ref.path)) ?? (await contentPreview($, raw, g).catch(() => undefined)), g.ref.path)
      }
      if (lead === 'page' && g.ref?.url) {
        if (!(await openPage($, g.ref.url))) $.ui.toast(`Could not open ${g.ref.url}`)
        return
      }
      if (lead === 'show') return show(await contentPreview($, raw, g).catch(() => undefined), g.label)
      if (lead === 'turn' && turn !== undefined) {
        // the chat is scrolled where the surface lets a plugin (the terminal);
        // the desktop does not, so the turn is shown here instead
        if (isLive && (await jumpToTurn($, raw, turn)) === undefined) return
        return show(await turnPreview($, raw, turn).catch(() => undefined), `turn ${turn}`)
      }
    }

    // filter actions: a row's click picks it alone, or drops it when it is the one picked
    const onlyTurn = (turn: number) =>
      setFilter({ ...filter, turns: filter.turns.length === 1 && filter.turns[0] === turn ? [] : [turn] })
    const onlyCat = (cat: string) => setFilter({ ...filter, cats: filter.cats.length === 1 && filter.cats[0] === cat ? [] : [cat] })

    // ----- the surfaces that draw SVG -----
    if (e.surface !== 'terminal') {
      const els = $.ui.resolve(e)
      const { Box, Text, Button, Svg } = els
      // mobile draws no dropdown: there the chips and the rows filter
      const Select = 'Select' in els ? els.Select : undefined
      setChartWidth(cols * PX_PER_COLUMN - 24)
      // an interactive Svg is drawn in a frame of its own, which does not take
      // the markup's size by itself: it is given the size the markup declares
      const chart = (source: string, alt: string) => {
        const fitted = fits(source)
        const { width, height } = svgSize(fitted)
        return (
          <Box marginTop={2}>
            <Svg source={fitted} alt={alt} width={width} height={height} isInteractive />
          </Box>
        )
      }
      const heading = (title: string, info?: string) => (
        <Box flexDirection="row" alignItems="center" gap={1} marginTop={2}>
          <Text bold>{title}</Text>
          {info ? <Svg source={infoIcon(info)} alt={info} width={18} height={18} isInteractive /> : null}
        </Box>
      )
      const legend = (items: [string, string][]) => (
        <Svg source={legendStrip(items, cols * PX_PER_COLUMN)} alt={items.map(([, l]) => l).join(', ')} width={svgSize(legendStrip(items, cols * PX_PER_COLUMN)).width} height={18} />
      )

      // native rows: the label is a button that filters, the bar a picture with a tooltip
      type Row = {
        key: string
        label: string
        segs: { v: number; cls: string }[]
        value: string
        title: string
        isSelected?: boolean
        isDimmed?: boolean
        onPress?: () => void
      }
      const labelCols = Math.max(18, Math.floor(cols * 0.34))
      const valueCols = 16
      const barPx = Math.max(80, Math.floor((cols - labelCols - valueCols - 4) * PX_PER_COLUMN))
      const rows = (list: Row[]) => {
        const max = Math.max(1e-12, ...list.map(x => x.segs.reduce((s, sg) => s + sg.v, 0)))
        return (
          <Box flexDirection="column" marginTop={1}>
            {list.map(x => (
              <Box key={`row-${x.key}`} flexDirection="row" alignItems="center">
                <Box width={labelCols} flexShrink={0}>
                  {x.onPress ? (
                    <Button
                      plain
                      key={`pick-${x.key}`}
                      label={cut(x.label, labelCols - 2)}
                      variant={x.isSelected ? 'primary' : undefined}
                      dimColor={x.isDimmed}
                      onPress={x.onPress}
                    >
                      <Text bold={x.isSelected} dimColor={x.isDimmed} wrap="truncate-end">
                        {cut(x.label, labelCols - 2)}
                      </Text>
                    </Button>
                  ) : (
                    <Text dimColor={x.isDimmed} wrap="truncate-end">
                      {cut(x.label, labelCols - 2)}
                    </Text>
                  )}
                </Box>
                <Svg
                  source={miniBar(x.segs, max, barPx, x.title, { isSelected: x.isSelected, isDimmed: x.isDimmed })}
                  alt={x.title}
                  width={barPx}
                  height={22}
                  isInteractive
                />
                <Text dimColor={x.isDimmed}> {x.value}</Text>
              </Box>
            ))}
          </Box>
        )
      }

      // the rows to pick from stay whole: kinds of content under the picked
      // turns, turns under the picked kinds; the picked ones are highlighted
      const byCats = applyFilter(raw, { turns: filter.turns, cats: [] })
      const byTurns = applyFilter(raw, { turns: [], cats: filter.cats })
      const totalCost = byCats.cost.total
      const contentRows = (limit: number): Row[] =>
        [...byCats.cats]
          .filter(c => c.inputCost + c.outputCost > 0.0005)
          .sort((a, b) => b.inputCost + b.outputCost - (a.inputCost + a.outputCost))
          .slice(0, limit)
          .map(c => {
            const isSelected = v.cats.has(c.id)
            return {
              key: `cat-${c.id}`,
              label: c.label,
              segs: [
                { v: c.inputCost, cls: 'read' },
                { v: c.outputCost, cls: 'out' },
              ],
              value: `${money(c.inputCost + c.outputCost)} · ${pct(c.inputCost + c.outputCost, totalCost)}`,
              title: `${c.label}\nAs context: ${money(c.inputCost)} · ${tok(c.added)} added, ${tok(c.processed)} sent in total\nAs output: ${money(c.outputCost)} · ${tok(c.output)} tokens\nClick to filter to it`,
              isSelected,
              isDimmed: v.cats.size > 0 && !isSelected,
              onPress: () => onlyCat(c.id),
            }
          })
      const turnRows = (): Row[] =>
        turnCosts(byTurns).map(({ t, read, write, out }) => {
          const isSelected = v.turns.has(t.turn)
          return {
            key: `turn-${t.turn}`,
            label: `${t.turn}. ${t.prompt}`,
            segs: [
              { v: read, cls: 'read' },
              { v: write, cls: 'write' },
              { v: out, cls: 'out' },
            ],
            value: money(read + write + out),
            title: `${t.turn}. ${cut(t.prompt, 100)}\n${v.isContent ? 'As context' : 'Cache reads'}: ${money(read)}${v.isContent ? '' : `\nCache writes: ${money(write)}`}\nOutput: ${money(out)}\n${dur(t.activeMs)} active · ${t.requests} requests · context ${tok(t.contextAtEnd)}\nClick to filter to this turn`,
            isSelected,
            isDimmed: v.turns.size > 0 && !isSelected,
            onPress: () => onlyTurn(t.turn),
          }
        })
      // a details entry's row: its cost, and a click that leads to it
      const entryRow = (g: Group, prefix: string, withKind = false): Row => {
        const lead = leadOf(g)
        const where = g.ref?.path ?? g.ref?.url
        const kind = CATS[g.cat]?.label ?? g.cat
        return {
          key: `${prefix}-${g.cat}-${g.label}`,
          label: lead === 'none' ? g.label : `${g.label} ↗`,
          segs: [{ v: g.cost, cls: 'read' }],
          value: `${money(g.cost)}${g.count > 1 ? ` · ${g.count}×` : ''}`,
          title: [
            g.label,
            ...(withKind ? [kind] : []),
            `${money(g.cost)} · ${tok(g.tokens)} tokens added${g.count > 1 ? ` · ${g.count} pieces` : ''}`,
            ...(where && where !== g.label ? [where] : []),
            ...(lead === 'none' ? [] : [leadHint(lead, g)]),
          ].join('\n'),
          onPress: lead === 'none' ? undefined : () => void goTo(g),
        }
      }
      const turnTimeRows = (): Row[] =>
        raw.turnRows.map(t => {
          const isSelected = v.turns.has(t.turn)
          const other = Math.max(0, t.activeMs - t.modelMs - t.toolMs - t.waitMs)
          return {
            key: `tt-${t.turn}`,
            label: `${t.turn}. ${t.prompt}`,
            segs: [
              { v: t.modelMs, cls: 'read' },
              { v: t.toolMs, cls: 'write' },
              { v: t.waitMs, cls: 'out' },
              { v: other, cls: 'other' },
            ],
            value: dur(t.activeMs),
            title: `${t.turn}. ${cut(t.prompt, 100)}\nClaude: ${dur(t.modelMs)} · tools: ${dur(t.toolMs)} · waiting: ${dur(t.waitMs)} · other: ${dur(other)}\nClick to filter to this turn`,
            isSelected,
            isDimmed: v.turns.size > 0 && !isSelected,
            onPress: () => onlyTurn(t.turn),
          }
        })
      const costLegend: [string, string][] = v.isContent
        ? [
            ['read', 'As context'],
            ['out', 'Output'],
          ]
        : [
            ['read', 'Cache reads'],
            ['write', 'Cache writes'],
            ['out', 'Output'],
          ]

      let body
      if (current === 'timeline') {
        body = [
          heading('Cost per turn', TURN_INFO + ' Click a turn to filter everything to it.'),
          legend(costLegend),
          rows(turnRows()),
          chart(contextChart(r, v.isContent), 'Context sent per request'),
          chart(costChart(r, v.isContent), 'Cost per request'),
          chart(cumulativeChart(r), 'Running total of the cost'),
        ]
      } else if (current === 'content') {
        const picked = [...v.cats]
        body = [
          heading('What each kind of content cost', CONTENT_INFO),
          legend([
            ['read', 'Sent as context (input)'],
            ['out', 'Written by Claude (output)'],
          ]),
          rows(contentRows(40)),
          ...(picked.length === 0
            ? [
                <Box marginTop={1}>
                  <Text dimColor>Click a kind of content to see what it was made of.</Text>
                </Box>,
              ]
            : picked.flatMap(cat => {
                const details = detailsOf(raw, cat, v)
                return [
                  heading(`${CATS[cat]?.label ?? cat}: what it was made of`, 'The most expensive entries of this kind, each summed over all its pieces: every read and edit of a file, every call of a command, every load of a skill.'),
                  details.length === 0
                    ? <Text dimColor>Nothing of this kind in the picked turns.</Text>
                    : rows(details.map(g => entryRow(g, `d-${cat}`))),
                ]
              })),
        ]
      } else if (current === 'time') {
        body = [
          chart(timeChart(r), 'Active time by activity'),
          heading('Time per turn', 'How long Claude worked on each prompt, from the prompt to its last action. Click a turn to filter everything to it.'),
          legend([
            ['read', 'Claude'],
            ['write', 'Tools'],
            ['out', 'Waiting for you'],
            ['other', 'Other'],
          ]),
          rows(turnTimeRows()),
          chart(toolsTable(r), 'Tools: calls, total and average time, result tokens'),
          heading('Slowest single calls', 'From the call to its result; a call that waited for your approval includes that wait. Click one to see the call and what came back.'),
          rows(
            r.slowest.slice(0, 15).map((s, k) => {
              const g: Group = {
                cat: s.bucket === 't_terminal' ? 'cmd' : 'other_tools',
                label: s.label,
                cost: 0,
                tokens: 0,
                count: 1,
                byTurn: { [s.turn]: 1 },
                ref: s.toolUseId ? { toolUseId: s.toolUseId } : undefined,
              }
              const lead = leadOf(g)
              return {
                key: `slow-${k}`,
                label: s.label,
                segs: [{ v: s.ms, cls: 'write' }],
                value: dur(s.ms),
                title: [s.label, `Took ${dur(s.ms)} · turn ${s.turn}`, ...(lead === 'none' ? [] : [leadHint(lead, g)])].join('\n'),
                onPress: lead === 'none' ? undefined : () => void goTo(g),
              }
            }),
          ),
          ...(v.isContent ? [<Text dimColor>Time is not split by kind of content; only the turn filter applies here.</Text>] : []),
        ]
      } else if (current === 'top') {
        body = [
          heading('The single entries that cost the most', 'Every entry of every kind of content, each summed over its pieces (every read of a file, every call of a command). Click one to see it.'),
          rows(topGroups(raw, v).map(g => entryRow(g, 'top', true))),
        ]
      } else if (current === 'agents') {
        body = [chart(agentsTable(r), 'Subagents: requests, tokens, time and cost')]
      } else {
        const allCats = byCats.cats.filter(c => c.inputCost + c.outputCost > 0.0005).length
        body = [
          chart(overviewTop(r, { isContent: v.isContent, measure }), `${money(r.cost.total)} at API prices, ${money(r.cost.noCache)} without caching`),
          heading('Where the money went', CONTENT_INFO),
          legend([
            ['read', 'Sent as context (input)'],
            ['out', 'Written by Claude (output)'],
          ]),
          rows(contentRows(5)),
          ...(allCats > 5 ? [<Text dimColor>{`Top 5 of ${allCats} · all on the By content tab`}</Text>] : []),
          chart(timeChart(r, 5, 'Where the time went', 'all on the Time tab'), 'The five activities that took the most time'),
          heading('Cost per turn', TURN_INFO + ' Click a turn to filter everything to it.'),
          legend(costLegend),
          rows(turnRows()),
        ]
      }

      // the filter: dropdowns add, chips remove
      const turnOptions = [
        { value: 'all', label: 'Add a turn…' },
        ...raw.turnRows.filter(t => !v.turns.has(t.turn)).map(t => ({ value: String(t.turn), label: `${t.turn}. ${cut(t.prompt, 48)}` })),
      ]
      const catOptions = [
        { value: 'all', label: 'Add a kind of content…' },
        ...raw.cats
          .filter(c => !v.cats.has(c.id) && c.inputCost + c.outputCost > 0.0005)
          .sort((a, b) => a.label.localeCompare(b.label))
          .map(c => ({ value: c.id, label: c.label })),
      ]
      const filterControls = (
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap" flexShrink={1}>
          <Text dimColor>Filter</Text>
          {Select ? (
            <Select
              key="add-turn"
              options={turnOptions}
              value="all"
              onSelect={(value: string) => {
                if (value !== 'all') setFilter({ ...filter, turns: [...filter.turns, Number(value)].sort((a, b) => a - b) })
              }}
            />
          ) : null}
          {Select ? (
            <Select
              key="add-cat"
              options={catOptions}
              value="all"
              onSelect={(value: string) => {
                if (value !== 'all') setFilter({ ...filter, cats: [...filter.cats, value] })
              }}
            />
          ) : null}
          {filter.turns.map(t => (
            <Button key={`chip-turn-${t}`} onPress={() => setFilter({ ...filter, turns: filter.turns.filter(x => x !== t) })}>
              {`Turn ${t}  ✕`}
            </Button>
          ))}
          {filter.cats.map(c => (
            <Button key={`chip-cat-${c}`} onPress={() => setFilter({ ...filter, cats: filter.cats.filter(x => x !== c) })}>
              {`${CATS[c]?.label ?? c}  ✕`}
            </Button>
          ))}
          {v.isFiltered ? (
            <Button plain key="clear-filter" label="Clear the filter" onPress={() => setFilter(NO_FILTER)}>
              <Text dimColor>Clear</Text>
            </Button>
          ) : null}
        </Box>
      )

      // the filter on the left; the two secondary actions small and dim on the right
      const filterBar = (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} marginTop={1}>
          {filterControls}
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button key="refresh" label="⟳" dimColor onPress={refreshNow} />
            <Button key="export" label="⤓ .md" dimColor onPress={exportReport} />
          </Box>
        </Box>
      )

      // one row of tabs, the picked one drawn as the primary button; where
      // they would not fit on one row, a dropdown takes their place
      const tabsPx = tabs.reduce((s, [, label]) => s + label.length * PX_PER_COLUMN + 28, 0) + (tabs.length - 1) * PX_PER_COLUMN
      const tabBar =
        tabsPx <= cols * PX_PER_COLUMN || !Select ? (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {tabs.map(([id, label]) => (
              <Button key={`tab-${id}`} label={label} variant={current === id ? 'primary' : undefined} dimColor={current !== id} onPress={setTab(id)} />
            ))}
          </Box>
        ) : (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text dimColor>View</Text>
            <Select key="tab" options={tabs.map(([value, label]) => ({ value, label }))} value={current} onSelect={(value: string) => void $.state.set(TAB, value)} />
          </Box>
        )

      // what a details entry's click put on show: the file, script, output or skill itself
      const { Code, Markdown } = els
      // a long preview shows a window of its lines, stepped with ▲ ▼, so the
      // pane keeps its length (a Box clips but does not scroll); "Show all" lifts it
      const lines = preview ? preview.source.split('\n') : []
      const isWindowed = preview !== null && !preview.isExpanded && lines.length > PREVIEW_LINES
      const first = isWindowed ? Math.min(Math.max(0, preview.offset ?? 0), lines.length - PREVIEW_LINES) : 0
      const shownSource = isWindowed ? lines.slice(first, first + PREVIEW_LINES).join('\n') : (preview?.source ?? '')
      const movePreview = async (change: (p: Preview) => Partial<Preview>) => {
        const { value: now } = await $.state.get(PREVIEW)
        if (now) await $.state.set(PREVIEW, { ...now, ...change(now) })
      }
      const step = (by: number) => () =>
        void movePreview(p => ({ offset: Math.min(Math.max(0, (p.offset ?? 0) + by), Math.max(0, lines.length - PREVIEW_LINES)) }))
      const shown = preview ? (
        <Box flexDirection="column" marginTop={2} borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Text bold wrap="truncate-middle">
              {preview.title}
            </Text>
            <Button key="preview-close" label="✕" dimColor onPress={() => void $.state.set(PREVIEW, null)} />
          </Box>
          {preview.note ? <Text dimColor>{preview.note}</Text> : null}
          <Box marginTop={1}>
            {preview.isMarkdown ? (
              <Markdown text={shownSource} />
            ) : (
              <Code source={shownSource} language={preview.language} path={preview.path} startLine={first + 1} />
            )}
          </Box>
          {lines.length > PREVIEW_LINES ? (
            <Box flexDirection="row" alignItems="center" gap={1} marginTop={1}>
              {isWindowed ? (
                <>
                  <Button key="preview-up" label="▲" dimColor onPress={step(-PREVIEW_LINES)} />
                  <Button key="preview-down" label="▼" dimColor onPress={step(PREVIEW_LINES)} />
                  <Text dimColor>{`lines ${first + 1}–${Math.min(lines.length, first + PREVIEW_LINES)} of ${lines.length}`}</Text>
                  <Button key="preview-all" label="Show all" dimColor onPress={() => void movePreview(() => ({ isExpanded: true }))} />
                </>
              ) : (
                <Button key="preview-less" label="Show less" dimColor onPress={() => void movePreview(() => ({ isExpanded: false }))} />
              )}
            </Box>
          ) : null}
        </Box>
      ) : null

      return (
        <Box flexDirection="column">
          {tabBar}
          {filterBar}
          {note ? <Text dimColor>{note}</Text> : null}
          {shown}
          <Box flexDirection="column">{body}</Box>
        </Box>
      )
    }

    // ----- the terminal: text bars -----
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const inputTotal = r.input.uncached + r.input.cacheWrite + r.input.cacheRead
    const labelW = Math.min(36, Math.floor(cols * 0.36))
    const barW = Math.max(6, cols - labelW - 28)

    const row = (p: { label: string; color: string; frac: number; value: string; dim?: boolean }) => (
      <Box flexDirection="row">
        <Box width={labelW}>
          <Text dimColor={p.dim} wrap="truncate-end">
            {cut(p.label, labelW - 1)}
          </Text>
        </Box>
        <Box width={barW}>
          <Text color={p.color}>{bar(p.frac, barW)}</Text>
        </Box>
        <Text dimColor={p.dim}> {p.value}</Text>
      </Box>
    )
    const heading = (title: string) => (
      <Box marginTop={1}>
        <Text bold>{title}</Text>
      </Box>
    )

    let body
    if (current === 'timeline') {
      const maxCost = Math.max(1e-9, ...r.turnRows.map(t => t.cost))
      body = (
        <Box flexDirection="column">
          {heading('Cost per turn')}
          {r.turnRows.map(t =>
            row({ label: `${t.turn}. ${t.prompt}`, color: '#2a78d6', frac: t.cost / maxCost, value: `${money(t.cost)} · ${t.requests} req · ctx ${tok(t.contextAtEnd)}`, dim: v.turns.size > 0 && !v.turns.has(t.turn) }),
          )}
        </Box>
      )
    } else if (current === 'content') {
      const byProcessed = [...r.cats].filter(c => c.processed > 0).sort((a, b) => b.processed - a.processed)
      const byOutput = [...r.cats].filter(c => c.output >= 1).sort((a, b) => b.output - a.output)
      body = (
        <Box flexDirection="column">
          {heading('Input: what filled the context (added → sent in total)')}
          {byProcessed.map(c =>
            row({ label: c.label, color: c.color, frac: c.processed / Math.max(1, inputTotal), value: `${tok(c.added)} → ${tok(c.processed)} · ${money(c.inputCost)}` }),
          )}
          {heading('Output: what Claude generated')}
          {byOutput.map(c =>
            row({ label: c.label, color: c.color, frac: c.output / Math.max(1, r.output.total), value: `${tok(c.output)} · ${money(c.outputCost)}` }),
          )}
        </Box>
      )
    } else if (current === 'time') {
      const maxTool = Math.max(1, ...r.tools.map(t => t.ms))
      body = (
        <Box flexDirection="column">
          {heading('Where the active time went')}
          {r.time
            .filter(t => t.id !== 'idle')
            .sort((a, b) => b.ms - a.ms)
            .map(t => row({ label: t.label, color: t.color, frac: t.ms / Math.max(1, activeMs), value: `${dur(t.ms)}  ${pct(t.ms, activeMs)}` }))}
          {idleMs > 0 && row({ label: BUCKETS.idle!.label, color: BUCKETS.idle!.color, frac: 0, value: dur(idleMs), dim: true })}
          {heading('Tools (calls · total · avg · result tokens)')}
          {r.tools.slice(0, 20).map(t =>
            row({
              label: t.tool.replace(/^mcp__/, ''),
              color: '#3fa36b',
              frac: t.ms / maxTool,
              value: `${t.calls}× ${dur(t.ms)} · ${dur(t.ms / Math.max(1, t.calls))} · ${tok(t.resultTokens)}`,
            }),
          )}
        </Box>
      )
    } else if (current === 'top') {
      const max = Math.max(1e-9, r.top[0]?.cost ?? 0)
      body = (
        <Box flexDirection="column">
          {heading('Most expensive items (cost · pieces)')}
          {r.top.map(t => row({ label: t.label, color: CATS[t.cat]?.color ?? '#888', frac: t.cost / max, value: `${money(t.cost)}${t.reads > 1 ? ` · ${t.reads}×` : ''}` }))}
        </Box>
      )
    } else if (current === 'agents') {
      body = <Markdown text={mdAgentTable(r)} />
    } else {
      body = (
        <Box flexDirection="column">
          <Markdown text={mdCostTable(r)} />
          <Markdown text={cachingStory(r)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {tabs.map(([id, label]) => (
            <Button key={`tab-${id}`} variant={current === id ? 'primary' : 'secondary'} onPress={setTab(id)}>
              {label}
            </Button>
          ))}
          <Button key="refresh" dimColor onPress={refreshNow}>
            Refresh
          </Button>
          <Button key="export" dimColor onPress={exportReport}>
            Export .md
          </Button>
        </Box>
        <Text dimColor>
          {`${r.turns} turns · ${r.requests} requests · ${dur(activeMs)} active · context now ${tok(r.contextNow)}`}
          {v.isFiltered ? ` · filtered: ${[...filter.turns.map(t => `turn ${t}`), ...filter.cats.map(c => CATS[c]?.label ?? c)].join(', ')}` : ''}
          {note ? ` · ${note}` : ''}
        </Text>
        {body}
      </Box>
    )
  })
}
