import type { EngineInterface, RenderElement, RenderInput, RenderSurface } from 'claude-code'

import type { Group, Preview } from '../types'
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
  turnCosts,
} from './charts'
import { PANE, PX_PER_COLUMN } from './constants'
import { NO_FILTER, applyFilter, detailsOf, topGroups } from './filter'
import { cut, dur, money, pct, tok } from './format'
import {
  PREVIEW_LINES,
  contentPreview,
  filePreview,
  firstTurn,
  jumpToTurn,
  leadHint,
  leadOf,
  openPage,
  openView,
  showInFilesPane,
  turnPreview,
} from './leads'
import type { PaneContext } from './pane'
import { memoize } from './reports'

const TAB = { plugin: 'session-insights', key: 'tab' } as const
const PREVIEW = { plugin: 'session-insights', key: 'preview' } as const
const VIEW = { plugin: 'session-insights', key: 'view' } as const

const CONTENT_INFO =
  'Content sent once keeps being re-sent with every later request, so a big file read or command output early on costs again and again (as cheap cache reads). Output is charged once, at the highest rate. The growth of the context between two requests is exact; it is shared out over the content added in between by character count, so the split per kind is a close estimate. Click a row to filter everything to that kind and see what it was made of.'

/** Turns the Overview lists; the Timeline tab lists them all. */
const OVERVIEW_TURNS = 12

