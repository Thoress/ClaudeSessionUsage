// SVG charts for the surfaces that draw them (desktop, VS Code, mobile).
//
// Each chart is one self-contained SVG: its title, an (i) icon whose card
// explains it, the marks, and a styled tooltip card per mark, shown with CSS
// :hover inside the Svg element's frame (no script). Colour: the reference
// palette's first three categorical slots, validated all-pairs for colour-
// vision deficiency in light and dark: blue = served from the cache, aqua =
// new input written to the cache, orange = output. Text always wears the text
// tokens, never a series colour.

import type { LimitWindow, Measure, RequestPoint, UsageReport } from '../types'
import { CATS } from './analyze'
import { cachingText, dur, money, pct, tok } from './format'

let W = 720

/** Sizes the charts to the space the pane gives them, in CSS pixels. */
export function setChartWidth(px: number) {
  W = Math.round(Math.max(420, Math.min(1000, px)))
}

/** The CSS-pixel size an SVG from this module declares. */
export function svgSize(source: string): { width: number; height: number } {
  const m = /width="(\d+)" height="(\d+(?:\.\d+)?)"/.exec(source)
  return { width: Number(m?.[1] ?? W), height: Math.ceil(Number(m?.[2] ?? 200)) }
}

const MAX_SOURCE = 131_072
const MAX_COLUMNS = 80

// pictures, not text: the arrow cursor, nothing to select
const NO_SELECT = 'svg,text{cursor:default;user-select:none;-webkit-user-select:none}'

const STYLE = `<style>${NO_SELECT}
text{font-size:14px}.f12{font-size:12px}.f13{font-size:13px}.f16{font-size:16px}.f30{font-size:30px}.b{font-weight:600}.e{text-anchor:end}.m{text-anchor:middle}
.t{fill:#0b0b0b}.t2{fill:#52514e}.t3{fill:#7a7975}.grid{stroke:#e9e8e4}.base{stroke:#c9c8c3}.turnl{stroke:#b5b4ae}
.read{fill:#2a78d6}.write{fill:#1baf7a}.out{fill:#eb6834}.other{fill:#c9c8c3}.crit{fill:#d03b3b}.line{stroke:#2a78d6;fill:none}
.tile{fill:#f4f3f0}.zebra{fill:#f6f5f2}.track{fill:#e2e1dc}
.hit{fill:transparent;cursor:default}.hit:hover{fill:rgba(127,127,127,.12)}
.ic{fill:none;stroke:#8f8e88}.ict{fill:#8f8e88}.icon:hover .ic{stroke:#2a78d6}.icon:hover .ict{fill:#2a78d6}

@media (prefers-color-scheme: dark){
.t{fill:#ffffff}.t2{fill:#c3c2b7}.t3{fill:#9a9990}.grid{stroke:#2f2f2c}.base{stroke:#55544f}.turnl{stroke:#5a5954}
.read{fill:#3987e5}.write{fill:#199e70}.out{fill:#d95926}.other{fill:#55544f}.line{stroke:#3987e5}
.tile{fill:#242422}.zebra{fill:#20201e}.track{fill:#3a3a37}
.ic{stroke:#8f8e88}.ict{fill:#8f8e88}.icon:hover .ic{stroke:#3987e5}.icon:hover .ict{fill:#3987e5}}
</style>`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n1 = (v: number) => (Math.round(v * 10) / 10).toString()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0)

/** `cls` holds colour, size, weight and anchor classes: 't2 f13 b e'. */
const text = (x: number, y: number, s: string, cls = 't') => `<text x="${n1(x)}" y="${n1(y)}" class="${cls}">${esc(s)}</text>`

/** A bar with rounded data ends (4px), square where it meets a neighbour or the baseline. */
function rect(x: number, y: number, w: number, h: number, cls: string, round: 'none' | 'top' | 'right' | 'all' = 'none') {
  if (w <= 0.2 || h <= 0.2) return ''
  const r = Math.min(4, w / 2, h / 2)
  if (round === 'none' || r < 1) return `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" class="${cls}"/>`
  if (round === 'all') return `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${n1(r)}" class="${cls}"/>`
  const [x0, y0, x1, y1] = [x, y, x + w, y + h].map(n1)
  const d =
    round === 'top'
      ? `M${x0},${y1}V${n1(y + r)}Q${x0},${y0} ${n1(x + r)},${y0}H${n1(x + w - r)}Q${x1},${y0} ${x1},${n1(y + r)}V${y1}Z`
      : `M${x0},${y0}H${n1(x + w - r)}Q${x1},${y0} ${x1},${n1(y + r)}V${n1(y + h - r)}Q${x1},${y1} ${n1(x + w - r)},${y1}H${x0}Z`
  return `<path d="${d}" class="${cls}"/>`
}

/** Splits text into lines of at most `max` characters, at spaces; `\n` starts a new paragraph. */
export function wrap(s: string, max: number): string[] {
  const out: string[] = []
  s.split('\n').forEach((para, k) => {
    if (k > 0) out.push('')
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > max) {
        out.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    out.push(line)
  })
  return out
}

// ---------- tooltips and the (i) icon ----------
//
// Every hover in the mod shows the same thing: the system's tooltip, from an
// SVG <title>. A card drawn inside the SVG could not leave a small picture's
// frame (the (i) beside a heading, a row's bar), so it is used nowhere.

type TipLine = { swatch?: string; label: string; value?: string }
type Tip = { title: string; lines?: TipLine[]; text?: string }
/** Where a card would go; kept so callers read the same. */
type Anchor = { x: number; top: number; bottom: number; place: 'side' | 'row' }

/** `as of 12m ago` for a limit read earlier by another session; undefined for this session's own reading. */
export const readAgo = (l: LimitWindow, now: number) =>
  l.readAt === undefined ? undefined : `as of ${dur(Math.max(60_000, now - l.readAt)).replace(/ 00[ms]$/, '')} ago`

/**
 * About how wide `s` draws in px at `size`, semibold system-ui: a width per
 * character class, close enough to set an icon after a title.
 */
