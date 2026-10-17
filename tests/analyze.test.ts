import { describe, expect, test } from 'claude-code/testing'

import { buildReport } from '../hooks/analyze'
import {
  agentsTable,
  contextChart,
  costChart,
  cumulativeChart,
  framed,
  infoIcon,
  itemChart,
  miniBar,
  overviewTop,
  ring,
  slowChart,
  summaryCard,
  timeChart,
  toolsTable,
  tooltipCard,
} from '../hooks/charts'
import { NO_FILTER, applyFilter, detailsOf, viewOf } from '../hooks/filter'
import { dur, money, tok, toMarkdown } from '../hooks/format'
import { pack, requestCosts, scanLine, unpack, windowShare } from '../hooks/limits'

const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const usage = (ctxRead: number, ctxWrite: number, output: number, thinking: number) => ({
  input_tokens: 2,
  cache_creation_input_tokens: ctxWrite,
  cache_read_input_tokens: ctxRead,
  output_tokens: output,
  output_tokens_details: { thinking_tokens: thinking },
})

// prompt → request 1 (thinking + Bash) → result → request 2 (Write) →
// result → request 3 (reply) → stop; then 10 min idle; second prompt → reply
const ROWS = [
  { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'Build the thing please' } },
  { type: 'attachment', uuid: 'a1', timestamp: at(0.1), attachment: { type: 'instructions' }, rendered: [{ content: 'x'.repeat(3600) }] },
  { type: 'assistant', uuid: 'm1a', timestamp: at(4), message: { id: 'm1', usage: usage(0, 20000, 300, 200), content: [{ type: 'thinking', thinking: '' }] } },
  { type: 'assistant', uuid: 'm1b', timestamp: at(5), message: { id: 'm1', usage: usage(0, 20000, 300, 200), content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', uuid: 'r1', timestamp: at(35), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok '.repeat(3000) }] } },
  { type: 'assistant', uuid: 'm2', timestamp: at(45), message: { id: 'm2', usage: usage(20000, 3000, 900, 0), content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/app.ts', content: 'const a = 1\n'.repeat(250) } }] } },
  { type: 'user', uuid: 'r2', timestamp: at(46), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'File written' }] } },
  { type: 'assistant', uuid: 'm3', timestamp: at(50), message: { id: 'm3', usage: usage(23000, 1000, 50, 0), content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: at(51) },
  { type: 'user', uuid: 'u2', timestamp: at(651), message: { role: 'user', content: 'thanks' } },
  { type: 'assistant', uuid: 'm4', timestamp: at(653), message: { id: 'm4', usage: usage(24000, 100, 10, 0), content: [{ type: 'text', text: 'You are welcome.' }] } },
]

describe('buildReport', () => {
  const r = buildReport('s', 'f.jsonl', ROWS, [], T0 + 700_000)

  test('totals are the API usage, summed over requests', () => {
    expect(r.requests).toBe(4)
    expect(r.turns).toBe(2)
    expect(r.input.cacheWrite).toBe(24100)
    expect(r.output.total).toBe(1260)
    expect(r.output.thinking).toBe(200)
  })

  test('processed context adds up to the billed input', () => {
    const processed = r.cats.reduce((s, c) => s + c.processed, 0)
    const billed = r.input.uncached + r.input.cacheWrite + r.input.cacheRead
    expect(Math.round(processed)).toBe(billed)
    const output = r.cats.reduce((s, c) => s + c.output, 0)
    expect(Math.round(output)).toBe(r.output.total)
  })

  test('content lands in its category', () => {
    const cat = (id: string) => r.cats.find(c => c.id === id)
    expect(cat('termout')!.added).toBeGreaterThan(2000)
    expect(cat('code_write')!.output).toBeGreaterThan(800)
    expect(cat('cmd')!.output).toBeGreaterThan(0)
    expect(cat('instructions')!.added).toBeGreaterThan(0)
    expect(cat('sys')!.added).toBeGreaterThan(15000)
  })

  test('time splits model, tools and idle', () => {
    const ms = (id: string) => r.time.find(t => t.id === id)?.ms ?? 0
    expect(ms('t_terminal')).toBe(30_000)
    expect(ms('idle')).toBe(600_000)
    expect(ms('model')).toBeGreaterThan(10_000)
    expect(r.tools.find(t => t.tool === 'Bash')!.calls).toBe(1)
  })
})

