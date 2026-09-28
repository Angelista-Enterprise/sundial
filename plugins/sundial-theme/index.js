// @sundial/dsh-theme (host half) — serves the things the browser half cannot
// carry itself: the bundled typeface, today's dial figure, and the ledger
// rollup the Ledger page reads.
//
// The dial figure is NOT recomputed here. `composeFigure({kind:'dial-slice'})`
// is the same composer the `gnomon_compose_figure` tool calls, so the dial the
// owner sees on the landing page and the dial the assistant draws mid-answer
// are the same artefact computed once — a second implementation would drift
// the moment either changed. The ledger route does the same non-recomputation
// one level down: it projects the `llm_audit` queries from `@sundial/db` — the
// single write path every LLM call in the system goes through — rather than
// keeping its own counters.
import { guard } from './shell/guard.js'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountShell } from './shell/server.js'
import { entitySlug } from './shell/entity-id.js'
import { QUIET_AFTER_DAYS, foldDuplicates, groupByParent, lastMoved, linkMovement, parseSteps, quietDays, splitStatus, stepProgress, stepsFromCommits } from './shell/goals.js'
import { WITH_SHOWN, bySeen, daysSince, displayName, foldPeople, isHash, mergeHint, notAPerson, withWhom } from './shell/people.js'
import { GATE_DAILY_BUDGET, barsFor } from './shell/gate.js'
import { skillVsConstant, skillVsPastBaseline } from './shell/calibration.js'
import { SENSORS } from './shell/sensors.js'
import { momentIdIn, openDoors } from './shell/trace.js'
import { EFFECT_FAMILY } from '@sundial/kernel/effect-delivery.js'
import { buildDailyContext } from '@sundial/kernel/daily-context.js'
import { composeFigure } from '@sundial/kernel/tools/figure-tools.js'
import { buildWorkShape } from '@sundial/kernel/work-shape.js'
import { buildSituation } from '@sundial/kernel/situation.js'
import { routineForecast, routineLabel, topRoutines } from '@sundial/kernel/routines.js'
import { mergeMirrors, rituals } from '@sundial/kernel/rituals.js'
import { resolveDailyCaps } from '@sundial/kernel/budgets.js'
// The same predicate `researchGoals` opens a goal by, so the surface can say
// what the fold is waiting for instead of guessing at it.
import { LEARNED_LOSS_DROP, gapEligibility } from '@sundial/kernel/gap-eligibility.js'
import { getSundialConfigPath, getSundialHome } from '@sundial/helpers/config.js'
import { getPermissionStatus } from '@sundial/helpers/permission-status.js'
import { loadSundialConfig, ruleForPlace, sanitizeProjectRule, unstableRuleReason } from '@sundial/helpers/sundial-config.js'
import { WAKING_DAY_START_HOUR, localDate, localDayRange, wakingDate, wakingMinute } from '@sundial/helpers/local-day.js'
// One definition of "is this a name", shared with `peopleAsk` and the ask
// route — a copy here would let the surface admit what the reducer rejects.
import { looksLikePersonName } from '@sundial/helpers/person-name.js'
import { classifyActivity, isSystemProcess } from '@sundial/helpers/window-classification.js'
import {
  getLlmAuditOverview,
  getLlmAuditDaily,
  getLlmAuditByModel,
  getRecentLlmAudit,
  getLlmAuditById,
  getLostAnswers,
  getGateDecisionsBetween,
  listRetractedFacts,
  getPipelineCoverage,
  getEmbeddingHealth,
  getCalibrationBins,
  getDayArcs,
  getObservedHours,
  getSignalFreshness,
  getSignalTotals,
  getLatestMoments,
  getRedactionHealth,
  getAllEntities,
  getCurrentEntityFacts,
  getEntityFactTimeline,
  getEntityGraphEdges,
  getCurrentFactsWithProof,
  tallyPredictions,
  listResolvedPredictions,
  getMomentsForDate,
  getMomentsSince,
  getRecentRuleTriggers,
  getEffectJournalCensus,
  getEffectsForEvents,
  getMomentsByIds,
  getProfileFact,
  getLeftOff,
  getToolCalls,
  getActivityHours,
  getContextSwitchesBetween,
  getThrashingBetween,
  getInterruptionsBetween,
  getShellRunsBetween,
  getCommitsBetween,
  getOpenCommitments,
  getSignalsInRange,
  getKnowledgeEntriesSince,
  getRecentOwnerAsks,
  getFactsBySourceEventIds,
} from '@sundial/db/index.js'

/**
 * The window the tensorx route declares (`DEFAULT_CONTEXT_WINDOW`) and the
 * fraction `dsh-compaction-basic` acts on (`DEFAULT_THRESHOLD_RATIO`).
 *
 * Mirrored rather than imported: the first lives in another plugin's adapter
 * facts, the second inside a third-party plugin's config defaults, and neither
 * is exported. They are here so the gauge can say what it is measuring against;
 * if either moves, the gauge reads slightly wrong and nothing breaks.
 */
const CONTEXT_WINDOW = 128_000
const COMPACT_THRESHOLD_RATIO = 0.8

export const name = 'sundial-theme'
// `agents` + `agentDefaultModel` are what shell/server.js drives sessions with —
// the same two services sundial-proactive injects to own its companion.
//
// A note on the name. This package stopped being "the theme" some time ago: it
// serves Today, the Ledger, six instruments, and the conversation shell. It is the
// Gnomon web UI. Renaming it means touching the profile's link list in
// ~/.dsh/profiles/web/package.json, which is a machine-level file outside the
// repo, so the debt is recorded here rather than paid halfway.
// `gnomonDb` is injected but unused directly: it is what guarantees the DB is
// open and migrated before `composeFigure` reads through it.
// `gnomonKernel` is read for ONE thing: the open research goal on
// `state.mind.goals`, which is live state rather than anything the DB holds —
// a goal is a working intention, and only the closed ones leave a durable
// trace (as the `self-report` notice they produce).
// `sessionProjectionCache` is dsh 0.1.5's persisted projection cache and it is
// what makes the sidebar cheap — see `listHint` in shell/server.js. Declared
// rather than read opportunistically on purpose: without it the list silently
// falls back to reading 185 whole session logs, which is a four-second stall
// that looks like nothing in particular. A missing service should say so.
export const inject = [
  'webServer',
  'connection',
  'gnomonDb',
  'gnomonKernel',
  'agents',
  'agentDefaultModel',
  'sessionQuery',
  'sessionPersistence',
  'sessionProjectionCache',
  'llm',
  'tools',
  'gnomonReach',
]

const HERE = dirname(fileURLToPath(import.meta.url))
const FONT_PATH = join(HERE, 'assets', 'InterTight-Variable.ttf')

/** A day in the owner's own local reckoning, which is what the dial is keyed by. */
/** Top files of the day from `state.files.hot`: path, project, changes. */
function hotFilesOf(state) {
  const hot = Object.values(state?.files?.hot ?? {})
  return hot
    .sort((a, b) => b.changes - a.changes)
    .slice(0, 6)
    .map((f) => ({ path: f.relPath, project: f.projectRoot.split('/').pop() ?? f.projectRoot, changes: f.changes, focusedChanges: f.focusedChanges, lastAt: f.lastAt }))
}

function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Calendar-day arithmetic on a `YYYY-MM-DD` — never 24h subtraction, which drifts across DST. */
function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10)
}

/**
 * WHEN a request is about: the board's own span unless the caller named one.
 *
 * Every route here used to answer for its own idea of time — `date` defaulting
 * to today, `days` defaulting to 14 or 60, the ledger with a private `window`
 * of its own — so the same board could show one card's Tuesday beside another
 * card's fortnight and nothing on screen said so. The span lives in the record
 * (`state.board.span`), so this is the one place that reads it.
 *
 * An explicit query parameter still WINS, for three reasons: a card may pin
 * itself to a span and say so, `gnomon_look`'s readers pass their own, and a
 * route called directly should answer exactly what it was asked. The board span
 * is a default, not an override.
 *
 * Returns inclusive owner-local dates plus the two shapes callers already
 * speak: `date` is the last day of the span, which is what a day-bound card
 * shows, and `days` is the inclusive count.
 */
function spanFrom(url, getState, fallbackDays = 1) {
  const span = getState()?.board?.span ?? null
  const asked = { date: url.searchParams.get('date'), days: Number(url.searchParams.get('days')) || 0 }
  const to = asked.date || span?.to || today()
  const days = asked.days > 0 ? asked.days : asked.date ? 1 : span ? Math.max(1, Math.round((Date.parse(`${span.to}T00:00:00Z`) - Date.parse(`${span.from}T00:00:00Z`)) / 86_400_000) + 1) : fallbackDays
  const from = shiftDate(to, -(days - 1))
  return { from, to, days, date: to, label: span?.label ?? null, pinned: Boolean(asked.date || asked.days > 0) }
}

/**
 * A zone's UTC offset in whole hours at one instant.
 *
 * SQLite has no timezone database, so `getDayArcs` needs a constant shift —
 * and a constant is an hour wrong on the far side of a daylight saving change.
 * Taking it at the MIDDLE of the window means one such change inside the range
 * moves a single day's boundary rather than every day's.
 */
