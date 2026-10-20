// Turns a Claude Code transcript (.jsonl rows) into a UsageReport.
//
// Tokens: the API reports, per request, how big the whole context was
// (input + cache write + cache read) and how much was generated (output, with
// thinking split out). The growth of the context between two requests is
// exact; it is shared out over the content that was appended in between
// (tool results, prompts, reminders, the model's own previous blocks) by
// character count. Each piece of content then stays in the context and is
// re-processed (mostly as cache reads) on every later request until a
// compaction drops it, which is the "processed" figure.
//
// Time: from row timestamps. A request runs from the row before it to its
// last streamed block; a tool runs from its tool_use row to its tool_result.
// Overlaps are resolved model > tool > overhead; gaps between a turn's end
// and the next prompt are time spent waiting for the person.

import type {
  AgentRow,
  CacheBreak,
  Price,
  Ref,
  RequestPoint,
  CatRow,
  Group,
  SlowCall,
  TimeRow,
  ToolRow,
  ToolTurn,
  TopItem,
  TurnCat,
  TurnRow,
  UsageReport,
} from '../types'

type Row = Record<string, any>

export const CATS: Record<string, { label: string; color: string }> = {
  sys: { label: 'System prompt & tool definitions', color: '#8b8b8b' },
  prompt: { label: 'Your prompts', color: '#e8a33d' },
  instructions: { label: 'CLAUDE.md & memory', color: '#c98b5a' },
  tooling: { label: 'Tool / skill / agent listings', color: '#a3a3a3' },
  reminders: { label: 'System reminders & injected context', color: '#b5b5b5' },
  skills: { label: 'Skill instructions', color: '#9b7fd1' },
  compaction: { label: 'Compaction summaries', color: '#6f6f6f' },
  thinking: { label: 'Thinking', color: '#c06bc9' },
  reply: { label: "Claude's replies (text)", color: '#d9774a' },
  cmd: { label: 'Terminal commands', color: '#3fa36b' },
  script: { label: 'Scripts (inline in commands)', color: '#2f7d52' },
  termout: { label: 'Terminal output', color: '#7cc79a' },
  code_read: { label: 'Code read', color: '#3d7fd9' },
  doc_read: { label: 'Docs & data read', color: '#7aa8e6' },
  code_write: { label: 'Code written / edited', color: '#2456a6' },
  doc_write: { label: 'Docs & data written / edited', color: '#5c86c7' },
  search: { label: 'Search (Grep / Glob)', color: '#37a3a3' },
  web: { label: 'Web pages, search & browser', color: '#d4b13a' },
  agents: { label: 'Subagent prompts & results', color: '#cf5a7a' },
  mcp: { label: 'Other MCP tools', color: '#8a9a3a' },
  scratch: { label: 'Scratchpad & temp files', color: '#8a7fb0' },
  other_tools: { label: 'Other tools', color: '#9a8a6a' },
  other: { label: 'Unattributed', color: '#5a5a5a' },
}

export const BUCKETS: Record<string, { label: string; color: string }> = {
  model: { label: 'Claude thinking & writing', color: '#d9774a' },
  t_terminal: { label: 'Running terminal commands', color: '#3fa36b' },
  t_files: { label: 'Reading / writing files', color: '#3d7fd9' },
  t_search: { label: 'Searching (Grep / Glob)', color: '#37a3a3' },
  t_web: { label: 'Web & browser', color: '#d4b13a' },
  t_agents: { label: 'Subagents', color: '#cf5a7a' },
  t_mcp: { label: 'Other MCP tools', color: '#8a9a3a' },
  t_other: { label: 'Other tools', color: '#9a8a6a' },
  approval: { label: 'Waiting for your approval / answer', color: '#e05252' },
  overhead: { label: 'Overhead (hooks, startup, retries)', color: '#8b8b8b' },
  stalled: { label: 'Stalled (no activity: sleep, network, hang)', color: '#6b5a8a' },
  idle: { label: 'Idle between turns (waiting for you)', color: '#4a4a4a' },
}

const CHARS_PER_TOKEN = 3.6

// $ per million tokens, first-party API list prices. Cache writes cost 1.25x
// input for the 5-minute TTL and 2x for the 1-hour TTL; reads are per model.
const PRICES: [RegExp, Omit<Price, 'model' | 'isKnown'>][] = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50, read: 0.25 }],
  [/fable-5|mythos-5/, { input: 10, output: 50, read: 1 }],
  [/opus-5-5/, { input: 4, output: 20, read: 0.2 }],
  [/opus-5|opus-4-[5-9]/, { input: 5, output: 25, read: 0.5 }],
  [/opus-4/, { input: 15, output: 75, read: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, read: 0.2 }],
  [/sonnet-4|sonnet-3/, { input: 3, output: 15, read: 0.3 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5, read: 0.01 }],
  [/haiku-4/, { input: 1, output: 5, read: 0.1 }],
  [/haiku-3/, { input: 0.8, output: 4, read: 0.08 }],
]
const DEFAULT_PRICE = { input: 4, output: 20, read: 0.2 }

export function priceOf(model: string): Price {
  const hit = PRICES.find(([re]) => re.test(model))
  return { model, isKnown: hit !== undefined, ...(hit?.[1] ?? DEFAULT_PRICE) }
}
const IMAGE_WEIGHT = 6000 // an image block weighs as much as ~1.6k tokens of text
const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyw|cs|cpp|cc|cxx|c|h|hpp|java|kt|kts|go|rs|rb|php|swift|sh|bash|zsh|ps1|psm1|psd1|bat|cmd|sql|lua|gd|gdshader|vue|svelte|css|scss|sass|less|html|htm|dart|scala|r|m|mm|fs|vb|zig|nim|ex|exs|erl|hs|clj|el|vim|asm|glsl|hlsl|shader|wgsl|cmake|gradle|tf|proto)$/i
/** A gap this long with nothing running, or a request this silent, is a stall. */
const STALL_MS = 10 * 60 * 1000
const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'])

const textLen = (v: unknown): number => (typeof v === 'string' ? v.length : 0)

/** Weight of a content value (string or blocks) in characters. */
function weight(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length
  let w = 0
  for (const b of content) {
    if (b == null) continue
    if (typeof b === 'string') w += b.length
    else if (b.type === 'text') w += textLen(b.text)
    else if (b.type === 'image' || b.type === 'document') w += IMAGE_WEIGHT
    else if (b.type === 'tool_reference') w += 400
    else if (b.type === 'tool_result') w += weight(b.content)
    else w += JSON.stringify(b).length
  }
  return w
}