function textWidth(s: string, size: number): number {
  let em = 0
  for (const ch of s) {
    if (/[ilj.,:;'|!]/.test(ch)) em += 0.26
    else if (/[ frt()\-/]/.test(ch)) em += 0.36
    else if (/[mwMW]/.test(ch)) em += 0.86
    else if (/[A-Z]/.test(ch)) em += 0.64
    else if (/[0-9]/.test(ch)) em += 0.56
    else em += 0.54
  }
  return em * size
}

const tipText = (t: Tip) =>
  [t.title, t.text, ...(t.lines ?? []).map(l => (l.value ? `${l.label}: ${l.value}` : l.label))].filter(Boolean).join('\n')

/** The (i) icon at (x, y), its top left, 18px square; hovering it shows `info`. */
const infoMark = (x: number, y: number, info: string) =>
  `<g class="icon"><title>${esc(info)}</title><rect x="${n1(x)}" y="${n1(y)}" width="18" height="18" fill="transparent"/>` +
  `<circle cx="${n1(x + 9)}" cy="${n1(y + 9)}" r="7" class="ic" stroke-width="1.4"/>` +
  // the size as a style: a chart's stylesheet sizes every text, and beats an attribute
  `<text x="${n1(x + 9)}" y="${n1(y + 13)}" text-anchor="middle" style="font-size:11px;font-weight:700" class="ict">i</text></g>`

class Canvas {
  private parts: string[] = []
  private next = 0

  add(s: string) {
    this.parts.push(s)
  }

  /** A transparent target that shows `tip` while the pointer is on it. */
  hover(x: number, y: number, w: number, h: number, tip: Tip, _at: Anchor) {
    const id = this.next++
    this.parts.push(
      `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(Math.max(1, w))}" height="${n1(Math.max(1, h))}" class="hit h${id}"><title>${esc(tipText(tip))}</title></rect>`,
    )
  }

  /** A chart title, with the (i) icon after it whose tooltip holds `info`. */
  title(s: string, info?: string, y = 18) {
    this.add(text(0, y, s, 't f16 b'))
    // after the title's estimated width, the gap a native heading leaves before its (i)
    if (info) this.add(infoMark(textWidth(s, 16) + 7, y - 14, `${s}\n\n${info}`))
  }

  /** A dim line under the chart. */
  footer(y: number, s: string) {
    this.add(text(0, y, s, 't3 f13'))
  }

  legend(y: number, items: [string, string][], x0 = 0) {
    let x = x0
    for (const [cls, label] of items) {
      this.add(rect(x, y - 11, 12, 12, cls, 'all') + text(x + 18, y, label, 't2 f13'))
      x += 18 + label.length * 7.2 + 22
    }
  }

  /** The whole SVG. */
  finish(height: number): string {
    const H = Math.ceil(height)
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">` +
      STYLE +
      this.parts.join('') +
      `</svg>`
    )
  }
}

/** Nice round axis maximum. */
function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(step => m <= step) ?? 10) * p
}

const fmtTime = (ms: number) => new Date(ms).toISOString().slice(11, 16)

// ---------- overview ----------

