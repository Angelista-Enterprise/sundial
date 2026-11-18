import { localDate } from '@sundial/helpers/local-day.js';

// The chat voice itself lives in `../persona.ts` (`chatParts`), rendered per
// access since step 6 of the provider plan; the old name stays for its readers.
export { ASK_SYSTEM_PROMPT } from '../persona.js';

/**
 * Today's date, stated outright, because the model does not have a clock.
 *
 * Every tool that takes a `date` defaults to today when it is omitted, so this
 * was invisible until a question said "yesterday" — at which point the model had
 * to guess a calendar date, guessed 2026-07-29 on a day that was actually
 * 2026-08-02, passed the guess to `gnomon_today_summary`, got an empty result,
 * and truthfully reported that nothing was tracked yesterday. Every part of that
 * chain behaved correctly and the answer was still wrong.
 *
 * `yesterday` is spelled out alongside `today` rather than left as arithmetic:
 * the failure mode is a model doing date maths badly, and handing it both
 * removes the arithmetic from the one place it demonstrably slips. The weekday
 * is included because "last Tuesday" is a question people actually ask.
 */
export function nowLine(now: Date, timeZone: string): string {
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const today = localDate(now.toISOString(), timeZone);
  const yesterday = localDate(new Date(now.getTime() - 86_400_000).toISOString(), timeZone);
  return `Right now it is ${stamp} (${timeZone}). Today is ${today}; yesterday was ${yesterday}. Every tool's \`date\` argument is YYYY-MM-DD in this timezone.`;
}
