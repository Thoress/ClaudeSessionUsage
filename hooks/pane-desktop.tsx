import type { RenderElement, RenderInput, RenderSurface } from 'claude-code'

import { CATS } from './analyze'
import {
  TURN_INFO,
  agentsTable,
  contextChart,
  costChart,
  cumulativeChart,
  fits,
  infoIcon,
  legendStrip,
  miniBar,
  overviewTop,
  setChartWidth,
  svgSize,
  timeChart,
  toolsTable,
} from './charts'
import { PX_PER_COLUMN } from './constants'
import { detailsOf, topGroups } from './filter'
import { cut, money } from './format'
import { paneActions } from './navigate'
import type { PaneContext } from './pane'
import { memoize } from './reports'
import type { Host } from './host'
import {
  CONTENT_INFO,
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
  pickLists,
  previewHead,
  rowTotal,
  slowestRows,
  turnOptions,
  turnRows,
  turnTimeRows,
} from './rows'


// the full view of a preview: a pane of its own, which the surface scrolls
export async function renderViewPane(host: Host, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { value: view = null } = await host.state.get('view')
  const { Box, Text, Code, Markdown } = host.ui.resolve(e)
  if (!view) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Click an entry in Session usage to see it here.</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text bold>{view.title}</Text>
      {view.note ? <Text dimColor>{view.note}</Text> : null}
      <Box marginTop={1}>
        {view.isMarkdown ? (
          <Markdown text={view.source} />
        ) : (
          <Code source={view.source} language={view.language} path={view.path} startLine={view.path ? 1 : undefined} />
        )}
      </Box>
    </Box>
  )
}

