

import type { LimitWindow, LiveUsage, UsageReport } from '../types'
import { type CachedFile, type CostPoint, WINDOW_MS, pack, requestCosts, scanLine, unpack } from './limits'
import { configDir } from './transcripts'
import type { Host } from './host'


// ---------- every local session's requests, for the limits' shares ----------

// each transcript's request costs, by path, kept in host.store across sessions
// (a finished session's file never changes, so it is scanned once)
const COSTS_KEY = 'costs'
let costCache: Record<string, CachedFile> | undefined

type Transcript = { path: string; size: number; mtimeMs: number; session: string }

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/** Every local transcript, main conversation or subagent, written to since `since`. */
async function recentTranscripts(host: Host, since: number): Promise<Transcript[]> {
  const projects = `${await configDir(host)}/projects`
  const out: Transcript[] = []
  for (const d of await host.fs.list(projects).catch(() => [])) {
    if (d.kind !== 'dir') continue
    const dir = `${projects}/${d.name}`
    for (const f of await host.fs.list(dir).catch(() => [])) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs < since) continue
      const session = f.name.slice(0, -'.jsonl'.length)
      out.push({ path: `${dir}/${f.name}`, size: f.size, mtimeMs: f.mtimeMs, session })
      const sub = `${dir}/${session}/subagents`
      for (const s of await host.fs.list(sub).catch(() => [])) {
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
async function scan(host: Host, paths: string[]): Promise<Map<string, CostPoint[]>> {
  const out = new Map<string, CostPoint[]>()
  const put = (file: string, p: CostPoint) => {
    const key = norm(file)
    const list = out.get(key)
    if (list) list.push(p)
    else out.set(key, [p])
  }
  if ((await host.env.get('OS')) === 'Windows_NT') {
    const tmp = (await host.env.get('TEMP')) ?? (await configDir(host))
    const list = `${tmp}\\session-insights-scan.txt`
    await host.fs.write(list, paths.map(p => p.replace(/\//g, '\\')).join('\r\n'))
    const script = `${host.root}/hooks/scan.ps1`.replace(/\//g, '\\')
    let rest = ''
    const argv = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, list]
    for await (const chunk of host.process.spawn({ argv })) {
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
      for await (const chunk of host.process.spawn({ argv })) if (chunk.stream === 'stdout') text += chunk.text
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
export async function sessionCosts(host: Host, since: number): Promise<Map<string, CostPoint[]>> {
  if (!costCache) {
    const stored = await host.store.get(COSTS_KEY).catch(() => undefined)
    costCache = stored && typeof stored === 'object' ? (stored as Record<string, CachedFile>) : {}
  }
  const cache = costCache
  const files = await recentTranscripts(host, since)
  const stampOf = (f: Transcript) => `${f.size}:${f.mtimeMs}`
  const stale = files.filter(f => cache[norm(f.path)]?.stamp !== stampOf(f))
  let isChanged = false
  if (stale.length > 0) {
    await host.state.set('measure', { state: 'measuring', files: stale.length })
    const scanned = await scan(host, stale.map(f => f.path))
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
  if (isChanged) await host.store.set(COSTS_KEY, cache).catch(() => undefined)
  const bySession = new Map<string, CostPoint[]>()
  for (const f of files) {
    const points = unpack(cache[norm(f.path)]?.points ?? [])
    const list = bySession.get(f.session)
    if (list) list.push(...points)
    else bySession.set(f.session, points)
  }
  return bySession
}

export const windowStart = (l: LimitWindow) => {
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
export async function liveUsage(host: Host): Promise<LiveUsage> {
  const usage = await host.session.usage()
  const now = await host.clock.now()
  let limits: LimitWindow[] = usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
  if (limits.length > 0) {
    await host.store.set(LIMITS_KEY, { at: now, limits } satisfies StoredLimits).catch(() => undefined)
  } else {
    const stored = (await host.store.get(LIMITS_KEY).catch(() => undefined)) as StoredLimits | undefined
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
export function pickShare(measured: LimitWindow | undefined, percentUsed: number): Partial<LimitWindow> {
  if (!measured || measured.totalUsd === undefined || measured.sessionUsd === undefined) return {}
  return {
    session: measured.totalUsd > 0 ? (percentUsed * measured.sessionUsd) / measured.totalUsd : 0,
    sessionUsd: measured.sessionUsd,
    totalUsd: measured.totalUsd,
    sessions: measured.sessions,
  }
}

export const withShares = (r: UsageReport, from: LimitWindow[]): UsageReport => {
  if (!r.live) return r
  const byKind = new Map(from.map(l => [l.kind, l]))
  return { ...r, live: { ...r.live, limits: r.live.limits.map(l => ({ ...l, ...pickShare(byKind.get(l.kind), l.percentUsed) })) } }
}
