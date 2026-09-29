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
 *       `absent` — no matching event for M minutes of the owner at the
 *                  machine (`clock: 'active'`, the default), or of daytime
 *                  (`clock: 'wall'`)
 *       `then`   — a match, then (or then not) another event about the same
 *                  thing within M minutes: "a PR opened, then no review
 *                  within two days", "a meeting ended, then no notes"
 *       (none)   — every matching event fires
 *   - `by`: which thing an event is about (a repo, a PR, a meeting). Each
 *     thing keeps its own trigger state and its own cooldown, so one repo's
 *     clean `git:status` no longer ends another repo's dirty stretch. A state
 *     stream that is always about one thing (see `NATURAL_KEY`) is grouped by
 *     it unless the spec says `by: []`. On such a stream an untriggered rule
 *     fires when a thing starts matching, not on every re-sent row.
 *   - `during`: the days and hours, in the owner's zone, the rule may count
 *     and speak in ("after 22:00", "on workdays").
 *   - `say`: the sentence, with `{field}` filled from the matching payload.
 *   - `cooldownMin`: a rule (or, with `by`, one thing) is quiet this long after it fires.
 */

import { createHash } from 'node:crypto';
import { localMinuteOfDay, localWeekday } from '@sundial/helpers/local-day.js';
import type { NoticeCandidate } from './types.js';

/**
 * `ne` is not-eq, `in` is eq to one of a list, `exists` asks whether the field
 * holds a value at all. `ageGt` / `ageLt` read the field as a date and compare
 * how many minutes ago it was: "the meeting ended more than 10 minutes ago".
 * Time moves while no row arrives, so every tick weighs the last row again.
 */
export type WatchOp = 'eq' | 'ne' | 'in' | 'exists' | 'contains' | 'matches' | 'gt' | 'lt' | 'ageGt' | 'ageLt';

export type WatchAction = { wakeup: { inMin: number; reason: string } } | { job: { subject: string; brief: string } } | { ask: { question: string; choices?: string[] } };

export interface WatchThen {
  type: string;
  where?: WatchCondition[];
  by?: string[];
  withinMin: number;
  absent: boolean;
  clock?: WatchClock;
}

export interface WatchWindow {
  days?: number[];
  from?: string;
  to?: string;
}

/** `wall`: every minute counts. `active`: only minutes the owner was at the machine, awake and not idle. */
export type WatchClock = 'wall' | 'active';

export interface WatchCondition {
  field: string;
  op: WatchOp;
  /** A list for `in`, a boolean for `exists`. */
  value: string | number | boolean | (string | number)[];
}

export interface WatchRule {
  id: string;
  title: string;
  /** `where` must all hold; with `anyOf`, so must every condition of at least one of its groups (one level of OR). */
  when: { type: string; where?: WatchCondition[]; anyOf?: WatchCondition[][] };
  /** Payload paths that name the thing an event is about. `[]` means one stream for the whole rule. */
  by?: string[];
  /** When the rule may count and speak, in the owner's zone: ISO weekdays (1 = Monday … 7 = Sunday) and a `HH:MM` window, which may wrap midnight. */
  during?: WatchWindow;
  /** The owner's situation the rule may count and speak in: `{call: true}`, `{meeting: false, away: false}`. */
  while?: WatchWhile;
  /** Hours it holds its fires back, saying them when they end: "never at night". Unlike `during`, nothing is lost. */
  quiet?: WatchWindow;
  /**
   * What the rule does when it fires, besides speaking: internal verbs only —
   * a wake-up, a read-only background job, or a question to the owner (which
   * then IS how it speaks). Anything outward (a calendar block, a draft) is
   * only ever an ask's choice: the owner's tap, through the action gate.
   */
  do?: WatchAction[];
  /** Delivered as its own sentence, banner and push, with no model turn behind it: detection AND delivery without an LLM. */
  plain?: boolean;
  /** "Tell me, and again if it is still so in an hour": a held state or silence still true `afterMin` after its fire is said once more, as an interruption. */
  escalate?: { afterMin: number };
  /** `distinct`: count different values of that field, not rows ("3 different meetings"). `sum`: add that numeric field up instead ("3 hours of focus in a day"). */
  count?: { atLeast: number; withinMin: number; distinct?: string; sum?: string };
  /** `clock: 'active'` counts only minutes the owner was at the machine (see `WatchFlags`). */
  dwell?: { atLeastMin: number; clock?: WatchClock };
  /** `clock` defaults to `'active'`: a night asleep is not six hours without a commit. */
  absent?: { forMin: number; clock: WatchClock };
  /** A sequence: after a `when` match, the `then` event about the same thing (`by`, or its own `by` for the second type) within `withinMin` — `absent: true` (the default) fires when it does NOT come. */
  then?: WatchThen;
  say: string;
  cooldownMin: number;
}

export interface WatchRuntime {
  /** Timestamps of recent matches (count). */
  hits: string[];
  /** With `count.distinct`: the value each hit carried, beside `hits`. */
  hv?: string[];
  /** When the current matching state began (dwell), null when not in it. */
  since: string | null;
  lastMatchAt: string | null;
  lastFiredAt: string | null;
  /** `WatchFlags.activeMs` when `since` began and at `lastMatchAt`, for an active-time clock. */
  sinceActive?: number;
  matchActive?: number;
  /** The payload of the last match, for `{field}` in `say`. With an age condition, the last row of the type, matching or not: time may yet make it match. */
  last: Record<string, unknown> | null;
  /** When a row about this thing last arrived, for keeping the most recent things. */
  seenAt?: string;
  /** Fires waiting to be said again if still so (`escalate`), per thing. */
  escalate?: Record<string, { at: string; text: string; payload: Record<string, unknown> | null }>;
  /** Fires kept during the rule's quiet hours, said when they end. */
  held?: WatchFire[];
  /** A sequence's open first half: when it matched, and the active time then. */
  pending?: { at: string; active: number } | null;
  /** With `by`: one runtime per thing, at most `MAX_WATCH_KEYS`, the least recently matched dropped first. */
  keys?: Record<string, WatchRuntime>;
}

/** One fire: the sentence, the payload it was filled from, and the thing it is about (null without `by`). */
export interface WatchFire {
  text: string;
  payload: Record<string, unknown> | null;
  key: string | null;
  /** The second saying of a fire still so (`escalate`). */
  escalated?: boolean;
}

/**
 * The little state every rule may read beyond its own events, folded by ONE
 * reducer from a fixed set of types (`WATCH_FLAG_TYPES`) — in the live fold and
 * in the backtest alike, so an active-time clock means the same thing in both
 * by construction rather than by care.
 */
export interface WatchFlags {
  /** Milliseconds the owner was at the machine, summed between flag events. A gap over `ACTIVE_GAP_MS` is not counted: nothing was watching. */
  activeMs: number;
  lastTs: string | null;
  /** Idle or asleep: from `idle:start` or a sleep until `idle:end` or a wake. */
  away: boolean;
  /** The calendar's current meeting (not an all-day entry), from `calendar:active`. */
  meeting?: { start: string; end: string } | null;
  /** Microphone or camera in use, from `media:state`. */
  call?: boolean;
  /** A Focus mode on, from `focus-mode:changed`. */
  focus?: boolean;
}

/**
 * Apps whose hold on the microphone is not a call: Sundial's own hearing (and
 * its older name). Measured 2026-09-28: 62% of the month's microphone-on rows
 * were Sundial listening, so "in a call" without this meant "Gnomon is listening".
 */
export const NOT_A_CALL_APPS = ['sundial', 'gnomon', 'coreaudiod'];

/** The owner's situation a rule may require, each true or false: in a meeting, in a call, Focus on, away. */
export interface WatchWhile {
  meeting?: boolean;
  call?: boolean;
  focus?: boolean;
  away?: boolean;
}
const WHILE_FLAGS = ['meeting', 'call', 'focus', 'away'] as const;

/** Whether the owner's situation at `ts` is what the rule requires. */
export function situationHolds(w: WatchWhile, flags: WatchFlags | undefined, ts: string): boolean {
  const f = flags ?? emptyWatchFlags();
  const now: Record<(typeof WHILE_FLAGS)[number], boolean> = {
    meeting: !!f.meeting && f.meeting.start <= ts && ts < f.meeting.end,
    call: f.call === true,
    focus: f.focus === true,
    away: f.away,
  };
  return WHILE_FLAGS.every((k) => w[k] === undefined || w[k] === now[k]);
}