/** The four headline tiles and the tokens-vs-cost bars, one picture. */
export function overviewTop(r: UsageReport, opts: { isContent?: boolean; measure?: Measure } = {}): string {
  const pending =
    opts.measure?.state === 'error'
      ? `couldn't measure: ${opts.measure.error ?? 'unknown error'}`
      : opts.measure?.state === 'measuring'
        ? `measuring${opts.measure.files ? ` ${opts.measure.files} files` : ''}…`
        : 'measuring…'
  const c = new Canvas()
  const inputAll = r.input.cacheRead + r.input.cacheWrite + r.input.uncached
  const active = sum(r.time.filter(t => t.id !== 'idle'), t => t.ms)
  const idle = r.time.find(t => t.id === 'idle')?.ms ?? 0
  const p = r.price
  const live = r.live
  const week = live?.limits.find(l => l.kind === 'seven_day')
  const five = live?.limits.find(l => l.kind === 'five_hour')
  const resets = (iso?: string) => {
    const at = iso ? Date.parse(iso) : NaN
    return Number.isFinite(at) ? `resets in ${dur(Math.max(0, at - r.generatedAt)).replace(/ 00[ms]$/, '')}` : ''
  }

  type Tile = { label: string; value: string; sub: string; tip: Tip; bar?: { used: number; mine?: number } }

  // headline: this session's part of the limit; the bar: the whole account's
  // use in grey, this session's in blue
  const limitTile = (label: string, name: string, l: LimitWindow | undefined): Tile => {
    if (!l) {
      return {
        label,
        value: '–',
        sub: live ? 'shows after the next reply' : 'running session only',
        tip: {
          title: `Your ${name} usage limit`,
          text: live
            ? 'The API reports the limits with each reply, on a subscription. No session has had a reply in this window yet; the figure shows after the next one.'
            : 'The limits are known only to a running session; this report is about an earlier one.',
        },
      }
    }
    const hasShare = l.session !== undefined
    const mine = Math.min(l.session ?? 0, l.percentUsed)
    const asOf = readAgo(l, r.generatedAt)
    return {
      label: `${label}: this session`,
      value: hasShare ? `${mine < 10 ? mine.toFixed(1) : Math.round(mine)}%` : '…',
      sub: asOf ? `${Math.round(l.percentUsed)}% in all · ${asOf}` : `${Math.round(l.percentUsed)}% used in all · ${hasShare ? resets(l.resetsAt) : pending}`,
      bar: { used: l.percentUsed, mine: hasShare ? mine : undefined },
      tip: {
        title: `Your ${name} usage limit`,
        text:
          `How much of the limit is used is exact: the API reports it for your whole account (all sessions, all devices), never per session. ` +
          `This session's part is that figure split by cost: this session's requests inside the window, against every Claude Code session on this computer inside the same window, all priced at API list prices. ` +
          `Usage elsewhere (claude.ai, other devices) is not in the local transcripts and makes this session's part read high.`,
        lines: [
          { swatch: 'read', label: 'This session', value: hasShare ? `≈ ${mine.toFixed(1)}% · ${money(l.sessionUsd ?? 0)}` : pending },
          { swatch: 'other', label: `Everything else${l.sessions ? ` (${Math.max(0, l.sessions - 1)} other sessions)` : ''}`, value: hasShare ? `≈ ${(l.percentUsed - mine).toFixed(1)}% · ${money(Math.max(0, (l.totalUsd ?? 0) - (l.sessionUsd ?? 0)))}` : '' },
          { label: 'Used in all', value: `${l.percentUsed.toFixed(1)}%` },
          ...(l.resetsAt ? [{ label: 'Window', value: resets(l.resetsAt) }] : []),
        ],
      },
    }
  }
  const contextTokens = live?.contextTokens ?? r.contextNow
  const contextPct = live ? (live.contextPercent ?? (100 * contextTokens) / Math.max(1, live.contextWindow)) : undefined
  const tiles: Tile[] = [
    {
      label: 'Cost (API prices)',
      value: money(r.cost.total),
      sub: `${money(r.cost.noCache)} without caching`,
      tip: {
        title: 'What this session would cost on the API',
        text: `At ${p.isKnown ? p.model : 'Claude Opus 5.5'} list prices: input $${p.input}/M, output $${p.output}/M, cache reads $${p.read}/M, cache writes $${p.input * 1.25}/M (5-minute) or $${p.input * 2}/M (1-hour). On a subscription nothing is billed per token; the figure weighs the parts the way the API does.`,
        lines: [
          { swatch: 'read', label: 'Cache reads', value: money(r.cost.read) },
          { swatch: 'write', label: 'Cache writes', value: money(r.cost.write + r.cost.uncached) },
          { swatch: 'out', label: 'Output', value: money(r.cost.output) },
          { label: 'Without caching it would be', value: money(r.cost.noCache) },
          { label: 'Caching saved', value: pct(r.cost.noCache - r.cost.total, r.cost.noCache) },
        ],
      },
    },
    {
      label: 'Input tokens sent',
      value: tok(inputAll),
      sub: `${pct(r.input.cacheRead, inputAll)} from the cache`,
      tip: {
        title: 'Input, summed over all requests',
        text: 'Every request sends the whole conversation again, so the same content is counted once per request.',
        lines: [
          { swatch: 'read', label: 'Read from the cache', value: tok(r.input.cacheRead) },
          { swatch: 'write', label: 'New, written to the cache', value: tok(r.input.cacheWrite + r.input.uncached) },
          { swatch: 'out', label: 'Output (incl. thinking)', value: tok(r.output.total) },
          { label: 'of it thinking', value: tok(r.output.thinking) },
        ],
      },
    },
    {
      label: 'Active time',
      value: dur(active),
      sub: `+ ${dur(idle)} waiting for you`,
      tip: {
        title: 'Time the session was working',
        lines: [
          { label: 'Active', value: dur(active) },
          { label: 'Idle between turns', value: dur(idle) },
          { label: 'Turns', value: String(r.turns) },
          { label: 'Model requests', value: String(r.requests) },
        ],
      },
    },
    {
      label: 'Context used',
      value: contextPct === undefined ? tok(contextTokens) : `${Math.round(contextPct)}%`,
      sub: live ? `${tok(contextTokens)} of ${tok(live.contextWindow)}` : 'window unknown here',
      bar: contextPct === undefined ? undefined : { used: contextPct },
      tip: {
        title: 'How full the context window is',
        text: 'The conversation as the last request sent it, against the model’s context window. Near the limit Claude Code compacts the conversation: it replaces it with a summary.',
        lines: [
          { label: 'Context now', value: `${tok(contextTokens)} tokens` },
          ...(live ? [{ label: 'Context window', value: `${tok(live.contextWindow)} tokens` }] : []),
          ...(contextPct !== undefined ? [{ label: 'Used', value: `${contextPct.toFixed(1)}%` }] : []),
        ],
      },
    },
    limitTile('Weekly limit', 'weekly (7-day)', week),
    limitTile('5-hour limit', '5-hour', five),
  ]
  const gap = 12
  const perRow = W >= 640 ? 3 : 2
  const tw = (W - gap * (perRow - 1)) / perRow
  const th = 104
  tiles.forEach((tile, k) => {
    const x = (k % perRow) * (tw + gap)
    const y = Math.floor(k / perRow) * (th + gap)
    c.add(`<rect x="${n1(x)}" y="${y}" width="${n1(tw)}" height="${th}" rx="10" class="tile"/>`)
    c.add(text(x + 16, y + 27, tile.label, 't2'))
    c.add(text(x + 16, y + 60, tile.value, 't f30 b'))
    if (tile.bar) {
      const bw = tw - 32
      const used = Math.max(0, Math.min(100, tile.bar.used)) / 100
      const mine = Math.max(0, Math.min(used, (tile.bar.mine ?? 0) / 100))
      const isHigh = tile.bar.used >= 90
      c.add(rect(x + 16, y + 70, bw, 6, 'track', 'all'))
      if (tile.bar.mine !== undefined) {
        c.add(rect(x + 16, y + 70, bw * (used - mine), 6, isHigh ? 'crit' : 'other', 'none'))
        c.add(rect(x + 16 + bw * (used - mine), y + 70, Math.max(2, bw * mine), 6, 'read', 'none'))
      } else c.add(rect(x + 16, y + 70, Math.max(2, bw * used), 6, isHigh ? 'crit' : 'read', 'none'))
    }
    c.add(text(x + 16, y + 94, cut(tile.sub, Math.floor((tw - 24) / 6.8)), 't3 f13'))
    c.hover(x, y, tw, th, tile.tip, { x: x + 8, top: y, bottom: y + th, place: 'row' })
  })
  const y0 = (th + gap) * Math.ceil(tiles.length / perRow) + 26

  // the same session counted in tokens and in money
  c.title('Tokens vs. cost', cachingText(r).join('\n') + (r.notes.length ? '\n' + r.notes.join('\n') : ''), y0)
  c.legend(
    y0 + 28,
    opts.isContent
      ? [
          ['read', 'Sent as context (input)'],
          ['out', 'Output'],
        ]
      : [
          ['read', 'Read from the cache'],
          ['write', 'New input (cache writes)'],
          ['out', 'Output'],
        ],
  )
  const labelW = 84
  const bw = W - labelW
  const names = opts.isContent ? ['Sent as context (input)', '', 'Output'] : ['Read from the cache', 'New input, written to the cache', 'Output']
  const cls = ['read', 'write', 'out']
  const rows: [string, number[], (v: number) => string][] = [
    ['Tokens', [r.input.cacheRead, r.input.cacheWrite + r.input.uncached, r.output.total], tok],
    ['Cost', [r.cost.read, r.cost.write + r.cost.uncached, r.cost.output], money],
  ]
  rows.forEach(([label, vals, fmt], i) => {
    const y = y0 + 42 + i * 42
    const total = vals.reduce((s, v) => s + v, 0) || 1
    c.add(text(0, y + 21, label, 't b'))
    let x = labelW
    vals.forEach((v, k) => {
      const w = (v / total) * bw
      const isLast = k === vals.length - 1
      const seg = Math.max(0, w - (isLast ? 0 : 2))
      c.add(rect(x, y, seg, 30, cls[k]!, isLast ? 'right' : 'none'))
      if (seg > 100) c.add(text(x + 10, y + 20, `${pct(v, total)} · ${fmt(v)}`, 't'))
      x += w
    })
    c.hover(
      labelW,
      y,
      bw,
      30,
      {
        title: label === 'Tokens' ? 'Where the tokens went' : 'Where the money went',
        lines: vals
          .map((v, k) => ({ swatch: cls[k], label: names[k]!, value: `${fmt(v)} · ${pct(v, total)}` }))
          .filter(l => l.label !== ''),
      },
      { x: labelW, top: y, bottom: y + 30, place: 'row' },
    )
  })
  return c.finish(y0 + 42 + 2 * 42)
}