function offsetHoursAt(iso, timeZone) {
  try {
    const at = new Date(iso)
    const local = new Date(at.toLocaleString('en-US', { timeZone }))
    const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }))
    return Math.round((local.getTime() - utc.getTime()) / 3_600_000)
  } catch {
    return 0
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // The dial changes every minute the owner works. A cached one is a lie
    // about the present, which is the one thing this drawing is about.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function apply(ctx) {
  // Every route goes through the fence (shell/guard.js): a same-origin, signed-in browser, or this process.
  const registerRoute = (route) => ctx.webServer.register(guard(ctx.connection, route))
  // Gnomon's own client, at `/`. See shell/server.js for why leaving dsh's web
  // app is one route registration rather than a fork: its SPA is whoever claims
  // the web server's FALLBACK seat, and a named exact route is matched first.
  mountShell(ctx, { cwd: process.cwd() })

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/font/inter-tight.ttf',
      handler: async (_req, res) => {
        try {
          const font = await readFile(FONT_PATH)
          res.writeHead(200, {
            'content-type': 'font/ttf',
            // Content-addressed by version in practice: the file only changes
            // when the plugin does, and a stale face is a cosmetic fault.
            'cache-control': 'public, max-age=31536000, immutable',
          })
          res.end(font)
        } catch (error) {
          // A missing face degrades to the fallback stack rather than breaking
          // the page, so this answers 404 instead of 500.
          console.warn(`[sundial-theme] could not read the bundled face: ${error instanceof Error ? error.message : String(error)}`)
          res.writeHead(404).end()
        }
      },
    }),
  )

  // ── The other direction ─────────────────────────────────────────────────
  // Gnomon asking the OWNER something (packages/rules/src/owner-ask.ts). The
  // rule has been able to ask for a while; until now the only mouth it had was
  // prose in the companion conversation, which meant the question was only
  // visible to an owner who happened to be reading that session.
  //
  // The seat above the composer is on every view, so the question finds them
  // wherever they are — and, when it has a closed set of answers, is answered
  // with one tap.

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/ask/open',
      handler: async (_req, res) => {
        try {
          const open = ctx.gnomonKernel.getState().ownerAsk?.open ?? null
          sendJson(res, 200, {
            open:
              open === null
                ? null
                : {
                    askId: open.askId,
                    question: open.question,
                    reason: open.reason === '' ? null : open.reason,
                    choices: Array.isArray(open.choices) ? open.choices : [],
                    waiting: open.waiting === true,
                    ts: open.ts,
                  },
          })
        } catch (error) {
          console.error(`[sundial-theme] open ask failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The open question could not be read.' })
        }
      },
    }),
  )

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/ask/answer',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { unavailable: 'Answering takes a POST.' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) {
            body += chunk
            if (body.length > 8192) {
              sendJson(res, 413, { unavailable: 'That answer is too long for a tap — say it in the chat.' })
              return
            }
          }
        } catch {
          sendJson(res, 400, { unavailable: 'The answer could not be read.' })
          return
        }

        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        const askId = typeof parsed?.askId === 'string' ? parsed.askId.trim() : ''
        const answer = typeof parsed?.answer === 'string' ? parsed.answer.trim() : ''
        if (askId === '' || answer === '') {
          sendJson(res, 400, { unavailable: 'An answer needs both an askId and an answer.' })
          return
        }

        try {
          // The SAME signal `gnomon_owner_answer` appends, on purpose. A tap and
          // a typed reply are the same fact — one habituation path, one place
          // the reducer closes the question, one thing to reason about later.
          // The rule ignores an askId that is not the open one, so a stale tab
          // tapping an answered question is inert rather than corrupting.
          await ctx.gnomonKernel.appendSignal('ask:owner-answered', { askId, answer })
          sendJson(res, 200, { recorded: true, askId })
        } catch (error) {
          console.error(`[sundial-theme] answer failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'That answer could not be recorded.' })
        }
      },
    }),
  )

  // ── How heavy the conversation has become ────────────────────────────────
  // Read from Gnomon's OWN ledger rather than dsh's token-meter projection:
  // that projection is served to dsh's SPA, which never boots here, and every
  // chat call is already written to `llm_audit`. The most recent `ask` call is
  // the current turn on a single-owner machine, which is the only case there is.
  //
  // Reported against the window the route DECLARES (128k) and the threshold
  // compaction acts on (80% of it). Both numbers matter to the reader: 44 calls
  // on this record sailed past the threshold and the largest reached 165,108 —
  // 37k beyond the window — and still returned success, so nothing anywhere
  // said the context had been overrun.

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/context',
      handler: async (_req, res) => {
        try {
          // A small window, then the first `ask` in it: `getRecentLlmAudit`
          // takes no purpose filter and adding one for this would be a query
          // nobody else wants. Kernel purposes (`intent`, `journal`) interleave,
          // hence 24 rather than 1.
          const recent = await getRecentLlmAudit(24)
          const last = recent.find((row) => row.purpose === 'ask') ?? null
          sendJson(res, 200, {
            promptTokens: last?.promptTokens ?? null,
            model: last?.model ?? null,
            at: last?.requestedAt ?? null,
            contextWindow: CONTEXT_WINDOW,
            compactAt: Math.floor(CONTEXT_WINDOW * COMPACT_THRESHOLD_RATIO),
          })
        } catch (error) {
          console.error(`[sundial-theme] context failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The context size could not be read.' })
        }
      },
    }),
  )

  // ── What the owner said they want ────────────────────────────────────────
  // Five goal entities on the live record, each with a real `status` fact
  // ("open — …", "done", "dropped"), and reachable by nothing: no route, no
  // tool, and only the top 40 entities by fact count reach the Memory table —
  // where three of the five fell outside. The write path (`gnomon_assert` on
  // kind 'goal') has existed all along, which is the same read/write asymmetry
  // the people roster had.

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/goals',
      handler: async (_req, res) => {
        try {
          // Pinned to the whole record, and the card says so on its face. A
          // goal set in July is not less true in a seven-day span, and the
          // board's span would empty this card every morning.
          const now = Date.now()
          const [entities, commitments, commitSignals] = await Promise.all([
            getAllEntities(),
            getOpenCommitments(50),
            // Sixty days of commit subjects, for the `[n/7]` progress tokens the
            // owner puts in them. `getCommitsBetween` drops the subject line, so
            // this reads the stream itself.
            getSignalsInRange(new Date(now - 60 * 86_400_000).toISOString(), new Date(now + 86_400_000).toISOString(), 4000, ['git']),
          ])
          const commits = commitSignals.filter((s) => s.eventType === 'commit').map((s) => s.data)
          const rows = await Promise.all(
            entities
              .filter((entity) => entity.kind === 'goal')
              .map(async (entity) => {
                // The whole timeline, not only what is believed now: a goal's
                // life is every time the owner said something about it, and a
                // superseded status is exactly such a saying.
                const [facts, timeline] = await Promise.all([getCurrentEntityFacts(entity.id), getEntityFactTimeline(entity.id)])
                const pick = (predicate) => facts.find((fact) => fact.predicate === predicate)
                const status = pick('status')
                const { state, why } = splitStatus(status?.object ?? 'open')
                // A goal captured in a conversation has no `status` at all — it
                // arrives as `plansTo` or `goal`, which IS its why. Reading
                // those is what makes a goal said in chat land as a row here.
                const said = pick('why') ?? pick('plansTo') ?? pick('goal')
                const anchor = status ?? said
                return {
                  id: entity.id,
                  goal: entity.canonicalName,
                  status: status?.object ?? null,
                  state,
                  why: why || said?.object || null,
                  targetDate: pick('targetDate')?.object ?? null,
                  stored: pick('steps')?.object ?? null,
                  partOf: pick('partOf') ? `goal:${entitySlug(pick('partOf').object)}` : null,
                  since: anchor?.validFrom ?? null,
                  saidBy: anchor?.provenance === 'assertion' ? 'owner' : (anchor?.provenance ?? null),
                  saidAt: timeline.map((fact) => fact.validFrom).filter(Boolean),
                }
              }),
          )
          const goals = foldDuplicates(rows).map(({ stored, saidAt, ...row }) => {
            const movement = linkMovement(row.goal, commitments, commits)
            const quiet = quietDays(row.since, movement, now)
            // The owner's own list if they have written one; otherwise the
            // `[n/7]` tokens read back as the checklist they always were. The
            // second is DERIVED and says so, because the owner has not agreed
            // to it and the first edit replaces it wholesale.
            const own = stored === null ? [] : parseSteps(stored)
            const steps = own.length ? own : stepsFromCommits(movement?.log ?? [])
            return {
              ...row,
              // What this goal's own trail is drawn from. Two kinds, because
              // they answer different questions: a `said` is the owner giving
              // it attention, a `did` is work landing on the branch it names,
              // and a goal can have plenty of one and none of the other.
              life: [
                ...(saidAt ?? []).map((at) => ({ at, kind: 'said' })),
                ...(movement?.log ?? []).map((c) => ({ at: c.timestamp, kind: 'did' })).filter((e) => e.at),
              ],
              steps,
              stepsAreDerived: own.length === 0 && steps.length > 0,
              progress: stepProgress(steps),
              movement,
              movedAt: lastMoved(row.since, movement),
              quietDays: quiet,
              // Only a goal still in play can go quiet. A dropped one is not
              // neglected, it is decided.
              stale: quiet !== null && quiet >= QUIET_AFTER_DAYS && ['open', 'doing', 'waiting', 'blocked'].includes(row.state),
            }
          })
          sendJson(res, 200, { goals: groupByParent(goals), quietAfterDays: QUIET_AFTER_DAYS })
        } catch (error) {
          console.error(`[sundial-theme] goals failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The goals could not be read.' })
        }
      },
    }),
  )

  // The second write door is gone. It wrote `goal:${goal}` — the raw name —
  // while `gnomon_assert` and `POST /gnomon/api/assert` wrote the slug, so
  // pressing Done on this card and saying "that's done" in the chat reached two
  // different entities. Four goals are split across two ids each in the live
  // record because of it, two of them carrying a live `done` AND a live
  // `dropped`. The card now writes through `/gnomon/api/assert` like everything
  // else, and the read folds the existing wreckage together by slug.

  // ── Who Gnomon has met ───────────────────────────────────────────────────
  // The page that makes automatic naming correctable. `identity-resolve` names
  // a hashed attendee from addresses already on the machine, and a derivation
  // can be imperfect — `alexm@example.com` yields "Alexm". Before this the only
  // way to fix that was to answer a question Gnomon chose to ask; now it is a
  // text field. The rename writes the same `knownAs` fact `gnomon_assert`
  // writes, so the owner's word supersedes a derived name on ONE observation.
  //
  // **Meetings are read from the LOG, not from `state.meetings.seen`.** That
  // map is swept at `SEEN_HORIZON_MS`, which is two days — so the "Met" and
  // "Last" columns were a 48-hour window wearing the words "how often" and
  // "when last", and thirty-five of sixty-nine people read `met 0` for no
  // reason except that the owner had not seen them since Wednesday. The
  // owner's actual question was "who haven't I seen in two weeks?", which that
  // map cannot answer at all. The calendar signals hold every event with its
  // attendees, and that is what this reads.

  /**
   * Every calendar event on the record, once, with its attendees.
   *
   * Deduplicated by `eventId + startDate`: the sensor re-logs an upcoming
   * meeting on every poll, so the 2,807 calendar signals in the live record are
   * 98 actual events. All-day entries are dropped — `Passiedag`, `Bob middag
   * vrij` — because a whole-office all-day invite is not a room the owner was in
   * with anybody, and counting it would make "most seen" mean "on the most
   * mailing lists".
   */
  const calendarEvents = async (sinceDays = 400) => {
    const to = new Date(Date.now() + 86_400_000).toISOString()
    const from = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
    const rows = await getSignalsInRange(from, to, 20_000, ['calendar'])
    const events = new Map()
    for (const row of rows) {
      const event = row?.data?.event
      if (!event?.eventId || event.isAllDay) continue
      const attendees = Array.isArray(event.attendees) ? event.attendees : []
      if (attendees.length === 0) continue
      events.set(`${event.eventId}|${event.startDate}`, { at: String(event.startDate ?? row.capturedAt), title: String(event.title ?? 'a meeting'), attendees })
    }
    return [...events.entries()]
  }

  // The meetings of one day, with their calendar times — the windows Explore's
  // "Said" reads speech inside. Not the day context's meetings: those are
  // stitched from moments, and the live standup of 2026-09-22 came out as 30
  // seconds. Not `state.meetings.seen` either: two days deep. The sensor logs an
  // event from a day ahead, so a week before the day finds every one of them.
  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/meetings',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') ?? '') ? url.searchParams.get('date') : localDate(new Date().toISOString(), loadSundialConfig().timezone)
          const { start, end } = localDayRange(date, loadSundialConfig().timezone)
          const rows = await getSignalsInRange(new Date(Date.parse(start) - 7 * 86_400_000).toISOString(), end, 20_000, ['calendar'])
          const events = new Map()
          for (const row of rows) {
            const e = row?.data?.event
            if (!e?.title || e.isAllDay || !e.startDate || e.startDate < start || e.startDate >= end) continue
            events.set(`${e.title}|${e.startDate}`, { title: String(e.title ?? 'a meeting'), start: e.startDate, end: e.endDate ?? e.startDate, attendees: Array.isArray(e.attendees) ? e.attendees.length : 0 })
          }
          sendJson(res, 200, { date, meetings: [...events.values()].sort((a, b) => a.start.localeCompare(b.start)) })
        } catch (error) {
          sendJson(res, 500, { unavailable: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/people',
      handler: async (_req, res) => {
        try {
          const state = ctx.gnomonKernel.getState()
          const aliasNames = state.memory?.aliasNames ?? {}
          const config = loadSundialConfig()
          const personAliases = config.personAliases ?? {}
          const ownerAliases = config.ownerAliases ?? []

          // attendee string → the events they were in. Keyed by event so a fold
          // of two ids that were both invited to one meeting counts it once.
          const events = new Map(await calendarEvents())
          const met = new Map()
          for (const [id, event] of events) {
            for (const attendee of event.attendees) {
              if (!met.has(attendee)) met.set(attendee, new Map())
              met.get(attendee).set(id, { at: event.at, title: event.title })
            }
          }

          const entities = (await getAllEntities()).filter((e) => e.kind === 'person')
          const notPeople = []
          const rows = []
          for (const entity of entities) {
            const key = entity.canonicalName ?? entity.id
            const knownAs = aliasNames[key]
            const name = displayName({ alias: key, name: key, knownAs }, personAliases)
            // A room, a distribution list, or the owner. Named rather than
            // dropped: three rows that silently vanish are three rows nobody can
            // question, and the owner asked to know these were filtered.
            const why = notAPerson(name, ownerAliases) ?? notAPerson(key, ownerAliases)
            if (why) {
              notPeople.push({ name, why })
              continue
            }
            rows.push({
              alias: key,
              name,
              named: knownAs !== undefined || !isHash(name),
              // Both spellings, because the calendar may have invited this
              // person under the hash on one event and the name on another.
              events: [...(met.get(key) ?? new Map()), ...(knownAs ? (met.get(knownAs) ?? new Map()) : new Map())],
            })
          }

          const folded = foldPeople(rows)
          const named = folded.filter((p) => p.named)

          // A co-attendee is resolved through the SAME fold the list uses, so
          // `person-c205ca11f2` in someone's room reads "Alex Morgan" and
          // lands on the row that is already on this card. Built from the folded
          // result rather than re-deriving, because two resolutions of one name
          // is how a surface starts disagreeing with itself.
          const byAlias = new Map()
          for (const person of folded) for (const alias of person.aliases ?? []) byAlias.set(alias, person.name)
          const resolve = (attendee) => byAlias.get(attendee) ?? displayName({ name: attendee }, personAliases)
          // Rooms, groups and the owner are not company — the owner is in every
          // one of these rooms by definition, and "you were also there" is not a
          // connection worth drawing.
          const company = (person) => withWhom(person, events, resolve).filter((w) => notAPerson(w.name, ownerAliases) === null)

          const people = named
            .map((p) => {
              const all = company(p)
              return {
                ...p,
                daysSince: daysSince(p.lastSeen),
                hint: mergeHint(p, named),
                with: all.slice(0, WITH_SHOWN),
                withMore: Math.max(0, all.length - WITH_SHOWN),
              }
            })
            .sort(bySeen)
          // The unnamed are ONE bucket, not eight rows at the top of the list.
          // They are the same question asked eight times, and the answer to each
          // is a name the owner may not have — seven of the eight have never
          // been in a timed meeting, so there is nothing to jog it with.
          const unnamed = folded
            .filter((p) => !p.named)
            .map((p) => ({ ...p, daysSince: daysSince(p.lastSeen), with: company(p).slice(0, WITH_SHOWN) }))
            .sort(bySeen)
          sendJson(res, 200, {
            people,
            unnamed,
            notPeople: notPeople.sort((a, b) => a.name.localeCompare(b.name)),
            aliasesApplied: Object.keys(personAliases).length,
          })
        } catch (error) {
          console.error(`[sundial-theme] people failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The people could not be read.' })
        }
      },
    }),
  )

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/people/name',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { unavailable: 'Naming takes a POST.' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) {
            body += chunk
            if (body.length > 4096) {
              sendJson(res, 413, { unavailable: 'That name is too long.' })
              return
            }
          }
        } catch {
          sendJson(res, 400, { unavailable: 'The name could not be read.' })
          return
        }

        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        const alias = typeof parsed?.alias === 'string' ? parsed.alias.trim() : ''
        const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
        if (alias === '' || name === '') {
          sendJson(res, 400, { unavailable: 'A naming needs both an alias and a name.' })
          return
        }
        if (!looksLikePersonName(name)) {
          // The same shallow test `peopleAsk` applies to a typed answer, and for
          // the same reason: the first answer that rule ever got was "in which
          // meeting where they?" and it filed that as a colleague's name.
          sendJson(res, 400, { unavailable: 'That does not read like a name.' })
          return
        }

        try {
          // Through the SAME `entity:fact-candidate` path a sensor uses, with
          // `provenance: 'assertion'` — the owner's own word, which
          // `contradictionCheck` promotes on one observation instead of three.
          // No privileged write into core memory from a web route.
          await ctx.gnomonKernel.appendSignal('entity:fact-candidate', {
            entityId: `person:${alias}`,
            entityKind: 'person',
            canonicalName: alias,
            predicate: 'knownAs',
            object: name,
            confidence: 100,
            provenance: 'assertion',
            projectId: null,
          })
          sendJson(res, 200, { recorded: true, alias, name })
        } catch (error) {
          console.error(`[sundial-theme] naming failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'That name could not be recorded.' })
        }
      },
    }),
  )

  // ── What the assistant proposed ──────────────────────────────────────────
  // `gnomon_propose` writes an `assistant:proposal` signal and `assistantTrack`
  // folds it into `state.assistant.recent`. Until these two routes existed that
  // slice had two readers — `context.ts` and `ambient-context.ts`, both prompt
  // builders — and no surface: 23 proposals went into the model's OWN context
  // and nowhere a person could see, while the tool told the model the owner
  // could accept or reject them. These routes are the missing half. The verdict
  // writes the same `assistant:response` signal `gnomon_record_outcome` writes,
  // for the same reason a tapped answer and a typed one share a signal above.

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/assistant/proposals',
      handler: async (_req, res) => {
        try {
          const assistant = ctx.gnomonKernel.getState().assistant ?? { recent: [], proposedCount: 0, acceptedCount: 0, rejectedCount: 0 }
          const recent = Array.isArray(assistant.recent) ? assistant.recent : []
          sendJson(res, 200, {
            proposals: recent
              // `gnomon_run_shell` logged every command it ran to
              // `assistant:proposal` until 2026-09-09; it uses
              // `action:performed` now, but the rows it already wrote are still
              // in the ring, still `open`, and can never resolve — a command
              // that ran is not awaiting a verdict. All 23 rows on this record
              // were of that kind, which is why the surface first rendered as
              // 921px of shell history. Filtered by kind rather than migrated:
              // the log is append-only and these are readable there as what
              // they always were.
              .filter((p) => p.kind !== 'run_shell' && p.kind !== 'run_shell-refused')
              // Open ones only. A resolved proposal is a record, and Today is
              // for what still wants something from the owner.
              .filter((p) => p.outcome === 'open')
              .sort((a, b) => String(b.at).localeCompare(String(a.at))),
            // What was decided this week, newest first: a proposal that was
            // accepted is not "nothing to decide", it is the record of a decision.
            resolved: recent
              .filter((p) => p.kind !== 'run_shell' && p.kind !== 'run_shell-refused' && p.outcome !== 'open' && Date.now() - Date.parse(p.resolvedAt ?? p.at) < 7 * 86_400_000)
              .sort((a, b) => String(b.resolvedAt ?? b.at).localeCompare(String(a.resolvedAt ?? a.at)))
              .slice(0, 12),
            accepted: assistant.acceptedCount ?? 0,
            rejected: assistant.rejectedCount ?? 0,
          })
        } catch (error) {
          console.error(`[sundial-theme] assistant proposals failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The proposals could not be read.' })
        }
      },
    }),
  )

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/assistant/verdict',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { unavailable: 'A verdict takes a POST.' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) {
            body += chunk
            if (body.length > 4096) {
              sendJson(res, 413, { unavailable: 'That verdict is too long.' })
              return
            }
          }
        } catch {
          sendJson(res, 400, { unavailable: 'The verdict could not be read.' })
          return
        }

        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        const proposalId = typeof parsed?.proposalId === 'string' ? parsed.proposalId.trim() : ''
        const verdict = typeof parsed?.verdict === 'string' ? parsed.verdict.trim() : ''
        if (proposalId === '' || (verdict !== 'accepted' && verdict !== 'rejected')) {
          sendJson(res, 400, { unavailable: 'A verdict needs a proposalId and either "accepted" or "rejected".' })
          return
        }

        try {
          // `assistantTrack` ignores an id that is not an open proposal, so a
          // stale tab is inert rather than corrupting — same property the
          // answer route relies on.
          await ctx.gnomonKernel.appendSignal('assistant:response', { proposalId, verdict })
          sendJson(res, 200, { recorded: true, proposalId, verdict })
        } catch (error) {
          console.error(`[sundial-theme] verdict failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'That verdict could not be recorded.' })
        }
      },
    }),
  )

  // ── Untracked time, and what to call it ──────────────────────────────────
  // `attributionPropose` times every unattributed focus period by host or app.
  // These two routes are the surface: the biggest candidates as proposals, and
  // the owner's decision — which writes a ProjectRule to config.json AND
  // appends `attribution:rule-decided`, so the same rule lands on
  // `state.config.projectRules` in the fold and applies to the next window.

  /** Show a candidate once it has this much unattributed time. */
  const PROPOSAL_MIN_SECONDS = 15 * 60
  const PROPOSALS_MAX = 8
  // The one config path, honouring SUNDIAL_HOME: a second `join(homedir(), …)` is
