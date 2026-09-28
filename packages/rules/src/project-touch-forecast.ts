import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, KernelState, ProjectTouchedPrediction, ResolvedPrediction, Rule } from '@sundial/kernel/types.js';
import { bumpCalibration, clampProb, pastRate } from './forward-model.js';
import { MAX_ACCUMULATED } from './surprise-drive.js';

/**
 * The system's third forecaster: will this project be worked on at all today?
 *
 * `dayShapeForecast` predicts WHEN the day ends and `hourFragmentedForecast`
 * whether the hour comes apart. This is the first forecaster about the CONTENT
 * of the work — and it is allowed to exist only because it asks at the one
 * granularity where content was ever measured to be predictable: a whole day.
 * `guides/measure-forecast-skill` records that every "what next" question at
 * a 30-minute or one-moment horizon scores at or below zero, while "will you
 * touch this project today" is the one project question that carries skill.
 *
 * ## The measurement
 *
 * `measure-forecast-skill.ts` Q5, "which project" feature, leave-one-day-out:
 *
 * | cutoff     | n  | base rate | which project | project × workday |
 * |------------|----|-----------|---------------|-------------------|
 * | 2026-08-20 | 90 | 0.44      | +14.5%        | +16.1%            |
 * | 2026-08-27 | 90 | 0.44      | +14.5%        | +16.1%            |
 * | 2026-09-03 | 96 | 0.42      | +12.9%        | +14.1%            |
 *
 * Stable across cutoffs, which is the test the shelved return-after-interruption
 * target failed. The flat "which project" cell is used rather than the higher
 * reading "project × workday": with under a hundred samples across six projects
 * the workday split halves every cell, and the guide's warning about thin cells
 * posting a strong number once and then collapsing applies with force. The
 * workday variable is left for a research goal to prove, the way `dayShape`'s
 * conditioned cells are.
 *
 * ## The population, and where it differs from the measurement
 *
 * The script bet on the six busiest projects of the whole corpus, one sample per
 * project per active day. A live rule cannot know the corpus's top six in
 * advance, so it bets on every project touched within the last
 * `CANDIDATE_RECENCY_DAYS` days. That is a different population — it drops
 * projects that have gone quiet, which are mostly misses — so the offline
 * number is NOT inherited, and the replay of the built rule against the real
 * log is what decides whether it earned its own. See the memory note that came
 * out of `hourFragmentedForecast`: an offline skill number is a claim about a
 * population, and a rule that bets on a different one has to be re-measured.
 *
 * ## The resolver
 *
 * Outcome = "this project appears in `projectTouch.touched[day]`", a list this
 * rule itself builds from `window.attribution.projectId` as the day goes. It is
 * never derived at resolution time from the closing event, and it is keyed by
 * the BET's day rather than "today", so a day that closes late — laptop shut
 * overnight, the next activation arriving the following morning — resolves
 * against its own record and not the new day's.
 */

/** With no evidence at all, the chance a candidate project gets touched: the measured base rate, 0.42. */
const UNINFORMED_TOUCH_RATE = 0.42;

/** Pseudo-counts pulling a thin project cell toward the pooled rate. Same constant as the two other forecasters, so the three read as one method. */
const CELL_SMOOTHING = 6;

/** A project last touched more than this many days ago is not bet on. It is also the horizon after which `lastTouched` forgets it. */
export const CANDIDATE_RECENCY_DAYS = 14;

/** `input:activity` emits before an hour counts as active — identical to the other two forecasters and to the measurement script. */
const ACTIVE_HOUR_MIN_EMITS = 3;

/** Names the METHOD, not the rule, so a conditioned or LLM-enhanced competitor on this target can be scored apart from it. */
export const PROJECT_TOUCH_FORECASTER = 'project-rate';