// the full view of a preview: a pane of its own, which the surface scrolls
export async function renderViewPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { value: view = null } = await $.state.get(VIEW)
  const { Box, Text, Code, Markdown } = $.ui.resolve(e)
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
export function renderDesktopPane($: EngineInterface, e: RenderInput<'Pane', Exclude<RenderSurface, 'terminal'>>, ctx: PaneContext): RenderElement {
  const { raw, r, v, base, cols, filter, measure, preview, note, tabs, current, isLive, setTab, setFilter, exportReport, refreshNow } = ctx

  // a details entry's click: a file in the Files pane (else here), a page in
  // the browser, a command, output or skill here, anything else its turn in
  // the chat; nothing filters, and a step that cannot says why
  const show = async (p: Preview | undefined, what: string) => {
    if (!p) return $.ui.toast(`Could not find ${what}.`)
    await $.state.set(PREVIEW, p)
    void $.ui.scroll({ in: PANE, to: { key: 'preview-close' }, block: 'start' }).catch(() => undefined)
  }
  const goTo = async (g: Group) => {
    const lead = leadOf(g)
    const turn = firstTurn(g)
    if (lead === 'file' && g.ref?.path) {
      if (await showInFilesPane($, g.ref.path)) return
      // outside the session's folders the Files pane opens nothing: show it here
      return show((await filePreview($, g.ref.path)) ?? (await contentPreview($, raw, g).catch(() => undefined)), g.ref.path)
    }
    if (lead === 'page' && g.ref?.url) {
      if (!(await openPage($, g.ref.url))) $.ui.toast(`Could not open ${g.ref.url}`)
      return
    }
    if (lead === 'show') return show(await contentPreview($, raw, g).catch(() => undefined), g.label)
    if (lead === 'turn' && turn !== undefined) {
      // the chat is scrolled where the surface lets a plugin (the terminal);
      // the desktop does not, so the turn is shown here instead
      if (isLive && (await jumpToTurn($, raw, turn)) === undefined) return
      return show(await turnPreview($, raw, turn).catch(() => undefined), `turn ${turn}`)
    }
  }

  // filter actions: a row's click picks it alone, or drops it when it is the one picked
  const onlyTurn = (turn: number) =>
    setFilter({ ...filter, turns: filter.turns.length === 1 && filter.turns[0] === turn ? [] : [turn] })
  const onlyCat = (cat: string) => setFilter({ ...filter, cats: filter.cats.length === 1 && filter.cats[0] === cat ? [] : [cat] })

  const els = $.ui.resolve(e)
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
  type Row = {
    key: string
    label: string
    segs: { v: number; cls: string }[]
    value: string
    title: string
    isSelected?: boolean
    isDimmed?: boolean
    onPress?: () => void
  }
  const labelCols = Math.max(18, Math.floor(cols * 0.34))
  const valueCols = 16
  const barPx = Math.max(80, Math.floor((cols - labelCols - valueCols - 4) * PX_PER_COLUMN))
  const rows = (list: Row[]) => {
    const max = Math.max(1e-12, ...list.map(x => x.segs.reduce((s, sg) => s + sg.v, 0)))
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

  // the rows to pick from stay whole: kinds of content under the picked
  // turns, turns under the picked kinds; the picked ones are highlighted
  const byCats = memoize(`${base}|byCats`, () => applyFilter(raw, { turns: filter.turns, cats: [] }))
  const byTurns = memoize(`${base}|byTurns`, () => applyFilter(raw, { turns: [], cats: filter.cats }))
  const totalCost = byCats.cost.total
  const contentRows = (limit: number): Row[] =>
    [...byCats.cats]
      .filter(c => c.inputCost + c.outputCost > 0.0005)
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
          onPress: () => onlyCat(c.id),
        }
      })
  const turnRows = (): Row[] =>
    turnCosts(byTurns).map(({ t, read, write, out }) => {
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
        onPress: () => onlyTurn(t.turn),
      }
    })
  // a details entry's row: its cost, and a click that leads to it
  const entryRow = (g: Group, prefix: string, withKind = false): Row => {
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
      onPress: lead === 'none' ? undefined : () => void goTo(g),
    }
  }
  // the `n` rows that cost the most, kept in their order
  const costliest = (list: Row[], n: number) => {
    if (list.length <= n) return list
    const total = (x: Row) => x.segs.reduce((s, sg) => s + sg.v, 0)
    const keep = new Set([...list].sort((a, b) => total(b) - total(a)).slice(0, n))
    return list.filter(x => keep.has(x) || x.isSelected)
  }
  const turnTimeRows = (): Row[] =>
    raw.turnRows.map(t => {
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
        onPress: () => onlyTurn(t.turn),
      }
    })
  const costLegend: [string, string][] = v.isContent
    ? [
        ['read', 'As context'],
        ['out', 'Output'],
      ]
    : [
        ['read', 'Cache reads'],
        ['write', 'Cache writes'],
        ['out', 'Output'],
      ]

  let body
  if (current === 'timeline') {
    body = [
      heading('Cost per turn', TURN_INFO + ' Click a turn to filter everything to it.'),
      legend(costLegend),
      rows(turnRows()),
      chart('context', () => contextChart(r, v.isContent), 'Context sent per request'),
      chart('cost', () => costChart(r, v.isContent), 'Cost per request'),
      chart('cumulative', () => cumulativeChart(r), 'Running total of the cost'),
    ]
  } else if (current === 'content') {
    const picked = [...v.cats]
    body = [
      heading('What each kind of content cost', CONTENT_INFO),
      legend([
        ['read', 'Sent as context (input)'],
        ['out', 'Written by Claude (output)'],
      ]),
      rows(contentRows(40)),
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
                : rows(details.map(g => entryRow(g, `d-${cat}`))),
            ]
          })),
    ]
  } else if (current === 'time') {
    body = [
      chart('time', () => timeChart(r), 'Active time by activity'),
      heading('Time per turn', 'How long Claude worked on each prompt, from the prompt to its last action. Click a turn to filter everything to it.'),
      legend([
        ['read', 'Claude'],
        ['write', 'Tools'],
        ['out', 'Waiting for you'],
        ['other', 'Other'],
      ]),
      rows(turnTimeRows()),
      chart('tools', () => toolsTable(r), 'Tools: calls, total and average time, result tokens'),
      heading('Slowest single calls', 'From the call to its result; a call that waited for your approval includes that wait. Click one to see the call and what came back.'),
      rows(
        r.slowest.slice(0, 15).map((s, k) => {
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
            onPress: lead === 'none' ? undefined : () => void goTo(g),
          }
        }),
      ),
      ...(v.isContent ? [<Text dimColor>Time is not split by kind of content; only the turn filter applies here.</Text>] : []),
    ]
  } else if (current === 'top') {
    body = [
      heading('The single entries that cost the most', 'Every entry of every kind of content, each summed over its pieces (every read of a file, every call of a command). Click one to see it.'),
      rows(topGroups(raw, v).map(g => entryRow(g, 'top', true))),
    ]
  } else if (current === 'agents') {
    body = [chart('agents', () => agentsTable(r), 'Subagents: requests, tokens, time and cost')]
  } else {
    const allCats = byCats.cats.filter(c => c.inputCost + c.outputCost > 0.0005).length
    body = [
      chart(`top|${JSON.stringify(measure ?? null)}`, () => overviewTop(r, { isContent: v.isContent, measure }), `${money(r.cost.total)} at API prices, ${money(r.cost.noCache)} without caching`),
      heading('Where the money went', CONTENT_INFO),
      legend([
        ['read', 'Sent as context (input)'],
        ['out', 'Written by Claude (output)'],
      ]),
      rows(contentRows(5)),
      ...(allCats > 5 ? [<Text dimColor>{`Top 5 of ${allCats} · all on the By content tab`}</Text>] : []),
      chart('time5', () => timeChart(r, 5, 'Where the time went', 'all on the Time tab'), 'The five activities that took the most time'),
      heading('Cost per turn', TURN_INFO + ' Click a turn to filter everything to it.'),
      legend(costLegend),
      // a long session has hundreds of turns: the costliest here, in order, all on the Timeline tab
      rows(costliest(turnRows(), OVERVIEW_TURNS)),
      ...(raw.turnRows.length > OVERVIEW_TURNS
        ? [<Text dimColor>{`The ${OVERVIEW_TURNS} costliest of ${raw.turnRows.length} turns · all on the Timeline tab`}</Text>]
        : []),
    ]
  }

  // the filter: dropdowns add, chips remove
  const turnOptions = [
    { value: 'all', label: 'Add a turn…' },
    ...raw.turnRows.filter(t => !v.turns.has(t.turn)).map(t => ({ value: String(t.turn), label: `${t.turn}. ${cut(t.prompt, 48)}` })),
  ]
  const catOptions = [
    { value: 'all', label: 'Add a kind of content…' },
    ...raw.cats
      .filter(c => !v.cats.has(c.id) && c.inputCost + c.outputCost > 0.0005)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(c => ({ value: c.id, label: c.label })),
  ]
  const filterControls = (
    <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap" flexShrink={1}>
      <Text dimColor>Filter</Text>
      {Select ? (
        <Select
          key="add-turn"
          options={turnOptions}
          value="all"
          onSelect={(value: string) => {
            if (value !== 'all') setFilter({ ...filter, turns: [...filter.turns, Number(value)].sort((a, b) => a - b) })
          }}
        />
      ) : null}
      {Select ? (
        <Select
          key="add-cat"
          options={catOptions}
          value="all"
          onSelect={(value: string) => {
            if (value !== 'all') setFilter({ ...filter, cats: [...filter.cats, value] })
          }}
        />
      ) : null}
      {filter.turns.map(t => (
        <Button key={`chip-turn-${t}`} onPress={() => setFilter({ ...filter, turns: filter.turns.filter(x => x !== t) })}>
          {`Turn ${t}  ✕`}
        </Button>
      ))}
      {filter.cats.map(c => (
        <Button key={`chip-cat-${c}`} onPress={() => setFilter({ ...filter, cats: filter.cats.filter(x => x !== c) })}>
          {`${CATS[c]?.label ?? c}  ✕`}
        </Button>
      ))}
      {v.isFiltered ? (
        <Button plain key="clear-filter" label="Clear the filter" onPress={() => setFilter(NO_FILTER)}>
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
        <Select key="tab" options={tabs.map(([value, label]) => ({ value, label }))} value={current} onSelect={(value: string) => void $.state.set(TAB, value)} />
      </Box>
    )

  // what a details entry's click put on show: the file, script, output or skill itself
  const { Code, Markdown } = els
  // the first lines inline; the whole of it in a tab of its own, which scrolls
  // (a Box in a pane clips but does not scroll)
  const lines = preview ? preview.source.split('\n') : []
  const head = lines.slice(0, PREVIEW_LINES).join('\n')
  const rest = Math.max(0, lines.length - PREVIEW_LINES)
  const shown = preview ? (
    <Box flexDirection="column" marginTop={2} borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Text bold wrap="truncate-middle">
          {preview.title}
        </Text>
        <Button key="preview-close" label="✕" dimColor onPress={() => void $.state.set(PREVIEW, null)} />
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
        <Button key="preview-open" label="Open full view ↗" onPress={() => void openView($, preview)} />
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
