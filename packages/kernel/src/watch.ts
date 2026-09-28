/**
 * Watch rules: the rules Gnomon writes for itself.
 *
 * A rule in `RULE_MANIFEST` is TypeScript a person wrote, reviewed and
 * shipped. That is the law and it stays: nothing loads code at runtime. What
 * the model may write instead is a WATCH — a small declarative spec (which
 * events, which condition, what to say) that one pure interpreter,
 * `watchRules`, folds like any other rule. The same step function replays a
 * spec over the past log (`backtestWatch`), so before the owner adopts one
 * they see exactly what it would have said. Adoption is a `rule:adopted`
 * event: the rule set lives in the log and replays with it.
 *
 * The language is deliberately small:
 *   - `when`: one event type, and conditions on its payload fields.
 *   - one trigger:
 *       `count`  — at least N matching events within M minutes
 *       `dwell`  — the matching state has held for M minutes (for state events
 *                  such as window:changed: a non-matching event of the same
 *                  type ends it)
 *       `absent` — no matching event for M minutes, during daytime
 *       (none)   — every matching event fires
 *   - `say`: the sentence, with `{field}` filled from the matching payload.
 *   - `cooldownMin`: a rule is quiet this long after it fires.
 */

export type WatchOp = 'eq' | 'contains' | 'matches' | 'gt' | 'lt';

export interface WatchCondition {
  field: string;
  op: WatchOp;
  value: string | number;
}

export interface WatchRule {
  id: string;
  title: string;
  when: { type: string; where?: WatchCondition[] };
  count?: { atLeast: number; withinMin: number };
  dwell?: { atLeastMin: number };
  absent?: { forMin: number };
  say: string;
  cooldownMin: number;
}

export interface WatchRuntime {
  /** Timestamps of recent matches (count). */
  hits: string[];
  /** When the current matching state began (dwell), null when not in it. */
  since: string | null;
  lastMatchAt: string | null;
  lastFiredAt: string | null;
  /** The payload of the last match, for `{field}` in `say`. */
  last: Record<string, unknown> | null;
}

export const MAX_WATCH_RULES = 20;
const OPS = new Set<WatchOp>(['eq', 'contains', 'matches', 'gt', 'lt']);
/** Types that are pure telemetry or Gnomon's own bookkeeping — a watch on them would watch the machine, not the owner. */
const UNWATCHABLE = new Set(['clock:tick', 'input:activity', 'privacy:redacted', 'llm:dispatched', 'llm:result', 'judgement:result', 'notice:candidate', 'entity:fact-candidate', 'rule:adopted', 'rule:dropped']);

export const emptyWatchRuntime = (): WatchRuntime => ({ hits: [], since: null, lastMatchAt: null, lastFiredAt: null, last: null });

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const posNum = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null);

/** A spec from a model or a person, checked and normalised. Never throws. */
export function validateWatchRule(input: unknown): { rule: WatchRule } | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'a rule is an object' };
  const r = input as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 80) : '';
  if (!title) return { error: 'title is required' };
  const when = (r.when ?? {}) as Record<string, unknown>;
  const type = typeof when.type === 'string' ? when.type.trim() : '';
  if (!/^[a-z-]+:[a-z-]+$/.test(type)) return { error: 'when.type must be one event type such as "window:changed"' };
  if (UNWATCHABLE.has(type)) return { error: `${type} cannot be watched` };
  const where: WatchCondition[] = [];
  for (const c of Array.isArray(when.where) ? when.where : []) {
    const cond = c as Record<string, unknown>;
    if (typeof cond.field !== 'string' || !/^[A-Za-z0-9_.]+$/.test(cond.field) || !OPS.has(cond.op as WatchOp)) return { error: 'each condition needs field (a.b.c) and op (eq|contains|matches|gt|lt)' };
    if (typeof cond.value !== 'string' && typeof cond.value !== 'number') return { error: `condition on ${cond.field} needs a string or number value` };
    if (cond.op === 'matches') {
      try {
        new RegExp(String(cond.value), 'i');
      } catch {
        return { error: `condition on ${cond.field}: not a valid pattern` };
      }
    }
    where.push({ field: cond.field, op: cond.op as WatchOp, value: cond.value });
  }
  if (where.length > 6) return { error: 'at most 6 conditions' };
  const triggers = ['count', 'dwell', 'absent'].filter((k) => r[k] !== undefined);
  if (triggers.length > 1) return { error: 'one trigger at most: count, dwell or absent' };
  const rule: WatchRule = { id: typeof r.id === 'string' && r.id.trim() ? slug(r.id) : slug(title), title, when: { type, ...(where.length ? { where } : {}) }, say: '', cooldownMin: 60 };
  if (r.count !== undefined) {
    const c = r.count as Record<string, unknown>;
    const atLeast = posNum(c.atLeast, 1000);
    const withinMin = posNum(c.withinMin, 24 * 60);
    if (!atLeast || !withinMin) return { error: 'count needs atLeast (1–1000) and withinMin (1–1440)' };
    rule.count = { atLeast: Math.round(atLeast), withinMin };
  }
  if (r.dwell !== undefined) {
    const atLeastMin = posNum((r.dwell as Record<string, unknown>).atLeastMin, 24 * 60);
    if (!atLeastMin) return { error: 'dwell needs atLeastMin (1–1440)' };
    rule.dwell = { atLeastMin };
  }
  if (r.absent !== undefined) {
    const forMin = posNum((r.absent as Record<string, unknown>).forMin, 7 * 24 * 60);
    if (!forMin) return { error: 'absent needs forMin (1–10080)' };
    rule.absent = { forMin };
  }
  const say = typeof r.say === 'string' ? r.say.trim().slice(0, 300) : '';
  if (!say) return { error: 'say is required: the sentence Gnomon says when it fires' };
  rule.say = say;
  rule.cooldownMin = posNum(r.cooldownMin, 7 * 24 * 60) ?? 60;
  return { rule };
}

