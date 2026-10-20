import type { Register } from 'claude-code'

import { COMMAND, PANE, VIEW_PANE } from './constants'
import { renderAbovePrompt, renderSessionMode } from './footer'
import { dur, money, tok, toMarkdown } from './format'
import { promptKey, promptRows } from './leads'
import { emptyPane, readPane } from './pane'
import { renderDesktopPane, renderViewPane } from './pane-desktop'
import { renderTerminalPane } from './pane-terminal'
import { activeMsOf, closePopover, refreshCurrent, refreshPane } from './reports'

const PLUGIN = 'session-insights'
// a pane an earlier version opened from the footer; closed when the mod loads
const SUMMARY = 'session-insights-summary'
const STATUS = { plugin: 'session-insights', key: 'status' } as const

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Break this session’s tokens, cost and time down by content and activity',
      argumentHint: '[session-id] [export]',
      immediate: true,
    })
    // an earlier version kept weekly-limit readings here; nothing reads them now
    for (const key of await $.store.keys()) if (key.startsWith('limits:')) await $.store.delete(key)
    void $.ui.close({ id: SUMMARY })
    // a resumed session has turns already: show them in the footer
    $.clock.after(300, () => void refreshCurrent($))
    return next(e)
  })

  // the popover closes as a popover does: when the person turns to something
  // else (types, sends, presses anything but the popover's own buttons). The
  // app tells a plugin of no click elsewhere, so these stand in for one.
  on('prompt.edit', async ($, e, next) => {
    void closePopover($)
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    void closePopover($)
    return next(e)
  })
  on('ui.press', async ($, e, next) => {
    const isOwn = e.plugin === PLUGIN && (e.element === 'usage-toggle' || e.element === 'usage-details')
    if (!isOwn) void closePopover($)
    return next(e)
  })

  // learn each prompt's row id as the chat draws it, for a jump to its turn;
  // the drawing itself is the engine's, untouched
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!e.props.from && !e.props.task) promptRows.set(promptKey(e.props.text), e.requestId)
    return next(e)
  })

  // keep the footer and the pane current: once a turn of the main
  // conversation ends, analyze again, a moment later so the transcript has
  // its last rows
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) $.clock.after(1500, () => void refreshCurrent($))
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const wantsExport = words.includes('export')
    const sessionId = words.find(w => w !== 'export') ?? (await $.session.id())
    void $.ui.open({ id: PANE, title: 'Session usage', columns: 110 })
    const r = await refreshPane($, sessionId)
    if (!r) return { text: (await $.state.get(STATUS)).value || 'Could not analyze the session.' }
    if (wantsExport) {
      const path = `${await $.session.cwd()}/session-usage-${sessionId.slice(0, 8)}.md`
      await $.fs.write(path, toMarkdown(r))
      return { text: `Session usage report written to ${path}` }
    }
    return {
      text: `Session usage: ${money(r.cost.total)} at API prices (${money(r.cost.noCache)} without caching), ${tok(r.output.total)} output, ${dur(activeMsOf(r))} active. Details in the Session usage pane.`,
    }
  })

  // the footer's button, and the short summary it opens above the prompt
  on('ui.render', { component: 'SessionMode' }, ($, e, next) => renderSessionMode($, e, next))
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => renderAbovePrompt($, e, next))

  // the full view of a preview, in a tab of its own
  on('ui.render', { component: 'Pane', requestId: VIEW_PANE }, ($, e) => renderViewPane($, e))

  // the pane: charts where the surface draws SVG, text bars in the terminal
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p = await readPane($, e)
    if (!p.raw) return emptyPane($, e, p.note)
    return e.surface !== 'terminal' ? renderDesktopPane($, e, p) : renderTerminalPane($, e, p)
  })
}