// ---------- row charts ----------

type Seg = { v: number; cls: string }
type RowSpec = { label: string; segs: Seg[]; value: string; tip: Tip }

/** Horizontal bars, one row each, the value at the bar's end. */
function rowChart(title: string, info: string | undefined, legendItems: [string, string][] | undefined, rows: RowSpec[], share: number, valueW: number, footer?: string): string {
  const c = new Canvas()
  c.title(title, info)
  let y0 = 34
  if (legendItems) {
    c.legend(y0 + 12, legendItems)
    y0 += 26
  }
  if (rows.length === 0) {
    c.add(text(0, y0 + 16, 'Nothing yet.', 't3'))
    return c.finish(y0 + 24)
  }
  const labelW = Math.round(Math.max(150, Math.min(380, W * share)))
  const chars = Math.floor(labelW / 7.4)
  const bw = W - labelW - valueW
  const max = Math.max(1e-12, ...rows.map(row => sum(row.segs, s => s.v)))
  const rowH = 30
  rows.forEach((row, k) => {
    const y = y0 + k * rowH
    c.add(text(0, y + 19, cut(row.label, chars), 't'))
    const last = row.segs.map(s => s.v > 0).lastIndexOf(true)
    let x = labelW
    row.segs.forEach((s, i) => {
      const w = (s.v / max) * bw
      c.add(rect(x, y + 7, Math.max(0, w - (i < last && w > 3 ? 2 : 0)), 16, s.cls, i === last ? 'right' : 'none'))
      x += w
    })
    c.add(text(x + 8, y + 19, row.value, 't2 f13'))
    c.hover(0, y, W, rowH, row.tip, { x: Math.min(x + 8, W - 200), top: y, bottom: y + rowH, place: 'row' })
  })
  if (footer) c.footer(y0 + rows.length * rowH + 20, footer)
  return c.finish(y0 + rows.length * rowH + (footer ? 28 : 4))
}

/** Active time by activity. */
export function timeChart(r: UsageReport, limit = 30, title = 'Where the time went', footer?: string): string {
  const list = r.time.filter(t => t.id !== 'idle').sort((a, b) => b.ms - a.ms)
  const active = sum(list, t => t.ms)
  const idle = r.time.find(t => t.id === 'idle')?.ms ?? 0
  const rows = list.slice(0, limit).map(t => ({
    label: t.label,
    segs: [{ v: t.ms, cls: 'read' }],
    value: `${dur(t.ms)} · ${pct(t.ms, active)}`,
    tip: { title: t.label, lines: [{ label: 'Time', value: dur(t.ms) }, { label: 'Share of the active time', value: pct(t.ms, active) }] },
  }))
  return rowChart(
    title,
    `${dur(active)} active, plus ${dur(idle)} idle between turns while the session waited for your next prompt. Model time runs from a request's input to its last streamed block; tool time from the call to its result. Where they overlap, time counts once, model first. Waiting for your approval includes the tool's own run time.`,
    undefined,
    rows,
    0.36,
    120,
    list.length > rows.length && footer ? `Top ${rows.length} of ${list.length} · ${footer}` : undefined,
  )
}

/** Each turn's cost split by what it paid for, and the card that tells it. */
export function turnCosts(r: UsageReport) {
  return r.turnRows.map((t, k) => {
    const pts = r.series.filter(p => p.turn === k + 1)
    const read = sum(pts, p => p.costRead)
    const write = sum(pts, p => p.costWrite)
    const out = sum(pts, p => p.costOutput)
    const tip: Tip = {
      title: `${k + 1}. ${cut(t.prompt, 110)}`,
      lines: [
        { swatch: 'read', label: `Cache reads · ${tok(t.cacheRead)}`, value: money(read) },
        { swatch: 'write', label: `Cache writes · ${tok(t.cacheWrite)}`, value: money(write) },
        { swatch: 'out', label: `Output · ${tok(t.outputTokens)}`, value: money(out) },
        { label: 'Total', value: money(t.cost) },
        { label: 'Active time', value: dur(t.activeMs) },
        { label: 'Model requests', value: String(t.requests) },
        { label: 'Context at the end', value: tok(t.contextAtEnd) },
      ],
    }
    return { t, k, read, write, out, tip }
  })
}

export const TURN_INFO =
  'A turn is everything Claude did for one of your prompts (or for a background task that woke the session). Later turns cost more per request because the context they re-send is bigger.'

/** The single pieces of content that cost the most. */
export function itemChart(r: UsageReport, limit = 25): string {
  const rows = r.top.slice(0, limit).map(t => ({
    label: t.label,
    segs: [{ v: t.cost, cls: 'read' }],
    value: `${money(t.cost)}${t.reads > 1 ? ` · ${t.reads} pieces` : ''}`,
    tip: {
      title: cut(t.label, 120),
      lines: [
        { label: 'Kind', value: CATS[t.cat]?.label ?? t.cat },
        { label: 'Tokens added to the context', value: tok(t.tokens) },
        ...(t.reads > 1 ? [{ label: 'Pieces (reads, calls, edits)', value: String(t.reads) }] : []),
        { label: 'Cost', value: money(t.cost) },
      ],
    },
  }))
  return rowChart(
    'Most expensive single items',
    'Content summed by what it is: a file (all its reads and edits), a command, a skill, a reminder. Each piece stays in the context and is re-sent with every later request until a compaction drops it, so its cost is its first write to the cache plus every re-read, plus the output where Claude wrote it.',
    undefined,
    rows,
    0.44,
    170,
  )
}

/** The slowest single tool calls. */
export function slowChart(r: UsageReport, limit = 12): string {
  const rows = r.slowest.slice(0, limit).map(s => ({
    label: s.label,
    segs: [{ v: s.ms, cls: 'read' }],
    value: dur(s.ms),
    tip: { title: cut(s.label, 120), lines: [{ label: 'Took', value: dur(s.ms) }] },
  }))
  return rowChart('Slowest single calls', 'From the call to its result. A call that waited for your approval includes that wait.', undefined, rows, 0.5, 80)
}

