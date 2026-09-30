// S1 — the situation: what is true right now, in one object (W4 step 6). The screen's
// `/gnomon/situation`, `gnomon_current_context` and the turn's ambient reads all call this, so the
// owner and the agent read one present: `buildSituation` over the state, plus the reads it needs
// from the record — where the owner left off on each project, how many shelf items wait, and, on a
// return, the last lines on the project before the absence (U2-F38) and the code touched in the
// hour before the break (U2-F40).
import { homedir } from 'node:os';
import { getLeftOff, getProjectIntents, getSignalsInRange } from '@sundial/db/index.js';
import { TRAIL_BEFORE_MIN, buildSituation, editTrail, type Situation } from '../situation.js';
import type { KernelState } from '../types.js';
import { readShelf } from './shelf.js';

export type ReadSituation = Situation & { resume: (NonNullable<Situation['resume']> & { digest?: { at: string; what: string }[]; trail?: ReturnType<typeof editTrail> }) | null };

export async function readSituation({ state, now }: { state: KernelState; now: number }): Promise<ReadSituation> {
  const [leftOff, shelf] = await Promise.all([getLeftOff(new Date(now - 14 * 86_400_000).toISOString()), readShelf({ now })]);
  const sit: ReadSituation = buildSituation(state, { home: homedir(), leftOff, shelfWaiting: shelf.filter((item) => item.verdict === null).length }, now);
  const resume = sit.resume;
  if (!resume) return sit;
  const left = Date.parse(resume.at) - resume.awayMs;
  const back = resume.trigger === 'project-return' ? resume.pieces.project : null;
  if (back) resume.digest = await getProjectIntents(back.id, new Date(left + 60_000).toISOString());
  const rows = await getSignalsInRange(new Date(left - TRAIL_BEFORE_MIN * 60_000).toISOString(), new Date(left + 60_000).toISOString(), 400, ['symbol']);
  resume.trail = editTrail(rows, resume.pieces.project?.id ?? null);
  return sit;
}
