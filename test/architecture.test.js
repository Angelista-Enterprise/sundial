// Architecture fences (docs/release/12-autonomy/W4 F1–F8, W6 F9–F11). Regexes over the
// source, not a linter: each fence counts its violations per file and holds
// them to a recorded map. The maps are ratchets — a count may go down, never
// up — and a count that went down fails too, so the map is lowered in the same
// commit that earned it and the review shows it.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = execFileSync('git', ['ls-files', 'packages', 'plugins'], { cwd: REPO, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|js)$/.test(f) && !f.includes('/dist/') && !f.includes('/node_modules/'))
const read = (f) => readFileSync(join(REPO, f), 'utf8')
const isTest = (f) => /\.test\.(ts|js)$/.test(f)
const count = (text, re) => (text.match(re) ?? []).length

/** Counts per file, zeros dropped, so the recorded map names only offenders. */
const tally = (files, measure) => Object.fromEntries(files.map((f) => [f, measure(read(f))]).filter(([, n]) => n > 0))

/** Every file at or under its recorded count, and (unless the map is a ceiling) every recorded count still earned. */
function ratchet(actual, recorded, { ceiling = false } = {}) {
  const over = Object.entries(actual).filter(([f, n]) => n > (recorded[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${recorded[f] ?? 0}`)
  const slack = ceiling ? [] : Object.entries(recorded).filter(([f, n]) => (actual[f] ?? 0) < n).map(([f, n]) => `${f}: ${actual[f] ?? 0} < ${n} (lower the ratchet)`)
  expect({ over, slack }).toEqual({ over: [], slack: [] })
}

// F1: no source file over 1,200 lines, except these, each held to its size. A ceiling: a split
// that frees lines leaves room under it, and the number is lowered when a split lands.
const MAX_LINES = 1200
const OVER = {
  'plugins/sundial-theme/shell/app.js': 3710,
  'packages/harness-runtime/src/runtime.ts': 2199,
  'plugins/sundial-theme/shell/stage.js': 1696,
}
// W4's acceptance sizes, held as ceilings once reached (Phase 5): the host's entry, the shell mount, the
// views' index. `KernelState` itself is its slice interfaces (state/<domain>.ts), at most 90 lines.
const BUDGET = {
  'plugins/sundial-theme/index.js': 400,
  'plugins/sundial-theme/host/server.js': 700,
  'plugins/sundial-theme/shell/views.js': 150,
}

// F2: no loopback fetch in the tools, the theme's host code or the kernel; no internal token outside the fence.
const LOOPBACK_SCOPE = FILES.filter((f) => !isTest(f) && (f.startsWith('plugins/sundial-tools/') || f.startsWith('packages/kernel/src/') || f === 'plugins/sundial-theme/index.js' || f.startsWith('plugins/sundial-theme/host/')))
const LOOPBACK = {}
const INTERNAL_HEADERS = {}

// F3: route files do not import the database; rules never do.
const ROUTE_FILES = ['plugins/sundial-theme/index.js', ...FILES.filter((f) => /^plugins\/sundial-theme\/host\/(routes-|api-|http|server)/.test(f))]
const DB_IMPORTS = {}

// F4: host modules keep no state of their own: no top-level (or apply-level) `let`, no `setInterval(`.
const HOST_FILES = FILES.filter((f) => f.startsWith('plugins/') && f.endsWith('.js') && !isTest(f) && !f.includes('/shell/'))
const HOST_STATE = {
  'plugins/sundial-kernel/index.js': 1,
  'plugins/sundial-llm-openai/index.js': 7,
  'plugins/sundial-proactive/delivery.js': 1,
  'plugins/sundial-proactive/index.js': 2,
  'plugins/sundial-proactive/night-shift.js': 1,
  'plugins/sundial-proactive/work.js': 3,
  'plugins/sundial-theme/host/api-config.js': 1,
  'plugins/sundial-theme/host/api-sessions.js': 1,
  'plugins/sundial-theme/host/signin-log.js': 3,
  'plugins/sundial-web-browser/browser-page.js': 2,
  'plugins/sundial-web-browser/cdp.js': 3,
  'plugins/sundial-web-browser/launcher.js': 3,
  'plugins/sundial-web-browser/page-session.js': 1,
}

// F5: the kernel's tools (and read/, when it lands) take their clock as an argument.
const CLOCK_SCOPE = FILES.filter((f) => !isTest(f) && /^packages\/kernel\/src\/(read|tools)\//.test(f))
const CLOCK = {}

// F6: the shared words are spelled once, in helpers' vocab.ts (W4 step 2).
const VOCAB = /'gnomon-companion'|'useful', '(wrong|not-now)', '(wrong|not-now)'|'person', 'project', 'tool'/g
const VOCAB_COPIES = {}

// F8 (W5 step 6): a number shown to the model or the owner comes from the calibrated-parameter
// slice (`formatParam`), not a literal. A scan of the prompt builders' code lines for a written-in
// reliability ("about 27%", "27% reliable", "27% of the time"); comments may cite the history.
const PROMPT_BUILDERS = FILES.filter((f) => !isTest(f) && (f.startsWith('packages/kernel/src/') || f.startsWith('plugins/sundial-tools/') || f.startsWith('plugins/sundial-proactive/') || f === 'plugins/sundial-theme/shell/app.js' || f.startsWith('plugins/sundial-theme/host/')))
const GUESSES = /about \d+ ?%|\d+ ?% (reliable|of the time)/gi
const code = (t) => t.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
const LITERAL_RELIABILITY = {}


// F9–F11 (W6): every event type a rule reads has a producer, every type written has a reader,
// every `experiments` switch is read. An allow-list entry says why and since when; the lists
// are ratchets like the maps above: an entry that is no longer needed fails too.
const TYPE = '[a-z][a-z0-9-]*:[a-z][a-z0-9:-]*'
const SOURCE = FILES.filter((f) => !isTest(f)).map((f) => [f, read(f)])
const lits = (text) => [...text.matchAll(new RegExp(`['"\`](${TYPE})['"\`]`, 'g'))].map((m) => m[1])
/** A line that writes an event: every type literal on it is produced there. `type: '…'` builds one. */
const PRODUCING = /\b(appendSignal|toDaemonEvent|handleSensorEvent|ingestAndApply|fold|emit|record)\(|\btype:\s*['"`]/
const produced = new Set(SOURCE.flatMap(([, t]) => t.split('\n').filter((line) => PRODUCING.test(line)).flatMap(lits)))
/** `board:${action}`: a templated producer covers its prefix. */
const templated = new Set(SOURCE.flatMap(([, t]) => [...t.matchAll(/`([a-z][a-z0-9-]*):\$\{/g)].map((m) => m[1])))
const consumed = new Set(SOURCE.filter(([f]) => /^packages\/(rules|kernel)\/src\//.test(f)).flatMap(([, t]) => [...t.matchAll(new RegExp(`(?:\\b(?:event|e|ev|evt)\\.type\\s*[!=]==?\\s*|case\\s+)['"\`](${TYPE})['"\`]`, 'g'))].map((m) => m[1])))
/** Read anywhere: the literal appears on a line that does not write it. */
const mentioned = new Set(SOURCE.flatMap(([, t]) => t.split('\n').filter((line) => !PRODUCING.test(line)).flatMap(lits)))

// F9: read by a rule, produced by nothing in this repository.
const NO_PRODUCER = {
  // The phone door: Shortcuts on the owner's phone send these; no sender exists yet (P15, the owner decides).
  'health:hr': '2026-09-29 P15', 'health:sleep': '2026-09-29 P15', 'health:steps': '2026-09-29 P15',
  'phone:motion': '2026-09-29 P15', 'phone:place': '2026-09-29 P15', 'phone:sleep': '2026-09-29 P15',
  // The presence scan's consent has no UI (P7, the owner decides); `sundial migrate` carried the old grant.
  'presence:consent': '2026-09-29 P7',
}

// F10: written, and read by nothing: log-only by design.
const LOG_ONLY = {
  // Audit trails: the judge's second key on a call, the approval prompts and their answers (W3).
  'action:classified': 'audit', 'approval:asked': 'audit', 'approval:answered': 'audit',
  // Countable in the log: a quiet day's skipped model pass.
  'llm:skipped': 'audit',
  // W2: what became of a loop, a record (the loop's own state is in `state.loops`).
  'loop:expired': 'record', 'loop:resolved': 'record',
}

describe('architecture fences (W4)', () => {
  it('F1: no file over 1,200 lines outside the OVER map, and none past its recorded size', () => {
    const lines = tally(FILES, (t) => count(t, /\n/g))
    ratchet(Object.fromEntries(Object.entries(lines).filter(([f, n]) => n > MAX_LINES || OVER[f] !== undefined)), OVER, { ceiling: true })
    ratchet(Object.fromEntries(Object.keys(BUDGET).map((f) => [f, lines[f] ?? 0])), BUDGET, { ceiling: true })
    const types = read('packages/kernel/src/types.ts')
    const kernelState = types.slice(types.indexOf('export interface KernelState')).split('\n')
    expect(kernelState.findIndex((line) => line.endsWith('{}') || line === '}') + 1).toBeLessThanOrEqual(90)
  })

  it('F2: no loopback fetch, no internalHeaders outside guard.js', () => {
    ratchet(tally(LOOPBACK_SCOPE, (t) => count(t, /fetch\([^)]*(127\.0\.0\.1|localhost)/g)), LOOPBACK)
    ratchet(tally(FILES.filter((f) => !isTest(f) && !f.endsWith('host/guard.js')), (t) => count(t, /\binternalHeaders\b/g)), INTERNAL_HEADERS)
  })

  it('F3: no @sundial/db import in route files or rules', () => {
    const scope = FILES.filter((f) => !isTest(f) && (ROUTE_FILES.includes(f) || f.startsWith('packages/rules/src/')))
    ratchet(tally(scope, (t) => count(t, /from '@sundial\/db[^']*'/g)), DB_IMPORTS)
  })

  it('F4: no module or apply-scope let, no setInterval, in host files', () => {
    ratchet(tally(HOST_FILES, (t) => count(t, /^ {0,2}let /gm) + count(t, /\bsetInterval\(/g)), HOST_STATE)
  })

  it('F6: the companion id, the verdict set and the entity-kind sets appear only in vocab.ts', () => {
    ratchet(tally(FILES.filter((f) => !isTest(f) && f !== 'packages/helpers/src/vocab.ts'), (t) => count(t, VOCAB)), VOCAB_COPIES)
  })

  it('W3: one writer of llm_audit — nothing but openLlmAudit calls recordLlmAudit or updateLlmAudit', () => {
    const writers = FILES.filter((f) => !isTest(f) && !f.startsWith('packages/db/src/') && /\b(recordLlmAudit|updateLlmAudit)\b/.test(read(f)))
    expect(writers).toEqual(['packages/llm/src/audit.ts'])
  })

  it('W3: one .env parser — only helpers\' sundial-env.ts imports dotenv or splits KEY=VALUE lines', () => {
    const parsers = FILES.filter((f) => !isTest(f) && (/from 'dotenv'/.test(read(f)) || /indexOf\('='\)|\(\?:export\\s\+\)\?\(\[A-Za-z_\]/.test(read(f))))
    // llm-providers.ts is the writer (`setEnvValues` keeps every line it does not set), not a reader.
    expect(parsers).toEqual(['packages/helpers/src/llm-providers.ts', 'packages/helpers/src/sundial-env.ts'])
  })

  it('F7: the executor is a handler map the compiler holds exhaustive, not a chain', () => {
    expect(read('packages/harness-runtime/src/effects/index.ts')).toMatch(/satisfies \{ \[K in Effect\['type'\]\]: Handler<K> \}/)
    expect(read('packages/harness-runtime/src/runtime.ts')).toMatch(/performEffect\([^)]*\): Promise<void> \{\n +await \(EFFECT_HANDLERS\[effect\.type\]/)
  })

  it('F8: no literal reliability percentage in a prompt builder', () => {
    ratchet(tally(PROMPT_BUILDERS, (t) => count(code(t), GUESSES)), LITERAL_RELIABILITY)
  })

  it('F5: no bare clock in kernel/src/read or kernel/src/tools', () => {
    ratchet(tally(CLOCK_SCOPE, (t) => count(t, /\bDate\.now\(\)|\bnew Date\(\)/g)), CLOCK)
  })

  it('F9: every event type a rule reads has a producer, or a dated reason it has none', () => {
    const missing = [...consumed].filter((t) => !produced.has(t) && !templated.has(t.split(':')[0])).sort()
    expect(missing).toEqual(Object.keys(NO_PRODUCER).sort())
  })

  it('F10: every event type written is read somewhere, or is log-only by design', () => {
    const unread = [...produced].filter((t) => !consumed.has(t) && !mentioned.has(t)).sort()
    expect(unread).toEqual(Object.keys(LOG_ONLY).sort())
  })

  it('F11: every experiments switch has a reader', () => {
    const config = read('packages/helpers/src/sundial-config.ts')
    const switches = Object.keys(JSON.parse(config.match(/experiments: (\{[^}]*\}),\n/)[1].replace(/(\w+):/g, '"$1":')))
    const readers = SOURCE.filter(([f]) => !['packages/helpers/src/sundial-config.ts', 'packages/kernel/src/initial-state.ts'].includes(f)).map(([, t]) => t).join('\n')
    const unread = switches.filter((k) => !new RegExp(`experiments\\??\\.(?:\\[)?['"]?${k}\\b|flagged\\('${k}'`).test(readers))
    expect({ switches: switches.length > 0, unread }).toEqual({ switches: true, unread: [] })
  })

  it('plugins have no build step: no declaration tsc emitted is tracked, and .gitignore keeps one out', () => {
    expect(FILES.filter((f) => f.startsWith('plugins/') && f.endsWith('.d.ts'))).toEqual([])
    const probe = ['plugins/sundial-proactive/night-shift.d.ts', 'plugins/sundial-proactive/night-shift.d.ts.map']
    expect(execFileSync('git', ['check-ignore', ...probe], { cwd: REPO, encoding: 'utf8' }).trim().split('\n')).toEqual(probe)
  })
})
