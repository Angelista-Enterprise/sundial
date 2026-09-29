import { createHash } from 'node:crypto';
import { localDate } from '@sundial/helpers/local-day.js';
import { policyForBias, simulateGate } from './gate.js';
import { backtestWatch, type WatchRule } from './watch.js';

/**
 * What `gnomon_test_rule` reports for one rule over a stretch of the log, as
 * a pure function of the rows — so the tool, the rules card's re-test before
 * a save, the miner and an offline replay all read the same numbers.
 *
 * `fired` is what the rule noticed; `gate` is what the owner would have HEARD
 * under their own dial (UC4 F2). `holdout` splits the stretch in two halves,
 * each with its own n, so a rule tuned on the older half is judged on the
 * recent one (F26). `byKey` counts fires per thing, hashed (F27). Each example
 * names the signal ids behind it (F23); a rule that never fired says how close
 * it came.
 */
export interface BacktestSummary {
  valid: true;
  rule: WatchRule;
  days: number;
  eventsReplayed: number;
  matched: number;
  fired: number;
  gate: { dial: number; phasic: number; tonic: number; suppressed: number; reasons: Record<string, number>; note: string };
  holdout: { older: { days: number; fired: number }; recent: { days: number; fired: number } };
  byKey: Record<string, number>;
  perDay: Record<string, number>;
  nearest?: string;
  examples: { at: string; said: string; heard: string; evidence: string[]; wouldDo?: string[] }[];
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 6);

export function summarizeBacktest(
  rule: WatchRule,
  events: { id?: string; type: string; ts: string; payload: unknown }[],
  opts: { days: number; zone: string; dial: number; silent: boolean; now: string; daytime: (ts: string) => boolean },
): BacktestSummary {
  const { matched, fires, nearest } = backtestWatch(rule, events, { daytime: opts.daytime, timeZone: opts.zone });
  const perDay: Record<string, number> = {};
  for (const f of fires) perDay[localDate(f.at, opts.zone)] = (perDay[localDate(f.at, opts.zone)] ?? 0) + 1;
  const sim = simulateGate(policyForBias(opts.dial), fires.map((f) => ({ candidate: f.candidate, ts: f.at })), opts.zone);
  const gate = opts.silent
    ? { dial: opts.dial, phasic: 0, tonic: 0, suppressed: fires.length, reasons: fires.length ? { 'owner-silent': fires.length } : {}, note: 'Autonomy is off, so nothing would be said.' }
    : {
        dial: opts.dial,
        phasic: sim.phasic,
        tonic: sim.tonic,
        suppressed: sim.suppressed,
        reasons: sim.reasons,
        note: "An upper bound: the replay cannot see the moment (a call or typing defers an interruption, and a deferred one can expire) nor the other notices spending the day's list budget.",
      };
  const mid = new Date(Date.parse(opts.now) - (opts.days / 2) * 86_400_000).toISOString();
  const older = fires.filter((f) => f.at < mid).length;
  const byKey: Record<string, number> = {};
  for (const f of fires) byKey[f.key === null ? 'all' : hashKey(f.key)] = (byKey[f.key === null ? 'all' : hashKey(f.key)] ?? 0) + 1;
  const unit = rule.count ? (rule.count.sum ? '' : ' matches in its window') : rule.dwell ? ' minutes held' : '';
  const shown = fires.slice(-6);
  return {
    valid: true,
    rule,
    days: opts.days,
    eventsReplayed: events.length,
    matched,
    fired: fires.length,
    gate,
    holdout: { older: { days: opts.days / 2, fired: older }, recent: { days: opts.days / 2, fired: fires.length - older } },
    byKey: Object.fromEntries(Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    perDay,
    ...(fires.length === 0 && unit !== '' ? { nearest: `closest: ${nearest}${unit}` } : {}),
    examples: shown.map((f, i) => ({ at: f.at, said: f.text, heard: opts.silent ? 'suppressed' : sim.channels[fires.length - shown.length + i]!, evidence: f.evidence, ...(f.wouldDo ? { wouldDo: f.wouldDo } : {}) })),
  };
}
