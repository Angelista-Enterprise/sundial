// The ambient memory slice: what the model should know about the owner before
// the owner has said anything.
//
// Context FOR A QUESTION is the tools' job — they embed the query, run
// `scoredSearch`, and pull the facts of entities the question names (the old
// `buildContext` in context.ts did that for the retired `/ask`, and was deleted
// once nothing called it). The dsh harness has no question at assembly time: a system-prompt
// context is resolved before the turn, for a greeting as much as for a hard
// question. Until this existed the harness registered exactly one context, the
// clock, so every turn started from a model that knew the date and nothing
// about the person it was talking to (almanac/architecture/llm/tool-loop).
//
// This is the question-independent half of that old context's four layers, plus
// the live slices the kernel already holds and never told the model about:
//
//   1. facts about the owner — every current fact on an entity whose name is
//      one of `config.ownerAliases`, newest per predicate;
//   2. today so far — the same orientation line `/ask` always had;
//   3. open commitments, open wake-ups, the open owner question, Gnomon's own
//      open research goal — all straight off `KernelState`;
//   4. what was noticed recently — the last few `knowledge_entries`;
//   5. the assistant's own track record, under the same ten-resolution floor
//      the tools' track-record readout uses.
//
// `scoredSearch` is deliberately NOT here. Retrieval needs a query; the tools
// carry that half. Routines are not here either (almanac/concepts/memory-tiers):
// at the precision `routine.next` measures they are candidates a person weighs, not
// context a model asserts from. `gnomon_routines` states its precision; a prompt line cannot.
//
// Split in two so the composition is testable without a database:
// `gatherAmbientInput` does the reads, `composeAmbientContext` is pure.
import { readSituation } from './read/situation.js';
import {
  findEntitiesByName,
  getAllEntities,
  getCurrentEntityFacts,
  getKnowledgeEntriesSince,
  getMomentsForDate,
} from '@sundial/db/index.js';
import { formatClock, localDate } from '@sundial/helpers/local-day.js';
import { openAsk, wakeupsOf } from '@sundial/helpers/loops.js';
import type { KernelState } from './types.js';
import { promisePhrase } from './promise-words.js';

/** Owner facts shown at most — the newest per predicate, then the newest overall. */
export const MAX_OWNER_FACTS = 15;
export const MAX_COMMITMENTS = 5;
export const MAX_WAKEUPS = 3;
export const MAX_RECENT_KNOWLEDGE = 3;
/** How far back "recently noticed" reaches. */
export const RECENT_KNOWLEDGE_MS = 48 * 60 * 60 * 1000;
/** Ten resolutions: a rate over fewer is noise wearing a percentage. */
const MIN_RESOLVED_FOR_RATE = 10;

export interface AmbientOwnerFact {
  predicate: string;
  object: string;
  provenance: string;
  validFrom: string;
}

export interface AmbientInput {
  /** ISO instant the slice describes. */
  now: string;
  ownerFacts: AmbientOwnerFact[];
  /** The owner's goals (entities of kind `goal`) with their current facts; closed ones filtered out. */
  goals: { name: string; facts: { predicate: string; object: string }[] }[];
  today: { sessions: number; minutes: number; activeMinutes?: number; mostRecentProcess: string; topProjects?: { name: string; minutes: number }[] } | null;
  commitments: { name: string; projectName: string | null; activeDays: number; lastTouchedAt: string }[];
  /** UC1: open promises, in the owner's words, with when they are due — `due` already on the owner's clock (`dueClock`). */
  promises?: { line: string; due: string | null; confirmed: boolean }[];
  /** The zone the promise due times are written in; named once over the list. */
  timeZone?: string;
  wakeups: { at: string; reason: string }[];
  ownerAsk: { question: string; askId?: string } | null;
  /** Gnomon's own open research question, if one is open. */
  researchGoal: { question: string } | null;
  recentKnowledge: { kind: string; title: string }[];
  assistant: { acceptedCount: number; rejectedCount: number } | null;
  /** S2: the moment of the day and the one question it answers, from the same `buildSituation` the screen draws. */
  moment?: { phase: string; question: string; next: string | null } | null;
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : 0;
}

function provenanceNote(provenance: string): string {
  if (provenance === 'assertion') return 'the owner said so';
  if (provenance === 'conversation') return 'from a conversation';
  return 'inferred';
}

/** A fact whose object names a day this many days back is flagged, not hidden. */
export const STALE_DATED_FACT_DAYS = 7;

