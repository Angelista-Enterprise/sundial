// The owner's writes: each validates its body, then appends one signal the fold reads (the board,
// drafts, reports, resumes, commitments, watch rules, hygiene, verdicts, transcripts, assertions).
import { post, readJson, sendJson } from './http.js'
import { mountBench } from './api-bench.js'
import { ASSERTABLE_ENTITY_KINDS, VERDICTS } from '@sundial/helpers/vocab.js'
import { answerPayload } from '@sundial/helpers/loops.js'
import { inletPayload, readInlets } from '@sundial/helpers/inlets.js'
import { readOpenRow } from './read-commitment.js'
import { executeGnomonTool, toolEnv } from '@sundial/kernel/tools/index.js'
import { predictedFrom, validateWatchRule } from '@sundial/kernel/watch.js'
import { flowFrom, watchRoomFor } from '@sundial/kernel/watch-flow.js'
import { readRules } from './read-rules.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { reachRefusal } from '../../sundial-actions/gate.js'
import { entityId as makeEntityId } from '../shell/entity-id.js'
import { consumeMcpWrites } from './mcp-writes.js'
import { followupLine } from '../../sundial-proactive/notice-message.js'
import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js'
import { join } from 'node:path'

const ASSERT_KINDS = new Set(ASSERTABLE_ENTITY_KINDS)
const ARTIFACT_KINDS = new Set(['knowledge_entry', 'moment', 'entity_fact', 'ask_thread', 'notice', 'owner_ask', 'routine'])

/**
 * The owner's verdict on something Gnomon produced — a notice, a fact, an insight, a moment —
 * or a notice line seen. `feedbackTrack` folds a verdict (a `wrong` on a fact RETRACTS it), so
 * it needs no model in between. Behind `/gnomon/api/feedback` and the MCP server's `gnomon_feedback`
 * and `gnomon_notice_seen`. A string back is the reason it was refused.
 */
/** Plan 15 step 5: which surface a correction came from; the belief page counts its own. */
const via = (body) => (body.via === 'belief-page' ? { via: 'belief-page' } : {})

export async function feedbackWrite(ctx, body) {
  const [artifactKind, artifactId, verdict] = [typeof body.artifactKind === 'string' ? body.artifactKind : '', typeof body.artifactId === 'string' ? body.artifactId.trim() : '', body.verdict]
  const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 500) : undefined
  // Not a verdict: a notice line was on screen, in view, in a visible tab (`notice:seen`; the client sends each key once per page).
  if (body.seen === true && artifactKind === 'notice' && artifactId !== '') return ctx.gnomonKernel.appendSignal('notice:seen', { noticeKey: artifactId.slice(0, 300), surface: typeof body.surface === 'string' ? body.surface.slice(0, 40) : 'page' }).then(() => ({ seen: true }))
  if (!ARTIFACT_KINDS.has(artifactKind) || artifactId === '' || !VERDICTS.includes(verdict)) return 'A verdict needs artifactKind, artifactId and one of useful / wrong / not-now.'
  // The chat it was given in, when one sent it: a skill kept in the rig's chat is the rig's (self-review.ts).
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim().slice(0, 200) : undefined
  await ctx.gnomonKernel.appendSignal('feedback:verdict', { artifactKind, artifactId, verdict, ...(note ? { note } : {}), ...(sessionId ? { sessionId } : {}), ...via(body) })
  return { recorded: true, artifactKind, artifactId, verdict }
}

/**
 * The owner's word, as a fact — the same door `gnomon_assert` opens from the chat, for a caller
 * with no model in between (a form, a migration, a script, the MCP server). Enters as an
 * `entity:fact-candidate` with `provenance: 'assertion'`; the fold's shape gate
 * (`rejectEntityName`) still decides, so success means "offered", not "believed".
 */