/** What a step may know beyond the event: whether it is daytime (for a wall-clock `absent`) and the flags. */
export interface WatchCtx {
  daytime: boolean;
  flags?: WatchFlags;
  /** The owner's zone, for `during`. UTC when absent. */
  timeZone?: string;
}

/** Ticks come once a minute while the machine is awake; a longer gap is a machine that was not running. */
export const ACTIVE_GAP_MS = 5 * 60_000;
/** The only types `stepWatchFlags` reads. The backtest replays them for every rule. */
export const WATCH_FLAG_TYPES = ['clock:tick', 'idle:start', 'idle:end', 'system:sleep-wake', 'calendar:active', 'media:state', 'focus-mode:changed'];

export const emptyWatchFlags = (): WatchFlags => ({ activeMs: 0, lastTs: null, away: false });

/** Active milliseconds up to `ts`: the folded sum plus the stretch since the last flag event, when present and recent. */
export function activeAt(flags: WatchFlags | undefined, ts: string): number {
  if (!flags) return 0;
  const gap = flags.lastTs === null ? 0 : Date.parse(ts) - Date.parse(flags.lastTs);
  return flags.activeMs + (!flags.away && gap > 0 && gap <= ACTIVE_GAP_MS ? gap : 0);
}

/** One event through the flags. Anything outside `WATCH_FLAG_TYPES` returns the same object. */
export function stepWatchFlags(flags: WatchFlags, event: { type: string; ts: string; payload: unknown }): WatchFlags {
  if (!WATCH_FLAG_TYPES.includes(event.type)) return flags;
  const next: WatchFlags = { ...flags, activeMs: activeAt(flags, event.ts), lastTs: event.ts };
  const kind = (event.payload as { kind?: unknown } | null)?.kind;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === 'idle:start' || (event.type === 'system:sleep-wake' && kind === 'sleep')) next.away = true;
  else if (event.type === 'idle:end' || (event.type === 'system:sleep-wake' && kind === 'wake')) next.away = false;
  else if (event.type === 'calendar:active') {
    const e = (p.event ?? {}) as Record<string, unknown>;
    if (e.isAllDay !== true && typeof e.startDate === 'string' && typeof e.endDate === 'string') next.meeting = { start: new Date(instant(e.startDate)).toISOString(), end: new Date(instant(e.endDate)).toISOString() };
  } else if (event.type === 'media:state') {
    const mic = typeof p.audioInputProcess === 'string' ? p.audioInputProcess.toLowerCase() : '';
    next.call = (p.audioInput === true && !NOT_A_CALL_APPS.some((name) => mic.includes(name))) || p.camera === true;
  }
  else if (event.type === 'focus-mode:changed') next.focus = typeof p.state === 'string' && p.state !== 'off';
  return next;
}

/** The spec language in a paragraph, for the tools that take a rule. */
export const WATCH_GRAMMAR = [
  "A rule: {title, when: {type: 'git:pr-status', where: [{field, op, value}], anyOf?: [[cond…], [cond…]]},",
  "ops eq | ne | in (a list) | exists (true/false) | contains | matches (a regex) | gt | lt | ageGt | ageLt (minutes since a date field, weighed again every tick) | person (a name: the test resolves it to every alias the record holds for them, and the adopted rule keeps that list);",
  "a field is a dotted path, and list[].field holds when any item does;",
  "by?: ['number'] — one runtime and one cooldown per thing (a repo, a PR, a session); state streams (git:status, git:pr-status, calendar:*, agent:fleet) are grouped by what they are about unless by: [];",
  "one trigger — count: {atLeast, withinMin, distinct?: field, sum?: field} | dwell: {atLeastMin, clock?: 'wall' | 'active'} (a state held) | absent: {forMin, clock?: 'active' (default: only minutes the owner was at the machine) | 'wall'} | then: {type, where?, by?, withinMin, absent?: true (default: fires when it does NOT follow) | false} (a sequence about the same thing) | none (every match; on a state stream, when a thing starts matching) — horizons up to 10080 minutes;",
  "during?: {days?: [1..7, Monday = 1], from?: 'HH:MM', to?: 'HH:MM'} and while?: {meeting?, call?, focus?, away?: true | false} — when it may count and speak, in the owner's zone; quiet?: the same window shape, hours whose fires are held and said when they end;",
  "escalate?: {afterMin} — said once more, as an interruption, if a held state or silence is still so;",
  "plain?: true — said as its own sentence (banner, push), no model turn;",
  "do?: [{wakeup: {inMin, reason}} | {job: {subject, brief}} (a read-only background job) | {ask: {question, choices?}} (then the question is how it speaks)] — internal only; anything outward is an ask's choice for the owner to tap; {said} is the sentence;",
  "say: 'the sentence, {field} and {minutes}/{count}/{sum} filled in', cooldownMin.}",
].join(' ');

export const MAX_WATCH_RULES = 20;
/** Things one rule tracks at once. Enough for every open PR, repo or meeting; the least recently matched goes first. */
export const MAX_WATCH_KEYS = 50;

/**
 * The thing a state stream is always about. A `git:status` row describes one
 * repo, a `git:pr-status` row one PR, a calendar row one meeting: a rule that
 * holds or waits on such a stream means "per repo", "per PR", "per meeting"
 * whether or not the spec says so. Measured 2026-09-28: the one adopted rule (a
 * dwell on `git:status`) never fired live because a clean status from another
 * of 14 repos ended every stretch. `by: []` keeps one stream.
 */
export const NATURAL_KEY: Record<string, string[]> = {
  'git:status': ['cwd'],
  'git:pr-status': ['number'],
  'calendar:active': ['event.eventId'],
  'calendar:context-event': ['event.eventId'],
  // Whole-state snapshots of a list: each item is its own thing.
  'agent:fleet': ['sessions[].id'],
  'calendar:upcoming': ['events[].eventId'],
};
const MAX_BY = 3;
/** Fires one rule holds through its quiet hours; the newest are kept. */
const MAX_HELD = 5;
/** The longest horizon a trigger may hold: "two days", "a week". A backtest reaches 60 days, so a week-long hold still has history to fire on. */
const WEEK_MIN = 7 * 24 * 60;
/**
 * Streams that re-send the same thing: the calendar re-emits a context event
 * about a hundred times a day. A count on one counts different meetings unless
 * the spec names another `distinct`.
 */
const RESENT: Record<string, string> = { 'calendar:active': 'event.eventId', 'calendar:context-event': 'event.eventId' };
/** `a.b.c`, or `list[].c` — at most one list per path. */
const PATH = /^[A-Za-z0-9_]+(\[\])?(\.[A-Za-z0-9_]+(\[\])?)*$/;
const listRoot = (path: string) => path.slice(0, path.indexOf('[]'));
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** A `during`-shaped window from a spec, checked; `{error}` when it cannot be run. */
function windowFrom(v: unknown, name: string): WatchWindow | { error: string } {
  const w = (v ?? {}) as Record<string, unknown>;
  const out: WatchWindow = {};
  if (w.days !== undefined) {
    if (!Array.isArray(w.days) || w.days.length === 0 || !w.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return { error: `${name}.days is a list of weekdays, 1 (Monday) to 7 (Sunday)` };
    out.days = [...new Set(w.days as number[])].sort();
  }
  if (w.from !== undefined || w.to !== undefined) {
    if (typeof w.from !== 'string' || typeof w.to !== 'string' || !HHMM.test(w.from) || !HHMM.test(w.to) || w.from === w.to) return { error: `${name} needs from and to as HH:MM, and they differ` };
    out.from = w.from;
    out.to = w.to;
  }
  if (!out.days && !out.from) return { error: `${name} needs days, or from and to` };
  return out;
}

/** Whether an instant falls in a window, in the owner's zone. A window that wraps midnight belongs to the day it starts on. */
export function inWindow(w: WatchWindow, ts: string, timeZone = 'UTC'): boolean {
  const minute = localMinuteOfDay(ts, timeZone);
  let dayTs = ts;
  if (w.from && w.to) {
    const from = minuteOf(w.from);
    const to = minuteOf(w.to);
    const wraps = from > to;
    if (wraps ? minute < from && minute >= to : minute < from || minute >= to) return false;
    if (wraps && minute < to) dayTs = new Date(Date.parse(ts) - (minute + 1) * 60_000).toISOString();
  }
  if (!w.days) return true;
  const iso = localWeekday(dayTs, timeZone) || 7;
  return w.days.includes(iso);
}
const OPS = new Set<WatchOp>(['eq', 'ne', 'in', 'exists', 'contains', 'matches', 'gt', 'lt', 'ageGt', 'ageLt']);
const AGE_OPS = new Set<WatchOp>(['ageGt', 'ageLt']);
/** Types that are pure telemetry or Gnomon's own bookkeeping — a watch on them would watch the machine, not the owner. */
const UNWATCHABLE = new Set(['clock:tick', 'input:activity', 'privacy:redacted', 'llm:dispatched', 'llm:result', 'judgement:result', 'notice:candidate', 'entity:fact-candidate', 'rule:adopted', 'rule:dropped', 'rule:paused', 'rule:resumed']);

/** A group holding a quantifier, itself quantified: `(a+)+`, `(.*x)*`, `(a|b+){2,}` — the catastrophic-backtracking shape. */
const NESTED_QUANTIFIER = /\([^)]*[+*}][^)]*\)\s*[+*{]/;

export const emptyWatchRuntime = (): WatchRuntime => ({ hits: [], since: null, lastMatchAt: null, lastFiredAt: null, last: null });

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const posNum = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null);

