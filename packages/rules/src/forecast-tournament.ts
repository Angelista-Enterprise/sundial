import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate as localDay, localHour, localWeekday as weekday } from '@sundial/helpers/local-day.js';
import type { Effect, HourFragmentedPrediction, JudgementResultPayload, KernelState, ResolvedPrediction, Rule, TournamentPrediction } from '@sundial/kernel/types.js';
import { bumpCalibration, clampProb, pastRate } from './forward-model.js';
import { FORECAST_NOTE, forecastMeetingOverrun, forecastReturnToday } from './questions/forecast-targets.js';

/**
 * J2.2 — the forecast tournament.
 *
 * Three targets, each bet by two forecasters on the same case: `base-rate`
 * (the running rate of the population, smoothed toward the bench prior —
 * the incumbent everything must beat) and `jev` (a `Judge` under purpose
 * `forecast`, the target's `forecast-*` set over a state of numbers). Each
 * case is one `TournamentPrediction` in `predictions.open`; the truth comes
 * from the log and resolves both at once; each forecaster gets its own
 * `RecordPrediction` row and its own `<target>/<forecaster>` calibration
 * entry, so the Ledger's tally is the leaderboard.
 *
 * Retirement (law 10 in production): at the day boundary, a forecaster whose
 * Brier is worse than base-rate's on the same target at n ≥ 30 is retired
 * for that target — its bets stop (Jev's calls stop), base-rate's continue
 * so the measurement does not. Cumulative Brier, not a 30-day window: the
 * state holds no window, and a forecaster that lost over its first thirty
 * cases has lost.
 *
 * Targets and their truth:
 * - `return-today`: opened when the owner leaves a project (a context switch
 *   away from it), hit when a later switch comes back to it the same local
 *   day, miss at the day boundary. Bench: +11.8 % skill on 39.
 * - `meeting-overrun`: opened at a calendar meeting's scheduled end when
 *   hearing heard speech during it, resolved five minutes later: hit if an
 *   utterance landed in (end, end + 5 min]. Bench: +2.5 % on 33 — a coin
 *   that accrues.
 * - `hour-fragmented`: a twin of the existing rule's bet, opened when it
 *   opens one and resolved when it resolves (the bench's clear win: 0.086
 *   vs 0.153). The existing rule keeps its own `prev-hour-lag` rows.
 * Not here: "a switch within 30 minutes" — base rate 97.5 %, degenerate.
 */
export const TOURNAMENT_FORECASTERS = ['base-rate', 'jev'] as const;
export const RETIRE_MIN_N = 30;
const SMOOTHING = 6;
const OVERRUN_GRACE_MS = 5 * 60_000;
const UTTERANCE_RING_MS = 20 * 60_000;
const UTTERANCE_RING_MAX = 600;
const TOUCHED_DAYS = 14;

/**
 * The bench's base rates, the prior each running rate is smoothed toward until it has its own thirty.
 * Except `return-today`: its bench rate (0.853) was nowhere near the live one
 * (0.15, n=27), and at full weight it lost to a constant (Brier 0.325 vs 0.126).
 * It starts at a neutral 0.5 with the weight of two cases (`PRIOR_WEIGHT`), so
 * a handful of live resolutions set it.
 */
const BENCH_PRIOR: Record<string, number> = { 'return-today': 0.5, 'meeting-overrun': 0.576, 'hour-fragmented': 0.14 };
const PRIOR_WEIGHT: Record<string, number> = { 'return-today': 2 };
const SET_BY_TARGET = { 'return-today': forecastReturnToday, 'meeting-overrun': forecastMeetingOverrun } as const;
/** The existing target's question for Jev; its set lives here because the rule that owns the target predates the registry. */
export const HOUR_FRAGMENTED_QUESTION = 'Will the coming hour be fragmented — ten or more context switches rather than sustained work?';

const isTwin = (p: KernelState['predictions']['open'][number]): p is TournamentPrediction => typeof p.kind === 'string' && p.kind.startsWith('tournament:');
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The incumbent's probability: hits over n for this target's base-rate rows, smoothed toward the bench prior. */
export function baseRateFor(state: KernelState, target: string): number {
  const c = state.predictions.calibration[`${target}/base-rate`];
  const prior = BENCH_PRIOR[target] ?? 0.5;
  const weight = PRIOR_WEIGHT[target] ?? SMOOTHING;
  return clampProb(((c?.hits ?? 0) + prior * weight) / ((c?.n ?? 0) + weight));
}