/**
 * The owner's answer to Gnomon's open question: the SAME signal the chat's `gnomon_owner_answer`
 * and the seat's tap append. The rule ignores an askId that is not the open one, so a stale
 * answer from any surface is inert. Shared by `/gnomon/ask/answer` and the MCP `answer` write.
 */
export async function answerWrite(ctx, body) {
  const askId = typeof body.askId === 'string' ? body.askId.trim() : ''
  const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
  if (askId === '' || answer === '') return 'An answer needs both an askId and an answer.'
  // A watch rule's question also names its rule (`answerPayload`), so another rule can branch on the answer.
  await ctx.gnomonKernel.appendSignal('ask:owner-answered', answerPayload(askId, answer))
  return { recorded: true, askId }
}

/**
 * The owner host's rule writes (the MCP server's `gnomon_adopt_rule` and `gnomon_drop_rule`, for
 * a session opened with the owner token). That server backtested the spec over 30 days and
 * checked it before queueing; this checks it again against the live state, the way
 * `gnomon_adopt_rule` in watch-tools.js does, and appends the same event with `via: 'mcp-owner'`.
 */
export async function adoptWrite(ctx, body) {
  const checked = validateWatchRule(body.rule)
  if ('error' in checked) return checked.error
  const unreachable = reachRefusal(checked.rule, loadSundialConfig().integrations ?? [])
  if (unreachable !== null) return unreachable
  const flow = body.flow === undefined ? undefined : flowFrom(body.flow)
  if (flow && 'error' in flow) return flow.error
  const full = watchRoomFor(ctx.gnomonKernel.getState()?.watch, checked.rule.id, flow)
  if (full !== null) return full
  const predicted = predictedFrom(body.predicted)
  await ctx.gnomonKernel.appendSignal('rule:adopted', { rule: checked.rule, ...(predicted ? { predicted } : {}), via: 'mcp-owner', ...(flow ? { flow } : {}) })
  return { adopted: checked.rule.id }
}

/** The rule ids a write names: `{id}`, or every rule adopted in `{flow}`. */
export function rulesNamed(watch, body) {
  const rules = watch?.rules ?? []
  if (typeof body.flow === 'string' && body.flow !== '') return rules.filter((r) => watch?.stats?.[r.id]?.flow?.id === body.flow).map((r) => r.id)
  return rules.some((r) => r.id === body.id) ? [body.id] : []
}

/** Drop (pause, resume) one rule or a whole flow: one `rule:*` event per rule, as the rules card writes them. */
export async function ruleOpWrite(ctx, op, body) {
  const ids = rulesNamed(ctx.gnomonKernel.getState()?.watch, body)
  if (ids.length === 0) return 'No such rule or flow.'
  for (const id of ids) await ctx.gnomonKernel.appendSignal(`rule:${op}`, { id, by: 'owner', via: 'mcp-owner' })
  return { [op]: ids }
}

/** Take back a rule's leave to run its reach alone: one `rule:auto-revoked`, for a rule that has that reach let run alone. */
export async function revokeWrite(ctx, body) {
  const id = typeof body.id === 'string' ? body.id : ''
  const tool = typeof body.tool === 'string' ? body.tool : ''
  if (ctx.gnomonKernel.getState()?.watch?.stats?.[id]?.reach?.[tool]?.auto !== true) return 'That rule does not run that reach alone.'
  await ctx.gnomonKernel.appendSignal('rule:auto-revoked', { id, tool, by: 'owner', via: 'mcp-owner' })
  return { revoked: { id, tool } }
}

/**
 * An inlet's event (`gnomon_ingest`, `sundial ingest`): checked against inlets.json again here,
 * at the moment it is applied, then appended like a sensor's row — `appendSignal` sanitizes it.
 */
export async function ingestWrite(ctx, body, inlets = readInlets()) {
  const type = typeof body.type === 'string' ? body.type.trim() : ''
  const checked = inletPayload(type, body.payload, inlets)
  if ('error' in checked) return checked.error
  await ctx.gnomonKernel.appendSignal(type, checked.payload)
  return { ingested: type }
}