/** A list of conditions, checked. The fold runs these on every event of the type, so what they may ask is bounded. */
function conditionsFrom(list: unknown, max: number): WatchCondition[] | { error: string } {
  const out: WatchCondition[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const cond = (c ?? {}) as Record<string, unknown>;
    if (typeof cond.field !== 'string' || !PATH.test(cond.field) || !OPS.has(cond.op as WatchOp)) return { error: `each condition needs field (a.b.c, or list[].c for any item of a list) and op (${[...OPS].join('|')})` };
    const op = cond.op as WatchOp;
    const v = cond.value;
    if (op === 'exists') {
      if (typeof v !== 'boolean') return { error: `exists on ${cond.field} takes true or false` };
    } else if (AGE_OPS.has(op)) {
      if (posNum(v, 60 * 24 * 60) === null) return { error: `${op} on ${cond.field} takes minutes (1–86400)` };
    } else if (op === 'in') {
      if (!Array.isArray(v) || v.length === 0 || v.length > 20 || !v.every((x) => typeof x === 'string' || typeof x === 'number')) return { error: `in on ${cond.field} takes a list of 1–20 strings or numbers` };
    } else if (typeof v !== 'string' && typeof v !== 'number' && !(typeof v === 'boolean' && (op === 'eq' || op === 'ne'))) return { error: `condition on ${cond.field} needs a string or number value (eq and ne also take true or false)` };
    if (op === 'matches') {
      // The fold runs this on every event of the type, so a pattern that can
      // backtrack for ever would stall the kernel: bounded, and no quantified group.
      if (String(v).length > 200) return { error: `condition on ${cond.field}: a pattern is at most 200 characters` };
      if (NESTED_QUANTIFIER.test(String(v))) return { error: `condition on ${cond.field}: a repeated group such as (a+)+ is not allowed` };
      try {
        new RegExp(String(v), 'i');
      } catch {
        return { error: `condition on ${cond.field}: not a valid pattern` };
      }
    }
    out.push({ field: cond.field, op, value: v as WatchCondition['value'] });
  }
  if (out.length > max) return { error: `at most ${max} conditions` };
  return out;
}

const clockOf = (v: unknown, fallback: WatchClock): WatchClock | null => (v === undefined ? fallback : v === 'wall' || v === 'active' ? v : null);

/** Whether the rule may count and speak at `ts`: inside its hours and in the situation it asks for. */
function allowedAt(rule: WatchRule, ts: string, ctx: WatchCtx): boolean {
  return (rule.during === undefined || inWindow(rule.during, ts, ctx.timeZone)) && (rule.while === undefined || situationHolds(rule.while, ctx.flags, ts));
}

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
  const where = conditionsFrom(when.where, 6);
  if ('error' in where) return where;
  const anyOf: WatchCondition[][] = [];
  if (when.anyOf !== undefined) {
    if (!Array.isArray(when.anyOf) || when.anyOf.length < 2 || when.anyOf.length > 4) return { error: 'anyOf is 2 to 4 groups of conditions' };
    for (const group of when.anyOf) {
      const conds = conditionsFrom(group, 6);
      if ('error' in conds) return conds;
      if (conds.length === 0) return { error: 'each anyOf group needs a condition' };
      anyOf.push(conds);
    }
  }
  let during: WatchWindow | undefined;
  if (r.during !== undefined) {
    const w = windowFrom(r.during, 'during');
    if ('error' in w) return w;
    during = w;
  }
  let by: string[] | undefined;
  if (r.by !== undefined) {
    const list = typeof r.by === 'string' ? [r.by] : r.by;
    if (!Array.isArray(list) || list.length > MAX_BY || !list.every((p) => typeof p === 'string' && PATH.test(p))) return { error: `by is a field path (a.b.c, or list[].c for each item of a list) or a list of at most ${MAX_BY}` };
    by = [...new Set(list as string[])];
    if (new Set(by.filter((p) => p.includes('[]')).map(listRoot)).size > 1) return { error: 'by may fan out over one list only' };
  }
  const triggers = ['count', 'dwell', 'absent', 'then'].filter((k) => r[k] !== undefined);
  if (triggers.length > 1) return { error: 'one trigger at most: count, dwell, absent or then' };
  const rule: WatchRule = { id: typeof r.id === 'string' && r.id.trim() ? slug(r.id) : slug(title), title, when: { type, ...(where.length ? { where } : {}), ...(anyOf.length ? { anyOf } : {}) }, say: '', cooldownMin: 60 };
  if (r.count !== undefined) {
    const c = r.count as Record<string, unknown>;
    const sum = c.sum;
    if (sum !== undefined && (typeof sum !== 'string' || !PATH.test(sum) || c.distinct !== undefined)) return { error: 'count.sum is a field path, and not with distinct' };
    const atLeast = posNum(c.atLeast, sum ? 1e12 : 1000);
    const withinMin = posNum(c.withinMin, WEEK_MIN);
    if (!atLeast || !withinMin) return { error: 'count needs atLeast (1–1000, or any positive total with sum) and withinMin (1–10080, a week)' };
    const distinct = sum ? undefined : (c.distinct ?? RESENT[type]);
    if (distinct !== undefined && (typeof distinct !== 'string' || !PATH.test(distinct))) return { error: 'count.distinct is a field path' };
    rule.count = { atLeast: sum ? atLeast : Math.round(atLeast), withinMin, ...(distinct ? { distinct } : {}), ...(sum ? { sum } : {}) };
  }
  if (r.dwell !== undefined) {
    const d = r.dwell as Record<string, unknown>;
    const atLeastMin = posNum(d.atLeastMin, WEEK_MIN);
    const clock = clockOf(d.clock, 'wall');
    if (!atLeastMin || !clock) return { error: 'dwell needs atLeastMin (1–10080, a week), and clock is wall or active' };
    rule.dwell = clock === 'active' ? { atLeastMin, clock } : { atLeastMin };
  }
  if (r.absent !== undefined) {
    const a = r.absent as Record<string, unknown>;
    const forMin = posNum(a.forMin, WEEK_MIN);
    const clock = clockOf(a.clock, 'active');
    if (!forMin || !clock) return { error: 'absent needs forMin (1–10080), and clock is active (the default) or wall' };
    rule.absent = { forMin, clock };
  }
  if (r.then !== undefined) {
    const t = (r.then ?? {}) as Record<string, unknown>;
    const ttype = typeof t.type === 'string' ? t.type.trim() : '';
    if (!/^[a-z-]+:[a-z-]+$/.test(ttype) || UNWATCHABLE.has(ttype)) return { error: 'then.type must be one watchable event type' };
    const twhere = conditionsFrom(t.where, 6);
    if ('error' in twhere) return twhere;
    const withinMin = posNum(t.withinMin, WEEK_MIN);
    const clock = clockOf(t.clock, 'wall');
    if (!withinMin || !clock || (t.absent !== undefined && typeof t.absent !== 'boolean')) return { error: 'then needs withinMin (1–10080), absent true or false, and clock wall or active' };
    let tby: string[] | undefined;
    if (t.by !== undefined) {
      const list = typeof t.by === 'string' ? [t.by] : t.by;
      if (!Array.isArray(list) || list.length > MAX_BY || !list.every((p) => typeof p === 'string' && PATH.test(p))) return { error: 'then.by is a field path or a list of them' };
      tby = list as string[];
    }
    rule.then = { type: ttype, ...(twhere.length ? { where: twhere } : {}), ...(tby ? { by: tby } : {}), withinMin, absent: t.absent !== false, ...(clock === 'active' ? { clock } : {}) };
  }
  const say = typeof r.say === 'string' ? r.say.trim().slice(0, 300) : '';
  if (!say) return { error: 'say is required: the sentence Gnomon says when it fires' };
  rule.say = say;
  rule.cooldownMin = posNum(r.cooldownMin, 7 * 24 * 60) ?? 60;
  // A state stream is grouped by the thing it is about unless the spec says otherwise; a count keeps one stream.
  const natural = rule.count ? undefined : NATURAL_KEY[type];
  if (by !== undefined) rule.by = by;
  else if (natural) rule.by = [...natural];
  if (during) rule.during = during;
  if (r.plain !== undefined) {
    if (typeof r.plain !== 'boolean') return { error: 'plain is true or false' };
    if (r.plain) rule.plain = true;
  }
  if (r.do !== undefined) {
    const list = Array.isArray(r.do) ? r.do : [r.do];
    if (list.length === 0 || list.length > 2) return { error: 'do is one or two actions: wakeup, job or ask' };
    const acts: WatchAction[] = [];
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : null);
    for (const a of list as Record<string, Record<string, unknown>>[]) {
      const keys = Object.keys(a ?? {});
      if (keys.length !== 1) return { error: 'each action is one of {wakeup}, {job}, {ask}' };
      const [verb] = keys;
      const v = a[verb!] ?? {};
      if (verb === 'wakeup' && posNum(v.inMin, 14 * 24 * 60) && text(v.reason, 200)) acts.push({ wakeup: { inMin: v.inMin as number, reason: text(v.reason, 200)! } });
      else if (verb === 'job' && text(v.subject, 140) && text(v.brief, 600)) acts.push({ job: { subject: text(v.subject, 140)!, brief: text(v.brief, 600)! } });
      else if (verb === 'ask' && text(v.question, 200) && (v.choices === undefined || (Array.isArray(v.choices) && v.choices.length >= 2 && v.choices.length <= 4 && v.choices.every((c) => text(c, 48))))) acts.push({ ask: { question: text(v.question, 200)!, ...(v.choices ? { choices: (v.choices as string[]).map((c) => c.trim()) } : {}) } });
      else return { error: `action ${verb}: wakeup {inMin (≤ 14 days), reason}, job {subject, brief}, or ask {question, choices?: 2–4 short labels}. Nothing outward: a calendar block or a draft is an ask's choice, for the owner to tap.` };
    }
    rule.do = acts;
  }
  if (r.escalate !== undefined) {
    const afterMin = posNum((r.escalate as Record<string, unknown> | null)?.afterMin, 24 * 60);
    if (!afterMin) return { error: 'escalate needs afterMin (1–1440)' };
    if (rule.count || rule.then) return { error: 'escalate is for a held state (dwell), a silence (absent) or a state stream: a count or a sequence has nothing that stays true' };
    rule.escalate = { afterMin };
  }
  if (r.quiet !== undefined) {
    const w = windowFrom(r.quiet, 'quiet');
    if ('error' in w) return w;
    rule.quiet = w;
  }
  if (r.while !== undefined) {
    const w = (r.while ?? {}) as Record<string, unknown>;
    const keys = Object.keys(w);
    if (keys.length === 0 || !keys.every((k) => (WHILE_FLAGS as readonly string[]).includes(k) && typeof w[k] === 'boolean')) return { error: `while takes ${WHILE_FLAGS.join(', ')}, each true or false` };
    rule.while = w as WatchWhile;
  }
  return { rule };
}

