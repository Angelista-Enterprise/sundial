import { deriveId } from '@sundial/helpers/derive-id.js';
// One re-ask predicate, shared with `gnomon_ask_owner` so the tool and the
// reducer cannot disagree about what counts as the same question.
import { recentlyAnswered } from '@sundial/helpers/asked.js';
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import type { AnsweredOwnerAsk, Effect, HabituationEntry, KernelState, OpenOwnerAsk, OwnerAskRow, Rule } from '@sundial/kernel/types.js';
import { REDACTION_ALIAS } from './entity-name-validation.js';
import { DEFAULT_GATE_POLICY, habituatedGain } from './notice-gate.js';

/**
 * Gnomon asking the owner something, and knowing whether it was answered.
 *
 * Every other path in this system runs the other way: sensors observe, rules
 * infer, the gate decides whether to say. Nothing could ask. That bounded a
 * whole class of cheap knowledge — which of two projects a branch belongs to,
 * whether a meeting actually happened, whether a commitment is abandoned or
 * merely paused — behind inference that will never be as good as one question.
 *
 * Shaped after `solicitFeedback` rather than after `askTrack`: one open question
 * at a time with a TTL, closed by the reducer recognizing the answering event.
 * A queue would be an interrogation, and — worse — an assistant holding three
 * open questions cannot tell which one a reply answers.
 *
 * The question reaches the owner as an ordinary `notice:candidate`, not by a
 * private channel. That is the point: asking is a form of speaking, priced by
 * the same gate, so a question that arrives mid-call is DEFERRED rather than
 * blared. The alternative — a question that always interrupts because it is a
 * question — is exactly how an assistant becomes something you mute.
 */

/** Silence is not a `no`. It just unblocks the next question — and is recorded, because being ignored is evidence about the asking. */
const OWNER_ASK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Matches the wake-up weight for the same reason: a question was deliberately
 * asked, so the gate's remaining job is WHEN, not whether. Clears
 * `phasicThreshold` (1.6) and `budgetExemptAbove` (1.6).
 */
const ASK_SURPRISE = 2.0;

/** Two hours — a question is worth much less once the moment it was about has passed, which is what this field means. */
const ASK_VALUE_HALF_LIFE_MS = 2 * 60 * 60 * 1000;

/** How many answered questions are remembered. Five is more than a day of asks. */
const RECENT_MAX = 5;

/** The Notify channel a WAITING ask is announced on; the web shell redraws the seat on it. Not a notice: delivery ignores it. */
export const ASK_OPEN_CHANNEL = 'ask-open';

/** The gate key for an ask. Ask ids already begin with `owner-ask:` (the tool and meeting-followup mint them so); this used to prefix again. */
export function askKey(askId: string): string {
  return askId.startsWith('owner-ask:') ? askId : `owner-ask:${askId}`;
}

/**
 * Which KIND of question this is — the stimulus the owner actually judges.
 *
 * A notice key is the stimulus because the same notice recurs. An ask does not:
 * it is asked once, about one meeting or one alias, and then it is over. So a
 * per-ask key is a stimulus that never repeats, and the record shows exactly
 * that — over the 63 gate decisions an ask has ever had, `habituation` is 1.0
 * on every one and `weight` is 2.0 on every one. Nothing an owner could ever
 * press would have moved either number.
 *
 * What DOES repeat is the template. Gnomon has four, and the owner's complaints
 * have always been about one of them rather than about a question: "Don't ask me
 * to identify hashed attendee IDs — that needs to be handled in code", said in
 * five different wordings across ten `who` asks. That is a verdict on a class.
 *
 * Read off the ask's OWN ID, which the minting rules build from the subject
 * (`owner-ask:meeting-<id>`, `owner-ask:who-<alias>`, `owner-ask:goals-<date>`),
 * and never off the question text — the text is a template with a subject
 * substituted in, so matching it is matching the template badly. Anything else
 * is `other`, which is where every question Gnomon composed for itself lands.
 *
 * The client's `askKind` (`plugins/sundial-theme/shell/asks.js`) splits the same
 * ids the same way and cannot import this, because the shell is plain ES modules
 * served from disk. Pinned against it by *asks.test.js*, which reads this file.
 */
