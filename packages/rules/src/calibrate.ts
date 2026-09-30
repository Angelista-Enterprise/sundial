import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { isTestNoticeKey } from '@sundial/helpers/vocab.js';
import { credit, observe } from '@sundial/kernel/calibrated.js';
import { routineForecast } from '@sundial/kernel/routines.js';
import type { CalibratedState, DeliveredNotice, Effect, KernelState, NoticeDay, Rule, SanitizedEvent, WatchedNotice } from '@sundial/kernel/types.js';
import { isZeroActivity } from './idle-track.js';
import { askClass } from './owner-ask.js';

/*
 * W5 steps 3 and 5: the single writer of `state.calibrated`. It folds every outcome a declared
 * parameter is scored by (`PARAMETERS` in `@sundial/kernel/calibrated.js`) and watches each
 * delivered notice for what the owner did next.
 *
 * Two kinds of label, never mixed: "seen" (the owner at the Mac within 5 minutes) feeds a
 * seen-rate, and each kind's own action feeds that kind's acted-rate. Neither is a verdict: only
 * the owner's `useful` / `wrong` moves precision. Each implicit label is also written to the log
 * as `feedback:implicit {noticeKey, kind, signal, lagMs}`; the fold counts it where it is
 * detected, so a replay counts it once and the logged copy is ignored here.
 *
 * After `noticeGate` (it reads `notices.lastDelivered`, which the gate writes on the same event),
 * `routineLearn` (the trail) and `feedbackTrack` (the insight a verdict names).
 */

const MINUTE = 60_000;
export const SEEN_WITHIN_MS = 5 * MINUTE;
/** A question answered this soon counts toward the interruption cost's evidence. */
const ANSWERED_WITHIN_MS = 10 * MINUTE;
/** A phasic notice that pulled the owner away, if they left the app within 5 min, and came back within the hour. */
const LEFT_WITHIN_MS = 5 * MINUTE;
const RETURN_WITHIN_MS = 60 * MINUTE;
/** Interruption cost at or above this is "high" (the W5 measure's split). */
const HIGH_COST = 0.7;
const MAX_WATCH = 100;
const NOTICE_DAYS = 30;
const PROBE_EVERY_MINUTES = 15;

/** Each kind's own action: what the owner does that says the notice was used, and how long after it counts. */
export const ACTIONS: { kind: (kind: string) => boolean; withinMs: number; by: (event: SanitizedEvent, w: WatchedNotice) => boolean }[] = [
  // A prompt in the waiting session.
  { kind: (k) => k === 'agent-waiting', withinMs: 10 * MINUTE, by: (e, w) => e.type === 'agent:hook' && e.payload.event === 'UserPromptSubmit' && w.subject !== null && e.payload.session === w.subject },
  // A piece the resume line named, opened.
  { kind: (k) => k === 'return-from-break', withinMs: 30 * MINUTE, by: (e) => e.type === 'resume:opened' },
  // A commit on the quiet branch.
  { kind: (k) => k === 'commitment-quiet', withinMs: 24 * 60 * MINUTE, by: (e, w) => e.type === 'git:commit' && w.subject !== null && e.payload.branch === w.subject },
  // The owner's next turn in the thread the follow-up went to.
  { kind: (k) => k.startsWith('followup:'), withinMs: 24 * 60 * MINUTE, by: (e, w) => e.type === 'chat:owner' && w.sessionId !== null && e.payload.sessionId === w.sessionId },
  // Gnomon's question, answered.
  { kind: (k) => k === 'owner-question', withinMs: 24 * 60 * MINUTE, by: (e, w) => e.type === 'ask:owner-answered' && w.askId !== null && e.payload.askId === w.askId },
];
const actionOf = (kind: string) => ACTIONS.find((a) => a.kind(kind));

/** The signal types this rule reads from the log (the boot backfill pages exactly these). */
export const CALIBRATE_SOURCE_TYPES = ['feedback:verdict', 'input:activity', 'window:changed', 'agent:hook', 'resume:opened', 'git:commit', 'chat:owner', 'ask:owner-answered', 'action:verified', 'action:performed', 'notice:seen', 'clock:tick'] as const;