/**
 * Every value a path reaches. A `list[]` segment reaches each item of the list
 * — or the one item a fanned-out row holds in its place — so a condition on it
 * holds when any item does.
 */
function values(payload: unknown, path: string): unknown[] {
  let vs: unknown[] = [payload];
  for (const seg of path.split('.')) {
    const many = seg.endsWith('[]');
    const k = many ? seg.slice(0, -2) : seg;
    vs = vs.map((v) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined));
    if (many) vs = vs.flatMap((v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]));
  }
  return vs;
}

function field(payload: unknown, path: string): unknown {
  return values(payload, path)[0];
}

/**
 * A row holding a list, as one row per item: the list replaced by that item,
 * so `sessions[].state` on a fanned-out row reads the one session.
 */
function fanOut(payload: unknown, root: string): unknown[] {
  const list = field(payload, root);
  if (!Array.isArray(list)) return [];
  const keys = root.split('.');
  const put = (obj: unknown, i: number, item: unknown): unknown => (i === keys.length ? item : { ...(obj as Record<string, unknown>), [keys[i]!]: put((obj as Record<string, unknown>)?.[keys[i]!], i + 1, item) });
  return list.map((item) => put(payload, 0, item));
}

function holds(cond: WatchCondition, payload: unknown, now: number): boolean {
  if (!cond.field.includes('[]')) return holdsOne(cond, field(payload, cond.field), now);
  const vs = values(payload, cond.field);
  // Any item, except that "does not exist" means no item has it.
  if (cond.op === 'exists' && cond.value === false) return !vs.some((v) => holdsOne({ ...cond, value: true }, v, now));
  return vs.some((v) => holdsOne(cond, v, now));
}

/** A field read as an instant: an ISO string, or epoch seconds or milliseconds. */
function instant(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  return typeof v === 'string' ? Date.parse(v) : Number.NaN;
}

function holdsOne({ op, value }: WatchCondition, v: unknown, now: number): boolean {
  if (op === 'exists') return (v !== undefined && v !== null && v !== '') === value;
  if (op === 'ageGt' || op === 'ageLt') {
    const at = instant(v);
    if (!Number.isFinite(at) || !Number.isFinite(now)) return false;
    return op === 'ageGt' ? now - at > Number(value) * 60_000 : now - at < Number(value) * 60_000;
  }
  if (op === 'gt' || op === 'lt') return typeof v === 'number' && (op === 'gt' ? v > Number(value) : v < Number(value));
  const text = (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)).toLowerCase();
  if (op === 'eq') return text === String(value).toLowerCase();
  if (op === 'ne') return text !== String(value).toLowerCase();
  if (op === 'in') return (value as (string | number)[]).some((x) => text === String(x).toLowerCase());
  if (op === 'contains') return text.includes(String(value).toLowerCase());
  return new RegExp(String(value), 'i').test(text);
}

/** Whether a row of the rule's type matches, at `ts` (what an age condition measures from; the row's own time when a row arrives). */
export function matchesWatch(rule: WatchRule, type: string, payload: unknown, ts?: string): boolean {
  if (type !== rule.when.type) return false;
  const now = ts === undefined ? Number.NaN : Date.parse(ts);
  if (!(rule.when.where ?? []).every((c) => holds(c, payload, now))) return false;
  return rule.when.anyOf === undefined || rule.when.anyOf.some((group) => group.every((c) => holds(c, payload, now)));
}

/** A rule with an age condition: time alone can make its last row match, or stop matching. */
export function ages(rule: WatchRule): boolean {
  return [...(rule.when.where ?? []), ...(rule.when.anyOf ?? []).flat()].some((c) => AGE_OPS.has(c.op));
}

function render(say: string, payload: Record<string, unknown> | null, extra: Record<string, string>): string {
  return say.replace(/\{([A-Za-z0-9_.[\]]+)\}/g, (_, f: string) => {
    if (f in extra) return extra[f]!;
    const v = field(payload, f);
    return v === undefined || v === null ? '' : String(v).slice(0, 80);
  });
}

/** The thing an event is about under `by`, as one string. */
export function watchKeyOf(by: string[], payload: unknown): string {
  return by.map((p) => {
    const v = field(payload, p);
    return v === undefined || v === null ? '' : typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v).slice(0, 120);
  }).join('\u0001');
}

const keyed = (rule: WatchRule) => (rule.by?.length ?? 0) > 0;

/**
 * One event through one thing's runtime. `keyedRule` changes one semantic: on
 * a state stream (`NATURAL_KEY`), an untriggered rule with `by` fires when a
 * thing STARTS matching, not on every matching row — a PR re-reported as
 * failing is the same failure.
 */
