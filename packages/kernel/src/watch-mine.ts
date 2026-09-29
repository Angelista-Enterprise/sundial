import { backtestTypes, backtestWatch, NATURAL_KEY, validateWatchRule, type WatchRule } from './watch.js';

/**
 * Rule mining, deterministic first and the model last (UC4 F28).
 *
 * The weekly rule-idea job used to ask a model to invent a rule and tune it;
 * in 30 days it shelved one. This enumerates candidates from the record
 * itself, and only what survives a backtest on BOTH halves of the window goes
 * to the model, which writes the words:
 *
 *   1. recurring patterns: a high value (p90, p95, p99) of each numeric field, held
 *      (on a state stream) or repeated (on an event stream), and a long
 *      silence (p95 of the gaps) on a frequent stream;
 *   2. routines: a learned A > B > C that stops after A;
 *   3. the owner's repeated asks: an app or site they asked about on three
 *      days, held a while;
 *   4. useful-rated notices: candidates on the types behind a notice kind the
 *      owner marked useful rank first.
 *
 * Each candidate is replayed over the older half (tune) and the recent half
 * (holdout) of the window. It stays only with 1–10 fires in each half and the
 * two within 3× of each other, and it drops when half its fires land within
 * ten minutes of a notice a built-in rule already raised: that was said.
 */

type Ev = { id?: string; type: string; ts: string; payload: unknown };

export const MINE_TYPES = ['git:status', 'git:commit', 'git:pr-status', 'shell:command', 'window:changed', 'browser:tab', 'event:notification', 'event:thrashing', 'mail:received', 'calendar:active'];
/** Streams whose rows describe a state that holds (a dwell is the question), beyond the natural-key ones. */
const HELD = new Set(['window:changed', 'event:notification', 'browser:tab']);
/** The type behind a built-in notice kind, for "the owner found this useful". */
const KIND_TYPES: Record<string, string> = { 'shell-failing': 'shell:command', 'shell-failing-streak': 'shell:command', 'shell-failure': 'shell:command', 'agent-waiting': 'agent:fleet', 'agent-pr-red': 'git:pr-status', thrashing: 'event:thrashing', 'notification-pileup': 'event:notification' };
const SKIP_FIELDS = /(^|\.)(timestamp|id|pid|number|windowId|eventId|ts|at)$/i;

export interface MineInput {
  events: Ev[];
  now: string;
  days: number;
  zone: string;
  routines: { steps: string[]; support: number }[];
  /** The owner's own chat questions over the window. */
  asks: { ts: string; query: string }[];
  /** Notice kinds (or `watch:<id>` rule kinds with their type) the owner marked useful, with n. */
  useful: { kind: string; type?: string; n: number }[];
  /** Notices built-in rules raised, for the overlap drop. */
  builtins: string[];
}

export interface MinedRule {
  source: 'pattern' | 'routine' | 'ask' | 'useful';
  spec: WatchRule;
  older: number;
  recent: number;
  /** Share of fires within ten minutes of a built-in notice. */
  overlap: number;
  score: number;
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};
const p95 = (xs: number[]) => pct(xs, 0.95);
const niceUp = (v: number) => {
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, v))) - 1);
  return Math.ceil(v / mag) * mag;
};

