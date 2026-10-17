// The pane's filter: some turns and/or some kinds of content. A filtered view
// has the report's shape, so every chart draws it unchanged; `View` tells the
// charts what was picked, to highlight it and to word their legends.

import type { CatRow, Filter, Group, TopItem, UsageReport } from '../types'
import { BUCKETS, CATS } from './analyze'

export type View = {
  isFiltered: boolean
  /** Kinds of content are picked: costs are "as context" and "as output", not cache reads and writes. */
  isContent: boolean
  turns: Set<number>
  cats: Set<string>
}

export const NO_FILTER: Filter = { turns: [], cats: [] }

const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0)

export function viewOf(f: Filter): View {
  return {
    isFiltered: f.turns.length > 0 || f.cats.length > 0,
    isContent: f.cats.length > 0,
    turns: new Set(f.turns),
    cats: new Set(f.cats),
  }
}

/** The cost of a details entry within the picked turns. */
export const groupCost = (g: Group, v: View) =>
  v.turns.size === 0 ? g.cost : Object.entries(g.byTurn).reduce((s, [t, c]) => s + (v.turns.has(Number(t)) ? c : 0), 0)

/** One kind of content's details: what it was made of, the most expensive first. */
export function detailsOf(r: UsageReport, cat: string, v: View, limit = 15): Group[] {
  return r.groups
    .filter(g => g.cat === cat)
    .map(g => ({ ...g, cost: groupCost(g, v) }))
    .filter(g => g.cost > 0.00005)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, limit)
}

/** The report as the filter sees it. */
export function applyFilter(r: UsageReport, f: Filter): UsageReport {
  const v = viewOf(f)
  if (!v.isFiltered) return { ...r, top: topOf(r, v) }
  const inT = (turn: number) => v.turns.size === 0 || v.turns.has(turn)
  const inC = (cat: string) => v.cats.size === 0 || v.cats.has(cat)
  const tc = r.turnCats.filter(t => inT(t.turn) && inC(t.cat))

  const catMap = new Map<string, CatRow>()
  for (const t of tc) {
    const c = catMap.get(t.cat) ?? {
      id: t.cat,
      label: CATS[t.cat]?.label ?? t.cat,
      color: CATS[t.cat]?.color ?? '#888',
      added: 0,
      processed: 0,
      output: 0,
      inputCost: 0,
      outputCost: 0,
    }
    c.added += t.added
    c.processed += t.processed
    c.output += t.output
    c.inputCost += t.inputCost
    c.outputCost += t.outputCost
    catMap.set(t.cat, c)
  }
  const cats = [...catMap.values()]
  const inputCost = sum(cats, c => c.inputCost)
  const outputCost = sum(cats, c => c.outputCost)

  // requests of the picked turns; with kinds picked, only what those kinds cost
  const series = r.series
    .filter(p => inT(p.turn))
    .map(p => {
      if (!v.isContent) return p
      const picked = Object.entries(p.cats ?? {}).filter(([cat]) => v.cats.has(cat))
      const costOutput = sum(picked, ([, c]) => c[1])
      return {
        ...p,
        read: sum(picked, ([, c]) => c[2]),
        write: 0,
        output: Math.round((costOutput * 1e6) / Math.max(1e-9, r.price.output)),
        thinking: 0,
        costRead: sum(picked, ([, c]) => c[0]),
        costWrite: 0,
        costOutput,
        cats: Object.fromEntries(picked),
      }
    })

  // input cost split into cache reads and writes as the main conversation's
  // requests split it; subagents (in `inputCost`) are scaled in
  let read: number
  let write: number
  if (v.isContent) {
    read = inputCost
    write = 0
  } else {
    const readS = sum(series, p => p.costRead)
    const writeS = sum(series, p => p.costWrite)
    const k = readS + writeS > 0 ? inputCost / (readS + writeS) : 0
    read = readS * k
    write = writeS * k
  }
  const total = inputCost + outputCost
  const turnRows = r.turnRows.map(t =>
    v.isContent ? { ...t, cost: sum(tc.filter(x => x.turn === t.turn), x => x.inputCost + x.outputCost) } : t,
  )

  const picked = r.turnRows.filter(t => inT(t.turn))
  const time =
    v.turns.size === 0
      ? r.time
      : Object.entries(BUCKETS)
          .map(([id, meta]) => ({ id, label: meta.label, color: meta.color, ms: sum(picked, t => t.buckets[id] ?? 0) }))
          .filter(t => t.ms > 0)

  const toolMap = new Map<string, { tool: string; calls: number; ms: number; resultTokens: number }>()
  for (const t of r.toolTurns.filter(x => inT(x.turn))) {
    const row = toolMap.get(t.tool) ?? { tool: t.tool, calls: 0, ms: 0, resultTokens: 0 }
    row.calls += t.calls
    row.ms += t.ms
    row.resultTokens += t.resultTokens
    toolMap.set(t.tool, row)
  }

  return {
    ...r,
    turns: v.turns.size || r.turns,
    requests: series.length,
    input: v.isContent
      ? { uncached: 0, cacheWrite: 0, cacheRead: sum(cats, c => c.processed) }
      : { uncached: 0, cacheWrite: sum(series, p => p.write), cacheRead: sum(series, p => p.read) },
    output: { total: sum(cats, c => c.output), thinking: sum(cats.filter(c => c.id === 'thinking'), c => c.output) },
    cost: {
      read,
      write,
      uncached: 0,
      output: outputCost,
      total,
      noCache: r.cost.total > 0 ? (r.cost.noCache * total) / r.cost.total : 0,
      rebuild: sum(r.breaks.filter(b => inT(b.turn)), b => b.extraCost),
    },
    series,
    breaks: r.breaks.filter(b => inT(b.turn)),
    cats,
    time,
    tools: [...toolMap.values()].sort((a, b) => b.ms - a.ms),
    slowest: r.slowest.filter(s => inT(s.turn)),
    turnRows,
    top: topOf(r, v),
    agents: r.agents.filter(a => inT(a.turn)),
  }
}

/** The most expensive details entries of any kind, within the filter. */
function topOf(r: UsageReport, v: View): TopItem[] {
  return r.groups
    .filter(g => v.cats.size === 0 || v.cats.has(g.cat))
    .map(g => ({ label: g.label, cat: g.cat, tokens: g.tokens, reads: g.count, processed: 0, cost: groupCost(g, v) }))
    .filter(g => g.cost > 0.00005)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 25)
}
