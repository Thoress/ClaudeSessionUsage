import type { EngineInterface, Register } from 'claude-code'

import { COMMAND, PANE, VIEW_PANE } from './constants'
import { renderAbovePrompt, renderSessionMode } from './footer'
import { dur, money, tok, toMarkdown } from './format'
import type { Host, StatePort } from './host'
import { promptKey, promptRows } from './leads'
import { emptyPane, readPane } from './pane'
import { renderDesktopPane, renderViewPane } from './pane-desktop'
import { renderTerminalPane } from './pane-terminal'
import { activeMsOf, closePopover, refreshCurrent, refreshPane } from './reports'

const PLUGIN = 'session-insights'
// a pane an earlier version opened from the footer; closed when the mod loads
const SUMMARY = 'session-insights-summary'

// the state values, here alone: the loader takes a reference only as the
// argument of a $.state call in this file
const REPORT = { plugin: 'session-insights', key: 'report' } as const
const CURRENT = { plugin: 'session-insights', key: 'current' } as const
const TAB = { plugin: 'session-insights', key: 'tab' } as const
const STATUS = { plugin: 'session-insights', key: 'status' } as const
const FILTER = { plugin: 'session-insights', key: 'filter' } as const
const MEASURE = { plugin: 'session-insights', key: 'measure' } as const
const POPOVER = { plugin: 'session-insights', key: 'popover' } as const
const PREVIEW = { plugin: 'session-insights', key: 'preview' } as const
const VIEW = { plugin: 'session-insights', key: 'view' } as const

/**
 * What the other modules may do, as closures over this hook's `$`: the engine
 * follows `$` into this file's functions only, never across an import.
 */
