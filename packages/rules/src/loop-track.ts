import { createHash } from 'node:crypto';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { formatClock, localDate } from '@sundial/helpers/local-day.js';
import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js';
import { matchesWatch } from '@sundial/kernel/watch.js';
import type { Effect, KernelState, LoopsState, OpenLoop, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { closeLoop } from '@sundial/helpers/loops.js';
import { foldProposal } from './assistant-track.js';
import { foldOwnerAsk } from './owner-ask.js';
import { foldWakeup } from './loop-wakeup.js';

/**
 * W2: open loops, and the one line Gnomon adds when one resolves. The single
 * writer of `state.loops`.
 *
 * A loop is something raised that Gnomon will say one more thing about: "263
 * commits not pushed" said in a chat becomes a loop that resolves when the push
 * lands, and the resolution is a `notice:candidate` addressed to that chat
 * (`sessionId`). It goes through the gate like everything else — a line in the
 * thread, never a push or a banner — and its delivery comes back as
 * `notice:delivered` / `notice:dropped`, folded here into `said` / `unsaid`.
 *
 *   loop:opened  — an opener fired (below), or a tool or rule opened one; folded here
 *   any event    — each open loop whose `resolve.when` matches counts down `left` or resolves
 *   clock:tick   — a loop past `expiresAt` expires, silently
 *
 * The caps are the design, not tuning: a loop opens only when Gnomon SAID the
 * thing (it is shown on every turn); one open loop per kind and subject, a later
 * mention moving it to the newer chat; at most two follow-up lines per chat per
 * local day; expiry says nothing; and the notice key carries the subject, so
 * habituation quiets a repeat (2.0, then 0.8, then 0.32).
 *
 * After `conversationTrack` (it reads `conversation.said` on the same
 * `chat:said`) and `gitAheadTrack` (it reads `git.unpushed` on the same
 * `git:status`), before the gate.
 */

export const MAX_OPEN_LOOPS = 20;
export const MAX_FOLLOWUPS_PER_DAY = 2;
/** Asked-for in effect: Gnomon raised it, so its value is not in question, only its timing. Same reasoning as a wake-up's. */
const FOLLOWUP_SURPRISE = 2.0;
/** Above the gate's two-hour urgent line: tonic, a line, never an interruption. */
const FOLLOWUP_HALF_LIFE_MS = 4 * 60 * 60 * 1000;

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Opened = Pick<OpenLoop, 'subject' | 'about' | 'resolve' | 'seen'>;

/** An opener: which said fact starts a loop of its kind, and how that loop reads. Shaped like `OCCURRENCE_STREAMS`. */
export interface LoopOpener {
  kind: string;
  factKey: string;
  /** The reply must speak of this kind of thing: a fact's name alone (a repo named after its product) is not a mention of it. */
  cue: RegExp;
  ttlMs: number;
  /** The loops, from the value the fact was shown with and the marks the reply said it by (`conversation.said` values). */
  open(value: Record<string, unknown>, marks: readonly (string | number)[]): Opened[];
  /** Whether a `by` value is already settled (the thing happened before the turn ended). */
  settled(state: KernelState, value: string): boolean;
  line(loop: OpenLoop, resolvedAt: string, timeZone: string): { observation: string; evidence: string[] };
}

export const LOOP_OPENERS: LoopOpener[] = [
  {
    kind: 'unpushed',
    factKey: 'git.unpushed',
    cue: /\b(?:push|pushed|pushing|unpushed|ahead|commits?)\b/i,
    ttlMs: 12 * 60 * 60 * 1000,
    // One loop per repo the reply named (by name, or by its own count); every repo when it said only the total.
    // A repo Gnomon did not name is not followed up, and one still ahead never holds back another's line.
    open(value, marks) {
      const repos = (Array.isArray(value.repos) ? value.repos : []).filter((r): r is { cwd: string; ahead: number } => typeof r?.cwd === 'string' && typeof r.ahead === 'number');
      const said = new Set(marks.map((m) => String(m).toLowerCase()));
      const named = repos.filter((r) => said.has(basename(r.cwd).toLowerCase()) || said.has(String(r.ahead)));
      const total = repos.reduce((sum, r) => sum + r.ahead, 0);
      return (named.length === 0 || said.has(String(total)) ? repos : named).map((r) => ({
        subject: r.cwd,
        about: `${plural(r.ahead, 'commit')} not pushed in ${basename(r.cwd)}`,
        resolve: { when: { type: 'git:status', where: [{ field: 'cwd', op: 'in', value: [r.cwd] }, { field: 'ahead', op: 'eq', value: 0 }] }, by: 'cwd', left: [r.cwd] },
        seen: { [r.cwd]: r.ahead },
      }));
    },
    settled: (state, cwd) => !state.git.unpushed[cwd],
    line(loop, resolvedAt, timeZone) {
      const names = Object.keys(loop.seen).map(basename);
      const total = Object.values(loop.seen).reduce((sum, n) => sum + n, 0);
      return {
        observation: `Pushed: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} up to date (${plural(total, 'commit')} ${total === 1 ? 'was' : 'were'} waiting).`,
        evidence: [`you raised this here at ${formatClock(loop.openedAt, timeZone)}`, `git status ${formatClock(resolvedAt, timeZone)} shows 0 ahead`],
      };
    },
  },
];

const openerOf = (kind: string) => LOOP_OPENERS.find((o) => o.kind === kind);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const emit = (event: SanitizedEvent, part: string, type: string, payload: Record<string, unknown>): Effect => ({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'loop-track', part), type, ts: event.ts, payload } });

