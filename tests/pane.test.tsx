// The pane, drawn by both renderers from a report as readPane hands it over.
// The kit's `$.ui.mount` would load the whole plugin, which this CLI's loader
// refuses (register.tsx passes `$` into imported functions), so the renderers
// are called directly with a recorded `$` and a plain element table.

import { describe, expect, test } from 'claude-code/testing'

import type { Filter, Group } from '../types'
import { NO_FILTER, viewOf } from '../hooks/filter'
import { paneActions } from '../hooks/navigate'
import { renderDesktopPane } from '../hooks/pane-desktop'
import { renderTerminalPane, segmentCells, sparkline } from '../hooks/pane-terminal'
import { type RowActions, contentRows, costliest, entryRow, headlineTiles, pickLists, slowestRows, turnRows } from '../hooks/rows'
import { type Call, DESKTOP, PREVIEW, type Scene, TERMINAL, context, elements, fakeEngine, report, textOf, walk } from './fixture'

const settle = async () => {
  for (let k = 0; k < 200; k++) await Promise.resolve()
}

/** Row actions that only say what they were asked. */
function recorder() {
  const asked: string[] = []
  const act: RowActions = {
    onlyTurn: t => void asked.push(`turn ${t}`),
    onlyCat: c => void asked.push(`cat ${c}`),
    goTo: async g => void asked.push(`go ${g.label}`),
  }
  return { act, asked }
}

function drawTerminal(scene: Scene) {
  const calls: Call[] = []
  const filters: Filter[] = []
  const $ = fakeEngine(elements(TERMINAL), calls)
  const tree = renderTerminalPane($, { surface: 'terminal' } as any, context(report({ live: scene.live }), scene, filters, calls))
  const all = walk(tree)
  const byKey = (key: string) => all.find(el => el.props.key === key)
  const press = async (key: string, arg: unknown = {}) => {
    const el = byKey(key)
    if (!el) throw new Error(`nothing keyed ${key}`)
    calls.length = 0
    filters.length = 0
    ;(el.props.onPress ?? el.props.onSelect)(arg, {})
    await settle()
  }
  return { tree, all, byKey, press, calls, filters, text: textOf(tree) }
}

describe('rows', () => {
  const raw = report()

  test('kinds of content: the costliest first, the picked one highlighted, a click filters to it', () => {
    const filter = { turns: [], cats: ['termout'] }
    const { byCats } = pickLists(raw, filter, 'rows|cats')
    const { act, asked } = recorder()
    const list = contentRows(byCats, viewOf(filter), act, 40)
    const totals = list.map(x => x.segs[0]!.v + x.segs[1]!.v)
    expect([...totals].sort((a, b) => b - a)).toEqual(totals)
    const picked = list.find(x => x.key === 'cat-termout')!
    expect(picked.isSelected).toBe(true)
    expect(list.filter(x => x !== picked).every(x => x.isDimmed)).toBe(true)
    picked.onPress!()
    expect(asked).toEqual(['cat termout'])
  })

  test('turns: one row each, a click filters to the turn; the Overview keeps the costliest, in order', () => {
    const { byTurns } = pickLists(raw, NO_FILTER, 'rows|turns')
    const { act, asked } = recorder()
    const list = turnRows(byTurns, viewOf(NO_FILTER), act)
    expect(list.map(x => x.label)).toEqual(['1. Build the thing please', '2. look it up', '3. thanks'])
    list[1]!.onPress!()
    expect(asked).toEqual(['turn 2'])
    const two = costliest(list, 2)
    expect(two.length).toBe(2)
    expect(two.map(x => x.key)).toEqual(list.filter(x => two.includes(x)).map(x => x.key))
    // a picked turn stays though it is not among the costliest
    const cheapest = [...list].sort((a, b) => a.segs.reduce((s, g) => s + g.v, 0) - b.segs.reduce((s, g) => s + g.v, 0))[0]!
    expect(costliest(list.map(x => (x === cheapest ? { ...x, isSelected: true } : x)), 1).some(x => x.key === cheapest.key)).toBe(true)
  })

  test('an entry leads somewhere when it can: its label says so, its click goes there', () => {
    const { act, asked } = recorder()
    const file = raw.groups.find(g => g.cat === 'code_write')!
    const row = entryRow(file, 'd', act)
    expect(row.label).toBe('src/app.ts ↗')
    expect(row.title).toContain('Click to show the file')
    row.onPress!()
    expect(asked).toEqual(['go src/app.ts'])
    const nowhere: Group = { cat: 'sys', label: 'System prompt', cost: 1, tokens: 1, count: 1, byTurn: {} }
    expect(entryRow(nowhere, 'd', act).onPress).toBeUndefined()
    expect(entryRow(nowhere, 'd', act).label).toBe('System prompt')
  })

  test('the slowest calls lead to the call', () => {
    const { act, asked } = recorder()
    const list = slowestRows(raw, act)
    expect(list[0]!.label).toContain('npm test')
    list[0]!.onPress!()
    expect(asked).toEqual([`go ${list[0]!.label}`])
  })

  test('the headline tiles carry this session’s part of each limit, and how old an earlier reading is', () => {
    const tiles = headlineTiles(report({ live: true }), { state: 'idle' })
    const week = tiles.find(t => t.label === 'Weekly limit: this session')!
    expect(week.value).toBe('3.5%')
    expect(week.sub).toContain('42% used in all')
    const five = tiles.find(t => t.label === '5-hour limit: this session')!
    expect(five.value).toBe('6.0%')
    expect(five.sub).toBe('18% in all · as of 20m ago')
    // an earlier session's report knows no limits
    expect(headlineTiles(report(), undefined).find(t => t.label === 'Weekly limit')?.sub).toBe('running session only')
  })
})