/** What a kind's action would touch, from the candidate's own evidence (the record's candidates carry no field for it). */
function subjectOf(kind: string, evidence: string[]): string | null {
  if (kind === 'agent-waiting') return /^session (\S+) in /.exec(evidence[0] ?? '')?.[1] ?? null;
  if (kind === 'commitment-quiet') return evidence.map((e) => /^branch (.+)$/.exec(e)?.[1]).find((b): b is string => !!b) ?? null;
  return null;
}

/** A notice delivered before the watch holds it: its kind from its key, as the Trust card reads one. */
const KEY_KINDS: Record<string, string> = { 'owner-ask': 'owner-question', 'resume-project': 'return-from-break', 'resume-switch': 'return-from-break' };
const kindOfKey = (key: string) => KEY_KINDS[key.split(/[:|]/)[0]!] ?? key.split(/[:|]/)[0]!;

const EMPTY_DAY: NoticeDay = { delivered: 0, labelled: 0, useful: 0, wrong: 0, notNow: 0, seen: 0, acted: 0, explored: 0 };

/** One count on a kind's day; a new day drops the kind's days past the window. */
function bumpDay(c: CalibratedState, kind: string, day: string, fields: Partial<Record<keyof NoticeDay, number>>): CalibratedState {
  const days = c.noticeByKind[kind] ?? {};
  const kept = days[day] ? days : Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-(NOTICE_DAYS - 1)));
  const row = { ...EMPTY_DAY, ...kept[day] };
  for (const [f, n] of Object.entries(fields) as [keyof NoticeDay, number][]) row[f] += n;
  return { ...c, noticeByKind: { ...c.noticeByKind, [kind]: { ...kept, [day]: row } } };
}

function implicit(event: SanitizedEvent, w: WatchedNotice, signal: 'seen' | 'acted'): Effect {
  return {
    type: 'EmitEvent',
    event: { id: deriveId(event.ts, event.id, 'calibrate', w.key, w.at, signal), type: 'feedback:implicit', ts: event.ts, payload: { noticeKey: w.key, kind: w.kind, signal, lagMs: Math.max(0, Date.parse(event.ts) - Date.parse(w.at)) } },
  };
}

/** A label on one watched notice: its day counts it, and the first label also counts it as labelled. */
function label(c: CalibratedState, i: number, patch: Partial<WatchedNotice>, counts: Partial<Record<keyof NoticeDay, number>>): CalibratedState {
  const w = c.watch[i]!;
  const next = bumpDay(c, w.kind, w.day, { ...counts, ...(w.labelled ? {} : { labelled: 1 }) });
  return { ...next, watch: next.watch.map((x, j) => (j === i ? { ...x, ...patch, labelled: true } : x)) };
}

function deliveries(c: CalibratedState, items: DeliveredNotice[], ts: string, tz: string): CalibratedState {
  let out = c;
  for (const d of items) {
    if (out.watch.some((w) => w.key === d.key && w.at === ts)) continue;
    const day = localDate(ts, tz);
    const w: WatchedNotice = { key: d.key, kind: d.kind, channel: d.channel, at: ts, day, subject: subjectOf(d.kind, d.evidence), sessionId: d.sessionId, askId: d.askId, cost: d.cost, app: d.channel === 'phasic' ? out.app : null, leftAt: null };
    let params = observe(observe(out.params, `notice.seen:${d.kind}`, false, ts), 'notice.seen', false, ts);
    if (actionOf(d.kind)) params = observe(params, `notice.acted:${d.kind}`, false, ts);
    if (d.kind === 'owner-question' && d.askId) params = observe(params, `gate.answered:${d.cost >= HIGH_COST ? 'high' : 'low'}`, false, ts);
    out = bumpDay({ ...out, params, watch: [...out.watch, w].slice(-MAX_WATCH) }, d.kind, day, { delivered: 1, ...(d.exploration ? { explored: 1 } : {}) });
  }
  return out;
}

