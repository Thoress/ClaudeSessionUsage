import type { EngineInterface } from 'claude-code'

import type { UsageReport } from '../types'
import { buildReport, parseJsonl } from './analyze'

const FS_READ_LIMIT = 4 * 1024 * 1024

// ---------- finding and reading transcripts ----------

export async function configDir($: EngineInterface): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}/.claude`
}

export async function findTranscript($: EngineInterface, id: string): Promise<string | undefined> {
  const projects = `${await configDir($)}/projects`
  const guesses = [await $.session.root(), await $.session.cwd()].map(p => p.replace(/[^a-zA-Z0-9]/g, '-'))
  for (const g of guesses) {
    const f = `${projects}/${g}/${id}.jsonl`
    if (await $.fs.exists(f)) return f
  }
  for (const d of await $.fs.list(projects).catch(() => [])) {
    if (d.kind !== 'dir') continue
    const f = `${projects}/${d.name}/${id}.jsonl`
    if (await $.fs.exists(f)) return f
  }
  return undefined
}

/** Reads a text file of any size: past $.fs.read's 4 MiB, through a child. */
export async function readText($: EngineInterface, path: string): Promise<string> {
  const { size } = await $.fs.stat(path)
  if (size <= FS_READ_LIMIT) return $.fs.read(path)
  const isWindows = /^[A-Za-z]:/.test(path) || (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['cmd', '/d', '/c', 'type', path.replace(/\//g, '\\')] : ['cat', path]
  let text = ''
  for await (const chunk of $.process.spawn({ argv })) if (chunk.stream === 'stdout') text += chunk.text
  return text
}

export async function analyze($: EngineInterface, sessionId: string): Promise<UsageReport> {
  const file = await findTranscript($, sessionId)
  if (!file) throw new Error(`No transcript found for session ${sessionId}.`)
  const main = parseJsonl(await readText($, file))
  const dir = `${file.replace(/\.jsonl$/, '')}/subagents`
  const subagents: { id: string; rows: ReturnType<typeof parseJsonl> }[] = []
  if (await $.fs.exists(dir)) {
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      subagents.push({ id: f.name.replace(/^agent-/, '').replace(/\.jsonl$/, ''), rows: parseJsonl(await readText($, `${dir}/${f.name}`)) })
    }
  }
  return compact(buildReport(sessionId, file, main, subagents, await $.clock.now()))
}

/** Rounds every fraction to 5 significant digits: the state stays small. */
export const compact = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(5)) : v)))