function localDay(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localHour(ts: string): number {
  return new Date(ts).getHours();
}

/** Whole days between two local day keys, positive when `later` is after `earlier`. */
function daysBetween(earlier: string, later: string): number {
  return Math.round((new Date(`${later}T12:00:00`).getTime() - new Date(`${earlier}T12:00:00`).getTime()) / 86_400_000);
}

type Slice = KernelState['predictions']['projectTouch'];

/**
 * The observed share of bets that hit, pooled across every project, smoothed
 * toward the measured prior. Two layers of smoothing on purpose — the cell
 * smooths toward this, and this smooths toward the prior — because
 * `hourFragmentedForecast`'s first day showed what one unsmoothed miss does to
 * a cold forecaster: 0/1 became the base rate and the next bet went out at the
 * 2% floor.
 */
function pooledRate(byProject: Slice['byProject']): number {
  let n = 0;
  let hits = 0;
  for (const cell of Object.values(byProject)) {
    n += cell.n;
    hits += cell.hits;
  }
  return (hits + UNINFORMED_TOUCH_RATE * CELL_SMOOTHING) / (n + CELL_SMOOTHING);
}

/** P(this project is touched today), from its own cell, smoothed toward the pooled rate so a new project degrades to the uninformed bet. */
export function projectTouchPrior(slice: Slice, project: string): number {
  const cell = slice.byProject[project] ?? { n: 0, hits: 0 };
  const base = pooledRate(slice.byProject);
  return clampProb((cell.hits + base * CELL_SMOOTHING) / (cell.n + CELL_SMOOTHING));
}

/** Projects eligible for a bet on `day`: touched within the recency window, strictly before today. */
export function candidateProjects(slice: Slice, day: string): string[] {
  return Object.entries(slice.lastTouched)
    .filter(([, last]) => {
      const age = daysBetween(last, day);
      return age >= 0 && age <= CANDIDATE_RECENCY_DAYS;
    })
    .map(([project]) => project)
    .sort();
}

/**
 * Resolves every open bet on the slice's day against that day's own touch
 * record, folds each outcome into its project cell, calibration and the shared
 * surprise drive, and clears the day. A no-op when no day is open.
 */
function closeDay(state: KernelState, ts: string): { state: KernelState; effects: Effect[] } {
  const slice = state.predictions.projectTouch;
  if (slice.day === null) return { state, effects: [] };
  const day = slice.day;
  const touched = new Set(slice.touched[day] ?? []);
  const bets = state.predictions.open.filter((p): p is ProjectTouchedPrediction => p.kind === 'project-touched' && p.day === day);

  let calibration = state.predictions.calibration;
  let byProject = slice.byProject;
  let recentResolved = state.predictions.recentResolved;
  let importance = state.memory.accumulatedImportance;
  const effects: Effect[] = [];

  for (const bet of bets) {
    const hit = touched.has(bet.project);
    const outcome: 0 | 1 = hit ? 1 : 0;
    const pActual = clampProb(hit ? bet.priorProb : 1 - bet.priorProb);
    const surprise = Math.round(-Math.log(pActual) * 1000) / 1000;
    const resolved: ResolvedPrediction = { kind: 'project-touched', priorProb: bet.priorProb, hit, surprise, resolvedAt: ts };
    const cell = byProject[bet.project] ?? { n: 0, hits: 0 };
    byProject = { ...byProject, [bet.project]: { n: cell.n + 1, hits: cell.hits + outcome } };
    // K0.3 — the running mean over prior resolutions, read before the bump.
    const baseProb = pastRate(calibration, 'project-touched');
    calibration = bumpCalibration(calibration, 'project-touched', outcome, bet.priorProb);
    recentResolved = [...recentResolved, resolved].slice(-50);
    // The one master surprise scalar, shared with the other forecasters and
    // `anomalyZscore` — mood and reflection read the accumulator, never a
    // single forecaster's record.
    importance = Math.min(MAX_ACCUMULATED, importance + -Math.log(pActual));
    effects.push({
      type: 'RecordPrediction',
      id: bet.id,
      kind: 'project-touched',
      forecaster: PROJECT_TOUCH_FORECASTER,
      createdAt: bet.createdAt,
      resolvedAt: ts,
      priorProb: bet.priorProb,
      features: { project: bet.project, day, weekday: new Date(`${day}T12:00:00`).getDay() },
      outcome,
      surprise,
      baseProb,
    });
  }

  // The closed day's record has served its purpose; only the newest day's is
  // kept so the map cannot grow with the log.
  const touchedKept: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(slice.touched)) if (k !== day) touchedKept[k] = v;

  return {
    state: {
      ...state,
      memory: { ...state.memory, accumulatedImportance: importance },
      predictions: {
        ...state.predictions,
        open: state.predictions.open.filter((p) => !(p.kind === 'project-touched' && p.day === day)),
        calibration,
        recentResolved,
        projectTouch: { ...slice, day: null, touched: touchedKept, byProject },
      },
    },
    effects,
  };
}

/**
 * Reacts to three event types, each doing one job:
 *
 *  - `window:changed` — the evidence. Reads the attribution `windowTrack` just
 *    recomputed for this window and records the project against the local day.
 *    Recorded whether or not a day is open, because the measured target counts
 *    every attributed moment of the day, including those before the first hour
 *    turns active.
 *  - `input:activity` — promotes the day's first hour to active, which is when
 *    the day's bets OPEN: one per candidate project. Closes the previous day
 *    first if it never closed, so its outcomes condition the new bets.
 *  - `day:boundary` — closes the day at midnight when the machine is awake.
 */