/** The pane on the surfaces that draw SVG. */
export function renderDesktopPane(host: Host, e: RenderInput<'Pane', Exclude<RenderSurface, 'terminal'>>, ctx: PaneContext): RenderElement {
  const { raw, r, v, base, cols, filter, measure, preview, note, tabs, current, setTab, exportReport, refreshNow } = ctx
  const act = paneActions(host, ctx)

  const els = host.ui.resolve(e)
  const { Box, Text, Button, Svg } = els
  // mobile draws no dropdown: there the chips and the rows filter
  const Select = 'Select' in els ? els.Select : undefined
  setChartWidth(cols * PX_PER_COLUMN - 24)
  // an interactive Svg is drawn in a frame of its own, which does not take
  // the markup's size by itself: it is given the size the markup declares
  const chart = (name: string, make: () => string, alt: string) => {
    const { fitted, width, height } = memoize(`${base}|chart|${name}`, () => {
      const fitted = fits(make())
      return { fitted, ...svgSize(fitted) }
    })
    return (
      <Box marginTop={2}>
        <Svg source={fitted} alt={alt} width={width} height={height} isInteractive />
      </Box>
    )
  }
  const heading = (title: string, info?: string) => (
    <Box flexDirection="row" alignItems="center" gap={1} marginTop={2}>
      <Text bold>{title}</Text>
      {info ? <Svg source={infoIcon(info)} alt={info} width={18} height={18} isInteractive /> : null}
    </Box>
  )
  const legend = (items: [string, string][]) => (
    <Svg source={legendStrip(items, cols * PX_PER_COLUMN)} alt={items.map(([, l]) => l).join(', ')} width={svgSize(legendStrip(items, cols * PX_PER_COLUMN)).width} height={18} />
  )

  // native rows: the label is a button that filters, the bar a picture with a tooltip
  const labelCols = Math.max(18, Math.floor(cols * 0.34))
  const valueCols = 16
  const barPx = Math.max(80, Math.floor((cols - labelCols - valueCols - 4) * PX_PER_COLUMN))
  const rows = (list: Row[]) => {
    const max = Math.max(1e-12, ...list.map(rowTotal))
    return (
      <Box flexDirection="column" marginTop={1}>
        {list.map(x => (
          <Box key={`row-${x.key}`} flexDirection="row" alignItems="center">
            <Box width={labelCols} flexShrink={0}>
              {x.onPress ? (
                <Button
                  plain
                  key={`pick-${x.key}`}
                  label={cut(x.label, labelCols - 2)}
                  variant={x.isSelected ? 'primary' : undefined}
                  dimColor={x.isDimmed}
                  onPress={x.onPress}
                >
                  <Text bold={x.isSelected} dimColor={x.isDimmed} wrap="truncate-end">
                    {cut(x.label, labelCols - 2)}
                  </Text>
                </Button>
              ) : (
                <Text dimColor={x.isDimmed} wrap="truncate-end">
                  {cut(x.label, labelCols - 2)}
                </Text>
              )}
            </Box>
            <Svg
              source={miniBar(x.segs, max, barPx, x.title, { isSelected: x.isSelected, isDimmed: x.isDimmed })}
              alt={x.title}
              width={barPx}
              height={22}
              isInteractive
            />
            <Text dimColor={x.isDimmed}> {x.value}</Text>
          </Box>
        ))}
      </Box>
    )
  }

  const { byCats, byTurns } = pickLists(raw, filter, base)

  let body
  if (current === 'timeline') {
    body = [
      heading('Cost per turn', TURN_INFO + ' Click a turn to filter everything to it.'),
      legend(costLegend(v)),
      rows(turnRows(byTurns, v, act)),
      chart('context', () => contextChart(r, v.isContent), 'Context sent per request'),
      chart('cost', () => costChart(r, v.isContent), 'Cost per request'),
      chart('cumulative', () => cumulativeChart(r), 'Running total of the cost'),
    ]
  } else if (current === 'content') {
    const picked = [...v.cats]
    body = [
      heading('What each kind of content cost', CONTENT_INFO),
      legend(CONTENT_LEGEND),
      rows(contentRows(byCats, v, act, 40)),
      ...(picked.length === 0
        ? [
            <Box marginTop={1}>
              <Text dimColor>Click a kind of content to see what it was made of.</Text>
            </Box>,
          ]
        : picked.flatMap(cat => {
            const details = detailsOf(raw, cat, v)
            return [
              heading(`${CATS[cat]?.label ?? cat}: what it was made of`, 'The most expensive entries of this kind, each summed over all its pieces: every read and edit of a file, every call of a command, every load of a skill.'),
              details.length === 0
                ? <Text dimColor>Nothing of this kind in the picked turns.</Text>
                : rows(details.map(g => entryRow(g, `d-${cat}`, act))),
            ]
          })),
    ]
  } else if (current === 'time') {
    body = [
      chart('time', () => timeChart(r), 'Active time by activity'),
      heading('Time per turn', 'How long Claude worked on each prompt, from the prompt to its last action. Click a turn to filter everything to it.'),
      legend(TIME_LEGEND),
      rows(turnTimeRows(raw, v, act)),
      chart('tools', () => toolsTable(r), 'Tools: calls, total and average time, result tokens'),
      heading('Slowest single calls', 'From the call to its result; a call that waited for your approval includes that wait. Click one to see the call and what came back.'),
      rows(slowestRows(r, act)),
      ...(v.isContent ? [<Text dimColor>Time is not split by kind of content; only the turn filter applies here.</Text>] : []),
    ]
  } else if (current === 'top') {
    body = [
      heading('The single entries that cost the most', 'Every entry of every kind of content, each summed over its pieces (every read of a file, every call of a command). Click one to see it.'),
      rows(topGroups(raw, v).map(g => entryRow(g, 'top', act, true))),
    ]
  } else if (current === 'agents') {
    body = [chart('agents', () => agentsTable(r), 'Subagents: requests, tokens, time and cost')]
  } else {
    const allCats = costlyCats(byCats).length
    body = [
      chart(`top|${JSON.stringify(measure ?? null)}`, () => overviewTop(r, { isContent: v.isContent, measure }), `${money(r.cost.total)} at API prices, ${money(r.cost.noCache)} without caching`),
      heading('Where the money went', CONTENT_INFO),
      legend(CONTENT_LEGEND),
      rows(contentRows(byCats, v, act, 5)),
      ...(allCats > 5 ? [<Text dimColor>{`Top 5 of ${allCats} · all on the By content tab`}</Text>] : []),
      chart('time5', () => timeChart(r, 5, 'Where the time went', 'all on the Time tab'), 'The five activities that took the most time'),
      heading('Cost per turn', TURN_INFO + ' Click a turn to filter everything to it.'),
      legend(costLegend(v)),
      // a long session has hundreds of turns: the costliest here, in order, all on the Timeline tab
      rows(costliest(turnRows(byTurns, v, act), OVERVIEW_TURNS)),
      ...(raw.turnRows.length > OVERVIEW_TURNS
        ? [<Text dimColor>{`The ${OVERVIEW_TURNS} costliest of ${raw.turnRows.length} turns · all on the Timeline tab`}</Text>]
        : []),
    ]
  }

  // the filter: dropdowns add, chips remove
  const filterControls = (
    <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap" flexShrink={1}>
      <Text dimColor>Filter</Text>
      {Select ? (
        <Select key="add-turn" options={turnOptions(raw, v)} value="all" onSelect={act.addTurn} />
      ) : null}
      {Select ? (
        <Select key="add-cat" options={catOptions(raw, v)} value="all" onSelect={act.addCat} />
      ) : null}
      {filter.turns.map(t => (
        <Button key={`chip-turn-${t}`} onPress={() => act.dropTurn(t)}>
          {`Turn ${t}  ✕`}
        </Button>
      ))}
      {filter.cats.map(c => (
        <Button key={`chip-cat-${c}`} onPress={() => act.dropCat(c)}>
          {`${CATS[c]?.label ?? c}  ✕`}
        </Button>
      ))}
      {v.isFiltered ? (
        <Button plain key="clear-filter" label="Clear the filter" onPress={act.clearFilter}>
          <Text dimColor>Clear</Text>
        </Button>
      ) : null}
    </Box>
  )

  // the filter on the left; the two secondary actions small and dim on the right
  const filterBar = (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} marginTop={1}>
      {filterControls}
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Button key="refresh" label="⟳" dimColor onPress={refreshNow} />
        <Button key="export" label="⤓ .md" dimColor onPress={exportReport} />
      </Box>
    </Box>
  )

  // one row of tabs, the picked one drawn as the primary button; where
  // they would not fit on one row, a dropdown takes their place
  const tabsPx = tabs.reduce((s, [, label]) => s + label.length * PX_PER_COLUMN + 28, 0) + (tabs.length - 1) * PX_PER_COLUMN
  const tabBar =
    tabsPx <= cols * PX_PER_COLUMN || !Select ? (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {tabs.map(([id, label]) => (
          <Button key={`tab-${id}`} label={label} variant={current === id ? 'primary' : undefined} dimColor={current !== id} onPress={setTab(id)} />
        ))}
      </Box>
    ) : (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text dimColor>View</Text>
        <Select key="tab" options={tabs.map(([value, label]) => ({ value, label }))} value={current} onSelect={(value: string) => setTab(value)()} />
      </Box>
    )

  // what a details entry's click put on show: the file, script, output or skill itself
  const { Code, Markdown } = els
  // the first lines inline; the whole of it in a tab of its own, which scrolls
  // (a Box in a pane clips but does not scroll)
  const { head, rest } = previewHead(preview)
  const shown = preview ? (
    <Box flexDirection="column" marginTop={2} borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Text bold wrap="truncate-middle">
          {preview.title}
        </Text>
        <Button key="preview-close" label="✕" dimColor onPress={act.closePreview} />
      </Box>
      {preview.note ? <Text dimColor>{preview.note}</Text> : null}
      <Box marginTop={1}>
        {preview.isMarkdown ? (
          <Markdown text={head} />
        ) : (
          <Code source={head} language={preview.language} path={preview.path} startLine={preview.path ? 1 : undefined} />
        )}
      </Box>
      <Box flexDirection="row" alignItems="center" gap={1} marginTop={1}>
        <Button key="preview-open" label="Open full view ↗" onPress={() => act.openFull(preview)} />
        {rest > 0 ? <Text dimColor>{`${rest} more line${rest === 1 ? '' : 's'}`}</Text> : null}
      </Box>
    </Box>
  ) : null

  return (
    <Box flexDirection="column">
      {tabBar}
      {filterBar}
      {note ? <Text dimColor>{note}</Text> : null}
      {shown}
      <Box flexDirection="column">{body}</Box>
    </Box>
  )
}
