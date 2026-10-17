// A session's share of a rate-limit window (5-hour, 7-day).
//
// The API reports how much of each window the whole account has used, never
// what one session used. Every Claude Code session on this computer keeps a
// transcript with the exact usage of each of its requests, though. So the
// share is the session's own cost inside the window, divided by the cost of
// every local session inside the same window, times the reported percentage.
// Cost at API list prices is the weight; usage elsewhere (claude.ai, other
// devices) is not in the local transcripts and makes the share read high.

import { priceOf } from './analyze'

type Row = Record<string, any>

/** One model request: when it started (ms), what it cost ($), and its message id. */
export type CostPoint = { at: number; usd: number; id: string }

/** What each model request of a transcript cost, once per request. */
export function requestCosts(text: string): CostPoint[] {
  const seen = new Set<string>()
  const out: CostPoint[] = []
  for (const line of text.split('\n')) {
    // a cheap test first: most rows are no model response
    if (!line.includes('"output_tokens"') || !line.includes('"assistant"')) continue
    let r: Row
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const m = r.message
    if (r.type !== 'assistant' || !m || m.model === '<synthetic>') continue
    const id = String(m.id ?? r.uuid)
    if (seen.has(id)) continue
    seen.add(id)
    const at = Date.parse(r.timestamp)
    if (!Number.isFinite(at)) continue
    out.push({ at, usd: usageCost(m.usage ?? {}, String(m.model ?? '')), id })
  }
  return out
}

/**
 * One line of scan.ps1's output: the file, then one model response's time,
 * id, model and token counts (input, cache read, cache write, 5-minute and
 * 1-hour write, output). Undefined for a line that is none.
 */
export function scanLine(line: string): { file: string; point: CostPoint } | undefined {
  const f = line.replace(/\r$/, '').split('\t')
  if (f.length < 10) return undefined
  const [file, stamp, id, model, ...n] = f as [string, string, string, string, ...string[]]
  if (model === '<synthetic>') return undefined
  const at = Date.parse(stamp)
  if (!Number.isFinite(at)) return undefined
  const num = (s: string | undefined) => (s === undefined || s === '' ? undefined : Number(s))
  const hasSplit = num(n[3]) !== undefined || num(n[4]) !== undefined
  const usage = {
    input_tokens: num(n[0]) ?? 0,
    cache_read_input_tokens: num(n[1]) ?? 0,
    cache_creation_input_tokens: num(n[2]) ?? 0,
    cache_creation: hasSplit ? { ephemeral_5m_input_tokens: num(n[3]), ephemeral_1h_input_tokens: num(n[4]) } : undefined,
    output_tokens: num(n[5]) ?? 0,
  }
  return { file, point: { at, usd: usageCost(usage, model), id: id || `${stamp}` } }
}

/** One request's cost from its usage, at the model's list prices. */
export function usageCost(u: Row, model: string): number {
  const p = priceOf(model)
  const write = u.cache_creation_input_tokens ?? 0
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, write - w1h)
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.cache_read_input_tokens ?? 0) * p.read +
      (w5 * 1.25 + w1h * 2) * p.input +
      (u.output_tokens ?? 0) * p.output) /
    1e6
  )
}

export type WindowShare = {
  /** This session's part of the window, in percentage points of the limit. */
  session: number
  /** This session's cost inside the window. */
  sessionUsd: number
  /** Every local session's cost inside the window, this one included. */
  totalUsd: number
  /** Local sessions with a request inside the window. */
  sessions: number
}

/**
 * The session's share of a window that started at `start` and is
 * `percentUsed` full. `bySession` holds every local session's requests; a
 * request kept in two files (a subagent's, in older transcripts also in the
 * main one) counts once.
 */
export function windowShare(percentUsed: number, start: number, sessionId: string, bySession: Map<string, CostPoint[]>): WindowShare {
  const seen = new Set<string>()
  let sessionUsd = 0
  let totalUsd = 0
  let sessions = 0
  for (const [id, points] of bySession) {
    let used = false
    for (const p of points) {
      if (p.at < start || seen.has(p.id)) continue
      seen.add(p.id)
      used = true
      totalUsd += p.usd
      if (id === sessionId) sessionUsd += p.usd
    }
    if (used) sessions++
  }
  return { session: totalUsd > 0 ? (percentUsed * sessionUsd) / totalUsd : 0, sessionUsd, totalUsd, sessions }
}

/** How long each window runs, to find its start from when it resets. */
export const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 86_400_000,
}

// ---------- the persistent cache: each transcript's costs, by file ----------

/** A file's requests as [seconds, dollars, id], compact enough for the store. */
export type CachedFile = { stamp: string; mtimeMs: number; points: [number, number, string][] }

export const pack = (points: CostPoint[]): CachedFile['points'] =>
  points.map(p => [Math.round(p.at / 1000), Math.round(p.usd * 1e6) / 1e6, p.id.slice(-12)])

export const unpack = (points: CachedFile['points']): CostPoint[] => points.map(([s, usd, id]) => ({ at: s * 1000, usd, id }))