/** The owner's verdict on one fire of a rule (`gnomon_rule_verdict`): one `rule:verdict`, for a rule that is adopted. */
export async function ruleVerdictWrite(ctx, body) {
  const id = typeof body.id === 'string' ? body.id : ''
  const fireId = typeof body.fireId === 'string' ? body.fireId.trim().slice(0, 120) : ''
  if (!(ctx.gnomonKernel.getState()?.watch?.rules ?? []).some((r) => r.id === id) || fireId === '' || typeof body.useful !== 'boolean') return 'A verdict needs an adopted rule id, a fireId and useful: true or false.'
  await ctx.gnomonKernel.appendSignal('rule:verdict', { id, fireId, useful: body.useful, by: 'owner' })
  return { recorded: true, id, fireId }
}

export async function assertWrite(ctx, body) {
  const fact = assertion(body, ctx.gnomonKernel.getState()?.config.ownerAliases ?? [])
  if (typeof fact === 'string') return fact
  await ctx.gnomonKernel.appendSignal('entity:fact-candidate', fact)
  return { offered: true, entityId: fact.entityId, triple: `${fact.canonicalName} ${fact.predicate} ${fact.object}` }
}

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
  return { entityKind, canonicalName, predicate, object, confidence: 100, provenance: 'assertion', entityId: makeEntityId(entityKind, canonicalName), sourceEventId, projectId: null, ...via(body) }
}

/** Round 4: a tool's answer as one line for the conversation: a brief's lines, the rows' commands, else its JSON, cut. */
export function offerGist(value) {
  const rows = Array.isArray(value?.signals) ? value.signals.map((r) => [r.data?.command ?? r.type, typeof r.data?.exitCode === 'number' ? `(exit ${r.data.exitCode})` : null].filter(Boolean).join(' ')) : null
  const text = Array.isArray(value?.lines) ? value.lines.join(' ') : rows ? rows.join('; ') : (value?.none ?? value?.unavailable ?? JSON.stringify(value ?? null))
  return String(text || 'Nothing on the record.').slice(0, 600)
}

/**
 * Round 4: the owner pressed a notice's one button. The call is the one the gate kept for that
 * notice (`notices.offers`), never one the page names. It runs through dsh's tool pipeline as a call
 * of the conversation, so the action gate decides it like any other: a read runs, a plain act asks
 * as usual, a final still asks, a private app is refused. `notice:offer-taken` is the go (an offer
 * seen and never taken was ignored); what the call found lands in the conversation as Gnomon's line.
 */
const OFFER_VIA = new Set(['slip', 'knock'])

/** Set 2 R3: the knock's spoken go on a notice with an offer (`voiceKnock` Notify `offer-take`) presses it here, the same way. */
export const offerOnGo = (ctx, agentFor) => (notice) => (notice?.channel === 'offer-take' ? offerPress(ctx, agentFor, { noticeKey: notice.payload?.noticeKey, via: 'knock' }).catch(() => null) : null)

