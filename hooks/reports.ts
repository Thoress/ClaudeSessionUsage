import type { EngineInterface } from 'claude-code'

import type { UsageReport } from '../types'
import { NO_FILTER } from './filter'
import { windowShare } from './limits'
import { liveUsage, sessionCosts, windowStart, withShares } from './shares'
import { analyze, compact } from './transcripts'

const REPORT = { plugin: 'session-insights', key: 'report' } as const
const CURRENT = { plugin: 'session-insights', key: 'current' } as const
const STATUS = { plugin: 'session-insights', key: 'status' } as const
const FILTER = { plugin: 'session-insights', key: 'filter' } as const
const MEASURE = { plugin: 'session-insights', key: 'measure' } as const
const POPOVER = { plugin: 'session-insights', key: 'popover' } as const
const PREVIEW = { plugin: 'session-insights', key: 'preview' } as const

// ---------- keeping the reports current ----------

// the measurement of the shares under way, if any: one at a time
let measuring: Promise<void> | undefined

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
    const full = reports.get(r.sessionId)
    if (full) {
      const { value: ref } = await $.state.get(REPORT)
      reports.set(r.sessionId, withShares(full, measured))
      if (ref?.sessionId === r.sessionId) await $.state.set(REPORT, { sessionId: r.sessionId, rev: ++rev })
    }
    await $.state.set(MEASURE, { state: 'idle' })
  } catch (err) {
    await $.state.set(MEASURE, { state: 'error', error: (err as Error)?.message ?? String(err) })
  }
}

// what a pane drawn without its report asks for, once a few seconds at most
let reanalyzedAt = -Infinity
export function reanalyze($: EngineInterface, sessionId: string) {
  $.clock.after(0, async () => {
    const now = await $.clock.now()
    if (now - reanalyzedAt < 5000) return
    reanalyzedAt = now
    await refreshPane($, sessionId)
  })
}

// derived values a pane draw would otherwise compute again on every redraw
// (a tab switch, a filter, a preview): the filtered reports and the charts,
// keyed by the report's revision, the filter and the width
const memo = new Map<string, unknown>()
export function memoize<T>(key: string, make: () => T): T {
  if (memo.has(key)) return memo.get(key) as T
  if (memo.size > 80) memo.clear()
  const value = make()
  memo.set(key, value)
  return value
}

// the reports themselves, by session: a state value is copied on every read
// and a long session's report runs to megabytes, so state holds only which
// one the pane shows (with a revision that redraws it) and a slim copy for
// the footer. A hot reload empties this; the pane then analyzes again.
export const reports = new Map<string, UsageReport>()
let rev = 0

/** The report without its long lists: what the footer and the popover draw from. */
const slim = (r: UsageReport): UsageReport => ({
  ...r,
  series: [],
  breaks: [],
  cats: [],
  modelByCat: [],
  tools: [],
  slowest: [],
  turnRows: [],
  turnCats: [],
  toolTurns: [],
  groups: [],
  top: [],
  agents: [],
})

/** Puts a report on the pane. */
export async function showReport($: EngineInterface, r: UsageReport) {
  reports.set(r.sessionId, r)
  await $.state.set(REPORT, { sessionId: r.sessionId, rev: ++rev })
}

/** Analyzes the running session for the footer, and for the pane when it shows this session. */
export async function refreshCurrent($: EngineInterface): Promise<UsageReport | undefined> {
  const sessionId = await $.session.id()
  const r = await analyze($, sessionId).catch(() => undefined)
  if (!r) return undefined
  r.live = await liveUsage($).catch(() => undefined)
  // keep the shares of the last measurement until the new one lands
  const { value: before } = await $.state.get(CURRENT)
  const report = before?.live && before.sessionId === sessionId ? withShares(r, before.live.limits) : r
  reports.set(sessionId, report)
  await $.state.set(CURRENT, compact(slim(report)))
  const { value: ref } = await $.state.get(REPORT)
  if (!ref || ref.sessionId === sessionId) await showReport($, report)
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
export async function refreshPane($: EngineInterface, sessionId: string): Promise<UsageReport | undefined> {
  await $.state.set(STATUS, 'Analyzing…')
  try {
    let r: UsageReport | undefined
    if (sessionId === (await $.session.id())) {
      r = await refreshCurrent($)
      if (r) await showReport($, r)
    } else {
      r = await analyze($, sessionId)
      await showReport($, r)
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
export function warmUp($: EngineInterface) {
  $.clock.after(0, async () => {
    const now = await $.clock.now()
    if (now - warmedAt < 5000) return
    warmedAt = now
    await refreshCurrent($)
  })
}

export async function closePopover($: EngineInterface) {
  const { value: isOpen = false } = await $.state.get(POPOVER)
  if (isOpen) await $.state.set(POPOVER, false)
}

export const activeMsOf = (r: UsageReport) => r.time.filter(t => t.id !== 'idle').reduce((s, t) => s + t.ms, 0)
