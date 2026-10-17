export type CatRow = {
  id: string
  label: string
  color: string
  /** Tokens this content put into the context (the first time it was sent). */
  added: number
  /** Tokens of it the model processed, summed over every request it was re-sent in. */
  processed: number
  /** Output tokens the model generated in this category. */
  output: number
  /** API-price equivalent of this content as input: first write plus every re-read. */
  inputCost: number
  /** API-price equivalent of the output generated in this category. */
  outputCost: number
}

/** $ per million tokens. */
export type Price = { model: string; isKnown: boolean; input: number; output: number; read: number }

/** One model request of the main conversation. */
export type RequestPoint = {
  at: number
  /** 1-based turn the request belongs to (0 before the first prompt). */
  turn: number
  /** Input tokens served from the cache. */
  read: number
  /** Input tokens written to the cache, plus the few never cached. */
  write: number
  output: number
  thinking: number
  costRead: number
  costWrite: number
  costOutput: number
  /** Most of the previously cached context had to be written again. */
  isBreak: boolean
  /** By kind of content: [input cost, output cost, tokens of it in the context]. */
  cats?: Record<string, [number, number, number]>
}

export type CacheBreak = {
  at: number
  turn: number
  /** Tokens that were cached before and had to be written again. */
  tokens: number
  /** What re-writing them cost over reading them from the cache. */
  extraCost: number
  gapMs: number
  reason: string
}

export type Cost = {
  read: number
  write: number
  uncached: number
  output: number
  total: number
  /** The same tokens with no caching at all: every input token at the base price. */
  noCache: number
  /** Extra paid because the cache had to be rebuilt (part of write). */
  rebuild: number
}

export type TimeRow = { id: string; label: string; color: string; ms: number }

export type ToolRow = {
  tool: string
  calls: number
  ms: number
  resultTokens: number
}

export type SlowCall = { label: string; ms: number; bucket: string; turn: number }

export type TurnRow = {
  /** 1-based. */
  turn: number
  prompt: string
  startedAt: number
  activeMs: number
  modelMs: number
  toolMs: number
  waitMs: number
  /** Active time by activity (BUCKETS ids). */
  buckets: Record<string, number>
  requests: number
  outputTokens: number
  contextAtEnd: number
  cost: number
  cacheRead: number
  cacheWrite: number
  /** The transcript row of the turn's prompt, to scroll to. */
  promptId?: string
}

/** One turn's cost and tokens for one kind of content, subagents included. */
export type TurnCat = {
  turn: number
  cat: string
  inputCost: number
  outputCost: number
  added: number
  processed: number
  output: number
}

/** One tool's calls within one turn. */
export type ToolTurn = { turn: number; tool: string; calls: number; ms: number; resultTokens: number }

/**
 * Where an entry of the details leads: its file, its web page, or its row in
 * the transcript (a tool call's id, a message's uuid). Subagents' rows are not
 * in the main transcript: their entries carry no ids.
 */
export type Ref = { path?: string; url?: string; toolUseId?: string; messageId?: string }

/** One entry of a kind of content's details: a file, a skill, a command, all its pieces summed. */
export type Group = {
  cat: string
  label: string
  cost: number
  tokens: number
  /** Pieces summed into it (reads of the same file, calls of the same command). */
  count: number
  /** Its cost by turn. */
  byTurn: Record<string, number>
  /** Where it leads, from its first piece that says. */
  ref?: Ref
}

export type TopItem = {
  label: string
  cat: string
  tokens: number
  reads: number
  processed: number
  cost: number
}

export type AgentRow = {
  label: string
  requests: number
  inputTokens: number
  outputTokens: number
  ms: number
  cost: number
  /** The main turn that started it. */
  turn: number
}

export type LimitWindow = {
  kind: string
  /** How full the window is for the whole account, as the API reports it. */
  percentUsed: number
  resetsAt?: string
  /** This session's part of it, in percentage points of the limit. */
  session?: number
  /** This session's cost inside the window. */
  sessionUsd?: number
  /** Every local Claude Code session's cost inside the window. */
  totalUsd?: number
  /** Local sessions that used the window. */
  sessions?: number
}

/** What only the running session can tell: the live context and the rate limits. */
export type LiveUsage = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: LimitWindow[]
}

export type UsageReport = {
  /** Present when the report is about the running session. */
  live?: LiveUsage
  sessionId: string
  file: string
  generatedAt: number
  firstAt: number
  lastAt: number
  requests: number
  turns: number
  /** Billed input of all requests, split the way the API bills it. */
  input: { uncached: number; cacheWrite: number; cacheRead: number }
  output: { total: number; thinking: number }
  contextNow: number
  price: Price
  cost: Cost
  /** Cache writes by lifetime: 5 minutes (1.25x input) or 1 hour (2x input). */
  ttl: { w5: number; w1h: number }
  /** The main conversation's requests in order. */
  series: RequestPoint[]
  breaks: CacheBreak[]
  cats: CatRow[]
  time: TimeRow[]
  modelByCat: TimeRow[]
  tools: ToolRow[]
  slowest: SlowCall[]
  turnRows: TurnRow[]
  turnCats: TurnCat[]
  toolTurns: ToolTurn[]
  groups: Group[]
  top: TopItem[]
  agents: AgentRow[]
  notes: string[]
}

/** What the pane shows: the turns and kinds of content picked; empty means all. */
export type Filter = { turns: number[]; cats: string[] }

/** Something the pane shows in full: a file, a script, its output, a skill, a message. */
export type Preview = {
  title: string
  source: string
  /** A highlighter language id; absent, inferred from `path`. */
  language?: string
  path?: string
  /** Drawn as markdown (a skill, a prompt, a reply) rather than as code. */
  isMarkdown?: boolean
  /** A dim line under the title: a command's description, a cut. */
  note?: string
}

/** The background measurement of the limits' shares. */
export type Measure = { state: 'idle' | 'measuring' | 'error'; files?: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-insights': {
      report: UsageReport | null
      /** The running session's own report, for the footer, whatever the pane shows. */
      current: UsageReport | null
      tab: string
      status: string
      filter: Filter
      measure: Measure
      /** Whether the footer's popover is open. */
      popover: boolean
      /** What a details entry's click put on show in the pane. */
      preview: Preview | null
    }
  }
}