function judgeFor(state: KernelState, bet: TournamentPrediction, base: number): Effect[] {
  if ((state.predictions.tournament.retired[bet.target] ?? []).includes('jev')) return [];
  const set = bet.target === 'hour-fragmented' ? null : SET_BY_TARGET[bet.target as 'return-today' | 'meeting-overrun'];
  const built = set
    ? set.build({ features: bet.features, historicallyTrueThisOften: base })
    : { state: { forecast: HOUR_FRAGMENTED_QUESTION, features: bet.features, historically_true_this_often: Number(base.toFixed(3)), note: FORECAST_NOTE }, questions: { yes: { type: 'noul' as const, instructions: HOUR_FRAGMENTED_QUESTION } } };
  return [{ type: 'Judge', purpose: 'forecast', questionSetId: set ? set.id : 'forecast-hour-fragmented', momentId: null, delayMs: 0, state: built.state, questions: built.questions, metadata: { predictionId: bet.id } }];
}

function open(state: KernelState, bet: Omit<TournamentPrediction, 'forecasters'>): { state: KernelState; effects: Effect[] } {
  const base = baseRateFor(state, bet.target);
  const full: TournamentPrediction = { ...bet, forecasters: { 'base-rate': base, jev: null } };
  return {
    state: { ...state, predictions: { ...state.predictions, open: [...state.predictions.open, full] } },
    effects: judgeFor(state, full, base),
  };
}

function resolve(state: KernelState, bet: TournamentPrediction, outcome: 0 | 1, ts: string): { state: KernelState; effects: Effect[] } {
  let calibration = state.predictions.calibration;
  const effects: Effect[] = [];
  const resolved: ResolvedPrediction[] = [];
  for (const forecaster of TOURNAMENT_FORECASTERS) {
    const p = bet.forecasters[forecaster];
    if (typeof p !== 'number') continue;
    const prob = clampProb(p);
    const surprise = Math.round(-Math.log(outcome === 1 ? prob : 1 - prob) * 1000) / 1000;
    // K0.3 — read BEFORE the bump: the running mean over prior resolutions is
    // the opponent this forecaster could actually have bet against. Every
    // forecaster on a shared target accumulates the same outcomes, so its own
    // key carries the TARGET's rate.
    const baseProb = pastRate(calibration, `${bet.target}/${forecaster}`);
    calibration = bumpCalibration(calibration, `${bet.target}/${forecaster}`, outcome, prob);
    resolved.push({ kind: bet.target, priorProb: prob, hit: outcome === 1, surprise, resolvedAt: ts });
    effects.push({ type: 'RecordPrediction', id: `${bet.id}:${forecaster}`, kind: bet.target, forecaster, createdAt: bet.createdAt, resolvedAt: ts, priorProb: prob, features: bet.features, outcome, surprise, baseProb });
  }
  return {
    state: {
      ...state,
      predictions: {
        ...state.predictions,
        open: state.predictions.open.filter((p) => p !== bet),
        calibration,
        recentResolved: [...state.predictions.recentResolved, ...resolved].slice(-50),
      },
    },
    effects,
  };
}

/** Retire a forecaster on a target when its cumulative Brier is worse than base-rate's at n ≥ RETIRE_MIN_N. */
export function retirements(state: KernelState): Record<string, string[]> {
  const retired = { ...state.predictions.tournament.retired };
  for (const target of Object.keys(BENCH_PRIOR)) {
    const base = state.predictions.calibration[`${target}/base-rate`];
    const jev = state.predictions.calibration[`${target}/jev`];
    if (!base || !jev || jev.n < RETIRE_MIN_N || base.n === 0) continue;
    if (jev.brierSum / jev.n > base.brierSum / base.n && !(retired[target] ?? []).includes('jev')) retired[target] = [...(retired[target] ?? []), 'jev'];
  }
  return retired;
}

