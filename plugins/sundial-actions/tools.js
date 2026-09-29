// Gnomon's internal action tools.
//
// Each is thin on purpose: it validates, then appends ONE event that an
// existing rule already folds. Nothing here invents a write path — `claim`
// rides `assistant:claim` (→ entityExtract, a fact CANDIDATE that earns
// promotion the ordinary way, never a privileged write), `propose`/`outcome`
// ride `assistant:proposal`/`assistant:response` (→ assistantTrack). That is
// the almanac's law made literal: the assistant emits events, folded by
// ordinary rules, and the owner's verdict is the only thing that moves belief.
import { defineTool } from '@deepseek-ai/dsh-tools'
// The ONE re-ask predicate, shared with the `ownerAsk` reducer: a copy here is
// how the tool came to refuse questions the reducer accepts, and the symptom is
// the duplicate ask this guard exists to stop.
import { recentlyAnswered } from '@sundial/helpers/asked.js'
import { nextOccurrence, parseRepeat, repeatKey } from '@sundial/helpers/repeat-schedule.js'

const ENTITY_KINDS = ['person', 'project', 'tool', 'topic', 'task']

/** How long a WAITING ask holds its turn. A person who has not answered in ten minutes has walked away; the ask stays open on the record without the turn. */
const ASK_WAIT_MS = 10 * 60 * 1000
const ASK_POLL_MS = 1000

/**
 * Must stay identical to `slugify` in `packages/rules/src/wakeup-track.ts`.
 *
 * Duplicated rather than imported because a plugin cannot import a rule's
 * private helper, and the alternative — letting the rule derive the key — means
 * the tool tells the model a key the rule never stored, so the cancel that names
 * it silently does nothing.
 */