// ---------- tables ----------

type Col = { label: string; tip: string; align?: 'left' | 'right'; share: number }

/** A table with a tooltip on each header and a thin bar under the first cell. */
function table(title: string, info: string | undefined, cols: Col[], rows: { cells: string[]; bar?: number; tip?: Tip }[]): string {
  const c = new Canvas()
  c.title(title, info)
  const y0 = 34
  const rowH = 30
  const totalShare = sum(cols, col => col.share)
  const xs: number[] = []
  let acc = 0
  for (const col of cols) {
    xs.push((acc / totalShare) * W)
    acc += col.share
  }
  const edge = (k: number) => (k + 1 < cols.length ? xs[k + 1]! : W)
  const xOf = (k: number) => (cols[k]!.align === 'right' ? edge(k) - 6 : xs[k]! + (k === 0 ? 0 : 8))
  rows.forEach((row, i) => {
    const y = y0 + rowH * (i + 1)
    if (i % 2 === 1) c.add(`<rect x="0" y="${y}" width="${W}" height="${rowH}" class="zebra"/>`)
    if (row.bar !== undefined) c.add(rect(0, y + 25, Math.max(2, (edge(0) - 12) * row.bar), 3, 'read', 'all'))
    row.cells.forEach((cell, k) => {
      const room = Math.floor((edge(k) - xs[k]! - 14) / 7.2)
      c.add(text(xOf(k), y + 19, cut(cell, room), `${k === 0 ? 't' : 't f13'}${cols[k]!.align === 'right' ? ' e' : ''}`))
    })
    if (row.tip) c.hover(0, y, W, rowH, row.tip, { x: 8, top: y, bottom: y + rowH, place: 'row' })
  })
  c.add(`<line x1="0" x2="${W}" y1="${y0 + rowH}" y2="${y0 + rowH}" class="base"/>`)
  cols.forEach((col, k) => {
    const isRight = col.align === 'right'
    const x = xOf(k)
    c.add(text(x, y0 + 20, col.label, `t2 f13 b${isRight ? ' e' : ''}`))
    const w = col.label.length * 7.6
    c.hover(isRight ? x - w - 4 : x - 4, y0 + 2, w + 8, rowH - 4, { title: col.label, text: col.tip }, { x: isRight ? x - w : x, top: y0, bottom: y0 + rowH, place: 'row' })
  })
  return c.finish(y0 + rowH * (rows.length + 1) + 6)
}

export function toolsTable(r: UsageReport): string {
  const max = Math.max(1, ...r.tools.map(t => t.ms))
  return table(
    'Tools',
    'Every tool Claude called, how long its calls took and how big their results were. Results stay in the context, so large ones keep costing on every later request.',
    [
      { label: 'Tool', tip: 'The tool’s name; MCP tools without their mcp__ prefix. The thin bar under it is its total time.', share: 4 },
      { label: 'Calls', tip: 'How many times it was called.', align: 'right', share: 1 },
      { label: 'Total', tip: 'Time from each call to its result, summed.', align: 'right', share: 1.3 },
      { label: 'Average', tip: 'The total time divided by the number of calls.', align: 'right', share: 1.3 },
      { label: 'Result tokens', tip: 'Tokens its results added to the context, summed over its calls. Each is then re-sent with every later request.', align: 'right', share: 1.7 },
    ],
    r.tools.map(t => ({
      cells: [t.tool.replace(/^mcp__/, ''), String(t.calls), dur(t.ms), dur(t.ms / Math.max(1, t.calls)), tok(t.resultTokens)],
      bar: t.ms / max,
    })),
  )
}

export function agentsTable(r: UsageReport): string {
  const max = Math.max(1e-12, ...r.agents.map(a => a.cost))
  return table(
    'Subagents',
    'Each subagent runs its own conversation, with its own context and cache. Its prompt and its final answer also land in the main conversation (as “Subagent prompts & results”).',
    [
      { label: 'Subagent', tip: 'What the subagent was asked to do. The thin bar under it is its cost.', share: 4.4 },
      { label: 'Requests', tip: 'Model requests the subagent made.', align: 'right', share: 1.1 },
      { label: 'Input', tip: 'Input tokens summed over its requests: cache reads, cache writes and uncached.', align: 'right', share: 1.1 },
      { label: 'Output', tip: 'Output tokens. Subagent transcripts often keep only a stub count, so this is estimated from the text it wrote, without thinking.', align: 'right', share: 1.1 },
      { label: 'Time', tip: 'From its first row to its last.', align: 'right', share: 1.1 },
      { label: 'Cost', tip: 'At API list prices.', align: 'right', share: 1.1 },
    ],
    r.agents.map(a => ({
      cells: [a.label.replace(/^Agent: /, ''), String(a.requests), tok(a.inputTokens), tok(a.outputTokens), dur(a.ms), money(a.cost)],
      bar: a.cost / max,
    })),
  )
}

// ---------- over time ----------

type Column = { first: number; last: number; pts: RequestPoint[]; turnStart?: number; isBreak: boolean }

/** Consecutive requests merged, so no chart draws more than MAX_COLUMNS columns. */
function columns(series: RequestPoint[]): Column[] {
  const size = Math.max(1, Math.ceil(series.length / MAX_COLUMNS))
  const cols: Column[] = []
  for (let k = 0; k < series.length; k += size) {
    const pts = series.slice(k, k + size)
    const turnStart = pts.find((p, i) => k + i === 0 || series[k + i - 1]!.turn !== p.turn)?.turn
    cols.push({ first: k + 1, last: k + pts.length, pts, turnStart, isBreak: pts.some(p => p.isBreak) })
  }
  return cols
}

type Plot = { x0: number; top: number; bottom: number; step: number; barW: number }

function plot(c: Canvas, cols: Column[], top: number, bottom: number, max: number, fmt: (v: number) => string): Plot {
  const x0 = 58
  const step = (W - x0) / Math.max(1, cols.length)
  const barW = Math.max(1, step - (step >= 5 ? 2 : 0.5))
  for (const f of [0, 0.5, 1]) {
    const y = bottom - (bottom - top) * f
    c.add(`<line x1="${x0}" x2="${W}" y1="${n1(y)}" y2="${n1(y)}" class="${f === 0 ? 'base' : 'grid'}"/>`)
    c.add(text(x0 - 8, y + 4, fmt(max * f), 't3 f12 e'))
  }
  let lastLabelX = -100
  cols.forEach((col, k) => {
    if (col.turnStart === undefined) return
    const x = x0 + k * step - 1
    c.add(`<line x1="${n1(x)}" x2="${n1(x)}" y1="${top}" y2="${bottom}" class="turnl" stroke-dasharray="2 3"/>`)
    if (x - lastLabelX > 28) {
      c.add(text(x + 3, top + 12, `T${col.turnStart}`, 't3 f12'))
      lastLabelX = x
    }
  })
  return { x0, top, bottom, step, barW }
}

