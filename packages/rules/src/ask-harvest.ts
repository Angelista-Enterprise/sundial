import type { AskProposal, Rule } from '@sundial/kernel/types.js';
import { withPersona } from '@sundial/kernel/persona.js';
import { MAX_CONVERSATION_CONFIDENCE } from './conversation-extract.js';
import { normalizePredicate } from './nightly-fact-extract.js';

/**
 * Reading what the owner already told us, so keeping it costs one press.
 *
 * The card this feeds is an INBOX for the owner's own words, and its one
 * measure is how many answers became beliefs: 1 of 49 when this was written,
 * and the one was a misfire. What capped it was the routing form — four fields
 * and about thirty seconds an answer — so nobody filled it in twelve times.
 *
 * **This rule proposes BESIDE the ask and never writes a fact.** The precedent
 * is `transcriptClean` and the reason written on that rule applies here word
 * for word: it only takes one confident correction of a word that was right for
 * the record to start lying in the owner's own voice. So the model's reading
 * goes in `owner_asks.proposals`, marked as a reading by where it is stored,
 * and the owner's press on `/gnomon/api/assert` stays the only thing that makes
 * a fact. Emitting an `entity:fact-candidate` from here would be exactly the
 * `peopleAsk` misfire this rule exists to replace — that auto-router took the
 * owner's counter-question, "in which meeting where they?", and wrote it down
 * as a human being's name, where it stood until they corrected it by hand.
 *
 * **No new `LlmPurpose`.** It shares `extract` with the nightly moment pass and
 * the conversation pass, whose own comment says why: one more call a day, same
 * family of work — owner text in, typed fact candidates out — and no five-place
 * purpose plumbing. The cap is 300 a day and about two are used.
 *
 * **Ordering: this runs BEFORE `ownerAsk` in `RULE_MANIFEST`**, the same
 * requirement `transcriptClean` has against `momentClose`. It reads the
 * question off `state.ownerAsk.open`, and `ownerAsk` sets that to null on this
 * very event. Placed after it, every harvest would see no question at all.
 */

/** Three, not the nightly pass's ten. An answer is a paragraph, and a ceiling of ten is an invitation to pad. */
export const MAX_ASK_PROPOSALS = 3;

/** Below this the nightly pass already drops a candidate, and a weak reading of one paragraph is weaker still. */
export const MIN_ASK_PROPOSAL_CONFIDENCE = 50;

/**
 * The backfill's own door into this rule.
 *
 * `askHarvest` fires forwards; the 49 answers that predate it are reached by
 * `askHarvestBackfill`, whose executor does the DB read a pure rule cannot and
 * appends this event carrying the row it found. One event type rather than a
 * second prompt, so the sweep and the live path cannot ask different questions.
 */
export const ASK_HARVEST_DUE = 'ask:harvest-due';

/**
 * The instruction half. Shares `conversationExtractionInstructions`' vocabulary
 * — the same entity kinds, the same preferred predicates, the same strict-JSON
 * shape — because a second vocabulary for the same fact table is how two
 * surfaces start disagreeing about what a predicate means.
 *
 * Three differences, each earned on the live record:
 *
 *  1. The QUESTION is in the prompt. "Fine, nothing to keep" means nothing
 *     without it, and "Jordan De Wit" is only a `knownAs` because the
 *     question was "who is person-d1feb17d9f?".
 *  2. Three proposals, not ten (`MAX_ASK_PROPOSALS`).
 *  3. Refusing is said plainly, because it is the commonest right answer.
 *     Measured over the 49 answers on 2026-09-22: 29 of them hold nothing at
 *     all — "Fine, nothing to keep", "didnt attend this", ten refusals to
 *     identify a hashed attendee, and half a dozen counter-questions. A prompt
 *     that does not say so will invent something for all 49.
 *
 * The answer reaches the model RAW, unlike the conversation pass, which redacts
 * the owner's turns first. That asymmetry is deliberate and was decided by the
 * owner on 2026-09-22: redaction would strip the spreadsheet link out of the
 * tango answer, which is the single most routable thing on the whole card; the
 * same words already reach the same model through the `ask` purpose every time
 * the owner talks to it; and a conversation transcript is a wide net over
 * everything the owner happened to type, where an ask answer is one paragraph
 * written on purpose in reply to a question Gnomon asked. Nothing at ingest
 * changes — `sanitizeAtIngest` has never had a rule for this field.
 */
