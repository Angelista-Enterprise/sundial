import type { ChoreCounter, KernelState } from '../types.js';

/**
 * Round 5 (FORESIGHT 4a): reading `state.chores`, for `choreLearn` and the rule miner.
 *
 * The count a chore needs when config names none (`choreDays`). Sized 2026-11-15 by replaying the
 * owner's own tabs and ticket opens of the eight weeks before the rig days through the built rule: at
 * 3 days, 12 of 17 pull request offers came on a morning the owner went on to the code host (4 days:
 * 10 of 15), and 6 of 10 ticket offers named a ticket re-opened that day (4 days: 2 of 6). n is small.
 */
export const DEFAULT_CHORE_DAYS = 3;
/** Days counted back from today: a chore not done in four weeks is not one any more. */
export const CHORE_HORIZON_DAYS = 28;

const shift = (day: string, days: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The days a chore was done in the four weeks up to and including `today` (an owner-local date). */
export function recentDays(counter: ChoreCounter | undefined, today: string): string[] {
  const from = shift(today, -CHORE_HORIZON_DAYS);
  return (counter?.days ?? []).filter((d) => d > from && d <= today);
}

/** The usual minute of the day's first visit: the median of the days kept. */
export function usualMinute(counter: ChoreCounter): number {
  const sorted = [...counter.minutes].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The distinct days a chore needs before it is known. */
export const choreDaysNeeded = (state: Pick<KernelState, 'config'>): number => state.config.choreDays ?? DEFAULT_CHORE_DAYS;

/** The host chores known on `today`, with their days and usual first minute: the rule miner's weekday seeds. */
export function knownHostChores(state: Pick<KernelState, 'config' | 'chores'>, today: string): { host: string; days: number; minute: number }[] {
  const need = choreDaysNeeded(state);
  return Object.entries(state.chores?.keys ?? {})
    .filter(([key, c]) => key.startsWith('host:') && recentDays(c, today).length >= need)
    .map(([key, c]) => ({ host: key.slice('host:'.length), days: recentDays(c, today).length, minute: usualMinute(c) }));
}
