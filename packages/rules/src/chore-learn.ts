import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate, localMinuteOfDay, localWeekday } from '@sundial/helpers/local-day.js';
import { choreDaysNeeded, recentDays, usualMinute } from '@sundial/kernel/read/chores.js';
import { byGnomon, byGnomonMarked } from './by-gnomon.js';
import type { ChoreCounter, Effect, KernelState, NoticeOffer, Rule, SanitizedEvent } from '@sundial/kernel/types.js';

/**
 * Round 5 (FORESIGHT 4a): the chore learner. Routines count `process/activityClass` steps and so can
 * never say "the code host" or "BOX-484"; the owner's two real chores have exactly those objects in
 * them: a sweep of the same sites on workday mornings, and the same tickets re-opened week after week.
 *
 * Counts, from owner rows only (`ownerOnly` in the manifest: a row Gnomon caused or the rig's window
 * never counts; `document:opened` comes from `contextUrlClassify`, itself owner-only), the DISTINCT
 * owner-local days of each chore key and the minute of each day's first visit:
 *   - `host:<host>`: a site's first tab of a workday (`config.workdays`) morning, before noon;
 *   - `ticket:<id>`: a ticket page opened (`document:opened`, any day).
 *
 * A chore is known at `choreDays` distinct days in four weeks (`read/chores.ts`). The offer waits for
 * today's trigger, an event, never a clock:
 *   - the day's first tab on a known morning site that is not the code host, while the code host is a
 *     known chore not yet visited today: "Show the pull requests" (`gnomon_pull_requests`);
 *   - the day's first ticket opened, while known tickets that were also open a week ago today are not
 *     open yet: "Show the N tickets" (`gnomon_tickets`).
 * Each is an anticipatory `notice:candidate` with an `offer` (Round 4), at most one of each a day, and a
 * `chore:offered` row so the go rate (`notice:offer-taken` over offers) can be read; trust it at n ≥ 20.
 * A host chore reaching its count is kept as `crossed`, the seed the workbench's rule idea waits for.
 */
export const MAX_CHORES = 64;
export const MAX_CHORE_DAYS = 14;
/** A workday morning ends here: a site first opened later is the day's work, not the sweep. */
export const MORNING_ENDS_MIN = 12 * 60;
export const MAX_OFFERED_TICKETS = 5;
/** An offer's value half-life: the morning moves on. Past the gate's urgent line (2 h), so it is a list row, never an interruption. */
export const CHORE_OFFER_LIFE_MS = 3 * 60 * 60 * 1000;
const CODE_HOST = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$|^gitlab\./;
const TICKET_KINDS = new Set(['jira-ticket', 'linear']);
const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Chores = NonNullable<KernelState['chores']>;
const EMPTY: Chores = { keys: {}, offered: {}, crossed: null };

const shift = (day: string, days: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const clock = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Today's first visit added to a chore; the weakest key (fewest recent days, then the stalest) leaves past `MAX_CHORES`. */
function bump(chores: Chores, key: string, day: string, minute: number): Chores {
  const was: ChoreCounter = chores.keys[key] ?? { days: [], minutes: [] };
  const counter = { days: [...was.days, day].slice(-MAX_CHORE_DAYS), minutes: [...was.minutes, minute].slice(-MAX_CHORE_DAYS) };
  const keys = { ...chores.keys, [key]: counter };
  const over = Object.keys(keys).length - MAX_CHORES;
  if (over > 0) {
    const weakest = Object.entries(keys)
      .filter(([k]) => k !== key)
      .sort(([, a], [, b]) => recentDays(a, day).length - recentDays(b, day).length || (a.days.at(-1) ?? '').localeCompare(b.days.at(-1) ?? ''))
      .slice(0, over);
    for (const [k] of weakest) delete keys[k];
  }
  return { ...chores, keys };
}

function offerEffects(event: SanitizedEvent, offered: { family: string; key: string; days: number; items: string[]; observation: string; evidence: string[]; offer: NoticeOffer }): Effect[] {
  const noticeKey = `chore:${offered.family}`;
  return [
    { type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'chore-learn', noticeKey), type: 'notice:candidate', ts: event.ts, payload: { timestamp: event.ts, shape: 'anticipatory', kind: 'chore', key: noticeKey, surprise: 1, precision: 1, valueHalfLifeMs: CHORE_OFFER_LIFE_MS, plain: true, observation: offered.observation, evidence: offered.evidence, concerns: [], offer: offered.offer } } },
    { type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'chore-learn', 'offered', noticeKey), type: 'chore:offered', ts: event.ts, payload: { timestamp: event.ts, key: offered.key, days: offered.days, items: offered.items, noticeKey, tool: offered.offer.tool } } },
  ];
}

