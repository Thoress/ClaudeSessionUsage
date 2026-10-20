// What the modules may do outside themselves. The engine follows `$` only
// into functions of the hooks module's own file, never across an import, so
// `register.tsx` hands the other modules this instead: one closure per call,
// each spelled `$.noun.event(...)` there. State goes by its key; the
// references live in `register.tsx` alone, as the loader wants them.

import type { EngineInterface, PluginState } from 'claude-code'

type E = EngineInterface
type S = PluginState['session-insights']

export type EnvName = 'CLAUDE_CONFIG_DIR' | 'USERPROFILE' | 'HOME' | 'OS' | 'TEMP' | 'SystemRoot'

/** This mod's state values, by key. A read while drawing subscribes the drawing, as `$.state.get` does. */
export type StatePort = {
  get: <K extends keyof S>(key: K) => Promise<{ value?: S[K] }>
  set: <K extends keyof S>(key: K, value: S[K]) => Promise<void>
}

export type Host = {
  state: StatePort
  /** The variables the modules read, by name; another throws. */
  env: { get: (name: EnvName) => Promise<string | undefined> }
  fs: Pick<E['fs'], 'list' | 'exists' | 'stat' | 'read' | 'write'>
  clock: Pick<E['clock'], 'now' | 'after'>
  process: Pick<E['process'], 'spawn' | 'run'>
  store: Pick<E['store'], 'get' | 'set'>
  session: Pick<E['session'], 'id' | 'cwd' | 'root' | 'usage'>
  ui: Pick<E['ui'], 'resolve' | 'toast' | 'scroll' | 'open'>
  mcp: Pick<E['mcp'], 'call'>
  /** The plugin's folder. */
  root: string
}
