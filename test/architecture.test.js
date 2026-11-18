// Architecture fences (docs/release/12-autonomy/W4 F1–F8, W6 F9–F11). Regexes over the
// source, not a linter: each fence counts its violations per file and holds
// them to a recorded map. The maps are ratchets — a count may go down, never
// up — and a count that went down fails too, so the map is lowered in the same
// commit that earned it and the review shows it.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
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
  'plugins/sundial-theme/shell/app.js': 3769, // 2026-11-15: the step and eye frames, a screen step's words on its screen_act row and the newest look's key for the slip (12 lines; both are pushed by host/server.js); 2026-11-15: the slip's correction mid-turn, gnomon:correct (5 lines; the host side lives in api-sessions.js); 2026-11-15: a notice's offer on the strip (1 line; the chip lives in verdicts.js); 2026-11-15: the Routes card (1 line; it lives in view-routes.js); 2026-11-14: lowered, the live strip moved to live-strip.js and the reading line to reading-line.js; 2026-11-13: the thread pill's wiring, its import and the live frame that follows a thread picked elsewhere (8 lines; the pill itself lives in thread-pill.js); 2026-11-12: the model chip's thread, chipThread (3 lines); 2026-11-12: lowered, the approval's argument text moved to tool-line.js; 2026-10-03: the composer's slow-turn timer and the walk/question pause (31 lines); 2026-11-03: the catalogue's entry in the thread list (3 lines, over one line already staged); 2026-11-03: the thread bar's mode switch, its import (1 line; the switch lives in mode-switch.js); 2026-11-11: the summon's turn place, its import (1 line; the rule lives in pointing.js); 2026-11-11: the About you card (1 line; it lives in view-beliefs.js)
  'packages/harness-runtime/src/runtime.ts': 2165, // 2026-11-17: a refunded journal call releases its route slot (4 lines); 2026-11-17: the conversation pass moved to conversation-pass.ts (-46); 2026-11-17: a boot with no chore counters folds them from the log (3 lines; the fold lives in chores-rebuild.ts); 2026-11-16: a sandbox job's rows carry the rig chat's mark, and its watchdog reads that sandbox (4 lines; the predicate lives in helpers sandbox.ts); 2026-11-15: the conversation pass skips the rig's sessions, its import (1 line; the rule lives in kernel read/rig-session.ts)
  'plugins/sundial-theme/shell/stage.js': 1703, // 2026-11-02: the Nodus card's branch in materialize (7 lines)
  'packages/helpers/src/sundial-config.ts': 1266, // 2026-11-17: offerBar (S6), its line, doc, resolved type, default and parse (5 lines). 2026-11-17: audio.whisperUrl refused off the loopback, loopbackWhisperUrl (7 lines). 2026-11-16: browser.pageTextAx and privacy.privateHosts, their lines, default and resolve (4 lines). 2026-11-16: web.knownHosts, its import, field, default and resolve (4 lines; the list and its resolver live in web-config.ts). 2026-11-15: llm.connectMs, its line and doc (1 line). 2026-11-15: llm.compactKeepFront, its doc (2 lines). 2026-11-15: choreDays, its line, doc, default and parse (5 lines). 2026-11-15: workdays, its line, doc, default and parse (5 lines). 2026-11-13: appNotes, its line, doc and default (6 lines). 2026-11-13: ownerEmails, its line, doc and default (5 lines). 2026-11-12: llm.hedgeAfterMs, its line and its doc (2 lines). 2026-11-12: llm.compactAt, its line and its doc (2 lines). 2026-11-12: llm.chatReasoning, its line and its doc (2 lines). 2026-11-11: experiments.witnessPairs, voiceKnock, quietSummon, stuckSigns, holdToTalk and the three screen switches (6 lines); `voice`, its type and resolver in voice-config.ts (5 lines)
  'packages/nodus/src/kit.js': 1476, // 2026-11-04: Plate mode's picture parts (trace, solids, meshes) came in with the lab; split them out to lower this
  'packages/nodus/vendor/GLTFLoader.js': 4779, // 2026-11-03: three.js r160's glTF loader, vendored as it is for Atlas mode (MIT): not ours to split
}
// W4's acceptance sizes, held as ceilings once reached (Phase 5): the host's entry, the shell mount, the
// views' index. `KernelState` itself is its slice interfaces (state/<domain>.ts), at most 90 lines.
const BUDGET = {
  'plugins/sundial-theme/index.js': 400,
  'plugins/sundial-theme/host/server.js': 700,
  'plugins/sundial-theme/shell/views.js': 150,
  // Set 3 R3: the action gate, its finals, shell reading and tool table split out (gate-finals.js, gate-shell.js, gate-tools.js).
  'plugins/sundial-actions/gate.js': 1000,
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
  'plugins/sundial-llm-openai/index.js': 8, // 2026-11-12: hedge()'s winner, a let inside the function the two-space rule also counts
  'plugins/sundial-proactive/delivery.js': 1,
  'plugins/sundial-proactive/index.js': 2,
  'plugins/sundial-proactive/night-shift.js': 1,
  'plugins/sundial-proactive/work.js': 4, // 2026-10-03: one in-flight promise so two jobs in a tick create one work agent
  'plugins/sundial-theme/host/api-config.js': 1,
  'plugins/sundial-theme/host/api-sessions.js': 1,
  'plugins/sundial-theme/host/signin-log.js': 3,
  'plugins/sundial-web-browser/browser-page.js': 2,
  'plugins/sundial-web-browser/cdp.js': 3,
  'plugins/sundial-web-browser/launcher.js': 3,
  'plugins/sundial-web-browser/page-session.js': 1,
}