describe('format', () => {
  test('numbers read short', () => {
    expect(tok(950)).toBe('950')
    expect(tok(12_345)).toBe('12k')
    expect(tok(2_500_000)).toBe('2.50M')
    expect(dur(42_000)).toBe('42s')
    expect(dur(125_000)).toBe('2m 05s')
    expect(dur(3_900_000)).toBe('1h 05m')
  })

  test('the markdown export carries every section', () => {
    const md = toMarkdown(buildReport('abc', 'f.jsonl', ROWS, [], T0 + 700_000))
    for (const heading of ['## Tokens and cost', '## Turns', '## By content', '## Time', '## Most expensive single items']) {
      expect(md.includes(heading)).toBe(true)
    }
    expect(md.includes('Terminal output')).toBe(true)
    expect(md.includes('Why caching matters')).toBe(true)
  })

  test('money reads short', () => {
    expect(money(123.4)).toBe('$123')
    expect(money(6.456)).toBe('$6.46')
    expect(money(0.0042)).toBe('$0.004')
    expect(money(0)).toBe('$0')
  })
})

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

describe('cost', () => {
  const r = buildReport('s', 'f.jsonl', ROWS, [], T0 + 700_000)

  test('is priced from the usage, and the parts add up', () => {
    // no model named: priced as Claude Opus 5.5, every write at the 5-minute rate
    expect(r.price.isKnown).toBe(false)
    expect(near(r.cost.read, ((20000 + 23000 + 24000) * 0.2) / 1e6)).toBe(true)
    expect(near(r.cost.write, ((20000 + 3000 + 1000 + 100) * 4 * 1.25) / 1e6)).toBe(true)
    expect(near(r.cost.output, (1260 * 20) / 1e6)).toBe(true)
    const byContent = r.cats.reduce((s, c) => s + c.inputCost + c.outputCost, 0)
    expect(near(byContent, r.cost.total)).toBe(true)
    const byTurn = r.turnRows.reduce((s, t) => s + t.cost, 0)
    expect(near(byTurn, r.cost.total)).toBe(true)
    expect(r.cost.noCache).toBeGreaterThan(r.cost.total)
    expect(r.series.length).toBe(4)
  })

  test('a pause past the cache lifetime shows as a rebuild', () => {
    const model = 'claude-opus-5-5'
    const big = (read: number, write: number) => ({
      input_tokens: 0,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
      output_tokens: 10,
      output_tokens_details: { thinking_tokens: 0 },
    })
    const rows = [
      { type: 'user', uuid: 'p1', timestamp: at(0), message: { role: 'user', content: 'go' } },
      { type: 'assistant', uuid: 'a1', timestamp: at(2), message: { id: 'a1', model, usage: big(0, 40000), content: [{ type: 'text', text: 'ok' }] } },
      { type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: at(3) },
      { type: 'user', uuid: 'p2', timestamp: at(2 * 3600), message: { role: 'user', content: 'again' } },
      { type: 'assistant', uuid: 'a2', timestamp: at(2 * 3600 + 2), message: { id: 'a2', model, usage: big(0, 40100), content: [{ type: 'text', text: 'ok' }] } },
    ]
    const b = buildReport('s', 'f.jsonl', rows, [], T0 + 3 * 3600_000)
    expect(b.price.isKnown).toBe(true)
    expect(b.breaks.length).toBe(1)
    expect(b.breaks[0]!.reason).toContain('over an hour')
    expect(b.series[1]!.isBreak).toBe(true)
    expect(b.cost.rebuild).toBeGreaterThan(0)
    expect(b.ttl.w1h).toBe(80100)
  })

  test('every chart draws, with a card for every hover target', () => {
    const all = [
      overviewTop(r),
      timeChart(r),
      timeChart(r, 2, 'Top', 'all elsewhere'),
      contextChart(r),
      contextChart(r, true),
      costChart(r),
      costChart(r, true),
      cumulativeChart(r),
      itemChart(r),
      toolsTable(r),
      slowChart(r),
      agentsTable(r),
      summaryCard(r),
    ]
    for (const source of all) {
      expect(source.startsWith('<svg')).toBe(true)
      const targets = source.match(/class="[^"]*\bh\d+"/g)?.length ?? 0
      const cards = source.match(/class="tip t\d+"/g)?.length ?? 0
      expect(cards).toBe(targets)
    }
    // one column per request, and the (i) inside the title's own text
    expect(contextChart(r).match(/class="hit h\d+"/g)?.length).toBe(4)
    expect(/class="t f16 b icon h0">Context sent per request<tspan[^>]*>ⓘ<\/tspan><\/text>/.test(contextChart(r))).toBe(true)
  })

  test('the small pictures carry their tooltip as a title', () => {
    const b = miniBar([{ v: 2, cls: 'read' }, { v: 1, cls: 'out' }], 3, 200, 'Code written: $2', { isSelected: true })
    expect(b.includes('<title>Code written: $2</title>')).toBe(true)
    expect(b.includes('class="sel"')).toBe(true)
    expect(miniBar([{ v: 1, cls: 'read' }], 3, 200, 'x', { isDimmed: true }).includes('opacity="0.35"')).toBe(true)
    expect(ring(25, 'a\nb').includes('<title>a\nb</title>')).toBe(true)
    expect(infoIcon('why').includes('<title>why</title>')).toBe(true)
  })

  test('a long session stays under the Svg size limit', () => {
    const many = Array.from({ length: 1200 }, (_, k) => ({
      at: T0 + k * 1000,
      turn: 1 + Math.floor(k / 40),
      read: 1000 * k,
      write: 500,
      output: 200,
      thinking: 50,
      costRead: 0.001,
      costWrite: 0.002,
      costOutput: 0.003,
      isBreak: k === 600,
    }))
    const big = { ...r, series: many }
    for (const source of [contextChart(big), costChart(big), cumulativeChart(big)]) {
      expect(source.length).toBeLessThan(131072)
      expect(source.match(/class="hit h\d+"/g)?.length).toBe(80)
    }
  })

  test('the tiles lead with this session’s part of each limit', () => {
    const live = {
      ...r,
      live: {
        contextTokens: 250_000,
        contextWindow: 1_000_000,
        limits: [
          { kind: 'seven_day', percentUsed: 79, resetsAt: new Date(T0 + 3 * 86_400_000).toISOString(), session: 2.8, sessionUsd: 22.39, totalUsd: 634, sessions: 51 },
          { kind: 'five_hour', percentUsed: 38, resetsAt: new Date(T0 + 3_600_000).toISOString(), session: 22, sessionUsd: 22.39, totalUsd: 38.63, sessions: 3 },
        ],
      },
    }
    const top = overviewTop(live)
    for (const s of ['Context used', '25%', 'Weekly limit: this session', '>2.8%<', '79% used in all', '5-hour limit: this session', '>22%<', '38% used in all', '50 other sessions']) {
      expect(top.includes(s)).toBe(true)
    }
    expect(top.includes('Without caching<')).toBe(false)
    // before the shares are measured
    const pending = { ...live, live: { ...live.live, limits: [{ kind: 'five_hour', percentUsed: 38 }] } }
    expect(overviewTop(pending).includes('measuring…')).toBe(true)
    // without a live session the limits say why they are empty
    expect(overviewTop(r).includes('subscription only')).toBe(true)
  })
})

