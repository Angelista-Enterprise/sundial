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
import { parseStatedPromise } from './promise-terms.js';

/** One owner-typed turn, as the executor hands it to the pass (a `chat:owner` row). Text is already sanitized. */
export interface ConversationTurn {
  sessionId: string;
  /** ISO instant. */
  at: string;
  text: string;
  /** Who said it: the owner (a `chat:owner` row, the default) or Gnomon (a `chat:said` row, read when `memory.extractReplies` is on). */
  by?: 'owner' | 'gnomon';
}

/** Whole-transcript cap per pass, so a chatty day is one bounded call. */
export const MAX_TRANSCRIPT_CHARS = 24_000;
/** Shorter than this and a turn is a "yes" or an "ok" — nothing to extract. */
export const MIN_TURN_CHARS = 12;
/** A model reading one sentence is not the owner typing a claim: cap what it may seed. */
export const MAX_CONVERSATION_CONFIDENCE = 85;
/**
 * Facts one conversation call may file. The moment pass keeps its 10; a chat
 * chunk of 24,000 characters holds far more than ten things the owner said
 * about their life, and LongMemEval's first run (2026-11-17) hit the old cap
 * on 414 of 1,147 days, dropping the rest unseen.
 */
export const MAX_CONVERSATION_FACTS = 40;

const lineOf = (turn: ConversationTurn): string => `[${turn.at.slice(0, 16)} · ${turn.sessionId}] ${turn.by === 'gnomon' ? '(Gnomon) ' : ''}${turn.text.replace(/\s+/g, ' ')}`;

/** One extract call's share of a window: its transcript and the days its lines come from. */
export interface TranscriptChunk {
  text: string;
  /** YYYY-MM-DD of every line, in order, deduplicated. */
  days: string[];
  /** The first line's instant on each day, so a fact dated to a day gets a real instant. */
  firstAtByDay: Record<string, string>;
  lastAt: string;
}

/**
 * The whole window as chunks of at most `maxChars`, oldest first, every turn
 * kept. `formatTranscript` keeps only a window's tail; on a day of 240 turns
 * (LongMemEval's one-day haystacks) that read the last tenth and dropped the
 * evidence of 13 of the first run's 35 misses before any model saw it. A line
 * longer than a chunk is cut to fit.
 */
export function transcriptChunks(turns: readonly ConversationTurn[], maxChars = MAX_TRANSCRIPT_CHARS): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let lines: string[] = [];
  let used: ConversationTurn[] = [];
  let total = 0;
  const close = () => {
    if (lines.length === 0) return;
    const firstAtByDay: Record<string, string> = {};
    for (const t of used) firstAtByDay[t.at.slice(0, 10)] ??= t.at;
    chunks.push({ text: lines.join('\n'), days: Object.keys(firstAtByDay), firstAtByDay, lastAt: used[used.length - 1].at });
    lines = [];
    used = [];
    total = 0;
  };
  for (const turn of turns) {
    const line = lineOf(turn).slice(0, maxChars);
    if (total + line.length + 1 > maxChars) close();
    lines.push(line);
    used.push(turn);
    total += line.length + 1;
  }
  close();
  return chunks;
}

/** The instant a fact the model dated `at` (YYYY-MM-DD) is filed at: that day's first line in the chunk, or the chunk's last line when the day is not one of its own. */
export function factInstant(chunk: TranscriptChunk, at: string | undefined): string {
  return (at !== undefined && chunk.firstAtByDay[at]) || chunk.lastAt;
}

/**
 * The transcript as the model sees it: one line per turn, tagged with the day
 * and the session, oldest first, bounded from the END so the most recent
 * statements survive a cap (a correction made this evening outranks the claim
 * it corrects from this morning).
 */
export function formatTranscript(turns: readonly ConversationTurn[], maxChars = MAX_TRANSCRIPT_CHARS): string {
  const lines = turns.map(lineOf);
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
    `These are chat lines between ${ownerName}, the owner, and you, each tagged with its date and session. A line marked "(Gnomon)" is something you said; every other line the owner TYPED.`,
    `Extract what the owner stated about their own life and world: preferences and dislikes, routines and schedules, people and their relation to the owner, places, plans and goals, projects and their state, dates that matter, instructions about how the owner wants you to behave, AND the concrete details they may ask you about later: what they did, bought, own, attended, visited, made, tried or decided, with whom, where, how many, how much, how long and when. A past event is worth keeping with its date.`,
    `From your own "(Gnomon)" lines keep only a specific the owner may ask back (a name, a place, a title, a number, a recommendation you gave): entityKind "topic", predicate "gnomonSaid".`,
    `Do NOT extract: questions the owner asked, one-off requests ("show me yesterday"), anything about the current screen, general knowledge that is not about the owner, or anything you inferred rather than the owner stated.`,
    `Use entityKind "owner" with canonicalName "${ownerName}" for facts about the owner themselves. Use "goal" for something the owner wants to achieve (canonicalName = the goal in a few of their words; predicates status = open|paused|done|dropped, targetDate, why). Use "person" for other people (by the name the owner used; when the owner names someone the record knows only as "person-<hash>", emit knownAs on that alias), "project" only for a code repository or work project, "tool" for software, "topic" for anything else. Never make the owner a "person".`,
    `Prefer these predicates when they fit: prefers, dislikes, wakeAt, asleepBy, dayBeginsAt, dayEndsAt, workSchedule, occupation, livesIn, worksWith, relationship, birthday, goal, plansTo, did, bought, owns, attended, visited, instructs, worksOn, usesTool, relatesToProject. A profile attribute (wake time, occupation, where they live) holds ONE value: state the newest the owner gave. Keep the object specific and self-contained, with the names, numbers and units the owner used ("a 55-inch Samsung TV for the living room"). When a count, an amount or a state changed, say the new value and that it is new ("now 25 titles on the to-watch list, up from 20").`,
    `"confidence" is a prior a later contradiction has to overcome. Above 80 only when the owner stated it plainly and unconditionally. 50-70 when it is a fair reading of what they said. Below 50, leave it out. Never above ${MAX_CONVERSATION_CONFIDENCE}.`,
    `"at" is the date (YYYY-MM-DD) of the line the fact comes from.`,
    `Respond with STRICT JSON only, no markdown fencing: a JSON array of up to ${MAX_CONVERSATION_FACTS} objects, each exactly {"entityKind": "owner"|"goal"|"person"|"project"|"tool"|"topic", "canonicalName": "...", "predicate": "...", "object": "...", "confidence": 1-${MAX_CONVERSATION_CONFIDENCE}, "at": "YYYY-MM-DD"}. Respond with [] when nothing qualifies.`,
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