describe('text bars', () => {
  test('the segments fill the bar as far as the row’s share, never past it', () => {
    expect(segmentCells([{ v: 1 }, { v: 1 }], 2, 10)).toEqual([5, 5])
    expect(segmentCells([{ v: 1 }, { v: 0 }, { v: 1 }], 4, 10)).toEqual([3, 0, 2])
    expect(segmentCells([{ v: 0.001 }], 100, 10)).toEqual([1])
    expect(segmentCells([{ v: 0 }], 100, 10)).toEqual([0])
    for (const width of [6, 13, 40]) {
      const cells = segmentCells([{ v: 3 }, { v: 2 }, { v: 7 }, { v: 1 }], 13, width)
      expect(cells.reduce((s, n) => s + n, 0)).toBe(width)
    }
  })

  test('a long series folds into the width', () => {
    const s = sparkline([1, 2, 3, 4, 5, 6, 7, 8], 4, 'sum')
    expect(s.per).toBe(2)
    expect(s.top).toBe(15)
    expect(s.line.length).toBe(4)
    expect(s.line.endsWith('█')).toBe(true)
    expect(sparkline([], 10).line).toBe('')
  })
})

describe('the terminal pane', () => {
  const TABS = ['overview', 'timeline', 'content', 'time', 'top', 'agents']

  test('draws every tab with the terminal’s elements only, a row a line', () => {
    for (const tab of TABS)
      for (const cols of [50, 100, 160])
        for (const filter of [NO_FILTER, { turns: [2], cats: ['web'] }]) {
          const d = drawTerminal({ tab, cols, filter, preview: PREVIEW })
          for (const el of d.all) expect(TERMINAL).toContain(el.type)
          // a row's label and value are cut to their columns: nothing wraps
          for (const row of d.all.filter(el => String(el.props.key).startsWith('row-'))) {
            const [label, bar, value] = row.props.children as any[]
            expect(label.props.width + bar.props.width + textOf(value).length).toBeLessThanOrEqual(cols + 1)
            expect(textOf(row).includes('\n')).toBe(false)
          }
        }
  })

  test('the tabs are the desktop’s, as buttons, the picked one primary; a dropdown where they do not fit', () => {
    const wide = drawTerminal({ tab: 'time', cols: 100 })
    const tabs = wide.all.filter(el => el.type === 'Button' && String(el.props.key).startsWith('tab-'))
    expect(tabs.map(el => el.props.label)).toEqual(['Overview', 'Timeline', 'Content', 'Time', 'Top items', 'Agents'])
    expect(tabs.find(el => el.props.variant === 'primary')?.props.label).toBe('Time')
    const narrow = drawTerminal({ tab: 'time', cols: 50 })
    expect(narrow.byKey('tab')?.type).toBe('Select')
    expect(narrow.byKey('tab-time')).toBeUndefined()
  })

  test('the filter: dropdowns add, chips remove, a row’s click picks it alone', async () => {
    const d = drawTerminal({ tab: 'overview', filter: { turns: [3], cats: [] } })
    await d.press('add-turn', '1')
    expect(d.filters).toEqual([{ turns: [1, 3], cats: [] }])
    await d.press('add-cat', 'all')
    expect(d.filters).toEqual([])
    await d.press('chip-turn-3')
    expect(d.filters).toEqual([NO_FILTER])
    await d.press('pick-turn-3')
    expect(d.filters).toEqual([NO_FILTER])
    await d.press('pick-turn-1')
    expect(d.filters).toEqual([{ turns: [1], cats: [] }])
    await d.press('pick-cat-termout')
    expect(d.filters).toEqual([{ turns: [3], cats: ['termout'] }])
    await d.press('clear-filter')
    expect(d.filters).toEqual([NO_FILTER])
  })

  test('a kind of content picked lists what it was made of, each entry leading to it', async () => {
    const d = drawTerminal({ tab: 'content', filter: { turns: [], cats: ['code_write', 'termout'] } })
    expect(d.text).toContain('Code written / edited: what it was made of')
    const entry = d.all.find(el => el.type === 'Button' && String(el.props.label).startsWith('src/app.ts'))!
    expect(entry.props.label).toBe('src/app.ts ↗')
    // outside the session's folders the Files pane opens nothing; no file here either, so it says so
    await d.press(entry.props.key)
    expect(d.calls.map(c => c.path)).toContain('mcp.call')
    expect(d.calls.at(-1)).toEqual({ path: 'ui.toast', args: ['Could not find src/app.ts.'] })
  })

  test('the Overview: the tiles, the capped lists, the limits with this session’s part', () => {
    const d = drawTerminal({ tab: 'overview', live: true, measure: { state: 'idle' } })
    for (const s of ['Cost (API prices)', 'Weekly limit: this session', '3.5%', 'as of 20m ago', 'Where the money went', 'Where the time went', 'Cost per turn', 'Why caching matters']) {
      expect(d.text).toContain(s)
    }
    expect(d.all.filter(el => String(el.props.key).startsWith('row-cat-')).length).toBeLessThanOrEqual(5)
  })

  test('the Time tab: activities, turns, tools, and the slowest calls as rows that lead to the call', () => {
    const d = drawTerminal({ tab: 'time' })
    expect(d.text).toContain('Running terminal commands')
    expect(d.all.some(el => el.type === 'Markdown' && String(el.props.text).includes('| Tool |'))).toBe(true)
    expect(d.all.some(el => el.type === 'Button' && String(el.props.key).startsWith('pick-slow-'))).toBe(true)
    expect(d.all.filter(el => String(el.props.key).startsWith('pick-tt-')).length).toBe(3)
  })

  test('the Timeline: every turn, and the requests as one-line charts', () => {
    const d = drawTerminal({ tab: 'timeline', cols: 80 })
    expect(d.all.filter(el => String(el.props.key).startsWith('pick-turn-')).length).toBe(3)
    expect(d.text).toContain('Context sent per request')
    expect(d.text).toContain('Running total of the cost')
  })

  test('a preview: its first lines inline, the whole in the full view', async () => {
    const d = drawTerminal({ tab: 'overview', preview: PREVIEW })
    const code = d.all.find(el => el.type === 'Code')!
    expect(String(code.props.source).split('\n').length).toBe(12)
    expect(d.text).toContain('8 more lines')
    await d.press('preview-open')
    expect(d.calls.map(c => c.path)).toEqual(['state.set', 'ui.open'])
    expect(d.calls[0]!.args[1]).toEqual(PREVIEW)
    await d.press('preview-close')
    expect(d.calls).toEqual([{ path: 'state.set', args: ['preview', null] }])
  })
})

