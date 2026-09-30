// The owner's writes: each validates its body, then appends one signal the fold reads (the board,
// drafts, reports, resumes, commitments, watch rules, hygiene, verdicts, transcripts, assertions).
import { post, readJson, sendJson } from './http.js'
import { ASSERTABLE_ENTITY_KINDS, VERDICTS } from '@sundial/helpers/vocab.js'
import { executeGnomonTool, toolEnv } from '@sundial/kernel/tools/index.js'
import { validateWatchRule } from '@sundial/kernel/watch.js'
import { readRules } from './read-rules.js'
import { entityId as makeEntityId } from '../shell/entity-id.js'

const ASSERT_KINDS = new Set(ASSERTABLE_ENTITY_KINDS)

/** An `entity:fact-candidate` from the owner's assertion, or what is missing. The owner under any alias, any kind, is the one owner entity (`ownerAliases[0]`). */
function assertion(body, aliases) {
  const kind = typeof body.entityKind === 'string' ? body.entityKind.trim() : ''
  const name = typeof body.canonicalName === 'string' ? body.canonicalName.trim() : ''
  const predicate = typeof body.predicate === 'string' ? body.predicate.trim() : ''
  const object = typeof body.object === 'string' ? body.object.trim().slice(0, 1000) : ''
  if (!ASSERT_KINDS.has(kind) || name === '' || predicate === '' || object === '') return 'An assertion needs entityKind (owner/person/project/tool/topic/goal), canonicalName, predicate and object.'
  const isOwner = aliases.some((alias) => alias.trim().toLowerCase() === name.toLowerCase()) && ['owner', 'person', 'topic'].includes(kind)
  const [entityKind, canonicalName] = isOwner ? ['owner', aliases[0]] : [kind, name]
  // What the owner was looking at when they said it, when the surface knows: an answer routed into memory keeps
  // a pointer to the question that produced it, so the asks card can read back what it wrote (`people-ask` does the same).
  const sourceEventId = typeof body.sourceEventId === 'string' && body.sourceEventId.trim() !== '' ? body.sourceEventId.trim() : null
  return { entityKind, canonicalName, predicate, object, confidence: 100, provenance: 'assertion', entityId: makeEntityId(entityKind, canonicalName), sourceEventId, projectId: null }
}

