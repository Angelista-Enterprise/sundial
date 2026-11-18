import { createHash } from 'node:crypto';
import { localDate } from '@sundial/helpers/local-day.js';
import { policyForBias, simulateGate } from './gate.js';
import { backtestWatch, replayWatches, validateWatchRule, type BacktestFire, type WatchRule } from './watch.js';

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

type Events = { id?: string; type: string; ts: string; payload: unknown }[];
type Opts = { days: number; zone: string; dial: number; silent: boolean; now: string; daytime: (ts: string) => boolean };

export function summarizeBacktest(rule: WatchRule, events: Events, opts: Opts): BacktestSummary {
  return summarize(rule, backtestWatch(rule, events, { daytime: opts.daytime, timeZone: opts.zone }), events.length, opts);
}

function summarize(rule: WatchRule, { matched, fires, nearest }: { matched: number; fires: BacktestFire[]; nearest: number }, eventsReplayed: number, opts: Opts): BacktestSummary {
  const perDay: Record<string, number> = {};
  for (const f of fires) perDay[localDate(f.at, opts.zone)] = (perDay[localDate(f.at, opts.zone)] ?? 0) + 1;
  // A silent step (`emit` and no `say`) raises its event and puts nothing to the gate.
  const quiet = rule.say === '';
  const sim = simulateGate(policyForBias(opts.dial), quiet ? [] : fires.map((f) => ({ candidate: f.candidate, ts: f.at })), opts.zone);
  const gate = quiet
    ? { dial: opts.dial, phasic: 0, tonic: 0, suppressed: 0, reasons: {}, note: `A silent step: each fire emits ${rule.emit} and says nothing.` }
    : opts.silent
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
    eventsReplayed,
    matched,
    fired: fires.length,
    gate,
    holdout: { older: { days: opts.days / 2, fired: older }, recent: { days: opts.days / 2, fired: fires.length - older } },
    byKey: Object.fromEntries(Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    perDay,
    ...(fires.length === 0 && unit !== '' ? { nearest: `closest: ${nearest}${unit}` } : {}),
    examples: shown.map((f, i) => ({ at: f.at, said: f.text, heard: quiet ? 'silent' : opts.silent ? 'suppressed' : sim.channels[fires.length - shown.length + i]!, evidence: f.evidence, ...(f.wouldDo ? { wouldDo: f.wouldDo } : {}) })),
  };
}

/** A step the replay cannot run: it waits on the owner's answer to a question the replay itself would have asked. */
export const UNTESTABLE = 'waits on your answer';

export interface FlowStep {
  id: string;
  title: string;
  fired?: number;
  /** Phasic plus tonic: what the owner would have heard. */
  heard?: number;
  gate?: { phasic: number; tonic: number; suppressed: number };
  examples?: BacktestSummary['examples'];
  untestable?: string;
}

export interface FlowSummary {
  valid: true;
  days: number;
  eventsReplayed: number;
  steps: FlowStep[];
  /** The flow end to end: the steps no later step hears, summed. `untestable` when one of them is. */
  chain: { fired: number; heard: number; untestable?: string };
}

/** Whether a step hears a type. */
const hears = (r: WatchRule, type: string) => r.when.type === type || r.then?.type === type;

/**
 * A flow over one replay (`replayWatches`): every step's own numbers, and the
 * chain's. A step that branches on the owner's answer to an earlier step's ask
 * (`ask:owner-answered` with `rule` one of the flow's ids) cannot be replayed —
 * no answer to a question asked only in the replay exists — so it, and every
 * step that hears it, is reported as untestable rather than as zero.
 */
