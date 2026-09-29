/**
 * Lane B (#17) — mail that matters. A mail from someone the owner owes, or who
 * owes the owner, is said in passing: "Mira Bakker replied about the numbers".
 *
 * What the mail does to the promise is `promiseTrack`'s (`mailBearing`): a fresh
 * mail naming the thing keeps what they owed; a reply in the thread, or mail
 * about what the owner owes, is cited and closes nothing. This rule only tells
 * the owner, through the gate, and so it runs BEFORE `promiseTrack` — it reads
 * the promise before this mail can close it.
 *
 * Mail from them about something else is said only when the owner owes them
 * something due within two days: the moment they are on the owner's mind.
 */
import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import type { Rule } from '@sundial/kernel/types.js';
import { mailBearing, whoOf } from './promise-track.js';

/** Mail about something else is worth a line only this close to what the owner owes them. */
export const CONTACT_DUE_WITHIN_MS = 2 * 86_400_000;
const RANK = { keeps: 0, about: 1, contact: 2 } as const;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export const mailMatters: Rule = (state, event) => {
  if (event.type !== 'mail:received' || state.commitments.promises.length === 0) return { state, effects: [] };
  const p = event.payload as { from?: unknown; subject?: unknown };
  const from = str(p.from);
  const subject = str(p.subject).slice(0, 120);
  const now = Date.parse(event.ts);
  const hit = state.commitments.promises
    .map((c) => ({ c, bearing: mailBearing(c, from, subject) }))
    .filter((h): h is { c: (typeof h)['c']; bearing: 'keeps' | 'about' | 'contact' } => {
      if (h.bearing === null) return false;
      if (h.bearing !== 'contact') return true;
      const terms = h.c.promise!;
      return terms.direction !== 'awaiting' && !!terms.due && Date.parse(terms.due) - now <= CONTACT_DUE_WITHIN_MS;
    })
    .sort((a, b) => RANK[a.bearing] - RANK[b.bearing])[0];
  if (!hit) return { state, effects: [] };

  const terms = hit.c.promise!;
  const who = whoOf(state, from) ?? 'They';
  const quoted = `“${subject || '(no subject)'}”`;
  const observation =
    hit.bearing === 'keeps'
      ? `${who} sent ${terms.deliverable}: ${quoted}. Kept.`
      : hit.bearing === 'about'
        ? terms.direction === 'awaiting'
          ? `${who} replied about ${terms.deliverable}: ${quoted}. Open until it arrives.`
          : `${who} wrote about ${terms.deliverable}, which you owe them: ${quoted}.`
        : `Mail from ${who}: ${quoted}. You owe them ${terms.deliverable}, due ${localDate(terms.due!, state.config.timezone)}.`;
  return {
    state,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'mail-matters', hit.c.id),
          type: 'notice:candidate',
          ts: event.ts,
          payload: {
            timestamp: event.ts,
            shape: 'transition',
            kind: 'mail-matters',
            // Per person: the gate learns how the owner takes hearing about THEM.
            key: `mail-matters:${from}`,
            surprise: hit.bearing === 'about' ? 1.2 : hit.bearing === 'keeps' ? 1 : 0.9,
            precision: terms.confirmed ? 1 : 0.8,
            valueHalfLifeMs: null,
            plain: true,
            observation,
            evidence: [`"${terms.quote}"`, 'the subject only; mail bodies are not read'],
            concerns: [hit.c.id],
          },
        },
      },
    ],
  };
};