function field(payload: unknown, path: string): unknown {
  let v: unknown = payload;
  for (const k of path.split('.')) v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

export function matchesWatch(rule: WatchRule, type: string, payload: unknown): boolean {
  if (type !== rule.when.type) return false;
  return (rule.when.where ?? []).every(({ field: f, op, value }) => {
    const v = field(payload, f);
    if (op === 'gt' || op === 'lt') return typeof v === 'number' && (op === 'gt' ? v > Number(value) : v < Number(value));
    const text = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    if (op === 'eq') return text.toLowerCase() === String(value).toLowerCase();
    if (op === 'contains') return text.toLowerCase().includes(String(value).toLowerCase());
    return new RegExp(String(value), 'i').test(text);
  });
}

function render(say: string, payload: Record<string, unknown> | null, extra: Record<string, string>): string {
  return say.replace(/\{([A-Za-z0-9_.]+)\}/g, (_, f: string) => {
    if (f in extra) return extra[f]!;
    const v = field(payload, f);
    return v === undefined || v === null ? '' : String(v).slice(0, 80);
  });
}

/**
 * One event through one rule. `daytime` gates `absent` (silence at night is
 * sleep, not news). Returns the new runtime and, when it fires, the sentence.
 */
export function stepWatch(rule: WatchRule, rt: WatchRuntime, event: { type: string; ts: string; payload: unknown }, daytime: boolean): { rt: WatchRuntime; fire: string | null } {
  const now = Date.parse(event.ts);
  const cooled = rt.lastFiredAt === null || now - Date.parse(rt.lastFiredAt) >= rule.cooldownMin * 60_000;
  const matched = matchesWatch(rule, event.type, event.payload);
  const payload = matched && typeof event.payload === 'object' && event.payload !== null ? (event.payload as Record<string, unknown>) : rt.last;
  let next: WatchRuntime = matched ? { ...rt, lastMatchAt: event.ts, last: payload } : rt;
  const fired = (extra: Record<string, string> = {}) => ({ rt: { ...next, lastFiredAt: event.ts, hits: [] }, fire: render(rule.say, next.last, extra) });

  if (rule.count) {
    if (!matched) return { rt: next, fire: null };
    const horizon = now - rule.count.withinMin * 60_000;
    next = { ...next, hits: [...next.hits.filter((t) => Date.parse(t) >= horizon), event.ts].slice(-rule.count.atLeast) };
    return next.hits.length >= rule.count.atLeast && cooled ? fired({ count: String(next.hits.length) }) : { rt: next, fire: null };
  }
  if (rule.dwell) {
    if (matched) next = { ...next, since: next.since ?? event.ts };
    else if (event.type === rule.when.type) next = { ...next, since: null };
    const held = next.since === null ? 0 : now - Date.parse(next.since);
    if (next.since !== null && held >= rule.dwell.atLeastMin * 60_000 && cooled && (rt.lastFiredAt === null || rt.lastFiredAt < next.since)) return fired({ minutes: String(Math.round(held / 60_000)) });
    return { rt: next, fire: null };
  }
  if (rule.absent) {
    if (matched || !daytime || next.lastMatchAt === null) return { rt: next, fire: null };
    const quiet = now - Date.parse(next.lastMatchAt);
    // Once per silence: it fires again only after a new match starts a new one.
    if (quiet >= rule.absent.forMin * 60_000 && cooled && (rt.lastFiredAt === null || rt.lastFiredAt < next.lastMatchAt)) return fired({ minutes: String(Math.round(quiet / 60_000)) });
    return { rt: next, fire: null };
  }
  return matched && cooled ? fired() : { rt: next, fire: null };
}

/**
 * What a rule would have said over a stretch of the log, oldest first. The
 * events must include `clock:tick` rows for `dwell`/`absent` to be judged
 * between matches; `isDaytime` answers for `absent`.
 */
export function backtestWatch(rule: WatchRule, events: { type: string; ts: string; payload: unknown }[], isDaytime: (ts: string) => boolean): { matched: number; fires: { at: string; text: string }[] } {
  let rt = emptyWatchRuntime();
  let matched = 0;
  const fires: { at: string; text: string }[] = [];
  for (const e of events) {
    if (matchesWatch(rule, e.type, e.payload)) matched++;
    const out = stepWatch(rule, rt, e, isDaytime(e.ts));
    rt = out.rt;
    if (out.fire !== null) fires.push({ at: e.ts, text: out.fire });
  }
  return { matched, fires };
}