function firstLine(s: unknown, max = 70): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function baseName(p: unknown): string {
  const s = String(p ?? '')
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/') || s
}

function host(u: unknown): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(u ?? ''))
  return m?.[1] ?? firstLine(u, 40)
}

/** The skill's folder, from "Base directory for this skill: <path>". */
const skillDir = (text: string) => /Base directory for this skill:\s*(\S+)/.exec(text)?.[1] ?? ''

/** The skill's folder name. */
function skillName(text: string): string {
  return skillDir(text).split(/[\\/]/).filter(Boolean).pop() ?? 'skill'
}

const isCodePath =(p: unknown) => CODE_EXT.test(String(p ?? ''))

/** CLAUDE.md files anywhere, and the auto-memory under ~/.claude. */
const isMemoryPath = (p: unknown) => {
  const s = String(p ?? '')
  return /(^|[\\/])CLAUDE(\.local)?\.md$/i.test(s) || /[\\/]\.claude[\\/](projects[\\/][^\\/]+[\\/])?memory[\\/]/i.test(s)
}

/** Claude's own working files: the session scratchpad and its temp folder. */
const isScratchPath = (p: unknown) => /[\\/](Temp|tmp)[\\/]claude[\\/]|[\\/]scratchpad([\\/]|$)/i.test(String(p ?? ''))

/** The kind a file read or written counts under. */
const fileCat = (p: unknown, isWrite: boolean) =>
  isMemoryPath(p) ? 'instructions' : isScratchPath(p) ? 'scratch' : isCodePath(p) ? (isWrite ? 'code_write' : 'code_read') : isWrite ? 'doc_write' : 'doc_read'

const isWeb = (name: string) =>
  name === 'WebFetch' ||
  name === 'WebSearch' ||
  /^mcp__(Claude_Browser|claude-in-chrome|remote-devices__Claude_Browser)__/.test(name) ||
  /^mcp__[^_]*(fetch|browser|playwright|puppeteer)/i.test(name)

const isTerminal = (name: string) =>
  name === 'Bash' ||
  name === 'PowerShell' ||
  name === 'BashOutput' ||
  name === 'KillShell' ||
  name === 'Monitor' ||
  /^mcp__terminal__/.test(name)