/**
 * "stayingAt: Elite Hotel, Stockholm (2026-08-18)" is true of a day, not of the
 * owner, and it was still the newest current fact three weeks later. A read
 * path cannot retire it — that is the lifecycle policy's job — but it can stop
 * a model from greeting the owner in a hotel they left. The oldest day named
 * in the object decides, so a range keeps the flag when its start is old.
 */
export function staleDatedNote(object: string, nowIso: string): string | null {
  const days = object.match(/\b(20\d{2}-\d{2}-\d{2})\b/g);
  if (!days) return null;
  const oldest = days.slice().sort()[0];
  const age = daysBetween(`${oldest}T00:00:00Z`, nowIso);
  return age >= STALE_DATED_FACT_DAYS ? `dated ${oldest}, ${age} days ago — probably no longer true` : null;
}

/**
 * Newest fact per predicate, newest first overall, capped.
 *
 * A predicate the owner corrected ("day begins ~08:00, the earlier ~20:00 was
 * wrong") can carry two current rows when cardinality was not enforced at
 * write time. This is a read path, so it trims rather than repairs: the model
 * gets the latest word, and the duplicate stays in the table for
 * `predicateCardinality` to deal with.
 */
export function selectOwnerFacts(facts: AmbientOwnerFact[], max = MAX_OWNER_FACTS): AmbientOwnerFact[] {
  const newestByPredicate = new Map<string, AmbientOwnerFact>();
  for (const fact of facts) {
    const seen = newestByPredicate.get(fact.predicate);
    if (!seen || fact.validFrom > seen.validFrom) newestByPredicate.set(fact.predicate, fact);
  }
  return Array.from(newestByPredicate.values())
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0))
    .slice(0, max);
}

/** The prompt text. Empty string when there is nothing to say, which dsh treats as "contributes nothing". */
/** A UTC due instant as the owner reads it: "2026-10-01 09:30" in Europe/Amsterdam for 07:30Z. */
export function dueClock(dueIso: string, timeZone: string): string {
  return `${localDate(dueIso, timeZone)} ${formatClock(dueIso, timeZone)}`;
}

