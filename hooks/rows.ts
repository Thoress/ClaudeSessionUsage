// The pane's rows, apart from how a surface draws them: a label, a bar of
// segments, a value, a tooltip, whether it is picked, and what a click does.
// The desktop draws a row as a Button and a small Svg bar, the terminal as a
// Button and a text bar; what the rows are, and what they lead to, is here.

import type { Filter, Group, LimitWindow, Measure, Preview, UsageReport } from '../types'
import { CATS } from './analyze'
import { readAgo, turnCosts } from './charts'
import { type View, applyFilter } from './filter'
import { cut, dur, money, pct, tok } from './format'
import { PREVIEW_LINES, leadHint, leadOf } from './leads'
import { activeMsOf, memoize } from './reports'

export type Row = {
  key: string
  label: string
  segs: { v: number; cls: string }[]
  value: string
  title: string
  isSelected?: boolean
  isDimmed?: boolean
  onPress?: () => void
}

/** What a row's click does: filter to a turn or a kind, or lead to an entry. */
export type RowActions = {
  onlyTurn: (turn: number) => void
  onlyCat: (cat: string) => void
  goTo: (g: Group) => Promise<unknown>
}

export const CONTENT_INFO =
  'Content sent once keeps being re-sent with every later request, so a big file read or command output early on costs again and again (as cheap cache reads). Output is charged once, at the highest rate. The growth of the context between two requests is exact; it is shared out over the content added in between by character count, so the split per kind is a close estimate. Click a row to filter everything to that kind and see what it was made of.'

/** Turns the Overview lists; the Timeline tab lists them all. */
export const OVERVIEW_TURNS = 12

export const rowTotal = (x: Row) => x.segs.reduce((s, sg) => s + sg.v, 0)

/**
 * The rows to pick from stay whole: kinds of content under the picked
 * turns, turns under the picked kinds; the picked ones are highlighted.
 */
export function pickLists(raw: UsageReport, filter: Filter, base: string) {
  const byCats = memoize(`${base}|byCats`, () => applyFilter(raw, { turns: filter.turns, cats: [] }))
  const byTurns = memoize(`${base}|byTurns`, () => applyFilter(raw, { turns: [], cats: filter.cats }))
  return { byCats, byTurns }
}

/** Kinds of content that cost anything, the costliest first. */
export const costlyCats = (r: UsageReport) => r.cats.filter(c => c.inputCost + c.outputCost > 0.0005)

export function contentRows(byCats: UsageReport, v: View, act: RowActions, limit: number): Row[] {
  const totalCost = byCats.cost.total
  return [...costlyCats(byCats)]
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
        onPress: () => act.onlyCat(c.id),
      }
    })
}

export function turnRows(byTurns: UsageReport, v: View, act: RowActions): Row[] {
  return turnCosts(byTurns).map(({ t, read, write, out }) => {
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
      onPress: () => act.onlyTurn(t.turn),
    }
  })
}

export function turnTimeRows(raw: UsageReport, v: View, act: RowActions): Row[] {
  return raw.turnRows.map(t => {
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
      onPress: () => act.onlyTurn(t.turn),
    }
  })
}

/** A details entry's row: its cost, and a click that leads to it. */
export function entryRow(g: Group, prefix: string, act: RowActions, withKind = false): Row {
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
    onPress: lead === 'none' ? undefined : () => void act.goTo(g),
  }
}

/** The slowest single calls, each leading to the call and what came back. */
export function slowestRows(r: UsageReport, act: RowActions, n = 15): Row[] {
  return r.slowest.slice(0, n).map((s, k) => {
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
      onPress: lead === 'none' ? undefined : () => void act.goTo(g),
    }
  })
}

/** Active time by activity, the longest first; nothing to click. */
export function timeRows(r: UsageReport, limit = 30): Row[] {
  const list = r.time.filter(t => t.id !== 'idle').sort((a, b) => b.ms - a.ms)
  const active = activeMsOf(r)
  return list.slice(0, limit).map(t => ({
    key: `time-${t.id}`,
    label: t.label,
    segs: [{ v: t.ms, cls: 'read' }],
    value: `${dur(t.ms)} · ${pct(t.ms, active)}`,
    title: `${t.label}\nTime: ${dur(t.ms)}\nShare of the active time: ${pct(t.ms, active)}`,
  }))
}

/** The `n` rows that cost the most, kept in their order. */
export function costliest(list: Row[], n: number): Row[] {
  if (list.length <= n) return list
  const keep = new Set([...list].sort((a, b) => rowTotal(b) - rowTotal(a)).slice(0, n))
  return list.filter(x => keep.has(x) || x.isSelected)
}