/** `saidToday` rolled to the owner's day of `ts`. */
function today(loops: LoopsState, ts: string, timeZone: string): LoopsState {
  const day = localDate(ts, timeZone);
  return loops.day === day ? loops : { ...loops, day, saidToday: {} };
}

const close = (loops: LoopsState, loop: OpenLoop): LoopsState => closeLoop(loops, loop);

/** A loop whose thing happened: one line to its chat, or none past the day's cap. */
function resolve(state: KernelState, loops: LoopsState, loop: OpenLoop, event: SanitizedEvent): { loops: LoopsState; effects: Effect[] } {
  const tz = state.config.timezone;
  const rolled = today(loops, event.ts, tz);
  const session = loop.target.sessionId ?? COMPANION_SESSION_ID;
  if ((rolled.saidToday[session] ?? 0) >= MAX_FOLLOWUPS_PER_DAY) {
    return { loops: close(rolled, { ...loop, status: 'unsaid' }), effects: [emit(event, `resolved:${loop.id}`, 'loop:resolved', { loopId: loop.id, byEventId: event.id, said: false, reason: 'cap' })] };
  }
  const opener = openerOf(loop.kind);
  const line = opener ? opener.line(loop, event.ts, tz) : { observation: `Resolved: ${loop.about}.`, evidence: [] };
  const noticeKey = `followup:${loop.kind}:${hash(loop.subject)}`;
  return {
    loops: close(rolled, { ...loop, status: 'resolved', noticeKey, line }),
    effects: [emit(event, `resolved:${loop.id}`, 'loop:resolved', { loopId: loop.id, byEventId: event.id, said: true }), emit(event, `followup:${loop.id}`, 'notice:candidate', candidate(loop, noticeKey, line, event.ts, loop.target.sessionId))],
  };
}

function candidate(loop: OpenLoop, key: string, line: { observation: string; evidence: string[] }, ts: string, sessionId: string | null): Record<string, unknown> {
  return { timestamp: ts, shape: 'transition', kind: `followup:${loop.kind}`, key, surprise: FOLLOWUP_SURPRISE, precision: 1, valueHalfLifeMs: FOLLOWUP_HALF_LIFE_MS, observation: line.observation, evidence: line.evidence, concerns: [], plain: true, sessionId };
}