function isScript(cmd: string): boolean {
  const lines = cmd.split('\n').length
  return lines >= 6 || cmd.length > 500 || (/<<\s*['"]?\w+/.test(cmd) && lines >= 3) || /@['"]\s*\n/.test(cmd)
}

type ToolInfo = {
  name: string
  /** Category of the tool_use block (what the model wrote). */
  inCat: string
  /** Category of the tool_result (what came back). */
  outCat: string
  label: string
  bucket: string
  startedAt: number
  /** The file or page it worked on. */
  path?: string
  url?: string
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const webUrl = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : undefined)

function classifyTool(name: string, input: Row): Omit<ToolInfo, 'startedAt'> {
  const i = input ?? {}
  if (isTerminal(name)) {
    const cmd = String(i.command ?? i.cmd ?? '')
    return {
      name,
      inCat: cmd && isScript(cmd) ? 'script' : 'cmd',
      outCat: 'termout',
      label: `${name}: ${firstLine(i.description || cmd, 60)}`,
      bucket: 't_terminal',
    }
  }
  if (name === 'Read' || name === 'NotebookRead') {
    const p = i.file_path ?? i.notebook_path
    const cat = fileCat(p, false)
    return { name, inCat: cat, outCat: cat, label: `Read ${baseName(p)}`, bucket: 't_files', path: str(p) }
  }
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const p = i.file_path ?? i.notebook_path
    const cat = fileCat(p, true)
    return { name, inCat: cat, outCat: cat, label: `${name} ${baseName(p)}`, bucket: 't_files', path: str(p) }
  }
  if (name === 'Grep' || name === 'Glob' || name === 'LS') {
    return { name, inCat: 'search', outCat: 'search', label: `${name} ${firstLine(i.pattern ?? i.path, 50)}`, bucket: 't_search' }
  }
  if (isWeb(name)) {
    const what = i.url ?? i.query ?? i.text ?? i.action ?? ''
    const short = name.replace(/^mcp__[^_]+(__[^_]+)?__/, '')
    return { name, inCat: 'web', outCat: 'web', label: `${short} ${i.url ? host(i.url) : firstLine(what, 50)}`, bucket: 't_web', url: webUrl(i.url) }
  }
  if (name === 'Agent' || name === 'Task') {
    return { name, inCat: 'agents', outCat: 'agents', label: `Agent: ${firstLine(i.description ?? i.prompt, 55)}`, bucket: 't_agents' }
  }
  if (name === 'Skill') return { name, inCat: 'skills', outCat: 'skills', label: `Skill ${i.skill ?? ''}`, bucket: 't_other' }
  if (name === 'ToolSearch') return { name, inCat: 'tooling', outCat: 'tooling', label: `ToolSearch ${firstLine(i.query, 50)}`, bucket: 't_other' }
  if (WAIT_TOOLS.has(name)) return { name, inCat: 'other_tools', outCat: 'other_tools', label: name, bucket: 'approval' }
  if (name.startsWith('mcp__')) {
    const short = name.replace(/^mcp__/, '').replace(/__/g, ' › ')
    return { name, inCat: 'mcp', outCat: 'mcp', label: firstLine(short, 60), bucket: 't_mcp' }
  }
  return { name, inCat: 'other_tools', outCat: 'other_tools', label: name, bucket: 't_other' }
}

function attachmentCat(kind: string): string {
  if (kind === 'instructions' || kind === 'nested_memory' || kind === 'memory') return 'instructions'
  if (/listing|deferred_tools|mcp_instructions|agent_listing|tools_delta/.test(kind)) return 'tooling'
  if (kind === 'queued_command') return 'prompt'
  return 'reminders'
}

function renderedWeight(r: Row): number {
  const rendered = r.rendered
  if (Array.isArray(rendered)) return rendered.reduce((w: number, x: any) => w + weight(x?.content ?? x), 0)
  if (typeof rendered === 'string') return rendered.length
  return 0
}

type Item = {
  cat: string
  w: number
  label: string
  tokens: number
  reads: number
  processed: number
  cost: number
  /** Its cost by the turn whose requests carried it. */
  byTurn: Record<number, number>
  /** The turn whose request first carried it. */
  turnAdded?: number
  /** What generating it cost, where the model wrote it (a reply, a tool call's input). */
  outCost: number
  resultOf?: string
  ref?: Ref
}

type Interval = { from: number; to: number; kind: 'model' | 'tool'; bucket: string; tool?: string }

type Turn = {
  prompt: string
  startedAt: number
  lastAt: number
  requests: number
  outputTokens: number
  contextAtEnd: number
  intervals: Interval[]
  /** Timestamps of the turn's own rows. */
  marks: number[]
  cost: number
  cacheRead: number
  cacheWrite: number
  promptId?: string
}

export type ChainResult = {
  added: Record<string, number>
  processed: Record<string, number>
  output: Record<string, number>
  items: Item[]
  requests: number
  input: { uncached: number; cacheWrite: number; cacheRead: number }
  outputTotal: number
  thinking: number
  contextNow: number
  turns: Turn[]
  tools: Map<string, ToolRow>
  slow: SlowCall[]
  firstAt: number
  lastAt: number
  firstPrompt: string
  /** agentId of each Agent tool call, keyed by tool_use_id. */
  agentIds: Map<string, string>
  agentLabels: Map<string, string>
  /** Requests whose transcript usage was a stub, their output estimated. */
  estimatedOutputs: number
  inputCost: Record<string, number>
  outputCost: Record<string, number>
  points: RequestPoint[]
  breaks: CacheBreak[]
  cost: { read: number; write: number; uncached: number; output: number; rebuild: number }
  ttl: { w5: number; w1h: number }
  model: string
  /** Cost and tokens by turn and kind of content, keyed `turn|cat`. */
  turnCats: Map<string, TurnCat>
  /** Tool calls by turn and tool, keyed `turn|tool`. */
  toolTurns: Map<string, ToolTurn>
}

const add =(m: Record<string, number>, k: string, v: number) => {
  m[k] = (m[k] ?? 0) + v
}

const ts = (r: Row): number => {
  const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
  return Number.isFinite(t) ? t : NaN
}

/** A chain read so far: more rows can follow. */
export type Chain = {
  res: ChainResult
  /** Reads the next rows, in the file's order. */
  feed: (rows: Row[]) => void
  /**
   * Closes the request still streaming, as the rows' end would, so `res`
   * reads as a whole analysis of the rows so far; the function it returns
   * opens it again for the rows still to come.
   */
  settle: () => () => void
}

/**
 * Analyzes one conversation chain: the main session or one subagent. A
 * subagent has no turns of its own: `turnOf` names the main turn a moment
 * belongs to, so its requests count toward the turn that ran it.
 */
export function analyzeChain(rows: Row[], turnOf?: (at: number) => number): ChainResult {
  const c = chainOf(turnOf)
  c.feed(rows)
  c.settle()
  return c.res
}

/** A chain to feed rows to as they are written: the state stays between feeds. */
export function chainOf(turnOf?: (at: number) => number): Chain {
  const res: ChainResult = {
    added: {},
    processed: {},
    output: {},
    items: [],
    requests: 0,
    input: { uncached: 0, cacheWrite: 0, cacheRead: 0 },
    outputTotal: 0,
    thinking: 0,
    contextNow: 0,
    turns: [],
    tools: new Map(),
    slow: [],
    firstAt: NaN,
    lastAt: NaN,
    firstPrompt: '',
    agentIds: new Map(),
    agentLabels: new Map(),
    estimatedOutputs: 0,
    inputCost: {},
    outputCost: {},
    points: [],
    breaks: [],
    cost: { read: 0, write: 0, uncached: 0, output: 0, rebuild: 0 },
    ttl: { w5: 0, w1h: 0 },
    model: '',
    turnCats: new Map(),
    toolTurns: new Map(),
  }

  const turnNow = (at: number) => (turnOf ? turnOf(at) : res.turns.length)
  // a subagent's rows are not in the main transcript: nothing to scroll to
  const rowId = (id: unknown) => (turnOf ? undefined : str(id))
  const turnCat = (turn: number, cat: string): TurnCat => {
    const key = `${turn}|${cat}`
    let tc = res.turnCats.get(key)
    if (!tc) {
      tc = { turn, cat, inputCost: 0, outputCost: 0, added: 0, processed: 0, output: 0 }
      res.turnCats.set(key, tc)
    }
    return tc
  }
  const pointCat = (p: RequestPoint, cat: string) => {
    p.cats ??= {}
    return (p.cats[cat] ??= [0, 0, 0])
  }

  const toolUses = new Map<string, ToolInfo & { ref: Ref }>()
  let pending: Item[] = []
  let live: Item[] = []
  let sysItem: Item | undefined
  let prevCtx = 0
  let lastInputAt = NaN
  let prevRequestAt = NaN
  let prevModel = ''
  let compactedSince = false

  // the request whose blocks are streaming in now
  let cur:
    | {
        id: string
        startedAt: number
        endedAt: number
        output: number
        thinking: number
        blocks: { cat: string; w: number; item?: Item }[]
        price: Price
        point: RequestPoint
        turn: number
      }
    | undefined
  let turn: Turn | undefined
  // set by the turn's stop marker: activity after it, before a new prompt, is
  // a turn of its own (a background task or another agent woke the session)
  let turnEnded = false
  let wakeLabel = ''
  const startTurn = (label: string, at: number, promptId?: string) => {
    turn = {
      prompt: label,
      promptId,
      startedAt: at,
      lastAt: at,
      requests: 0,
      outputTokens: 0,
      contextAtEnd: prevCtx,
      intervals: [],
      marks: [at],
      cost: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }
    res.turns.push(turn)
    turnEnded = false
  }

  const newItem = (cat: string, w: number, label: string, resultOf?: string, ref?: Ref): Item => {
    const it: Item = { cat, w, label, tokens: 0, reads: 0, processed: 0, cost: 0, byTurn: {}, outCost: 0, resultOf, ref }
    res.items.push(it)
    return it
  }

  const closeRequest = () => {
    if (!cur) return
    const c = cur
    cur = undefined
    const nonThinking = c.blocks.filter(b => b.cat !== 'thinking')
    // subagent transcripts keep the usage of the stream's start, not its end
    const visibleEst = nonThinking.reduce((s, b) => s + b.w, 0) / CHARS_PER_TOKEN
    if (c.thinking === 0 && c.output < visibleEst * 0.5) {
      res.outputTotal += visibleEst - c.output
      if (turn) turn.outputTokens += visibleEst - c.output
      c.output = visibleEst
      res.estimatedOutputs++
    }
    let rest = Math.max(0, c.output - c.thinking)
    let thinking = c.thinking
    const hasThinkingBlock = c.blocks.some(b => b.cat === 'thinking')
    if (thinking === 0 && hasThinkingBlock) {
      // no thinking count reported: whatever the visible blocks do not explain
      const visible = nonThinking.reduce((s, b) => s + b.w, 0) / CHARS_PER_TOKEN
      thinking = Math.max(0, rest - visible)
      rest -= thinking
    }
    const perOut = c.price.output / 1e6
    const addOut = (cat: string, tokens: number) => {
      add(res.output, cat, tokens)
      add(res.outputCost, cat, tokens * perOut)
      const tc = turnCat(c.turn, cat)
      tc.output += tokens
      tc.outputCost += tokens * perOut
      pointCat(c.point, cat)[1] += tokens * perOut
    }
    addOut('thinking', thinking)
    const totalW = nonThinking.reduce((s, b) => s + b.w, 0)
    if (rest > 0) {
      if (totalW === 0) addOut('reply', rest)
      else
        for (const b of nonThinking) {
          const tokens = (rest * b.w) / totalW
          addOut(b.cat, tokens)
          if (b.item) {
            b.item.outCost += tokens * perOut
            b.item.byTurn[c.turn] = (b.item.byTurn[c.turn] ?? 0) + tokens * perOut
          }
        }
    }
    res.thinking += thinking
    const outCost = c.output * perOut
    res.cost.output += outCost
    c.point.output = c.output
    c.point.thinking = thinking
    c.point.costOutput = outCost
    if (turn) turn.cost += outCost
    if (turn && Number.isFinite(c.startedAt) && Number.isFinite(c.endedAt)) {
      turn.intervals.push({ from: c.startedAt, to: Math.max(c.startedAt, c.endedAt), kind: 'model', bucket: 'model' })
    }
  }

  const openRequest = (id: string, usage: Row, at: number, model: string) => {
    closeRequest()
    const price = priceOf(model)
    if (!res.model && model) res.model = model
    const ctx =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    res.requests++
    res.input.uncached += usage.input_tokens ?? 0
    res.input.cacheWrite += usage.cache_creation_input_tokens ?? 0
    res.input.cacheRead += usage.cache_read_input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    res.outputTotal += output

    if (!sysItem) {
      // first request: the content seen so far is estimated, the rest is the
      // system prompt and the tool definitions
      const est = pending.reduce((s, p) => s + p.w, 0) / CHARS_PER_TOKEN
      const scale = est > ctx * 0.85 && est > 0 ? (ctx * 0.85) / est : 1
      for (const p of pending) p.tokens = (p.w / CHARS_PER_TOKEN) * scale
      sysItem = newItem('sys', 0, 'System prompt & tool definitions')
      sysItem.tokens = Math.max(0, ctx - pending.reduce((s, p) => s + p.tokens, 0))
      live.push(sysItem)
    } else {
      let fresh = ctx - live.reduce((s, it) => s + it.tokens, 0)
      if (fresh < 0) {
        // the context shrank (old tool results cleared, compaction): scale
        // what is kept down to make room for what was just added
        const keepTarget = Math.max(0, ctx - pending.reduce((s, p) => s + p.w, 0) / CHARS_PER_TOKEN)
        const kept = live.reduce((s, it) => s + it.tokens, 0)
        const f = kept > 0 ? Math.min(1, keepTarget / kept) : 0
        for (const it of live) it.tokens *= f
        fresh = Math.max(0, ctx - live.reduce((s, it) => s + it.tokens, 0))
      }
      const pw = pending.reduce((s, p) => s + p.w, 0)
      if (pw > 0) for (const p of pending) p.tokens = (fresh * p.w) / pw
      else if (fresh > 0) {
        const it = newItem('other', 0, 'Unattributed context growth')
        it.tokens = fresh
        pending.push(it)
      }
    }
    const startedAt = Number.isFinite(lastInputAt) ? lastInputAt : at
    const tn = turnNow(startedAt)
    for (const p of pending) {
      add(res.added, p.cat, p.tokens)
      turnCat(tn, p.cat).added += p.tokens
      p.turnAdded = tn
    }
    if (sysItem && sysItem.reads === 0) {
      add(res.added, 'sys', sysItem.tokens)
      turnCat(tn, 'sys').added += sysItem.tokens
    }
    const isNew = new Set<Item>(pending)
    if (sysItem && sysItem.reads === 0) isNew.add(sysItem)
    live.push(...pending)
    pending = []

    // what this request's input cost, as the API bills it
    const read = usage.cache_read_input_tokens ?? 0
    const write = usage.cache_creation_input_tokens ?? 0
    const uncached = usage.input_tokens ?? 0
    const w1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const w5 = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, write - w1h)
    res.ttl.w5 += w5
    res.ttl.w1h += w1h
    const per = price.input / 1e6
    const readRate = price.read / 1e6
    const costRead = read * readRate
    const costWrite = (w5 * 1.25 + w1h * 2) * per
    const costUncached = uncached * per
    res.cost.read += costRead
    res.cost.write += costWrite
    res.cost.uncached += costUncached
    const writeRate = write > 0 ? costWrite / write : 1.25 * per

    // a cache break: most of what the last request had cached is written again
    const isBreak = !compactedSince && prevCtx > 20_000 && read < prevCtx * 0.5 && write > prevCtx * 0.5
    if (isBreak) {
      const gapMs = Number.isFinite(prevRequestAt) && Number.isFinite(startedAt) ? startedAt - prevRequestAt : 0
      const rewritten = Math.max(0, Math.min(write, prevCtx) - read)
      const reason =
        prevModel && model !== prevModel
          ? 'the model changed'
          : gapMs > 60 * 60 * 1000
            ? 'paused over an hour: the cache expired'
            : gapMs > 5 * 60 * 1000 && w1h === 0
              ? 'paused over 5 minutes: the cache expired'
              : 'the start of the prompt changed (tools, settings or instructions)'
      const extra = rewritten * (writeRate - readRate)
      res.cost.rebuild += extra
      res.breaks.push({ at: startedAt, turn: tn, tokens: rewritten, extraCost: extra, gapMs, reason })
    }
    compactedSince = false

    // share the input cost out over the content: new content was written to
    // the cache, older content read from it (or written again on a break)
    const rateOf = (it: Item) => (isNew.has(it) || isBreak ? writeRate : readRate)
    const modelled = live.reduce((s, it) => s + it.tokens * rateOf(it), 0)
    const actual = costRead + costWrite + costUncached
    const scale = modelled > 0 ? actual / modelled : 0
    const thinking = usage.output_tokens_details?.thinking_tokens ?? 0
    const point: RequestPoint = {
      at: startedAt,
      turn: tn,
      read,
      write: write + uncached,
      output,
      thinking,
      costRead,
      costWrite: costWrite + costUncached,
      costOutput: 0,
      isBreak,
    }
    // every live item, every request: the turn's entries looked up once per kind
    const tcs: Record<string, TurnCat> = {}
    for (const it of live) {
      const c = it.tokens * rateOf(it) * scale
      it.cost += c
      it.byTurn[tn] = (it.byTurn[tn] ?? 0) + c
      add(res.inputCost, it.cat, c)
      it.reads++
      it.processed += it.tokens
      add(res.processed, it.cat, it.tokens)
      const tc = (tcs[it.cat] ??= turnCat(tn, it.cat))
      tc.inputCost += c
      tc.processed += it.tokens
      const pc = pointCat(point, it.cat)
      pc[0] += c
      pc[2] += it.tokens
    }
    prevCtx = ctx
    prevModel = model
    prevRequestAt = startedAt
    res.contextNow = ctx

    res.points.push(point)
    cur = { id, startedAt, endedAt: at, output, thinking, blocks: [], price, point, turn: tn }
    if (turn) {
      turn.requests++
      turn.outputTokens += output
      turn.contextAtEnd = ctx
      turn.cost += actual
      turn.cacheRead += read
      turn.cacheWrite += write + uncached
    }
  }

  const touch = (at: number) => {
    if (!Number.isFinite(at)) return
    if (!Number.isFinite(res.firstAt) || at < res.firstAt) res.firstAt = at
    if (!Number.isFinite(res.lastAt) || at > res.lastAt) res.lastAt = at
  }
  const mark = (at: number) => {
    if (!turn || !Number.isFinite(at)) return
    turn.marks.push(at)
    if (at > turn.lastAt) turn.lastAt = at
  }

  const seen = new Set<string>()
  const feed = (rows: Row[]) => {
    for (const r of rows) {
      if (typeof r.uuid === 'string') {
        if (seen.has(r.uuid)) continue
        seen.add(r.uuid)
      }
      const at = ts(r)
      const type = r.type

      if (type === 'system') {
        if (r.subtype === 'compact_boundary') {
          closeRequest()
          for (const it of live) if (it !== sysItem) it.tokens = 0
          live = sysItem ? [sysItem] : []
          prevCtx = sysItem?.tokens ?? 0
          compactedSince = true
        }
        if (r.subtype === 'stop_hook_summary') {
          mark(at)
          turnEnded = true
        }
        continue
      }

      if (type === 'attachment') {
        const a = r.attachment ?? {}
        const kind = String(a.type ?? '')
        const w = renderedWeight(r)
        const cat = attachmentCat(kind)
        const files: { path?: unknown; content?: unknown }[] =
          cat !== 'instructions' ? [] : Array.isArray(a.files) ? a.files : typeof a.path === 'string' ? [{ path: a.path, content: a.content }] : []
        const sizes = files.map(f => Math.max(1, textLen(f.content)))
        const all = sizes.reduce((x, y) => x + y, 0)
        if (w > 0 && files.length > 0) {
          files.forEach((f, k) =>
            pending.push(newItem('instructions', (w * sizes[k]!) / all, `Instructions: ${baseName(f.path)}`, undefined, { path: str(f.path), messageId: rowId(r.uuid) })),
          )
        } else if (w > 0) pending.push(newItem(cat, w, `Reminder: ${kind}`, undefined, { messageId: rowId(r.uuid) }))
        touch(at)
        if (Number.isFinite(at)) lastInputAt = at
        continue
      }

      if (type === 'assistant') {
        const msg = r.message ?? {}
        if (msg.model === '<synthetic>') continue
        const id = String(msg.id ?? r.uuid)
        if (!cur || cur.id !== id) {
          if (turnEnded || !turn) {
            closeRequest()
            startTurn(wakeLabel || '(no prompt: woken by a background event)', Number.isFinite(lastInputAt) ? lastInputAt : at)
          }
          openRequest(id, msg.usage ?? {}, at, String(msg.model ?? ''))
        }
        if (cur && Number.isFinite(at)) cur.endedAt = Math.max(cur.endedAt, at)
        touch(at)
        mark(at)
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            const w = textLen(b.thinking)
            cur?.blocks.push({ cat: 'thinking', w })
            if (w > 0) pending.push(newItem('thinking', w, 'Thinking'))
          } else if (b.type === 'text') {
            const w = textLen(b.text)
            const item = newItem('reply', w, `Reply: ${firstLine(b.text, 55)}`, undefined, { messageId: rowId(r.uuid) })
            cur?.blocks.push({ cat: 'reply', w, item })
            pending.push(item)
          } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            const tool = classifyTool(String(b.name), b.input)
            const info = { ...tool, startedAt: at, ref: { path: tool.path, url: tool.url, toolUseId: rowId(b.id) } }
            toolUses.set(b.id, info)
            const w = JSON.stringify(b.input ?? {}).length + String(b.name).length
            const item = newItem(info.inCat, w, info.label, undefined, info.ref)
            cur?.blocks.push({ cat: info.inCat, w, item })
            pending.push(item)
            if (info.name === 'Agent' || info.name === 'Task') res.agentLabels.set(b.id, info.label)
          }
        }
        continue
      }

      if (type === 'user') {
        const msg = r.message ?? {}
        const content = msg.content
        const blocks: any[] = Array.isArray(content) ? content : []
        const results = blocks.filter(b => b?.type === 'tool_result')
        touch(at)

        if (results.length > 0) {
          mark(at)
          for (const b of results) {
            const info = toolUses.get(b.tool_use_id)
            const w = weight(b.content)
            const cat = info?.outCat ?? 'other_tools'
            pending.push(newItem(cat, w, info ? `${info.label} → result` : 'Tool result', info?.name, info?.ref ?? { toolUseId: rowId(b.tool_use_id) }))
            if (info && Number.isFinite(info.startedAt) && Number.isFinite(at)) {
              const ms = Math.max(0, at - info.startedAt)
              const src = String(r.permissionDecision?.source ?? '')
              const bucket = /user|prompt|dialog/i.test(src) ? 'approval' : info.bucket
              turn?.intervals.push({ from: info.startedAt, to: info.startedAt + ms, kind: 'tool', bucket, tool: info.name })
              const row = res.tools.get(info.name) ?? { tool: info.name, calls: 0, ms: 0, resultTokens: 0 }
              row.calls++
              row.ms += ms
              res.tools.set(info.name, row)
              const tn = turnNow(info.startedAt)
              res.slow.push({ label: info.label, ms, bucket, turn: tn, toolUseId: info.ref.toolUseId })
              const key = `${tn}|${info.name}`
              const tt = res.toolTurns.get(key) ?? { turn: tn, tool: info.name, calls: 0, ms: 0, resultTokens: 0 }
              tt.calls++
              tt.ms += ms
              res.toolTurns.set(key, tt)
            }
            const agentId = r.toolUseResult?.agentId
            if (typeof agentId === 'string') res.agentIds.set(b.tool_use_id, agentId)
          }
          const extra = blocks.filter(b => b?.type !== 'tool_result')
          const ew = weight(extra)
          if (ew > 0) pending.push(newItem('reminders', ew, 'Note beside a tool result'))
          if (Number.isFinite(at)) lastInputAt = at
          continue
        }

        const w = weight(content)
        const text = typeof content === 'string' ? content : blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n')
        if (r.isCompactSummary) {
          pending.push(newItem('compaction', w, 'Compaction summary'))
        } else if (r.isMeta) {
          const isSkill = /^Base directory for this skill/.test(text)
          if (turnEnded) wakeLabel = `(woken) ${firstLine(text.replace(/<[^>]+>/g, ' '), 70)}`
          const ref = { messageId: rowId(r.uuid), path: isSkill && skillDir(text) ? `${skillDir(text)}/SKILL.md` : undefined }
          pending.push(newItem(isSkill ? 'skills' : 'reminders', w, isSkill ? `Skill: ${skillName(text)}` : `Meta: ${firstLine(text, 50)}`, undefined, ref))
        } else {
          closeRequest()
          const isNotification = /^<task-notification>/.test(text.trim())
          const label = isNotification ? 'Background task notification' : firstLine(text.replace(/<[^>]+>/g, ' '), 80)
          pending.push(newItem(isNotification ? 'reminders' : 'prompt', w, `Prompt: ${label}`, undefined, { messageId: rowId(r.uuid) }))
          if (!res.firstPrompt) res.firstPrompt = label
          if (!isNotification || !turn || turnEnded) startTurn(isNotification ? `(woken) ${label}` : label, at, rowId(r.uuid))
          wakeLabel = ''
        }
        if (Number.isFinite(at)) lastInputAt = at
        continue
      }
    }
  }

  const settle = () => {
    const c = cur
    if (!c) return () => {}
    // what closing changes, to put back: few objects, as it touches only
    // this request's blocks, its turn and its point
    const point = c.point
    const closed: RequestPoint = { ...point }
    if (point.cats) closed.cats = Object.fromEntries(Object.entries(point.cats).map(([k, v]) => [k, [...v] as [number, number, number]]))
    const t = turn
    const before = {
      output: c.output,
      outputTotal: res.outputTotal,
      estimatedOutputs: res.estimatedOutputs,
      thinking: res.thinking,
      costOutput: res.cost.output,
      outputs: { ...res.output },
      outputCosts: { ...res.outputCost },
      turn: t && { outputTokens: t.outputTokens, cost: t.cost, intervals: t.intervals.length },
    }
    const keys = [...new Set(['thinking', 'reply', ...c.blocks.map(b => b.cat)])].map(cat => `${c.turn}|${cat}`)
    const turnCats = keys.map(key => [key, res.turnCats.get(key)] as const).map(([key, tc]) => [key, tc && { ...tc }] as const)
    const items = c.blocks.flatMap(b => (b.item ? [[b.item, b.item.outCost, b.item.byTurn[c.turn]] as const] : []))
    // the report may keep the closed point: closing writes into a copy
    const last = res.points.length - 1
    res.points[last] = closed
    c.point = closed
    closeRequest()
    return () => {
      cur = c
      c.point = point
      res.points[last] = point
      c.output = before.output
      res.outputTotal = before.outputTotal
      res.estimatedOutputs = before.estimatedOutputs
      res.thinking = before.thinking
      res.cost.output = before.costOutput
      res.output = before.outputs
      res.outputCost = before.outputCosts
      for (const [key, tc] of turnCats) {
        if (tc) Object.assign(res.turnCats.get(key)!, tc)
        else res.turnCats.delete(key)
      }
      for (const [it, outCost, byTurn] of items) {
        it.outCost = outCost
        if (byTurn === undefined) delete it.byTurn[c.turn]
        else it.byTurn[c.turn] = byTurn
      }
      if (t && before.turn) {
        t.outputTokens = before.turn.outputTokens
        t.cost = before.turn.cost
        t.intervals.length = before.turn.intervals
      }
    }
  }

  return { res, feed, settle }
}

