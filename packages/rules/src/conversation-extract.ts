// The nightly pass over the owner's own chat turns — the pure half.
//
// A person tells a friend things no sensor can see: that a project is
// stressful, that Thursday is a partner's birthday, that they prefer to be
// asked before anything is scheduled. Until this pass existed, Gnomon's
// retention policy for all of it was zero unless the owner typed a
// `gnomon_assert` by hand (`architecture/rules/memory-and-knowledge-rules`).
//
// W1 step 7: the owner's turns are the log's own `chat:owner` rows (the chat
// recorder, sanitized at ingest), read by the executor for the effect's window,
// so a replay reads the same rows. One `extract` call reads them, and the typed
// candidates re-enter through the same `entity:fact-candidate` door a sensor
// uses, with `provenance: 'conversation'`.
//
// This file holds everything that can be tested without a database or a
// model: how the transcript is laid out for the model, what the model is
// asked, and how an owner alias is folded onto the `owner` kind.
import type { EntityKind } from '@sundial/kernel/types.js';
import { canonicalOwnerName } from './entity-name-validation.js';
import type { ExtractedFactCandidate } from './nightly-fact-extract.js';
import { MAX_EXTRACTED_FACTS_PER_PASS } from './nightly-fact-extract.js';
import { parseStatedPromise } from './promise-terms.js';

/** One owner-typed turn, as the executor hands it to the pass (a `chat:owner` row). Text is already sanitized. */
export interface ConversationTurn {
  sessionId: string;
  /** ISO instant. */
  at: string;
  text: string;
}

/** Whole-transcript cap per pass, so a chatty day is one bounded call. */
export const MAX_TRANSCRIPT_CHARS = 24_000;
/** Shorter than this and a turn is a "yes" or an "ok" — nothing to extract. */
export const MIN_TURN_CHARS = 12;
/** A model reading one sentence is not the owner typing a claim: cap what it may seed. */
export const MAX_CONVERSATION_CONFIDENCE = 85;

/**
 * The transcript as the model sees it: one line per turn, tagged with the day
 * and the session, oldest first, bounded from the END so the most recent
 * statements survive a cap (a correction made this evening outranks the claim
 * it corrects from this morning).
 */
export function formatTranscript(turns: readonly ConversationTurn[], maxChars = MAX_TRANSCRIPT_CHARS): string {
  const lines = turns.map((turn) => `[${turn.at.slice(0, 16)} · ${turn.sessionId}] ${turn.text.replace(/\s+/g, ' ')}`);
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (total + lines[i].length + 1 > maxChars) break;
    kept.unshift(lines[i]);
    total += lines[i].length + 1;
  }
  return kept.join('\n');
}

/** The instruction half of the `extract` call. `ownerName` is `ownerAliases[0]`. */
export function conversationExtractionInstructions(ownerName: string): string {
  return [
    `These are things ${ownerName}, the owner, TYPED to you in chat over the last day. Nothing here was said by you. Extract only what the owner stated about their own life and world that is worth remembering for weeks: preferences and dislikes, routines and schedules, people and their relation to the owner, places, plans and goals, projects and their state, dates that matter, and instructions about how the owner wants you to behave.`,
    `Do NOT extract: questions the owner asked, one-off requests ("show me yesterday"), anything about the current screen, anything you inferred rather than the owner stated, or anything that was true only for that hour.`,
    `Use entityKind "owner" with canonicalName "${ownerName}" for facts about the owner themselves. Use "goal" for something the owner wants to achieve (canonicalName = the goal in a few of their words; predicates status = open|paused|done|dropped, targetDate, why). Use "person" for other people (by the name the owner used — and when the owner names someone the record knows only as "person-<hash>", emit knownAs on that alias), "project" for projects, "tool" for software, "topic" for anything else. Never make the owner a "person".`,
    `Prefer these predicates when they fit: prefers, dislikes, wakeAt, asleepBy, dayBeginsAt, dayEndsAt, workSchedule, occupation, livesIn, worksWith, relationship, birthday, goal, plansTo, instructs, worksOn, usesTool, relatesToProject. A profile attribute (wake time, occupation, where they live) holds ONE value — state the newest the owner gave.`,
    `"confidence" is a prior a later contradiction has to overcome. Above 80 only when the owner stated it plainly and unconditionally. 50-70 when it is a fair reading of what they said. Below 50, leave it out. Never above ${MAX_CONVERSATION_CONFIDENCE}.`,
    `Respond with STRICT JSON only, no markdown fencing: a JSON array of up to ${MAX_EXTRACTED_FACTS_PER_PASS} objects, each exactly {"entityKind": "owner"|"goal"|"person"|"project"|"tool"|"topic", "canonicalName": "...", "predicate": "...", "object": "...", "confidence": 1-${MAX_CONVERSATION_CONFIDENCE}}. Respond with [] when nothing qualifies — most days, nothing does.`,
  ].join(' ');
}

/**
 * Fold a candidate onto the owner entity when it names the owner under any
 * alias or any kind, cap its confidence, and drop it when it claims to be the
 * owner but is not. Returns null for a candidate to discard.
 */
export function canonicalizeConversationCandidate(candidate: ExtractedFactCandidate, ownerAliases: readonly string[]): (ExtractedFactCandidate & { entityKind: EntityKind }) | null {
  const confidence = Math.min(candidate.confidence, MAX_CONVERSATION_CONFIDENCE);
  const ownerName = canonicalOwnerName(candidate.canonicalName, [...ownerAliases]);
  if (candidate.entityKind === 'owner') {
    // "owner" named as somebody else is a misread of who is talking.
    return ownerName === null ? null : { ...candidate, canonicalName: ownerName, entityKind: 'owner', confidence };
  }
  if (ownerName !== null && (candidate.entityKind === 'person' || candidate.entityKind === 'topic')) {
    return { ...candidate, canonicalName: ownerName, entityKind: 'owner', confidence };
  }
  return { ...candidate, confidence };
}

/**
 * UC1 (U1-F11) — promises the owner told Gnomon about in passing, read from
 * the same turns the nightly pass reads, without a model: only a sentence that
 * says it outright ("I owe Mira the draft", "I promised Bob I'd…", "I told
 * Mira I'd…", "ik heb Mira beloofd…") and names the person. "I'll look at it",
 * said to Gnomon, is a request to an assistant, not a promise to a person, and
 * is left alone. `gnomon_track_promise` is the live path; this catches what
 * the model did not track.
 */
const OWED = /\b(i owe|i promised|i told \p{Lu}[\p{L}'-]+ (?:i'?d|i would|that i)|ik heb \p{Lu}[\p{L}'-]+ beloofd|beloofd aan)\b/iu;

export function promisesInTurns(turns: readonly ConversationTurn[], timeZone: string): { turn: ConversationTurn; sentence: string; counterparty: string; deliverable: string; dueText: string | null }[] {
  const out: { turn: ConversationTurn; sentence: string; counterparty: string; deliverable: string; dueText: string | null }[] = [];
  for (const turn of turns) {
    for (const sentence of turn.text.split(/(?<=[.!?])\s+|\n+/)) {
      if (!OWED.test(sentence)) continue;
      const stated = parseStatedPromise(sentence, { ts: turn.at, tz: timeZone });
      if (!stated?.counterparty || stated.deliverable === '') continue;
      out.push({ turn, sentence: sentence.trim().slice(0, 160), counterparty: stated.counterparty, deliverable: stated.deliverable, dueText: stated.dueText });
    }
  }
  return out;
}