/** Fold one `loop:opened`: retarget the open loop on the same subject, or open it (settled at once when the thing already happened). */
function opened(state: KernelState, event: SanitizedEvent): { state: KernelState; effects: Effect[] } {
  const p = event.payload as Partial<OpenLoop>;
  const kind = str(p.kind);
  const subject = str(p.subject);
  if (kind === '' || subject === '' || typeof p.resolve?.when?.type !== 'string') return { state, effects: [] };
  let loops = state.loops;
  const target = { sessionId: typeof p.target?.sessionId === 'string' ? p.target.sessionId : null };
  const existing = loops.open.find((l) => l.kind === kind && l.subject === subject);
  if (existing) {
    const moved = { ...existing, target, about: str(p.about) || existing.about, seen: p.seen ?? existing.seen, openedAt: event.ts, expiresAt: str(p.expiresAt) || existing.expiresAt };
    return { state: { ...state, loops: { ...loops, open: loops.open.map((l) => (l.id === existing.id ? moved : l)) } }, effects: [] };
  }
  const opener = openerOf(kind);
  const left = (p.resolve.left ?? []).filter((v) => !opener?.settled(state, v));
  const loop: OpenLoop = {
    id: str(p.id) || deriveId(event.ts, event.id, 'loop', kind),
    origin: p.origin ?? 'tool',
    kind,
    subject,
    about: str(p.about),
    resolve: { ...p.resolve, ...(p.resolve.by ? { left } : {}) },
    seen: p.seen ?? {},
    target,
    openedAt: event.ts,
    expiresAt: str(p.expiresAt) || new Date(Date.parse(event.ts) + (opener?.ttlMs ?? 12 * 60 * 60 * 1000)).toISOString(),
    status: 'open',
  };
  // The push beat the turn's end: resolved as it opens.
  if (p.resolve.by && left.length === 0) {
    const done = resolve(state, loops, loop, event);
    return { state: { ...state, loops: done.loops }, effects: done.effects };
  }
  loops = { ...loops, open: [...loops.open, loop] };
  const effects: Effect[] = [];
  // Per kind: a kind folded elsewhere (a wake-up) keeps its own cap and never displaces a follow-up.
  while (loops.open.filter((l) => l.kind === kind).length > MAX_OPEN_LOOPS) {
    const oldest = loops.open.find((l) => l.kind === kind)!;
    loops = close(loops, { ...oldest, status: 'unsaid' });
    effects.push(emit(event, `expired:${oldest.id}`, 'loop:expired', { loopId: oldest.id, reason: 'displaced' }));
  }
  return { state: { ...state, loops }, effects };
}

/**
 * Kinds that keep their own events and their own close (W2 M1–M3): each fold owns its events and
 * returns null for the rest. The TTL sweep and the watch-language resolver below leave them alone.
 */
const KIND_FOLDS = [foldWakeup, foldProposal, foldOwnerAsk];
const OWNED = new Set(['wakeup', 'proposal', 'owner-ask']);

export const loopTrack: Rule = (state, event) => {
  // Every kind sees a tick (a wake-up due and an ask gone on the same one); an owned event stops at its kind.
  let owned = null as { state: KernelState; effects: Effect[] } | null;
  for (const fold of KIND_FOLDS) {
    const out = fold(owned?.state ?? state, event);
    if (out) owned = { state: out.state, effects: [...(owned?.effects ?? []), ...out.effects] };
  }
  if (owned === null) return loops(state, event);
  if (event.type !== 'clock:tick') return owned;
  const rest = loops(owned.state, event);
  return { state: rest.state, effects: [...owned.effects, ...rest.effects] };
};

