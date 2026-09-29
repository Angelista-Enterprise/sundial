/**
 * Memory that proves itself (use case 7): a belief that makes a testable
 * prediction is scored against what the owner then did, day by day, and the
 * record rides on the fact — "right 12 of 13".
 *
 * Pure. `factTestTrack` (packages/rules) folds the day's observations and calls
 * `resolveFactDay` when a waking day ends. The record never touches the fact's
 * object or validity window; after `MIN_TESTS_FOR_BELIEF` outcomes each new one
 * moves the Beta posterior by one (a hit on `alpha`, a miss on `beta`). Before
 * that, the record only gathers.
 *
 * What is testable today, and what each predicts for one waking day:
 *
 * - `project usesTool T` — on a day the project was worked on (at least
 *   `MIN_SEEN_PER_DAY` closed moments), T was one of its apps.
 * - `task relatesToProject P` — on a day the task's branch was worked on, it
 *   was worked on inside P.
 * - `owner dayBeginsAt HH:MM` — on a working weekday, the first real input was
 *   within `CLOCK_TOLERANCE_MIN` of HH:MM.
 * - `owner asleepBy HH:MM` — on a working day, the last real input was no more
 *   than `CLOCK_TOLERANCE_MIN` after HH:MM.
 *
 * A fact is tested only on days after the one it was first seen on, so the
 * observations that promoted it never count as its own successes.
 */
import type { DriftDay } from './drift.js';
import { ACTIVE_DAY_EMITS, weekdayOf } from './drift.js';

export const TESTED_PREDICATES = {
  usesTool: 'set',
  relatesToProject: 'set',
  dayBeginsAt: 'clock',
  asleepBy: 'clock',
} as const;
export type TestedPredicate = keyof typeof TESTED_PREDICATES;

/** Outcomes before any of them moves the belief. A default, like the gate's n ≥ 20. */
export const MIN_TESTS_FOR_BELIEF = 20;
/** Closed moments of an entity before its day counts as a test. */
export const MIN_SEEN_PER_DAY = 3;
export const CLOCK_TOLERANCE_MIN = 60;
export const MAX_FACT_RECORDS = 600;
const MAX_SEEN_ENTITIES = 200;
const MAX_SEEN_OBJECTS = 32;

export interface FactRecord {
  entityId: string;
  predicate: TestedPredicate;
  object: string;
  /** The waking day the record started; tested from this day on. */
  since: string;
  right: number;
  wrong: number;
  lastDay: string | null;
}

export interface FactTestsState {
  /** The waking day being collected. */
  day: string | null;
  /** `${entityId}|${predicate}` → how many observations today, and which objects. */
  seen: Record<string, { n: number; objects: string[] }>;
  /** Keyed by fact id. */
  records: Record<string, FactRecord>;
}

export const EMPTY_FACT_TESTS: FactTestsState = { day: null, seen: {}, records: {} };

export interface TestableFact {
  factId: string;
  entityId: string;
  predicate: TestedPredicate;
  object: string;
}

type CursorEntry = { object: string | null; factId: string | null };

/**
 * The confirmed facts with a tested predicate, read off `memory.factCursor`.
 *
 * The cursor key is `${entityId}:${predicate}` for a single-valued predicate and
 * `${entityId}:${predicate}:${object}` for a set-valued one. Entity ids and
 * objects may hold colons themselves, so the key is matched from the right with
 * the entry's own object rather than split.
 */
export function testableFacts(factCursor: Record<string, CursorEntry>): TestableFact[] {
  const out: TestableFact[] = [];
  for (const [key, entry] of Object.entries(factCursor)) {
    if (!entry.factId || entry.object === null) continue;
    for (const [predicate, shape] of Object.entries(TESTED_PREDICATES) as [TestedPredicate, string][]) {
      const suffix = shape === 'set' ? `:${predicate}:${entry.object}` : `:${predicate}`;
      if (!key.endsWith(suffix) || key.length === suffix.length) continue;
      const entityId = key.slice(0, -suffix.length);
      if (shape === 'clock' && (!entityId.startsWith('owner:') || leadingClock(entry.object) === null)) continue;
      out.push({ factId: entry.factId, entityId, predicate, object: entry.object });
    }
  }
  return out;
}

