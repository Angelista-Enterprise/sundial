// The nightly pass over the owner's own chat turns — the pure half.
//
// A person tells a friend things no sensor can see: that a project is
// stressful, that Thursday is a partner's birthday, that they prefer to be
// asked before anything is scheduled. Until this pass existed, Gnomon's
// retention policy for all of it was zero unless the owner typed a
// `gnomon_assert` by hand (`enhancements/conversation-memory`).
//
// The invariant this keeps: the transcript never enters the signal log. dsh's
// session store is read by the executor, the OWNER's turns (never the model's)
// are redacted with the same policy every sensor gets, one `extract` call reads
// them, and only the typed, sanitized candidates re-enter — through the same
// `entity:fact-candidate` door a sensor uses, with `provenance: 'conversation'`.
//
// This file holds everything that can be tested without a session store or a
// model: which turns count, how the transcript is laid out for the model, what
// the model is asked, and how an owner alias is folded onto the `owner` kind.
import type { EntityKind } from '@sundial/kernel/types.js';
import { canonicalOwnerName } from './entity-name-validation.js';
import type { ExtractedFactCandidate } from './nightly-fact-extract.js';
import { MAX_EXTRACTED_FACTS_PER_PASS } from './nightly-fact-extract.js';

/** One owner-typed turn, as the executor hands it to the pass. Text is already redacted. */
export interface ConversationTurn {
  sessionId: string;
  /** ISO instant. */
  at: string;
  text: string;
}

/** The narrowest thing the executor needs from the dsh session store. */
export interface ConversationSource {
  /** Owner-typed turns at or after `sinceIso`, oldest first. Empty when there are none. */
  readOwnerTurnsSince(sinceIso: string): Promise<ConversationTurn[]>;
}

/** Longest single turn kept; a pasted log is not a statement about the owner. */
export const MAX_TURN_CHARS = 1_200;
/** Whole-transcript cap per pass, so a chatty day is one bounded call. */
export const MAX_TRANSCRIPT_CHARS = 24_000;
/** Shorter than this and a turn is a "yes" or an "ok" — nothing to extract. */
export const MIN_TURN_CHARS = 12;
/** A model reading one sentence is not the owner typing a claim: cap what it may seed. */
export const MAX_CONVERSATION_CONFIDENCE = 85;

/**
 * The shape of a raw dsh session event this pass cares about, kept structural
 * so `@sundial/rules` does not depend on dsh's packages. `time` is epoch ms;
 * `source.kind` tells an owner turn from injected context (a notice, the Ask
 * layer's place caption) — the same test the web client uses to decide whose
 * words to draw as the owner's.
 */
export interface RawSessionEvent {
  type: string;
  time: number;
  data?: {
    source?: { kind?: string };
    content?: unknown;
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('');
}

function isOwnerTurn(event: RawSessionEvent): boolean {
  if (event.type !== 'user/message') return false;
  const kind = event.data?.source?.kind;
  return kind === undefined || kind === 'user' || kind === 'human';
}

/**
 * The owner's turns from one session's raw log, at or after `sinceMs` and
 * before `untilMs`, in log order. Injected context blocks are dropped; so are
 * one-word turns and anything longer than `MAX_TURN_CHARS` (truncated, not
 * dropped — the first sentence of a long paste is usually the owner's own).
 */
export function selectOwnerTurns(sessionId: string, events: readonly RawSessionEvent[], sinceMs: number, untilMs: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const event of events) {
    if (!isOwnerTurn(event)) continue;
    if (!Number.isFinite(event.time) || event.time < sinceMs || event.time >= untilMs) continue;
    const text = textOf(event.data?.content).trim();
    if (text.length < MIN_TURN_CHARS) continue;
    turns.push({ sessionId, at: new Date(event.time).toISOString(), text: text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}…` : text });
  }
  return turns;
}

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