export function summarizeFlow(rules: WatchRule[], events: Events, opts: Opts & { flow?: string }): FlowSummary {
  const runs = replayWatches(rules, events, { daytime: opts.daytime, timeZone: opts.zone, flow: opts.flow });
  const ids = new Set(rules.map((r) => r.id));
  const answers = (r: WatchRule) => [...(r.when.type === 'ask:owner-answered' ? (r.when.where ?? []) : []), ...(r.then?.type === 'ask:owner-answered' ? (r.then.where ?? []) : [])].some((c) => c.field === 'rule' && (c.op === 'eq' ? ids.has(String(c.value)) : c.op === 'in' && Array.isArray(c.value) && c.value.some((v) => ids.has(String(v)))));
  const untestable = new Set<number>();
  rules.forEach((r, i) => {
    if (answers(r) || rules.slice(0, i).some((p, j) => untestable.has(j) && p.emit !== undefined && hears(r, p.emit))) untestable.add(i);
  });
  const steps: FlowStep[] = rules.map((r, i) => {
    if (untestable.has(i)) return { id: r.id, title: r.title, untestable: UNTESTABLE };
    const s = summarize(r, runs[i]!, events.length, opts);
    return { id: r.id, title: r.title, fired: s.fired, heard: s.gate.phasic + s.gate.tonic, gate: { phasic: s.gate.phasic, tonic: s.gate.tonic, suppressed: s.gate.suppressed }, examples: s.examples };
  });
  const ends = rules.map((_, i) => i).filter((i) => !rules.some((later, j) => j > i && rules[i]!.emit !== undefined && hears(later, rules[i]!.emit!)));
  const chain = { fired: 0, heard: 0 } as FlowSummary['chain'];
  for (const i of ends) {
    if (untestable.has(i)) chain.untestable = UNTESTABLE;
    else {
      chain.fired += steps[i]!.fired!;
      chain.heard += steps[i]!.heard!;
    }
  }
  return { valid: true, days: opts.days, eventsReplayed: events.length, steps, chain };
}

/** The settings a sweep may vary: one number of one trigger. */
export const SWEEP_FIELDS = ['then.withinMin', 'count.withinMin', 'count.atLeast', 'dwell.atLeastMin', 'absent.forMin'] as const;
export type SweepField = (typeof SWEEP_FIELDS)[number];
/** Values one sweep may try. */
export const MAX_SWEEP = 30;

/**
 * One rule replayed at each value of one setting, for the composer's Tune.
 * `best` is the value whose rate comes closest to once a day without passing
 * three a day: about once a day is what a rule the owner asked for should
 * say, and past three it is the "tune a rule that fires more than a few times
 * a day" the test tool already warns about. Ties go to the earlier value in
 * the sweep. Null when every value fires more than three times a day, or the
 * rule never fires at any of them.
 */
export function sweepBacktest(
  spec: Record<string, unknown>,
  sweep: { field: SweepField; from: number; to: number; step: number },
  events: Events,
  opts: Opts,
): { sweep: { value: number; fired: number; heard: number }[]; best: number | null } | { error: string } {
  if (!SWEEP_FIELDS.includes(sweep.field)) return { error: `sweep.field is one of ${SWEEP_FIELDS.join(', ')}` };
  const { from, to, step } = sweep;
  if (![from, to, step].every((n) => typeof n === 'number' && Number.isFinite(n)) || step <= 0 || to < from || (to - from) / step + 1 > MAX_SWEEP) return { error: `sweep needs from ≤ to and a positive step, at most ${MAX_SWEEP} values` };
  const [trigger, key] = sweep.field.split('.') as [string, string];
  if (typeof spec[trigger] !== 'object' || spec[trigger] === null) return { error: `the rule has no ${trigger} to sweep` };
  const out: { value: number; fired: number; heard: number }[] = [];
  for (let i = 0; from + i * step <= to + 1e-9; i++) {
    const value = Math.round((from + i * step) * 1000) / 1000;
    const checked = validateWatchRule({ ...spec, [trigger]: { ...(spec[trigger] as object), [key]: value } });
    if ('error' in checked) return { error: `at ${value}: ${checked.error}` };
    const s = summarizeBacktest(checked.rule, events, opts);
    out.push({ value, fired: s.fired, heard: s.gate.phasic + s.gate.tonic });
  }
  let best: number | null = null;
  let gap = Infinity;
  for (const r of out) {
    const rate = r.fired / opts.days;
    if (r.fired === 0 || rate > 3 || Math.abs(rate - 1) >= gap) continue;
    gap = Math.abs(rate - 1);
    best = r.value;
  }
  return { sweep: out, best };
}