/** Splits a turn's wall time into buckets: model > tool > overhead. */
function turnTime(t: Turn): Record<string, number> {
  const out: Record<string, number> = {}
  if (!Number.isFinite(t.startedAt) || !Number.isFinite(t.lastAt)) return out
  const points = new Set<number>([t.startedAt, t.lastAt])
  for (const at of t.marks) points.add(Math.max(t.startedAt, Math.min(t.lastAt, at)))
  for (const iv of t.intervals) {
    points.add(Math.max(t.startedAt, Math.min(t.lastAt, iv.from)))
    points.add(Math.max(t.startedAt, Math.min(t.lastAt, iv.to)))
  }
  const sorted = [...points].sort((a, b) => a - b)
  for (let k = 0; k + 1 < sorted.length; k++) {
    const a = sorted[k]!
    const b = sorted[k + 1]!
    const len = b - a
    if (len <= 0) continue
    const mid = (a + b) / 2
    const active = t.intervals.filter(iv => iv.from <= mid && iv.to >= mid)
    const tools = active.filter(iv => iv.kind === 'tool')
    if (tools.length === 0 && len >= STALL_MS) {
      add(out, 'stalled', len)
      continue
    }
    if (active.some(iv => iv.kind === 'model')) {
      add(out, 'model', len)
      continue
    }
    if (tools.length === 0) {
      add(out, 'overhead', len)
      continue
    }
    for (const iv of tools) add(out, iv.bucket, len / tools.length)
  }
  return out
}

