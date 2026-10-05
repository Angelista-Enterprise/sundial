// W5 step 9: the reliability scorecard, thirteen rows (13 is W6 P5), each with its n and its target. Rows that
// gate a decision (1–4, 11) are folded (`reliability.llm`, `calibrated`) and read here as a pure
// function of the state; the rest need history and are read from the log (W4's placement rule).
// `gnomon_reliability` reads them all (`scorecard-history.ts` adds the log's rows), and the
// autonomy slice and the Settings card read the folded ones, so Gnomon quotes itself in the owner's numbers. A rate on fewer than `TRUST_N` outcomes says so.
import { TRUST_N } from '../calibrated.js';
import type { KernelState } from '../types.js';
import { noticesByKind } from './trust.js';

export interface ScorecardRow {
  id: number;
  metric: string;
  /** The row said in one line, every rate with its n. */
  value: string;
  n: number;
  target: string;
  /** Whether the row meets its target at the stated n; null when there is nothing to judge yet. */
  meets: boolean | null;
  lives: 'folded' | 'selector';
  /** Per route, kind or tool, when the row has parts. */
  parts?: { key: string; value: number | null; n: number; meets: boolean | null }[];
}

export const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`);
export const withN = (v: string, n: number) => `${v} (n = ${n.toLocaleString('en-US')}${n > 0 && n < TRUST_N ? ', too small to trust' : ''})`;
export const rate = (hits: number, n: number) => (n > 0 ? hits / n : null);
export const judged = (ok: boolean, n: number, minN: number) => (n === 0 ? null : n >= minN && ok);

/** Row 4's bar, and the n it must be met at, before a kind may interrupt alone (W5 step 10). */
export const PHASIC_PRECISION = 0.8;
export const PHASIC_MIN_N = 30;
/** Row 8's bar: the Brier skill, and the n it must be met at, before a forecaster feeds the gate (`hasSkill`). */
export const SKILL_MIN = 0.2;
export const SKILL_MIN_N = 200;
/** Row 11's bar for outward actions. */
export const ACTION_TARGET = 0.98;
export const ACTION_MIN_N = 30;

/** Notice precision per kind, raw (useful / (useful + wrong)), as row 4 judges it. */
export function kindPrecision(state: KernelState | null, kind: string): { value: number | null; n: number; meets: boolean | null } {
  const s = state?.calibrated?.params?.[`notice.precision:${kind}`];
  const value = s ? rate(s.hits, s.n) : null;
  return { value, n: s?.n ?? 0, meets: judged((value ?? 0) >= PHASIC_PRECISION, s?.n ?? 0, PHASIC_MIN_N) };
}

/** Row 11 over every tool: verified as done, and performed without failing or being refused. */
export function actionRates(state: KernelState | null): { verified: { value: number | null; n: number }; performed: { value: number | null; n: number }; meets: boolean | null } {
  const sum = (prefix: string) => Object.entries(state?.calibrated?.params ?? {}).filter(([id]) => id.startsWith(prefix)).reduce((a, [, s]) => ({ n: a.n + s.n, hits: a.hits + s.hits }), { n: 0, hits: 0 });
  const v = sum('action.outward:');
  const p = sum('action.performed:');
  const verified = { value: rate(v.hits, v.n), n: v.n };
  const performed = { value: rate(p.hits, p.n), n: p.n };
  return { verified, performed, meets: v.n === 0 ? null : v.n >= ACTION_MIN_N && p.n >= ACTION_MIN_N && (verified.value ?? 0) >= ACTION_TARGET && (performed.value ?? 0) >= ACTION_TARGET };
}

/** The rows a pure read of the state can answer: 1–5 and 11. */
export function foldedScorecard(state: KernelState | null, now: number): ScorecardRow[] {
  const routes = Object.entries(state?.reliability?.llm ?? {});
  const week = routes.map(([route, r]) => {
    const d = r.days.slice(-7).reduce((a, x) => ({ calls: a.calls + x.calls, failed: a.failed + x.failed }), { calls: 0, failed: 0 });
    const value = rate(d.calls - d.failed, d.calls);
    return { key: route, value, n: d.calls, meets: judged((value ?? 0) >= 0.99, d.calls, TRUST_N) };
  });
  const calls = week.reduce((s, w) => s + w.n, 0);
  const ok = week.reduce((s, w) => s + (w.value ?? 0) * w.n, 0);
  const streaks = routes.map(([route, r]) => ({ key: route, value: r.longestClosed ?? 0, n: r.days.reduce((s, x) => s + x.calls, 0), meets: (r.longestClosed ?? 0) <= 10 }));
  const notices = noticesByKind(state, now);
  const kinds = notices.byKind.map((k) => ({ key: k.kind, value: rate(k.labelled, k.delivered), n: k.delivered, meets: judged(k.labelled / Math.max(1, k.delivered) >= 0.8, k.delivered, TRUST_N) }));
  const precision = Object.keys(state?.calibrated?.params ?? {}).filter((id) => id.startsWith('notice.precision:')).map((id) => ({ key: id.slice('notice.precision:'.length), ...kindPrecision(state, id.slice('notice.precision:'.length)) }));
  const all = state?.calibrated?.params?.['notice.precision'];
  const seen = state?.calibrated?.params?.['notice.seen'];
  const base = state?.calibrated?.params?.['presence.baseline'];
  const lift = seen && base && seen.n > 0 && base.n > 0 ? seen.hits / seen.n - base.hits / base.n : null;
  const actions = actionRates(state);
  // R11: each outward tool's verified ratio. A tool with no verdict yet has no part, and `actions` stays `ask` for every tool until the row is met.
  const verifiedByTool = Object.entries(state?.calibrated?.params ?? {}).filter(([id]) => id.startsWith('action.outward:')).map(([id, s]) => ({ key: id.slice('action.outward:'.length), value: rate(s.hits, s.n), n: s.n, meets: judged(s.hits / Math.max(1, s.n) >= ACTION_TARGET, s.n, ACTION_MIN_N) }));
  return [
    { id: 1, metric: 'Model calls that succeeded, per route, last 7 days', value: withN(pct(rate(ok, calls)), calls), n: calls, target: '≥ 99% after retry', meets: week.length === 0 ? null : week.every((w) => w.meets !== false), lives: 'folded', parts: week },
    { id: 2, metric: 'Longest run of failed calls, per route', value: streaks.length === 0 ? 'none recorded' : streaks.map((s) => `${s.key} ${s.value}`).join(', '), n: streaks.length, target: '≤ 10, then the breaker opens', meets: streaks.length === 0 ? null : streaks.every((s) => s.meets), lives: 'folded', parts: streaks },
    { id: 3, metric: 'Delivered notices with a verdict or an implicit label, 30 days', value: withN(pct(rate(notices.labelled, notices.delivered)), notices.delivered), n: notices.delivered, target: '≥ 80%', meets: judged(notices.labelled / Math.max(1, notices.delivered) >= 0.8, notices.delivered, TRUST_N), lives: 'folded', parts: kinds },
    { id: 4, metric: 'Notices judged worth hearing, per kind', value: withN(pct(all ? rate(all.hits, all.n) : null), all?.n ?? 0), n: all?.n ?? 0, target: `≥ ${PHASIC_PRECISION * 100}% at n ≥ ${PHASIC_MIN_N} before a kind may interrupt alone`, meets: precision.length === 0 ? null : precision.some((k) => k.meets === true), lives: 'folded', parts: precision },
    { id: 5, metric: 'At the Mac within 5 min of a notice, against a fixed time', value: lift === null ? 'not measured yet' : withN(`${lift >= 0 ? '+' : ''}${Math.round(lift * 100)} pts (${pct(seen!.hits / seen!.n)} vs ${pct(base!.hits / base!.n)})`, seen!.n), n: seen?.n ?? 0, target: '≥ +20 pts', meets: lift === null ? null : judged(lift >= 0.2, seen!.n, TRUST_N), lives: 'selector' },
    { id: 11, metric: 'Actions verified as done; calls that did not fail or get refused', value: `${withN(pct(actions.verified.value), actions.verified.n)}; ${withN(pct(actions.performed.value), actions.performed.n)}`, n: actions.verified.n, target: '≥ 98% each', meets: actions.meets, lives: 'folded', parts: verifiedByTool },
  ];
}