const colTitle = (col: Column) =>
  col.first === col.last
    ? `Request ${col.first} · turn ${col.pts[0]!.turn} · ${fmtTime(col.pts[0]!.at)} UTC`
    : `Requests ${col.first}–${col.last} · turn ${col.pts[0]!.turn}${col.pts.at(-1)!.turn !== col.pts[0]!.turn ? `–${col.pts.at(-1)!.turn}` : ''}`

/** How big the context was on each request, and how much of it was new. */
export function contextChart(r: UsageReport, isContent = false): string {
  const c = new Canvas()
  const cols = columns(r.series)
  c.title(
    isContent ? 'Picked content in the context, per request' : 'Context sent per request',
    'Every request sends the whole conversation so far. Blue is the part the cache already held (read at a fraction of the price), green what was new since the previous request and had to be written to the cache. A red bar is a cache rebuild: a pause longer than the cache lifetime, or a change of tools or settings, made the request write everything again. Dashed lines mark where a turn starts.' +
      (cols.length < r.series.length ? ` Each bar merges ${Math.ceil(r.series.length / MAX_COLUMNS)} consecutive requests and shows the last of them.` : ''),
  )
  c.legend(
    46,
    isContent
      ? [['read', 'Tokens of the picked content in the context']]
      : [
          ['read', 'Read from the cache'],
          ['write', 'New (cache write)'],
          ['crit', 'Cache rebuilt'],
        ],
  )
  if (cols.length === 0) return c.finish(60)
  const last = (col: Column) => col.pts.at(-1)!
  const max = niceMax(Math.max(...cols.map(col => last(col).read + last(col).write)))
  const pl = plot(c, cols, 64, 236, max, tok)
  const y = (v: number) => ((pl.bottom - pl.top) * v) / max
  cols.forEach((col, k) => {
    const p = last(col)
    const x = pl.x0 + k * pl.step
    const hr = y(p.read)
    const hw = y(p.write)
    const gap = hr > 3 && hw > 3 ? 1 : 0
    c.add(rect(x, pl.bottom - hr, pl.barW, hr, 'read', hw > 0 ? 'none' : 'top'))
    c.add(rect(x, pl.bottom - hr - hw, pl.barW, hw - gap, col.isBreak ? 'crit' : 'write', 'top'))
    c.hover(
      x - 1,
      pl.top,
      pl.step + 1,
      pl.bottom - pl.top,
      {
        title: colTitle(col),
        lines: [
          { swatch: 'read', label: 'Read from the cache', value: tok(p.read) },
          { swatch: col.isBreak ? 'crit' : 'write', label: col.isBreak ? 'Written again (rebuild)' : 'New, written', value: tok(p.write) },
          { label: 'Context size', value: tok(p.read + p.write) },
          { label: 'Cost', value: money(sum(col.pts, q => q.costRead + q.costWrite + q.costOutput)) },
        ],
      },
      { x: x + pl.barW / 2, top: pl.top + 20, bottom: pl.bottom, place: 'side' },
    )
  })
  return c.finish(pl.bottom + 6)
}

/** What each request cost, split by what it paid for. */
export function costChart(r: UsageReport, isContent = false): string {
  const c = new Canvas()
  const cols = columns(r.series)
  c.title(
    'Cost per request',
    'Spikes are long outputs (orange) or large new content such as a file read or a long command output (green). The blue floor grows with the context: every request re-reads all of it from the cache.',
  )
  c.legend(
    46,
    isContent
      ? [
          ['read', 'As context (input)'],
          ['out', 'As output'],
        ]
      : [
          ['read', 'Cache reads'],
          ['write', 'Cache writes'],
          ['out', 'Output'],
        ],
  )
  if (cols.length === 0) return c.finish(60)
  const costs = cols.map(col => ({
    read: sum(col.pts, p => p.costRead),
    write: sum(col.pts, p => p.costWrite),
    out: sum(col.pts, p => p.costOutput),
  }))
  const max = niceMax(Math.max(...costs.map(v => v.read + v.write + v.out)))
  const pl = plot(c, cols, 64, 216, max, v => money(v))
  const y = (v: number) => ((pl.bottom - pl.top) * v) / max
  cols.forEach((col, k) => {
    const v = costs[k]!
    const x = pl.x0 + k * pl.step
    const segs: [number, string][] = [
      [v.read, 'read'],
      [v.write, 'write'],
      [v.out, 'out'],
    ]
    const last = segs.map(([s]) => s > 0).lastIndexOf(true)
    let acc = 0
    segs.forEach(([s, cls], i) => {
      const h = y(s)
      const gap = i < last && h > 3 ? 1 : 0
      c.add(rect(x, pl.bottom - acc - h + gap, pl.barW, h - gap, cls, i === last ? 'top' : 'none'))
      acc += h
    })
    c.hover(
      x - 1,
      pl.top,
      pl.step + 1,
      pl.bottom - pl.top,
      {
        title: colTitle(col),
        lines: [
          { swatch: 'read', label: `Cache reads · ${tok(sum(col.pts, p => p.read))}`, value: money(v.read) },
          { swatch: 'write', label: `Cache writes · ${tok(sum(col.pts, p => p.write))}`, value: money(v.write) },
          { swatch: 'out', label: `Output · ${tok(sum(col.pts, p => p.output))}`, value: money(v.out) },
          { label: 'Total', value: money(v.read + v.write + v.out) },
        ],
      },
      { x: x + pl.barW / 2, top: pl.top + 20, bottom: pl.bottom, place: 'side' },
    )
  })
  return c.finish(pl.bottom + 6)
}

