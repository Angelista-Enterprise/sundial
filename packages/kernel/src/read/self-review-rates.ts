// Round 5: the numbers Gnomon's self-review is judged by, over log rows the caller reads (lab/self-review/measure.mjs):
// the failed-step rate per app before and after the owner kept a proposal for it, steps per repeated goal (the first
// run against the later ones), and how many proposals the owner kept. Each with its n, and whether that n is enough
// (FORESIGHT 4b and 4c: 30 steps a side, 10 repeated goals; 20 proposals, as for any offer). The rig's runs are left out.
import { ownSteps, type StepRow } from './routes.js';

export const REVIEW_TYPES = ['review:proposed', 'review:accepted', 'review:dismissed'];
export const MIN_STEPS_PER_SIDE = 30;
export const MIN_REPEATED_GOALS = 10;
export const MIN_PROPOSALS = 20;

/** One log row: its type, when, and its payload. */
export interface RateRow {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

const rate = (steps: StepRow[]) => ({ n: steps.length, failed: steps.filter((s) => s.ok === false).length, rate: steps.length ? steps.filter((s) => s.ok === false).length / steps.length : null });

export function reviewRates(rows: readonly RateRow[], rigSessions: readonly string[] = []) {
  const rig = new Set(rigSessions);
  const steps = ownSteps(rows.filter((r) => r.type === 'screen:step').map((r) => ({ ...r.data, at: r.at }) as StepRow)).filter((s) => !(typeof s.session === 'string' && rig.has(s.session)));
  const of = (type: string) => rows.filter((r) => r.type === type);
  const accepted = of('review:accepted');

  const apps = [...new Set(steps.map((s) => String(s.processName ?? '')).filter(Boolean))].map((app) => {
    const mine = steps.filter((s) => s.processName === app);
    const keptAt = accepted.filter((r) => r.data.app === app).map((r) => r.at).sort()[0];
    if (!keptAt) return { app, all: rate(mine) };
    const [before, after] = [rate(mine.filter((s) => String(s.at) < keptAt)), rate(mine.filter((s) => String(s.at) >= keptAt))];
    return { app, all: rate(mine), keptAt, before, after, enough: before.n >= MIN_STEPS_PER_SIDE && after.n >= MIN_STEPS_PER_SIDE };
  });

  // A goal's runs: one per chat, in the order they began. Steps of the first run against the mean of the later ones.
  const byGoal = new Map<string, Map<string, StepRow[]>>();
  for (const s of steps) {
    if (typeof s.goal !== 'string' || s.goal === '') continue;
    const runs = byGoal.get(s.goal) ?? new Map<string, StepRow[]>();
    runs.set(String(s.session ?? ''), [...(runs.get(String(s.session ?? '')) ?? []), s]);
    byGoal.set(s.goal, runs);
  }
  const repeated = [...byGoal.values()].map((runs) => [...runs.values()].sort((a, b) => String(a[0]!.at).localeCompare(String(b[0]!.at))).map((run) => run.length)).filter((counts) => counts.length >= 2);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const goals = { n: repeated.length, first: mean(repeated.map((c) => c[0]!)), later: mean(repeated.map((c) => mean(c.slice(1))!)), enough: repeated.length >= MIN_REPEATED_GOALS };

  const proposed = of(REVIEW_TYPES[0]!).length;
  const proposals = { proposed, accepted: accepted.length, dismissed: of(REVIEW_TYPES[2]!).length, share: proposed ? accepted.length / proposed : null, enough: proposed >= MIN_PROPOSALS };
  return { steps: rate(steps), apps, goals, proposals };
}