describe('share of a limit', () => {
  const row = (id: string, at: number, usage: object, model = 'claude-opus-5-5') =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, model, usage, content: [] } })

  test('each request is priced once, at its model’s prices', () => {
    const u = { input_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, output_tokens: 100_000 }
    const text = [row('m1', T0, u), row('m1', T0 + 1, u), '{"type":"user","message":{"content":"output_tokens"}}', row('m2', T0 + 2, u, 'claude-sonnet-5-5')].join('\n')
    const points = requestCosts(text)
    expect(points.length).toBe(2)
    expect(near(points[0]!.usd, 0.2 + 2)).toBe(true)
    expect(near(points[1]!.usd, 0.2 + 1)).toBe(true)
  })

  test('is the session’s cost inside the window against all local sessions', () => {
    const p = (id: string, at: number, usd: number) => ({ id, at, usd })
    const bySession = new Map([
      ['me', [p('a', 100, 1), p('b', 200, 3)]],
      ['other', [p('c', 50, 10), p('d', 250, 1)]],
      // a subagent's request kept twice counts once
      ['me-again', [p('b', 200, 3)]],
    ])
    const s = windowShare(40, 150, 'me', bySession)
    expect(s.sessionUsd).toBe(3)
    expect(s.totalUsd).toBe(4)
    expect(s.session).toBe(30)
    expect(s.sessions).toBe(2)
  })

  test('the store keeps a compact copy of each file’s requests', () => {
    const points = [{ at: 1_700_000_000_123, usd: 0.1234567, id: 'msg_0123456789abcdef' }]
    const back = unpack(pack(points))
    expect(back[0]!.at).toBe(1_700_000_000_000)
    expect(near(back[0]!.usd, 0.123457)).toBe(true)
    expect(back[0]!.id).toBe('456789abcdef')
  })
})