export const costLegend = (v: View): [string, string][] =>
  v.isContent
    ? [
        ['read', 'As context'],
        ['out', 'Output'],
      ]
    : [
        ['read', 'Cache reads'],
        ['write', 'Cache writes'],
        ['out', 'Output'],
      ]

export const CONTENT_LEGEND: [string, string][] = [
  ['read', 'Sent as context (input)'],
  ['out', 'Written by Claude (output)'],
]

export const TIME_LEGEND: [string, string][] = [
  ['read', 'Claude'],
  ['write', 'Tools'],
  ['out', 'Waiting for you'],
  ['other', 'Other'],
]

// ---------- the filter's dropdowns ----------

export const turnOptions = (raw: UsageReport, v: View) => [
  { value: 'all', label: 'Add a turn…' },
  ...raw.turnRows.filter(t => !v.turns.has(t.turn)).map(t => ({ value: String(t.turn), label: `${t.turn}. ${cut(t.prompt, 48)}` })),
]

export const catOptions = (raw: UsageReport, v: View) => [
  { value: 'all', label: 'Add a kind of content…' },
  ...raw.cats
    .filter(c => !v.cats.has(c.id) && c.inputCost + c.outputCost > 0.0005)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(c => ({ value: c.id, label: c.label })),
]

// ---------- the headline figures, for surfaces without the tiles' picture ----------

export type Tile = { label: string; value: string; sub: string }

/** The Overview's tiles as text: what the desktop's picture shows, line by line. */
export function headlineTiles(r: UsageReport, measure: Measure | undefined): Tile[] {
  const pending =
    measure?.state === 'error'
      ? `couldn't measure: ${measure.error ?? 'unknown error'}`
      : measure?.state === 'measuring'
        ? `measuring${measure.files ? ` ${measure.files} files` : ''}…`
        : 'measuring…'
  const live = r.live
  const inputAll = r.input.cacheRead + r.input.cacheWrite + r.input.uncached
  const idle = r.time.find(t => t.id === 'idle')?.ms ?? 0
  const resets = (iso?: string) => {
    const at = iso ? Date.parse(iso) : NaN
    return Number.isFinite(at) ? `resets in ${dur(Math.max(0, at - r.generatedAt)).replace(/ 00[ms]$/, '')}` : ''
  }
  // this session's part of the limit first, the whole account's use after it
  const limit = (label: string, l: LimitWindow | undefined): Tile => {
    if (!l) return { label, value: '–', sub: live ? 'shows after the next reply' : 'running session only' }
    const hasShare = l.session !== undefined
    const mine = Math.min(l.session ?? 0, l.percentUsed)
    const asOf = readAgo(l, r.generatedAt)
    return {
      label: `${label}: this session`,
      value: hasShare ? `${mine < 10 ? mine.toFixed(1) : Math.round(mine)}%` : '…',
      sub: asOf ? `${Math.round(l.percentUsed)}% in all · ${asOf}` : `${Math.round(l.percentUsed)}% used in all · ${hasShare ? resets(l.resetsAt) : pending}`,
    }
  }
  const contextTokens = live?.contextTokens ?? r.contextNow
  const contextPct = live ? (live.contextPercent ?? (100 * contextTokens) / Math.max(1, live.contextWindow)) : undefined
  return [
    { label: 'Cost (API prices)', value: money(r.cost.total), sub: `${money(r.cost.noCache)} without caching` },
    { label: 'Input tokens sent', value: tok(inputAll), sub: `${pct(r.input.cacheRead, inputAll)} from the cache` },
    { label: 'Active time', value: dur(activeMsOf(r)), sub: `+ ${dur(idle)} waiting for you` },
    {
      label: 'Context used',
      value: contextPct === undefined ? tok(contextTokens) : `${Math.round(contextPct)}%`,
      sub: live ? `${tok(contextTokens)} of ${tok(live.contextWindow)}` : 'window unknown here',
    },
    limit('Weekly limit', live?.limits.find(l => l.kind === 'seven_day')),
    limit('5-hour limit', live?.limits.find(l => l.kind === 'five_hour')),
  ]
}

/** A preview's first lines, shown inline, and how many more its full view has. */
export function previewHead(p: Preview | null): { head: string; rest: number } {
  const lines = p ? p.source.split('\n') : []
  return { head: lines.slice(0, PREVIEW_LINES).join('\n'), rest: Math.max(0, lines.length - PREVIEW_LINES) }
}
