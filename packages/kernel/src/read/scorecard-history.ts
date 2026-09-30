// W5 step 9: the scorecard rows that need history (6–10, 12, 13), read from the log, and all
// of them together for `gnomon_reliability`.
import { getScorecardCounts, getSignalFreshness, getSignalsInRange } from '@sundial/db/index.js';
import type { KernelState } from '../types.js';
import { scoreRoutePredictor } from './route-predictor.js';
import { foldedScorecard, judged, pct, rate, withN, type ScorecardRow } from './scorecard.js';

/** Every row: the folded ones, and the ones the log answers. */
export async function readScorecard({ state, now, days = 30 }: { state: KernelState | null; now: number; days?: number }): Promise<ScorecardRow[]> {
  const since = new Date(now - days * 86_400_000).toISOString();
  const until = new Date(now + 60_000).toISOString();
  const [counts, freshness, predicted, actual] = await Promise.all([
    getScorecardCounts(since),
    getSignalFreshness(),
    getSignalsInRange(since, until, 5000, ['ask:route-predicted']),
    getSignalsInRange(since, until, 5000, ['ask:route-actual', 'chat:said']),
  ]);
  const f = counts.facts;
  const factN = f.useful + f.wrong;
  const ownerN = f.ownerUseful + f.ownerWrong;
  const r = counts.refutations;
  const route = scoreRoutePredictor(
    predicted.map((row) => ({ turnId: String(row.data.turnId ?? ''), predicted: (row.data.predicted ?? {}) as Record<string, number | null> })),
    actual.map((row) => ({ turnId: String(row.data.turnId ?? ''), tools: Array.isArray(row.data.tools) ? row.data.tools.map(String) : [] })),
  );
  const m = counts.moments;
  const quiet = freshness.filter((s) => now - Date.parse(s.lastCapturedAt) > 7 * 86_400_000).map((s) => `${s.signalType}:${s.eventType}`);
  const forecasts = counts.forecasts.map((f) => {
    const climatology = f.base * (1 - f.base);
    const skill = climatology > 0 ? Math.round((1 - f.brier / climatology) * 100) / 100 : null;
    return { key: f.kind, value: skill, n: f.n, meets: judged((skill ?? 0) >= 0.2, f.n, 200) };
  });
  const history: ScorecardRow[] = [
    { id: 8, metric: 'Forecaster Brier skill against climatology', value: forecasts.length === 0 ? 'no forecast resolved in the window' : forecasts.map((f) => `${f.key} ${f.value ?? '—'} (n = ${f.n})`).join(', '), n: forecasts.reduce((s, f) => s + f.n, 0), target: '≥ 0.2 at n ≥ 200 to feed the gate', meets: forecasts.length === 0 ? null : forecasts.some((f) => f.meets === true), lives: 'selector', parts: forecasts },
    { id: 6, metric: 'Facts you judged true; facts about you', value: `${withN(pct(rate(f.useful, factN)), factN)}; ${withN(pct(rate(f.ownerUseful, ownerN)), ownerN)}`, n: factN, target: '≥ 85% at n ≥ 30', meets: judged((rate(f.useful, factN) ?? 0) >= 0.85, factN, 30), lives: 'selector' },
    { id: 7, metric: 'Facts you called wrong, closed within the hour', value: withN(pct(rate(r.closedWithinHour, r.wrong)), r.wrong), n: r.wrong, target: '100%', meets: r.wrong === 0 ? null : r.closedWithinHour === r.wrong, lives: 'selector' },
    { id: 9, metric: 'Route predictor: turns routed safely; Brier skill', value: route.n === 0 ? 'retired, no predictions in the window' : `${withN(pct(route.safe), route.n)}; skill ${route.skill === null ? '—' : Math.round(route.skill * 100) / 100}`, n: route.n, target: '≥ 95% safe and skill > 0, else retired (retired 2026-09-29 at skill −0.20)', meets: route.n === 0 ? null : (route.safe ?? 0) >= 0.95 && (route.skill ?? 0) > 0, lives: 'selector' },
    { id: 10, metric: 'Moments with activeMs within their duration; with an intent', value: `${withN(pct(rate(m.n - m.activeOver, m.n)), m.n)}; ${pct(rate(m.withIntent, m.n))}`, n: m.n, target: '100%; ≥ 95%', meets: m.n === 0 ? null : m.activeOver === 0 && m.withIntent / m.n >= 0.95, lives: 'selector' },
    // W6 P5: `ask:harvest-drained` ends the one back-fill sweep (once); the health is answers read, not that ratio.
    { id: 13, metric: 'Your answers to Gnomon, read for knowledge', value: withN(pct(rate(counts.harvest.read, counts.harvest.answered)), counts.harvest.answered), n: counts.harvest.answered, target: '≥ 95%', meets: judged((rate(counts.harvest.read, counts.harvest.answered) ?? 0) >= 0.95, counts.harvest.answered, 20), lives: 'selector' },
    { id: 12, metric: 'Busy hours the window sensor spoke in; streams quiet a week', value: `${withN(pct(rate(counts.liveBusyHours, counts.busyHours)), counts.busyHours)}; ${quiet.length} quiet`, n: counts.busyHours, target: '≥ 99%; 0 quiet', meets: counts.busyHours === 0 ? null : counts.liveBusyHours / counts.busyHours >= 0.99 && quiet.length === 0, lives: 'selector', parts: quiet.map((key) => ({ key, value: null, n: 0, meets: false })) },
  ];
  return [...foldedScorecard(state, now), ...history].sort((a, b) => a.id - b.id);
}

