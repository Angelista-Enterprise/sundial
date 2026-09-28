/**
 * `forecast-*` — one set per forecast target (J2.2). Each is a single noul
 * over a state of NUMBERS (law 7): the features a hand-built forecaster would
 * read, plus `historically_true_this_often`, the base rate of the population
 * being bet on, named as a prior (law 2's one allowed derived number). The
 * lab: Jev at Brier 0.086 vs the live forecaster's 0.153 on hour-fragmented;
 * it will not go below ≈ 0.19 on a near-zero base rate, so it loses there.
 *
 * The truth for each target is in the log, and the tournament (J2.2c)
 * retires any forecaster — hand-built or Jev — whose 30-day Brier is worse
 * than always-base-rate. The bench (J2.2a) is that tournament run over
 * history before anything is live.
 */
import type { JudgeQuestion } from '@sundial/kernel/types.js';
import { noul, type QuestionSet } from './index.js';

export const FORECAST_NOTE = 'The owner is a software developer in the Netherlands; hours are local, weekdays 0 = Sunday.';

export interface ForecastInput {
  /** Numbers only. The set names the fields a consumer must send; extras are passed through. */
  features: Record<string, number | boolean | null>;
  /** Base rate of the population bet on, 0..1. */
  historicallyTrueThisOften: number;
}

function forecastSet(id: string, question: string, sample: Record<string, number | boolean | null>): QuestionSet<[ForecastInput]> & { question: JudgeQuestion } {
  const q = noul(question);
  return {
    id,
    question: q,
    build: (input) => ({
      state: { forecast: question, features: input.features, historically_true_this_often: Number(input.historicallyTrueThisOften.toFixed(3)), note: FORECAST_NOTE },
      questions: { yes: q },
    }),
    samples: () => [[{ features: sample, historicallyTrueThisOften: 0.5 }]],
  };
}

/**
 * A switch to a DIFFERENT PROJECT inside the next 30 minutes. Population:
 * every recorded project switch. "Any switch within 30 min" was benched
 * first and is degenerate — base rate 97.5 %, nothing to forecast.
 */
export const forecastSwitch30 = forecastSet('forecast-project-switch-30', 'Will the owner switch to a different project within the next 30 minutes?', {
  local_hour: 14,
  weekday: 2,
  project_switches_last_60_min: 2,
  minutes_since_previous_project_switch: 12,
  minutes_on_current_project: 12,
  project_switches_so_far_today: 9,
});

/** The owner comes back to this project later today. Population: every moment that left a project. */
export const forecastReturnToday = forecastSet('forecast-return-today', 'Will the owner return to the project they just left, later today?', {
  local_hour: 11,
  weekday: 2,
  minutes_on_project_today: 48,
  sessions_on_project_today: 3,
  days_project_touched_last_14: 9,
});

/** Still talking five minutes after the scheduled end. Population: meetings hearing was on for. */
export const forecastMeetingOverrun = forecastSet('forecast-meeting-overrun', 'Will this meeting run past its scheduled end by five minutes or more?', {
  scheduled_minutes: 60,
  local_hour_end: 15,
  weekday: 1,
  attendee_count: 4,
  is_recurring: true,
  utterances_last_10_min: 31,
});

export const FORECAST_SETS = [forecastSwitch30, forecastReturnToday, forecastMeetingOverrun];