function stepKey(rule: WatchRule, rt: WatchRuntime, event: { type: string; ts: string; payload: unknown }, ctx: WatchCtx, matched: boolean, keyedRule: boolean): { rt: WatchRuntime; fire: string | null } {
  const now = Date.parse(event.ts);
  const cooled = rt.lastFiredAt === null || now - Date.parse(rt.lastFiredAt) >= rule.cooldownMin * 60_000;
  const ofType = event.type === rule.when.type;
  const aging = ages(rule);
  const row = typeof event.payload === 'object' && event.payload !== null ? (event.payload as Record<string, unknown>) : null;
  const payload = (matched || (aging && ofType)) && row !== null ? row : rt.last;
  // A tick weighs the last row again at the tick's time: it can age into
  // matching (a synthetic match), or out of it — which only holds a fire back,
  // since only a real row ends a state.
  const aged = aging && !ofType ? rt.last !== null && matchesWatch(rule, rule.when.type, rt.last, event.ts) : null;
  const active = activeAt(ctx.flags, event.ts);
  // Outside its window a rule neither counts nor speaks; a held state or a silence carries on.
  const open = allowedAt(rule, event.ts, ctx);
  let next: WatchRuntime = matched ? { ...rt, lastMatchAt: event.ts, matchActive: active, last: payload } : aging && ofType ? { ...rt, last: payload } : rt;
  if (ofType && keyedRule) next = { ...next, seenAt: event.ts };
  const fired = (extra: Record<string, string> = {}) => (open && aged !== false ? { rt: { ...next, lastFiredAt: event.ts, hits: [], ...(next.hv ? { hv: [] } : {}) }, fire: render(rule.say, next.last, extra) } : { rt: next, fire: null });

  if (rule.count) {
    if (!matched || !open) return { rt: next, fire: null };
    const horizon = now - rule.count.withinMin * 60_000;
    if (rule.count.sum !== undefined) {
      // A running total over the window, from the rows' own numbers.
      const v = Number(field(event.payload, rule.count.sum));
      const pairs = [...next.hits.map((t, i) => [t, next.hv?.[i] ?? '0'] as const).filter(([t]) => Date.parse(t) >= horizon), [event.ts, String(Number.isFinite(v) ? v : 0)] as const].slice(-500);
      next = { ...next, hits: pairs.map(([t]) => t), hv: pairs.map(([, x]) => x) };
      const total = next.hv!.reduce((a, x) => a + Number(x), 0);
      return total >= rule.count.atLeast && cooled ? fired({ count: String(next.hits.length), sum: String(Math.round(total)) }) : { rt: next, fire: null };
    }
    if (rule.count.distinct !== undefined) {
      // One hit per value, the latest: a re-sent row moves its value's hit, it does not add one.
      const v = watchKeyOf([rule.count.distinct], event.payload);
      const kept = next.hits.map((t, i) => [t, next.hv?.[i] ?? ''] as const).filter(([t, x]) => Date.parse(t) >= horizon && x !== v);
      const pairs = [...kept, [event.ts, v] as const].slice(-rule.count.atLeast);
      next = { ...next, hits: pairs.map(([t]) => t), hv: pairs.map(([, x]) => x) };
    } else next = { ...next, hits: [...next.hits.filter((t) => Date.parse(t) >= horizon), event.ts].slice(-rule.count.atLeast) };
    return next.hits.length >= rule.count.atLeast && cooled ? fired({ count: String(next.hits.length) }) : { rt: next, fire: null };
  }
  if (rule.dwell) {
    if ((matched || aged === true) && next.since === null) next = { ...next, since: event.ts, sinceActive: active };
    else if (!matched && ofType) next = { ...next, since: null };
    const held = next.since === null ? 0 : rule.dwell.clock === 'active' ? active - (next.sinceActive ?? active) : now - Date.parse(next.since);
    if (next.since !== null && held >= rule.dwell.atLeastMin * 60_000 && cooled && (rt.lastFiredAt === null || rt.lastFiredAt < next.since)) return fired({ minutes: String(Math.round(held / 60_000)) });
    return { rt: next, fire: null };
  }
  if (rule.absent) {
    const wall = rule.absent.clock === 'wall';
    if (matched || (wall && !ctx.daytime) || next.lastMatchAt === null) return { rt: next, fire: null };
    const quiet = wall ? now - Date.parse(next.lastMatchAt) : active - (next.matchActive ?? active);
    // Once per silence: it fires again only after a new match starts a new one.
    if (quiet >= rule.absent.forMin * 60_000 && cooled && (rt.lastFiredAt === null || rt.lastFiredAt < next.lastMatchAt)) return fired({ minutes: String(Math.round(quiet / 60_000)) });
    return { rt: next, fire: null };
  }
  // On a state stream a thing fires when it STARTS matching: a PR re-reported
  // as failing is the same failure. On an event stream (a mail, a command)
  // every match is news, one cooldown per thing.
  if ((keyedRule && rule.when.type in NATURAL_KEY) || aging) {
    if (!ofType && aged !== true) return { rt: next, fire: null };
    if (ofType && !matched) return { rt: next.since === null ? next : { ...next, since: null }, fire: null };
    const starts = next.since === null;
    next = { ...next, since: next.since ?? event.ts };
    return starts && cooled ? fired() : { rt: next, fire: null };
  }
  return matched && cooled ? fired() : { rt: next, fire: null };
}

/** Keep the things matched most recently. */
function boundKeys(keys: Record<string, WatchRuntime>): Record<string, WatchRuntime> {
  const ids = Object.keys(keys);
  if (ids.length <= MAX_WATCH_KEYS) return keys;
  const recent = (k: string) => keys[k]!.seenAt ?? keys[k]!.lastMatchAt ?? '';
  const kept = ids.sort((a, b) => recent(b).localeCompare(recent(a))).slice(0, MAX_WATCH_KEYS);
  return Object.fromEntries(kept.map((k) => [k, keys[k]!]));
}

/**
 * One event through one rule. Only the rule's own type and `clock:tick` step
 * it — the tick is what lets a held state or a silence be judged between
 * matches, and it is all the backtest replays, so live and backtest see the
 * same stream. Returns the new runtime and what fired.
 */
export function stepWatch(rule: WatchRule, rt: WatchRuntime, event: { type: string; ts: string; payload: unknown }, ctx: WatchCtx): { rt: WatchRuntime; fires: WatchFire[] } {
  const core = rule.then ? stepSequence(rule, rule.then, rt, event, ctx) : stepCore(rule, rt, event, ctx);
  const out = rule.escalate ? escalate(rule, rule.escalate.afterMin, core, event) : core;
  if (!rule.quiet) return out;
  // Quiet hours hold what fired and say it when they end, at the first tick after.
  const held = out.rt.held ?? [];
  if (inWindow(rule.quiet, event.ts, ctx.timeZone)) return out.fires.length === 0 ? out : { rt: { ...out.rt, held: [...held, ...out.fires].slice(-MAX_HELD) }, fires: [] };
  return held.length === 0 ? out : { rt: { ...out.rt, held: [] }, fires: [...held, ...out.fires] };
}

/** Whether what a fire said is still so: the state still held, or the silence still unbroken. */
function stillTrue(rule: WatchRule, k: WatchRuntime | undefined, firedAt: string): boolean {
  if (!k) return false;
  if (rule.absent) return k.lastMatchAt === null || k.lastMatchAt <= firedAt;
  return k.since !== null && k.since <= firedAt;
}

/**
 * Escalation: a fire whose state is still so `afterMin` later is said once
 * more, heavier and on its own gate key, so habituation on the first does not
 * swallow it and it clears the bar to interrupt (a push). A state that ended
 * in between cancels it.
 */
function escalate(rule: WatchRule, afterMin: number, out: { rt: WatchRuntime; fires: WatchFire[] }, event: { type: string; ts: string }): { rt: WatchRuntime; fires: WatchFire[] } {
  const pending = { ...(out.rt.escalate ?? {}) };
  for (const f of out.fires) if (!f.escalated) pending[f.key ?? ''] = { at: event.ts, text: f.text, payload: f.payload };
  const fires = [...out.fires];
  if (event.type === 'clock:tick') {
    for (const [k, p] of Object.entries(pending)) {
      const krt = keyed(rule) ? out.rt.keys?.[k] : out.rt;
      if (!stillTrue(rule, krt, p.at)) delete pending[k];
      else if (Date.parse(event.ts) - Date.parse(p.at) >= afterMin * 60_000) {
        fires.push({ text: `Still: ${p.text}`, payload: p.payload, key: keyed(rule) ? k : null, escalated: true });
        delete pending[k];
      }
    }
  }
  const same = Object.keys(pending).length === Object.keys(out.rt.escalate ?? {}).length && Object.keys(pending).every((k) => out.rt.escalate?.[k] === pending[k]);
  return { rt: same ? out.rt : { ...out.rt, escalate: pending }, fires };
}