// Set 2 R3: side state in the loop's files. A module or plugin-scope `new Map(`/`new Set(` is state the fold does not
// hold, so a restart forgets it; these counts may only go down. 2026-11-15: index.js `shells` became the fold's
// `state.shells`; voice-turn.js `turns` keeps only the stream buffer and timers (what a turn said is `state.voice.said`).
const SIDE_STATE_FILES = ['plugins/sundial-actions/screen-tools.js', 'plugins/sundial-actions/index.js', 'plugins/sundial-theme/host/voice-turn.js', 'plugins/sundial-theme/host/server.js']
const SIDE_STATE = {
  'plugins/sundial-actions/screen-tools.js': 7, // SLOW (a constant), two per-call locals, and the four bounded caches below
  'plugins/sundial-actions/index.js': 0,
  'plugins/sundial-theme/host/voice-turn.js': 1,
  'plugins/sundial-theme/host/server.js': 10,
}
/** The screen tools' prompt caches and the unwritten-Send fallback: each must be held to a size. */
const SCREEN_CACHES = ['mapped', 'unwritten', 'told', 'looked']

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
/** The Mac app is a producer outside packages/ and plugins/: it writes its events to app-events.jsonl (`emit`, `answer`). */
const APP_PRODUCED = readdirSync(join(REPO, 'apps/macos')).filter((f) => f.endsWith('.swift')).flatMap((f) => read(`apps/macos/${f}`).split('\n')).filter((line) => /\b(emit|answer)\(/.test(line)).flatMap(lits)
const produced = new Set([...SOURCE.flatMap(([, t]) => t.split('\n').filter((line) => PRODUCING.test(line)).flatMap(lits)), ...APP_PRODUCED])
/** `board:${action}`: a templated producer covers its prefix. */
const templated = new Set(SOURCE.flatMap(([, t]) => [...t.matchAll(/`([a-z][a-z0-9-]*):\$\{/g)].map((m) => m[1])))
const consumed = new Set(SOURCE.filter(([f]) => /^packages\/(rules|kernel)\/src\//.test(f)).flatMap(([, t]) => [...t.matchAll(new RegExp(`(?:\\b(?:event|e|ev|evt)\\.type\\s*[!=]==?\\s*|case\\s+)['"\`](${TYPE})['"\`]`, 'g'))].map((m) => m[1])))
/** Read anywhere: the literal appears on a code line that does not write it. A comment that names a type is not a read. */
const mentioned = new Set(SOURCE.flatMap(([, t]) => code(t).split('\n').filter((line) => !PRODUCING.test(line)).flatMap(lits)))
/** A family in a signal-type list (`OWNER_EVIDENCE_TYPES = ['web', …]`, gnomon_signals) reads every `web:*`. */
const families = new Set(SOURCE.flatMap(([, t]) => [...code(t).matchAll(/_TYPES\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/['"]([a-z][a-z0-9-]*)['"]/g)].map((x) => x[1]))))

// F9: read by a rule, produced by nothing in this repository.
const NO_PRODUCER = {
  // The phone door: Shortcuts on the owner's phone send these; no sender exists yet (P15, the owner decides).
  // The phone ingest listener and the presence scan were dropped on 2026-10-14 with their rules.
  'health:hr': '2026-09-29 P15', 'health:sleep': '2026-09-29 P15', 'health:steps': '2026-09-29 P15',
  'phone:sleep': '2026-09-29 P15',
  // 2026-11-03: the phone inbox receives these from the phone's own Shortcuts; no Sundial sensor produces them.
  'phone:motion': '2026-11-03 phone inbox', 'phone:place': '2026-11-03 phone inbox',
}

// F10: written, and read by nothing: log-only by design.
const LOG_ONLY = {
  // Audit trails: the judge's second key on a call (W3).
  'action:classified': 'audit',
  // Countable in the log: a quiet day's skipped model pass.
  'llm:skipped': 'audit',
  // Plan 15 step 8 (2026-11-11): a value put back, counted in the log beside the act it undid.
  'action:undone': 'audit',
  // Set 2 Round 1 (2026-11-15): a pull-up's start and end, read beside its screen:mark-placed row for the 5 s number.
  'screen:pull-up': 'measure',
  // Set 2 Round 2 (2026-11-15): a replayed route's steps, offered and run, read by the rig (suite3.sh replayed) beside llm_audit's model steps.
  'screen:replayed': 'measure',
  // W2: what became of a loop, a record (the loop's own state is in `state.loops`).
  'loop:expired': 'record', 'loop:resolved': 'record',
  // Set 4 (2026-11-16): named only in comments until F10 stopped counting a comment as a read.
  // A chore offer shown, for the go rate (lab/chores/report.mjs: notice:offer-taken over offers).
  'chore:offered': 'measure',
  // The label calibrate folds where it detects it; the logged copy is its audit trail.
  'feedback:implicit': 'audit',
  // screen_act waited on a loading window: the rig's slow-app check reads it (suite3.sh).
  'screen:waited': 'measure',
  // The day line the slip said with no turn (overlay.js daySaid): the rig's evening answer (run.sh), a record beside the summon's rows.
  'overlay:day-said': 'measure',
  // Doc 29 (2026-11-17): who pressed a Stop (the slip's button or key, the run bar, another caller), for the rig to tell its own from a hand's.
  'chat:stop': 'measure',
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

  it('Set 2 R3: module and plugin-scope Maps and Sets in the loop files only go down, and every screen cache is bounded', () => {
    ratchet(tally(SIDE_STATE_FILES, (t) => count(t, /^ {0,2}(?:const|let) [\w$]+ = new (?:Map|Set)\(/gm)), SIDE_STATE)
    const screen = read('plugins/sundial-actions/screen-tools.js')
    expect(SCREEN_CACHES.filter((name) => !new RegExp(`const ${name} = new Map\\(`).test(screen) || !new RegExp(`\\b${name}\\.size > \\d+`).test(screen))).toEqual([])
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
    const unread = [...produced].filter((t) => !consumed.has(t) && !mentioned.has(t) && !families.has(t.split(':')[0])).sort()
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