export const forecastTournament: Rule = (state, event) => {
  let s = state;
  const effects: Effect[] = [];
  const t = s.predictions.tournament;
  const day = localDay(event.ts, state.config.timezone);
  const now = Date.parse(event.ts);
  const apply = (r: { state: KernelState; effects: Effect[] }) => {
    s = r.state;
    effects.push(...r.effects);
  };

  // Jev's answer for a bet still open.
  if (event.type === 'judgement:result') {
    const payload = event.payload as unknown as JudgementResultPayload;
    if (!payload.questionSetId?.startsWith('forecast-')) return { state, effects: [] };
    const id = str(payload.metadata?.predictionId);
    const p = payload.answers?.yes?.noul;
    const bet = s.predictions.open.find((b): b is TournamentPrediction => isTwin(b) && b.id === id);
    if (!bet || typeof p !== 'number') return { state, effects: [] };
    const updated: TournamentPrediction = { ...bet, forecasters: { ...bet.forecasters, jev: clampProb(p) } };
    return { state: { ...s, predictions: { ...s.predictions, open: s.predictions.open.map((b) => (b === bet ? updated : b)) } }, effects: [] };
  }

  // The utterance ring for the meeting target.
  if (event.type === 'audio:transcript') {
    const utterances = [...t.utterances.filter((u) => now - Date.parse(u) <= UTTERANCE_RING_MS), event.ts].slice(-UTTERANCE_RING_MAX);
    return { state: { ...s, predictions: { ...s.predictions, tournament: { ...t, utterances } } }, effects: [] };
  }

  // Day boundary: open return-today bets are misses; tallies reset; retirements.
  if (event.type === 'day:boundary') {
    for (const bet of s.predictions.open.filter((b): b is TournamentPrediction => isTwin(b) && b.target === 'return-today')) apply(resolve(s, bet, 0, event.ts));
    const touchedDays = Object.fromEntries(Object.entries(t.touchedDays).map(([k, days]) => [k, days.filter((d) => (now - Date.parse(d)) / 86_400_000 <= TOUCHED_DAYS)]).filter(([, days]) => (days as string[]).length > 0));
    s = { ...s, predictions: { ...s.predictions, tournament: { ...s.predictions.tournament, day, projectToday: {}, touchedDays, retired: retirements(s) } } };
    // The hour-fragmented twin resolves below, on the same event its original does.
  }

  // A moment closed on this event: tallies for return-today's features. This rule
  // folds AFTER `momentClose`, so `closingMomentRow` would see the already-closed
  // state and answer null; the record `momentClose` leaves behind is read instead.
  const closed = s.project.lastClosedMoment;
  if (closed?.projectId && closed.endedAt === event.ts) {
    const tally = t.projectToday[closed.projectId] ?? { minutes: 0, sessions: 0 };
    const days = t.touchedDays[closed.projectId] ?? [];
    s = {
      ...s,
      predictions: {
        ...s.predictions,
        tournament: {
          ...s.predictions.tournament,
          day,
          projectToday: { ...(s.predictions.tournament.day === day ? s.predictions.tournament.projectToday : {}), [closed.projectId]: { minutes: tally.minutes + (closed.durationMs ?? 0) / 60_000, sessions: tally.sessions + 1 } },
          touchedDays: { ...s.predictions.tournament.touchedDays, [closed.projectId]: days.includes(day) ? days : [...days, day].slice(-TOUCHED_DAYS) },
        },
      },
    };
  }

  // return-today: leave → bet; come back → hit.
  if (event.type === 'event:context-switch') {
    const from = str(event.payload.fromProject);
    const to = str(event.payload.toProject);
    if (from !== to) {
      const tt = s.predictions.tournament;
      if (to !== null) for (const bet of s.predictions.open.filter((b): b is TournamentPrediction => isTwin(b) && b.target === 'return-today' && b.key === `${day}|${to}`)) apply(resolve(s, bet, 1, event.ts));
      if (from !== null && !s.predictions.open.some((b) => isTwin(b) && b.key === `${day}|${from}`)) {
        const tally = tt.projectToday[from] ?? { minutes: 0, sessions: 0 };
        apply(
          open(s, {
            id: deriveId(event.ts, event.id, 'tournament', 'return-today', from),
            kind: 'tournament:return-today',
            target: 'return-today',
            key: `${day}|${from}`,
            createdAt: event.ts,
            resolveBy: null,
            about: `${from.split('/').pop()} · ${day}`,
            features: { local_hour: localHour(event.ts, state.config.timezone), weekday: weekday(event.ts, state.config.timezone), minutes_on_project_today: Math.round(tally.minutes), sessions_on_project_today: tally.sessions, days_project_touched_last_14: (tt.touchedDays[from] ?? []).length },
          }),
        );
      }
    }
  }

  // meeting-overrun: at a scheduled end hearing was on for → bet; five minutes later → truth.
  if (event.type === 'clock:tick') {
    for (const bet of s.predictions.open.filter((b): b is TournamentPrediction => isTwin(b) && b.target === 'meeting-overrun' && b.resolveBy !== null && Date.parse(b.resolveBy) <= now)) {
      const end = Date.parse(bet.resolveBy!) - OVERRUN_GRACE_MS;
      const spokeAfter = s.predictions.tournament.utterances.some((u) => Date.parse(u) > end && Date.parse(u) <= end + OVERRUN_GRACE_MS);
      apply(resolve(s, bet, spokeAfter ? 1 : 0, event.ts));
    }
    for (const meeting of Object.values(s.meetings.seen)) {
      const end = Date.parse(meeting.end);
      const key = `meeting|${meeting.start}`;
      if (!(end <= now && now - end < OVERRUN_GRACE_MS) || s.predictions.open.some((b) => isTwin(b) && b.key === key)) continue;
      const during = s.predictions.tournament.utterances.filter((u) => Date.parse(u) >= Date.parse(meeting.start) && Date.parse(u) <= end);
      if (during.length === 0) continue; // hearing was off: no truth possible
      apply(
        open(s, {
          id: deriveId(meeting.start, 'tournament', 'meeting-overrun', meeting.title),
          kind: 'tournament:meeting-overrun',
          target: 'meeting-overrun',
          key,
          createdAt: event.ts,
          resolveBy: new Date(end + OVERRUN_GRACE_MS).toISOString(),
          about: meeting.title,
          features: { scheduled_minutes: Math.round((end - Date.parse(meeting.start)) / 60_000), local_hour_end: localHour(meeting.end, state.config.timezone), weekday: weekday(meeting.end, state.config.timezone), attendee_count: meeting.attendees.length, utterances_last_10_min: during.filter((u) => end - Date.parse(u) <= 10 * 60_000).length },
        }),
      );
    }
  }

  // hour-fragmented: twin the existing rule's bet; resolve when it resolves.
  const original = s.predictions.open.find((p): p is HourFragmentedPrediction => p.kind === 'hour-fragmented');
  if (original && !s.predictions.open.some((b) => isTwin(b) && b.key === `hf|${original.day}|${original.hour}`)) {
    apply(
      open(s, {
        id: deriveId(original.createdAt, 'tournament', 'hour-fragmented', original.id),
        kind: 'tournament:hour-fragmented',
        target: 'hour-fragmented',
        key: `hf|${original.day}|${original.hour}`,
        createdAt: original.createdAt,
        resolveBy: null,
        about: `${original.day} ${String(original.hour).padStart(2, '0')}:00`,
        features: { local_hour: original.hour, weekday: weekday(original.createdAt, state.config.timezone), previous_hour_fragmented: original.prevState === 'prev-frag' },
      }),
    );
  }
  for (const twin of s.predictions.open.filter((b): b is TournamentPrediction => isTwin(b) && b.target === 'hour-fragmented')) {
    const stillOpen = s.predictions.open.some((p) => p.kind === 'hour-fragmented' && `hf|${(p as HourFragmentedPrediction).day}|${(p as HourFragmentedPrediction).hour}` === twin.key);
    if (stillOpen) continue;
    const fresh = [...s.predictions.recentResolved].reverse().find((r) => r.kind === 'hour-fragmented');
    if (fresh && fresh.resolvedAt === event.ts) apply(resolve(s, twin, fresh.hit ? 1 : 0, event.ts));
    else if (!fresh || fresh.resolvedAt !== event.ts) {
      // The original vanished without a resolution on this event (a snapshot from
      // before the twin, or a retired kind): drop the twin rather than guess.
      s = { ...s, predictions: { ...s.predictions, open: s.predictions.open.filter((p) => p !== twin) } };
    }
  }

  return s === state && effects.length === 0 ? { state, effects: [] } : { state: s, effects };
};
