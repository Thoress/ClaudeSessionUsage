import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Filter, Measure, Preview, UsageReport } from '../types'
import { COMMAND } from './constants'
import { NO_FILTER, applyFilter, viewOf } from './filter'
import { toMarkdown } from './format'
import { memoize, reanalyze, refreshPane, reports } from './reports'

const REPORT = { plugin: 'session-insights', key: 'report' } as const
const TAB = { plugin: 'session-insights', key: 'tab' } as const
const STATUS = { plugin: 'session-insights', key: 'status' } as const
const FILTER = { plugin: 'session-insights', key: 'filter' } as const
const MEASURE = { plugin: 'session-insights', key: 'measure' } as const
const PREVIEW = { plugin: 'session-insights', key: 'preview' } as const

const TABS: [string, string][] = [
  ['overview', 'Overview'],
  ['timeline', 'Timeline'],
  ['content', 'Content'],
  ['time', 'Time'],
  ['top', 'Top items'],
  ['agents', 'Agents'],
]
// tab ids an earlier version stored
const OLD_TABS: Record<string, string> = { tokens: 'content', turns: 'timeline' }

/** What both panes draw from: the report as filtered, the tab shown, and the actions they share. */
export type PaneContext = {
  raw: UsageReport
  r: UsageReport
  v: ReturnType<typeof viewOf>
  /** what each memo key of this revision, filter and width starts with */
  base: string
  cols: number
  filter: Filter
  measure: Measure | undefined
  preview: Preview | null
  note: string
  tabs: [string, string][]
  current: string
  isLive: boolean
  setTab: (id: string) => () => void
  setFilter: (next: Filter) => void
  exportReport: () => Promise<void>
  refreshNow: () => void
}

/** Reads what the pane draws from; without a report, only the status line. */
export async function readPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<PaneContext | { raw: null; note: string }> {
  const { value: ref = null } = await $.state.get(REPORT)
  const raw = ref ? (reports.get(ref.sessionId) ?? null) : null
  // the module was reloaded since: its reports are gone, analyze again
  if (ref && !raw) reanalyze($, ref.sessionId)
  const { value: stored = 'overview' } = await $.state.get(TAB)
  const { value: note = '' } = await $.state.get(STATUS)
  const { value: filter = NO_FILTER } = await $.state.get(FILTER)
  const { value: measure } = await $.state.get(MEASURE)
  const { value: preview = null } = await $.state.get(PREVIEW)
  const cols = Math.max(50, Math.min(160, e.props.bodyColumns ?? e.viewport?.columns ?? 100))
  const setTab = (id: string) => () => void $.state.set(TAB, id)
  const setFilter = (next: Filter) => void $.state.set(FILTER, next)

  if (!raw) return { raw: null, note }

  const v = viewOf(filter)
  // everything derived from the report is computed once per revision, filter and width
  const base = `${raw.sessionId}|${ref?.rev ?? 0}|${filter.turns.join(',')}/${filter.cats.join(',')}|${cols}`
  const r = memoize(`${base}|r`, () => applyFilter(raw, filter))
  const tabs = TABS.filter(([id]) => id !== 'agents' || raw.agents.length > 0)
  const wanted = OLD_TABS[stored] ?? stored
  const current = tabs.some(([id]) => id === wanted) ? wanted : 'overview'
  const exportReport = async () => {
    const path = `${await $.session.cwd()}/session-usage-${raw.sessionId.slice(0, 8)}.md`
    await $.fs.write(path, toMarkdown(raw))
    $.ui.toast(`Written to ${path}`)
  }
  const refreshNow = () => void refreshPane($, raw.sessionId)
  const isLive = raw.sessionId === (await $.session.id())
  return { raw, r, v, base, cols, filter, measure, preview, note, tabs, current, isLive, setTab, setFilter, exportReport, refreshNow }
}

/** The pane before there is a report: the status, else how to get one. */
export function emptyPane($: EngineInterface, e: RenderInput<'Pane'>, note: string): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      <Text dimColor>{note || `Run /${COMMAND} to analyze this session.`}</Text>
    </Box>
  )
}
