import type { RenderElement, RenderInput } from 'claude-code'

import type { UsageReport } from '../types'
import { summaryCard, svgSize } from './charts'
import { PANE, PX_PER_COLUMN } from './constants'
import { dur, money, tok } from './format'
import { activeMsOf, refreshPane, reports, warmUp } from './reports'
import type { Host } from './host'


/** One line per figure, for the footer's hover. */
function summaryText(r: UsageReport): string {
  const lines = [`Session usage: ${money(r.cost.total)} at API prices (${money(r.cost.noCache)} without caching)`]
  for (const [kind, name] of [
    ['five_hour', '5-hour limit'],
    ['seven_day', 'Weekly limit'],
  ] as const) {
    const l = r.live?.limits.find(x => x.kind === kind)
    if (l) lines.push(`${name}: this session ${l.session === undefined ? 'measuring…' : `≈ ${l.session.toFixed(1)}%`} (${Math.round(l.percentUsed)}% used in all)`)
  }
  if (r.live) {
    const ctx = r.live.contextPercent ?? (100 * (r.live.contextTokens ?? r.contextNow)) / Math.max(1, r.live.contextWindow)
    lines.push(`Context: ${Math.round(ctx)}% · ${tok(r.live.contextTokens ?? r.contextNow)} of ${tok(r.live.contextWindow)}`)
  }
  lines.push(`Active ${dur(activeMsOf(r))} · ${r.turns} turns`, 'Click for more')
  return lines.join('\n')
}

// the footer: one button whose name is the figure itself (the desktop draws
// a footer button by its label alone: no pictures, nothing floating). Its
// ring glyph fills with this session's part of the 5-hour limit, else the
// context's fill. A click opens the short summary in the band above the
// prompt, the nearest place to the button that draws a card.
export async function renderSessionMode(
  host: Host,
  e: RenderInput<'SessionMode'>,
): Promise<RenderElement | undefined> {
  if (e.surface === 'terminal') return undefined
  const { value: r } = await host.state.get('current')
  // no report yet, or one of the session before a /clear: ask for one now
  // rather than at the end of the next turn
  if (!r || r.sessionId !== (await host.session.id())) {
    warmUp(host)
    if (!r) return undefined
  }
  const { value: isOpen = false } = await host.state.get('popover')
  const { Box, Text, Button } = host.ui.resolve(e)
  const five = r.live?.limits.find(l => l.kind === 'five_hour')
  const ctx = r.live ? (r.live.contextPercent ?? (100 * (r.live.contextTokens ?? r.contextNow)) / Math.max(1, r.live.contextWindow)) : 0
  const percent = five?.session ?? ctx
  const glyph = percent < 12.5 ? '○' : percent < 37.5 ? '◔' : percent < 62.5 ? '◑' : percent < 87.5 ? '◕' : '●'
  const figure = five?.session !== undefined ? `${glyph} ${Math.round(five.session)}% of 5h · ${money(r.cost.total)}` : `${glyph} ${money(r.cost.total)}`
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {e.props.modes.length > 0 ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : null}
      {/* the footer draws a button's label alone, no chrome: no-break spaces pad it */}
      <Button plain key="usage-toggle" label={`  ${figure}${isOpen ? ' ▴' : ' ▾'}  `} onPress={() => void host.state.set('popover', !isOpen)} />
    </Box>
  )
}

// the short summary, in the band above the prompt while the footer's button has it open
export async function renderAbovePrompt(
  host: Host,
  e: RenderInput<'AbovePrompt'>,
): Promise<RenderElement | undefined> {
  if (e.surface === 'terminal' || e.props.hasSurvey) return undefined
  const { value: isOpen = false } = await host.state.get('popover')
  const { value: r } = await host.state.get('current')
  if (!isOpen || !r) return undefined
  const { value: measure } = await host.state.get('measure')
  const { Box, Button, Svg } = host.ui.resolve(e)
  // as wide as the app's own context card, narrower only in a narrow window
  const card = summaryCard(r, measure, Math.min(380, Math.max(260, e.props.bodyColumns * PX_PER_COLUMN - 24)))
  const { width, height } = svgSize(card)
  const openDetails = async () => {
    await host.state.set('popover', false)
    await host.ui.open({ id: PANE, title: 'Session usage', columns: 110 })
    const { value: ref } = await host.state.get('report')
    if (!ref || ref.sessionId !== r.sessionId || !reports.has(r.sessionId)) await refreshPane(host, r.sessionId)
  }
  // the band is the app's, as wide as the prompt; the card sits in its middle
  return (
    <Box flexDirection="column" alignItems="center" width="100%">
      <Box flexDirection="column" gap={1} width={Math.ceil(width / PX_PER_COLUMN) + 1}>
        <Svg source={card} alt={summaryText(r)} width={width} height={height} isInteractive />
        <Box flexDirection="row">
          <Button key="usage-details" onPress={() => void openDetails()}>
            Show the full breakdown
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