function stepCore(rule: WatchRule, rt: WatchRuntime, event: { type: string; ts: string; payload: unknown }, ctx: WatchCtx): { rt: WatchRuntime; fires: WatchFire[] } {
  const ofType = event.type === rule.when.type;
  if (!ofType && event.type !== 'clock:tick') return { rt, fires: [] };
  const matched = ofType && matchesWatch(rule, event.type, event.payload, event.ts);
  const aging = ages(rule);
  if (!keyed(rule)) {
    const out = stepKey(rule, rt, event, ctx, matched, false);
    return { rt: out.rt, fires: out.fire === null ? [] : [{ text: out.fire, payload: out.rt.last, key: null }] };
  }
  const keys = { ...(rt.keys ?? {}) };
  const fires: WatchFire[] = [];
  let changed = false;
  const step = (k: string, isMatch: boolean, payload: unknown) => {
    const before = keys[k] ?? emptyWatchRuntime();
    const out = stepKey(rule, before, { ...event, payload }, ctx, isMatch, true);
    if (out.rt !== before) {
      keys[k] = out.rt;
      changed = true;
    }
    if (out.fire !== null) fires.push({ text: out.fire, payload: out.rt.last, key: k });
  };
  const list = rule.by!.find((p) => p.includes('[]'));
  if (ofType && list !== undefined) {
    // A snapshot of a list: each item is a row about one thing, and a thing
    // missing from the snapshot has stopped matching.
    const seen = new Set<string>();
    for (const item of fanOut(event.payload, listRoot(list))) {
      const k = watchKeyOf(rule.by!, item);
      seen.add(k);
      const isMatch = matchesWatch(rule, event.type, item, event.ts);
      if (isMatch || aging || k in keys) step(k, isMatch, item);
    }
    for (const k of Object.keys(keys)) if (!seen.has(k)) step(k, false, event.payload);
  } else if (ofType) {
    // A row of the type is about one thing; a tick is about every thing held.
    const k = watchKeyOf(rule.by!, event.payload);
    if (matched || aging || k in keys) step(k, matched, event.payload);
  } else for (const k of Object.keys(keys)) step(k, false, event.payload);
  return changed ? { rt: { ...rt, keys: boundKeys(keys) }, fires } : { rt, fires };
}

/** Every type a backtest of this rule must replay, and the only ones the live fold lets touch it. */
export function backtestTypes(rule: WatchRule): string[] {
  return [...new Set([rule.when.type, ...(rule.then ? [rule.then.type] : []), ...WATCH_FLAG_TYPES])];
}

/** The things a row is about under `by`: one per item when a path fans out over a list, else one. */
function rowsByKey(by: string[] | undefined, payload: unknown): [string, unknown][] {
  if (!by || by.length === 0) return [['', payload]];
  const list = by.find((p) => p.includes('[]'));
  const items = list === undefined ? [payload] : fanOut(payload, listRoot(list));
  return items.map((item) => [watchKeyOf(by, item), item]);
}

/**
 * A sequence rule. The first half (`when`) opens a wait for the thing it is
 * about; the second (`then`) about the same thing closes it — a fire when the
 * rule waits for it to come, silence when it waits for it not to. A tick past
 * `withinMin` fires an absence (in the rule's window) or lets a presence lapse.
 */
function stepSequence(rule: WatchRule, then: WatchThen, rt: WatchRuntime, event: { type: string; ts: string; payload: unknown }, ctx: WatchCtx): { rt: WatchRuntime; fires: WatchFire[] } {
  const isA = event.type === rule.when.type;
  const isB = event.type === then.type;
  if (!isA && !isB && event.type !== 'clock:tick') return { rt, fires: [] };
  const keys = { ...(rt.keys ?? {}) };
  const fires: WatchFire[] = [];
  let changed = false;
  const now = Date.parse(event.ts);
  const active = activeAt(ctx.flags, event.ts);
  const open = allowedAt(rule, event.ts, ctx);
  const elapsed = (k: WatchRuntime) => (then.clock === 'active' ? active - k.pending!.active : now - Date.parse(k.pending!.at));
  const cooled = (k: WatchRuntime) => k.lastFiredAt === null || now - Date.parse(k.lastFiredAt) >= rule.cooldownMin * 60_000;
  const set = (key: string, k: WatchRuntime) => {
    keys[key] = k;
    changed = true;
  };
  const fire = (key: string, k: WatchRuntime) => {
    fires.push({ text: render(rule.say, k.last, { minutes: String(Math.round(elapsed(k) / 60_000)) }), payload: k.last, key: keyed(rule) ? key : null });
    set(key, { ...k, pending: null, lastFiredAt: event.ts });
  };
  const bRule = { ...rule, when: { type: then.type, ...(then.where ? { where: then.where } : {}) } };
  if (isB) {
    for (const [key, item] of rowsByKey(then.by ?? rule.by, event.payload)) {
      const k = keys[key];
      if (!k?.pending || !matchesWatch(bRule, then.type, item, event.ts)) continue;
      if (!then.absent && elapsed(k) <= then.withinMin * 60_000 && cooled(k) && open) fire(key, k);
      else set(key, { ...k, pending: null });
    }
  }
  if (isA) {
    for (const [key, item] of rowsByKey(rule.by, event.payload)) {
      if (!open || !matchesWatch(rule, rule.when.type, item, event.ts)) continue;
      const k = keys[key] ?? emptyWatchRuntime();
      const row = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
      set(key, { ...k, last: row, lastMatchAt: event.ts, seenAt: event.ts, pending: k.pending ?? { at: event.ts, active } });
    }
  }
  if (event.type === 'clock:tick') {
    for (const [key, k] of Object.entries(keys)) {
      if (!k.pending || elapsed(k) < then.withinMin * 60_000) continue;
      // An absence past its window waits for the rule's hours to speak; a presence that did not come lapses.
      if (!then.absent) set(key, { ...k, pending: null });
      else if (open && cooled(k)) fire(key, k);
    }
  }
  return changed ? { rt: { ...rt, keys: boundKeys(keys) }, fires } : { rt, fires };
}

/** A backtest fire: when, what was said, which thing, and the notice it becomes. */
export interface BacktestFire {
  at: string;
  text: string;
  key: string | null;
  /** Signal ids behind the fire: the last matching row about the thing, and the event it fired on. */
  evidence: string[];
  /** What its actions would have done. */
  wouldDo?: string[];
  candidate: NoticeCandidate;
}

/**
 * What a rule would have said over a stretch of the log, oldest first. The
 * events must include `backtestTypes(rule)`: the rule's own type, and the
 * flag types, `clock:tick` among them, for held states and silences to be
 * judged between matches. `daytime` answers for a wall-clock `absent`.
 */
export function backtestWatch(
  rule: WatchRule,
  events: { id?: string; type: string; ts: string; payload: unknown }[],
  opts: { daytime: (ts: string) => boolean; timeZone?: string },
): { matched: number; fires: BacktestFire[]; nearest: number } {
  let rt = emptyWatchRuntime();
  let flags = emptyWatchFlags();
  let matched = 0;
  let nearest = 0;
  const fires: BacktestFire[] = [];
  // The last matching row about each thing: with the firing event, the evidence behind a fire.
  const lastRow: Record<string, string> = {};
  for (const e of events) {
    if (matchesWatch(rule, e.type, e.payload, e.ts)) {
      matched++;
      if (e.id) for (const [k, item] of rowsByKey(keyed(rule) ? rule.by : undefined, e.payload)) if (matchesWatch(rule, e.type, item, e.ts)) lastRow[k] = e.id;
    }
    flags = stepWatchFlags(flags, e);
    const out = stepWatch(rule, rt, e, { daytime: opts.daytime(e.ts), flags, timeZone: opts.timeZone });
    rt = out.rt;
    if (out.fires.length === 0) nearest = Math.max(nearest, progress(rule, rt, e.ts));
    for (const f of out.fires) {
      const evidence = [...new Set([lastRow[f.key ?? ''], e.id].filter((x): x is string => typeof x === 'string'))];
      fires.push({ at: e.ts, text: f.text, key: f.key, evidence, candidate: watchCandidate(rule, f.text, f.payload, e.ts, f.key, undefined, f.escalated), ...(rule.do ? { wouldDo: describeActions(watchActions(rule, f, e.ts)) } : {}) });
    }
  }
  return { matched, fires, nearest };
}

/**
 * How close the rule came, for a backtest that never fired: the most hits a
 * count held, or the most minutes a dwell held. 0 for the other triggers.
 */
