/**
 * `screen-read`: what the window in front is, from its TEXT (`screenRead`,
 * `ocr.jev.text`). The state is what the fold already holds: the app's
 * profile, at most eight cleaned lines (sanitized at ingest, clipped), and
 * the typed facts as plain fields. No frame, and no derived label: the
 * profile is the app's family, read off its name, not a verdict on the work.
 */
import type { JudgementResultPayload, ScreenFact, ScreenReading } from '@sundial/kernel/types.js';
import { choice, clip, noul, type QuestionSet, keyed } from './index.js';

export const SCREEN_READ_MAX_LINES = 8;
const LINE_CHARS = 120;

export interface ScreenReadInput {
  app: string | null;
  appFamily: string;
  lines: string[];
  facts: ScreenFact[];
}

export const SCREEN_ACTIVITIES = {
  coding: 'Writing or changing code.',
  debugging: 'Chasing an error, a failing test or a broken build.',
  reviewing: 'Reading a diff, a pull request or a ticket.',
  reading: 'Reading documentation, an article or notes.',
  writing: 'Writing prose: a document, a message draft, notes.',
  communicating: 'In a chat, a mail or a thread with people.',
  meeting: 'In a call or a meeting.',
  admin: 'Settings, files, calendars, forms.',
  leisure: 'Not work: video, social, shopping, games.',
  unclear: 'The text does not say.',
};

export const SCREEN_READ_QUESTIONS = keyed('screen-read', {
  activity: choice('From `lines` (text read off the window in front) and `app_family`, what is the owner doing?', SCREEN_ACTIVITIES),
  meeting: noul('Is the window in front a call or a meeting with other people?'),
  blocked: noul('Does the text show an error or failure the owner is stuck on right now?'),
  work: noul('Is what is on screen the owner\'s work, rather than leisure?'),
});

export const screenRead: QuestionSet<[ScreenReadInput]> = {
  id: 'screen-read',
  build: (input) => {
    const values = (kind: ScreenFact['kind']): string[] => input.facts.filter((f) => f.kind === kind).map((f) => clip(f.value, 160));
    const error = values('error')[0];
    return {
      state: {
        app: input.app,
        app_family: input.appFamily,
        lines: input.lines.slice(0, SCREEN_READ_MAX_LINES).map((l) => clip(l, LINE_CHARS)),
        ...(error ? { error_line: error } : {}),
        ...(values('file').length > 0 ? { files: values('file') } : {}),
        ...(values('ticket').length + values('pr').length > 0 ? { refs: [...values('ticket'), ...values('pr')] } : {}),
        call_controls_on_screen: values('call').length > 0,
      },
      questions: SCREEN_READ_QUESTIONS,
    };
  },
  samples: () => [
    [{ app: 'dev.example.terminal', appFamily: 'terminal', lines: ['$ pnpm test', 'TypeError: cannot read properties of undefined', 'at render (src/card.ts:41)'], facts: [{ kind: 'error', value: 'TypeError: cannot read properties of undefined' }, { kind: 'file', value: 'card.ts' }] }],
    [{ app: 'com.example.browser', appFamily: 'browser', lines: ['BOX-484 Checkout times out on slow networks', 'Assignee Mira Bakker', 'In review'], facts: [{ kind: 'ticket', value: 'BOX-484' }] }],
    [{ app: 'us.example.calls', appFamily: 'generic', lines: ['Mute', 'Share screen', 'Mira Bakker'], facts: [{ kind: 'call', value: 'Calls' }, { kind: 'person', value: 'Mira Bakker' }] }],
  ],
};

const p = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);

/** Jev's answers as a `ScreenReading`; a missing answer is null, never a guess. */
export function screenReadingOf(answers: JudgementResultPayload['answers'] | undefined, at: string): ScreenReading {
  const activity = answers?.activity;
  const label = typeof activity?.choice === 'string' && activity.choice in SCREEN_ACTIVITIES ? activity.choice : null;
  return {
    at,
    activity: label,
    activityP: label === null ? null : p(activity?.probabilities?.[label] ?? activity?.confidence),
    meeting: p(answers?.meeting?.noul),
    blocked: p(answers?.blocked?.noul),
    work: p(answers?.work?.noul),
  };
}