const cmpDesc = <T>(f: (x: T) => number) => (a: T, b: T) => f(b) - f(a)

/** The main turn running at a moment: a subagent's moment belongs to it. */
export function turnAt(turns: { startedAt: number }[], at: number): number {
  let k = 0
  for (let i = 0; i < turns.length; i++) if (turns[i]!.startedAt <= at) k = i + 1
  return k
}

export function buildReport(
  sessionId: string,
  file: string,
  main: Row[],
  subagents: { id: string; rows: Row[] }[],
  now: number,
): UsageReport {
  const m = analyzeChain(main.filter(r => r.isSidechain !== true))
  const subs = subagents.map(s => ({ id: s.id, r: analyzeChain(s.rows, at => turnAt(m.turns, at)) }))
  return reportOf(sessionId, file, m, subs, now)
}

/** The report of chains read to their end (or settled). It shares no object the chains change later. */
export function reportOf(sessionId: string, file: string, m: ChainResult, subs: { id: string; r: ChainResult }[], now: number): UsageReport {
  const turnOf = (at: number) => turnAt(m.turns, at)
  const all = [m, ...subs.map(s => s.r)]

  const cats: CatRow[] = Object.entries(CATS)
    .map(([id, meta]) => ({
      id,
      label: meta.label,
      color: meta.color,
      added: all.reduce((s, c) => s + (c.added[id] ?? 0), 0),
      processed: all.reduce((s, c) => s + (c.processed[id] ?? 0), 0),
      output: all.reduce((s, c) => s + (c.output[id] ?? 0), 0),
      inputCost: all.reduce((s, c) => s + (c.inputCost[id] ?? 0), 0),
      outputCost: all.reduce((s, c) => s + (c.outputCost[id] ?? 0), 0),
    }))
    .filter(c => c.added + c.processed + c.output >= 0.5)

  const sum = (f: (c: ChainResult) => number) => all.reduce((s, c) => s + f(c), 0)
  const cost = {
    read: sum(c => c.cost.read),
    write: sum(c => c.cost.write),
    uncached: sum(c => c.cost.uncached),
    output: sum(c => c.cost.output),
    rebuild: sum(c => c.cost.rebuild),
    total: sum(c => c.cost.read + c.cost.write + c.cost.uncached + c.cost.output),
    noCache: sum(
      c =>
        ((c.input.uncached + c.input.cacheWrite + c.input.cacheRead) * priceOf(c.model).input) / 1e6 +
        c.cost.output,
    ),
  }

  // time, from the main chain (subagents run inside its Agent tool calls)
  const time: Record<string, number> = {}
  const turnRows: TurnRow[] = []
  m.turns.forEach((t, k) => {
    const tt = turnTime(t)
    for (const [key, ms] of Object.entries(tt)) add(time, key, ms)
    const next = m.turns[k + 1]
    if (next && Number.isFinite(next.startedAt) && Number.isFinite(t.lastAt)) {
      add(time, 'idle', Math.max(0, next.startedAt - t.lastAt))
    }
    const toolMs = Object.entries(tt)
      .filter(([key]) => key.startsWith('t_'))
      .reduce((s, [, ms]) => s + ms, 0)
    turnRows.push({
      turn: k + 1,
      buckets: tt,
      prompt: t.prompt,
      startedAt: t.startedAt,
      activeMs: Math.max(0, t.lastAt - t.startedAt),
      modelMs: tt.model ?? 0,
      toolMs,
      waitMs: tt.approval ?? 0,
      requests: t.requests,
      outputTokens: t.outputTokens,
      contextAtEnd: t.contextAtEnd,
      cost: t.cost,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      promptId: t.promptId,
    })
  })
  const timeRows: TimeRow[] = Object.entries(BUCKETS)
    .map(([id, meta]) => ({ id, label: meta.label, color: meta.color, ms: time[id] ?? 0 }))
    .filter(r => r.ms > 0)

  // model time shared out by what it generated (main chain)
  const modelMs = time.model ?? 0
  const mOut = Object.values(m.output).reduce((s, v) => s + v, 0)
  const modelByCat: TimeRow[] =
    mOut > 0
      ? Object.entries(m.output)
          .map(([id, out]) => ({ id, label: CATS[id]?.label ?? id, color: CATS[id]?.color ?? '#888', ms: (modelMs * out) / mOut }))
          .filter(r => r.ms >= 500)
          .sort(cmpDesc(r => r.ms))
      : []

  const toolMap = new Map<string, ToolRow>()
  for (const c of all) {
    for (const row of c.tools.values()) {
      const t = toolMap.get(row.tool) ?? { tool: row.tool, calls: 0, ms: 0, resultTokens: 0 }
      t.calls += row.calls
      t.ms += row.ms
      toolMap.set(row.tool, t)
    }
  }
  for (const c of all) {
    for (const it of c.items) {
      const row = it.resultOf === undefined ? undefined : toolMap.get(it.resultOf)
      if (row) row.resultTokens += it.tokens
    }
  }

  // per turn and kind of content, every chain together
  const turnCatMap = new Map<string, TurnCat>()
  for (const c of all) {
    for (const [key, v] of c.turnCats) {
      const t = turnCatMap.get(key) ?? { turn: v.turn, cat: v.cat, inputCost: 0, outputCost: 0, added: 0, processed: 0, output: 0 }
      t.inputCost += v.inputCost
      t.outputCost += v.outputCost
      t.added += v.added
      t.processed += v.processed
      t.output += v.output
      turnCatMap.set(key, t)
    }
  }
  const toolTurnMap = new Map<string, ToolTurn>()
  for (const c of all) {
    for (const [key, v] of c.toolTurns) {
      const t = toolTurnMap.get(key) ?? { turn: v.turn, tool: v.tool, calls: 0, ms: 0, resultTokens: 0 }
      t.calls += v.calls
      t.ms += v.ms
      toolTurnMap.set(key, t)
    }
    for (const it of c.items) {
      const t = it.resultOf === undefined ? undefined : toolTurnMap.get(`${it.turnAdded ?? 0}|${it.resultOf}`)
      if (t) t.resultTokens += it.tokens
    }
  }
  const groups = groupItems(all.flatMap(c => c.items), [...turnCatMap.values()])

  const top: TopItem[] = all
    .flatMap(c => c.items)
    .filter(it => it.cat !== 'sys' || it.processed > 0)
    .sort(cmpDesc(it => it.cost))
    .slice(0, 25)
    .map(it => ({ label: it.label, cat: it.cat, tokens: it.tokens, reads: it.reads, processed: it.processed, cost: it.cost }))

  const labelByAgent = new Map<string, string>()
  for (const [useId, agentId] of m.agentIds) {
    const label = m.agentLabels.get(useId)
    if (label) labelByAgent.set(agentId, label)
  }
  const agents: AgentRow[] = subs
    .map(s => ({
      label: labelByAgent.get(s.id) ?? (s.r.firstPrompt ? `Agent: ${firstLine(s.r.firstPrompt, 55)}` : `Agent ${s.id}`),
      requests: s.r.requests,
      inputTokens: s.r.input.uncached + s.r.input.cacheWrite + s.r.input.cacheRead,
      outputTokens: s.r.outputTotal,
      ms: Number.isFinite(s.r.firstAt) && Number.isFinite(s.r.lastAt) ? s.r.lastAt - s.r.firstAt : 0,
      cost: s.r.cost.read + s.r.cost.write + s.r.cost.uncached + s.r.cost.output,
      turn: Number.isFinite(s.r.firstAt) ? turnOf(s.r.firstAt) : 0,
    }))
    .sort(cmpDesc(a => a.cost))

  const notes: string[] = []
  const estimated = all.reduce((s, c) => s + c.estimatedOutputs, 0)
  if (estimated > 0) {
    notes.push(`${estimated} requests (mostly subagents) stored only a stub output count; their output is estimated from the text they wrote, without thinking.`)
  }
  if ((time.stalled ?? 0) > 0) {
    notes.push('Stalled = 10+ minutes inside a turn with no tool running and no row written (the PC slept, the network dropped, or a request hung).')
  }
  if (all.some(c => c.thinking > 0 && c.items.every(it => it.cat !== 'thinking' || it.w === 0))) {
    notes.push('Thinking text is not stored in the transcript; its output tokens are exact (reported by the API), its context share is folded into the next request.')
  }

  return {
    sessionId,
    file,
    generatedAt: now,
    firstAt: Number.isFinite(m.firstAt) ? m.firstAt : now,
    lastAt: Number.isFinite(m.lastAt) ? m.lastAt : now,
    requests: all.reduce((s, c) => s + c.requests, 0),
    turns: m.turns.length,
    input: {
      uncached: all.reduce((s, c) => s + c.input.uncached, 0),
      cacheWrite: all.reduce((s, c) => s + c.input.cacheWrite, 0),
      cacheRead: all.reduce((s, c) => s + c.input.cacheRead, 0),
    },
    output: {
      total: all.reduce((s, c) => s + c.outputTotal, 0),
      thinking: all.reduce((s, c) => s + c.thinking, 0),
    },
    contextNow: m.contextNow,
    price: priceOf(m.model),
    cost,
    ttl: { w5: sum(c => c.ttl.w5), w1h: sum(c => c.ttl.w1h) },
    // the chain goes on adding to its own list
    series: m.points.slice(),
    breaks: all.flatMap(c => c.breaks).sort((a, b) => a.at - b.at),
    cats,
    time: timeRows,
    modelByCat,
    tools: [...toolMap.values()].sort(cmpDesc(t => t.ms)),
    slowest: all
      .flatMap(c => c.slow)
      .sort(cmpDesc(s => s.ms))
      .slice(0, 80),
    turnRows,
    turnCats: [...turnCatMap.values()],
    toolTurns: [...toolTurnMap.values()],
    groups,
    top,
    agents,
    notes,
  }
}

