// Plan 15 4.3: how often each stuck sign came, how often it was part of a stuck notice, and the owner's verdicts on those.
import { getAllSignalsInRange } from '@sundial/db/index.js';

export interface StuckStats {
  days: number;
  rows: { sign: string; seen: number; notices: number; useful: number; wrong: number }[];
}

export async function readStuckStats({ now, days = 30 }: { now: number; days?: number }): Promise<StuckStats> {
  const signals = await getAllSignalsInRange(new Date(now - days * 86_400_000).toISOString(), new Date(now + 1).toISOString(), ['stuck', 'notice', 'feedback']);
  const rows = new Map<string, StuckStats['rows'][number]>();
  const row = (sign: string) => rows.get(sign) ?? rows.set(sign, { sign, seen: 0, notices: 0, useful: 0, wrong: 0 }).get(sign)!;
  const signsOf = (key: unknown) => (typeof key === 'string' && key.startsWith('stuck:') ? key.slice(6).split('+') : []);
  for (const s of signals) {
    const type = `${s.signalType}:${s.eventType}`;
    if (type === 'stuck:sign' && typeof s.data.sign === 'string') row(s.data.sign).seen += 1;
    else if (type === 'notice:candidate' && s.data.kind === 'stuck') for (const sign of signsOf(s.data.key)) row(sign).notices += 1;
    else if (type === 'feedback:verdict' && s.data.artifactKind === 'notice')
      for (const sign of signsOf(s.data.artifactId)) {
        if (s.data.verdict === 'useful') row(sign).useful += 1;
        if (s.data.verdict === 'wrong') row(sign).wrong += 1;
      }
  }
  return { days, rows: [...rows.values()].sort((a, b) => b.seen - a.seen || a.sign.localeCompare(b.sign)) };
}