function progress(rule: WatchRule, rt: WatchRuntime, ts: string): number {
  const all = rt.keys ? Object.values(rt.keys) : [rt];
  if (rule.count) return Math.max(0, ...all.map((k) => (rule.count!.distinct ? new Set(k.hv ?? []).size : k.hits.length)));
  if (rule.dwell) return Math.max(0, ...all.map((k) => (k.since === null ? 0 : Math.round((Date.parse(ts) - Date.parse(k.since)) / 60_000))));
  return 0;
}

/**
 * Which thing a fire is about: the payload fields the rule's own `say` names
 * (`{number}`, `{cwd}`), rendered — or null when it names none.
 *
 * The owner chose those fields to tell one fire from another, so they are the
 * entity. `{count}` and `{minutes}` are left out: they change on every fire of
 * the same thing.
 */
export function watchEntity(rule: WatchRule, payload: Record<string, unknown> | null): string | null {
  const fields = [...rule.say.matchAll(/\{([A-Za-z0-9_.[\]]+)\}/g)].map((m) => m[1]!).filter((f) => f !== 'count' && f !== 'minutes');
  if (fields.length === 0) return null;
  return fields.map((f) => {
    const v = field(payload, f);
    return v === undefined || v === null ? '' : String(v).slice(0, 80);
  }).join('\u0001');
}

/**
 * The notice a fire becomes — one definition, read by the fold and by the backtest.
 *
 * The habituation key is per rule AND entity (UC4 finding 2): keyed on the rule
 * alone, "tell me when CI fails" wore down after two deliveries whichever PR
 * failed. A hash, so the key stays short and carries no payload text.
 */
export function watchCandidate(rule: WatchRule, observation: string, payload: Record<string, unknown> | null, ts: string, key: string | null = null, stats?: WatchStats, escalated = false): NoticeCandidate & { timestamp: string } {
  // With `by` the thing is the key; without, the fields the `say` names.
  const entity = key ?? watchEntity(rule, payload);
  return {
    timestamp: ts,
    shape: 'transition',
    kind: `watch:${rule.id}`,
    key: `${entity === null ? `watch:${rule.id}` : `watch:${rule.id}:${createHash('sha256').update(entity).digest('hex').slice(0, 10)}`}${escalated ? ':again' : ''}`,
    // The owner asked for exactly this (UC4 F1). 2.0 × 1.0 is the weight a
    // wake-up and an owner question carry: it clears the phasic bar (1.6) at
    // dial 0 and a quiet moment's cost, is deferred while the owner types or is
    // in a call, and past the day's interruption cap falls to the list, where it
    // is heavy enough not to pay the tonic budget. At 1.5 × 0.9 = 1.35 a rule
    // spoke only because the dial was at −1.
    // Said again because it is still so: heavier, so it interrupts (and pushes) past a quiet moment's cost.
    surprise: escalated ? 2.5 : 2,
    // The owner's own verdicts on this rule, once there are enough of them (F25).
    precision: verdictPrecision(stats),
    valueHalfLifeMs: 30 * 60 * 1000,
    observation,
    evidence: [`watch rule "${rule.title}" (${rule.id})`],
    concerns: [],
    ...(rule.plain ? { plain: true } : {}),
  };
}

/**
 * One rule's record since it was adopted in its current version: what the
 * backtest promised, what it did, and what the owner said about it. Folded by
 * `watchRules`; read by the rules card and by the review below.
 */
export interface WatchStats {
  version: number;
  adoptedAt: string;
  /** The backtest at adoption: fires over `days`, and how many the gate would have let through. */
  predicted?: { fired: number; days: number; heard?: number };
  fires: number;
  /** The last fires, newest last. */
  recent: string[];
  verdicts: { useful: number; wrong: number; 'not-now': number };
  /** When the review last asked about this rule. */
  askedAt?: string;
}

export const MAX_RECENT_FIRES = 20;
/** Verdicts before they move a rule's precision, and before a mostly-wrong rule is put to the owner. */
export const VERDICTS_TO_JUDGE = 5;

export const newWatchStats = (ts: string, version: number, predicted?: WatchStats['predicted']): WatchStats => ({ version, adoptedAt: ts, ...(predicted ? { predicted } : {}), fires: 0, recent: [], verdicts: { useful: 0, wrong: 0, 'not-now': 0 } });

/** A `predicted` block from a `rule:adopted` payload, checked. */
export function predictedFrom(v: unknown): WatchStats['predicted'] | undefined {
  const p = (v ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!n(p.fired) || !n(p.days) || (p.days as number) <= 0) return undefined;
  return { fired: p.fired as number, days: p.days as number, ...(n(p.heard) ? { heard: p.heard as number } : {}) };
}

/**
 * The gate's `precision` for a rule's notice: 1 until the owner has judged it
 * `VERDICTS_TO_JUDGE` times, then (useful + 1) / (useful + wrong + 2). A fresh
 * rule speaks at full weight; one marked wrong five times of five weighs 0.14
 * and goes quiet on its own, before the review even asks.
 */
export function verdictPrecision(stats: WatchStats | undefined): number {
  const n = (stats?.verdicts.useful ?? 0) + (stats?.verdicts.wrong ?? 0);
  return n < VERDICTS_TO_JUDGE ? 1 : (stats!.verdicts.useful + 1) / (n + 2);
}

/** Live fires in the last seven days against what the backtest rate predicts for seven days. */
export function ruleDrift(stats: WatchStats, now: string): { live: number; expected: number; drifting: boolean } {
  const since = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const live = stats.recent.filter((t) => t >= since).length;
  const expected = stats.predicted ? (stats.predicted.fired / stats.predicted.days) * 7 : 0;
  // Only once a week has passed since adoption, and only with n ≥ 5 on one side: a 3× gap either way.
  const old = Date.parse(now) - Date.parse(stats.adoptedAt) >= 7 * 86_400_000;
  const drifting = old && stats.predicted !== undefined && Math.max(live, expected) >= 5 && (live >= 3 * expected || live * 3 <= expected);
  return { live, expected: Math.round(expected * 10) / 10, drifting };
}

/**
 * Whether the owner should be asked about a rule, and how: mostly wrong
 * (80 % of at least five verdicts), silent for 30 days, or drifting 3× from
 * its backtest. Gnomon never drops a rule on its own; it asks, once a fortnight
 * at most per rule.
 */
export function ruleReview(rule: WatchRule, stats: WatchStats | undefined, now: string): { reason: 'wrong' | 'silent' | 'drift'; question: string; choices: string[] } | null {
  if (!stats) return null;
  if (stats.askedAt && Date.parse(now) - Date.parse(stats.askedAt) < 14 * 86_400_000) return null;
  const { useful, wrong } = stats.verdicts;
  if (useful + wrong >= VERDICTS_TO_JUDGE && wrong / (useful + wrong) >= 0.8) return { reason: 'wrong', question: `You marked ${wrong} of ${useful + wrong} notices from "${rule.title}" wrong. Drop the rule?`, choices: ['Drop it', 'Keep it'] };
  const month = new Date(Date.parse(now) - 30 * 86_400_000).toISOString();
  if (stats.adoptedAt <= month && !stats.recent.some((t) => t >= month)) return { reason: 'silent', question: `"${rule.title}" has not fired in 30 days. Drop it?`, choices: ['Drop it', 'Keep it'] };
  const d = ruleDrift(stats, now);
  if (d.drifting) return { reason: 'drift', question: `"${rule.title}" fired ${d.live} times this week; its backtest said about ${Math.round(d.expected)}. Keep it as it is?`, choices: ['Keep it', 'Pause it', 'Drop it'] };
  return null;
}

/** The ask id a rule's review uses, so its answer finds the rule again. */
export const reviewAskId = (id: string) => `owner-ask:rule-${id}`;

const OP_WORDS: Record<WatchOp, string> = { eq: 'is', ne: 'is not', in: 'is one of', exists: 'is set', contains: 'contains', matches: 'matches', gt: '>', lt: '<', ageGt: 'more than', ageLt: 'less than' };
const condWords = (c: WatchCondition) =>
  c.op === 'exists' ? `${c.field} ${c.value ? 'is set' : 'is not set'}` : c.op === 'ageGt' || c.op === 'ageLt' ? `${c.field} ${OP_WORDS[c.op]} ${c.value} min ago` : `${c.field} ${OP_WORDS[c.op]} ${Array.isArray(c.value) ? c.value.join(' / ') : String(c.value)}`;
const span = (min: number) => (min % 1440 === 0 ? `${min / 1440} d` : min % 60 === 0 ? `${min / 60} h` : `${min} min`);