export function composeAmbientContext(input: AmbientInput): string {
  const blocks: string[] = [];

  // One line, first: which moment of the day it is and what the owner is most
  // likely to want from it. The screen leads with the same question.
  if (input.moment) blocks.push(`Right now it is ${input.moment.phase.replace(/-/g, ' ')} — the question of this moment is "${input.moment.question}"${input.moment.next ? `; next: ${input.moment.next}` : ''}. Answer it first when the owner's message leaves room.`);

  const facts = selectOwnerFacts(input.ownerFacts);
  if (facts.length > 0) {
    blocks.push(
      [
        'What you know about the owner (current beliefs; a fact the owner stated outranks one you inferred):',
        ...facts.map((fact) => {
          const stale = staleDatedNote(fact.object, input.now);
          return `- ${fact.predicate}: ${fact.object} (${provenanceNote(fact.provenance)}${stale ? `; ${stale}` : ''})`;
        }),
      ].join('\n'),
    );
  }

  if (input.goals.length > 0) {
    blocks.push(
      [
        "The owner's goals (their words; status is theirs to change, ask before assuming):",
        ...input.goals.map((goal) => `- ${goal.name}${goal.facts.length > 0 ? `: ${goal.facts.map((fact) => `${fact.predicate} ${fact.object}`).join(', ')}` : ''}`),
      ].join('\n'),
    );
  }

  if (input.today && input.today.sessions > 0) {
    blocks.push(
      // Presence is not attention: the open-window minutes and the minutes with
      // real input are both said, so "a long day" and "a busy day" stay distinct.
      `Today so far: ${input.today.sessions} activity session(s), about ${input.today.minutes}m tracked${typeof input.today.activeMinutes === 'number' && input.today.activeMinutes > 0 ? ` (${input.today.activeMinutes}m with hands on keyboard or mouse)` : ''}, most recently in ${input.today.mostRecentProcess}.${input.today.topProjects && input.today.topProjects.length > 0 ? ` Mostly on ${input.today.topProjects.map((p) => `${p.name} (${p.minutes}m)`).join(', ')}.` : ''}`,
    );
  }

  const promises = (input.promises ?? []).slice(0, MAX_COMMITMENTS);
  if (promises.length > 0) {
    blocks.push(
      [
        // Due times on the owner's clock, zone named once. They were written as UTC until 2026-10-02: the model
        // repeated "due 07:30 UTC" for a 09:30 standup, and an answer with a time nobody keeps is a wrong answer.
        `Open promises (${input.promises!.length}; times in ${input.timeZone ?? 'UTC'}; closed by themselves when the mail, commit or file shows up — gnomon_open_commitments has the terms):`,
        ...promises.map((p) => `- ${p.line}${p.due ? `, due ${p.due}` : ''}${p.confirmed ? '' : ' (heard, not confirmed)'}`),
      ].join('\n'),
    );
  }

  const commitments = [...input.commitments]
    .sort((a, b) => (a.lastTouchedAt < b.lastTouchedAt ? 1 : a.lastTouchedAt > b.lastTouchedAt ? -1 : 0))
    .slice(0, MAX_COMMITMENTS);
  if (commitments.length > 0) {
    blocks.push(
      [
        `Open threads of work (${input.commitments.length} open; the most recently touched):`,
        ...commitments.map((commitment) => {
          const where = commitment.projectName ? ` in ${commitment.projectName}` : '';
          const quiet = daysBetween(commitment.lastTouchedAt, input.now);
          const last = quiet === 0 ? 'touched today' : `last touched ${quiet} day${quiet === 1 ? '' : 's'} ago`;
          return `- ${commitment.name}${where}: ${commitment.activeDays} active day${commitment.activeDays === 1 ? '' : 's'}, ${last}`;
        }),
      ].join('\n'),
    );
  }

  const wakeups = [...input.wakeups].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, MAX_WAKEUPS);
  if (wakeups.length > 0) {
    blocks.push(['Wake-ups you have set:', ...wakeups.map((wakeup) => `- ${wakeup.at}: ${wakeup.reason}`)].join('\n'));
  }

  if (input.ownerAsk) {
    // The id travels with the question. Without it the model could only recover
    // the id by asking again, which is exactly what it did once.
    const id = input.ownerAsk.askId ? ` (askId ${input.ownerAsk.askId})` : '';
    blocks.push(`You are waiting on the owner's answer to: "${input.ownerAsk.question}"${id}. Do not ask it again; if they answer in passing, record it with gnomon_owner_answer and that askId.`);
  }

  if (input.researchGoal) {
    blocks.push(`Your own open research question about your forecasts: ${input.researchGoal.question}`);
  }

  // The same title can land twice on consecutive days (a reflection that saw the
  // same shape twice); the model needs to hear it once.
  const seenTitles = new Set<string>();
  const recent = input.recentKnowledge.filter((entry) => (seenTitles.has(entry.title) ? false : (seenTitles.add(entry.title), true))).slice(0, MAX_RECENT_KNOWLEDGE);
  if (recent.length > 0) {
    blocks.push(['Recently noticed (your own reflections; check before repeating):', ...recent.map((entry) => `- [${entry.kind}] ${entry.title}`)].join('\n'));
  }

  if (input.assistant) {
    const resolved = input.assistant.acceptedCount + input.assistant.rejectedCount;
    if (resolved >= MIN_RESOLVED_FOR_RATE) {
      const rate = Math.round((100 * input.assistant.acceptedCount) / resolved);
      blocks.push(`Your track record with this owner: ${input.assistant.acceptedCount} of ${resolved} proposals accepted (${rate}%). Weigh your confidence accordingly.`);
    }
  }

  if (blocks.length === 0) return '';
  return [
    'Standing context from your memory. Use it; do not recite it back, and do not call a tool for something already stated here.',
    ...blocks,
  ].join('\n\n');
}

export interface GatherAmbientOptions {
  state: KernelState | null | undefined;
  /** ISO instant; defaults to the real clock. */
  now?: string;
}

/**
 * The reads. Every owner alias is one `LIKE` scan, so the alias list is kept
 * exact-match after the scan: `pat` must not pull `Pat's PR reviews` in.
 */
/** Minutes per project for the day's moments, biggest first, three at most, named through the kernel's project registry. */
function topProjectsOf(moments: readonly { projectId: string | null; durationMs: number }[], state: KernelState | null): { name: string; minutes: number }[] {
  const minutes = new Map<string, number>();
  for (const moment of moments) {
    if (!moment.projectId) continue;
    minutes.set(moment.projectId, (minutes.get(moment.projectId) ?? 0) + moment.durationMs / 60_000);
  }
  return [...minutes.entries()]
    .map(([id, m]) => ({ name: state?.project.known[id]?.name ?? id, minutes: Math.round(m) }))
    .filter((p) => p.minutes >= 5)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 3);
}