/** The day's first tab on a known morning site: the code host's pull requests, when it is a known chore not yet visited. */
function onTab(state: KernelState, chores: Chores, event: SanitizedEvent, host: string, day: string, minute: number): { state: KernelState; effects: Effect[] } {
  const key = `host:${host}`;
  if (chores.keys[key]?.days.includes(day)) return { state, effects: [] };
  const need = choreDaysNeeded(state);
  const known = (k: string) => recentDays(chores.keys[k], shift(day, -1)).length >= need;
  let next = bump(chores, key, day, minute);
  if (recentDays(next.keys[key], day).length === need) next = { ...next, crossed: { key, days: need, at: event.ts } };
  const code = CODE_HOST.test(host) || chores.offered.prs === day || chores.dismissed?.includes('prs') || !known(key)
    ? undefined
    : Object.keys(chores.keys).filter((k) => k.startsWith('host:') && CODE_HOST.test(k.slice(5)) && known(k) && !chores.keys[k]!.days.includes(day)).sort((a, b) => recentDays(chores.keys[b], day).length - recentDays(chores.keys[a], day).length)[0];
  if (!code) return { state: { ...state, chores: next }, effects: [] };
  const counter = chores.keys[code]!;
  const days = recentDays(counter, day).length;
  const usual = clock(usualMinute(counter));
  return {
    state: { ...state, chores: { ...next, offered: { ...next.offered, prs: day } } },
    effects: offerEffects(event, {
      family: 'prs',
      key: code,
      days,
      items: [code.slice(5)],
      observation: `You go to ${code.slice(5)} most workday mornings (${days} in the last four weeks), usually around ${usual}. The pull requests waiting, in one press?`,
      evidence: [`${code.slice(5)}: first visit on ${days} workday mornings in four weeks`, `today's morning started on ${host}`],
      offer: { tool: 'gnomon_pull_requests', args: {}, label: 'Show the pull requests', n: days },
    }),
  };
}

/** The day's first ticket: the known tickets that were also open a week ago today, not open yet. */
function onTicket(state: KernelState, chores: Chores, event: SanitizedEvent, id: string, day: string, minute: number): { state: KernelState; effects: Effect[] } {
  const key = `ticket:${id}`;
  if (chores.keys[key]?.days.includes(day)) return { state, effects: [] };
  const firstToday = !Object.entries(chores.keys).some(([k, c]) => k.startsWith('ticket:') && c.days.includes(day));
  const next = bump(chores, key, day, minute);
  if (!firstToday || chores.offered.tickets === day || chores.dismissed?.includes('tickets')) return { state: { ...state, chores: next }, effects: [] };
  const need = choreDaysNeeded(state);
  const weekAgo = shift(day, -7);
  const due = Object.entries(chores.keys)
    .filter(([k, c]) => k.startsWith('ticket:') && k !== key && c.days.includes(weekAgo) && recentDays(c, shift(day, -1)).length >= need)
    .sort(([, a], [, b]) => (b.days.at(-1) ?? '').localeCompare(a.days.at(-1) ?? ''))
    .slice(0, MAX_OFFERED_TICKETS);
  if (due.length === 0) return { state: { ...state, chores: next }, effects: [] };
  const ids = due.map(([k]) => k.slice('ticket:'.length));
  const n = ids.length;
  const weekday = WEEKDAYS[localWeekday(event.ts, state.config.timezone)]!;
  const days = Math.min(...due.map(([, c]) => recentDays(c, shift(day, -1)).length));
  return {
    state: { ...state, chores: { ...next, offered: { ...next.offered, tickets: day } } },
    effects: offerEffects(event, {
      family: 'tickets',
      key: 'tickets',
      days,
      items: ids,
      observation: `The ${n === 1 ? 'ticket' : `${n} tickets`} you come back to on ${weekday}s: ${ids.join(', ')}.`,
      evidence: due.map(([k, c]) => `${k.slice('ticket:'.length)}: opened on ${recentDays(c, shift(day, -1)).length} days in four weeks, a week ago today among them`),
      offer: { tool: 'gnomon_tickets', args: { ids }, label: `Show the ${n === 1 ? 'ticket' : `${n} tickets`}`, n: days },
    }),
  };
}

