/**
 * `judge-line` — the text model's sentence, checked against its own evidence
 * before the owner sees it (docs/jarvis/02; J1.1). The lab's `judge` flow,
 * word for word: hedge detection AUC 1.00, 20/20 caught, 0 false alarms on
 * the regex truth; `grounded` and `app_only` have no truth and are read as
 * rates. Re-benched on this exact wording before graduating (J1.1a).
 *
 * `evidence` is the same short named fields `moment-fanout` builds, so the
 * judge reads what the writer read. `assistant_wrote.line` is the text under
 * test — the one derived text in the state, and it is there BECAUSE it is
 * the thing being judged, named as the assistant's, not as a fact. Not
 * `intent`: that name is on the lint's denylist (law 2), and the lint is
 * right — a field called `intent` reads as a verdict, a field called `line`
 * reads as a thing someone wrote.
 */
import type { QuestionSet } from './index.js';
import { noul, score, keyed } from './index.js';
import { momentFanout, momentFanoutState, type MomentFanoutInput } from './moment-fanout.js';

export interface JudgeLineInput {
  moment: MomentFanoutInput;
  intent: string;
  narrative: string | null;
}

export const JUDGE_LINE_QUESTIONS = keyed('judge-line', {
  hedges: noul('Does `assistant_wrote` hedge with words like likely, probably, appears, seems, or otherwise avoid committing to a reading?'),
  grounded: noul('Is every project, person, tool and activity named in `assistant_wrote` present in `evidence`, with nothing invented?'),
  app_only: noul('Does `assistant_wrote.line` merely name the application or window instead of the work being done?'),
  names_the_work: noul('Does `assistant_wrote.line` name concrete work — what was being built, fixed, read, or discussed?'),
  quality: score('As a one-line record of this session for the owner to read later, how good is `assistant_wrote.line`?', [
    'Useless: wrong, empty, or just an application name.',
    'Weak: technically true but says nothing the window title did not.',
    'Good: names the work plainly.',
    'Excellent: names the work, the project and the point of it, in a few words.',
  ]),
});

export const judgeLine: QuestionSet<[JudgeLineInput]> = {
  id: 'judge-line',
  build: (input) => ({
    state: { evidence: momentFanoutState(input.moment), assistant_wrote: { line: input.intent, narrative: input.narrative } },
    questions: JUDGE_LINE_QUESTIONS,
  }),
  samples: () => momentFanout.samples().map(([moment], i) => [{ moment, intent: i === 0 ? 'Debugging the moment-close rule' : 'Working in Arc browser', narrative: i === 2 ? null : 'Spent the session on the runtime.' }]),
};
