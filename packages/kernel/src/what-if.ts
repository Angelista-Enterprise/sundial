import { formatClock, localDate } from '@sundial/helpers/local-day.js';
import { simulateGate, type Channel, type GatePolicy } from './gate.js';
import type { NoticeCandidate } from './types.js';

/*
 * UC9 — what if: the recorded notice candidates replayed through the gate's
 * own `decide`, once as the gate stands and once with a change (a lower cap, a
 * smaller list budget, another dial, a kind switched off, a watch rule that
 * was never adopted), and the difference between the two with its n.
 *
 * Both runs use the same replay, so the delta isolates the change: what the
 * replay cannot see (a deferral re-weighed on a later tick, the away hold)
 * is missing from both sides alike. How close the replay comes to what the
 * gate actually did is reported beside it, as agreement with its n.
 */

export interface ReplayItem {
  /** The candidate's row id (or `rule:<n>` for an added fire). */
  id: string;
  ts: string;
  candidate: NoticeCandidate;
  /** The interruption cost the live gate priced at the time, 0..1, when it was recorded. */
  cost?: number;
  /** What the live gate did with it, when the decision row is on record. */
  recorded?: Channel;
}

export interface PolicyChange {
  cap?: number;
  budget?: number;
  /** Kinds taken out of the stream. A kind ending in `*` takes every kind it starts. */
  mute?: string[];
}

export interface WhatIfLine {
  when: string;
  kind: string;
  said: string;
  was: Channel;
  now: Channel | 'muted';
}

export interface WhatIfResult {
  window: { from: string; days: number };
  candidates: number;
  asRecorded: { n: number; phasic: number; tonic: number; deferred: number; suppressed: number };
  /** The replay against the record, on the candidates that have a decision row. */
  agreement: string;
  now: Counts;
  changed: Counts;
  delta: { phasic: number; tonic: number };
  /** Interruptions the owner would NOT have had. */
  missed: WhatIfLine[];
  missedTotal: number;
  /** Interruptions the owner would have had and did not. */
  gained: WhatIfLine[];
  gainedTotal: number;
  /** Heard (phasic + tonic) per kind, now → changed, only where it moves. */
  byKind: Record<string, { now: number; changed: number; n: number }>;
  added?: { fires: number; phasic: number; tonic: number };
  note: string;
}

interface Counts {
  phasic: number;
  tonic: number;
  deferred: number;
  suppressed: number;
}

const count = (channels: readonly (Channel | 'muted')[]): Counts => ({
  phasic: channels.filter((c) => c === 'phasic').length,
  tonic: channels.filter((c) => c === 'tonic').length,
  deferred: channels.filter((c) => c === 'deferred').length,
  suppressed: channels.filter((c) => c === 'suppressed' || c === 'muted').length,
});

const muted = (kind: string, mute: readonly string[]) => mute.some((m) => (m.endsWith('*') ? kind.startsWith(m.slice(0, -1)) : kind === m));
const heard = (c: Channel | 'muted' | undefined) => c === 'phasic' || c === 'tonic';

/**
 * Replay `items` (every recorded candidate, oldest first — the whole log, so
 * habituation is warm when the window opens) under `base` and under
 * `variant` + `change`, and report on the ones at or after `from`.
 */
