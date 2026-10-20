// What the pane tests draw from: a report built from a small transcript, the
// context readPane would hand a renderer, and a `$` that records every call.
// The kit's own mount loads the plugin, which these tests do not need: they
// call the renderers with the context directly.

import type { Filter, LimitWindow, Measure, Preview, UsageReport } from '../types'
import { buildReport } from '../hooks/analyze'
import { NO_FILTER, applyFilter, viewOf } from '../hooks/filter'
import type { PaneContext } from '../hooks/pane'

const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const usage = (read: number, write: number, output: number) => ({ input_tokens: 2, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output })

// turn 1: a command and a file written; turn 2: a page fetched and a reply;
// turn 3: a short thanks. A subagent read a file during turn 2.
const ROWS = [
  { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'Build the thing please' } },
  { type: 'assistant', uuid: 'm1', timestamp: at(5), message: { id: 'm1', usage: usage(0, 20000, 300), content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', uuid: 'r1', timestamp: at(35), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok '.repeat(3000) }] } },
  { type: 'assistant', uuid: 'm2', timestamp: at(45), message: { id: 'm2', usage: usage(20000, 3000, 900), content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/app.ts', content: 'const a = 1\n'.repeat(250) } }] } },
  { type: 'user', uuid: 'r2', timestamp: at(46), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'File written' }] } },
  { type: 'assistant', uuid: 'm3', timestamp: at(50), message: { id: 'm3', usage: usage(23000, 1000, 50), content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: at(51) },
  { type: 'user', uuid: 'u2', timestamp: at(651), message: { role: 'user', content: 'look it up' } },
  { type: 'assistant', uuid: 'm4', timestamp: at(653), message: { id: 'm4', usage: usage(24000, 100, 50), content: [{ type: 'tool_use', id: 'tw', name: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'x' } }] } },
  { type: 'user', uuid: 'r4', timestamp: at(660), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tw', content: 'page '.repeat(800) }] } },
  { type: 'assistant', uuid: 'm5', timestamp: at(665), message: { id: 'm5', usage: usage(24100, 1200, 400), content: [{ type: 'text', text: 'Here is what the page says.' }] } },
  { type: 'system', subtype: 'stop_hook_summary', uuid: 's2', timestamp: at(666) },
  { type: 'user', uuid: 'u3', timestamp: at(900), message: { role: 'user', content: 'thanks' } },
  { type: 'assistant', uuid: 'm6', timestamp: at(902), message: { id: 'm6', usage: usage(25300, 100, 10), content: [{ type: 'text', text: 'You are welcome.' }] } },
]
const SUB = [
  { type: 'user', uuid: 'x0', timestamp: at(652), message: { role: 'user', content: 'read it' } },
  { type: 'assistant', uuid: 'x1', timestamp: at(653), message: { id: 'x1', usage: usage(0, 5000, 30), content: [{ type: 'tool_use', id: 'tx', name: 'Read', input: { file_path: 'C:/p/notes.md' } }] } },
  { type: 'user', uuid: 'x2', timestamp: at(654), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tx', content: 'n '.repeat(400) }] } },
  { type: 'assistant', uuid: 'x3', timestamp: at(655), message: { id: 'x3', usage: usage(5000, 400, 10), content: [{ type: 'text', text: 'done' }] } },
]

export const NOW = T0 + 1_000_000

/** A limit as the live usage carries it: this session's own reading, or another's from earlier. */
export const LIMITS: LimitWindow[] = [
  { kind: 'seven_day', percentUsed: 42, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(), session: 3.5, sessionUsd: 1.2, totalUsd: 14, sessions: 4 },
  { kind: 'five_hour', percentUsed: 18, readAt: NOW - 20 * 60_000, session: 6, sessionUsd: 0.4, totalUsd: 1.2, sessions: 2 },
]

/** The report, as the pane reads it from the module's map; with `live`, the running session's. */
export function report(opts: { live?: boolean } = {}): UsageReport {
  const r = buildReport('fixture', 'f.jsonl', ROWS, [{ id: 'a', rows: SUB }], NOW)
  if (opts.live) r.live = { contextTokens: 26000, contextWindow: 200_000, limits: LIMITS }
  return r
}

export const PREVIEW: Preview = {
  title: 'npm test',
  source: Array.from({ length: 20 }, (_, k) => `line ${k + 1}`).join('\n'),
  language: 'bash',
  note: 'Run the tests',
}

/** What a recorded `$` saw: each call's path and arguments, in order. */
export type Call = { path: string; args: unknown[] }

// what the recorded `$` answers where a caller reads the answer: the chat
// cannot be scrolled, the Files pane opens nothing, no file is there
const ANSWERS: Record<string, unknown> = {
  'ui.scroll': { deny: 'not scrollable here' },
  'mcp.call': { isError: true },
  'fs.exists': false,
}

/** A `$` that records every call; `ui.resolve` hands out a table of plain elements. */
export function fakeEngine(table: Record<string, unknown>, calls: Call[] = []): any {
  const node = (path: string): any =>
    new Proxy(function () {}, {
      get: (_t, name) => (typeof name === 'string' ? node(path ? `${path}.${name}` : name) : undefined),
      apply: (_t, _this, args) => {
        if (path === 'ui.resolve') return table
        calls.push({ path, args })
        return path in ANSWERS ? Promise.resolve(ANSWERS[path]) : path === 'fs.stat' ? Promise.reject(new Error('no fs')) : Promise.resolve(undefined)
      },
    })
  return node('')
}

/** Element constructors that return what they are given: `{ type, props }`. */
export function elements(names: string[]): Record<string, (props: Record<string, unknown>) => unknown> {
  return Object.fromEntries(names.map(type => [type, (props: Record<string, unknown>) => ({ type, props })]))
}
export const TERMINAL = ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Client', 'Raster', 'Image']
export const DESKTOP = ['Box', 'Text', 'Button', 'Input', 'Select', 'Svg', 'Link', 'Code', 'Markdown', 'Client']
export const MOBILE = ['Box', 'Text', 'Button', 'Svg', 'Link', 'Code', 'Markdown']

export type Scene = { tab?: string; filter?: Filter; preview?: Preview | null; cols?: number; measure?: Measure; live?: boolean }

/**
 * The context readPane builds, from a scene; `filters` collects what the pane
 * asked to filter to, `calls` the tab it switched to, as readPane's setTab writes it.
 */
export function context(raw: UsageReport, scene: Scene, filters: Filter[] = [], calls: Call[] = []): PaneContext {
  const filter = scene.filter ?? NO_FILTER
  const cols = scene.cols ?? 100
  const tabs: [string, string][] = (
    [
      ['overview', 'Overview'],
      ['timeline', 'Timeline'],
      ['content', 'Content'],
      ['time', 'Time'],
      ['top', 'Top items'],
      ['agents', 'Agents'],
    ] as [string, string][]
  ).filter(([id]) => id !== 'agents' || raw.agents.length > 0)
  return {
    raw,
    r: applyFilter(raw, filter),
    v: viewOf(filter),
    // a memo key of its own per scene: the memo is the module's
    base: `test|${raw.sessionId}|${raw.live ? 'live' : ''}|${filter.turns.join(',')}/${filter.cats.join(',')}|${cols}`,
    cols,
    filter,
    measure: scene.measure,
    preview: scene.preview ?? null,
    note: '',
    tabs,
    current: scene.tab ?? 'overview',
    isLive: scene.live ?? false,
    setTab: id => () => void calls.push({ path: 'state.set', args: ['tab', id] }),
    setFilter: next => void filters.push(next),
    exportReport: async () => undefined,
    refreshNow: () => undefined,
  }
}

type El = { type: string; props: Record<string, any> }
const isEl = (x: unknown): x is El => typeof x === 'object' && x !== null && 'type' in x && 'props' in x

/** Every element of a tree, depth first. */
export function walk(tree: unknown, out: El[] = []): El[] {
  if (Array.isArray(tree)) for (const x of tree) walk(x, out)
  else if (isEl(tree)) {
    out.push(tree)
    walk(tree.props.children, out)
  }
  return out
}

/** The text a tree shows: string children, and a Button's label where it has no children. */
export function textOf(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (!isEl(tree)) return ''
  const kids = textOf(tree.props.children)
  if (tree.type === 'Button' && !kids) return String(tree.props.label ?? '')
  if (tree.type === 'Markdown') return String(tree.props.text ?? '')
  if (tree.type === 'Code') return String(tree.props.source ?? '')
  return kids
}

/** A tree as plain data, each handler named but not kept: what two drawings compare by. */
export const plain = (tree: unknown) => JSON.stringify(tree, (_k, v: unknown) => (typeof v === 'function' ? '[fn]' : v))