describe('the desktop pane', () => {
  test('draws every tab, its rows clickable where they filter or lead', () => {
    for (const tab of ['overview', 'timeline', 'content', 'time', 'top', 'agents']) {
      const $ = fakeEngine(elements(DESKTOP))
      const tree = renderDesktopPane($, { surface: 'desktop' } as any, context(report(), { tab, filter: { turns: [], cats: ['termout'] } }))
      const all = walk(tree)
      for (const el of all) expect(DESKTOP).toContain(el.type)
      if (tab !== 'agents') expect(all.some(el => el.type === 'Button' && String(el.props.key).startsWith('pick-'))).toBe(true)
    }
  })
})

describe('the pane’s actions', () => {
  test('a turn’s entry in a running session scrolls the chat; where that is refused, the turn shows in the pane', async () => {
    const calls: Call[] = []
    const raw = report()
    const act = paneActions(fakeEngine({}, calls), context(raw, { live: true }))
    const prompt = raw.groups.find(g => g.cat === 'prompt' && g.label === 'Build the thing please')!
    await act.goTo(prompt)
    await settle()
    expect(calls[0]!.path).toBe('ui.scroll')
    // the transcript is not readable here: the pane says it could not find it
    expect(calls.at(-1)).toEqual({ path: 'ui.toast', args: ['Could not find turn 1.'] })
  })
})