/** A rule in one line of words, for the rules card and the tools: what it watches, when it fires, per what. */
export function describeRule(rule: WatchRule): string {
  const where = [...(rule.when.where ?? []).map(condWords), ...(rule.when.anyOf ? [`(${rule.when.anyOf.map((g) => g.map(condWords).join(' and ')).join(') or (')})`] : [])];
  const what = `${rule.when.type}${where.length ? ` where ${where.join(', ')}` : ''}`;
  const active = (c?: WatchClock) => (c === 'active' ? ' at the machine' : '');
  const trigger = rule.count
    ? `${rule.count.sum ? `${rule.count.sum} adds up to ${rule.count.atLeast}` : `${rule.count.atLeast}${rule.count.distinct ? ` different ${rule.count.distinct}` : ''}`} within ${span(rule.count.withinMin)}`
    : rule.dwell
      ? `held ${span(rule.dwell.atLeastMin)}${active(rule.dwell.clock)}`
      : rule.absent
        ? `none for ${span(rule.absent.forMin)}${active(rule.absent.clock)}`
        : rule.then
          ? `then ${rule.then.absent ? 'no' : ''} ${rule.then.type} within ${span(rule.then.withinMin)}`.replace('  ', ' ')
          : 'each time';
  const per = rule.by?.length ? `, per ${rule.by.join(' + ')}` : '';
  const when = [rule.during ? `${rule.during.days ? `days ${rule.during.days.join(',')}` : ''} ${rule.during.from ? `${rule.during.from}–${rule.during.to}` : ''}`.trim() : '', rule.while ? Object.entries(rule.while).map(([k, v]) => (v ? k : `not ${k}`)).join(', ') : ''].filter(Boolean).join('; ');
  return `${what}: ${trigger}${per}${when ? ` (${when})` : ''}`;
}

/** Whether a rule speaks through a question instead of a notice: then the ask is its voice. */
export const asksInstead = (rule: WatchRule) => (rule.do ?? []).some((a) => 'ask' in a);

/**
 * The events one fire's actions append, all internal. Rendered with the
 * fire's own payload, plus `{said}` for the sentence the rule said. The same
 * function the fold emits from and the backtest lists as `wouldDo`.
 */
export function watchActions(rule: WatchRule, fire: WatchFire, ts: string): { type: string; payload: Record<string, unknown> }[] {
  const tag = createHash('sha256').update(`${rule.id}\u0001${fire.key ?? ''}`).digest('hex').slice(0, 8);
  const fill = (text: string) => render(text, fire.payload, { said: fire.text });
  return (rule.do ?? []).map((a) => {
    if ('wakeup' in a) return { type: 'wakeup:scheduled', payload: { at: new Date(Date.parse(ts) + a.wakeup.inMin * 60_000).toISOString(), reason: fill(a.wakeup.reason), key: `watch-${rule.id}-${tag}` } };
    if ('job' in a) return { type: 'work:requested', payload: { subject: fill(a.job.subject), brief: `${fill(a.job.brief)}\n\nFrom the watch rule "${rule.title}": ${fire.text}`, by: 'rule', rule: rule.id } };
    return { type: 'ask:owner-opened', payload: { askId: `owner-ask:watch-${rule.id}-${tag}-${ts.slice(0, 16)}`, question: fill(a.ask.question), reason: `watch rule "${rule.title}": ${fire.text}`, ...(a.ask.choices ? { choices: a.ask.choices } : {}) } };
  });
}

/** One line per action, for a backtest example. */
export const describeActions = (events: { type: string; payload: Record<string, unknown> }[]) =>
  events.map((e) => (e.type === 'wakeup:scheduled' ? `wake-up at ${String(e.payload.at).slice(0, 16)}: ${e.payload.reason}` : e.type === 'work:requested' ? `job: ${e.payload.subject}` : `ask: ${e.payload.question}`));

/**
 * Identity in a condition (F18): `{field: 'from', op: 'person', value: 'Mira
 * Bakker'}` becomes `in` the name and every alias the record believes is
 * hers (`memory.aliasNames`: a `person-<hash>` a sender was sanitized to, a
 * short name the calendar uses). Resolved when the rule is tested, and frozen
 * into the spec that is adopted: the fold never looks a person up, and an edit
 * resolves again. Senders stay sanitized; this matches what ingest kept.
 */
export function resolvePeople(spec: unknown, aliasNames: Record<string, string>): unknown {
  if (typeof spec !== 'object' || spec === null) return spec;
  const names = (who: string) => {
    const want = who.trim().toLowerCase();
    return [...new Set([who.trim(), ...Object.entries(aliasNames).filter(([alias, name]) => name.trim().toLowerCase() === want || alias.toLowerCase() === want).flatMap(([alias, name]) => [alias, name])])].slice(0, 20);
  };
  const fix = (list: unknown) => (Array.isArray(list) ? list.map((c) => (c && typeof c === 'object' && (c as WatchCondition).op === ('person' as WatchOp) && typeof (c as WatchCondition).value === 'string' ? { ...(c as object), op: 'in', value: names((c as WatchCondition).value as string) } : c)) : list);
  const r = spec as Record<string, Record<string, unknown> | undefined>;
  return {
    ...r,
    ...(r.when ? { when: { ...r.when, ...(r.when.where ? { where: fix(r.when.where) } : {}), ...(Array.isArray(r.when.anyOf) ? { anyOf: (r.when.anyOf as unknown[]).map(fix) } : {}) } } : {}),
    ...(r.then ? { then: { ...r.then, ...(r.then.where ? { where: fix(r.then.where) } : {}) } } : {}),
  };
}

/**
 * Whether the owner is asking to be told when something happens — a standing
 * rule, not a question about now (F29). English and Dutch. "Remind me at four"
 * is a wake-up, not a rule, and does not count.
 */
const RULE_INTENT = [
  /\b(tell|let|notify|alert|warn|ping|nudge|remind|message|text) me( know)?,? (when|whenever|if|as soon as|every time|each time|once)\b/i,
  /\b(whenever|every time|each time|as soon as)\b.+\b(tell|let|notify|alert|warn|ping|nudge|remind) me\b/i,
  /\blaat (me |mij |het me |het mij )?(even )?weten (als|wanneer|zodra)\b/i,
  /\b(waarschuw|seintje|meld)\b.*\b(als|wanneer|zodra)\b/i,
  /\bzodra\b.+\b(laat|meld|waarschuw|zeg)\b/i,
  /\b(elke|iedere) keer (als|dat|wanneer)\b/i,
];
export const isRuleIntent = (text: string) => RULE_INTENT.some((re) => re.test(text));

/**
 * A rule as a blueprint to share (F30): every condition value lifted into a
 * named input, the id dropped. What is left is the rule's shape — fields, ops,
 * trigger, hours, the sentence — and the importer fills the inputs from their
 * own life, backtests it on their own log, and adopts it. The title and the
 * sentence stay, so the export tool runs the PII scan over them before
 * anything leaves.
 */
export function toBlueprint(rule: WatchRule): { blueprint: Record<string, unknown>; inputs: { name: string; field: string; op: WatchOp; example: 'string' | 'number' | 'boolean' | 'list' }[] } {
  const inputs: { name: string; field: string; op: WatchOp; example: 'string' | 'number' | 'boolean' | 'list' }[] = [];
  const lift = (list?: WatchCondition[]) =>
    list?.map((c) => {
      const base = (c.field.split('.').pop() ?? 'value').replace('[]', '');
      let name = base;
      for (let i = 2; inputs.some((x) => x.name === name); i++) name = `${base}${i}`;
      inputs.push({ name, field: c.field, op: c.op, example: Array.isArray(c.value) ? 'list' : (typeof c.value as 'string' | 'number' | 'boolean') });
      return { ...c, value: `{input:${name}}` };
    });
  const { id: _id, ...rest } = rule;
  const blueprint: Record<string, unknown> = { ...rest, when: { ...rule.when, ...(rule.when.where ? { where: lift(rule.when.where) } : {}), ...(rule.when.anyOf ? { anyOf: rule.when.anyOf.map((g) => lift(g)) } : {}) } };
  if (rule.then) blueprint.then = { ...rule.then, ...(rule.then.where ? { where: lift(rule.then.where) } : {}) };
  return { blueprint, inputs };
}

/** A blueprint with its inputs filled: a spec to test on this owner's log. An input left unfilled stays a placeholder, which fails validation where it matters. */
export function fromBlueprint(blueprint: unknown, inputs: Record<string, string | number | boolean | (string | number)[]>): unknown {
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = /^\{input:([A-Za-z0-9_]+)\}$/.exec(v);
      return m && m[1]! in inputs ? inputs[m[1]!] : v;
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(blueprint);
}