export function whatIf(
  items: readonly ReplayItem[],
  opts: { base: GatePolicy; variant: GatePolicy; change: PolicyChange; from: string; days: number; zone: string; added?: readonly ReplayItem[]; maxLines?: number },
): WhatIfResult {
  const mute = opts.change.mute ?? [];
  const maxLines = opts.maxLines ?? 10;
  const sorted = [...items].sort((a, b) => a.ts.localeCompare(b.ts));
  const baseSim = simulateGate(opts.base, sorted, opts.zone);
  const baseBy = new Map(sorted.map((it, i) => [it.id, baseSim.channels[i]!]));

  const kept = sorted.filter((it) => !muted(it.candidate.kind, mute));
  const variantItems = [...kept, ...(opts.added ?? [])].sort((a, b) => a.ts.localeCompare(b.ts));
  const variantSim = simulateGate(opts.variant, variantItems, opts.zone);
  const variantBy = new Map<string, Channel | 'muted'>(variantItems.map((it, i) => [it.id, variantSim.channels[i]!]));
  for (const it of sorted) if (!variantBy.has(it.id)) variantBy.set(it.id, 'muted');

  const inWindow = sorted.filter((it) => it.ts >= opts.from);
  const addedIn = (opts.added ?? []).filter((it) => it.ts >= opts.from);
  const line = (it: ReplayItem): WhatIfLine => ({
    when: `${localDate(it.ts, opts.zone).slice(5)} ${formatClock(it.ts, opts.zone)}`,
    kind: it.candidate.kind,
    said: it.candidate.observation.slice(0, 140),
    was: baseBy.get(it.id) ?? 'suppressed',
    now: variantBy.get(it.id) ?? 'suppressed',
  });

  const missed = inWindow.filter((it) => baseBy.get(it.id) === 'phasic' && variantBy.get(it.id) !== 'phasic');
  const gained = [...inWindow, ...addedIn].filter((it) => baseBy.get(it.id) !== 'phasic' && variantBy.get(it.id) === 'phasic');

  const recorded = inWindow.filter((it) => it.recorded !== undefined);
  const agree = recorded.filter((it) => it.recorded === baseBy.get(it.id)).length;

  const byKind: WhatIfResult['byKind'] = {};
  for (const it of [...inWindow, ...addedIn]) {
    const k = it.candidate.kind;
    const entry = byKind[k] ?? { now: 0, changed: 0, n: 0 };
    entry.n++;
    if (heard(baseBy.get(it.id))) entry.now++;
    if (heard(variantBy.get(it.id))) entry.changed++;
    byKind[k] = entry;
  }
  for (const [k, v] of Object.entries(byKind)) if (v.now === v.changed) delete byKind[k];

  const now = count(inWindow.map((it) => baseBy.get(it.id)!));
  const changed = count([...inWindow, ...addedIn].map((it) => variantBy.get(it.id)!));
  return {
    window: { from: opts.from, days: opts.days },
    candidates: inWindow.length,
    asRecorded: { n: recorded.length, ...count(recorded.map((it) => it.recorded!)) },
    agreement: `the replay matches the recorded channel on ${agree} of ${recorded.length} candidates with a decision on record`,
    now,
    changed,
    delta: { phasic: changed.phasic - now.phasic, tonic: changed.tonic - now.tonic },
    missed: missed.slice(-maxLines).map(line),
    missedTotal: missed.length,
    gained: gained.slice(-maxLines).map(line),
    gainedTotal: gained.length,
    byKind,
    ...(opts.added ? { added: { fires: addedIn.length, phasic: addedIn.filter((it) => variantBy.get(it.id) === 'phasic').length, tonic: addedIn.filter((it) => variantBy.get(it.id) === 'tonic').length } } : {}),
    note:
      'Both runs replay the same record through the gate\'s own arithmetic, so the difference is the change alone. Neither sees a deferral re-weighed later or the away hold, and a cost is known only where the gate priced one; "agreement" says how close the replay is to what actually happened.',
  };
}

/** A recorded candidate from its `notice:candidate` row, or null when the row is not one. */
export function candidateOf(payload: Record<string, unknown>): NoticeCandidate | null {
  const p = payload as Partial<NoticeCandidate>;
  if (typeof p.kind !== 'string' || typeof p.key !== 'string' || typeof p.surprise !== 'number' || typeof p.precision !== 'number') return null;
  return {
    shape: p.shape ?? 'transition',
    kind: p.kind,
    key: p.key,
    surprise: p.surprise,
    precision: p.precision,
    valueHalfLifeMs: typeof p.valueHalfLifeMs === 'number' ? p.valueHalfLifeMs : null,
    observation: typeof p.observation === 'string' ? p.observation : '',
    evidence: Array.isArray(p.evidence) ? p.evidence : [],
    concerns: Array.isArray(p.concerns) ? p.concerns : [],
  };
}
