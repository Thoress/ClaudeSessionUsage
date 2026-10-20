import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { UsageReport } from '../types'
import { BUCKETS, CATS } from './analyze'
import { detailsOf, topGroups } from './filter'
import { cachingStory, cut, dur, mdAgentTable, mdCostTable, mdToolTable, money, tok } from './format'
import { paneActions } from './navigate'
import type { PaneContext } from './pane'
import {
  CONTENT_LEGEND,
  OVERVIEW_TURNS,
  type Row,
  TIME_LEGEND,
  catOptions,
  contentRows,
  costLegend,
  costliest,
  costlyCats,
  entryRow,
  headlineTiles,
  pickLists,
  previewHead,
  rowTotal,
  slowestRows,
  timeRows,
  turnOptions,
  turnRows,
  turnTimeRows,
} from './rows'

// the charts' colours, for the text bars: cache reads, writes, output, other
const COLOR: Record<string, string> = { read: '#2a78d6', write: '#1baf7a', out: '#eb6834', other: '#8f8e88' }

/** How many cells each segment takes of a bar `width` wide that `max` fills; a row with anything in it shows. */
export function segmentCells(segs: { v: number }[], max: number, width: number): number[] {
  let sum = 0
  let at = 0
  // the segments' ends rounded, not their widths: the bar's length stays true
  const cells = segs.map(s => {
    sum += Math.max(0, s.v)
    const n = Math.max(0, Math.round((Math.min(sum, max) / max) * width) - at)
    at += n
    return n
  })
  if (at === 0 && sum > 0) {
    const big = segs.reduce((b, s, k) => (s.v > (segs[b]?.v ?? 0) ? k : b), 0)
    cells[big] = 1
  }
  return cells
}

const SPARKS = '▁▂▃▄▅▆▇█'

/**
 * A one-line chart of `values`, `width` cells at most: a long series folds
 * `per` values into each cell, the largest of them or their sum.
 */
export function sparkline(values: number[], width: number, fold: 'max' | 'sum' = 'max'): { line: string; per: number; top: number } {
  const per = Math.max(1, Math.ceil(values.length / Math.max(1, width)))
  const cells: number[] = []
  for (let k = 0; k < values.length; k += per) {
    const part = values.slice(k, k + per)
    cells.push(fold === 'max' ? Math.max(...part) : part.reduce((s, x) => s + x, 0))
  }
  const top = Math.max(0, ...cells)
  return { line: cells.map(x => SPARKS[top > 0 ? Math.round((x / top) * 7) : 0]).join(''), per, top }
}

/** The cost so far after each request. */
const running = (r: UsageReport) => {
  let sum = 0
  return r.series.map(p => (sum += p.costRead + p.costWrite + p.costOutput))
}

