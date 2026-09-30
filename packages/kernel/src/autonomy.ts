// W5 step 10: autonomy is earned per capability. `off | ask | act`; `act` only while that
// capability's scorecard rows meet their target at the stated n AND the owner has said yes
// (`autonomy:granted`), back to `ask` the moment the rows fall below. The owner can always lower
// a capability (`autonomy:set`), and a lowered level always wins. Everything starts at `ask`.
//
// What each level does where the capability acts today:
// - `notice:<kind>` (the notice gate): `act` may interrupt (phasic); `ask` says it in the list
//   instead (tonic: nothing takes the owner's attention unasked); `off` says nothing.
// - `followups` (the gate): a follow-up is a line in the chat it answers, which never interrupts;
//   `ask` and `act` both deliver it, `off` delivers none.
// - `actions` (sundial-actions' gate): `act` lets an outward or shell tool Gnomon starts unasked
//   run without a nod when the owner's auto mode is Act. A turn the owner opened, or a thread whose
//   Ask/Auto preset they chose, is their yes: the preset decides there, whatever this level is.
// - `night-jobs` (the night shift): the owner queues each job, so `ask` runs them as today; `off`
//   starts none. No row measures a night job yet, so it cannot earn `act`.
import { actionRates, kindPrecision, PHASIC_MIN_N, PHASIC_PRECISION, rate } from './read/scorecard.js';
import type { AutonomyLevel, AutonomyState, KernelState } from './types.js';

/** Notices that are not Gnomon's to earn: the owner's own reminders, and Sundial's word on its own health. */
export const UNGOVERNED_KINDS = new Set(['wakeup', 'sensor-health']);

/** The capability a notice kind belongs to; null when no autonomy governs it (a watch rule is the owner's own: they adopted it). */
export function capabilityOf(kind: string): string | null {
  if (UNGOVERNED_KINDS.has(kind) || kind.startsWith('watch:')) return null;
  return kind.startsWith('followup:') ? 'followups' : `notice:${kind}`;
}

const RANK: Record<AutonomyLevel, number> = { off: 0, ask: 1, act: 2 };

/** The level a capability has now, as folded; a capability nothing has folded yet asks. */
export function levelOf(state: KernelState | null | undefined, capability: string | null): AutonomyLevel {
  if (capability === null) return 'act';
  return state?.autonomy?.levels?.[capability]?.level ?? state?.autonomy?.lowered?.[capability] ?? 'ask';
}

/** Whether a capability's scorecard rows meet their target at the stated n, and the numbers that say so. */
export function earnedBy(state: KernelState | null, capability: string): { earned: boolean; rows: string; n: number } {
  if (capability.startsWith('notice:')) {
    const k = kindPrecision(state, capability.slice('notice:'.length));
    return { earned: k.meets === true, rows: `row 4: ${k.value === null ? 'not judged yet' : `${Math.round(k.value * 100)}% worth hearing`}, n = ${k.n}; needs ${PHASIC_PRECISION * 100}% at n ≥ ${PHASIC_MIN_N}`, n: k.n };
  }
  if (capability === 'followups') {
    const all = Object.entries(state?.calibrated?.params ?? {}).filter(([id]) => id.startsWith('notice.precision:followup:')).reduce((a, [, s]) => ({ n: a.n + s.n, hits: a.hits + s.hits }), { n: 0, hits: 0 });
    const value = rate(all.hits, all.n);
    return { earned: all.n >= PHASIC_MIN_N && (value ?? 0) >= PHASIC_PRECISION, rows: `row 4 over follow-ups: ${value === null ? 'not judged yet' : `${Math.round(value * 100)}% worth hearing`}, n = ${all.n}; needs ${PHASIC_PRECISION * 100}% at n ≥ ${PHASIC_MIN_N}`, n: all.n };
  }
  if (capability === 'actions') {
    const a = actionRates(state);
    const say = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`);
    return { earned: a.meets === true, rows: `row 11: verified ${say(a.verified.value)} (n = ${a.verified.n}), did not fail ${say(a.performed.value)} (n = ${a.performed.n}); needs 98% each at n ≥ 30`, n: a.verified.n };
  }
  const recent = state?.nightShift?.recent ?? [];
  return { earned: false, rows: `no scorecard row measures a night job yet (${recent.filter((j) => j.status === 'done').length} of ${recent.length} recent jobs done)`, n: recent.length };
}

/** Every capability there is a level for: the fixed three, and each notice kind the record has seen. */
export function capabilities(state: KernelState | null): string[] {
  const kinds = new Set([
    ...Object.keys(state?.calibrated?.params ?? {}).filter((id) => id.startsWith('notice.precision:')).map((id) => id.slice('notice.precision:'.length)),
    ...Object.keys(state?.calibrated?.noticeByKind ?? {}),
  ]);
  const notices = [...kinds].map(capabilityOf).filter((c): c is string => c !== null && c !== 'followups');
  return ['actions', 'followups', 'night-jobs', ...[...new Set(notices)].sort()];
}

/** The levels, recomputed: earned and granted is `act`, else `ask`, under the owner's own ceiling. Unchanged entries keep their `since`. */
export function computeLevels(state: KernelState, ts: string): AutonomyState['levels'] {
  const a = state.autonomy ?? { levels: {}, granted: {}, lowered: {} };
  const out: AutonomyState['levels'] = {};
  for (const cap of capabilities(state)) {
    const { earned } = earnedBy(state, cap);
    const base: AutonomyLevel = earned && a.granted[cap] ? 'act' : 'ask';
    const lowered = a.lowered[cap];
    const level = lowered && RANK[lowered] < RANK[base] ? lowered : base;
    const was = a.levels[cap];
    out[cap] = was && was.level === level && was.earned === earned ? was : { level, earned, since: was?.level === level ? was.since : ts };
  }
  return out;
}