/** The owner's verdict on a notice (or the insight written from it, or Gnomon's question). */
function verdict(state: KernelState, c: CalibratedState, event: SanitizedEvent): CalibratedState {
  const p = event.payload as { artifactKind?: unknown; artifactId?: unknown; verdict?: unknown };
  const v = p.verdict as string;
  const id = typeof p.artifactId === 'string' ? p.artifactId : '';
  if ((v !== 'useful' && v !== 'wrong' && v !== 'not-now') || id === '') return c;
  const insight = p.artifactKind === 'knowledge_entry' ? state.memory.recentInsights.find((x) => x.id === id) : undefined;
  const key = p.artifactKind === 'notice' ? id : (insight?.noticeKey ?? null);
  const askId = p.artifactKind === 'owner_ask' ? id : null;
  if ((key === null && askId === null) || (key !== null && isTestNoticeKey(key))) return c;
  const i = c.watch.map((w) => (key !== null ? w.key === key : w.askId === askId)).lastIndexOf(true);
  const w = i >= 0 ? c.watch[i] : undefined;
  // The latest verdict on a delivered notice counts (a mis-tap corrected is one judgement): the earlier one is taken back.
  const was = w?.verdict;
  if (was === v) return c;
  const kind = w?.kind ?? (askId !== null ? 'owner-question' : insight?.kind && insight.kind !== 'unknown' ? insight.kind : kindOfKey(key!));
  const field = (x: string) => (x === 'not-now' ? 'notNow' : x) as keyof NoticeDay;
  const counts = { [field(v)]: 1, ...(was ? { [field(was)]: -1 } : {}) } as Partial<Record<keyof NoticeDay, number>>;
  // A verdict on a delivery the watch no longer holds counts toward precision, not toward the labelled share (its delivery is not counted here either).
  const out = w ? label(c, i, { verdict: v }, counts) : bumpDay(c, kind, localDate(event.ts, state.config.timezone), counts);
  const dn = (v !== 'not-now' ? 1 : 0) - (was !== undefined && was !== 'not-now' ? 1 : 0);
  const dh = (v === 'useful' ? 1 : 0) - (was === 'useful' ? 1 : 0);
  const ask = askId ?? w?.askId ?? null;
  const ids = [`notice.precision:${kind}`, 'notice.precision', ...(w ? [`gate.precision:${w.channel}`] : []), ...(ask ? [`ask.class:${askClass(ask)}`, 'ask.class'] : [])];
  return dn === 0 && dh === 0 ? out : { ...out, params: ids.reduce((params, id) => adjust(params, id, dn, dh, event.ts), out.params) };
}

/** A verdict's outcome added (or a corrected one swapped): n and hits move together. */
function adjust(params: CalibratedState['params'], id: string, dn: number, dh: number, ts: string): CalibratedState['params'] {
  const s = params[id] ?? { n: 0, hits: 0, sum: 0, updatedAt: null };
  return { ...params, [id]: { n: s.n + dn, hits: s.hits + dh, sum: s.sum + dh, updatedAt: ts } };
}