/** The name an item is listed under in its kind's details: a file, a skill, a command. */
function groupLabel(it: Item): string {
  const l = it.label.replace(/ → result$/, '')
  if (it.cat === 'skills') return l.replace(/^Skill:? /, '')
  if (/^(code|doc)_(read|write)$/.test(it.cat)) return l.replace(/^(Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead) /, '')
  if (it.cat === 'reminders' || it.cat === 'tooling' || it.cat === 'instructions') return l.replace(/^(Reminder|Meta|Instructions): /, '').replace(/^(Read|Write|Edit|MultiEdit) /, '')
  if (it.cat === 'scratch') return l.replace(/^(Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead) /, '')
  if (it.cat === 'prompt') return l.replace(/^Prompt: /, '')
  if (it.cat === 'reply') return `Replies in turn ${it.turnAdded ?? 0}`
  return l
}

/** `a`'s fields, those it lacks from `b`; undefined when neither says anything. */
function mergeRef(a: Ref | undefined, b: Ref): Ref | undefined {
  const out: Ref = { ...a }
  for (const k of ['path', 'url', 'toolUseId', 'messageId'] as const) out[k] ??= b[k]
  for (const k of Object.keys(out) as (keyof Ref)[]) if (out[k] === undefined) delete out[k]
  return Object.keys(out).length > 0 ? out : undefined
}