export function askClass(askId: string): string {
  const tail = askKey(askId).slice('owner-ask:'.length);
  if (tail.startsWith('who-')) return 'who';
  if (tail.startsWith('meeting-')) return 'meeting';
  if (tail.startsWith('goals-')) return 'goals';
  return 'other';
}

/**
 * How sure Gnomon is that this class of question is worth putting to the owner.
 *
 * `precision` is the gate's term for confidence in the expectation behind a
 * candidate, and it is the honest place for this: the owner pressing "the wrong
 * question" is evidence about how likely this KIND of question is worth asking,
 * not about how surprising the thing that prompted it was. So `surprise` stays
 * at `ASK_SURPRISE` — a question was still deliberately asked, and that fact
 * does not change — and this moves instead.
 *
 * **Moved only by the owner, never by delivery, and the record decides that.**
 * Handing the gate a class key instead would have got the decay for free, and
 * it would have been wrong: delivery-decay puts the third meeting ask under the
 * phasic bar and the ceiling term pins it there, and the meeting class is the
 * one that works — 25 of its 26 asks answered, and every routable answer on the
 * card came from one (the tango hint decision, Alex's feedback, the Thomas call).
 * Habituating what works to silence is the opposite of the fix. The `who` class,
 * which the owner refused ten times, is the one that should go quiet, and only
 * their verdict can tell those two apart.
 *
 * Same curve as the gate's, read with the gate's own `habituatedGain`: one
 * verdict takes the class to 0.4, which drops an ask's weight to 0.8 — under
 * `phasicThreshold`, so it stops interrupting and becomes a row in the list. A
 * second takes it under `tonicThreshold` and the class goes silent. Recovery is
 * the gate's too, so a class the owner quiets in September is askable again in
 * October without anyone having to remember to switch it back on.
 */
export function askPrecision(state: KernelState, askId: string, ts: string): number {
  return habituatedGain(state.ownerAsk.classGain?.[askClass(askId)], Date.parse(ts), DEFAULT_GATE_POLICY);
}

/** One verdict's worth of quieting, so the reducer and the boot rebuild cannot apply it differently. */
export function quietClass(previous: HabituationEntry | undefined, ts: string): HabituationEntry {
  return {
    gain: habituatedGain(previous, Date.parse(ts), DEFAULT_GATE_POLICY) * DEFAULT_GATE_POLICY.habituationStep,
    at: ts,
    fires: (previous?.fires ?? 0) + 1,
  };
}

/** A verdict on an ask, as the log holds it. */
export interface AskVerdictRow {
  askId: string;
  verdict: string;
  at: string;
}

/**
 * Rebuild `classGain` from the LOG at boot, oldest first.
 *
 * `classGain` is fold-derived, and fold-derived state only survives if every
 * fold that built it is inside the snapshot or still in the replayed tail. A
 * verdict the owner pressed last week is in neither — which is not a
 * hypothetical here: the one verdict the record holds is from 2026-09-21, and
 * without this the consumer would have started at zero on the very machine
 * whose owner had already pressed the button. The same argument, and the same
 * fix, as `memory.aliasNames` — see the comment beside it in `boot()`.
 *
 * Rebuilding from the log rather than mirroring a table is the honest shape for
 * this one: `signals` IS the durable record of a verdict, there is no table to
 * mirror, and replaying it re-derives exactly what a full replay would. The
 * timestamps come back with it, so `habituatedGain` recovers a class quieted in
 * September by the time it is read in October — which is the behaviour, not a
 * loss of it.
 */
