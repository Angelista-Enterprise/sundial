/**
 * `listen-reply` — the owner's free-text answer to a question Gnomon asked,
 * made actionable (J1.5). The lab's `reply` flow, word for word (qualitative:
 * "attach it to this question" → instruct 0.85, transcript 0.58; "close this
 * topic, not attending" → goals drop, mood 0.06), plus one verdict per open
 * goal in fixed slots, so a goal reply pauses or drops THE goal it names and
 * not "one or more".
 *
 * The owner's words are the one sentence-shaped field the laws allow to
 * steer (law 3): they are the owner's, named as such, and Jev follows a
 * declarative sentence 37/40 — here that is the point.
 */
import type { JudgeQuestion } from '@sundial/kernel/types.js';
import { choice, clip, noul, score, type QuestionSet } from './index.js';

export const MAX_GOALS = 6;
export const goalSlot = (i: number): string => `goal_g${i}`;

export interface ListenReplyInput {
  question: string;
  reason: string | null;
  answer: string;
  /** Names of the goals open when the question was asked, in the order the question listed them. */
  openGoals: string[];
}

const GOAL_VERDICT = (i: number): JudgeQuestion =>
  choice(`What does \`owner_replied\` say about the goal named in \`open_goals.g${i}\`?`, {
    progress: 'It moved forward, or got real time.',
    pause: 'The owner wants it paused for now.',
    drop: 'The owner wants it dropped.',
    unmentioned: 'The reply does not say anything about this goal.',
  });

export const LISTEN_REPLY_QUESTIONS = {
  answered: noul('Does `owner_replied` actually answer `assistant_asked`, rather than deflect or change the subject?'),
  wants_transcript_attached: noul('Does the owner ask, in `owner_replied`, for a transcript or recording to be attached or used?'),
  contains_decision: noul('Does `owner_replied` state a decision that was made?'),
  contains_followup: noul('Does `owner_replied` mention a follow-up, an action item, or something that still needs doing?'),
  mentions_people: noul('Does `owner_replied` name or refer to specific people?'),
  asks_assistant_to_do_something: noul('Does `owner_replied` give the assistant an instruction — find, add, attach, remind, pause, drop?'),
  sentiment: score('How does the owner feel about what `assistant_asked` referred to?', ['Negative: frustrated, disappointed, or dismissive.', 'Flat: neutral, purely informational.', 'Positive: went well, satisfied.', 'Enthusiastic: clearly pleased or energised.']),
  worth_remembering: score('Should this reply become a lasting memory?', ['No: nothing to keep.', 'Note: a small detail worth a line.', 'Yes: a real update on a project, meeting or goal.', 'Definitely: a decision or a change of direction.']),
};

/** The goal slot questions, fixed, so their ids are six stable ones. */
export const GOAL_SLOT_QUESTIONS: Record<string, JudgeQuestion> = Object.fromEntries(Array.from({ length: MAX_GOALS }, (_, i) => [goalSlot(i), GOAL_VERDICT(i)]));

export const listenReply: QuestionSet<[ListenReplyInput]> = {
  id: 'listen-reply',
  build: (input) => {
    const goals = input.openGoals.slice(0, MAX_GOALS);
    return {
      state: {
        assistant_asked: clip(input.question),
        why_it_asked: input.reason ? clip(input.reason) : null,
        owner_replied: clip(input.answer),
        ...(goals.length > 0 ? { open_goals: Object.fromEntries(goals.map((g, i) => [`g${i}`, clip(g, 120)])) } : {}),
      },
      questions: { ...LISTEN_REPLY_QUESTIONS, ...Object.fromEntries(goals.map((_, i) => [goalSlot(i), GOAL_SLOT_QUESTIONS[goalSlot(i)]])) },
    };
  },
  samples: () => [
    // Full width first: `judgementTrack` reads a set's ids off its first sample.
    [{ question: 'New week. Your open goals: a; b; c; d; e; f. Which got real time?', reason: '6 open goals on record', answer: 'a landed, drop f, pause b for now', openGoals: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    [{ question: 'How did "Puzzlez - Planning" go?', reason: 'ended 14:00 with Alex', answer: `good, i've got a transcript, attach it to this question. ${'x'.repeat(700)}`, openGoals: [] }],
  ],
};
