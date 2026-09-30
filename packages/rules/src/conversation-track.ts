import { deriveId } from '@sundial/helpers/derive-id.js';
import type { ChatSession, ChatTurn, Effect, KernelState, Rule, SaidFact, ShownFact } from '@sundial/kernel/types.js';
import { promisesInTurns } from './conversation-extract.js';

/**
 * W1: the chat, in the log. The single writer of `state.conversation`, and it
 * reacts only to `chat:*`:
 *
 *   chat:shown  — the brief a turn was given (`gnomonKernel.brief()`): its facts and why the turn happened
 *   chat:owner  — the owner's words (the chat recorder)
 *   chat:said   — Gnomon's reply and the tools it called (the chat recorder)
 *   chat:forget — a thread deleted
 *
 * On `chat:said` each fact the session was shown is checked against the reply,
 * deterministically: a number of two or more digits as a whole word, or a
 * `name` of four or more characters, case-insensitive. A match goes on `said`,
 * which is what `loopTrack` reads to follow up on what Gnomon actually told the
 * owner rather than on everything it was shown. Two digits because small numbers
 * are everywhere in prose; the precision of the match is measured, not assumed.
 *
 * `chat:owner` also opens the promises the owner stated outright, with the same
 * id the nightly pass mints (`deriveId(at, sessionId, 'chat-promise', sentence)`),
 * so the two paths open nothing twice while both run.
 */

export const MAX_SESSIONS = 12;
export const MAX_TURNS = 6;
export const MAX_SAID = 50;
const TURN_CHARS = 280;
const MIN_NAME_CHARS = 4;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The tokens a fact can be recognised by: its whole numbers of two or more digits, and its `name` leaves. */
function marks(value: unknown, key = ''): (string | number)[] {
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) >= 10 ? [value] : [];
  if (typeof value === 'string') return key === 'name' && value.trim().length >= MIN_NAME_CHARS ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((v) => marks(v, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => marks(v, k));
  return [];
}

/** Which shown facts a reply names, each (key, token) once. */
export function mentioned(facts: readonly ShownFact[], reply: string): { key: string; value: string | number }[] {
  const out: { key: string; value: string | number }[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    for (const mark of marks(fact.value)) {
      const id = `${fact.key}\u0000${mark}`;
      if (seen.has(id)) continue;
      const re = typeof mark === 'number' ? new RegExp(`(?<![\\d.,])${mark}(?![\\d]|[.,]\\d)`) : new RegExp(`(?<![\\w-])${escape(mark)}(?![\\w-])`, 'i');
      if (!re.test(reply)) continue;
      seen.add(id);
      out.push({ key: fact.key, value: mark });
    }
  }
  return out;
}

function withSession(state: KernelState, sessionId: string, at: string, change: (s: ChatSession) => ChatSession): KernelState {
  const prior = state.conversation.sessions[sessionId] ?? { lastAt: at, shown: null, cause: null, turns: [] };
  const sessions = { ...state.conversation.sessions, [sessionId]: { ...change(prior), lastAt: at } };
  const ids = Object.keys(sessions);
  if (ids.length > MAX_SESSIONS) {
    const oldest = ids.filter((id) => id !== sessionId).sort((a, b) => (sessions[a].lastAt < sessions[b].lastAt ? -1 : 1))[0];
    delete sessions[oldest];
  }
  return { ...state, conversation: { ...state.conversation, sessions } };
}

const pushTurn = (s: ChatSession, turn: ChatTurn): ChatSession => ({ ...s, turns: [...s.turns, turn].slice(-MAX_TURNS) });

export const conversationTrack: Rule = (state, event) => {
  if (!event.type.startsWith('chat:')) return { state, effects: [] };
  const p = event.payload as Record<string, unknown>;
  const sessionId = str(p.sessionId);
  if (sessionId === '') return { state, effects: [] };

  if (event.type === 'chat:forget') {
    // W1 step 8: the thread's rows go from the log and the ledger at once, not at the 30-day horizon.
    const effects: Effect[] = [{ type: 'DeleteRows', olderThan: event.ts, signalTypes: ['chat'], sessionId }];
    if (!state.conversation.sessions[sessionId]) return { state, effects };
    const sessions = { ...state.conversation.sessions };
    delete sessions[sessionId];
    return { state: { ...state, conversation: { sessions, said: state.conversation.said.filter((s) => s.sessionId !== sessionId) } }, effects };
  }

  if (event.type === 'chat:shown') {
    const briefId = str(p.briefId) || event.id;
    const facts: ShownFact[] = (Array.isArray(p.facts) ? p.facts : [])
      .filter((f): f is { key: string; value: Record<string, unknown> } => typeof f?.key === 'string' && typeof f.value === 'object' && f.value !== null)
      .map((f) => ({ key: f.key, value: f.value }));
    const cause = (p.cause ?? {}) as Record<string, unknown>;
    return {
      state: withSession(state, sessionId, event.ts, (s) => ({ ...s, shown: { briefId, facts }, cause: { noticeKey: str(cause.noticeKey) || null, askId: str(cause.askId) || null } })),
      effects: [],
    };
  }

  const turnId = str(p.turnId) || event.id;
  const text = str(p.text);

  if (event.type === 'chat:owner') {
    const next = withSession(state, sessionId, event.ts, (s) => pushTurn(s, { at: event.ts, by: 'owner', turnId, text: text.slice(0, TURN_CHARS) }));
    // The owner's stated promises, opened without a model (UC1, moved here from the nightly pass).
    const effects: Effect[] = promisesInTurns([{ sessionId, at: event.ts, text }], state.config.timezone).map((found, i) => ({
      type: 'EmitEvent',
      event: {
        id: deriveId(event.ts, event.id, 'conversation-track', `promise:${i}`),
        type: 'commitment:heard',
        ts: event.ts,
        payload: { source: 'chat', id: `commitment:promise:${deriveId(found.turn.at, found.turn.sessionId, 'chat-promise', found.sentence)}`, direction: 'owner', counterparty: found.counterparty, deliverable: found.deliverable, dueText: found.dueText, quote: found.sentence },
      },
    }));
    return { state: next, effects };
  }

  if (event.type === 'chat:said') {
    const session = state.conversation.sessions[sessionId];
    const shownId = session?.shown?.briefId ?? null;
    const hits: SaidFact[] = mentioned(session?.shown?.facts ?? [], text).map((m) => ({ ...m, at: event.ts, sessionId, turnId }));
    const next = withSession(state, sessionId, event.ts, (s) => pushTurn(s, { at: event.ts, by: 'gnomon', turnId, text: text.slice(0, TURN_CHARS), shownId }));
    if (hits.length === 0) return { state: next, effects: [] };
    return { state: { ...next, conversation: { ...next.conversation, said: [...next.conversation.said, ...hits].slice(-MAX_SAID) } }, effects: [] };
  }

  return { state, effects: [] };
};
