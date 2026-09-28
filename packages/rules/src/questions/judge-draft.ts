/**
 * `judge-draft` — J4.3. The text model drafts an email or a note from evidence
 * the owner can see; before the card shows it, the judge reads the draft
 * against that evidence: is every claim in it grounded, does the tone fit a
 * message the owner would send? The card shows the numbers beside the draft.
 * Nothing acts on them: the send tap is L4 and the owner's; the judge only
 * says how much to trust the words (docs/jarvis/05).
 */
import type { JudgementResultPayload } from '@sundial/kernel/types.js';
import { clip, noul, score, type QuestionSet } from './index.js';

export interface JudgeDraftInput {
  kind: 'email' | 'note';
  to: string | null;
  subject: string;
  body: string;
  evidence: string[];
}

export const JUDGE_DRAFT_QUESTIONS = {
  grounded: noul('Is every fact, name, date and promise in `draft` present in `evidence`, with nothing invented or embellished?'),
  tone: score('As a message the owner would send under their own name, how does `draft` read?', ['Wrong: rude, gushing, or not something a person would send.', 'Off: stiff or generic; would need rewriting.', 'Fit: plain, polite, sendable with a small edit.', 'Right: reads as the owner, ready to send.']),
};

export const judgeDraft: QuestionSet<[JudgeDraftInput]> = {
  id: 'judge-draft',
  build: (input) => ({
    state: {
      evidence: input.evidence.slice(0, 12).map((e) => clip(e, 300)),
      // `format`, not `kind`: the lint's denylist reads `kind` as a verdict (law 2).
      draft: { format: input.kind, to: input.to, subject: clip(input.subject, 160), body: clip(input.body, 600) },
    },
    questions: JUDGE_DRAFT_QUESTIONS,
  }),
  samples: () => [
    [{ kind: 'email', to: 'Marco', subject: 'Feedback on the hint border', body: 'Hi Marco, as promised: the hint border fix is in PR #4701. Could you have a look before Thursday?', evidence: ['PR #4701 "grid line fixes" opened 2026-09-18', 'heard aloud: "dan zal ik Marco jouw feedback zetten erin"', 'x'.repeat(900)] }],
    [{ kind: 'note', to: null, subject: 'Standup 2026-09-22', body: 'y'.repeat(1500), evidence: [] }],
  ],
};

export function draftJudgementOf(answers: JudgementResultPayload['answers']): { grounded: number | null; tone: number | null } {
  return { grounded: typeof answers.grounded?.noul === 'number' ? answers.grounded.noul : null, tone: typeof answers.tone?.score === 'number' ? Math.round(answers.tone.score) : null };
}