/** Every candidate spec the record suggests, before any backtest. */
export function enumerateCandidates(input: MineInput): { source: MinedRule['source']; spec: Record<string, unknown> }[] {
  const out: { source: MinedRule['source']; spec: Record<string, unknown> }[] = [];
  const byType = new Map<string, Ev[]>();
  for (const e of input.events) if (MINE_TYPES.includes(e.type)) (byType.get(e.type) ?? byType.set(e.type, []).get(e.type)!).push(e);

  for (const [type, rows] of byType) {
    if (rows.length < 30) continue;
    const held = type in NATURAL_KEY || HELD.has(type);
    // 1a. A high value of each top-level numeric field.
    const fields = new Set<string>();
    for (const r of rows.slice(0, 200)) for (const [k, v] of Object.entries((r.payload ?? {}) as Record<string, unknown>)) if (typeof v === 'number' && !SKIP_FIELDS.test(k)) fields.add(k);
    for (const f of fields) {
      const vals = rows.map((r) => (r.payload as Record<string, unknown>)[f]).filter((v): v is number => typeof v === 'number');
      if (vals.length < 30) continue;
      for (const bar of new Set([0.9, 0.95, 0.99].map((q) => niceUp(pct(vals, q))))) {
        if (bar <= 0 || vals.filter((v) => v > bar).length < 3) continue;
        const where = [{ field: f, op: 'gt', value: bar }];
        out.push({ source: 'pattern', spec: held ? { title: `${type} ${f} over ${bar}, held`, when: { type, where }, dwell: { atLeastMin: 60, clock: 'active' }, say: `${f} has been over ${bar} for {minutes} min` } : { title: `${type} ${f} over ${bar}, repeated`, when: { type, where }, count: { atLeast: 3, withinMin: 60 }, say: `{count} times ${f} over ${bar} in an hour` } });
      }
    }
    // 1b. A long silence on a frequent event stream.
    if (!held && rows.length >= 50) {
      const gaps: number[] = [];
      for (let i = 1; i < rows.length; i++) {
        const g = (Date.parse(rows[i]!.ts) - Date.parse(rows[i - 1]!.ts)) / 60_000;
        if (g > 0 && g < 12 * 60) gaps.push(g);
      }
      if (gaps.length >= 30) {
        const quiet = Math.max(30, niceUp(p95(gaps)));
        out.push({ source: 'pattern', spec: { title: `no ${type} for ${quiet} min`, when: { type }, absent: { forMin: quiet }, say: `no ${type} for {minutes} min at the machine` } });
      }
    }
  }

  // 2. A routine that stops after its first step.
  for (const r of input.routines.filter((x) => x.steps.length === 3).sort((a, b) => b.support - a.support).slice(0, 3)) {
    const [a, , c] = r.steps.map((s) => s.split('/')[0]!);
    if (!a || !c || a === c) continue;
    out.push({ source: 'routine', spec: { title: `${a} without the usual ${c}`, when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: a }] }, by: [], then: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: c }], withinMin: 30 }, say: `${a} without ${c} after it, unlike usual` } });
  }

  // 3. An app or site the owner asked about on three different days, held a while.
  const values = new Map<string, { type: string; field: string }>();
  for (const e of byType.get('window:changed') ?? []) {
    const v = (e.payload as Record<string, unknown>).processName;
    if (typeof v === 'string' && v.length >= 4) values.set(v.toLowerCase(), { type: 'window:changed', field: 'processName' });
  }
  for (const e of byType.get('browser:tab') ?? []) {
    const v = (e.payload as Record<string, unknown>).host;
    if (typeof v === 'string' && v.length >= 4) values.set(v.toLowerCase(), { type: 'browser:tab', field: 'host' });
  }
  const askedOn = new Map<string, Set<string>>();
  for (const q of input.asks) for (const [v] of values) if (q.query.toLowerCase().includes(v)) (askedOn.get(v) ?? askedOn.set(v, new Set()).get(v)!).add(q.ts.slice(0, 10));
  for (const [v, ds] of askedOn) {
    if (ds.size < 3) continue;
    const at = values.get(v)!;
    const real = (byType.get(at.type) ?? []).map((e) => (e.payload as Record<string, unknown>)[at.field]).find((x) => typeof x === 'string' && x.toLowerCase() === v) as string;
    out.push({ source: 'ask', spec: { title: `${real} for a while`, when: { type: at.type, where: [{ field: at.field, op: 'eq', value: real }] }, dwell: { atLeastMin: 30, clock: 'active' }, say: `${real} for {minutes} min` } });
  }
  return out;
}

/** Enumerate, backtest on both halves, drop what a built-in already says, rank. The model only words what is returned. */
export function mineRules(input: MineInput, limit = 5): MinedRule[] {
  const mid = new Date(Date.parse(input.now) - (input.days / 2) * 86_400_000).toISOString();
  const builtinAt = input.builtins.map((t) => Date.parse(t)).sort((a, b) => a - b);
  const nearBuiltin = (ts: string) => builtinAt.some((b) => Math.abs(b - Date.parse(ts)) <= 10 * 60_000);
  const usefulTypes = new Map<string, number>();
  for (const u of input.useful) {
    const type = u.type ?? KIND_TYPES[u.kind.split(':')[0]!];
    if (type) usefulTypes.set(type, (usefulTypes.get(type) ?? 0) + u.n);
  }
  const hour = (ts: string) => new Date(ts).getUTCHours();
  const seen = new Set<string>();
  const kept: (MinedRule & { sig: string })[] = [];
  for (const c of enumerateCandidates(input)) {
    const checked = validateWatchRule(c.spec);
    if (!('rule' in checked) || seen.has(checked.rule.id)) continue;
    seen.add(checked.rule.id);
    const types = new Set(backtestTypes(checked.rule));
    const { fires } = backtestWatch(checked.rule, input.events.filter((e) => types.has(e.type)), { daytime: (ts) => hour(ts) >= 6 && hour(ts) < 18, timeZone: input.zone });
    const older = fires.filter((f) => f.at < mid).length;
    const recent = fires.length - older;
    // 1–10 in each half, and the halves within 3× of each other: a rate that holds out of sample.
    if (older < 1 || recent < 1 || older > 10 || recent > 10 || Math.max(older, recent) > 3 * Math.min(older, recent)) continue;
    const overlap = fires.filter((f) => nearBuiltin(f.at)).length / fires.length;
    if (overlap >= 0.5) continue;
    const boost = (c.source === 'ask' ? 2 : 0) + ((usefulTypes.get(checked.rule.when.type) ?? 0) > 0 ? 1 : 0);
    // Closest to a few a week reads best; a boosted source ranks first.
    const score = boost * 10 - Math.abs(recent - 4) - Math.abs(older - recent) / 2;
    kept.push({ source: boost > 0 && c.source === 'pattern' ? 'useful' : c.source, spec: checked.rule, older, recent, overlap: Math.round(overlap * 100) / 100, score, sig: fires.map((f) => f.at).join() });
  }
  // Two thresholds that fire at the same moments are one rule: keep the better-ranked.
  const sigs = new Set<string>();
  return kept
    .sort((a, b) => b.score - a.score)
    .filter((k) => !sigs.has(k.sig) && sigs.add(k.sig))
    .slice(0, limit)
    .map(({ sig: _sig, ...m }) => m);
}