export function rebuildAskClassGain(rows: readonly AskVerdictRow[]): Record<string, HabituationEntry> {
  const gain: Record<string, HabituationEntry> = {};
  for (const row of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    if (row.verdict !== 'wrong' && row.verdict !== 'not-now') continue;
    const cls = askClass(row.askId);
    gain[cls] = quietClass(gain[cls], row.at);
  }
  return gain;
}

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A tap-sized answer. Longer than this is a sentence, and belongs in the box. */
const CHOICE_MAX_CHARS = 48;

/**
 * The one-tap answers, normalized in the REDUCER rather than trusted from the
 * payload.
 *
 * A signal can arrive from a replay of an older log, from the CLI, or from a
 * model that ignored the tool's schema, so the shape has to be re-established
 * here or a bad list reaches state and then the screen. Four is the ceiling
 * because a fifth button is a menu, and a menu is a question that should have
 * been asked differently.
 */
function choicesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const choice = trim(entry);
    if (choice === '' || choice.length > CHOICE_MAX_CHARS) continue;
    seen.add(choice);
    if (seen.size === 4) break;
  }
  // One button is not a choice, it is a prompt to agree. Drop the list and let
  // the owner answer in their own words.
  return seen.size < 2 ? [] : [...seen];
}

function rowFor(ask: OpenOwnerAsk, close: { answer: string | null; answeredAt: string | null; outcome: string }): OwnerAskRow {
  return {
    id: ask.askId,
    question: ask.question,
    reason: ask.reason === '' ? null : ask.reason,
    askedAt: ask.ts,
    ...close,
  };
}

/**
 * A question the owner CANNOT answer, whoever asked it.
 *
 * A redaction alias or placeholder in the question text means the question is
 * quoting something the sanitizer deliberately made unreadable — a
 * `person-<hash>`, a `[private]` window title, a `[hidden]` app. Those exist so
 * that a value is never shown; putting one to the owner asks them to decode it,
 * and they cannot, because the readable form was discarded at ingest and was
 * never theirs to begin with.
 *
 * The instance that forced this: `peopleAsk` sent "Who is person-c7e3af19c4?
 * They were in ... with you and person-fdc656585a, Acme Office,
 * person-44d889e0a7" seven times on 2026-09-09, and was refused seven times.
 * Its own bugs are fixed in that rule, but the guard belongs HERE — this is the
 * one place every producer's question arrives, so one check covers the rule
 * that did it, the tool an assistant can call, and whatever asks next.
 *
 * The refusal is silent because a rule is pure — no rule in the manifest logs,
 * and this one is not going to be the first. It is still auditable: the
 * `ask:owner-opened` signal is in the log with no matching `owner_asks` row, so
 * a producer phrasing unanswerable questions shows up as exactly that gap.
 */
