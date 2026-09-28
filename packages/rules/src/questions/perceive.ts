/**
 * `perceive` — how the owner is doing, right now, from RAW RATES ONLY (J2.1).
 * The lab's `live` flow failed (p(stuck) 0.63–0.82 on every kind) because its
 * state carried rule-derived `life_events` and the question named thrashing —
 * a literal match, law 7 broken. Here every field is a quantity with its unit
 * in the name, read off the sensors the fold already keeps; no label, no
 * derived event, no title text. The judge returns likelihoods; the code keeps
 * the belief (`ownerPerceive`'s Beta filter) — Jev is not the filter.
 */
import { choice, noul, type QuestionSet } from './index.js';

export interface PerceiveInput {
  switches_last_10_min: number;
  minutes_since_last_switch: number | null;
  minutes_in_current_session: number;
  distinct_windows_in_session: number;
  keys_per_minute: number;
  input_events_per_minute: number;
  mic_on: boolean;
  playback_on: boolean;
  calendar_event_active: boolean;
  hour_local: number;
}

export const PERCEIVE_QUESTIONS = {
  in_flow: noul('Judged from these rates alone, is the owner in a stretch of focused, productive work that an interruption would break?'),
  stuck: noul('Judged from these rates alone, does the owner look blocked or churning — much switching and little steady input, for a while?'),
  interruptible: noul('Judged from these rates alone, would a short message from an assistant be acceptable to the owner right now?'),
  state: choice('Which best describes the owner right now, from these rates alone?', {
    deep_work: 'Head down on one thing, producing.',
    exploring: 'Reading, searching, or trying things out.',
    stuck: 'Blocked or churning without progress.',
    communicating: 'In a meeting, on a call, or writing to people.',
    winding_down: 'Wrapping up, tidying, or drifting to leisure.',
    unclear: 'The rates do not say.',
  }),
};

export const perceive: QuestionSet<[PerceiveInput]> = {
  id: 'perceive',
  build: (input) => ({ state: { ...input }, questions: PERCEIVE_QUESTIONS }),
  samples: () => [
    [{ switches_last_10_min: 1, minutes_since_last_switch: 24, minutes_in_current_session: 41, distinct_windows_in_session: 2, keys_per_minute: 96, input_events_per_minute: 120, mic_on: false, playback_on: true, calendar_event_active: false, hour_local: 10 }],
    [{ switches_last_10_min: 14, minutes_since_last_switch: 0, minutes_in_current_session: 3, distinct_windows_in_session: 9, keys_per_minute: 4, input_events_per_minute: 60, mic_on: false, playback_on: false, calendar_event_active: false, hour_local: 15 }],
    [{ switches_last_10_min: 0, minutes_since_last_switch: null, minutes_in_current_session: 12, distinct_windows_in_session: 1, keys_per_minute: 0, input_events_per_minute: 2, mic_on: true, playback_on: false, calendar_event_active: true, hour_local: 9 }],
  ],
};