/** The loops Gnomon raised itself (the follow-ups): opened, resolved through the watch language, expired. */
const loops: Rule = (state, event) => {
  if (event.type === 'loop:opened') return opened(state, event);

  // What Gnomon just said, through the openers.
  if (event.type === 'chat:said') {
    const sessionId = str(event.payload.sessionId);
    const said = state.conversation.said.filter((s) => s.sessionId === sessionId && s.at === event.ts);
    const shown = state.conversation.sessions[sessionId]?.shown?.facts ?? [];
    const effects: Effect[] = [];
    for (const opener of LOOP_OPENERS) {
      const marks = said.filter((s) => s.key === opener.factKey).map((s) => s.value);
      const fact = shown.find((f) => f.key === opener.factKey);
      if (marks.length === 0 || !fact || !opener.cue.test(str(event.payload.text))) continue;
      for (const spec of opener.open(fact.value as Record<string, unknown>, marks)) {
        const payload = { ...spec, id: deriveId(event.ts, event.id, 'loop', opener.kind, spec.subject), kind: opener.kind, origin: 'said', target: { sessionId }, expiresAt: new Date(Date.parse(event.ts) + opener.ttlMs).toISOString() };
        effects.push(emit(event, `open:${opener.kind}:${spec.subject}`, 'loop:opened', payload));
      }
    }
    return { state, effects };
  }

  // A follow-up's delivery, back from the plugin.
  if (event.type === 'notice:delivered' || event.type === 'notice:dropped') {
    const key = str(event.payload.noticeKey);
    const loop = [...state.loops.recent].reverse().find((l) => l.noticeKey === key && l.status === 'resolved');
    if (!loop) return { state, effects: [] };
    const tz = state.config.timezone;
    if (event.type === 'notice:delivered') {
      const loops = today(state.loops, event.ts, tz);
      const session = str(event.payload.sessionId) || COMPANION_SESSION_ID;
      const recent = loops.recent.map((l) => (l.id === loop.id ? { ...l, status: 'said' as const } : l));
      return { state: { ...state, loops: { ...loops, recent, saidToday: { ...loops.saidToday, [session]: (loops.saidToday[session] ?? 0) + 1 } } }, effects: [] };
    }
    // The chat is gone: the line goes to the conversation, once.
    if (str(event.payload.reason) === 'session-gone' && loop.target.sessionId !== null && loop.line) {
      const moved = { ...loop, target: { sessionId: null } };
      return {
        state: { ...state, loops: { ...state.loops, recent: state.loops.recent.map((l) => (l.id === loop.id ? moved : l)) } },
        effects: [emit(event, `fallback:${loop.id}`, 'notice:candidate', candidate(moved, key, loop.line, event.ts, null))],
      };
    }
    return { state: { ...state, loops: { ...state.loops, recent: state.loops.recent.map((l) => (l.id === loop.id ? { ...l, status: 'unsaid' as const } : l)) } }, effects: [] };
  }

  if (!state.loops.open.some((l) => !OWNED.has(l.kind))) return { state, effects: [] };

  // Time: past `expiresAt` goes quietly.
  if (event.type === 'clock:tick') {
    const now = Date.parse(event.ts);
    const expired = state.loops.open.filter((l) => !OWNED.has(l.kind) && Date.parse(l.expiresAt) <= now);
    if (expired.length === 0) return { state, effects: [] };
    const loops = expired.reduce((acc, l) => close(acc, { ...l, status: 'unsaid' }), state.loops);
    return { state: { ...state, loops }, effects: expired.map((l) => emit(event, `expired:${l.id}`, 'loop:expired', { loopId: l.id, reason: 'ttl' })) };
  }

  // Anything else may be what a loop was waiting for.
  let loops = state.loops;
  const effects: Effect[] = [];
  for (const loop of state.loops.open) {
    if (OWNED.has(loop.kind) || !matchesWatch(loop.resolve, event.type, event.payload, event.ts)) continue;
    const by = loop.resolve.by;
    if (by) {
      const value = String((event.payload as Record<string, unknown>)[by] ?? '').toLowerCase();
      const left = (loop.resolve.left ?? []).filter((v) => v.toLowerCase() !== value);
      if (left.length > 0) {
        loops = { ...loops, open: loops.open.map((l) => (l.id === loop.id ? { ...l, resolve: { ...l.resolve, left } } : l)) };
        continue;
      }
    }
    const done = resolve(state, loops, loop, event);
    loops = done.loops;
    effects.push(...done.effects);
  }
  return loops === state.loops ? { state, effects } : { state: { ...state, loops }, effects };
};