function hostOf($: EngineInterface): Host {
  // `$.state` by key; each branch is a call the loader can list
  const state: StatePort = {
    get: (async (key: string) => {
      if (key === 'report') return $.state.get(REPORT)
      if (key === 'current') return $.state.get(CURRENT)
      if (key === 'tab') return $.state.get(TAB)
      if (key === 'status') return $.state.get(STATUS)
      if (key === 'filter') return $.state.get(FILTER)
      if (key === 'measure') return $.state.get(MEASURE)
      if (key === 'popover') return $.state.get(POPOVER)
      if (key === 'preview') return $.state.get(PREVIEW)
      if (key === 'view') return $.state.get(VIEW)
      throw new Error(`no state value ${key}`)
    }) as StatePort['get'],
    set: (async (key: string, value: any) => {
      if (key === 'report') return void (await $.state.set(REPORT, value))
      if (key === 'current') return void (await $.state.set(CURRENT, value))
      if (key === 'tab') return void (await $.state.set(TAB, value))
      if (key === 'status') return void (await $.state.set(STATUS, value))
      if (key === 'filter') return void (await $.state.set(FILTER, value))
      if (key === 'measure') return void (await $.state.set(MEASURE, value))
      if (key === 'popover') return void (await $.state.set(POPOVER, value))
      if (key === 'preview') return void (await $.state.set(PREVIEW, value))
      if (key === 'view') return void (await $.state.set(VIEW, value))
      throw new Error(`no state value ${key}`)
    }) as StatePort['set'],
  }
  type E = EngineInterface
  return {
    state,
    // the loader lists the variables a module reads: each by its literal name
    env: {
      get: async name => {
        if (name === 'CLAUDE_CONFIG_DIR') return $.env.get('CLAUDE_CONFIG_DIR')
        if (name === 'USERPROFILE') return $.env.get('USERPROFILE')
        if (name === 'HOME') return $.env.get('HOME')
        if (name === 'OS') return $.env.get('OS')
        if (name === 'TEMP') return $.env.get('TEMP')
        if (name === 'SystemRoot') return $.env.get('SystemRoot')
        throw new Error(`no environment variable ${name} in the host`)
      },
    },
    fs: {
      list: (...a: Parameters<E['fs']['list']>) => $.fs.list(...a),
      exists: (...a: Parameters<E['fs']['exists']>) => $.fs.exists(...a),
      stat: (...a: Parameters<E['fs']['stat']>) => $.fs.stat(...a),
      // two overloads (text, or bytes with options): both spelled out
      read: ((path: string, options?: any) => (options === undefined ? $.fs.read(path) : $.fs.read(path, options))) as E['fs']['read'],
      write: (...a: Parameters<E['fs']['write']>) => $.fs.write(...a),
    },
    clock: {
      now: (...a: Parameters<E['clock']['now']>) => $.clock.now(...a),
      after: (...a: Parameters<E['clock']['after']>) => $.clock.after(...a),
    },
    process: {
      spawn: ((...a: Parameters<E['process']['spawn']>) => $.process.spawn(...a)) as E['process']['spawn'],
      run: (...a: Parameters<E['process']['run']>) => $.process.run(...a),
    },
    store: {
      get: (...a: Parameters<E['store']['get']>) => $.store.get(...a),
      set: (...a: Parameters<E['store']['set']>) => $.store.set(...a),
    },
    session: {
      id: (...a: Parameters<E['session']['id']>) => $.session.id(...a),
      cwd: (...a: Parameters<E['session']['cwd']>) => $.session.cwd(...a),
      root: (...a: Parameters<E['session']['root']>) => $.session.root(...a),
      usage: (...a: Parameters<E['session']['usage']>) => $.session.usage(...a),
    },
    ui: {
      resolve: (e => $.ui.resolve(e)) as E['ui']['resolve'],
      toast: (...a: Parameters<E['ui']['toast']>) => $.ui.toast(...a),
      scroll: (...a: Parameters<E['ui']['scroll']>) => $.ui.scroll(...a),
      open: (...a: Parameters<E['ui']['open']>) => $.ui.open(...a),
    },
    mcp: { call: (...a: Parameters<E['mcp']['call']>) => $.mcp.call(...a) },
    root: $.plugin.root,
  }
}

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
    const host = hostOf($)
    $.clock.after(300, () => void refreshCurrent(host))
    return next(e)
  })

  // the popover closes as a popover does: when the person turns to something
  // else (types, sends, presses anything but the popover's own buttons). The
  // app tells a plugin of no click elsewhere, so these stand in for one.
  on('prompt.edit', async ($, e, next) => {
    void closePopover(hostOf($))
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    void closePopover(hostOf($))
    return next(e)
  })
  on('ui.press', async ($, e, next) => {
    const isOwn = e.plugin === PLUGIN && (e.element === 'usage-toggle' || e.element === 'usage-details')
    if (!isOwn) void closePopover(hostOf($))
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
    if (e.agentId === undefined) {
      const host = hostOf($)
      $.clock.after(1500, () => void refreshCurrent(host))
    }
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const host = hostOf($)
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const wantsExport = words.includes('export')
    const sessionId = words.find(w => w !== 'export') ?? (await $.session.id())
    void $.ui.open({ id: PANE, title: 'Session usage', columns: 110 })
    const r = await refreshPane(host, sessionId)
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

  // the footer's button, and the short summary it opens above the prompt;
  // a drawing left undefined is the engine's own
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => (await renderSessionMode(hostOf($), e)) ?? next(e))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await renderAbovePrompt(hostOf($), e)) ?? next(e))

  // the full view of a preview, in a tab of its own
  on('ui.render', { component: 'Pane', requestId: VIEW_PANE }, ($, e) => renderViewPane(hostOf($), e))

  // the pane: charts where the surface draws SVG, text bars in the terminal
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const host = hostOf($)
    const p = await readPane(host, e)
    if (!p.raw) return emptyPane(host, e, p.note)
    return e.surface !== 'terminal' ? renderDesktopPane(host, e, p) : renderTerminalPane(host, e, p)
  })
}