export async function offerPress(ctx, agentFor, body) {
  const noticeKey = typeof body.noticeKey === 'string' ? body.noticeKey : ''
  const offers = ctx.gnomonKernel.getState()?.notices?.offers ?? {}
  // Own keys only: `constructor` or `__proto__` is on every plain object and is no offer.
  const offer = Object.hasOwn(offers, noticeKey) ? offers[noticeKey] : null
  if (!offer) return [404, { unavailable: 'That offer is gone: taken already, or too old.' }]
  // Set 2 R3: which surface took it (the strip says nothing), so the slip's and the knock's go rates read apart.
  await ctx.gnomonKernel.appendSignal('notice:offer-taken', { noticeKey, kind: offer.kind, tool: offer.tool, ...(OFFER_VIA.has(body.via) ? { via: body.via } : {}) })
  const agent = await agentFor(COMPANION_SESSION_ID)
  const result = await ctx.tools.execute({ callId: `offer-${Date.now()}`, name: offer.tool, arguments: offer.args, agent, signal: new AbortController().signal })
  if (result?.isError) return { ran: false, reason: String(result.error?.message ?? 'The call did not run.').slice(0, 300) }
  const gist = offerGist(result?.value)
  const message = followupLine({ observation: `${offer.label}: ${gist}` })
  // As delivery draws a line: straight onto an idle conversation's log, else at the running turn's next step.
  if (agent.status === 'idle' && typeof agent.session?.append === 'function') agent.session.append('user/message', message, { surfaceOp: 'append' })
  else agent.inject(message)
  // The surface that pressed shows what came back in place of the button: the same words, cut at a word to 160. A tool answer
  // with no lines of its own is raw JSON: the conversation holds it, the button's place says only where it went.
  if (/^[{[]/.test(gist)) return { ran: true }
  return { ran: true, said: gist.length > 160 ? `${gist.slice(0, 159).replace(/\s+\S*$/, '')}…` : gist }
}

export function mountWrites(ctx, shell) {
  const { api, broadcast, snapshot } = shell
  // A benchmark's events into the bench record: refused (403) off the bench install (api-bench.js, bench-guard.js).
  mountBench(ctx)

  /**
   * The board: read it, or append one change to it.
   *
   * A POST is one `board:*` event — the owner's drop, resize, group, note —
   * through the kernel like every other change to the space, so the owner's
   * hands and Gnomon's tool write the same log and every open browser hears
   * the same `gnomon/board`.
   */
  const BOARD_EVENTS = new Set(['place', 'move', 'remove', 'focus', 'notice', 'walk', 'step', 'continue', 'plan', 'span', 'clear', 'arrange', 'save', 'load', 'section'])
  api('/gnomon/api/board', async (req, res) => {
    const board = () => ctx.gnomonKernel.getState()?.board ?? null
    if (req.method !== 'POST') return sendJson(res, 200, board() ?? { cards: {}, groups: {}, scenes: {}, focus: null, updatedAt: null })
    const { action = '', ...payload } = (await readJson(req, 65_536)) ?? {}
    if (!BOARD_EVENTS.has(action)) return sendJson(res, 400, { unavailable: 'A board change needs an action.' })
    await ctx.gnomonKernel.appendSignal(`board:${action}`, { ...payload, by: 'owner' })
    ctx.emit('gnomon/board', board())
    sendJson(res, 200, board())
  })

  post(ctx, '/gnomon/api/offer', { limit: 1024, method: 'An offer is taken with a POST.' }, (body) => offerPress(ctx, shell.agentFor, body))
  ctx.effect(() => ctx.on('gnomon/notice', offerOnGo(ctx, shell.agentFor)))

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
    // A thread open in the table but no longer in state rides along as `row`, so the fold can close
    // it; nothing open under the id anywhere is refused rather than answered `closed`.
    const { open = [], promises = [] } = ctx.gnomonKernel.getState()?.commitments ?? {}
    const inState = [...open, ...promises].some((c) => c.id === id)
    const stored = inState ? null : await readOpenRow(id)
    if (!inState && !stored) return 'Nothing is open under that id.'
    await ctx.gnomonKernel.appendSignal('commitment:closed', { id, by: 'owner', ...(reason ? { reason } : {}), ...(due ? { due } : {}), ...(stored ? { row: stored } : {}) })
    return due ? { moved: id, due } : { closed: id }
  })

  // Round 3: the owner drops a route Gnomon learned on screen (the Routes card): one `screen:route-dropped`, which
  // `stepsOf` reads with the app's steps, so `routesOf` never offers it again (the brief, screen_act, the replay).
  post(ctx, '/gnomon/api/route-drop', { limit: 1024, method: 'Dropping a route takes a POST.' }, async (body) => {
    const app = typeof body.app === 'string' ? body.app.trim().slice(0, 100) : ''
    const routeKey = typeof body.routeKey === 'string' ? body.routeKey.trim().slice(0, 300) : ''
    if (app === '' || app.startsWith('[') || routeKey === '') return 'Dropping a route needs its app and routeKey.'
    await ctx.gnomonKernel.appendSignal('screen:route-dropped', { app, routeKey, by: 'owner' })
    return { dropped: routeKey, app }
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
    const refused = 'error' in checked ? checked.error : reachRefusal(checked.rule, loadSundialConfig().integrations ?? [])
    if (refused !== null) {
      sendJson(res, 200, { valid: false, error: refused })
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

  post(ctx, '/gnomon/api/feedback', { limit: 8192, method: 'A verdict takes a POST.' }, (body) => feedbackWrite(ctx, body))

  // Plan 15 step 2: the page's half of the summon. The app writes the summon, the dismiss and the step back.
  post(ctx, '/gnomon/api/overlay', { limit: 1024, method: 'A summon event takes a POST.' }, async (body) => {
    const summonId = typeof body.summonId === 'string' ? body.summonId.slice(0, 64) : ''
    // Plan 15 step 6: the owner's word on one mark: on the right thing or not.
    if (body.type === 'mark-judged' && typeof body.id === 'string') return ctx.gnomonKernel.appendSignal('screen:mark-judged', { id: body.id.slice(0, 80), right: body.right === true }).then(() => ({ recorded: true }))
    // The ring on the control a screen_act waits on, drawn before the owner's yes and cleared when it settles.
    if ((body.type === 'ask-mark' || body.type === 'ask-clear') && typeof body.id === 'string') {
      const id = `ask:${body.id.slice(0, 76)}`
      return ctx.gnomonKernel.appendSignal('screen:mark', body.type === 'ask-mark' ? { id, target: body.target, shape: 'ring' } : { clear: true, id }).then(() => ({ recorded: true }))
    }
    // Set 4 R2: "what did you do today" is answered by the slip itself (the Ledger's line, no turn); what it said is on the record.
    if (body.type === 'day-said') {
      const line = typeof body.line === 'string' ? body.line.trim().slice(0, 240) : ''
      if (!line) return 'A day line said needs the line.'
      return ctx.gnomonKernel.appendSignal('overlay:day-said', { summonId, line }).then(() => ({ recorded: true }))
    }
    const move = body.type === 'first-move' && ['type', 'look', 'talk'].includes(body.kind)
    if (!move && body.type !== 'place-added') return 'A summon event is a first move (type, look or talk) or a place added.'
    await (move ? ctx.gnomonKernel.appendSignal('overlay:first-move', { summonId, kind: body.kind }) : ctx.gnomonKernel.appendSignal('overlay:place-added', { summonId }))
    return { recorded: true }
  })

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

  post(ctx, '/gnomon/api/assert', { limit: 8192, method: 'An assertion takes a POST.' }, (body) => assertWrite(ctx, body))

  // The same two writes from the MCP server, a separate process that cannot append to the log:
  // it drops one request file per call, and this applies it with the handlers above.
  ctx.effect(() => consumeMcpWrites(join(shell.home, '.daemon', 'mcp-writes'), { feedback: (body) => feedbackWrite(ctx, body), assert: (body) => assertWrite(ctx, body), answer: (body) => answerWrite(ctx, body), adopt: (body) => adoptWrite(ctx, body), drop: (body) => ruleOpWrite(ctx, 'dropped', body), pause: (body) => ruleOpWrite(ctx, 'paused', body), resume: (body) => ruleOpWrite(ctx, 'resumed', body), revoke: (body) => revokeWrite(ctx, body), ingest: (body) => ingestWrite(ctx, body), verdict: (body) => ruleVerdictWrite(ctx, body) }), 'sundial-shell mcp writes')
}