/** "~08:00 (opens laptop at 8am)" → 08:00 as a waking minute (0 is 04:00). Only a LEADING clock counts; "no fixed bedtime … ~22:00" has none. */
export function leadingClock(object: string): number | null {
  const m = /^\s*~?\s*(\d{1,2})[:.](\d{2})\b/.exec(object);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return (((h * 60 + min - 4 * 60) % 1440) + 1440) % 1440;
}

/** Fold one observation of an entity into today's `seen`. */
export function noteSeen(tests: FactTestsState, entityId: string, predicate: string, object: string): FactTestsState {
  const key = `${entityId}|${predicate}`;
  const prior = tests.seen[key];
  const objects = prior?.objects.includes(object) ? prior.objects : [...(prior?.objects ?? []), object].slice(-MAX_SEEN_OBJECTS);
  const seen = { ...tests.seen, [key]: { n: (prior?.n ?? 0) + 1, objects } };
  const keys = Object.keys(seen);
  if (keys.length > MAX_SEEN_ENTITIES) delete seen[keys[0]!];
  return { ...tests, seen };
}

/** Whether a fact's prediction held on `day`, or `null` when the day is no test of it. */
export function judge(fact: TestableFact, day: string, seen: FactTestsState['seen'], driftDay: DriftDay | undefined): boolean | null {
  if (TESTED_PREDICATES[fact.predicate] === 'set') {
    const s = seen[`${fact.entityId}|${fact.predicate}`];
    if (!s || s.n < MIN_SEEN_PER_DAY) return null;
    return s.objects.includes(fact.object);
  }
  const stated = leadingClock(fact.object);
  if (stated === null || !driftDay || driftDay.active < ACTIVE_DAY_EMITS) return null;
  if (fact.predicate === 'dayBeginsAt') {
    const wd = weekdayOf(day);
    if (wd === 0 || wd === 6 || driftDay.first === null) return null;
    return Math.abs(driftDay.first - stated) <= CLOCK_TOLERANCE_MIN;
  }
  if (driftDay.last === null) return null;
  return driftDay.last <= stated + CLOCK_TOLERANCE_MIN;
}

export interface FactOutcome {
  factId: string;
  predicate: TestedPredicate;
  right: boolean;
  /** Outcomes the record held before this one. */
  priorN: number;
}

/**
 * Close a waking day: score every fact that existed through it, start a record
 * for every fact seen for the first time (tested from `nextDay`), and drop the
 * records of facts that are no longer believed.
 */
export function resolveFactDay(tests: FactTestsState, facts: TestableFact[], driftDay: DriftDay | undefined, nextDay: string): { tests: FactTestsState; outcomes: FactOutcome[] } {
  const day = tests.day;
  const records: Record<string, FactRecord> = {};
  const outcomes: FactOutcome[] = [];
  for (const fact of facts) {
    const prior = tests.records[fact.factId];
    if (!prior || day === null) {
      records[fact.factId] = { entityId: fact.entityId, predicate: fact.predicate, object: fact.object, since: nextDay, right: 0, wrong: 0, lastDay: null };
      continue;
    }
    const verdict = prior.since <= day ? judge(fact, day, tests.seen, driftDay) : null;
    if (verdict === null) {
      records[fact.factId] = prior;
      continue;
    }
    outcomes.push({ factId: fact.factId, predicate: fact.predicate, right: verdict, priorN: prior.right + prior.wrong });
    records[fact.factId] = { ...prior, right: prior.right + (verdict ? 1 : 0), wrong: prior.wrong + (verdict ? 0 : 1), lastDay: day };
  }
  const ids = Object.keys(records);
  if (ids.length > MAX_FACT_RECORDS) {
    // Keep the records with the most evidence.
    const keep = new Set(ids.sort((a, b) => records[b]!.right + records[b]!.wrong - (records[a]!.right + records[a]!.wrong)).slice(0, MAX_FACT_RECORDS));
    for (const id of ids) if (!keep.has(id)) delete records[id];
  }
  return { tests: { day: nextDay, seen: {}, records }, outcomes };
}

/** "right 12 of 13", and "gathering" beside it until the record may move the belief. */
export function factRecordLine(record: Pick<FactRecord, 'right' | 'wrong'>): string | null {
  const n = record.right + record.wrong;
  if (n === 0) return null;
  return n < MIN_TESTS_FOR_BELIEF ? `right ${record.right} of ${n}, gathering` : `right ${record.right} of ${n}`;
}