export function askHarvestInstructions(ownerName: string): string {
  return [
    `${ownerName}, the owner, was asked one question by you and typed one answer back. Read ONLY the answer, and only for what is worth remembering for weeks: preferences and dislikes, routines and schedules, people and their relation to the owner, places, plans and goals, projects and their state, decisions taken, dates that matter, and instructions about how the owner wants you to behave.`,
    `Most answers hold nothing, and saying so is the right answer — on this owner's record roughly three in five are a courtesy ("Fine, nothing to keep", "didnt attend this"), a refusal, or a question back at you. Return [] for every one of those. Do NOT extract: a question the owner asked you, a refusal, an instruction about how to ask better, a complaint about the question, or anything true only for that hour.`,
    `Use entityKind "owner" with canonicalName "${ownerName}" for facts about the owner themselves. Use "goal" for something the owner wants to achieve (canonicalName = the goal in a few of their words; predicates status = open|paused|done|dropped, targetDate, why). Use "person" for other people (by the name the owner used — and when the owner names someone the record knows only as "person-<hash>", emit knownAs on that alias), "project" for projects, "tool" for software, "topic" for anything else. Never make the owner a "person".`,
    // Measured, 2026-09-22: asked who `person-d1feb17d9f` was, the model read
    // the answer correctly and then wrote it inside out — canonicalName "Jordan
    // De Wit", object the hash — which would mint a SECOND entity
    // rather than give the one the record already has a name. The record
    // stores it the other way round (`peopleAsk`, and the card's own
    // `routePrefill`), so the direction is spelt out with its example.
    `A "knownAs" fact hangs on the name the RECORD holds, not on the new one: when the question is "who is person-d1feb17d9f?" and the owner answers "Jordan De Wit", set canonicalName to "person-d1feb17d9f" and object to "Jordan De Wit". Never the reverse.`,
    `Prefer these predicates when they fit: prefers, dislikes, wakeAt, asleepBy, dayBeginsAt, dayEndsAt, workSchedule, occupation, livesIn, worksWith, relationship, birthday, goal, plansTo, instructs, worksOn, usesTool, relatesToProject, knownAs, decided. A profile attribute (wake time, occupation, where they live) holds ONE value — state the newest the owner gave.`,
    `"confidence" orders your proposals and nothing else; it does not become a belief, because nothing here writes one — the owner presses a button or the reading is discarded. Above 80 only when the owner stated it plainly. 50-70 when it is a fair reading. Below ${MIN_ASK_PROPOSAL_CONFIDENCE}, leave it out. Never above ${MAX_CONVERSATION_CONFIDENCE}.`,
    `Respond with STRICT JSON only, no markdown fencing: a JSON array of up to ${MAX_ASK_PROPOSALS} objects, each exactly {"entityKind": "owner"|"goal"|"person"|"project"|"tool"|"topic", "canonicalName": "...", "predicate": "...", "object": "...", "confidence": 1-${MAX_CONVERSATION_CONFIDENCE}}. Respond with [] when nothing qualifies.`,
  ].join(' ');
}

/** The question and the answer, as the model sees them. The question is half the meaning of the answer. */
export function askHarvestPrompt(question: string, answer: string): string {
  return `Gnomon asked: ${question}\n\nThe owner answered: ${answer}`;
}

const VALID_ENTITY_KINDS = new Set(['person', 'project', 'tool', 'topic', 'owner', 'goal']);

/**
 * Parse the model's reading, in `parseExtractedFactCandidates`' defensive
 * style: strip a fence, validate every field, drop anything malformed rather
 * than throw. A bad response degrades to "nothing read", which is a perfectly
 * ordinary outcome here rather than a failure.
 *
 * Two filters the nightly pass does not have: weak readings are dropped
 * (`MIN_ASK_PROPOSAL_CONFIDENCE`) and the list is cut to three, strongest
 * first, so the card's second and third rows are the model's two best other
 * ideas rather than whatever it listed last.
 */
export function parseAskProposals(text: string): AskProposal[] {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const proposals: AskProposal[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const entityKind = typeof row.entityKind === 'string' ? row.entityKind : '';
    const canonicalName = typeof row.canonicalName === 'string' ? row.canonicalName.trim() : '';
    const predicate = typeof row.predicate === 'string' ? normalizePredicate(row.predicate.trim()) : '';
    const object = typeof row.object === 'string' ? row.object.trim() : '';
    const confidence = typeof row.confidence === 'number' ? row.confidence : NaN;
    if (!VALID_ENTITY_KINDS.has(entityKind) || !canonicalName || !predicate || !object || !Number.isFinite(confidence)) continue;
    if (confidence < MIN_ASK_PROPOSAL_CONFIDENCE) continue;
    // Nothing is a fact about itself — `parseExtractedFactCandidates` learned
    // this from `project:sundial worksOn sundial` sitting on the entity card.
    if (canonicalName.toLowerCase() === object.toLowerCase()) continue;
    proposals.push({
      entityKind: entityKind as AskProposal['entityKind'],
      canonicalName,
      predicate,
      object,
      confidence: Math.max(1, Math.min(MAX_CONVERSATION_CONFIDENCE, Math.round(confidence))),
    });
  }
  return proposals.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_ASK_PROPOSALS);
}

/**
 * One a minute, which is one per `clock:tick` — the fastest this sweep can go.
 *
 * Written as one an HOUR, on the reasoning that 49 answers is two days inside a
 * cap of 300 that sees about two. The owner asked for it faster on the day it
 * landed and they are right: nothing is waiting on a slow drain, and the whole
 * backlog is 49 calls — a sixth of one day's cap, spent once and never again,
 * because the sweep ends when the column has no NULLs left.
 *
 * It stays a cursor with an interval rather than a loop. A rule that drained
 * the table in one fold would be a rule holding a queue, and the interval is
 * what keeps a restart from re-firing the sweep the instant it boots.
 */