/** Whether `a` already has every field `b` says: merging `b` would change nothing. */
const refCovers = (a: Ref | undefined, b: Ref) =>
  (b.path === undefined || a?.path !== undefined) &&
  (b.url === undefined || a?.url !== undefined) &&
  (b.toolUseId === undefined || a?.toolUseId !== undefined) &&
  (b.messageId === undefined || a?.messageId !== undefined)

/** Items summed by kind and name, the most expensive 40 of each kind kept. */
function groupItems(items: Item[], turnCats: TurnCat[]): Group[] {
  const byKey = new Map<string, Group>()
  const groupOf: Group[] = []
  for (const it of items) {
    const label = groupLabel(it)
    const key = `${it.cat}|${label}`
    let g = byKey.get(key)
    if (!g) {
      g = { cat: it.cat, label, cost: 0, tokens: 0, count: 0, byTurn: {} }
      byKey.set(key, g)
    }
    g.cost += it.cost + it.outCost
    g.tokens += it.tokens
    g.count++
    groupOf.push(g)
  }
  // thinking leaves no item behind (its text is not kept): one entry per turn
  for (const t of turnCats) {
    if (t.cat !== 'thinking' || t.inputCost + t.outputCost <= 0) continue
    byKey.set(`thinking|${t.turn}`, {
      cat: 'thinking',
      label: `Thinking in turn ${t.turn}`,
      cost: t.inputCost + t.outputCost,
      tokens: t.output,
      count: 1,
      byTurn: { [t.turn]: t.inputCost + t.outputCost },
    })
  }
  const kept: Group[] = []
  const byCat = new Map<string, Group[]>()
  for (const g of byKey.values()) {
    const list = byCat.get(g.cat)
    if (list) list.push(g)
    else byCat.set(g.cat, [g])
  }
  for (const list of byCat.values()) kept.push(...list.sort(cmpDesc(g => g.cost)).slice(0, 40))
  // the turns and the link only of the entries kept: a long session has thousands
  const isKept = new Set(kept)
  items.forEach((it, k) => {
    const g = groupOf[k]!
    if (!isKept.has(g)) return
    const byTurn: Record<string, number> = it.byTurn
    for (const turn in byTurn) g.byTurn[turn] = (g.byTurn[turn] ?? 0) + byTurn[turn]!
    // a link already whole stays as it is
    if (it.ref && !refCovers(g.ref, it.ref)) g.ref = mergeRef(g.ref, it.ref)
  })
  return kept
}

export function parseJsonl(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s))
    } catch {
      // a line cut mid-write: skip it
    }
  }
  return rows
}