export function unanswerable(question: string): string | null {
  for (const word of question.split(/[\s,.;:?!"()]+/)) {
    const token = word.trim();
    if (token === '') continue;
    if (REDACTION_ALIAS.test(token) || isRedactedPlaceholder(token)) return token;
  }
  return null;
}

export const ownerAsk: Rule = (state, event) => {
  if (event.type === 'ask:owner-opened') {
    const question = trim(event.payload.question);
    if (question === '') return { state, effects: [] };

    // Never put a hash or a redaction placeholder to a human.
    if (unanswerable(question) !== null) return { state, effects: [] };

    // A second question while one is pending is DROPPED, not queued. The tool
    // reads `state.ownerAsk.open` and refuses first, so reaching here means a
    // race, and losing the newer question is the safer half of that race: the
    // owner is already looking at one.
    if (state.ownerAsk.open) return { state, effects: [] };

    // Already answered a moment ago — by a tap in the seat, most likely, while
    // the companion still believed it owed the owner the question. Asking it
    // again is the one thing the owner remembers about an assistant.
    if (recentlyAnswered(state.ownerAsk.recent, question, event.ts) !== null) return { state, effects: [] };

    const askId = trim(event.payload.askId) || deriveId(event.ts, event.id, 'owner-ask', question);
    // `mode: 'wait'` — the tool is holding its turn open for the answer. The
    // owner is present by construction (they started that turn), so the gate's
    // WHEN question is already answered: now. The seat is told directly over a
    // Notify channel instead of a candidate, and no candidate is emitted, or a
    // gated prose turn later would put the same question twice.
    const waiting = event.payload.mode === 'wait';
    const open: OpenOwnerAsk = { askId, question, reason: trim(event.payload.reason), choices: choicesFrom(event.payload.choices), ts: event.ts, ...(waiting ? { waiting } : {}) };
    const next = { ...state, ownerAsk: { ...state.ownerAsk, open, askedCount: state.ownerAsk.askedCount + 1 } };

    if (waiting) return { state: next, effects: [{ type: 'Notify', channel: ASK_OPEN_CHANNEL, payload: { askId } }] };

    return {
      state: next,
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: deriveId(event.ts, event.id, 'owner-ask', `notice:${askId}`),
            type: 'notice:candidate',
            ts: event.ts,
            payload: {
              timestamp: event.ts,
              shape: 'self-report',
              kind: 'owner-question',
              key: askKey(askId),
              surprise: ASK_SURPRISE,
              // Not 1 any more. `askPrecision` is the owner's standing verdict
              // on this KIND of question, and it is what makes the ask gate a
              // gate: before it, every ask weighed exactly 2.0.
              precision: askPrecision(state, askId, event.ts),
              valueHalfLifeMs: ASK_VALUE_HALF_LIFE_MS,
              observation: question,
              evidence: open.reason === '' ? [] : [open.reason],
              concerns: [],
              // Carried the way `noticeKey` is, so the companion can name the
              // right ask when the owner answers. A question delivered without
              // its id is a question whose answer can only be guessed at.
              askId,
            },
          },
        },
      ],
    };
  }

  if (event.type === 'ask:owner-answered') {
    const open = state.ownerAsk.open;
    if (!open) return { state, effects: [] };

    // Matched, not assumed: an answer naming a different ask is a stale reply
    // to a question that already expired, and folding it would attribute the
    // owner's words to the wrong question.
    const askId = trim(event.payload.askId);
    if (askId !== '' && askId !== open.askId) return { state, effects: [] };

    const answer = trim(event.payload.answer);
    if (answer === '') return { state, effects: [] };

    const remembered: AnsweredOwnerAsk = { askId: open.askId, question: open.question, answer, answeredAt: event.ts };
    const ownerAskState: KernelState['ownerAsk'] = {
      open: null,
      askedCount: state.ownerAsk.askedCount,
      answeredCount: state.ownerAsk.answeredCount + 1,
      recent: [...(state.ownerAsk.recent ?? []), remembered].slice(-RECENT_MAX),
      lastBackfillAt: state.ownerAsk.lastBackfillAt,
      backfillDone: state.ownerAsk.backfillDone,
      classGain: state.ownerAsk.classGain,
    };
    const effects: Effect[] = [
      { type: 'WriteDB', table: 'owner_asks', row: rowFor(open, { answer, answeredAt: event.ts, outcome: 'answered' }) },
    ];
    return { state: { ...state, ownerAsk: ownerAskState }, effects };
  }

  if (event.type !== 'clock:tick') return { state, effects: [] };

  const open = state.ownerAsk.open;
  if (!open) return { state, effects: [] };
  if (Date.parse(event.ts) - Date.parse(open.ts) < OWNER_ASK_TTL_MS) return { state, effects: [] };

  return {
    state: { ...state, ownerAsk: { ...state.ownerAsk, open: null } },
    // Recorded rather than silently dropped: a question the owner ignored says
    // something about the asking, and a table of only-answered questions would
    // report the asking as perfectly calibrated by construction.
    effects: [{ type: 'WriteDB', table: 'owner_asks', row: rowFor(open, { answer: null, answeredAt: null, outcome: 'expired' }) }],
  };
};