/** The running total, so it shows where the spending accelerated. */
export function cumulativeChart(r: UsageReport): string {
  const c = new Canvas()
  const cols = columns(r.series)
  c.title('Running total', 'The cost so far after each request. Steep stretches are where the session spent fastest.' + (r.agents.length > 0 ? ' Subagents are not included.' : ''))
  if (cols.length < 2) return c.finish(40)
  let acc = 0
  const cum = cols.map(col => (acc += sum(col.pts, p => p.costRead + p.costWrite + p.costOutput)))
  const max = niceMax(acc)
  const pl = plot(c, cols, 40, 150, max, v => money(v))
  const pts = cum.map((v, k) => `${n1(pl.x0 + k * pl.step + pl.barW / 2)},${n1(pl.bottom - ((pl.bottom - pl.top) * v) / max)}`)
  c.add(`<polyline points="${pts.join(' ')}" class="line" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`)
  c.add(text(W - 2, pl.bottom - ((pl.bottom - pl.top) * acc) / max - 8, money(acc), 't b e'))
  cols.forEach((col, k) => {
    const x = pl.x0 + k * pl.step
    c.hover(x - 1, pl.top, pl.step + 1, pl.bottom - pl.top, { title: colTitle(col), lines: [{ label: 'Cost so far', value: money(cum[k]!) }] }, {
      x: x + pl.barW / 2,
      top: pl.top,
      bottom: pl.bottom,
      place: 'side',
    })
  })
  return c.finish(pl.bottom + 6)
}

/** Guards the Svg element's size limit: a chart past it is replaced by a note. */
export function fits(source: string): string {
  if (source.length <= MAX_SOURCE) return source
  const c = new Canvas()
  c.add(text(0, 18, 'This chart is too large to draw here; Export .md has its numbers.', 't3'))
  return c.finish(28)
}

// ---------- small pictures for the pane's native rows and the footer ----------

const SMALL_STYLE = `<style>${NO_SELECT}.read{fill:#2a78d6}.write{fill:#1baf7a}.out{fill:#eb6834}.other{fill:#c9c8c3}.track{fill:#e8e7e3}.ring{stroke:#2a78d6}.ringt{stroke:#d9d8d3}.ic{fill:none;stroke:#8f8e88}.ict{fill:#8f8e88}.icon:hover .ic{stroke:#2a78d6}.icon:hover .ict{fill:#2a78d6}.sel{fill:none;stroke:#2a78d6}
@media (prefers-color-scheme: dark){.read{fill:#3987e5}.write{fill:#199e70}.out{fill:#d95926}.other{fill:#55544f}.track{fill:#2c2c2a}.ring{stroke:#3987e5}.ringt{stroke:#3a3a37}.ic{stroke:#9a9990}.ict{fill:#9a9990}.icon:hover .ic{stroke:#3987e5}.icon:hover .ict{fill:#3987e5}.sel{stroke:#3987e5}}</style>`

const small = (w: number, h: number, body: string, title?: string, opacity = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="system-ui, sans-serif">${SMALL_STYLE}` +
  `<g opacity="${opacity}">${title ? `<title>${esc(title)}</title>` : ''}<rect x="0" y="0" width="${w}" height="${h}" fill="transparent"/>${body}</g></svg>`

/** One row's bar: segments against the largest row, its tooltip the native title. */
export function miniBar(segs: { v: number; cls: string }[], max: number, width: number, title: string, opts: { isSelected?: boolean; isDimmed?: boolean } = {}): string {
  const h = 22
  const barH = 14
  const y = (h - barH) / 2
  // room on both sides for the selection's outline, which stands 3px off the bar
  const pad = 4
  let x = pad
  let body = ''
  const last = segs.map(sg => sg.v > 0).lastIndexOf(true)
  segs.forEach((sg, i) => {
    const w = max > 0 ? (sg.v / max) * (width - 2 * pad) : 0
    body += rect(x, y, Math.max(0, w - (i < last && w > 3 ? 2 : 0)), barH, sg.cls, i === last ? 'right' : 'none')
    x += w
  })
  if (opts.isSelected) body += `<rect x="0.75" y="${y - 3}" width="${n1(Math.max(pad + 4, x) + 2.5)}" height="${barH + 6}" rx="5" class="sel" stroke-width="1.5"/>`
  return small(width, h, body, title, opts.isDimmed ? 0.35 : 1)
}

/** The (i) beside a heading: hovering it shows `info`. */
export function infoIcon(info: string): string {
  return small(18, 18, infoMark(0, 0, info))
}

/** A legend strip for native rows. */
export function legendStrip(items: [string, string][], width: number): string {
  let x = 0
  let body = ''
  for (const [cls, label] of items) {
    body += rect(x, 4, 11, 11, cls, 'all') + `<text x="${n1(x + 17)}" y="14" font-size="13" fill="#8f8e88">${esc(label)}</text>`
    x += 17 + label.length * 7.2 + 20
  }
  return small(Math.min(width, Math.ceil(x)), 18, body)
}

/** A progress ring for the footer: `percent` of the circle, the rest a faint track. */
export function ring(percent: number, title: string, size = 16): string {
  const r = size / 2 - 2
  const c = 2 * Math.PI * r
  const f = Math.max(0, Math.min(1, percent / 100))
  return small(
    size,
    size,
    `<circle cx="${size / 2}" cy="${size / 2}" r="${n1(r)}" fill="none" class="ringt" stroke-width="2.5"/>` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${n1(r)}" fill="none" class="ring" stroke-width="2.5" stroke-dasharray="${n1(c * f)} ${n1(c)}" transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"/>`,
    title,
  )
}

/**
 * The short summary the footer's button opens, laid out as the app's own
 * context card is: a heading line, the cost, then one compact row per limit
 * and the context (name left; detail and figure right; a thin bar under it).
 * Each row's native tooltip says what its figure means.
 */
