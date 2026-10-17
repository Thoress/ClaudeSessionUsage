#!/usr/bin/env node
// Checks the rule the runtime enforces on state references: a ref
// (`const NAME = { plugin: '…', key: '…' } as const`) may only be passed to
// $.state.get / $.state.set, or spread into an object literal, in the file
// that defines it. A ref used anywhere else makes the runtime refuse the whole
// module, and `claude plugin validate` does not catch it (`REPORT.plugin` in a
// comparison broke loading once).
//
// usage: node scripts/check-state-refs.mjs [root]   (root defaults to the repo)
// prints `file:line: message` per finding and exits 1, or a one-line ok.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'))
const hooks = join(root, 'hooks')

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

// comments blanked to spaces, so a ref named in one is no finding and the
// offsets (and so the line numbers) stay as they are. only whole-line and
// ` // `-style trailing comments: telling a URL's // from a comment needs a
// real parser, and none is wanted here
const blank = s => s.replace(/[^\n]/g, ' ')
const stripComments = src =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[ \t])\/\/.*$/gm, (m, pre) => pre + blank(m.slice(pre.length)))

const DEF = /\b(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*plugin\s*:\s*(['"`])[^'"`]*\3\s*,\s*key\s*:\s*(['"`])[^'"`]*\4\s*,?\s*\}\s*as\s+const\b/dg
const IMPORT = /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\b/g
const CALL = /\$\.state\.(?:get|set)\s*(?:<[^()]*>)?\s*\(\s*$/

/** True when the `...` at `at` sits directly in an object literal's braces. */
function inObject(code, at) {
  let depth = 0
  for (let i = at - 1; i >= 0; i--) {
    const ch = code[i]
    if (ch === ')' || ch === ']' || ch === '}') depth++
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth === 0) return ch === '{'
      depth--
    }
  }
  return false
}

const files = walk(hooks).map(path => {
  const src = readFileSync(path, 'utf8')
  return { path, name: relative(root, path).replace(/\\/g, '/'), src, code: stripComments(src) }
})
const lineOf = (s, at) => s.slice(0, at).split('\n').length

const findings = []
const report = (f, at, msg) => findings.push({ name: f.name, line: lineOf(f.code, at), msg })

// every ref, by file
const refs = new Map()
for (const f of files) {
  const own = []
  for (const m of f.code.matchAll(DEF)) {
    const name = m[2]
    const nameAt = m.indices[2][0]
    own.push({ name, nameAt })
    if (m[1]) report(f, m.index, `state ref ${name} is exported; keep it in the one file that uses it`)
  }
  refs.set(f, own)
}
const allNames = new Set([...refs.values()].flat().map(r => r.name))

for (const f of files) {
  for (const { name, nameAt } of refs.get(f)) {
    for (const m of f.code.matchAll(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))) {
      const at = m.index
      if (at === nameAt) continue
      const before = f.code.slice(Math.max(0, at - 200), at)
      if (CALL.test(before)) continue
      if (/\.\.\.\s*$/.test(before) && inObject(f.code, at - before.match(/\.\.\.\s*$/)[0].length)) continue
      report(f, at, `state ref ${name} used outside $.state.get(${name}…) / $.state.set(${name}…); the runtime refuses the module`)
    }
  }
  // a ref imported from elsewhere: the runtime only accepts one defined in place
  for (const m of f.code.matchAll(IMPORT)) {
    for (const part of m[1].split(',')) {
      const local = part.trim().split(/\s+as\s+/).map(s => s.replace(/^type\s+/, '').trim())
      for (const id of local) {
        if (allNames.has(id)) report(f, m.index, `imports state ref ${id}; define it in this file instead`)
      }
    }
  }
}

if (findings.length > 0) {
  findings.sort((a, b) => a.name.localeCompare(b.name) || a.line - b.line)
  for (const x of findings) console.log(`${x.name}:${x.line}: ${x.msg}`)
  process.exit(1)
}
const n = [...refs.values()].reduce((s, r) => s + r.length, 0)
const m = [...refs.values()].filter(r => r.length > 0).length
console.log(`state refs ok (${n} ref${n === 1 ? '' : 's'} in ${m} file${m === 1 ? '' : 's'})`)