/** Every project-keyed map in the slice, with `from` folded into `into`. Counts add; a day's touch list dedupes. */
function mergeSlice(slice: Slice, from: string, into: string): Slice {
  const byProject = { ...slice.byProject };
  if (from in byProject) {
    const a = byProject[from];
    const b = byProject[into] ?? { n: 0, hits: 0 };
    byProject[into] = { n: a.n + b.n, hits: a.hits + b.hits };
    delete byProject[from];
  }
  const lastTouched = { ...slice.lastTouched };
  if (from in lastTouched) {
    lastTouched[into] = [lastTouched[from], lastTouched[into] ?? ''].sort().pop() as string;
    delete lastTouched[from];
  }
  const touched: Record<string, string[]> = {};
  for (const [day, list] of Object.entries(slice.touched)) touched[day] = [...new Set(list.map((p) => (p === from ? into : p)))];
  return { ...slice, byProject, lastTouched, touched };
}

export const projectTouchForecast: Rule = (state, event) => {
  if (event.type === 'day:boundary') return closeDay(state, event.ts);

  // One project folded into another (see `projectTrack`): the cells, the
  // candidate set and today's record follow it. An open bet on `from` is
  // re-pointed too, so it resolves against the merged record rather than
  // against a name nothing will touch again.
  if (event.type === 'project:merged') {
    const { from, into } = event.payload as { from?: string; into?: string };
    if (typeof from !== 'string' || typeof into !== 'string' || from === into) return { state, effects: [] };
    const hasInto = state.predictions.open.some((p) => p.kind === 'project-touched' && p.project === into);
    return {
      state: {
        ...state,
        predictions: {
          ...state.predictions,
          open: state.predictions.open.flatMap((p) => {
            if (p.kind !== 'project-touched' || p.project !== from) return [p];
            // Two bets on what is now one project: keep the real root's, drop the synthetic's.
            return hasInto ? [] : [{ ...p, project: into }];
          }),
          projectTouch: mergeSlice(state.predictions.projectTouch, from, into),
        },
      },
      effects: [],
    };
  }

  const slice = state.predictions.projectTouch;

  if (event.type === 'window:changed') {
    const project = state.window.attribution.projectId;
    if (project === null || project === '') return { state, effects: [] };
    const day = localDay(event.ts);
    const list = slice.touched[day] ?? [];
    if (list.includes(project) && slice.lastTouched[project] === day) return { state, effects: [] };
    return {
      state: {
        ...state,
        predictions: {
          ...state.predictions,
          projectTouch: {
            ...slice,
            touched: { ...slice.touched, [day]: list.includes(project) ? list : [...list, project] },
            lastTouched: { ...slice.lastTouched, [project]: day },
          },
        },
      },
      effects: [],
    };
  }

  if (event.type !== 'input:activity') return { state, effects: [] };

  const day = localDay(event.ts);
  // The day is already open: nothing to promote.
  if (slice.day === day) return { state, effects: [] };

  const key = `${day}|${localHour(event.ts)}`;
  const emitsThisHour = slice.emitsKey === key ? slice.emitsThisHour + 1 : 1;
  const counted: KernelState = { ...state, predictions: { ...state.predictions, projectTouch: { ...slice, emitsThisHour, emitsKey: key } } };
  if (emitsThisHour !== ACTIVE_HOUR_MIN_EMITS) return { state: counted, effects: [] };

  // A new day is active. Close the old one first, so its outcomes are in the
  // cells the new bets are priced from.
  const { state: closed, effects } = closeDay(counted, event.ts);
  const carried = closed.predictions.projectTouch;

  // Forget projects that have fallen out of the candidate window, so the map is
  // bounded by the owner's breadth of work rather than by the log's length.
  const lastTouched: Record<string, string> = {};
  for (const [project, last] of Object.entries(carried.lastTouched)) if (daysBetween(last, day) <= CANDIDATE_RECENCY_DAYS) lastTouched[project] = last;
  const pruned: Slice = { ...carried, lastTouched };

  const bets: ProjectTouchedPrediction[] = candidateProjects(pruned, day).map((project) => ({
    id: deriveId(event.ts, event.id, 'project-touched', `${day}|${project}`),
    createdAt: event.ts,
    kind: 'project-touched',
    day,
    project,
    priorProb: projectTouchPrior(pruned, project),
  }));

  return {
    state: {
      ...closed,
      predictions: {
        ...closed.predictions,
        open: [...closed.predictions.open, ...bets],
        projectTouch: { ...pruned, day },
      },
    },
    effects,
  };
};