export async function gatherAmbientInput(options: GatherAmbientOptions): Promise<AmbientInput> {
  const now = options.now ?? new Date().toISOString();
  const state = options.state ?? null;

  const ownerFacts: AmbientOwnerFact[] = [];
  const aliases = (state?.config.ownerAliases ?? []).map((alias: string) => alias.trim()).filter((alias: string) => alias.length > 0);
  const seenEntityIds = new Set<string>();
  for (const alias of aliases) {
    const matches = await findEntitiesByName(alias);
    for (const entity of matches) {
      if (entity.canonicalName.toLowerCase() !== alias.toLowerCase()) continue;
      if (seenEntityIds.has(entity.id)) continue;
      seenEntityIds.add(entity.id);
      const facts = await getCurrentEntityFacts(entity.id);
      for (const fact of facts) {
        ownerFacts.push({ predicate: fact.predicate, object: fact.object, provenance: fact.provenance, validFrom: fact.validFrom });
      }
    }
  }

  const CLOSED = new Set(['done', 'dropped', 'abandoned', 'cancelled', 'canceled', 'completed', 'achieved']);
  const goals: AmbientInput['goals'] = [];
  for (const entity of await getAllEntities()) {
    if (entity.kind !== 'goal') continue;
    const facts = await getCurrentEntityFacts(entity.id);
    const status = facts.find((fact) => fact.predicate === 'status');
    if (status && CLOSED.has(status.object.trim().toLowerCase())) continue;
    goals.push({ name: entity.canonicalName, facts: facts.map((fact) => ({ predicate: fact.predicate, object: fact.object })) });
  }

  const timeZone = state?.config.timezone ?? 'UTC';
  const todaysMoments = await getMomentsForDate(localDate(now, timeZone), timeZone);
  const today =
    todaysMoments.length > 0
      ? {
          sessions: todaysMoments.length,
          minutes: Math.round(todaysMoments.reduce((sum, moment) => sum + moment.durationMs, 0) / 60_000),
          activeMinutes: Math.round(todaysMoments.reduce((sum, moment) => sum + (typeof moment.data.activeMs === 'number' ? moment.data.activeMs : 0), 0) / 60_000),
          mostRecentProcess: todaysMoments[todaysMoments.length - 1].processName,
          // The day's shape in one clause, so "what am I doing today" needs no tool call.
          topProjects: topProjectsOf(todaysMoments, state),
        }
      : null;

  const since = new Date(Date.parse(now) - RECENT_KNOWLEDGE_MS).toISOString();
  const recentKnowledge = (await getKnowledgeEntriesSince(since))
    .filter((entry) => entry.retractedAt === null)
    .map((entry) => ({ kind: entry.kind, title: entry.title }));

  const openGoal = state?.mind.goals.find((goal) => goal.closedAt === null) ?? null;
  // The same present the screen draws (`read/situation.ts`).
  const sit = state ? await readSituation({ state, now: Date.parse(now) }) : null;

  return {
    now,
    ownerFacts,
    goals,
    today,
    promises: (state?.commitments.promises ?? []).map((c) => {
      const p = c.promise;
      const who = p?.counterparty ? (state?.memory.aliasNames?.[p.counterparty] ?? p.counterparty) : null;
      const named = who && !/^person-[0-9a-f]{10}$/.test(who) ? who : null;
      const line = p ? promisePhrase(p.direction, p.deliverable, named) : c.name;
      return { line, due: p?.due ? dueClock(p.due, timeZone) : null, confirmed: p?.confirmed === true };
    }),
    timeZone,
    commitments: (state?.commitments.open ?? []).map((commitment) => ({
      name: commitment.name,
      projectName: commitment.projectName,
      activeDays: commitment.activeDays.length,
      lastTouchedAt: commitment.lastTouchedAt,
    })),
    wakeups: wakeupsOf(state).map((wakeup) => ({ at: wakeup.at, reason: wakeup.reason })),
    ownerAsk: openAsk(state) ? { question: openAsk(state)!.question, askId: openAsk(state)!.askId } : null,
    researchGoal: openGoal ? { question: openGoal.question } : null,
    moment: sit ? { phase: sit.phase, question: sit.question, next: sit.next && sit.next.startsInMin <= 90 ? `${sit.next.title} in ${sit.next.startsInMin} min` : null } : null,
    recentKnowledge,
    assistant: state ? { acceptedCount: state.assistant.acceptedCount, rejectedCount: state.assistant.rejectedCount } : null,
  };
}