export const ASK_BACKFILL_INTERVAL_MS = 60 * 1000;

/** The executor saying there is nothing left to read. The one thing that ends the sweep. */
export const ASK_HARVEST_DRAINED = 'ask:harvest-drained';

/** The question and answer this event is about, from either door. */
function harvestable(state: Parameters<Rule>[0], event: Parameters<Rule>[1]): { askId: string; question: string; answer: string } | null {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

  if (event.type === ASK_HARVEST_DUE) {
    // The backfill's executor already read the row, so nothing here reaches for
    // `state.ownerAsk.open` — the ask it names closed days or weeks ago.
    const askId = text(event.payload.askId);
    const question = text(event.payload.question);
    const answer = text(event.payload.answer);
    return askId && question && answer ? { askId, question, answer } : null;
  }

  if (event.type !== 'ask:owner-answered') return null;
  const open = state.ownerAsk.open;
  if (!open) return null;
  // The same match `ownerAsk` makes a beat later: an answer naming a different
  // ask is a stale reply to an expired question, and harvesting it would read
  // the owner's words against the wrong question.
  const named = text(event.payload.askId);
  if (named !== '' && named !== open.askId) return null;
  const answer = text(event.payload.answer);
  return answer === '' ? null : { askId: open.askId, question: open.question, answer };
}

/**
 * One `extract` call per answered ask, and nothing on any other event.
 *
 * **No gate on answer length.** "gnomon" is six letters and is the whole answer
 * to "does the sundial branch belong to gnomon?", while "Fine, nothing to keep"
 * is nineteen and holds nothing. Deciding that in a rule means guessing what
 * the model is for; let it return `[]`, which is what it will do most days, and
 * pay two calls a day for the ones where it does not.
 */
export const askHarvest: Rule = (state, event) => {
  const subject = harvestable(state, event);
  if (!subject) return { state, effects: [] };

  // Nothing can be filed under the owner without a name for them, which is the
  // same refusal `dispatchRunConversationExtraction` makes.
  const ownerName = state.config.ownerAliases?.[0];
  if (typeof ownerName !== 'string' || ownerName.trim() === '') return { state, effects: [] };

  return {
    state,
    effects: [
      {
        type: 'ScheduleLLM',
        purpose: 'extract',
        // Not about any one moment — an answer is about whatever the question
        // was. `null` says so, rather than landing an empty string in
        // `llm_audit.momentId` that looks like a foreign key.
        momentId: null,
        delayMs: 0,
        messages: [
          { role: 'system', content: withPersona(askHarvestInstructions(ownerName.trim())) },
          { role: 'user', content: askHarvestPrompt(subject.question, subject.answer) },
        ],
        // The one thing the result has to carry back: which ask this reading
        // belongs beside. `applyLlmResult` keys on it.
        metadata: { askId: subject.askId },
      },
    ],
  };
};

/**
 * The 49 answers that predate the rule, one an hour, ending on its own.
 *
 * `askHarvest` fires forwards. Everything already in `owner_asks` — the tango
 * hint decision, the team roster, the Thomas call, "Jordan De Wit" —
 * would stay unread without this, and those are the answers the whole item was
 * measured on.
 *
 * Shaped after `nightlyRefutation`, which is the other sweep that works through
 * a table a few rows at a time: it rides `clock:tick` rather than
 * `day:boundary`, keeps its own cursor, and paces itself. Two differences, both
 * because this one has an end:
 *
 *  - **No circadian or idle gate.** The refutation pass waits for night because
 *    its failure mode is destructive — it argues a belief down. This one writes
 *    into a column nothing reads but the card, so there is nothing to protect
 *    the owner's afternoon from, and waiting for night would stretch two days
 *    into a fortnight.
 *  - **It stops.** `proposals IS NULL` is the cursor and the executor reports
 *    when there is nothing left; `backfillDone` is then set and no further
 *    sweep is emitted. A switch would be a thing to remember to turn off.
 */
export const askHarvestBackfill: Rule = (state, event) => {
  if (event.type === ASK_HARVEST_DRAINED) {
    if (state.ownerAsk.backfillDone) return { state, effects: [] };
    return { state: { ...state, ownerAsk: { ...state.ownerAsk, backfillDone: true } }, effects: [] };
  }

  if (event.type !== 'clock:tick') return { state, effects: [] };
  if (state.ownerAsk.backfillDone) return { state, effects: [] };

  const last = state.ownerAsk.lastBackfillAt;
  if (last !== null && Date.parse(event.ts) - Date.parse(last) < ASK_BACKFILL_INTERVAL_MS) return { state, effects: [] };

  return {
    state: { ...state, ownerAsk: { ...state.ownerAsk, lastBackfillAt: event.ts } },
    effects: [{ type: 'RunAskHarvestBackfill', ts: event.ts }],
  };
};