function slugifyWakeupKey(reason) {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * The internal tools, given an `appendSignal`. Returned so `index.js` registers
 * only the ones config permits.
 *
 * `getState` is read only to refuse up front what a rule would drop silently —
 * a second open question, a sixth queued job, an unreadable schedule — so the
 * model gets a refusal it can act on.
 */
export function internalTools(appendSignal, getState, { askWaitMs = ASK_WAIT_MS, askPollMs = ASK_POLL_MS } = {}) {
  /**
   * Hold the turn until the open ask `askId` closes, or `askWaitMs` passes.
   *
   * A poll, not a subscription: the kernel exposes state and `appendSignal`
   * and nothing else, and a blocked turn is already the expensive thing here —
   * one read a second under it costs nothing anyone can measure.
   * ponytail: poll; a kernel change event if a second waiter ever appears.
   */
  async function waitForAnswer(askId, signal) {
    const deadline = Date.now() + askWaitMs
    while (Date.now() < deadline) {
      // The owner pressing Stop must end the wait too. Without this the turn
      // was cancelled and this loop kept polling for its full ten minutes,
      // holding a tool call open on a turn that no longer existed.
      if (signal?.aborted === true) return { answered: false, reason: 'the owner stopped the turn before answering' }
      await new Promise((resolve) => setTimeout(resolve, askPollMs))
      const ask = getState?.().ownerAsk
      if (ask?.open?.askId === askId) continue
      const answer = (ask?.recent ?? []).find((entry) => entry.askId === askId)?.answer
      return answer === undefined ? { answered: false, reason: 'the question closed without an answer (expired, or superseded)' } : { answered: true, answer }
    }
    return { answered: false, reason: `no answer after ${Math.round(askWaitMs / 60000)} min; the question stays open on the record and the owner can still answer it later — carry on without it` }
  }

  return [
    defineTool({
      name: 'gnomon_claim',
      description:
        'Record a belief about the owner\'s world as a fact CANDIDATE — e.g. that a project uses a tool, or two people work together. It is not asserted as true: it enters memory the same way a sensor observation does and must be corroborated before it is believed. Use it when you learn something durable from the conversation; do not use it to state the owner\'s own assertions (those are theirs to make).',
      parameters: {
        entityKind: { type: 'string', required: true, description: `One of: ${ENTITY_KINDS.join(', ')}.` },
        canonicalName: { type: 'string', required: true, description: 'The entity this is about, by its canonical name.' },
        predicate: { type: 'string', required: true, description: 'The relation, e.g. "uses", "works-on", "collaborates-with".' },
        object: { type: 'string', required: true, description: 'The other side of the relation.' },
        confidence: { type: 'number', description: 'Optional 0–1 confidence in the claim.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { recorded: { type: 'boolean' }, provenance: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: value.recorded ? 'Recorded as a fact candidate (provenance: assistant).' : 'Not recorded.' }],
      },
      async execute(args) {
        const entityKind = String(args.entityKind).trim()
        if (!ENTITY_KINDS.includes(entityKind)) throw new Error(`entityKind must be one of ${ENTITY_KINDS.join(', ')}`)
        const canonicalName = String(args.canonicalName).trim()
        const predicate = String(args.predicate).trim()
        const object = String(args.object).trim()
        if (!canonicalName || !predicate || !object) throw new Error('canonicalName, predicate and object are all required')
        await appendSignal('assistant:claim', {
          entityKind,
          canonicalName,
          predicate,
          object,
          ...(typeof args.confidence === 'number' ? { confidence: args.confidence } : {}),
        })
        return { recorded: true, provenance: 'assistant' }
      },
    }),

    defineTool({
      name: 'gnomon_draft',
      description:
        'Draft an email or a note FOR THE OWNER TO SEND, from evidence you name — a reply someone is waiting for, a follow-up after a meeting, a note for the record. The draft appears on the owner\'s Today as a card with the evidence beside it and a Send tap that opens THEIR mail client; nothing is sent by you or by Gnomon. A judge reads the draft against the evidence first and the card shows how grounded it found it, so write only what the evidence holds.',
      parameters: {
        kind: { type: 'string', required: true, description: '"email" or "note".' },
        to: { type: 'string', description: 'The recipient, as the owner would name them (an email address only if the record holds it).' },
        subject: { type: 'string', required: true, description: 'One line.' },
        body: { type: 'string', required: true, description: 'The draft itself, in the owner\'s voice. Under 4000 characters.' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Two to eight short lines naming what the draft rests on — a moment, a heard promise, a PR, a calendar row. The owner sees these; the judge reads them.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: value.recorded ? 'Draft placed on the owner’s Today with its evidence. They send it, or dismiss it; you do not.' : 'Not recorded.' }],
      },
      async execute(args) {
        const kind = args.kind === 'email' || args.kind === 'note' ? args.kind : null
        const subject = String(args.subject ?? '').trim()
        const body = String(args.body ?? '').trim()
        if (!kind || !subject || !body) throw new Error('kind (email|note), subject and body are required')
        const evidence = Array.isArray(args.evidence) ? args.evidence.filter((e) => typeof e === 'string' && e.trim()).slice(0, 12) : []
        await appendSignal('assistant:draft', { kind, subject, body, evidence, ...(typeof args.to === 'string' && args.to.trim() ? { to: args.to.trim() } : {}) })
        return { recorded: true }
      },
    }),

    defineTool({
      name: 'gnomon_propose',
      description:
        'Put a proposal on the record before acting on it — "I could close the noticing-gate branch", "want me to draft that reply?". It opens a tracked, time-limited entry the owner can accept or reject, so what you suggest becomes something you are measured on. Call this for anything consequential you are about to do or recommend.',
      parameters: {
        summary: { type: 'string', required: true, description: 'One line: what you are proposing.' },
        kind: { type: 'string', description: 'Optional short category, e.g. "cleanup", "reply", "reminder".' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        // Says what is true. Until 2026-09-09 this read "the owner can accept
        // or reject it", and for the 23 proposals on the record they could not:
        // `assistantTrack` folds the signal into `state.assistant`, which two
        // prompt builders read and no surface did, so every proposal went into
        // the model's own context and nowhere else. A tool result the model
        // trusts must not describe a delivery that did not happen.
        render: (_args, value) => [{ type: 'text', text: value.recorded ? 'Proposal recorded — it appears on the owner’s Today surface for accept or reject.' : 'Not recorded.' }],
      },
      async execute(args) {
        const summary = String(args.summary).trim()
        if (!summary) throw new Error('summary is required')
        await appendSignal('assistant:proposal', { summary, ...(typeof args.kind === 'string' && args.kind.trim() ? { kind: args.kind.trim() } : {}) })
        return { recorded: true }
      },
    }),

    defineTool({
      name: 'gnomon_record_outcome',
      description:
        "Record the owner's verdict on your most recent open proposal (or a named one): accepted or rejected. This is what closes the loop — a rejected proposal teaches the system as much as an accepted one. Call it as soon as the owner responds to something you proposed.",
      parameters: {
        verdict: { type: 'string', required: true, description: 'accepted or rejected.' },
        proposalId: { type: 'string', description: 'Optional; defaults to the most recent still-open proposal.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' }, verdict: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.recorded ? `Recorded: ${value.verdict}.` : 'Not recorded.' }],
      },
      async execute(args) {
        const verdict = String(args.verdict).trim()
        if (verdict !== 'accepted' && verdict !== 'rejected') throw new Error('verdict must be "accepted" or "rejected"')
        await appendSignal('assistant:response', { verdict, ...(typeof args.proposalId === 'string' && args.proposalId.trim() ? { proposalId: args.proposalId.trim() } : {}) })
        return { recorded: true, verdict }
      },
    }),

    defineTool({
      name: 'gnomon_schedule_wakeup',
      description: [
        'Set a wake-up: come back to something at a specific time — "check the deploy at 17:00", "remind me about the standup tomorrow at 09:00".',
        'The wake-up survives restarts and is folded from the log, not held in this conversation, so it works even if this session is long closed.',
        'It does NOT guarantee an interruption at that instant: when it comes due it goes through the same noticing gate everything else does,',
        'so a wake-up landing mid-call is delayed rather than blared. Give a reason in the owner\'s own terms — it is all they will see when it fires.',
        'Reuse the same key to MOVE an existing wake-up instead of stacking a second one.',
      ].join(' '),
      parameters: {
        at: { type: 'string', required: true, description: 'ISO 8601 instant with an offset, e.g. 2026-08-18T17:00:00+02:00. Must be in the future and within 14 days.' },
        reason: { type: 'string', required: true, description: 'Why, in the owner\'s terms. Shown verbatim when the wake-up fires.' },
        key: { type: 'string', description: 'Optional stable id. Defaults to a slug of the reason. Reusing a key reschedules that wake-up.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { scheduled: { type: 'boolean' }, at: { type: 'string' }, key: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: value.scheduled ? `Wake-up set for ${value.at} (${value.key}).` : 'Not scheduled.' }],
      },
      async execute(args) {
        const reason = String(args.reason ?? '').trim()
        if (!reason) throw new Error('reason is required')

        const at = String(args.at ?? '').trim()
        const dueAt = Date.parse(at)
        if (!Number.isFinite(dueAt)) throw new Error(`at must be an ISO 8601 instant — got "${at}"`)
        // Rejected here as well as in the rule: the rule drops a bad wake-up
        // silently (it is a fold, it cannot argue), so the model would believe
        // it had scheduled something that does not exist.
        if (dueAt <= Date.now()) throw new Error('at must be in the future')
        if (dueAt - Date.now() > 14 * 24 * 60 * 60 * 1000) throw new Error('at must be within 14 days')

        // Derived HERE and sent explicitly, never left for the rule to derive:
        // the rule slugifies a missing key, so returning the raw reason would
        // hand the model a key that cancels nothing.
        const key = typeof args.key === 'string' && args.key.trim() ? args.key.trim() : slugifyWakeupKey(reason)
        if (!key) throw new Error('reason must contain at least one letter or digit, or pass an explicit key')
        const iso = new Date(dueAt).toISOString()
        await appendSignal('wakeup:scheduled', { at: iso, reason, key })
        return { scheduled: true, at: iso, key }
      },
    }),

    // UC1 (U1-F9): a promise the owner states to Gnomon. The terms are read by
    // the fold (`promiseTrack`), so this only carries the owner's words and the
    // three fields the model can see in them.
    defineTool({
      name: 'gnomon_track_promise',
      description: [
        'Track a promise the owner tells you about — "I owe Mira the draft by Tuesday", "I told Bob I\'d review his PR", "Mira will send me the numbers tomorrow".',
        'Only when the owner states it: never a promise you infer, and never your own. Gnomon then keeps it: it closes by itself when the mail, the commit or the file shows up, and it says so, once, before it is due (at the next meeting with that person when no date was said).',
        'Pass the person exactly as the owner named them, the thing in a few of their words, and the due words as they said them ("Tuesday", "morgen") — the date is worked out for you.',
        'To MOVE a promise already tracked (the owner renegotiated it), pass its id (commitment:promise:…) and move_to as an ISO-8601 instant with an offset, resolved against the clock context; nothing else is needed.',
      ].join(' '),
      parameters: {
        id: { type: 'string', description: 'Only to move a tracked promise: its id.' },
        move_to: { type: 'string', description: 'Only to move a tracked promise: the new due instant, ISO-8601 with offset.' },
        what: { type: 'string', description: 'The thing promised, a few words: "the draft". Required unless moving.' },
        to: { type: 'string', description: 'The person it is owed to (or, with owed_to_owner, the person who owes it). Omit when nobody in particular.' },
        due: { type: 'string', description: 'The due words as the owner said them, e.g. "Tuesday", "end of the week", "morgen". Omit when none.' },
        owed_to_owner: { type: 'boolean', description: 'True when someone else promised the OWNER, e.g. "Mira will send me the numbers".' },
        words: { type: 'string', description: 'The owner\'s own sentence, as typed.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { tracked: { type: 'boolean' }, id: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.tracked ? 'Tracking it.' : 'Not tracked.' }],
      },
      async execute(args) {
        const moving = typeof args.id === 'string' && args.id.startsWith('commitment:') && typeof args.move_to === 'string'
        if (moving) {
          if (!Number.isFinite(Date.parse(args.move_to))) throw new Error('move_to must be an ISO 8601 instant')
          await appendSignal('commitment:closed', { id: args.id, by: 'owner', due: new Date(Date.parse(args.move_to)).toISOString() })
          return { tracked: true, id: args.id }
        }
        const what = String(args.what ?? '').trim().slice(0, 80)
        if (!what) throw new Error('what is required')
        const id = `commitment:promise:chat-${Date.now().toString(36)}`
        await appendSignal('commitment:heard', {
          source: 'chat',
          id,
          direction: args.owed_to_owner === true ? 'awaiting' : 'owner',
          deliverable: what,
          ...(typeof args.to === 'string' && args.to.trim() ? { counterparty: args.to.trim().slice(0, 80) } : {}),
          ...(typeof args.due === 'string' && args.due.trim() ? { dueText: args.due.trim().slice(0, 40) } : {}),
          quote: typeof args.words === 'string' && args.words.trim() ? args.words.trim().slice(0, 160) : what,
        })
        return { tracked: true, id }
      },
    }),

    defineTool({
      name: 'gnomon_cancel_wakeup',
      description:
        'Cancel a scheduled wake-up by its key — use when the owner says the thing is handled, or asks you to drop it. A wake-up that already fired is gone on its own and needs no cancelling.',
      parameters: {
        key: { type: 'string', required: true, description: 'The key of the wake-up to cancel, exactly as it was scheduled.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { cancelled: { type: 'boolean' }, key: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.cancelled ? `Cancelled ${value.key}.` : 'Not cancelled.' }],
      },
      async execute(args) {
        const key = String(args.key ?? '').trim()
        if (!key) throw new Error('key is required')
        await appendSignal('wakeup:cancelled', { key })
        return { cancelled: true, key }
      },
    }),

    defineTool({
      name: 'gnomon_ask_owner',
      description: [
        'Ask the owner something only they can answer, and put the question on the record so you find out whether they answered.',
        'Use it for cheap facts you cannot observe — which project a branch belongs to, whether a stalled thread is abandoned or paused, whether a meeting happened.',
        'ONE question can be open at a time; asking again while one is pending is refused, because an assistant holding several open questions cannot tell which one a reply answers.',
        'The question reaches the owner through the same noticing gate everything else does, so it may be delayed if they are busy. It expires unanswered after 24 hours.',
        'When they answer, call gnomon_owner_answer with the askId this returns.',
        'If the question has a small closed set of answers, pass them as `choices` — the owner answers with one tap instead of typing.',
        'Two tempos. Default: the question goes on the record and reaches the owner when the gate says the moment is right; you carry on and record the answer later.',
        '`wait: true`: ONLY inside a turn the owner started (they are talking to you right now) — the question is put to them at once, this call pauses until they answer, and returns the answer so you can continue in the same breath. Never wait inside an unprompted notice turn: nobody may be there. If they do not answer within ten minutes the call returns without an answer and the question simply stays open on the record.',
      ].join(' '),
      parameters: {
        question: { type: 'string', required: true, description: 'One clear question, in the owner\'s terms. Not a paragraph.' },
        reason: { type: 'string', description: 'Optional: why you need to know. Shown as the evidence line under the question.' },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: 2–4 tap-sized answers, under 48 characters each, when the question has a small closed set ("sundial" / "overture" / "neither"). Leave it off for an open question. It is a shortcut, never a constraint — the owner can always answer in their own words instead, and that answer is recorded verbatim.',
        },
        wait: { type: 'boolean', description: 'Pause this turn until the owner answers (they are present, talking to you). Default false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { asked: { type: 'boolean' }, askId: { type: 'string' }, reason: { type: 'string' }, answered: { type: 'boolean' }, answer: { type: 'string' } },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: !value.asked
              ? `Not asked: ${value.reason}`
              : value.answered === true
                ? `The owner answered (${value.askId}): "${value.answer}". Already recorded — do not call gnomon_owner_answer for it.`
                : value.answered === false
                  ? `Asked (${value.askId}), ${value.reason}.`
                  : `Asked (${value.askId}).`,
          },
        ],
      },
      async execute(args, exec) {
        const question = String(args.question ?? '').trim()
        if (!question) throw new Error('question is required')

        // Refused here rather than silently dropped by the rule, so the model
        // learns it still owes an answer on the question already open instead of
        // believing it asked a second one.
        const open = getState?.().ownerAsk?.open
        if (open) return { asked: false, askId: open.askId, reason: `already waiting on an answer to: "${open.question}"` }

        // Answered a moment ago, most likely in the web seat. Refused HERE with
        // the answer in hand, so the model gets the fact it wanted instead of a
        // second chance to ask the owner the same thing (2026-09-07, twice).
        const recent = recentlyAnswered(getState?.().ownerAsk?.recent, question, new Date().toISOString())
        if (recent) return { asked: false, askId: recent.askId, reason: `the owner already answered this at ${recent.answeredAt}: "${recent.answer}". Do not ask again; use that answer.` }

        // Minted here, not in the rule, because the tool has to hand it back to
        // the model in the same breath — a question whose id arrives later
        // cannot be answered by the caller that asked it.
        const askId = `owner-ask:${Date.now().toString(36)}`
        // `choices` is passed through as-is: the `ownerAsk` rule normalizes it
        // (length, count, duplicates), because a replay or the CLI can produce
        // the same signal without ever passing through this tool.
        const wait = args.wait === true
        await appendSignal('ask:owner-opened', {
          askId,
          question,
          ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim() } : {}),
          ...(Array.isArray(args.choices) ? { choices: args.choices } : {}),
          ...(wait ? { mode: 'wait' } : {}),
        })
        if (!wait) return { asked: true, askId, reason: '' }
        // The fold closes the ask on `ask:owner-answered` (a tap in the seat or a
        // typed line — the web shell posts both without a model turn) and records
        // the answer in `ownerAsk.recent`, which is where it is read back from.
        const outcome = await waitForAnswer(askId, exec?.signal)
        return { asked: true, askId, reason: outcome.reason ?? '', ...outcome }
      },
    }),

    defineTool({
      name: 'gnomon_start_job',
      description: [
        'Hand yourself a background job whose result is a brief to KEEP on the owner\'s shelf — "leave me a note on X for tomorrow", or a proposal (gnomon_propose) they just accepted. For something the owner is waiting on in this conversation ("look into X", "count Y"), use the subagent tool instead: its answer comes back here.',
        'The job runs in its own session with read-only tools while this conversation goes on; the result lands on the owner\'s shelf and you tell them in this thread when it does. One job runs at a time; further ones wait their turn (five at most).',
        'Do not use it for something you can answer now with one or two tool calls — answer instead.',
        'With `repeat`, the job is kept and runs on that schedule instead of now ("every monday at 9, write my standup"); the same subject again replaces it, and gnomon_stop_repeat ends it.',
      ].join(' '),
      parameters: {
        subject: { type: 'string', required: true, description: 'A few words the owner will recognise it by, e.g. "Zed vs Cursor for TS monorepos".' },
        brief: { type: 'string', required: true, description: 'The task in the owner\'s own terms: what they want to know, why, and any constraints they gave. Two to five sentences.' },
        repeat: { type: 'string', description: 'Only for a repeating job, in English: days then a time — "every monday at 9am", "weekdays at 17:30", "daily at 8", "every tuesday and thursday at 14:00", "weekends at 10". Nothing finer than a day.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { queued: { type: 'boolean' }, subject: { type: 'string' }, repeat: { type: 'string' }, nextRun: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.repeat ? `Repeating job kept: "${value.subject}", ${value.repeat}. Next run ${value.nextRun}; each result lands on the shelf.` : value.queued ? `Job taken: "${value.subject}". It runs in the background; the result appears on the shelf and you will be told.` : 'Not queued.' }],
      },
      async execute(args) {
        const subject = String(args.subject ?? '').trim()
        const brief = String(args.brief ?? '').trim()
        const repeat = String(args.repeat ?? '').trim()
        if (subject === '' || brief === '') throw new Error('subject and brief are both required')
        // Refused HERE so the model learns it, where the rule can only drop it.
        const state = getState?.()
        const bench = state?.workbench
        if (repeat !== '') {
          const schedule = parseRepeat(repeat)
          if (!schedule) throw new Error(`cannot read "${repeat}" as a schedule; write days then a time, e.g. "every monday at 9am" or "weekdays at 17:30"`)
          const repeats = bench?.repeats ?? {}
          if (!(repeatKey(subject) in repeats) && Object.keys(repeats).length >= 10) throw new Error(`ten repeating jobs already: ${Object.values(repeats).map((r) => r.subject).join(', ')}; ask the owner which to stop`)
          await appendSignal('work:requested', { subject, brief, repeat })
          const zone = state?.config?.timezone ?? 'UTC'
          const next = nextOccurrence(schedule, new Date().toISOString(), zone)
          return { queued: false, subject, repeat, nextRun: next ? new Date(next).toLocaleString('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : 'within a week' }
        }
        if ((bench?.queue ?? []).length >= 5) throw new Error('five jobs are already waiting; tell the owner and ask which to drop')
        await appendSignal('work:requested', { subject, brief })
        return { queued: true, subject }
      },
    }),

    defineTool({
      name: 'gnomon_stop_repeat',
      description: 'End a repeating job the owner set up with gnomon_start_job and `repeat`, by its subject. A run already on its way still finishes.',
      parameters: {
        subject: { type: 'string', required: true, description: 'The repeating job\'s subject, as it was kept.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { stopped: { type: 'string' }, remaining: { type: 'array', items: { type: 'string' } } } },
        render: (_args, value) => [{ type: 'text', text: `Stopped "${value.stopped}".${value.remaining.length > 0 ? ` Still repeating: ${value.remaining.join(', ')}.` : ''}` }],
      },
      async execute(args) {
        const subject = String(args.subject ?? '').trim()
        const repeats = getState?.().workbench?.repeats ?? {}
        const key = repeatKey(subject)
        if (!(key in repeats)) {
          const kept = Object.values(repeats).map((r) => `"${r.subject}" (${r.schedule})`)
          throw new Error(kept.length > 0 ? `no repeating job called "${subject}"; the kept ones are ${kept.join(', ')}` : 'there are no repeating jobs')
        }
        await appendSignal('work:repeat-stopped', { subject })
        return { stopped: repeats[key].subject, remaining: Object.entries(repeats).filter(([k]) => k !== key).map(([, r]) => r.subject) }
      },
    }),

    defineTool({
      name: 'gnomon_owner_answer',
      description:
        "Record the owner's answer to a question you asked with gnomon_ask_owner. Call it as soon as they reply, in their own words — this is what closes the question and lets you ask the next one.",
      parameters: {
        askId: { type: 'string', required: true, description: 'The askId gnomon_ask_owner returned.' },
        answer: { type: 'string', required: true, description: "The owner's answer, in their words." },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' }, askId: { type: 'string' }, reason: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.recorded ? `Answer recorded for ${value.askId}.` : `Not recorded: ${value.reason}` }],
      },
      async execute(args) {
        const askId = String(args.askId ?? '').trim()
        const answer = String(args.answer ?? '').trim()
        if (!askId) throw new Error('askId is required')
        if (!answer) throw new Error('answer is required')
        // The reducer drops an answer to a question that is not the open one,
        // silently. Saying "recorded" for it is what sent the model looking for
        // an id to re-record against — by asking the owner again. Refuse first,
        // and say why, so the model stops rather than retries.
        const ask = getState?.().ownerAsk
        const open = ask?.open ?? null
        if (open === null) {
          const recent = (ask?.recent ?? []).find((entry) => entry.askId === askId)
          return {
            recorded: false,
            askId,
            reason: recent
              ? `that question was already answered at ${recent.answeredAt} ("${recent.answer}"); nothing is open. Do not ask it again.`
              : 'no question is open; it was answered elsewhere or expired. Do not ask it again.',
          }
        }
        if (open.askId !== askId) {
          return { recorded: false, askId, reason: `the open question has askId ${open.askId} ("${open.question}"), not ${askId}. Record against the open one, or let it go.` }
        }
        await appendSignal('ask:owner-answered', { askId, answer })
        return { recorded: true, askId }
      },
    }),
  ]
}


/**
 * `gnomon_calendar_create` — the first outward tool that is not a shell.
 *
 * Writes one event to the owner's own calendar through the same EventKit helper
 * the calendar sensor reads with. The helper is a pair of hands: this tool does
 * not decide whether to run — the gate does (outward: asks under
 * workspace-write, denied under read-only) — and it records what it did as an
 * `action:performed` signal so the outcome is on the record like every other
 * action.
 *
 * @param appendSignal writes to the log.
 * @param helperPath the compiled helper; injected so tests never spawn it.
 * @param run `execFile` or a stand-in.
 */
export function calendarCreateTool(appendSignal, helperPath, run) {
  return defineTool({
    name: 'gnomon_calendar_create',
    description: [
      "Create one event in the owner's calendar (Apple Calendar, on this Mac). Use it when the owner asks to block time, schedule something, or put a meeting in — never on your own initiative: propose first with gnomon_propose, and create only once they agree.",
      'Times are ISO-8601 with an offset (e.g. 2026-09-04T14:00:00+02:00); resolve "tomorrow at 2" against the clock context before calling. `calendar` is optional and must name one of their writable calendars; leave it off for the default.',
      'Returns the saved event exactly as the calendar sensor will read it back.',
    ].join(' '),
    parameters: {
      title: { type: 'string', required: true, description: 'The event title, as the owner would write it.' },
      start: { type: 'string', required: true, description: 'ISO-8601 start, with timezone offset.' },
      end: { type: 'string', required: true, description: 'ISO-8601 end, with timezone offset; after start.' },
      calendar: { type: 'string', description: 'Optional: the calendar name. Default calendar when omitted.' },
      location: { type: 'string', description: 'Optional location.' },
      notes: { type: 'string', description: 'Optional notes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'boolean' },
          eventId: { type: 'string' },
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          calendar: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.created ? `Created "${value.title}" in ${value.calendar}, ${value.start} → ${value.end}.` : `Not created: ${value.error}` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const title = String(args.title ?? '').trim()
      const start = String(args.start ?? '').trim()
      const end = String(args.end ?? '').trim()
      if (!title || !start || !end) throw new Error('title, start and end are required')
      const argv = ['--create', '--title', title, '--start', start, '--end', end]
      for (const key of ['calendar', 'location', 'notes']) {
        if (typeof args[key] === 'string' && args[key].trim() !== '') argv.push(`--${key}`, args[key].trim())
      }

      const output = await new Promise((resolve) => {
        run(helperPath, argv, { timeout: 15_000 }, (error, stdout) => {
          if (error && !stdout) return resolve({ created: false, error: error.message })
          try {
            resolve(JSON.parse(String(stdout)))
          } catch {
            resolve({ created: false, error: 'the calendar helper returned something that was not JSON' })
          }
        })
      })

      if (output.created !== true) {
        const error = output.accessGranted === false ? 'Calendar access is not granted to Gnomon. Grant it in System Settings → Privacy & Security → Calendars.' : String(output.error ?? 'unknown')
        return { created: false, error }
      }
      const ev = output.event ?? {}
      await appendSignal('action:performed', { tool: 'calendar_create', eventId: ev.eventId ?? null, title: ev.title ?? title, start: ev.startDate ?? start, end: ev.endDate ?? end, calendar: ev.calendar ?? null })
      return { created: true, eventId: String(ev.eventId ?? ''), title: String(ev.title ?? title), start: String(ev.startDate ?? start), end: String(ev.endDate ?? end), calendar: String(ev.calendar ?? '') }
    },
  })
}

/**
 * `gnomon_reminder_create` (UC1 U1-F38) — mirror a promise as an Apple
 * Reminder, with its due date. Outward like `gnomon_calendar_create`: the
 * gate asks before it runs, and the helper is only a pair of hands. The
 * reminder is recorded as `action:performed` with the promise it mirrors, so
 * the fold takes its due date and closes the promise when it is completed.
 */
export function reminderCreateTool(appendSignal, helperPath, run) {
  return defineTool({
    name: 'gnomon_reminder_create',
    description: [
      "Add one reminder to the owner's Apple Reminders, for a promise Gnomon is tracking — only when the owner asks for it, never on your own initiative.",
      'Pass the promise id from the ledger (commitment:promise:…), a title in the owner\'s words, and the due time as ISO-8601 with an offset. When the owner completes the reminder, the promise closes as kept.',
    ].join(' '),
    parameters: {
      title: { type: 'string', required: true, description: 'The reminder, as the owner would write it: "Send Mira the draft".' },
      due: { type: 'string', description: 'ISO-8601 due time with offset. Optional.' },
      promiseId: { type: 'string', description: 'The promise this mirrors (commitment:promise:…).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { created: { type: 'boolean' }, reminderId: { type: 'string' }, due: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.created ? `Added to Reminders${value.due ? `, due ${value.due}` : ''}.` : `Not added: ${value.error}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const title = String(args.title ?? '').trim()
      if (!title) throw new Error('title is required')
      const argv = ['--create-reminder', '--title', title]
      if (typeof args.due === 'string' && args.due.trim() !== '') {
        if (!Number.isFinite(Date.parse(args.due))) throw new Error('due must be an ISO-8601 date')
        argv.push('--due', args.due.trim())
      }
      const output = await new Promise((resolve) => {
        run(helperPath, argv, { timeout: 30_000 }, (error, stdout) => {
          if (error && !stdout) return resolve({ created: null, error: error.message })
          try {
            resolve(JSON.parse(String(stdout)))
          } catch {
            resolve({ created: null, error: 'the helper returned something that was not JSON' })
          }
        })
      })
      if (!output.created) return { created: false, error: output.accessGranted === false ? 'Reminders access is not granted to Sundial. Grant it in System Settings → Privacy & Security → Reminders.' : String(output.error ?? 'unknown') }
      const r = output.created
      const promiseId = typeof args.promiseId === 'string' ? args.promiseId.trim() : ''
      await appendSignal('action:performed', { tool: 'reminder_create', reminderId: r.id, title: r.title, due: r.due ?? null, ...(promiseId ? { promiseId } : {}) })
      return { created: true, reminderId: String(r.id), ...(r.due ? { due: String(r.due) } : {}) }
    },
  })
}
