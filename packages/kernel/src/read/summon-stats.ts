// Plan 15 step 2: what the owner did first after each summon, and how often the guess held, from the log.
import { getAllSignalsInRange } from '@sundial/db/index.js';

const CAME_FOR_IT = new Set(['type', 'look', 'talk']);

export interface SummonStats {
  days: number;
  summons: number;
  /** Times the owner attached the place with the chip. */
  placeAdded: number;
  moves: { move: string; n: number }[];
  /** Per sign that was the guess: `hits` = the first move was to type, look or talk. */
  guesses: { sign: string; n: number; hits: number }[];
}

export async function readSummonStats({ now, days = 30 }: { now: number; days?: number }): Promise<SummonStats> {
  const signals = await getAllSignalsInRange(new Date(now - days * 86_400_000).toISOString(), new Date(now + 1).toISOString(), ['overlay']);
  const moves = new Map<string, number>();
  const guesses = new Map<string, { sign: string; n: number; hits: number }>();
  let placeAdded = 0;
  for (const s of signals) {
    const type = `${s.signalType}:${s.eventType}`;
    if (type === 'overlay:place-added') placeAdded += 1;
    if (type !== 'overlay:settled') continue;
    const move = String(s.data.firstMove ?? '');
    moves.set(move, (moves.get(move) ?? 0) + 1);
    if (typeof s.data.guess !== 'string') continue;
    const row = guesses.get(s.data.guess) ?? { sign: s.data.guess, n: 0, hits: 0 };
    row.n += 1;
    if (CAME_FOR_IT.has(move)) row.hits += 1;
    guesses.set(row.sign, row);
  }
  const rows = [...moves].map(([move, n]) => ({ move, n })).sort((a, b) => b.n - a.n || a.move.localeCompare(b.move));
  return { days, summons: rows.reduce((n, r) => n + r.n, 0), placeAdded, moves: rows, guesses: [...guesses.values()].sort((a, b) => b.n - a.n || a.sign.localeCompare(b.sign)) };
}