/** What the owner did after each watched notice: at the Mac (seen), the kind's own action, the question answered, back in the app. */
function behaviour(state: KernelState, c: CalibratedState, event: SanitizedEvent, effects: Effect[]): CalibratedState {
  const now = Date.parse(event.ts);
  const present = event.type === 'input:activity' && !isZeroActivity(event.payload);
  // W6 P18: the client's own word that a line was in view (`notice:seen`), for that notice only.
  const inView = event.type === 'notice:seen' ? String(event.payload.noticeKey ?? '') : null;
  const app = event.type === 'window:changed' && typeof event.payload.processName === 'string' ? event.payload.processName : null;
  let out = app !== null && app !== c.app ? { ...c, app } : c;
  for (let i = 0; i < out.watch.length; i++) {
    const w = out.watch[i]!;
    const lag = now - Date.parse(w.at);
    if (lag < 0) continue;
    if ((present || inView === w.key) && !w.seen && lag <= SEEN_WITHIN_MS) {
      out = label({ ...out, params: credit(credit(out.params, `notice.seen:${w.kind}`, event.ts), 'notice.seen', event.ts) }, i, { seen: true }, { seen: 1 });
      effects.push(implicit(event, w, 'seen'));
    }
    const action = actionOf(w.kind);
    if (action && !w.acted && lag <= action.withinMs && action.by(event, w)) {
      out = label({ ...out, params: credit(out.params, `notice.acted:${w.kind}`, event.ts) }, i, { acted: true }, { acted: 1 });
      effects.push(implicit(event, w, 'acted'));
    }
    if (event.type === 'ask:owner-answered' && w.askId !== null && event.payload.askId === w.askId && !w.answered) {
      const params = lag <= ANSWERED_WITHIN_MS ? credit(out.params, `gate.answered:${w.cost >= HIGH_COST ? 'high' : 'low'}`, event.ts) : out.params;
      out = { ...out, params, watch: out.watch.map((x, j) => (j === i ? { ...x, answered: true } : x)) };
    }
    if (app !== null && w.app !== null && w.returned === undefined) {
      const patch: Partial<WatchedNotice> | null =
        w.leftAt === null
          ? app !== w.app ? (lag <= LEFT_WITHIN_MS ? { leftAt: event.ts } : { returned: false }) : null
          : app === w.app ? { returned: now - Date.parse(w.leftAt) <= RETURN_WITHIN_MS } : null;
      if (patch) {
        const params = patch.returned === true ? observe(out.params, 'gate.returnLag', (now - Date.parse(w.leftAt!)) / MINUTE, event.ts) : out.params;
        out = { ...out, params, watch: out.watch.map((x, j) => (j === i ? { ...x, ...patch } : x)) };
      }
    }
  }
  // The baseline: fixed times, scored the same way as "seen".
  if (present && out.probes.length > 0) {
    const live = out.probes.filter((at) => now - Date.parse(at) <= SEEN_WITHIN_MS && now >= Date.parse(at));
    let params = out.params;
    for (let k = 0; k < live.length; k++) params = credit(params, 'presence.baseline', event.ts);
    out = { ...out, params, probes: [] };
  }
  if (event.type === 'clock:tick' && new Date(event.ts).getUTCMinutes() % PROBE_EVERY_MINUTES === 0 && !out.probes.includes(event.ts)) {
    out = { ...out, params: observe(out.params, 'presence.baseline', false, event.ts), probes: [...out.probes.filter((at) => now - Date.parse(at) <= SEEN_WITHIN_MS), event.ts] };
  }
  // Loop I: the standing routine forecast, scored at the next step the trail takes.
  if (event.type === 'window:changed') {
    const trail = state.routines?.trail ?? [];
    const step = trail.at(-1);
    if (step !== undefined && out.routine?.from !== step) {
      const params = out.routine?.expected ? observe(out.params, 'routine.next', step === out.routine.expected, event.ts) : out.params;
      out = { ...out, params, routine: { from: step, expected: routineForecast(trail, state.routines.learned ?? {})?.expected ?? null, at: event.ts } };
    }
  }
  return out;
}

export const calibrate: Rule = (state, event) => {
  const start = state.calibrated;
  let c = start;
  const effects: Effect[] = [];
  const last = state.notices.lastDelivered;
  if (last?.at === event.ts && (event.type === 'notice:candidate' || event.type === 'clock:tick' || event.type === 'input:activity')) c = deliveries(c, last.items, event.ts, state.config.timezone);
  if (event.type === 'feedback:verdict') c = verdict(state, c, event);
  else if (event.type === 'action:verified' && typeof event.payload.tool === 'string') c = { ...c, params: observe(c.params, `action.verified:${event.payload.tool}`, event.payload.failed !== true, event.ts) };
  else if (event.type === 'action:performed' && typeof event.payload.tool === 'string') {
    const outcome = event.payload.outcome ?? (event.payload.refused ? 'refused' : 'ok');
    c = { ...c, params: observe(c.params, `action.performed:${event.payload.tool}`, outcome === 'ok', event.ts) };
  } else if (CALIBRATE_SOURCE_TYPES.includes(event.type as (typeof CALIBRATE_SOURCE_TYPES)[number])) c = behaviour(state, c, event, effects);
  return c === start ? { state, effects: [] } : { state: { ...state, calibrated: c }, effects };
};