export function mountWrites(ctx, shell) {
  const { api, broadcast, snapshot } = shell

  /**
   * The board: read it, or append one change to it.
   *
   * A POST is one `board:*` event — the owner's drop, resize, group, note —
   * through the kernel like every other change to the space, so the owner's
   * hands and Gnomon's tool write the same log and every open browser hears
   * the same `gnomon/board`.
   */
  const BOARD_EVENTS = new Set(['place', 'move', 'remove', 'focus', 'notice', 'walk', 'step', 'continue', 'plan', 'span', 'clear', 'arrange', 'save', 'load', 'section', 'unsection'])
  api('/gnomon/api/board', async (req, res) => {
    const board = () => ctx.gnomonKernel.getState()?.board ?? null
    if (req.method !== 'POST') return sendJson(res, 200, board() ?? { cards: {}, groups: {}, scenes: {}, focus: null, updatedAt: null })
    const { action = '', ...payload } = (await readJson(req, 65_536)) ?? {}
    if (!BOARD_EVENTS.has(action)) return sendJson(res, 400, { unavailable: 'A board change needs an action.' })
    await ctx.gnomonKernel.appendSignal(`board:${action}`, { ...payload, by: 'owner' })
    ctx.emit('gnomon/board', board())
    sendJson(res, 200, board())
  })

  // The owner's verdict on something Gnomon produced — a notice, a fact, an
  // insight, a moment. `feedback:verdict` is an ordinary signal; `feedbackTrack`
  // folds it (a `wrong` on a fact RETRACTS it), so the verdict needs no model
  // in between and lands the same way whether it came from a block's act, an
  // Unsaid row, or a fact row. This route exists because the CLI that used to
  // carry it is dead and, until now, only "not now" on a notice had a live path.
  const ARTIFACT_KINDS = new Set(['knowledge_entry', 'moment', 'entity_fact', 'ask_thread', 'notice', 'owner_ask'])

  // J4.3 — the owner's tap on a draft: `sent` (they opened their mail client
  // from the card) or `dismissed`. Gnomon sends nothing; this records the tap.
  post(ctx, '/gnomon/api/draft', { limit: 2048, method: 'A draft verdict takes a POST.' }, async (body) => {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const outcome = body.outcome === 'sent' || body.outcome === 'dismissed' ? body.outcome : ''
    if (id === '' || outcome === '') return 'A draft verdict needs its id and outcome: sent or dismissed.'
    await ctx.gnomonKernel.appendSignal('draft:closed', { id, outcome, by: 'owner' })
    return { closed: id, outcome }
  })

  // J2.1 — the owner's own word on how it is going: flow / meh / stuck. One
  // `owner:self-report` through the kernel; `ownerPerceive` scores its belief
  // against it (the Brier the gate waits for). Three a day is the surface's
  // rhythm, not the route's rule.
  post(ctx, '/gnomon/api/self-report', { limit: 1024, method: 'A self-report takes a POST.' }, async ({ tap }) => {
    if (tap !== 'flow' && tap !== 'meh' && tap !== 'stuck') return 'Say tap: flow, meh or stuck.'
    await ctx.gnomonKernel.appendSignal('owner:self-report', { tap, by: 'owner' })
    broadcast({ type: 'now', now: snapshot() })
    return { recorded: tap }
  })

  // UC2 — the owner's next step, written before leaving (U2-F35): one
  // `resume:note` through the kernel, shown first on the next return. An empty
  // note clears it.
  post(ctx, '/gnomon/api/resume', { method: 'A note takes a POST.' }, async (body) => {
    // A restore link opened (U2-F36): which piece the owner used.
    const opened = typeof body.opened === 'string' && /^[a-z]{2,12}$/.test(body.opened) ? body.opened : null
    if (opened) return ctx.gnomonKernel.appendSignal('resume:opened', { piece: opened, by: 'owner' }).then(() => ({ opened }))
    if (typeof body.note !== 'string') return 'Say note: the next step, or empty to clear it; or opened: the piece.'
    const text = body.note.trim().slice(0, 200)
    await ctx.gnomonKernel.appendSignal('resume:note', { text, by: 'owner' })
    return { noted: text }
  })

  // J4.4 — the owner closing a promise heard aloud (or any open thread): one
  // `commitment:closed` through the kernel; `commitmentTrack` files the close.
  post(ctx, '/gnomon/api/commitment', { method: 'Closing a thread takes a POST.' }, async (body) => {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    // UC1 (U1-F29): a promise closes with the owner's reason, or moves to a new date.
    const reason = ['kept', 'broken', 'dropped'].includes(body.reason) ? body.reason : null
    const due = typeof body.due === 'string' && Number.isFinite(Date.parse(body.due)) ? new Date(body.due).toISOString() : null
    if (id === '' || (body.close !== true && due === null)) return 'Closing a thread needs its id and close: true (or a new due date).'
    await ctx.gnomonKernel.appendSignal('commitment:closed', { id, by: 'owner', ...(reason ? { reason } : {}), ...(due ? { due } : {}) })
    return due ? { moved: id, due } : { closed: id }
  })

  // UC4 F20 — the rules card. GET reads every adopted rule with its record;
  // POST pauses, resumes or drops one, tests a spec, or adopts an edit — which
  // is backtested again here before it is saved, whatever the card showed.
  api('/gnomon/api/rules', async (req, res) => {
    const watch = ctx.gnomonKernel.getState()?.watch
    if (req.method !== 'POST') return sendJson(res, 200, await readRules({ state: ctx.gnomonKernel.getState(), now: Date.now() }))
    const body = (await readJson(req, 16_384)) ?? {}
    const id = typeof body.id === 'string' ? body.id : ''
    const known = (watch?.rules ?? []).some((r) => r.id === id)
    if (['pause', 'resume', 'drop'].includes(body.op)) {
      if (!known) {
        sendJson(res, 404, { unavailable: 'No such rule.' })
        return
      }
      await ctx.gnomonKernel.appendSignal(body.op === 'drop' ? 'rule:dropped' : body.op === 'pause' ? 'rule:paused' : 'rule:resumed', { id, by: 'owner' })
      sendJson(res, 200, { ok: true })
      return
    }
    if (body.op !== 'test' && body.op !== 'adopt') {
      sendJson(res, 400, { unavailable: 'Say op: pause, resume, drop, test or adopt.' })
      return
    }
    // An edit keeps its rule's id, so it becomes the next version instead of a second rule.
    const spec = body.rule && typeof body.rule === 'object' ? { ...body.rule, ...(known ? { id } : {}) } : body.rule
    const tested = await executeGnomonTool('gnomon_test_rule', { rule: spec, days: 30 }, toolEnv(() => ctx.gnomonKernel.getState()))
    if (body.op === 'test' || !tested?.valid) {
      sendJson(res, 200, tested)
      return
    }
    // What was tested (a person resolved to their aliases) is what is adopted.
    const checked = validateWatchRule(tested.rule)
    if ('error' in checked) {
      sendJson(res, 200, { valid: false, error: checked.error })
      return
    }
    await ctx.gnomonKernel.appendSignal('rule:adopted', { rule: checked.rule, predicted: { fired: tested.fired, days: tested.days, heard: tested.gate.phasic + tested.gate.tonic }, via: 'card' })
    sendJson(res, 200, { adopted: checked.rule.id, fired: tested.fired, heard: tested.gate.phasic + tested.gate.tonic })
  })

  // W2 — ask for a world-hygiene pass now rather than at the next midnight.
  // The pass itself is deterministic and logs its plan; this only rings it.
  post(ctx, '/gnomon/api/hygiene', { method: 'A hygiene pass is asked for with a POST.' }, async () => {
    await ctx.gnomonKernel.appendSignal('world:hygiene-requested', { by: 'operator' })
    return { requested: true }
  })

  // J2.6 — the rejudge job: `POST { all?, limit?, bench? }` starts it, a GET
  // reads its progress. Loopback-only like every route. Nothing in the tree
  // calls it since the hand-run script went with 9a6988c; it is reached by
  // POST/GET directly.
  api('/gnomon/api/rejudge', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 200, ctx.gnomonKernel.rejudgeStatus())
    const body = (await readJson(req, 4096)) ?? {}
    const num = (v) => (Number.isInteger(v) && v > 0 ? v : undefined)
    // W3: a logged request; `judgementTrack` opens the job and the executor runs it.
    await ctx.gnomonKernel.appendSignal('rejudge:requested', { all: body.all === true, limit: num(body.limit), bench: num(body.bench), pack: num(body.pack), sinceDays: num(body.sinceDays) })
    sendJson(res, 200, ctx.gnomonKernel.rejudgeStatus())
  })

  post(ctx, '/gnomon/api/feedback', { limit: 8192, method: 'A verdict takes a POST.' }, async (body) => {
    const [artifactKind, artifactId, verdict] = [typeof body.artifactKind === 'string' ? body.artifactKind : '', typeof body.artifactId === 'string' ? body.artifactId.trim() : '', body.verdict]
    const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 500) : undefined
    // Not a verdict: a notice line was on screen, in view, in a visible tab (`notice:seen`; the client sends each key once per page).
    if (body.seen === true && artifactKind === 'notice' && artifactId !== '') return ctx.gnomonKernel.appendSignal('notice:seen', { noticeKey: artifactId.slice(0, 300), surface: typeof body.surface === 'string' ? body.surface.slice(0, 40) : 'page' }).then(() => ({ seen: true }))
    if (!ARTIFACT_KINDS.has(artifactKind) || artifactId === '' || !VERDICTS.includes(verdict)) return 'A verdict needs artifactKind, artifactId and one of useful / wrong / not-now.'
    await ctx.gnomonKernel.appendSignal('feedback:verdict', { artifactKind, artifactId, verdict, ...(note ? { note } : {}) })
    return { recorded: true, artifactKind, artifactId, verdict }
  })

  // The owner's word, as a fact — the same door `gnomon_assert` opens from the
  // chat, for a caller with no model in between (a form, a migration, a
  // script). Enters as an `entity:fact-candidate` with `provenance:
  // 'assertion'`; the fold's shape gate (`rejectEntityName`) still decides, so
  // a 200 here means "offered", not "believed". Loopback-only like every route.
  /**
   * The owner accepting the cleaned-up copy of a speech capture.
   *
   * One signal, one meaning. Not a `feedback:verdict` on the moment: a verdict
   * there says the MOMENT was useful, and two meanings on one row is a record
   * nobody can read back in a month. Nothing is deleted — the raw capture stays
   * where it is, and this only changes which copy the page shows first.
   */
  post(ctx, '/gnomon/api/transcript-accept', { method: 'Accepting a transcript takes a POST.' }, async (body) => {
    const momentId = typeof body.momentId === 'string' ? body.momentId.trim() : ''
    if (momentId === '') return 'Which moment?'
    await ctx.gnomonKernel.appendSignal('moment:transcript-accepted', { momentId, by: 'owner' })
    return { accepted: true }
  })

  post(ctx, '/gnomon/api/assert', { limit: 8192, method: 'An assertion takes a POST.' }, async (body) => {
    const fact = assertion(body, ctx.gnomonKernel.getState()?.config.ownerAliases ?? [])
    if (typeof fact === 'string') return fact
    await ctx.gnomonKernel.appendSignal('entity:fact-candidate', fact)
    return { offered: true, entityId: fact.entityId, triple: `${fact.canonicalName} ${fact.predicate} ${fact.object}` }
  })
}
