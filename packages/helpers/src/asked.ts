/**
 * Whether a question was answered a moment ago — the one predicate that stops
 * Gnomon asking the same thing twice.
 *
 * Two readers, one definition: the `ownerAsk` rule refuses to OPEN a repeat,
 * and the `gnomon_ask_owner` tool refuses to MINT one, handing the model the
 * earlier answer instead. On 2026-09-07 the companion lost an ask id, opened a
 * new ask with the same words to recover one, and the owner heard the meeting
 * question a second time. A copy of this in each reader was the first fix, and
 * a copy is how the two would have drifted apart again.
 */

export interface AnsweredQuestion {
  askId: string;
  question: string;
  answer: string;
  answeredAt: string;
}

/**
 * Six hours: the day a meeting question lives in. A day later the same words
 * are a new question about a new meeting.
 */
export const REASK_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Two questions are the same when they read the same, ignoring case, spacing and punctuation. */
export function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[“”"'.?!]/g, '').trim();
  return norm(a) === norm(b);
}

/** The answered question this one repeats, inside the window, or null. */
export function recentlyAnswered(recent: readonly AnsweredQuestion[] | undefined, question: string, nowIso: string): AnsweredQuestion | null {
  const now = Date.parse(nowIso);
  for (const entry of recent ?? []) {
    if (now - Date.parse(entry.answeredAt) > REASK_WINDOW_MS) continue;
    if (sameQuestion(entry.question, question)) return entry;
  }
  return null;
}