// how a scratch run's decision lands in the real config file.
const CONFIG_PATH = getSundialConfigPath()

  /** Project names the owner already uses: known roots, rule targets, alias targets. */
  function knownProjectNames(state) {
    const names = new Set()
    for (const k of Object.values(state.project?.known ?? {})) if (typeof k?.name === 'string' && k.name !== '') names.add(k.name)
    for (const r of state.config?.projectRules ?? []) if (typeof r?.project === 'string') names.add(r.project)
    for (const v of Object.values(state.config?.projectAliases ?? {})) if (typeof v === 'string') names.add(v)
    return [...names].sort((a, b) => a.localeCompare(b))
  }

  /**
   * A guess at which project a candidate belongs to, from its own titles: a
   * project-name token of four letters or more that appears in the label or a
   * title (`puzzlebox` in "Puzzlebox - Backlog - Jira"). Offered first, never
   * applied — the owner picks.
   */
  function suggestProject(candidate, names) {
    const hay = [candidate.label, ...(candidate.titles ?? [])].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    let best = null
    for (const name of names) {
      const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4)
      const hit = tokens.find((t) => hay.includes(t))
      if (hit !== undefined && (best === null || hit.length > best.score)) best = { name, score: hit.length }
    }
    return best?.name ?? null
  }

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/attribution/proposals',
      handler: async (req, res) => {
        try {
          // The tail is readable on request: 153 of 161 places on this record
          // are under the fifteen-minute bar, and "the rest is small" is only
          // trustworthy if it can be looked at.
          const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
          const minSeconds = Math.max(0, Number(query.get('minMinutes') ?? '') * 60 || PROPOSAL_MIN_SECONDS)
          const limit = Math.min(400, Math.max(1, Number(query.get('limit') ?? '') || PROPOSALS_MAX))
          const state = ctx.gnomonKernel.getState()
          const ap = state.attributionProposals ?? { candidates: {}, decided: {} }
          const names = knownProjectNames(state)
          const all = Object.values(ap.candidates)
          const totalSeconds = all.reduce((n, c) => n + (c.seconds ?? 0), 0)
          const proposals = all
            .filter((c) => (c.seconds ?? 0) >= minSeconds)
            .sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0))
            .slice(0, limit)
            .map((c) => ({
              key: c.key,
              kind: c.kind,
              label: c.label,
              processName: c.processName,
              minutes: Math.round((c.seconds ?? 0) / 60),
              visits: c.visits ?? 0,
              days: (c.days ?? []).length,
              titles: (c.titles ?? []).slice(-4).reverse(),
              firstSeenAt: c.firstSeenAt,
              lastSeenAt: c.lastSeenAt,
              suggested: suggestProject(c, names),
              // The parts of a MULTI-PROJECT place, each answerable on its own:
              // figma.com is Northwind and Puzzles and overture, and one rule for
              // the host could only be wrong. Biggest first; a part worth under
              // a minute is not worth a row.
              parts: Object.entries(c.parts ?? {})
                .map(([partKey, part]) => ({
                  partKey,
                  kind: part.kind,
                  label: part.label,
                  minutes: Math.round(part.seconds / 60),
                  seconds: Math.round(part.seconds),
                  visits: part.visits,
                  suggested: suggestProject({ label: part.label, titles: [] }, names),
                }))
                .filter((part) => part.seconds >= 60)
                .sort((a, b) => b.seconds - a.seconds)
                .slice(0, 6),
            }))
          // Places already settled, so the owner sees the time is accounted for
          // rather than missing: shared work, personal time, and rules written.
          const settled = { assigned: 0, shared: 0, personal: 0, ambient: 0, ignored: 0 }
          for (const d of Object.values(ap.decided ?? {})) if (settled[d.decision] !== undefined) settled[d.decision] += 1
          sendJson(res, 200, {
            proposals,
            projects: names,
            thresholdMin: PROPOSAL_MIN_SECONDS / 60,
            totalUntrackedMin: Math.round(totalSeconds / 60),
            candidates: all.length,
            settled,
            sharedPlaces: state.config?.sharedPlaces ?? [],
          })
        } catch (error) {
          sendJson(res, 500, { unavailable: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/attribution/decide',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { unavailable: 'Deciding takes a POST.' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) {
            body += chunk
            if (body.length > 4096) {
              sendJson(res, 413, { unavailable: 'That decision is too long.' })
              return
            }
          }
        } catch {
          sendJson(res, 400, { unavailable: 'The decision could not be read.' })
          return
        }
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        const key = typeof parsed?.key === 'string' ? parsed.key.trim() : ''
        const DECISIONS = { assign: 'assigned', ignore: 'ignored', shared: 'shared', personal: 'personal', ambient: 'ambient' }
        const decision = DECISIONS[parsed?.decision] ?? null
        const project = typeof parsed?.project === 'string' ? parsed.project.trim().slice(0, 80) : ''
        // The part of the place being assigned, when the owner is splitting a
        // multi-project host rather than claiming all of it.
        const partKey = typeof parsed?.partKey === 'string' ? parsed.partKey.trim().slice(0, 200) : ''
        if (key === '' || decision === null || (decision === 'assigned' && project === '')) {
          sendJson(res, 400, { unavailable: 'A decision needs a key, and a project when it assigns one.' })
          return
        }
        const state = ctx.gnomonKernel.getState()
        const candidate = state.attributionProposals?.candidates?.[key] ?? null
        const kind = candidate?.kind ?? (key.startsWith('host:') ? 'host' : key.startsWith('app:') ? 'app' : null)
        const label = candidate?.label ?? key.replace(/^(host|app):/, '')
        if (kind === null || label === '') {
          sendJson(res, 404, { unavailable: 'That is not something Gnomon is timing.' })
          return
        }

        // The part the owner picked, when they picked one: `path:/puzzlez` or
        // `title:Planner`. The part decides how NARROW the rule is.
        const part = partKey === '' ? null : (state.attributionProposals?.candidates?.[key]?.parts?.[partKey] ?? null)

        let rule = null
        if (decision === 'assigned') {
          // A part narrows the rule to one path, one page title or one meeting,
          // which is what lets figma.com be Northwind on one file and overture on
          // another, and a Meet tab be whichever project the calendar says.
          // A rule the caller stated wins over one derived from the place: a
          // title or meeting rule cannot be worked out from a host alone, and it
          // is the durable kind. Both go through the ONE validator and the ONE
          // durability guard, which live in helpers beside the config parser.
          const built = parsed?.rule !== undefined ? { rule: sanitizeProjectRule({ ...parsed.rule, project }) } : ruleForPlace(kind, label, part, project)
          if (built.rule === null) {
            sendJson(res, 409, { unavailable: built.reason ?? 'a rule needs a project and at least one matcher.' })
            return
          }
          const unstable = unstableRuleReason(built.rule)
          if (unstable !== null) {
            sendJson(res, 409, { unavailable: unstable })
            return
          }
          rule = built.rule
        }
        // config.json is the durable half of every decision: a rule to match on,
        // a shared place to stop asking about, a personal one to classify as the
        // owner's own time. Written first — nothing is folded that was not saved.
        if (decision !== 'ignored') {
          try {
            let file = {}
            try {
              file = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error
            }
            if (rule !== null) {
              const rules = Array.isArray(file.projectRules) ? file.projectRules : []
              if (!rules.some((r) => JSON.stringify(r) === JSON.stringify(rule))) rules.push(rule)
              file.projectRules = rules
            }
            if (decision === 'shared') {
              const shared = Array.isArray(file.sharedPlaces) ? file.sharedPlaces : []
              const entry = kind === 'host' ? label : `app:${label}`
              if (!shared.some((e) => String(e).toLowerCase() === entry.toLowerCase())) shared.push(entry)
              file.sharedPlaces = shared
            }
            if (decision === 'personal' || decision === 'ambient') {
              // The owner's own taxonomy, not a project rule: a host goes in the
              // domain overrides, an app in the process overrides. `ambient` is
              // the class their taxonomy has for music playing while they work —
              // filing that as leisure would mean they never lack rest, which
              // silently disables the detector that exists to notice exactly that.
              const leisure = typeof file.leisureRules === 'object' && file.leisureRules !== null ? file.leisureRules : {}
              const bucket = kind === 'host' ? 'domainOverrides' : 'processes'
              const group = typeof leisure[bucket] === 'object' && leisure[bucket] !== null ? leisure[bucket] : {}
              const list = Array.isArray(group[decision]) ? group[decision] : []
              if (!list.some((e) => String(e).toLowerCase() === label.toLowerCase())) list.push(label)
              file.leisureRules = { ...leisure, [bucket]: { ...group, [decision]: list } }
            }
            await writeFile(CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
          } catch (error) {
            console.error(`[sundial-theme] could not write ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`)
            sendJson(res, 500, { unavailable: 'The decision could not be written to config.json, so nothing was changed.' })
            return
          }
        }
        try {
          await ctx.gnomonKernel.appendSignal('attribution:rule-decided', { key, kind, decision, project: project || null, ...(partKey ? { partKey } : {}), ...(rule ? { rule } : {}) })
          console.log(`[sundial-theme] attribution ${decision}: ${key}${project ? ` → ${project}` : ''}`)
          sendJson(res, 200, { recorded: true, key, decision, rule })
        } catch (error) {
          console.error(`[sundial-theme] decision failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'That decision could not be recorded.' })
        }
      },
    }),
  )

  // Everything the Today page states, in one round trip. It is a projection of
  // `buildDailyContext` — the same day the journal and the assistant read —
  // trimmed to what the page actually shows rather than shipped whole: the
  // full context carries a timeline of every moment, and the page draws none
  // of it.
  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/today',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const date = spanFrom(url, () => ctx.gnomonKernel.getState?.()).date
          const context = await buildDailyContext(date, { timeZone: loadSundialConfig().timezone })
          sendJson(res, 200, {
            date,
            coverage: context.coverage,
            focus: context.focus,
            noProjectMin: context.noProjectMin,
            // Biggest first: the day's shape is the finding, and a list in
            // record order buries it.
            projects: [...context.projects]
              .sort((a, b) => b.minutes - a.minutes)
              .slice(0, 6)
              .map((project) => ({ name: project.name, minutes: project.minutes, commits: project.commits, confidence: project.confidence })),
            noticed: context.anomalies.slice(0, 4).map((anomaly) => ({ title: anomaly.title, body: anomaly.body })),
            meetings: context.meetings.length,
            // The files worked in most today, off the fold's hot-files ring. Only
            // for today: the ring is reset at the day boundary.
            hotFiles: date === today() ? hotFilesOf(ctx.gnomonKernel.getState?.()) : [],
          })
        } catch (error) {
          console.error(`[sundial-theme] today failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'Today could not be read.' })
        }
      },
    }),
  )

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/dial',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const asked = spanFrom(url, () => ctx.gnomonKernel.getState?.())
          const date = asked.date
          // `days=N` returns the N days ENDING at `date`, newest first, as
          // `{ days: [{ date, ...figure }] }`. Strata wants a fortnight of
          // dials and used to ask fourteen times; the harness is one thread, so
          // fourteen round trips queued behind each other and behind everything
          // else the board wanted at the same moment. The work is identical —
          // this only stops paying for the queue.
          // The board's span counts as `days` here too: a dial asked for one
          // day draws one face, and a dial on a fortnight draws the fortnight.
          const days = Math.min(60, Math.max(0, asked.days > 1 ? asked.days : Number(url.searchParams.get('days')) || 0))
          if (days > 0) {
            const dates = Array.from({ length: days }, (_, i) => shiftDate(date, -i))
            const figures = await Promise.all(dates.map((on) => composeFigure({ kind: 'dial-slice', date: on })))
            sendJson(res, 200, { days: dates.map((on, i) => ({ date: on, ...figures[i] })) })
            return
          }
          const figure = await composeFigure({ kind: 'dial-slice', date })
          // `unavailable` is a real answer, not an error: a day with nothing
          // observed has no shape, and saying so is more honest than an empty
          // dial that looks like an idle day.
          sendJson(res, 200, figure)
        } catch (error) {
          console.error(`[sundial-theme] dial figure failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The dial could not be composed.' })
        }
      },
    }),
  )

  // ── The Unsaid ──────────────────────────────────────────────────────────
  // What Gnomon noticed today and what it did about it: said, held, dropped.
  //
  // This is the surface the noticing gate has never had. Every verdict it
  // reaches — admitted or not — is already written to `gate_decisions` with its
  // full arithmetic; nothing read those rows, so the gate's whole output was
  // invisible and a tonic notice (one a day, by design) landed in a context
  // injection the owner had no way to see. A gate that cannot be watched cannot
  // be trusted or corrected, and `not-now` is the signal habituation trains on.
  //
  // A projection, not a recount: the numbers are the ones the rule already
  // decided with, so this page can never disagree with what actually happened.
  // What is on the shelf, with the owner's verdict on each — one reading, used by
  // the Shelf route and by the situation (S1), so "3 waiting for you" and the
  // shelf it points at can never disagree.
  const readShelf = async () => {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const entries = (await getKnowledgeEntriesSince(since)).filter((entry) => entry.kind === 'shelf' && entry.retractedAt === null)
    // The owner's verdicts, read back from the log so a refresh does not
    // re-offer the buttons: the latest `feedback:verdict` per shelf item.
    // From the log rather than `state.feedback.recent`, which is a
    // 50-entry ring and would forget a Keep from last week.
    const verdicts = new Map()
    for (const signal of await getSignalsInRange(since, new Date(Date.now() + 60_000).toISOString(), 2000, ['feedback'])) {
      let data = signal.data
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data)
        } catch {
          continue
        }
      }
      if (data?.artifactKind !== 'knowledge_entry' || typeof data.artifactId !== 'string') continue
      verdicts.set(data.artifactId, { verdict: data.verdict, at: signal.capturedAt ?? signal.captured_at })
    }
    return (
      entries
        // "Not now" takes it off Today; it stays in the record.
        .filter((entry) => verdicts.get(entry.id)?.verdict !== 'not-now')
        .map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt, verdict: verdicts.get(entry.id)?.verdict ?? null }))
    )
  }

  // S1 — the situation: what is true right now, in one object. The same
  // `buildSituation` the agent's standing context calls, so the screen and the
  // agent read one present. See `packages/kernel/src/situation.ts`.
  instrument('/gnomon/situation', 'The situation could not be read.', async () => {
    const state = ctx.gnomonKernel.getState()
    if (!state) return { unavailable: 'The kernel has not booted.' }
    const [leftOff, shelf] = await Promise.all([getLeftOff(new Date(Date.now() - 14 * 86_400_000).toISOString()), readShelf()])
    return buildSituation(state, { leftOff, shelfWaiting: shelf.filter((item) => item.verdict === null).length })
  })

  // The shelf: what Gnomon made on its own (the `workbench` rule's jobs, or
  // something the owner asked to keep), as `knowledge_entries` of kind `shelf`,
  // newest first, plus the job in progress. A verdict on an item goes through
  // `/gnomon/api/feedback` like any knowledge entry — `wrong` retracts it.
  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/shelf',
      handler: async (req, res) => {
        try {
          const state = ctx.gnomonKernel.getState()
          const bench = state?.workbench ?? { open: null, recent: [], countToday: 0 }
          sendJson(res, 200, {
            items: await readShelf(),
            working: bench.open ? { kind: bench.open.kind, subject: bench.open.subject, reason: bench.open.reason, since: bench.open.openedAt } : null,
            recent: (bench.recent ?? []).slice(-8).reverse().map((job) => ({ kind: job.kind, subject: job.subject, outcome: job.outcome, closedAt: job.closedAt })),
            countToday: bench.countToday ?? 0,
          })
        } catch (error) {
          console.error('[sundial-theme] /gnomon/shelf failed:', error)
          sendJson(res, 500, { unavailable: 'The shelf could not be read.' })
        }
      },
    }),
  )

  // The shelf of lenses. A lens card is disposable — remove, clear or load a
  // scene all take it — but the QUESTION it encodes is not, so `board.lenses`
  // keeps every spec and this lists them. `up` says which are on the board now,
  // which is the difference between "go look" and "put it back".
  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/lenses',
      handler: async (_req, res) => {
        const board = ctx.gnomonKernel.getState?.()?.board
        const up = new Set(Object.keys(board?.cards ?? {}))
        const lenses = Object.entries(board?.lenses ?? {})
          .map(([id, lens]) => ({ id, title: lens.title, spec: lens.spec, at: lens.at, up: up.has(id) }))
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        sendJson(res, 200, { lenses })
      },
    }),
  )

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/unsaid',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const date = spanFrom(url, () => ctx.gnomonKernel.getState?.()).date
          const timeZone = loadSundialConfig().timezone
          const { start, end } = localDayRange(date, timeZone)
          // **Two spans, deliberately, and the card is pinned to the wider one.**
          //
          // The Today card and the mood card both ask this route what Gnomon
          // said TODAY, and that contract stays exactly as it was —
          // `counts`/`said`/`held`/`dropped` are still one local day.
          //
          // The Unsaid card is not about a day. Its subject is the BAR, and a
          // bar is a property of the record: the gate reaches about nine
          // verdicts on a working day but one or two on eight of its thirty
          // days, so a day is too thin to argue a threshold from. So the card
          // reads `decisions`, which is every decision the gate has ever made,
          // and says the pin on its face the way the asks card does.
          const whole = await getGateDecisionsBetween('1970-01-01T00:00:00.000Z', new Date(Date.now() + 60_000).toISOString())
          const decisions = whole.filter((row) => row.decidedAt >= start && row.decidedAt < end)
          // The decision table records the VERDICT and its terms, not the words
          // — the observation lives on the `notice:candidate` signal the verdict
          // was about. Their ids differ (each is its own derived id) but they
          // share the key and land in the same instant, so the nearest earlier
          // candidate with the same key is the one that was decided. Joined
          // here so the Unsaid page can show what Gnomon nearly said, not just
          // that it nearly said something.
          const candidates = new Map()
          for (const signal of await getSignalsInRange('1970-01-01T00:00:00.000Z', new Date(Date.now() + 60_000).toISOString(), 4000, ['notice'])) {
            let data = signal.data
            if (typeof data === 'string') {
              try {
                data = JSON.parse(data)
              } catch {
                continue
              }
            }
            if (!data || typeof data.key !== 'string') continue
            const at = Date.parse(signal.capturedAt ?? signal.captured_at ?? '')
            const list = candidates.get(data.key) ?? []
            list.push({ at, observation: data.observation, evidence: data.evidence })
            candidates.set(data.key, list)
          }
          const withWords = (row) => {
            const list = candidates.get(row.noticeKey) ?? []
            const decidedAt = Date.parse(row.decidedAt ?? '')
            let best = null
            for (const c of list) {
              if (Number.isFinite(decidedAt) && c.at > decidedAt + 5_000) continue
              if (best === null || c.at > best.at) best = c
            }
            return best === null ? row : { ...row, observation: best.observation ?? null, evidence: best.evidence ?? [] }
          }
          const rows = decisions.map(withWords)
          const everything = whole.map(withWords)

          // Grouped by what the owner would ask: what did you say, what are you
          // sitting on, and what did you throw away — with `reason` kept so
          // "dropped" can distinguish "I've said this too often" from "not
          // interesting enough", which are different corrections.
          // The verdict the owner already gave this notice, carried on the row.
          //
          // Without it the card could only settle in the DOM: pressing "Useful"
          // wrote a `feedback:verdict` and replaced the buttons with the word,
          // and then the next gate decision of the day re-read the route,
          // rebuilt the table, and put the buttons back as though nothing had
          // been said. The owner reported it as "I clicked useful and I don't
          // think it works" — it worked every time, and looked like it never
          // had. A rating is part of the reading, not a state of the widget.
          //
          // Read from the LOG, not from `state.feedback.recent`. That ring
          // holds fifty entries of every kind, and the record has 172 verdicts
          // in it — so on a card pinned to the whole record it would have
          // forgotten 36 of the 44 verdicts the owner has given a notice, and
          // re-offered the buttons on rows they had already judged. Same
          // reasoning as `/gnomon/shelf`, and the same shape.
          const state = ctx.gnomonKernel.getState()
          const ratedNotices = new Map()
          for (const signal of await getSignalsInRange('1970-01-01T00:00:00.000Z', new Date(Date.now() + 60_000).toISOString(), 4000, ['feedback'])) {
            let data = signal.data
            if (typeof data === 'string') {
              try {
                data = JSON.parse(data)
              } catch {
                continue
              }
            }
            if (data?.artifactKind !== 'notice' || typeof data.artifactId !== 'string') continue
            ratedNotices.set(data.artifactId, { verdict: data.verdict, at: signal.capturedAt ?? signal.captured_at })
          }
          const withVerdict = (row) => {
            const rated = row.noticeKey ? ratedNotices.get(row.noticeKey) : undefined
            return rated === undefined ? row : { ...row, verdict: rated.verdict, verdictAt: rated.at }
          }

          const said = rows.filter((row) => row.channel === 'phasic' || row.channel === 'tonic').map(withVerdict)
          const held = rows.filter((row) => row.channel === 'deferred').map(withVerdict)
          const dropped = rows.filter((row) => row.channel === 'suppressed')

          // The question Gnomon set itself, if it currently holds one. Served
          // beside the gate's verdicts because they answer the same owner
          // question — "what are you actually doing?" — from the two directions:
          // what it chose to look into, and what it chose to say.
          const open = (state?.mind?.goals ?? []).find((entry) => entry.closedAt === null) ?? null

          // **The asks come off the card, and the filter is here so the client
          // never has to know.** 63 of the record's decisions are
          // `owner-question`, and every one of them has `weight` exactly 2.0
          // and `habituation` exactly 1.0 — the gate does nothing to an ask
          // but price the interruption. They are a quarter of the rows and a
          // constant, and they have had their own card since I7.
          const noticing = everything.filter((row) => row.kind !== 'owner-question').map(withVerdict)

          // Today's ambient budget, from the gate's OWN counter rather than
          // recounted here. `spentToday` is what `applyDelivery` incremented
          // and what `decide` will read tomorrow morning; a recount off the
          // rows would disagree with it the moment the day rolled over, and a
          // budget figure that disagrees with the budget is worse than none.
          const notices = state?.notices ?? {}
          const budget = { spent: notices.day === date ? (notices.spentToday ?? 0) : 0, of: GATE_DAILY_BUDGET, refused: rows.filter((row) => row.reason === 'budget-spent').length }

          sendJson(res, 200, {
            date,
            // Where the two bars stand RIGHT NOW. The owner's own dial scales
            // both of them (`noticeGate` reads `settings.noticeBias` before it
            // weighs anything), so a card that drew the policy's shipped
            // constants would draw a bar the gate has not used since the dial
            // last moved — which it does not, on this machine, today.
            bars: barsFor(state?.settings?.noticeBias ?? 0),
            // Every decision the gate has ever reached about a NOTICE, newest
            // last, with its words and the owner's verdict. The card's rows.
            decisions: noticing,
            budget,
            goal:
              open === null
                ? null
                : {
                    label: open.label,
                    question: open.question,
                    openedAt: open.openedAt,
                    expectedLoss: open.openedWith.expectedLoss,
                    n: open.openedWith.n,
                    // The hypothesis under test, when the model has proposed one
                    // — the difference between "watching" and "investigating".
                    hypothesis: open.hypothesis ?? null,
                    tried: open.tried ?? [],
                  },
            counts: { said: said.length, held: held.length, dropped: dropped.length },
            said,
            held,
            // Heaviest first: the most interesting question about a dropped row is
            // "was that a mistake?", and the heaviest one is the likeliest to be.
            dropped: [...dropped].sort((a, b) => b.weight - a.weight).slice(0, 20),
          })
        } catch (error) {
          console.error(`[sundial-theme] unsaid failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The gate log could not be read.' })
        }
      },
    }),
  )

  // ── The ledger ──────────────────────────────────────────────────────────
  // Everything the Ledger page states, in one round trip: the
  // windowed rollup of `llm_audit` (the single ledger every LLM call in the
  // system writes — chat turns and background purposes alike), the per-day
  // shape of the last month, per-model spend at list price, today's budget
  // against its caps, and the most recent calls.

  /** Named windows → span in days; anything else means the whole ledger. */
  const LEDGER_WINDOWS = { today: 1, '7d': 7, '30d': 30 }

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/ledger',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          // No exception for money. The ledger used to own a private `7d`/`30d`
          // strip that nothing else could read, so the board could show a
          // fortnight of activity beside a week of spend and say neither.
          // `window=` still wins when a caller names one, which is how a pinned
          // card and `gnomon_look` keep working.
          const windowParam = url.searchParams.get('window')
          const asked = spanFrom(url, () => ctx.gnomonKernel.getState?.(), 7)
          const windowDays = windowParam ? LEDGER_WINDOWS[windowParam] : asked.days
          const config = loadSundialConfig()
          const timeZone = config.timezone
          const todayStr = localDate(new Date().toISOString(), timeZone)
          const since = windowDays ? localDayRange(shiftDate(windowParam ? todayStr : asked.to, -(windowDays - 1)), timeZone).start : null

          const [overview, models, recent, lostAnswers] = await Promise.all([
            getLlmAuditOverview(since ?? undefined),
            getLlmAuditByModel(since ?? undefined),
            getRecentLlmAudit(30),
            getLostAnswers(since ?? undefined),
          ])

          // The day breakdown belongs to the window the card claims.
          //
          // It used to be the last thirty days whatever the window, on the
          // argument that today's number alone cannot say whether today is
          // normal. That argument lost: a reader of the `ledger` card saw
          // `window: 7d` above a list running Aug 19 → Sep 3 — the eight OLDEST
          // of twenty-two days, because the card's own result trimmer cuts an
          // array from the end and the days arrived oldest-first. Days outside
          // the stated window and the newest days missing, in the one block
          // whose whole job is "what has it been doing lately".
          //
          // So: the window's own days, newest first, and a trim now takes the
          // most recent ones. An unwindowed read still gets the whole ledger.
          const daily = (await getLlmAuditDaily(timeZone, since ?? undefined)).reverse()

          // Today's budget: the caps from config against the ledger's own
          // count of today's calls per purpose. `state.budgets` is the
          // enforcing counter's live twin; the audit table is its persistent
          // record, and this route already trusts it for everything else.
          const caps = resolveDailyCaps(config.budgets)
          const todayOverview = windowDays === 1 ? overview : await getLlmAuditOverview(localDayRange(todayStr, timeZone).start)
          const usedToday = new Map(todayOverview.byPurpose.map((p) => [p.purpose, p.calls]))
          const budgets = {
            day: todayStr,
            // What today has cost so far, beside the caps that stop it. The
            // window's total answers "is this expensive"; only today's answers
            // "is it expensive RIGHT NOW".
            spentUsd: todayOverview.summary.estimatedCostUsd,
            calls: todayOverview.summary.calls,
            // Closest to its cap first: the only ordering in which the block
            // answers "is anything about to stop?" at a glance.
            purposes: Object.entries(caps)
              .map(([purpose, cap]) => ({ purpose, cap, used: usedToday.get(purpose) ?? 0 }))
              .sort((a, b) => b.used / b.cap - a.used / a.cap),
          }

          sendJson(res, 200, {
            generatedAt: new Date().toISOString(),
            // What the card says it is showing, whoever chose it: the caller's
            // own `window`, else the board's span by its own name.
            window: windowDays ? (windowParam ?? asked.label ?? `${asked.days}d`) : 'all',
            since,
            timeZone,
            summary: overview.summary,
            byPurpose: overview.byPurpose,
            latencyHistogram: overview.latencyHistogram,
            failureReasons: overview.failureReasons,
            unpricedRemoteModels: overview.unpricedRemoteModels,
            daily,
            models,
            budgets,
            recent,
            // The two questions the card could not answer: which of these
            // failures cost an ANSWER, and what the failing cost in money.
            lostAnswers,
            wasted: {
              billedOnFailureTokens: overview.summary.billedOnFailureTokens,
              billedOnFailureUsd: overview.summary.billedOnFailureUsd,
              retrySpendUsd: overview.summary.retrySpendUsd,
              failedMs: overview.summary.failedMs,
              lastFailureAt: overview.summary.lastFailureAt,
            },
          })
        } catch (error) {
          console.error(`[sundial-theme] ledger failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The ledger could not be read.' })
        }
      },
    }),
  )

  // One call's full row — prompt and response bodies included — fetched only
  // when a row in the Ledger is expanded (the list itself never carries
  // bodies; see `getRecentLlmAudit`).
  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/ledger/call',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const id = url.searchParams.get('id')
          if (!id) {
            sendJson(res, 400, { unavailable: 'A call id is required.' })
            return
          }
          const row = await getLlmAuditById(id)
          if (!row) {
            sendJson(res, 404, { unavailable: 'No such call.' })
            return
          }
          sendJson(res, 200, row)
        } catch (error) {
          console.error(`[sundial-theme] ledger call failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'The call could not be read.' })
        }
      },
    }),
  )

  // ── The instruments ─────────────────────────────────────────────────────
  // Five projections over data Gnomon has always written and nothing has ever
  // read back. The counts that motivated them, from one live 18-day database:
  // 182,385 signals, 29,922 applied effects, 2,784 moments, 2,760 embeddings,
  // 335 resolved predictions and 212 entity facts, against a UI that showed a
  // dial, four insight titles and the LLM ledger.
  //
  // Every one of them is a PROJECTION, in the same sense the Unsaid page is:
  // each reads the queries the rest of the system already decided with, and
  // recomputes nothing. A second implementation of "how good is the pipeline"
  // would drift from the pipeline the first time either changed, and a
  // transparency surface that can disagree with the thing it reports on is
  // worse than no surface at all.
  //
  // Nothing outside this plugin changes: no rule, no schema, no query. That is
  // the deliberate shape of the visibility pass — it cannot alter what Gnomon
  // believes, only what the owner can see of it.

  /** One read-only JSON instrument, with the failure grammar the routes above use. */
  function instrument(path, unavailable, read) {
    ctx.effect(() =>
      registerRoute({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            sendJson(res, 200, await read(new URL(req.url ?? '/', 'http://127.0.0.1')))
          } catch (error) {
            console.error(`[sundial-theme] ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
            sendJson(res, 500, { unavailable })
          }
        },
      }),
    )
  }

  const MINUTE = 60_000

  /** How far back a habit is read. Eight weeks is enough for a weekday rhythm and bounds the scan. */
  const RITUAL_WEEKS = 8

  // Trust — is the machine actually working?
  //
  // The honest denominator first: `coverage.observedHours` counts the
  // `input:activity` emits seen per local hour, so it measures how long the
  // daemon was watching rather than how busy the owner was. Every other number
  // on this page is a claim ABOUT a day, and a claim over a 1.2-hour
  // observation is a statement about the daemon, not the owner.
  // Setup — the first-run page's one reading. Permissions from the sidecars'
  // own grant flags (null = the sensor has not reported yet, never a guess),
  // whether a model is configured (host and model only, never the key), and
  // how much the record holds, which is the proof that capture works.
  instrument('/gnomon/setup', 'Setup could not be read.', async () => {
    const home = getSundialHome()
    const base = process.env.SUNDIAL_LLM_BASE_URL ?? ''
    let host = null
    try {
      host = base ? new URL(base).host : null
    } catch {
      host = null
    }
    // Shown to the person, so ~ rather than /Users/<name>.
    const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p)
    const label = process.env.SUNDIAL_LABEL ?? 'dev.sundial.agent'
    return {
      home: tilde(home),
      // Where the app is, for the "add this to the list" step: /Applications for the real install.
      app: tilde(process.env.SUNDIAL_APP_PATH || join(home, 'Sundial.app')),
      bundleId: process.env.SUNDIAL_BUNDLE_ID ?? (label === 'dev.sundial.agent' ? 'dev.sundial.daemon' : label),
      envFile: tilde(join(home, '.env')),
      permissions: getPermissionStatus(),
      llm: { configured: Boolean(base), host, model: process.env.SUNDIAL_LLM_MODEL ?? null, local: host !== null && /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host) },
      record: await getSignalTotals(),
      moments: (await getLatestMoments(3)).map((m) => ({ start: m.startTime, end: m.endTime, app: m.processName, title: Array.isArray(m.data.windowTitles) ? m.data.windowTitles[0] ?? null : null })),
    }
  })

  instrument('/gnomon/trust', 'The instruments could not be read.', async () => {
    const timeZone = loadSundialConfig().timezone
    const since = new Date(Date.now() - 24 * 60 * MINUTE).toISOString()
    // `getMemoryTierCounts` is GONE from this card, per the audit: signals,
    // moments, entries, entities and facts are VOLUME, and volume belongs on
    // the ledger beside what the thinking cost (L9). A trust surface answers
    // how much of the owner's life was seen and what became of it; how many
    // rows that filled is a different question and was the loudest panel here.
    const [pipeline, embeddings, freshness, redaction, retracted, observedDays] = await Promise.all([
      getPipelineCoverage(),
      getEmbeddingHealth(),
      getSignalFreshness(),
      getRedactionHealth(since, 24),
      listRetractedFacts(40),
      // The whole record, from the log, not the fifteen days the kernel's
      // bounded mirror keeps — see `getObservedHours` for why the surface and
      // the fold read different sources for the same measure.
      getObservedHours(),
    ])

    // UTC hours folded into LOCAL days here rather than in SQL, where the
    // shift would have to be a constant and would be an hour wrong on one side
    // of every daylight saving change.
    const perDay = new Map()
    for (const { hour, share } of observedDays) perDay.set(localDate(`${hour}:00:00.000Z`, timeZone), (perDay.get(localDate(`${hour}:00:00.000Z`, timeZone)) ?? 0) + share)
    const observed = [...perDay.entries()].map(([date, hours]) => ({ date, hours: Math.round(hours * 100) / 100 })).sort((a, b) => (a.date < b.date ? -1 : 1))

    const now = Date.now()
    // Quietest first: a sensor that stopped is the only thing this list is for,
    // and one that fired a second ago says nothing worth ranking.
    const sensors = freshness
      .map((row) => ({
        stream: `${row.signalType}:${row.eventType}`,
        lastCapturedAt: row.lastCapturedAt,
        quietMin: Math.max(0, Math.round((now - Date.parse(row.lastCapturedAt)) / MINUTE)),
      }))
      .sort((a, b) => b.quietMin - a.quietMin)

    const state = ctx.gnomonKernel.getState()

    const config = loadSundialConfig()
    return {
      generatedAt: new Date().toISOString(),
      timeZone,
      // Calendar day, deliberately: the Trust card's coverage calendar is about
      // dates, and K0.6's waking day belongs only to the Rhythm arcs.
      today: localDate(new Date().toISOString(), timeZone),
      pipeline,
      embeddings,
      // The owner's taps by verdict (J0.8) — the tally every learned
      // threshold will hang off, read from the fold rather than the log.
      feedback: { countsByVerdict: state?.feedback?.countsByVerdict ?? {}, lastVerdictAt: state?.feedback?.lastVerdictAt ?? null },
      // J2.3: the belief audit — when it last ran, and every retraction with
      // the answers behind it (null when an owner tap closed the fact).
      beliefAudit: { lastRunAt: state?.memory?.lastBeliefAuditAt ?? null, retracted },
      // J2.4: names that may be one thing — the exact leg's same-name roots
      // and the judge's answers at or above its threshold. Suggestions only;
      // the owner's projectAliases is what merges.
      aliasAlignment: { lastRunAt: state?.memory?.lastAliasAlignmentAt ?? null, suggestions: state?.memory?.aliasSuggestions ?? [] },
      // J2.1's gate: the owner-state filter scored against the owner's own taps,
      // and how many days of taps there are toward the fourteen the gate wants.
      perception: (() => {
        const o = state?.owner
        const reports = Array.isArray(o?.selfReports) ? o.selfReports : []
        const days = new Set(reports.map((r) => r.ts.slice(0, 10))).size
        return { n: o?.brier?.n ?? 0, brier: o?.brier?.n ? o.brier.sum / o.brier.n : null, days, firstAt: o?.brier?.firstAt ?? null, target: { brier: 0.15, days: 14 }, inGateCost: state?.config?.experiments?.ownerStateInGateCost === true }
      })(),
      // J5.4 / J5.2: is it getting better? Every judged question with its
      // learned or default threshold, the owner's verdicts on it and the
      // reliability deciles; and how long the judge has been off its own model.
      judgement: (() => {
        const j = state?.judgement ?? {}
        const records = j.questions ?? {}
        const catalog = new Map((ctx.gnomonKernel.questionCatalog?.() ?? []).map((q) => [q.id, q]))
        const questions = Object.entries(records).map(([id, r]) => {
          const meta = catalog.get(id)
          return { id, set: meta?.set ?? '?', key: meta?.key ?? id, type: r.type, threshold: r.threshold, learned: r.n >= (meta?.learnsAt ?? 20), n: r.n, hits: r.hits, bins: r.bins, lastVerdictAt: r.lastVerdictAt }
        })
        const degradedSince = j.degradedSince ?? null
        return {
          degraded: j.degraded ?? 'none',
          degradedSince,
          degradedMs: (j.degradedMs ?? 0) + (degradedSince ? Math.max(0, Date.now() - Date.parse(degradedSince)) : 0),
          questions,
          learnsAt: 20,
        }
      })(),
      redaction: {
        windowHours: redaction.windowHours,
        totalRedactions: redaction.totalRedactions,
        redactableEvents: redaction.redactableEvents,
        properties: redaction.properties,
        bySource: redaction.bySource.slice(0, 8),
      },
      sensors,
      observed,
      // Which opt-in sensors are actually switched on. A clipboard poller and
      // a screen reader running are exactly the facts a trust surface owes the
      // owner, and nothing on this board said either.
      optIn: {
        clipboardEnabled: Boolean(config.clipboardEnabled),
        ocr: Boolean(config.ocr?.enabled),
        vision: Boolean(config.ocr?.vision?.enabled),
        vault: typeof config.vault === 'string' && config.vault !== '',
        mail: config.privacy?.mail === true,
      },
    }
  })

  // Memory — every name Gnomon holds a belief about, with the beliefs ON it.
  //
  // The `?entity=` branch is GONE, and its deletion is the shape of the card.
  // It fetched one entity's facts to replace the whole panel with them, which
  // is why the owner called this the hardest page to browse: the only way to
  // read a belief was to leave the list, and the only way back was a "← All"
  // button. The beliefs ride along now, so a row folds open in place and the
  // search below can look INSIDE them. Measured before deciding: 442 current
  // facts over 221 names, about 90KB — one read where there were 222.
  //
  // The supersede history went with it. It was queried on every open, sliced to
  // 120 rows, and never rendered; a belief the card no longer holds belongs on
  // the entity drill-down in explore (D-J/M), not here.
  instrument('/gnomon/memory', 'Memory could not be read.', async () => {
    const [everything, edges, facts] = await Promise.all([getAllEntities(), getEntityGraphEdges(), getCurrentFactsWithProof()])
    // W2 — an entity with no CURRENT fact is a shell: everything it held was
    // retracted or superseded. The world-hygiene pass left 67 topics like that
    // (code symbols whose one fact came from a retired producer), and served
    // they read as "75 topics" on a record holding eight. Absent, not zero.
    const held = new Set(facts.map((fact) => fact.entityId))
    const entities = everything.filter((entity) => held.has(entity.id))

    const byEntity = new Map()
    for (const fact of facts) {
      const list = byEntity.get(fact.entityId) ?? []
      list.push({
        id: fact.id,
        predicate: fact.predicate,
        object: fact.object,
        confidence: fact.confidence,
        alpha: fact.alpha,
        validFrom: fact.validFrom,
        provenance: fact.provenance,
        momentId: fact.momentId ?? null,
        momentStart: fact.momentStart ?? null,
      })
      byEntity.set(fact.entityId, list)
    }

    const byKind = new Map()
    for (const entity of entities) byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1)

    const rows = entities.map((entity) => {
      const own = byEntity.get(entity.id) ?? []
      return {
        id: entity.id,
        kind: entity.kind,
        canonicalName: entity.canonicalName,
        facts: own,
        // `getAllEntities().factCount` counts superseded rows too. The card
        // draws current belief, so the number beside a name is the number of
        // rows its fold opens on — a reader and a renderer disagreeing about a
        // count is exactly what F exists to catch.
        factCount: own.length,
        ownerSaid: own.filter((f) => f.provenance === 'assertion').length,
        lastLearned: own.reduce((latest, f) => (String(f.validFrom) > latest ? String(f.validFrom) : latest), ''),
      }
    })

    return {
      counts: {
        entities: entities.length,
        facts: facts.length,
        // What can actually be SHOWN as evidence, said three ways because the
        // three are different answers, not one number with holes in it.
        ownerSaid: facts.filter((f) => f.provenance === 'assertion').length,
        proved: facts.filter((f) => f.momentId).length,
        edges: edges.length,
        // A superseded edge is history, not belief: counted apart so "what does
        // it think now" and "what has it changed its mind about" stay separate.
        supersededEdges: edges.filter((edge) => edge.superseded).length,
        byKind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
      },
      // Most-known first: an entity with one fact is a name, and an entity with
      // twenty is something Gnomon actually has a picture of.
      entities: rows.sort((a, b) => b.factCount - a.factCount || String(b.lastLearned).localeCompare(String(a.lastLearned))),
    }
  })

  // Calibration — the forecaster's own record.
  //
  // `predictions` holds one row per resolution and every row is already scored;
  // this bins them by claimed probability so the question "when it says 70%,
  // does it happen 70% of the time" can be answered by looking rather than
  // trusted. The Brier score comes from `tallyPredictions` rather than being
  // recomputed here, for the no-second-implementation reason above.
  // Lab — Gnomon's self-evolving state in one live pane: the experiments it has
  // scheduled for itself (wake-ups keyed `experiment-*`), the questions it is
  // holding open (research goals, with the cell's live evidence count), and
  // how its proposals and notices fared this week. A JOIN of records that
  // already exist — no new kind, nothing written. The shape is `LabReading`.
  instrument('/gnomon/lab', 'The lab could not be read.', async () => {
    const state = ctx.gnomonKernel.getState()
    const now = Date.now()
    const week = new Date(now)
    week.setHours(0, 0, 0, 0)
    week.setDate(week.getDate() - ((week.getDay() + 6) % 7)) // Monday
    const inWeek = (iso) => typeof iso === 'string' && Date.parse(iso) >= week.getTime()
    const mind = state?.mind ?? {}
    // Every scheduled wakeup that is LAB work, not just the ones whose key
    // happens to start with `experiment-`. That prefix match reported an empty
    // bench while `weekly-self-audit` — Gnomon's own standing review of its
    // week, and the most lab-like thing it does — sat scheduled on it.
    const experiments = (state?.wakeups?.open ?? [])
      .filter((w) => typeof w.key === 'string' && (w.key.startsWith('experiment-') || w.key.includes('audit')))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      // The prefix comes off only when it IS the prefix. `slice(11)` on
      // `weekly-self-audit` produced a bench row literally called " audit".
      .map((w) => ({
        key: w.key,
        name: (w.key.startsWith('experiment-') ? w.key.slice('experiment-'.length) : w.key).replace(/-/g, ' '),
        at: w.at,
        scheduledAt: w.scheduledAt,
        reason: w.reason,
        status: Date.parse(w.at) <= now ? 'due' : 'scheduled',
      }))
    const questions = (mind.goals ?? []).map((goal) => {
      // The cell's evidence as it stands now; a goal whose cell left the map keeps the count it closed (or opened) with.
      const cell = (mind.gaps ?? []).find((gap) => `${gap.forecaster}:${gap.cell}` === goal.id) ?? null
      return {
        id: goal.id,
        question: goal.question,
        label: goal.label,
        evidence: cell?.n ?? goal.closedWith?.n ?? goal.openedWith?.n ?? 0,
        status: goal.closedAt ? (goal.outcome ?? 'closed') : 'open',
        openedAt: goal.openedAt,
        closedAt: goal.closedAt ?? null,
        // What the card needs to decide whether to believe an outcome: how
        // much evidence the study actually gathered while it ran, and whether
        // anyone wrote down what it concluded. Both were already in state and
        // neither reached the page — so "learned" was printed with nothing
        // beside it on a verdict that rests on two new observations.
        openedWith: goal.openedWith ?? null,
        closedWith: goal.closedWith ?? null,
        finding: goal.finding ?? null,
        hypothesis: goal.hypothesis ?? null,
        tried: goal.tried ?? [],
      }
    })
    const assistant = state?.assistant ?? {}
    const proposals = (assistant.recent ?? [])
      .filter((p) => p.kind !== 'run_shell' && p.kind !== 'run_shell-refused' && p.outcome !== 'open' && inWeek(p.resolvedAt ?? p.at))
      .sort((a, b) => String(b.resolvedAt ?? b.at).localeCompare(String(a.resolvedAt ?? a.at)))
      .map((p) => ({ id: p.id, summary: p.summary, kind: p.kind, outcome: p.outcome, at: p.resolvedAt ?? p.at }))
    const notices = { useful: 0, wrong: 0, notNow: 0 }
    for (const f of state?.feedback?.recent ?? []) {
      if (f.artifactKind !== 'notice' || !inWeek(f.ts)) continue
      const slot = f.verdict === 'not-now' ? 'notNow' : f.verdict
      if (slot in notices) notices[slot] += 1
    }
    // **These two counters are LIFETIME, and the card called them "this
    // week".** `assistantTrack` increments `acceptedCount` on every accept and
    // never resets it, so "18 of 23 accepted" was all-time — printed under a
    // heading that said this week, beside notice counts that really were
    // week-scoped. One heading over two different spans is worse than either
    // being wrong on its own, so they are named for what they are now.
    const accepted = assistant.acceptedCount ?? 0
    const rejected = assistant.rejectedCount ?? 0
    return {
      lab: {
        experiments,
        questions,
        // Since the beginning, and labelled so.
        proposalsEver: { accepted, rejected, resolved: accepted + rejected },
        // Genuinely this week, from `state.feedback.recent` — a 50-entry ring,
        // so this is a floor rather than a count, and the card says that.
        thisWeek: { notices, proposals, since: week.toISOString() },
      },
    }
  })

  instrument('/gnomon/calibration', 'The forecast record could not be read.', async () => {
    // Bins come from their own aggregate now, not from a slice of rows. The
    // page used to decile the most recent 500 resolved predictions while the
    // tally beside it counted all 1,649 — two figures on one card describing
    // two different populations, with nothing saying so. And they are PER
    // FORECASTER: calibration is a property of a forecaster, and three of them
    // pooled is three curves laid on top of each other.
    const [tally, resolved, bins] = await Promise.all([tallyPredictions(), listResolvedPredictions({ limit: 40 }), getCalibrationBins()])

    const state = ctx.gnomonKernel.getState()
    const mind = state?.mind ?? {}
    return {
      // Skill rides ON the tally now, and it is computed against a constant at
      // the target's own base rate rather than against a `base-rate`
      // forecaster that has bet three times in the whole record. See
      // `skillVsConstant`: the old figure showed +72% against a
      // three-observation denominator and filtered the two best forecasters
      // off the board entirely.
      // Two opponents, both named. `skill` is against the oracle constant
      // (fitted with hindsight, and the card says so); `fairSkill` is K0.3's
      // past-only baseline, which only exists for rows written after the
      // column did — hence `fairN` beside it, so the card can refuse a figure
      // with nothing behind it rather than printing a confident percentage.
      tally: tally.map((row) => ({ ...row, skill: skillVsConstant(row), fairSkill: skillVsPastBaseline(row) })),
      bins,
      recent: resolved.slice(0, 40).map((row) => ({
        kind: row.kind,
        forecaster: row.forecaster,
        priorProb: row.priorProb,
        outcome: row.outcome,
        surprise: row.surprise,
        resolvedAt: row.resolvedAt,
      })),
      // The live half: what it is currently most ignorant about (the
      // uncertainty map's own cells, heaviest expected loss first), and every
      // goal it has set itself — the closed ones included, which the Unsaid
      // page drops because it only ever shows the open one.
      // Each cell carries WHY it is or is not being studied. Without it the map
      // is a list of numbers that never becomes a goal for no visible reason —
      // which is exactly what happened between 2026-08-22 and 2026-09-10, when
      // four different thresholds were failing on five different cells and no
      // surface said so.
      gaps: [...(mind.gaps ?? [])]
        .sort((a, b) => b.expectedLoss - a.expectedLoss)
        .slice(0, 12)
        .map((gap) => ({ ...gap, ...gapEligibility(gap, mind.goals ?? [], Date.now()) })),
      goals: (mind.goals ?? []).map((goal) => {
        // How far an open goal has actually got: the reducible loss it opened
        // with, against what that cell carries now. `null` when the cell has
        // left the top-five map, which is the one case where "no progress" and
        // "not measurable" are different things and must not be shown alike.
        const cell = (mind.gaps ?? []).find((gap) => `${gap.forecaster}:${gap.cell}` === goal.id) ?? null
        const opened = goal.openedWith?.excessLoss ?? 0
        const nowExcess = cell?.excessLoss ?? null
        return {
          ...goal,
          nowExcess,
          // The bar it has to clear to close as learned, in the same unit.
          targetExcess: opened > 0 ? opened * (1 - LEARNED_LOSS_DROP) : null,
          progress: opened > 0 && nowExcess !== null ? Math.max(0, Math.min(1, (opened - nowExcess) / (opened * LEARNED_LOSS_DROP))) : null,
        }
      }),
      // The bets currently in flight, and the `hour-fragmented` forecaster's own
      // two cells. A forecaster with no visible open position is one whose
      // resolution nobody can check against what it actually claimed — and this
      // one's cells ARE its model, small enough to print in full.
      // J2.2c's retirement, kept — but the LEADERBOARD it used to carry is
      // gone, folded into `tally.skill` above. It joined each forecaster to
      // the `base-rate` forecaster on the same target, which exists only for
      // `hour-fragmented` and only three times, so it printed one nonsense
      // percentage and dropped `day-ending` and `project-touched` on the
      // floor. What survives is the one thing that join really carried:
      // whether the tournament has retired a forecaster from a target.
      retired: state?.predictions?.tournament?.retired ?? {},
      open: (state?.predictions?.open ?? []).map((bet) => ({
        kind: bet.kind,
        priorProb: typeof bet.priorProb === 'number' ? bet.priorProb : (bet.forecasters?.jev ?? bet.forecasters?.['base-rate'] ?? null),
        createdAt: bet.createdAt,
        about:
          typeof bet.about === 'string'
            ? bet.about
            : bet.kind === 'hour-fragmented'
            ? `${bet.day} ${String(bet.hour).padStart(2, '0')}:00 · ${bet.prevState}`
            : bet.kind === 'project-touched'
              ? `${bet.day} · ${bet.project}`
              : `hour ${bet.hour}`,
      })),
      // Each forecaster's cells ARE its model, small enough to print in full:
      // the two lag cells of `hour-fragmented`, and one cell per project for
      // `project-touched`.
      cells: [
        ...Object.entries(state?.predictions?.fragmentation?.byPrevState ?? {}).map(([cell, counts]) => ({
          kind: 'hour-fragmented',
          cell,
          n: counts.n,
          hits: counts.hits,
          rate: counts.n === 0 ? null : counts.hits / counts.n,
        })),
        ...Object.entries(state?.predictions?.projectTouch?.byProject ?? {})
          .sort((a, b) => b[1].n - a[1].n)
          .map(([cell, counts]) => ({
            kind: 'project-touched',
            cell,
            n: counts.n,
            hits: counts.hits,
            rate: counts.n === 0 ? null : counts.hits / counts.n,
          })),
      ],
    }
  })

  // The day — 2,784 closed moments that no surface has ever made browsable.
  // Trimmed to what a row states: when, how long, what, where, how deep, and
  // whether the intent pass ever described it (the blank ones are the same
  // shortfall the Trust page counts, seen one moment at a time).
  instrument('/gnomon/day', 'The day could not be read.', async (url) => {
    const timeZone = loadSundialConfig().timezone
    const date = spanFrom(url, () => ctx.gnomonKernel.getState?.()).date
    const moments = await getMomentsForDate(date, timeZone)
    return {
      date,
      timeZone,
      count: moments.length,
      moments: moments.map((moment) => {
        const data = moment.data ?? {}
        return {
          id: moment.id,
          startTime: moment.startTime,
          // Both ends and the raw span, because the shared moment detail builds
          // its sentence from them ("21:00–21:31 · 31 min deep focus").
          endTime: moment.endTime,
          durationMs: moment.durationMs,
          durationMin: Math.round(moment.durationMs / MINUTE),
          // Input-backed minutes beside wall minutes: presence is not work, and
          // the gap between the two is the honest part of the row.
          activeMin: typeof data.activeMs === 'number' ? Math.round(data.activeMs / MINUTE) : null,
          processName: moment.processName,
          projectId: moment.projectId,
          kind: data.kind ?? null,
          focusQuality: data.focusQuality ?? null,
          focusScore: typeof data.focusScore === 'number' ? data.focusScore : null,
          location: data.location ?? null,
          gitBranch: data.gitBranch ?? null,
          intent: data.intent && typeof data.intent.text === 'string' ? data.intent.text : null,
          title: Array.isArray(data.windowTitles) ? data.windowTitles[0] ?? null : null,
          // The substance, so a row can be opened into the shared moment
          // detail without a second request. Window titles are the one
          // unbounded field here (the analysis pass sends up to 50), and a
          // day of sixty moments carrying fifty titles each is a payload
          // nobody reads — the detail shows a handful and says so.
          data: { ...data, windowTitles: Array.isArray(data.windowTitles) ? data.windowTitles.slice(0, 12) : data.windowTitles },
        }
      }),
    }
  })

  // The trace — why did you do that.
  //
  // `applied_effects` is the effect executor's own journal: one row per effect,
  // carrying the rule that asked for it and the event that provoked it. It is
  // written for crash-safety, not for reading, which is why 29,922 rows have
  // never been shown. Rolled up by rule as well as listed, because the first
  // question is "what is this thing spending its time on" and a raw tail
  // answers only the second.
  // Habits — what Gnomon has learned about how the owner works, and the reason
  // Step 4 exists: 64 routines, a dozen open threads and weeks of day-end
  // samples were folded on every event and shown to nobody. This is the page
  // where the owner can SEE what was learned, which is the precondition for
  // correcting it. Everything here is a projection of state and the commitments
  // table; nothing is recomputed.
  // J4.3: the drafts waiting for the owner, judged. Open first, then this week's closed.
  instrument('/gnomon/drafts', 'Drafts could not be read.', async () => {
    const recent = ctx.gnomonKernel.getState()?.drafts?.recent ?? []
    return {
      open: recent.filter((d) => d.status === 'open').sort((a, b) => String(b.at).localeCompare(String(a.at))),
      closed: recent.filter((d) => d.status !== 'open' && Date.now() - Date.parse(d.closedAt ?? d.at) < 7 * 86_400_000).sort((a, b) => String(b.closedAt ?? b.at).localeCompare(String(a.closedAt ?? a.at))),
    }
  })

  instrument('/gnomon/habits', 'Habits could not be read.', async () => {
    const state = ctx.gnomonKernel.getState()
    const { trail, learned } = state.routines
    const forecast = routineForecast(trail, learned)
    const dayEnd = state.expectations.dayEnd ?? []
    const recurring = Object.values(state.expectations.recurring ?? {})
    const now = Date.now()
    const open = await getOpenCommitments(40)
    // The rituals are read over eight weeks, not over the board's span: a habit
    // is a thing that recurred, and a span of Today would empty the card every
    // morning. The card is pinned and says so, which is the case DESIGN.md
    // allows. Eight weeks also bounds the scan as the log grows.
    const timeZone = loadSundialConfig().timezone
    const since = new Date(now - RITUAL_WEEKS * 7 * 86_400_000).toISOString()
    const observed = await getMomentsSince(since)
    const practised = rituals(
      observed.map((m) => ({
        startTime: m.startTime,
        endTime: m.endTime,
        processName: m.processName,
        projectId: m.projectId,
        intent: m.data?.intent && typeof m.data.intent.text === 'string' ? m.data.intent.text : null,
      })),
      timeZone,
    )
    // What the taxonomy cannot tell apart, and how much of the record it costs.
    //
    // A routine step is `App/class`, and that second half comes from `leisureRules`
    // in config. An app with no entry there classifies as `unknown`, so every step
    // it makes records that it happened and nothing about what it was for. Measured
    // here rather than read off the learned table, because the table is capped at 64
    // rows and evicts by support: a browser the owner adopted last week cannot
    // out-support two months of the old one, so it shows up in the table once and
    // looks like a rounding error when it is in fact most of their day.
    //
    // Free, because the moments are already loaded for the rituals. The lock screen
    // is excluded by the same call `moment-close` uses — it is not an app anyone
    // chose to be in.
    const classes = new Map()
    for (const moment of observed) {
      if (isSystemProcess(moment.processName)) continue
      // EVERY title, not the first. A moment is a whole stretch and carries up to
      // fifty of them; one window with an address in it is enough for the taxonomy
      // to place the stretch. Judged on the first title alone, Chrome read 43%
      // unclassified against 4% measured on the switches themselves — a number the
      // card would have stated as a fact about the owner's browser.
      const titles = Array.isArray(moment.data?.windowTitles) ? moment.data.windowTitles : []
      const seen = classes.get(moment.processName) ?? { seen: 0, blind: 0 }
      seen.seen += 1
      if ((titles.length === 0 ? [''] : titles).every((title) => classifyActivity(moment.processName, title, state.config.leisureRules) === 'unknown')) seen.blind += 1
      classes.set(moment.processName, seen)
    }
    const unclassified = [...classes]
      .filter(([, c]) => c.blind > 0)
      .map(([app, c]) => ({ app, blind: c.blind, seen: c.seen }))
      .sort((a, b) => b.blind - a.blind)
    const lastLearnedAt = Object.values(learned).reduce((latest, r) => (r.lastSeenAt > latest ? r.lastSeenAt : latest), '')
    return {
      routines: {
        learnedCount: Object.keys(learned).length,
        // Mirror pairs merged: `A → B → C` and `C → B → A` are one oscillation
        // seen from both ends, and the card reported them as two habits.
        top: mergeMirrors(topRoutines(learned, 24)).map((r) => ({ label: routineLabel(r), steps: r.steps, support: r.support, mirrored: r.mirrored, lastSeenAt: r.lastSeenAt, firstSeenAt: r.firstSeenAt })),
        trail: trail.map((step) => step.split('/')[0]),
        forecast: forecast === null ? null : { next: forecast.expectedProcess, from: routineLabel(forecast.routine), support: forecast.routine.support },
        lastLearnedAt: lastLearnedAt === '' ? null : lastLearnedAt,
        unclassified,
      },
      rituals: { weeks: RITUAL_WEEKS, observed: observed.length, timeZone, list: practised },
      commitments: {
        open: open.map((c) => ({
          id: c.id,
          name: c.name,
          // `git-branch` or (J4.4) `speech` — a promise heard aloud, which the row can close by hand.
          source: c.source,
          branch: c.branch,
          project: c.projectName ?? null,
          touches: c.touches,
          activeDays: c.activeDays,
          lastTouchedAt: c.lastTouchedAt,
          quietDays: Math.floor((now - Date.parse(c.lastTouchedAt)) / 86_400_000),
          // Mirrors the live thread's marker, so the page says which ones Gnomon
          // already spoke about.
          fadingNoticed: state.commitments.open.find((t) => t.id === c.id)?.fadingNoticedAt ?? null,
        })),
      },
      expectations: {
        // Newest last, minutes from local midnight. The page draws these as a
        // line; the slope is bedtime drift, which no surprise detector can see.
        dayEnd: dayEnd.slice(-21),
        recurring: recurring
          .filter((r) => r.intervalMs?.n >= 3)
          .sort((a, b) => b.intervalMs.n - a.intervalMs.n)
          .slice(0, 20)
          .map((r) => ({ stream: r.stream, bucket: r.bucket, n: r.intervalMs.n, meanIntervalMin: Math.round(r.intervalMs.mean / 60_000), lastSeenAt: r.lastSeenAt })),
      },
    }
  })

  // Reach — what Gnomon can touch outside its own record, and on what terms.
  // The tool list is dsh's own registry (the same one the model sees) and the
  // read/write verdicts come from sundial-actions through `gnomonReach`, so this
  // page can never disagree with the gate about what asks and what does not.
  instrument('/gnomon/reach', 'Reach could not be read.', async () => {
    const schemas = ctx.tools.schemas()
    const presets = ctx.gnomonReach.presets?.() ?? []
    // What the GATE says will happen, asked of the gate. Not re-derived here:
    // a second copy of the preset ladder on a surface is a second policy that
    // agrees today and diverges silently, on the one card whose whole job is
    // to be trusted about what Gnomon can do to the owner's services.
    const verdicts = (name) =>
      Object.fromEntries(presets.map((preset) => [preset, ctx.gnomonReach.verdict?.(name, preset) ?? { kind: 'allow' }]))

    const byServer = new Map()
    for (const schema of schemas) {
      const match = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/.exec(schema.name)
      if (match === null) continue
      const list = byServer.get(match[1]) ?? []
      list.push({
        name: schema.name,
        tool: match[2],
        description: schema.description ?? '',
        read: ctx.gnomonReach.isRead(match[1], match[2]),
        verdicts: verdicts(schema.name),
      })
      byServer.set(match[1], list)
    }
    const integrations = ctx.gnomonReach.integrations().map((i) => {
      const tools = (byServer.get(i.name) ?? []).sort((a, b) => Number(b.read) - Number(a.read) || a.tool.localeCompare(b.tool))
      return { ...i, tools, readCount: tools.filter((t) => t.read).length, writeCount: tools.filter((t) => !t.read).length }
    })

    // Gnomon's OWN hands, and all of them — the list was two names typed out,
    // which meant a tool added to `GNOMON_TOOLS` never appeared on the card
    // that exists to enumerate what Gnomon can do.
    const own = schemas
      // The web task tools (web_page, web_act) are Gnomon's own too, though not gnomon_-named.
      .filter((t) => t.name.startsWith('gnomon_') || t.name === 'web_page' || t.name === 'web_act')
      .map((t) => ({ name: t.name, tool: t.name.replace(/^gnomon_/, ''), description: t.description ?? '', verdicts: verdicts(t.name) }))
      .sort((a, b) => a.tool.localeCompare(b.tool))

    const mcpCount = [...byServer.values()].reduce((sum, list) => sum + list.length, 0)

    // K0.1 — what has actually run. Until the gate started writing a row per
    // call this was empty by construction, and the card had to close with a
    // section saying so. Keyed by the bare tool name as the SERVER knows it,
    // which is what the rows above are keyed by too.
    const calls = await getToolCalls()
    const usage = new Map(calls.map((row) => [`${row.server ?? ''}/${row.action}`, row]))
    const used = (server, tool) => usage.get(`${server ?? ''}/${tool}`) ?? null

    return {
      integrations: integrations.map((i) => ({
        ...i,
        tools: i.tools.map((t) => ({ ...t, used: used(i.name, t.tool) })),
        // The integration's own line: when it was last reached at all, and how
        // many of its calls went wrong. Summed from its tools rather than
        // queried again, so the two can never disagree.
        used: (() => {
          const rows = i.tools.map((t) => used(i.name, t.tool)).filter(Boolean)
          if (rows.length === 0) return null
          return {
            calls: rows.reduce((n, r) => n + r.calls, 0),
            failed: rows.reduce((n, r) => n + r.failed, 0),
            refused: rows.reduce((n, r) => n + r.refused, 0),
            lastAt: rows.map((r) => r.lastAt).sort().pop(),
          }
        })(),
      })),
      own,
      totalTools: schemas.length,
      presets,
      // The disclosure the audit asked for, COUNTED rather than written down.
      // D-R4 recorded 56 tools and "+36 built-in"; the registry is 49 today, so
      // a figure typed into the copy would already be wrong twice over.
      builtIn: schemas.length - mcpCount - own.length,
      // The owner's own dial, which tightens every outward verdict below `act`
      // — the card cannot explain an `ask` without it.
      autonomy: ctx.gnomonKernel?.getState()?.settings?.autonomy ?? null,
      // When the counting began. Every row before this is silence that means
      // nothing, and the card must not read it as "never used".
      countingSince: calls.length === 0 ? null : calls.map((r) => r.lastAt).sort()[0],
      ownUsed: Object.fromEntries(own.map((t) => [t.tool, used(null, t.name)])),
    }
  })

  // Every question Gnomon has put to the owner, and whether asking was worth it.
  //
  // **`ask_threads` is deliberately gone from this payload.** The audit read
  // the card as two objects on one surface — "asks (recorded questions) and
  // chat threads are different things sharing one card" — and the split is a
  // DELETION rather than a move: `ask_threads` is not the chat feed. The chat
  // feed is the dsh sessions the threads card reads (`/gnomon/api/sessions`);
  // `ask_threads` is the retired macOS Ask surface's Q&A log, whose event
  // (`ask:answered`) last fired on 2026-08-15. Its rule is still in the
  // manifest and nothing emits to it. Moving 75 dead rows onto a live card
  // would be worse than leaving them where they are — the four the owner
  // promoted are in `knowledge_entries` and reachable by search, and the
  // other 71 are history with no reader, which is what they were.
  //
  // Three joins, all of them because a card that can only report `answered`
  // against `expired` says 47 of 48 and flatters the asker:
  //
  // 1. **The verdict the owner gave the QUESTION.** New this item: `owner_ask`
  //    is now a `feedback:verdict` artifact kind, so `useful` / `wrong` /
  //    `not-now` land exactly on "worth asking" / "wrong question" / "bad
  //    moment". Read from the LOG rather than `state.feedback.recent`, which
  //    keeps only the last 50 verdicts and would silently drop older ones out
  //    of a precision figure computed over the whole record.
  // 2. **What the answer BECAME.** A fact stores the event it came from, so
  //    the `ask:owner-answered` signal ids give the other direction: which
  //    answers were routed into memory. That is the B1 rule applied — a route
  //    the card cannot read back is a button that looks like it did nothing.
  // 3. **The answer's own event id**, handed to the client so the routing door
  //    can stamp what it writes and appear in join 2 on the next read.
  instrument('/gnomon/asks', 'The asks could not be read.', async () => {
    // Pinned to the whole record and the card says so, which is the case
    // DESIGN.md allows: asking is a habit measured over weeks, and a span of
    // Today would empty the card most mornings. Capped well above the live 48
    // so the census cannot be quietly computed over a truncated list.
    const asks = await getRecentOwnerAsks(500)
    if (asks.length === 0) return { asks: [] }
    const from = asks[asks.length - 1].askedAt
    const to = new Date(Date.now() + 60_000).toISOString()
    const [askSignals, feedbackSignals] = await Promise.all([
      getSignalsInRange(from, to, 4000, ['ask']),
      getSignalsInRange(from, to, 4000, ['feedback']),
    ])

    const answerEventId = new Map()
    for (const signal of askSignals) {
      if (signal.eventType !== 'owner-answered') continue
      const askId = typeof signal.data?.askId === 'string' ? signal.data.askId : null
      if (askId !== null) answerEventId.set(askId, signal.id)
    }
    const routed = new Map()
    for (const fact of await getFactsBySourceEventIds([...new Set(answerEventId.values())])) {
      const list = routed.get(fact.sourceEventId) ?? []
      list.push({ id: fact.id, subject: fact.canonicalName, predicate: fact.predicate, object: fact.object, provenance: fact.provenance, retracted: fact.validTo !== null })
      routed.set(fact.sourceEventId, list)
    }
    const verdicts = new Map()
    for (const signal of feedbackSignals) {
      const { artifactKind, artifactId, verdict } = signal.data ?? {}
      if (artifactKind === 'owner_ask' && typeof artifactId === 'string' && typeof verdict === 'string') verdicts.set(artifactId, { verdict, at: signal.capturedAt })
    }

    // What the verdicts DID, which is new: a `wrong` or `not-now` on an ask now
    // lowers that whole CLASS's precision (`askClass`/`askPrecision`), and B1
    // says a write the card cannot read back is a button that looks like it did
    // nothing. Read from the fold rather than recomputed here — the gate's
    // arithmetic has one home.
    // Handed over as `fires` and `at`, NOT as a gain. The stored gain is what
    // it was at the verdict and recovers from there, so printing it would be a
    // stale number; recomputing it here would be a second copy of the gate's
    // curve on a surface that has no business owning one. What `fires` says is
    // exact and needs no arithmetic: once means the class stopped interrupting,
    // twice or more means it went silent.
    const quieted = ctx.gnomonKernel.getState?.()?.ownerAsk?.classGain ?? {}

    return {
      quieted,
      asks: asks.map((a) => {
        const eventId = answerEventId.get(a.id) ?? null
        const rated = verdicts.get(a.id)
        return {
          id: a.id,
          question: a.question,
          reason: a.reason,
          askedAt: a.askedAt,
          answer: a.answer,
          answeredAt: a.answeredAt,
          outcome: a.outcome,
          // H1's three states, carried through as three: `null` is nobody has
          // read this answer yet, `[]` is read and there was nothing in it, and
          // a list is a form waiting for one press. The card says different
          // things about all three.
          proposals: a.proposals,
          answerEventId: eventId,
          routed: (eventId === null ? null : routed.get(eventId)) ?? [],
          verdict: rated?.verdict ?? null,
          verdictAt: rated?.at ?? null,
        }
      }),
    }
  })

  // The journal, whole — see `tracePanel` for what the card is for.
  //
  // Pinned to the whole journal rather than to the board's span, and the two
  // reasons are both measurements. `applied_effects` begins on 2026-09-17,
  // when the harness executor first ran, against a log that begins on
  // 2026-07-30: a board span of a month would draw twenty-five empty days.
  // And nothing prunes this table — `deleteRowsOlderThan` touches signals,
  // moments, llm_audit and orphaned embeddings and not this — so the journal's
  // span only ever grows, and the card says its own dates on its face rather
  // than implying the record's.
  //
  // The census is five grouped scans in SQLite. The previous route pulled 120
  // rows and called their COUNT a window in minutes; over 27k rows the same
  // shape would be 3MB of JSON to produce five numbers.
  instrument('/gnomon/trace', 'The trace could not be read.', async (url) => {
    const limit = Math.min(200, Math.max(20, Number(url.searchParams.get('limit')) || 40))
    const [census, recent] = await Promise.all([getEffectJournalCensus(), getRecentRuleTriggers(limit)])
    const siblings = await getEffectsForEvents([...new Set(recent.map((row) => row.eventId))])

    // K0.5 — one hop further down the chain. An `EmitEvent` row now carries the
    // id of the event it raised, so the fold can show what that event went on
    // to cause rather than stopping at "it told itself something". Only the
    // children of the rows on screen are fetched, and only one level: a full
    // tree would be a fan-out of a fan-out for a list of forty.
    const emitted = [...new Set([...recent, ...siblings].map((row) => row.emittedEventId).filter(Boolean))]
    const children = await getEffectsForEvents(emitted)

    // A door is only a door if the thing behind it exists, and on this card
    // the newest rows are the likeliest to be shut. `Judge … moment=<id>` is
    // written when the judge is ASKED, which happens before the moment is
    // closed and written — 13 of the record's 635 of them name a moment that
    // is not in `moments` yet, and they are exactly the recent ones a
    // "last 40" list shows. Clicking one opened nothing and said nothing,
    // which is the worst kind of dead link. Asked rather than assumed.
    const named = [...new Set([...recent, ...siblings].map((row) => momentIdIn(row.effectDetail)).filter(Boolean))]
    const open = new Set((await getMomentsByIds(named)).map((moment) => moment.id))

    // What set an event off: the world, or Gnomon itself. Read off the Trust
    // card's own sensor roster — the one `sensors.test.js` holds against
    // `packages/sensors/src` — rather than off a second hand-written list of
    // event types, which would agree on the day it was written and drift.
    const sensorEvents = new Set(SENSORS.flatMap((sensor) => sensor.events))
    const origin = { world: { events: 0, effects: 0 }, gnomon: { events: 0, effects: 0 } }
    const byEventType = census.byEventType.map((row) => {
      const from = sensorEvents.has(row.eventType) ? 'world' : 'gnomon'
      origin[from].events += row.events
      origin[from].effects += row.effects
      return { ...row, origin: from }
    })

    const families = new Map()
    for (const row of census.byKind) {
      const family = EFFECT_FAMILY[row.kind] ?? 'record'
      const seat = families.get(family) ?? { family, count: 0, kinds: [] }
      seat.count += row.count
      seat.kinds.push(row)
      families.set(family, seat)
    }

    return {
      span: { firstAt: census.firstAt, lastAt: census.lastAt },
      total: census.total,
      events: census.events,
      byStatus: census.byStatus,
      failed: census.failed,
      emitEdges: census.emitEdges,
      families: ['record', 'itself', 'think', 'you'].map((family) => families.get(family) ?? { family, count: 0, kinds: [] }),
      byRule: census.byRule.map((row) => ({ ...row, kinds: (row.kinds ?? '').split(',').filter(Boolean).sort() })),
      byEventType,
      origin,
      byDay: census.byDay,
      recent: openDoors(recent, open).map((row) => ({ ...row, failures: row.failures ?? 0, lastError: row.lastError ?? null, emittedEventId: row.emittedEventId ?? null })),
      // Keyed by the CHILD event's id, so a row looks its own emission up.
      children: Object.fromEntries(
        emitted.map((id) => [
          id,
          openDoors(children.filter((row) => row.eventId === id), open).map((row) => ({ ruleName: row.ruleName, effectDetail: row.effectDetail, moment: row.moment })),
        ]),
      ),
      siblings: Object.fromEntries(
        [...new Set(recent.map((row) => row.eventId))].map((id) => [
          id,
          openDoors(siblings.filter((row) => row.eventId === id), open).map((row) => ({ effectIndex: row.effectIndex, ruleName: row.ruleName, effectDetail: row.effectDetail, moment: row.moment, emittedEventId: row.emittedEventId ?? null })),
        ]),
      ),
    }
  })

  // Shape — the streams that were being thrown away.
  //
  // The other instruments are projections of things the system had already
  // decided. This one is the first that COMPUTES something new, and it is
  // deliberately still not a rule: `buildWorkShape` is pure, so it produces
  // three weeks of history on its first call and can be recomputed per
  // cross-validation fold when these measures graduate into forecast targets.
  // See `packages/kernel/src/work-shape.ts` for that argument in full.
  //
  // The arithmetic lives in the kernel package, not here. A plugin that did its
  // own bucketing would be a second definition of "a day" living next to the one
  // in `local-day.ts`, and days are exactly what this system has already been
  // bitten by getting wrong twice.
  instrument('/gnomon/shape', 'The shape of the work could not be read.', async (url) => {
    const timeZone = loadSundialConfig().timezone
    // Fourteen was hardcoded in two copies of the client's route table and
    // duplicated again in the reader; the board's span replaces both. A span of
    // one day would draw a one-bar shape, which says nothing, so this one keeps
    // a floor of a fortnight unless the caller asked for less on purpose.
    const asked = spanFrom(url, () => ctx.gnomonKernel.getState?.(), 14)
    const days = Math.min(60, Math.max(1, asked.pinned ? asked.days : Math.max(14, asked.days)))
    const until = url.searchParams.get('until') ?? asked.to
    // Whole local days, inclusive of `until`, so the window never cuts a day in
    // half — a half-day at either edge would be a phantom low-activity row.
    const to = localDayRange(until, timeZone).end
    const from = localDayRange(shiftDate(until, -(days - 1)), timeZone).start
    const range = { from, to }

    const [activityHours, switches, thrashing, interruptions, shellRuns, commits] = await Promise.all([
      getActivityHours(range),
      getContextSwitchesBetween(range),
      getThrashingBetween(range),
      getInterruptionsBetween(range),
      getShellRunsBetween(range),
      getCommitsBetween(range),
    ])

    return buildWorkShape({ from, to, timeZone, activityHours, switches, thrashing, interruptions, shellRuns, commits })
  })

  // ── Rhythm ────────────────────────────────────────────────────────────
  // What the owner's days actually LOOK like — when they start, when they
  // stop, how much of the span was watched — with the attention numbers that
  // used to be the whole of the Shape card demoted to a ribbon under it.
  instrument('/gnomon/rhythm', 'The rhythm could not be read.', async (url) => {
    const timeZone = loadSundialConfig().timezone
    const asked = spanFrom(url, () => ctx.gnomonKernel.getState?.(), 28)
    // A floor of four weeks, because a weekday is a column here and two
    // samples a column is not a rhythm — the same argument the coverage
    // calendar makes, and the same measurement behind it.
    const days = Math.min(90, Math.max(14, asked.pinned ? asked.days : Math.max(28, asked.days)))
    const until = url.searchParams.get('until') ?? asked.to
    const to = localDayRange(until, timeZone).end
    const from = localDayRange(shiftDate(until, -(days - 1)), timeZone).start
    const range = { from, to }

    const [arcs, observedHours, activityHours, switches, thrashing, interruptions, shellRuns, commits] = await Promise.all([
      // The offset for the middle of the window, so a single daylight saving
      // change inside it moves one day's boundary by an hour rather than
      // shifting every day in the range.
      getDayArcs(from, to, offsetHoursAt(new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString(), timeZone)),
      getObservedHours(),
      getActivityHours(range),
      getContextSwitchesBetween(range),
      getThrashingBetween(range),
      getInterruptionsBetween(range),
      getShellRunsBetween(range),
      getCommitsBetween(range),
    ])

    // Observed hours per local day, from the log — the same measure the Trust
    // card's calendar draws, and the reason this card never prints a flat 24.
    // `buildWorkShape` reports `observedHours: 24` on every single day, which
    // is a claim that the daemon watched every hour of every one of them; the
    // log says 13.3, 11.9, 12.2 for the same three days.
    // Per local HOUR, not per day. A day total cannot draw a hatch: Gnomon
    // often runs more hours than the owner works, so `observed / span` is
    // above 1 on an ordinary day and the underlay came out full width on every
    // row — a picture saying every day was completely watched, which is the
    // flat-24 fault in a different costume. The hatch needs to know WHICH
    // hours, so the route sends them.
    //
    // K0.6 — bucketed on the WAKING day and indexed from 04:00, so the hatch
    // and the arc above it describe the same twenty-four hours. Left on the
    // calendar day they would disagree for exactly the seven days this item
    // exists to fix: the arc would say "this evening ran to 00:33" while the
    // hatch under it drew the following morning.
    const watched = new Map()
    for (const { hour, share } of observedHours) {
      const at = new Date(`${hour}:00:00.000Z`)
      const day = wakingDate(at.toISOString(), timeZone)
      const slot = wakingMinute(at.toISOString(), timeZone) / 60
      const byHour = watched.get(day) ?? new Array(24).fill(0)
      byHour[Math.floor(slot)] = Math.min(1, byHour[Math.floor(slot)] + share)
      watched.set(day, byHour)
    }

    const shape = buildWorkShape({ from, to, timeZone, activityHours, switches, thrashing, interruptions, shellRuns, commits })
    const byDate = new Map(shape.days.map((day) => [day.date, day]))
    return {
      from,
      to,
      timeZone,
      // The owner's own words about their bedtime, asked rather than assumed.
      // The audit wanted the band drawn against "the 23:00 intent line"; the
      // record's answer is that there is no such intent, and a line drawn from
      // one evening's remark across a belief that disclaims having a target is
      // the same fault as a gate bar taken from a constant the dial has moved.
      intent: await getProfileFact('asleepBy'),
      // K0.6 — the WAKING day, so "today" names the same row the arcs do. At
      // 00:30 the owner's day is still yesterday's, and a `now` tick on the
      // calendar date would jump to an empty row at midnight.
      today: wakingDate(new Date().toISOString(), timeZone),
      nowMin: wakingMinute(new Date().toISOString(), timeZone),
      dayStartsAt: WAKING_DAY_START_HOUR,
      days: arcs.map((arc) => ({
        ...arc,
        hours: (watched.get(arc.date) ?? new Array(24).fill(0)).map((share) => Math.round(share * 100) / 100),
        observedHours: Math.round((watched.get(arc.date) ?? []).reduce((sum, share) => sum + share, 0) * 100) / 100,
        switches: byDate.get(arc.date)?.switches ?? null,
        interruptions: byDate.get(arc.date)?.interruptions ?? null,
      })),
      attention: { totals: shape.totals, switchesByHour: shape.switchesByHour, suspects: shape.suspects, days: shape.days.map((day) => ({ date: day.date, thrashingBursts: day.thrashingBursts, thrashingFlips: day.thrashingFlips, thrashingBurstsMeasured: day.thrashingBurstsMeasured })) },
    }
  })
}
