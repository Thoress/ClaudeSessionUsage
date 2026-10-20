import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { BUCKETS, CATS } from './analyze'
import { bar, cachingStory, cut, dur, mdAgentTable, mdCostTable, money, pct, tok } from './format'
import type { PaneContext } from './pane'
import { activeMsOf } from './reports'

/** The pane on the terminal: text bars. */
export function renderTerminalPane($: EngineInterface, e: RenderInput<'Pane', 'terminal'>, ctx: PaneContext): RenderElement {
  const { r, v, cols, filter, note, tabs, current, setTab, exportReport, refreshNow } = ctx
  const activeMs = activeMsOf(r)
  const idleMs = r.time.find(t => t.id === 'idle')?.ms ?? 0

  const { Box, Text, Button, Markdown } = $.ui.resolve(e)
  const inputTotal = r.input.uncached + r.input.cacheWrite + r.input.cacheRead
  const labelW = Math.min(36, Math.floor(cols * 0.36))
  const barW = Math.max(6, cols - labelW - 28)

  const row = (p: { label: string; color: string; frac: number; value: string; dim?: boolean }) => (
    <Box flexDirection="row">
      <Box width={labelW}>
        <Text dimColor={p.dim} wrap="truncate-end">
          {cut(p.label, labelW - 1)}
        </Text>
      </Box>
      <Box width={barW}>
        <Text color={p.color}>{bar(p.frac, barW)}</Text>
      </Box>
      <Text dimColor={p.dim}> {p.value}</Text>
    </Box>
  )
  const heading = (title: string) => (
    <Box marginTop={1}>
      <Text bold>{title}</Text>
    </Box>
  )

  let body
  if (current === 'timeline') {
    const maxCost = Math.max(1e-9, ...r.turnRows.map(t => t.cost))
    body = (
      <Box flexDirection="column">
        {heading('Cost per turn')}
        {r.turnRows.map(t =>
          row({ label: `${t.turn}. ${t.prompt}`, color: '#2a78d6', frac: t.cost / maxCost, value: `${money(t.cost)} · ${t.requests} req · ctx ${tok(t.contextAtEnd)}`, dim: v.turns.size > 0 && !v.turns.has(t.turn) }),
        )}
      </Box>
    )
  } else if (current === 'content') {
    const byProcessed = [...r.cats].filter(c => c.processed > 0).sort((a, b) => b.processed - a.processed)
    const byOutput = [...r.cats].filter(c => c.output >= 1).sort((a, b) => b.output - a.output)
    body = (
      <Box flexDirection="column">
        {heading('Input: what filled the context (added → sent in total)')}
        {byProcessed.map(c =>
          row({ label: c.label, color: c.color, frac: c.processed / Math.max(1, inputTotal), value: `${tok(c.added)} → ${tok(c.processed)} · ${money(c.inputCost)}` }),
        )}
        {heading('Output: what Claude generated')}
        {byOutput.map(c =>
          row({ label: c.label, color: c.color, frac: c.output / Math.max(1, r.output.total), value: `${tok(c.output)} · ${money(c.outputCost)}` }),
        )}
      </Box>
    )
  } else if (current === 'time') {
    const maxTool = Math.max(1, ...r.tools.map(t => t.ms))
    body = (
      <Box flexDirection="column">
        {heading('Where the active time went')}
        {r.time
          .filter(t => t.id !== 'idle')
          .sort((a, b) => b.ms - a.ms)
          .map(t => row({ label: t.label, color: t.color, frac: t.ms / Math.max(1, activeMs), value: `${dur(t.ms)}  ${pct(t.ms, activeMs)}` }))}
        {idleMs > 0 && row({ label: BUCKETS.idle!.label, color: BUCKETS.idle!.color, frac: 0, value: dur(idleMs), dim: true })}
        {heading('Tools (calls · total · avg · result tokens)')}
        {r.tools.slice(0, 20).map(t =>
          row({
            label: t.tool.replace(/^mcp__/, ''),
            color: '#3fa36b',
            frac: t.ms / maxTool,
            value: `${t.calls}× ${dur(t.ms)} · ${dur(t.ms / Math.max(1, t.calls))} · ${tok(t.resultTokens)}`,
          }),
        )}
      </Box>
    )
  } else if (current === 'top') {
    const max = Math.max(1e-9, r.top[0]?.cost ?? 0)
    body = (
      <Box flexDirection="column">
        {heading('Most expensive items (cost · pieces)')}
        {r.top.map(t => row({ label: t.label, color: CATS[t.cat]?.color ?? '#888', frac: t.cost / max, value: `${money(t.cost)}${t.reads > 1 ? ` · ${t.reads}×` : ''}` }))}
      </Box>
    )
  } else if (current === 'agents') {
    body = <Markdown text={mdAgentTable(r)} />
  } else {
    body = (
      <Box flexDirection="column">
        <Markdown text={mdCostTable(r)} />
        <Markdown text={cachingStory(r)} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {tabs.map(([id, label]) => (
          <Button key={`tab-${id}`} variant={current === id ? 'primary' : 'secondary'} onPress={setTab(id)}>
            {label}
          </Button>
        ))}
        <Button key="refresh" dimColor onPress={refreshNow}>
          Refresh
        </Button>
        <Button key="export" dimColor onPress={exportReport}>
          Export .md
        </Button>
      </Box>
      <Text dimColor>
        {`${r.turns} turns · ${r.requests} requests · ${dur(activeMs)} active · context now ${tok(r.contextNow)}`}
        {v.isFiltered ? ` · filtered: ${[...filter.turns.map(t => `turn ${t}`), ...filter.cats.map(c => CATS[c]?.label ?? c)].join(', ')}` : ''}
        {note ? ` · ${note}` : ''}
      </Text>
      {body}
    </Box>
  )
}