describe('filter', () => {
  const r = buildReport('s', 'f.jsonl', ROWS, [], T0 + 700_000)

  test('no filter leaves the report as it is', () => {
    const f = applyFilter(r, NO_FILTER)
    expect(f.cost.total).toBe(r.cost.total)
    expect(f.series.length).toBe(r.series.length)
  })

  test('the turns split the whole: their parts add up to the session', () => {
    const one = applyFilter(r, { turns: [1], cats: [] })
    const two = applyFilter(r, { turns: [2], cats: [] })
    expect(near(one.cost.total + two.cost.total, r.cost.total)).toBe(true)
    expect(one.series.every(p => p.turn === 1)).toBe(true)
    expect(two.series.length).toBe(1)
    expect(near(one.cost.read + one.cost.write + one.cost.output, one.cost.total)).toBe(true)
    // time and tools follow the turn
    expect(one.tools.find(t => t.tool === 'Bash')?.calls).toBe(1)
    expect(two.tools.length).toBe(0)
    expect(two.time.find(t => t.id === 'idle')).toBeUndefined()
  })

  test('kinds of content split the whole too, and the requests follow', () => {
    const term = applyFilter(r, { turns: [], cats: ['termout'] })
    expect(term.cats.map(c => c.id)).toEqual(['termout'])
    expect(term.cost.write).toBe(0)
    const kinds = r.cats.map(c => c.id)
    const parts = kinds.reduce((s, cat) => s + applyFilter(r, { turns: [], cats: [cat] }).cost.total, 0)
    expect(near(parts, r.cost.total)).toBe(true)
    const perRequest = term.series.reduce((s, p) => s + p.costRead + p.costOutput, 0)
    expect(near(perRequest, term.cost.total)).toBe(true)
  })

  test('a kind of content lists what it was made of', () => {
    const code = detailsOf(r, 'code_write', viewOf(NO_FILTER))
    expect(code[0]?.label).toBe('src/app.ts')
    expect(code[0]!.cost > 0).toBe(true)
    // within a turn that did not touch it, nothing
    expect(detailsOf(r, 'code_write', viewOf({ turns: [2], cats: [] })).every(g => g.cost < 0.01)).toBe(true)
  })
})

describe('scan', () => {
  test('a line of the scan names the file and prices the request', () => {
    const s = scanLine('C:\\x\\a.jsonl\t2026-10-17T10:00:00.000Z\tmsg_1\tclaude-opus-5-5\t0\t1000000\t0\t\t\t100000\r')!
    expect(s.file).toBe('C:\\x\\a.jsonl')
    expect(s.point.id).toBe('msg_1')
    expect(near(s.point.usd, 0.2 + 2)).toBe(true)
    expect(scanLine('C:\\x\\a.jsonl\t2026-10-17T10:00:00.000Z\t\t<synthetic>\t0\t0\t0\t0\t0\t0')).toBeUndefined()
    expect(scanLine('garbage')).toBeUndefined()
  })
})

describe('footer', () => {
  const r = buildReport('s', 'f.jsonl', ROWS, [], T0 + 700_000)
  test('the tooltip and the popover float on an opaque card', () => {
    const tip = tooltipCard(r)
    expect(tip.includes('class="cardbg"')).toBe(true)
    expect(tip.includes('Session usage')).toBe(true)
    expect(tip.includes('Click for details')).toBe(true)
    const pop = framed(summaryCard(r), 'Session usage', 44)
    // the card leaves 44px under the summary for the buttons laid over it
    const inner = summaryCard(r).match(/height="(\d+)"/)![1]
    expect(pop.match(/height="(\d+)"/)![1]).toBe(String(Number(inner) + 28 + 30 + 44))
  })
})
