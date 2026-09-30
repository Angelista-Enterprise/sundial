// Today and the board's day cards: the open question and its answer, the conversation's weight,
// the day, the dial, the situation, the shelf, the lenses, the Unsaid, the drafts, the shape and the rhythm.
import { post, spanFrom, view } from './http.js'
import { readUnsaid } from './read-unsaid.js'
import { readSituation } from '@sundial/kernel/read/situation.js'
import { readShelf } from '@sundial/kernel/read/shelf.js'
import { readContext } from './read-context.js'
import { readOpenAsk } from './read-open-ask.js'
import { readToday } from './read-today.js'
import { readDial } from './read-dial.js'
import { readDay } from './read-day.js'
import { readShape } from './read-shape.js'
import { readRhythm } from './read-rhythm.js'

export function mountToday(ctx) {
  const instrument = (path, unavailable, read) => view(ctx, path, unavailable, read)

  // ── The other direction ─────────────────────────────────────────────────
  // Gnomon asking the OWNER something (packages/rules/src/owner-ask.ts). The
  // rule has been able to ask for a while; until now the only mouth it had was
  // prose in the companion conversation, which meant the question was only
  // visible to an owner who happened to be reading that session.
  //
  // The seat above the composer is on every view, so the question finds them
  // wherever they are — and, when it has a closed set of answers, is answered
  // with one tap.

  view(ctx, '/gnomon/ask/open', 'The open question could not be read.', () => readOpenAsk({ state: ctx.gnomonKernel.getState() }))

  // The SAME signal `gnomon_owner_answer` appends, on purpose: a tap and a typed reply are the same
  // fact. The rule ignores an askId that is not the open one, so a stale tab tapping is inert.
  post(ctx, '/gnomon/ask/answer', { limit: 8192, method: 'Answering takes a POST.', tooLong: 'That answer is too long for a tap — say it in the chat.' }, async (body) => {
    const askId = typeof body.askId === 'string' ? body.askId.trim() : ''
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    if (askId === '' || answer === '') return 'An answer needs both an askId and an answer.'
    await ctx.gnomonKernel.appendSignal('ask:owner-answered', { askId, answer })
    return { recorded: true, askId }
  })

  // ── How heavy the conversation has become ────────────────────────────────
  // Read from Gnomon's OWN ledger rather than dsh's token-meter projection:
  // that projection is served to dsh's SPA, which never boots here, and every
  // chat call is already written to `llm_audit`. The most recent `ask` call is
  // the current turn on a single-owner machine, which is the only case there is.
  //
  // Reported against the window the route DECLARES (`CONTEXT_WINDOW`) and the threshold
  // compaction acts on (80% of it). Both numbers matter to the reader: 44 calls
  // on this record sailed past the threshold and the largest reached 165,108 —
  // 37k beyond the window — and still returned success, so nothing anywhere
  // said the context had been overrun.

  view(ctx, '/gnomon/context', 'The context size could not be read.', () => readContext())

  // Everything the Today page states, in one round trip. It is a projection of
  // `buildDailyContext` — the same day the journal and the assistant read —
  // trimmed to what the page actually shows rather than shipped whole: the
  // full context carries a timeline of every moment, and the page draws none
  // of it.
  view(ctx, '/gnomon/today', 'Today could not be read.', (url) => readToday({ state: ctx.gnomonKernel.getState(), url }))

  view(ctx, '/gnomon/dial', 'The dial could not be composed.', (url) => readDial({ state: ctx.gnomonKernel.getState(), now: Date.now(), url }))

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
  // S1 — the situation: what is true right now, in one object (`read/situation.ts`).
  instrument('/gnomon/situation', 'The situation could not be read.', async () => {
    const state = ctx.gnomonKernel.getState()
    return state ? readSituation({ state, now: Date.now() }) : { unavailable: 'The kernel has not booted.' }
  })

  // The shelf: what Gnomon made on its own (the `workbench` rule's jobs, or
  // something the owner asked to keep), as `knowledge_entries` of kind `shelf`,
  // newest first, plus the job in progress. A verdict on an item goes through
  // `/gnomon/api/feedback` like any knowledge entry — `wrong` retracts it.
  view(ctx, '/gnomon/shelf', 'The shelf could not be read.', async () => {
    const state = ctx.gnomonKernel.getState()
    const bench = state?.workbench ?? { open: null, recent: [], countToday: 0 }
    return {
      items: await readShelf({ now: Date.now() }),
      working: bench.open ? { kind: bench.open.kind, subject: bench.open.subject, reason: bench.open.reason, since: bench.open.openedAt } : null,
      recent: (bench.recent ?? []).slice(-8).reverse().map((job) => ({ kind: job.kind, subject: job.subject, outcome: job.outcome, closedAt: job.closedAt })),
      countToday: bench.countToday ?? 0,
    }
  })

  // The shelf of lenses. A lens card is disposable — remove, clear or load a
  // scene all take it — but the QUESTION it encodes is not, so `board.lenses`
  // keeps every spec and this lists them. `up` says which are on the board now,
  // which is the difference between "go look" and "put it back".
  view(ctx, '/gnomon/lenses', 'The lenses could not be read.', async () => {
    const board = ctx.gnomonKernel.getState?.()?.board
    const up = new Set(Object.keys(board?.cards ?? {}))
    const lenses = Object.entries(board?.lenses ?? {})
      .map(([id, lens]) => ({ id, title: lens.title, spec: lens.spec, at: lens.at, up: up.has(id) }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    return { lenses }
  })

  view(ctx, '/gnomon/unsaid', 'The gate log could not be read.', (url) => readUnsaid({ state: ctx.gnomonKernel.getState(), now: Date.now(), date: spanFrom(url, () => ctx.gnomonKernel.getState?.()).date }))

  // The day — 2,784 closed moments that no surface has ever made browsable.
  // Trimmed to what a row states: when, how long, what, where, how deep, and
  // whether the intent pass ever described it (the blank ones are the same
  // shortfall the Trust page counts, seen one moment at a time).
  view(ctx, '/gnomon/day', 'The day could not be read.', (url) => readDay({ state: ctx.gnomonKernel.getState(), url }))

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
  view(ctx, '/gnomon/shape', 'The shape of the work could not be read.', (url) => readShape({ state: ctx.gnomonKernel.getState(), url }))

  // ── Rhythm ────────────────────────────────────────────────────────────
  // What the owner's days actually LOOK like — when they start, when they
  // stop, how much of the span was watched — with the attention numbers that
  // used to be the whole of the Shape card demoted to a ribbon under it.
  view(ctx, '/gnomon/rhythm', 'The rhythm could not be read.', (url) => readRhythm({ state: ctx.gnomonKernel.getState(), now: Date.now(), url }))
}
