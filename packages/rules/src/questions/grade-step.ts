/**
 * `grade-step` — J5.3. A goal's internal step ran as a dsh agent job and left
 * a shelf entry; did the entry accomplish the step? The judge reads the step
 * as written and the result as shelved, nothing else. A grade below θ marks
 * the step failed and the plan moves on; the report shows every grade.
 */
import type { JudgementResultPayload } from '@sundial/kernel/types.js';
import { clip, noul, type QuestionSet, keyed } from './index.js';

export interface GradeStepInput {
  goal: string;
  step: string;
  resultTitle: string;
  resultBody: string;
}

export const GRADE_STEP_QUESTIONS = keyed('grade-step', {
  accomplished: noul('Does `result` accomplish `step` for the goal in `goal` — the thing the step asked for is actually there, not a plan to do it or an apology for not doing it?'),
});

export const gradeStep: QuestionSet<[GradeStepInput]> = {
  id: 'grade-step',
  build: (input) => ({
    state: { goal: clip(input.goal, 200), step: clip(input.step, 300), result: { title: clip(input.resultTitle, 140), body: clip(input.resultBody, 600) } },
    questions: GRADE_STEP_QUESTIONS,
  }),
  samples: () => [
    [{ goal: 'work like Jarvis: proactive, show things unprompted', step: 'List the three notices of last week the owner marked useful and what they had in common', resultTitle: 'Useful notices, last week', resultBody: 'Three notices were marked useful: …'.padEnd(900, 'x') }],
    [{ goal: 'g', step: 's', resultTitle: 't', resultBody: '' }],
  ],
};

export const accomplishedOf = (answers: JudgementResultPayload['answers']): number | null => (typeof answers.accomplished?.noul === 'number' ? answers.accomplished.noul : null);
