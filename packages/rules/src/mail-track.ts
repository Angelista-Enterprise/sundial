import type { KernelState, Rule } from '@sundial/kernel/types.js';

const MAX_RECENT = 20;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Subjects of mail received in the last `windowMs`, newest first — evidence for the fan-out, never bodies. */
export function recentMailSubjects(state: KernelState, now: string, windowMs = 3 * 3_600_000, max = 5): string[] {
  const since = Date.parse(now) - windowMs;
  return [...(state.mail?.recent ?? [])].filter((m) => Date.parse(m.at) >= since).reverse().slice(0, max).map((m) => m.subject);
}

/**
 * J3.6 — mail and messages as the readers report them: `mail:received`
 * (from, subject), `message:received` (from, chat, fromMe), `mail:status`
 * (accessible). Senders arrive already sanitized (an address is a
 * `person-<hash>` after ingest); bodies never enter the log at all. Bounded
 * rings, no effects.
 */
export const mailTrack: Rule = (state, event) => {
  const mail = state.mail ?? { recent: [], messages: [], accessible: null };
  if (event.type === 'mail:status') {
    const accessible = (event.payload as { accessible?: unknown }).accessible;
    if (typeof accessible !== 'boolean' || accessible === mail.accessible) return { state, effects: [] };
    return { state: { ...state, mail: { ...mail, accessible } }, effects: [] };
  }
  if (event.type === 'mail:received') {
    const p = event.payload as { from?: unknown; subject?: unknown; timestamp?: unknown };
    const subject = text(p.subject, 200);
    if (subject === '') return { state, effects: [] };
    const at = typeof p.timestamp === 'string' && Number.isFinite(Date.parse(p.timestamp)) ? p.timestamp : event.ts;
    return { state: { ...state, mail: { ...mail, accessible: true, recent: [...mail.recent, { from: text(p.from, 120) || 'unknown', subject, at }].slice(-MAX_RECENT) } }, effects: [] };
  }
  if (event.type === 'message:received') {
    const p = event.payload as { from?: unknown; chat?: unknown; fromMe?: unknown; timestamp?: unknown };
    const from = text(p.from, 120);
    if (from === '') return { state, effects: [] };
    const at = typeof p.timestamp === 'string' && Number.isFinite(Date.parse(p.timestamp)) ? p.timestamp : event.ts;
    return { state: { ...state, mail: { ...mail, accessible: true, messages: [...mail.messages, { from, chat: text(p.chat, 120) || null, fromMe: p.fromMe === true, at }].slice(-MAX_RECENT) } }, effects: [] };
  }
  return { state, effects: [] };
};