/** Single writer of `state.chores`. Wrapped in `ownerOnly`. */
export const choreLearn: Rule = (state, event) => {
  const chores = state.chores ?? EMPTY;
  const zone = state.config.timezone;
  // Set 5 R3: "Not again" on the proposals card: that offer (`prs`, `tickets`) is never made again.
  if (event.type === 'proposal:answered' && event.payload.kind === 'chore' && (event.payload.key === 'prs' || event.payload.key === 'tickets') && event.payload.verdict === 'dismissed') {
    const family = event.payload.key;
    return chores.dismissed?.includes(family) ? { state, effects: [] } : { state: { ...state, chores: { ...chores, dismissed: [...(chores.dismissed ?? []), family] } }, effects: [] };
  }
  if (event.type === 'day:boundary') {
    const today = localDate(event.ts, zone);
    const keys = Object.fromEntries(
      Object.entries(chores.keys)
        .map(([k, c]) => {
          const kept = new Set(recentDays(c, today));
          return [k, { days: c.days.filter((d) => kept.has(d)), minutes: c.minutes.filter((_, i) => kept.has(c.days[i]!)) }] as const;
        })
        .filter(([, c]) => c.days.length > 0),
    );
    return state.chores ? { state: { ...state, chores: { ...chores, keys } }, effects: [] } : { state, effects: [] };
  }
  if (event.type === 'browser:tab') {
    const host = str(event.payload.host).toLowerCase();
    const minute = localMinuteOfDay(event.ts, zone);
    if (host === '' || minute >= MORNING_ENDS_MIN || !(state.config.workdays ?? DEFAULT_WORKDAYS).includes(localWeekday(event.ts, zone))) return { state, effects: [] };
    return onTab(state, chores, event, host, localDate(event.ts, zone), minute);
  }
  if (event.type === 'document:opened') {
    const id = str(event.payload.id).toUpperCase();
    if (id === '' || !TICKET_KINDS.has(str(event.payload.kind))) return { state, effects: [] };
    return onTicket(state, chores, event, id, localDate(event.ts, zone), localMinuteOfDay(event.ts, zone));
  }
  return { state, effects: [] };
};

/** The rows a rebuild reads: the chores, the owner's "not again", and the screen-act rows `byGnomon` marks Gnomon's own tabs by. */
export const CHORE_REBUILD_TYPES = ['browser:tab', 'document:opened', 'proposal:answered', 'window:changed', 'screen:acted', 'screen:step', 'action:decided', 'approval:answered', 'action:performed'];

/**
 * Set 5 R3: `state.chores` folded from history rows (log order), for a boot whose snapshot holds none: after a deploy
 * the counters started empty, and no offer could fire for three workdays. The same two rules the manifest runs (the
 * `byGnomon` mark, then `choreLearn` on owner rows only); the offers are left unsaid. Call it page by page on the
 * state it returns, starting from `choresCleared(state)`.
 */
export function foldChoreRows(state: KernelState, rows: Iterable<SanitizedEvent>): KernelState {
  let s = state;
  for (const row of rows) {
    s = byGnomon(s, row).state;
    if (byGnomonMarked(s, row) === null) s = choreLearn(s, row).state;
  }
  return s;
}

/** No counters, no offers; a "not again" already held is kept. */
export const choresCleared = (state: KernelState): KernelState => ({ ...state, chores: { ...EMPTY, ...(state.chores?.dismissed ? { dismissed: state.chores.dismissed } : {}) } });