/** The pane on the terminal: the desktop's tabs, filter and rows, its pictures drawn as text bars and tables. */
export function renderTerminalPane($: EngineInterface, e: RenderInput<'Pane', 'terminal'>, ctx: PaneContext): RenderElement {
  const { raw, r, v, base, cols, filter, measure, preview, note, tabs, current, setTab, exportReport, refreshNow } = ctx
  const act = paneActions($, ctx)
  const { Box, Text, Button, Select, Code, Markdown } = $.ui.resolve(e)

  const heading = (title: string) => (
    <Box marginTop={1}>
      <Text bold>{title}</Text>
    </Box>
  )
  const dim = (text: string) => <Text dimColor>{text}</Text>
  const legend = (items: [string, string][]) => (
    <Box flexDirection="row" gap={2} flexWrap="wrap">
      {items.map(([cls, label]) => (
        <Box key={`legend-${cls}`} flexDirection="row" gap={1}>
          <Text color={COLOR[cls]}>■</Text>
          <Text dimColor>{label}</Text>
        </Box>
      ))}
    </Box>
  )

  // a row is one line: the label (a button where it filters or leads
  // somewhere), a text bar, the value; there is no hover, so no tooltip
  const labelCols = Math.max(18, Math.floor(cols * 0.34))
  const valueCols = 16
  const barCols = Math.max(6, cols - labelCols - valueCols - 1)
  const rows = (list: Row[]) => {
    const max = Math.max(1e-12, ...list.map(rowTotal))
    return (
      <Box flexDirection="column" marginTop={1}>
        {list.map(x => {
          const label = cut(x.label, labelCols - 2)
          const text = (
            <Text bold={x.isSelected} color={x.isSelected ? 'suggestion' : undefined} dimColor={x.isDimmed} wrap="truncate-end">
              {label}
            </Text>
          )
          const cells = segmentCells(x.segs, max, barCols)
          return (
            <Box key={`row-${x.key}`} flexDirection="row">
              <Box width={labelCols} flexShrink={0}>
                {x.onPress ? (
                  <Button plain key={`pick-${x.key}`} label={label} dimColor={x.isDimmed} onPress={x.onPress}>
                    {text}
                  </Button>
                ) : (
                  text
                )}
              </Box>
              <Box width={barCols} flexShrink={0} flexDirection="row">
                {x.segs.map((s, k) =>
                  cells[k] ? (
                    <Text key={`seg-${k}`} color={COLOR[s.cls]} dimColor={x.isDimmed}>
                      {'█'.repeat(cells[k]!)}
                    </Text>
                  ) : null,
                )}
              </Box>
              <Text dimColor={x.isDimmed} wrap="truncate-end">
                {` ${x.value}`}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  }

  // the desktop's charts over the requests, one line each
  const spark = (title: string, values: number[], fold: 'max' | 'sum', fmt: (x: number) => string, color: string) => {
    const { line, per, top } = sparkline(values, cols - 2, fold)
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{title}</Text>
          {dim(`up to ${fmt(top)}${per > 1 ? ` · a mark is ${per} requests` : ''}`)}
        </Box>
        <Text color={color}>{line || '–'}</Text>
      </Box>
    )
  }

  const { byCats, byTurns } = pickLists(raw, filter, base)
  const idleMs = r.time.find(t => t.id === 'idle')?.ms ?? 0
  const timeList = (limit: number, more?: string) => {
    const all = r.time.filter(t => t.id !== 'idle').length
    return [
      rows(timeRows(r, limit)),
      ...(all > limit && more ? [dim(`Top ${limit} of ${all} · ${more}`)] : []),
      ...(idleMs > 0 && all <= limit ? [dim(`${BUCKETS.idle?.label ?? 'Idle'}: ${dur(idleMs)}, not counted as active`)] : []),
    ]
  }

  let body
  if (current === 'timeline') {
    body = [
      heading('Cost per turn'),
      legend(costLegend(v)),
      rows(turnRows(byTurns, v, act)),
      spark('Context sent per request', r.series.map(p => p.read + p.write), 'max', tok, COLOR.read!),
      spark('Cost per request', r.series.map(p => p.costRead + p.costWrite + p.costOutput), 'sum', money, COLOR.out!),
      spark('Running total of the cost', running(r), 'max', money, COLOR.write!),
    ]
  } else if (current === 'content') {
    const picked = [...v.cats]
    body = [
      heading('What each kind of content cost'),
      legend(CONTENT_LEGEND),
      rows(contentRows(byCats, v, act, 40)),
      ...(picked.length === 0
        ? [<Box marginTop={1}>{dim('Pick a kind of content to see what it was made of.')}</Box>]
        : picked.flatMap(cat => {
            const details = detailsOf(raw, cat, v)
            return [
              heading(`${CATS[cat]?.label ?? cat}: what it was made of`),
              details.length === 0 ? dim('Nothing of this kind in the picked turns.') : rows(details.map(g => entryRow(g, `d-${cat}`, act))),
            ]
          })),
    ]
  } else if (current === 'time') {
    body = [
      heading('Where the time went'),
      ...timeList(30),
      heading('Time per turn'),
      legend(TIME_LEGEND),
      rows(turnTimeRows(raw, v, act)),
      heading('Tools'),
      <Markdown text={mdToolTable(r)} />,
      heading('Slowest single calls'),
      rows(slowestRows(r, act)),
      ...(v.isContent ? [dim('Time is not split by kind of content; only the turn filter applies here.')] : []),
    ]
  } else if (current === 'top') {
    body = [heading('The single entries that cost the most'), rows(topGroups(raw, v).map(g => entryRow(g, 'top', act, true)))]
  } else if (current === 'agents') {
    body = [heading('Subagents'), <Markdown text={mdAgentTable(r)} />]
  } else {
    const allCats = costlyCats(byCats).length
    const tileCols = Math.max(14, Math.floor(cols * 0.3))
    body = [
      // the desktop's tiles, a line each: the figure, then what it is out of
      <Box flexDirection="column" marginTop={1}>
        {headlineTiles(r, measure).map(t => (
          <Box key={`tile-${t.label}`} flexDirection="row">
            <Box width={tileCols} flexShrink={0}>
              <Text dimColor wrap="truncate-end">
                {cut(t.label, tileCols - 1)}
              </Text>
            </Box>
            <Box width={8} flexShrink={0}>
              <Text bold>{t.value}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {t.sub}
            </Text>
          </Box>
        ))}
      </Box>,
      heading('Tokens vs. cost'),
      <Markdown text={mdCostTable(r)} />,
      heading('Where the money went'),
      legend(CONTENT_LEGEND),
      rows(contentRows(byCats, v, act, 5)),
      ...(allCats > 5 ? [dim(`Top 5 of ${allCats} · all on the Content tab`)] : []),
      heading('Where the time went'),
      ...timeList(5, 'all on the Time tab'),
      heading('Cost per turn'),
      legend(costLegend(v)),
      // a long session has hundreds of turns: the costliest here, in order, all on the Timeline tab
      rows(costliest(turnRows(byTurns, v, act), OVERVIEW_TURNS)),
      ...(raw.turnRows.length > OVERVIEW_TURNS ? [dim(`The ${OVERVIEW_TURNS} costliest of ${raw.turnRows.length} turns · all on the Timeline tab`)] : []),
      // the desktop's tooltip on the tokens and the cost, written out
      <Box marginTop={1}>
        <Markdown text={cachingStory(r)} />
      </Box>,
    ]
  }

  // the filter: dropdowns add, chips remove; the two secondary actions after it
  const filterBar = (
    <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap" marginTop={1}>
      {dim('Filter')}
      <Select key="add-turn" options={turnOptions(raw, v)} value="all" onSelect={act.addTurn} />
      <Select key="add-cat" options={catOptions(raw, v)} value="all" onSelect={act.addCat} />
      {filter.turns.map(t => (
        <Button key={`chip-turn-${t}`} onPress={() => act.dropTurn(t)}>
          {`Turn ${t} ✕`}
        </Button>
      ))}
      {filter.cats.map(c => (
        <Button key={`chip-cat-${c}`} onPress={() => act.dropCat(c)}>
          {`${CATS[c]?.label ?? c} ✕`}
        </Button>
      ))}
      {v.isFiltered ? <Button plain key="clear-filter" label="Clear" dimColor onPress={act.clearFilter} /> : null}
      <Button plain key="refresh" label="Refresh" dimColor onPress={refreshNow} />
      <Button plain key="export" label="Export .md" dimColor onPress={exportReport} />
    </Box>
  )

  // one row of tabs, the picked one the primary button (`[ label ]`); where
  // they would not fit on one row, a dropdown takes their place
  const tabsCols = tabs.reduce((s, [, label]) => s + label.length + 4, 0) + tabs.length - 1
  const tabBar =
    tabsCols <= cols ? (
      <Box flexDirection="row" gap={1}>
        {tabs.map(([id, label]) => (
          <Button key={`tab-${id}`} label={label} variant={current === id ? 'primary' : undefined} dimColor={current !== id} onPress={setTab(id)} />
        ))}
      </Box>
    ) : (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {dim('View')}
        <Select key="tab" options={tabs.map(([value, label]) => ({ value, label }))} value={current} onSelect={(value: string) => setTab(value)()} />
      </Box>
    )

  // what a details entry's click put on show: its first lines here, the
  // whole of it in a tab of its own, which scrolls
  const { head, rest } = previewHead(preview)
  const shown = preview ? (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text bold wrap="truncate-middle">
          {preview.title}
        </Text>
        <Button plain key="preview-close" label="Close ✕" dimColor onPress={act.closePreview} />
      </Box>
      {preview.note ? dim(preview.note) : null}
      <Box marginTop={1}>
        {preview.isMarkdown ? (
          <Markdown text={head} />
        ) : (
          <Code source={head} language={preview.language} path={preview.path} startLine={preview.path ? 1 : undefined} />
        )}
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="preview-open" label="Open full view ↗" onPress={() => act.openFull(preview)} />
        {rest > 0 ? dim(`${rest} more line${rest === 1 ? '' : 's'}`) : null}
      </Box>
    </Box>
  ) : null

  return (
    <Box flexDirection="column">
      {tabBar}
      {filterBar}
      {note ? dim(note) : null}
      {shown}
      <Box flexDirection="column">{body}</Box>
    </Box>
  )
}