export function summaryCard(r: UsageReport, measure?: Measure, width = 380): string {
  const w = Math.round(width)
  const five = r.live?.limits.find(l => l.kind === 'five_hour')
  const week = r.live?.limits.find(l => l.kind === 'seven_day')
  const ctx = r.live ? (r.live.contextPercent ?? (100 * (r.live.contextTokens ?? r.contextNow)) / Math.max(1, r.live.contextWindow)) : undefined
  const active = sum(r.time.filter(t => t.id !== 'idle'), t => t.ms)
  const pending = measure?.state === 'error' ? "couldn't measure" : 'measuring…'
  const resets = (iso?: string) => {
    const at = iso ? Date.parse(iso) : NaN
    return Number.isFinite(at) ? `resets in ${dur(Math.max(0, at - r.generatedAt)).replace(/ 00[ms]$/, '')}` : ''
  }
  // right-aligned: a dim detail, then the figure in bold
  const right = (y: number, detail: string, value: string, tail = '') =>
    `<text x="${w}" y="${y}" class="e f13"><tspan class="t3">${esc(detail)}</tspan><tspan class="t b">${esc(value)}</tspan>${tail ? `<tspan class="t3">${esc(tail)}</tspan>` : ''}</text>`
  const row = (y: number, h: number, title: string, body: string) =>
    `<g><title>${esc(title)}</title><rect x="0" y="${y}" width="${w}" height="${h}" fill="transparent"/>${body}</g>`
  const bar = (y: number, used: number, mine?: number) => {
    const u = Math.max(0, Math.min(100, used)) / 100
    const m = Math.max(0, Math.min(u, (mine ?? 0) / 100))
    const hot = used >= 90 ? 'crit' : 'other'
    return (
      rect(0, y, w, 4, 'track', 'all') +
      (mine === undefined
        ? rect(0, y, Math.max(2, w * u), 4, used >= 90 ? 'crit' : 'read', 'all')
        : rect(0, y, w * (u - m), 4, hot) + rect(w * (u - m), y, Math.max(2, w * m), 4, 'read', 'right'))
    )
  }

  let y = 0
  let body = ''
  // heading: what the card is about, and how long the session has run
  body += `<text x="0" y="${y + 14}" class="t b">Session usage</text>`
  body += `<text x="${w}" y="${y + 14}" class="t3 f12 e">${esc(`${dur(active)} active · ${r.turns} turns`)}</text>`
  y += 26
  body += row(
    y,
    22,
    `${money(r.cost.total)} at API prices; ${money(r.cost.noCache)} if nothing had been cached.\n${tok(r.input.cacheRead + r.input.cacheWrite + r.input.uncached)} input tokens · ${tok(r.output.total)} output tokens · ${r.requests} requests`,
    text(0, y + 14, 'Cost at API prices', 't2 f13') + right(y + 14, `${money(r.cost.noCache)} uncached · `, money(r.cost.total)),
  )
  y += 26
  body += `<line x1="0" x2="${w}" y1="${y + 0.5}" y2="${y + 0.5}" class="grid"/>`
  y += 10
  const limitRow = (name: string, l?: LimitWindow) => {
    if (!l) return
    const share = l.session === undefined ? '…' : `≈ ${l.session < 10 ? l.session.toFixed(1) : Math.round(l.session)}%`
    const detail = `${readAgo(l, r.generatedAt) ?? (l.session === undefined ? pending : resets(l.resetsAt))} · `
    body += row(
      y,
      30,
      `${name}: this session used ${share} of it; ${Math.round(l.percentUsed)}% is used in all, by every session and app on the account.${l.sessions ? `\n${l.sessions} local sessions used this window.` : ''}`,
      text(0, y + 14, name, 't2 f13') + right(y + 14, detail, share, ` of ${Math.round(l.percentUsed)}%`) + bar(y + 22, l.percentUsed, l.session),
    )
    y += 34
  }
  limitRow('5-hour limit', five)
  limitRow('Weekly limit', week)
  if (ctx !== undefined) {
    body += row(
      y,
      30,
      `The context the next request sends: ${tok(r.live?.contextTokens ?? r.contextNow)} of the model's ${tok(r.live?.contextWindow ?? 0)}.`,
      text(0, y + 14, 'Context', 't2 f13') + right(y + 14, `${tok(r.live?.contextTokens ?? r.contextNow)} of ${tok(r.live?.contextWindow ?? 0)} · `, `${Math.round(ctx)}%`) + bar(y + 22, ctx),
    )
    y += 34
  }
  const h = y - 4
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${STYLE}${body}</svg>`
}

// ---------- the footer's tooltip and popover ----------

const CARD_STYLE = `<style>${NO_SELECT}.cardbg{fill:#ffffff;stroke:#d6d5d0}.ct{fill:#0b0b0b}.ct2{fill:#52514e}.ct3{fill:#7a7975}
@media (prefers-color-scheme: dark){.cardbg{fill:#2b2b29;stroke:#4a4a46}.ct{fill:#ffffff}.ct2{fill:#c3c2b7}.ct3{fill:#9a9990}}</style>`

/**
 * An SVG drawn on an opaque card with a title, so it can float over the
 * conversation; `footer` leaves room at the bottom for buttons laid over it.
 */
export function framed(inner: string, title?: string, footer = 0): string {
  const { width, height } = svgSize(inner)
  const pad = 14
  const head = title ? 30 : 0
  const w = width + 2 * pad
  const h = height + 2 * pad + head + footer
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">` +
    CARD_STYLE +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" class="cardbg"/>` +
    (title ? `<text x="${pad}" y="${pad + 14}" font-size="15" font-weight="600" class="ct">${esc(title)}</text>` : '') +
    inner.replace('<svg ', `<svg x="${pad}" y="${pad + head}" `) +
    `</svg>`
  )
}

/** The short summary shown while the pointer is on the footer's icon. */
export function tooltipCard(r: UsageReport): string {
  const lines: [string, string][] = [['Cost (API prices)', money(r.cost.total)]]
  for (const [kind, name] of [
    ['five_hour', '5-hour limit'],
    ['seven_day', 'Weekly limit'],
  ] as const) {
    const l = r.live?.limits.find(x => x.kind === kind)
    if (l) lines.push([`${name}, this session`, l.session === undefined ? '…' : `≈ ${l.session < 10 ? l.session.toFixed(1) : Math.round(l.session)}% of ${Math.round(l.percentUsed)}%`])
  }
  if (r.live) {
    const ctx = r.live.contextPercent ?? (100 * (r.live.contextTokens ?? r.contextNow)) / Math.max(1, r.live.contextWindow)
    lines.push(['Context', `${Math.round(ctx)}%`])
  }
  lines.push(['Active', dur(sum(r.time.filter(t => t.id !== 'idle'), t => t.ms))])
  const w = 260
  const rowH = 21
  let body = ''
  lines.forEach(([label, value], k) => {
    body += `<text x="0" y="${14 + k * rowH}" font-size="13" class="ct2">${esc(label)}</text>`
    body += `<text x="${w}" y="${14 + k * rowH}" font-size="13" font-weight="600" text-anchor="end" class="ct">${esc(value)}</text>`
  })
  body += `<text x="0" y="${14 + lines.length * rowH + 4}" font-size="12" class="ct3">Click for details</text>`
  const inner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${lines.length * rowH + 26}" width="${w}" height="${lines.length * rowH + 26}">${body}</svg>`
  return framed(inner, 'Session usage')
}
