import type { UsageReport } from '../types'

// ---------- formatting ----------

export function tok(n: number): string {
  const v = Math.round(n)
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`
  return `${(v / 1_000_000).toFixed(2)}M`
}

export function dur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Dollars, with as many decimals as a small amount needs. */
export function money(v: number): string {
  if (v <= 0) return '$0'
  if (v >= 100) return `$${Math.round(v)}`
  if (v >= 0.01) return `$${v.toFixed(2)}`
  if (v >= 0.001) return `$${v.toFixed(3)}`
  return '<$0.001'
}

export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : '–')

const perM = (v: number) => `$${v < 1 ? v.toFixed(2) : v.toFixed(v % 1 === 0 ? 0 : 2)}`

/** Plain-language account of what caching did to this session's cost, as Markdown. */
export function cachingStory(r: UsageReport): string {
  const p = r.price
  const inputAll = r.input.cacheRead + r.input.cacheWrite + r.input.uncached
  const writes = r.ttl.w5 + r.ttl.w1h
  const mostly1h = r.ttl.w1h >= r.ttl.w5
  const ttlText =
    writes === 0
      ? ''
      : mostly1h
        ? `at ${perM(p.input * 2)}/M (2× input, for the 1-hour lifetime Claude Code asked for here)`
        : `at ${perM(p.input * 1.25)}/M (1.25× input, 5-minute lifetime)`
  const lines = [
    `**Why caching matters so much.** Every request re-sends the whole conversation so far: the system prompt, every file, every command output. The API keeps that prefix in a cache, so only the part that is new since the last request is **written** ${ttlText}; everything already seen is **read from the cache** at ${perM(p.read)}/M instead of ${perM(p.input)}/M.`,
    '',
    `Here, **${pct(r.input.cacheRead, inputAll)} of the ${tok(inputAll)} input tokens were cache reads**, yet they make up only **${pct(r.cost.read, r.cost.total)} of the cost**. New input made up ${pct(r.input.cacheWrite + r.input.uncached, inputAll)} of the tokens but ${pct(r.cost.write + r.cost.uncached, r.cost.total)} of the cost, and output ${pct(r.output.total, inputAll + r.output.total)} of the tokens but ${pct(r.cost.output, r.cost.total)} (output costs ${perM(p.output)}/M). Without caching, the same session would have cost **${money(r.cost.noCache)} instead of ${money(r.cost.total)}**.`,
  ]
  if (r.breaks.length > 0) {
    const extra = r.breaks.reduce((s, b) => s + b.extraCost, 0)
    lines.push(
      '',
      `**Cache rebuilt ${r.breaks.length}×**, costing ${money(extra)} extra: ` +
        r.breaks.map(b => `turn ${b.turn}, ${tok(b.tokens)} tokens written again (${b.reason})`).join('; ') +
        '. A pause longer than the cache lifetime, or a change to the tools or settings, makes the next request write the whole context again.',
    )
  }
  lines.push(
    '',
    `_Amounts are API list-price equivalents (${p.isKnown ? p.model : 'unknown model, priced as Claude Opus 5.5'}). On a subscription nothing is billed per token; the $ figures weigh reads, writes and output the way the API does, which makes the parts comparable._`,
  )
  return lines.join('\n')
}

export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)

export const bar = (frac: number, width: number) => '█'.repeat(Math.max(frac > 0 ? 1 : 0, Math.round(Math.min(1, frac) * width)))

// ---------- markdown tables (the export and the desktop pane share them) ----------

const cell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ')

export function mdCostTable(r: UsageReport): string {
  const inputAll = r.input.cacheRead + r.input.cacheWrite + r.input.uncached
  const all = inputAll + r.output.total
  const rows: [string, number, number][] = [
    ['Read from the cache', r.input.cacheRead, r.cost.read],
    ['New input written to the cache', r.input.cacheWrite, r.cost.write],
    ['Input never cached', r.input.uncached, r.cost.uncached],
    ['Output (incl. thinking)', r.output.total, r.cost.output],
  ]
  return [
    '| | tokens | share of tokens | cost | share of cost |',
    '|---|---:|---:|---:|---:|',
    ...rows.map(([l, t, c]) => `| ${l} | ${tok(t)} | ${pct(t, all)} | ${money(c)} | ${pct(c, r.cost.total)} |`),
    `| **Total** | **${tok(all)}** | | **${money(r.cost.total)}** | |`,
    `| Same tokens without caching | | | ${money(r.cost.noCache)} | |`,
  ].join('\n')
}

export function mdCategoryTable(r: UsageReport): string {
  const inputAll = r.input.cacheRead + r.input.cacheWrite + r.input.uncached
  const rows = [...r.cats].sort((a, b) => b.inputCost + b.outputCost - (a.inputCost + a.outputCost))
  return [
    '| Content | added to context | sent in total | output | cost | share |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows.map(
      c =>
        `| ${c.label} | ${tok(c.added)} | ${tok(c.processed)} (${pct(c.processed, inputAll)}) | ${tok(c.output)} | ${money(c.inputCost + c.outputCost)} | ${pct(c.inputCost + c.outputCost, r.cost.total)} |`,
    ),
  ].join('\n')
}

export function mdTurnTable(r: UsageReport): string {
  return [
    '| # | prompt | active | requests | cache reads | new input | output | context at end | cost |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---:|',
    ...r.turnRows.map(
      (t, k) =>
        `| ${k + 1} | ${cell(cut(t.prompt, 60))} | ${dur(t.activeMs)} | ${t.requests} | ${tok(t.cacheRead)} | ${tok(t.cacheWrite)} | ${tok(t.outputTokens)} | ${tok(t.contextAtEnd)} | ${money(t.cost)} |`,
    ),
  ].join('\n')
}

export function mdToolTable(r: UsageReport): string {
  return [
    '| Tool | calls | total time | average | result tokens |',
    '|---|---:|---:|---:|---:|',
    ...r.tools.map(t => `| ${cell(t.tool)} | ${t.calls} | ${dur(t.ms)} | ${dur(t.ms / Math.max(1, t.calls))} | ${tok(t.resultTokens)} |`),
  ].join('\n')
}

export function mdSlowTable(r: UsageReport, n = 10): string {
  return ['| call | time |', '|---|---:|', ...r.slowest.slice(0, n).map(s => `| ${cell(s.label)} | ${dur(s.ms)} |`)].join('\n')
}

export function mdItemTable(r: UsageReport): string {
  return [
    '| item | tokens | sent with | in total | cost |',
    '|---|---:|---:|---:|---:|',
    ...r.top.map(t => `| ${cell(t.label)} | ${tok(t.tokens)} | ${t.reads} requests | ${tok(t.processed)} | ${money(t.cost)} |`),
  ].join('\n')
}

export function mdAgentTable(r: UsageReport): string {
  return [
    '| subagent | requests | input sent | output | time | cost |',
    '|---|---:|---:|---:|---:|---:|',
    ...r.agents.map(a => `| ${cell(a.label)} | ${a.requests} | ${tok(a.inputTokens)} | ${tok(a.outputTokens)} | ${dur(a.ms)} | ${money(a.cost)} |`),
  ].join('\n')
}

// ---------- markdown export ----------

export function toMarkdown(r: UsageReport): string {
  const active = r.time.filter(t => t.id !== 'idle').reduce((s, t) => s + t.ms, 0)
  const L: string[] = []
  L.push(`# Session usage: ${r.sessionId}`, '')
  L.push(`${new Date(r.firstAt).toISOString()} → ${new Date(r.lastAt).toISOString()} · ${r.turns} turns · ${r.requests} model requests · context now ${tok(r.contextNow)}`, '')
  L.push('## Tokens and cost', '', mdCostTable(r), '', cachingStory(r), '')
  L.push('## Turns', '', mdTurnTable(r), '')
  L.push('## By content', '', mdCategoryTable(r), '')
  L.push('## Time', '', '| Activity | time | share of active |', '|---|---:|---:|')
  for (const t of r.time) L.push(`| ${t.label} | ${dur(t.ms)} | ${t.id === 'idle' ? '–' : pct(t.ms, active)} |`)
  L.push('', '### Tools', '', mdToolTable(r), '', '### Slowest calls', '', mdSlowTable(r, 15), '')
  L.push('## Most expensive single items', '', mdItemTable(r), '')
  if (r.agents.length > 0) L.push('## Subagents', '', mdAgentTable(r), '')
  if (r.notes.length > 0) L.push('## Notes', '', ...r.notes.map(n => `- ${n}`), '')
  L.push(
    '_"Added" is what a piece of content cost when it first entered the context; "sent in total" sums it over every later request that re-sent it (mostly cache reads). The growth of the context between requests is shared out by character count, so per-content figures are estimates; the totals are the API\'s own._',
    '',
  )
  return L.join('\n')
}


/** The caching account as plain paragraphs, for a tooltip card. */
export function cachingText(r: UsageReport): string[] {
  return cachingStory(r)
    .split('\n')
    .filter(Boolean)
    .map(l => l.replace(/\*\*/g, '').replace(/^_|_$/g, ''))
}
