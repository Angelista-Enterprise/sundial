/**
 * `gate-features` — how a notice would land, judged from its text (J1.6).
 * The lab's `gate` flow, word for word: 100 % under 1 s; speak-now 0.27 on
 * notices that go stale vs 0.16 evergreen; "meeting in 20 min" → alert,
 * "branch idle 14 d" → ambient. Unverifiable until the owner's verdicts
 * exist — which is why J1.6 LOGS these beside the gate's arithmetic and
 * changes nothing. J5.1 fits the learned gate on a month of both.
 *
 * State is the notice as the owner would see it (title, body, severity) and
 * one line of standing context. No gate arithmetic in the state: the first
 * lab run handed Jev the numbers and it judged numbers (law 2).
 */
import { choice, clip, noul, score, type QuestionSet } from './index.js';

export interface GateFeaturesInput {
  title: string;
  body: string | null;
  severity: string | null;
}

export const GATE_CONTEXT = 'The owner is a software developer at work. The assistant may show a notice quietly on its board, push it as an alert, or say nothing.';

export const GATE_FEATURES_QUESTIONS = {
  speak_now: noul('Should an assistant interrupt the owner right now to say this?', { true: 'Saying it now is worth the interruption.', false: 'It can wait, or should never be said.' }),
  value: score('How would the owner receive hearing this?', ['Annoying: noise they did not need.', 'Neutral: fine, but forgettable.', 'Useful: glad to know.', 'Important: they would want it even mid-task.']),
  channel: choice('How should `notice` be delivered?', { silent: 'Do not deliver it at all.', ambient: 'Show it somewhere it can be noticed later; do not alert.', alert: 'Push it to the owner now.' }),
  stale_soon: noul('Will `notice` be useless if the owner only sees it an hour from now?'),
  actionable: noul('Does `notice` tell the owner something they can act on, rather than merely describe?'),
};

export const gateFeatures: QuestionSet<[GateFeaturesInput]> = {
  id: 'gate-features',
  build: (input) => ({
    state: { notice: { title: clip(input.title, 200), body: input.body ? clip(input.body) : null, severity: input.severity }, context: GATE_CONTEXT },
    questions: GATE_FEATURES_QUESTIONS,
  }),
  samples: () => [
    [{ title: 'Puzzlez planning starts in 20 minutes', body: 'Calendar: 14:00–15:00, with Alex.', severity: 'info' }],
    [{ title: 'Branch feat/redesign idle 14 days', body: 'x'.repeat(900), severity: null }],
  ],
};
