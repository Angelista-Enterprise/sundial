/**
 * `moment-fanout` — everything a closing moment might be asked, in one effect
 * (law 9). Ported from `lab/jev/flows.mjs`'s `moment` flow with three changes
 * the lab findings force:
 *
 * - No `kind` question. O2 (docs/jarvis/04): the rule's `computeMomentKind`
 *   matches the owner's sense better than Jev's label, and it is free.
 * - No `life_events`. They are rule-derived verdicts ("event:thrashing"), and
 *   a label in the state is followed, not checked (finding 2); the `live`
 *   flow failed on exactly this. Raw counts stand in their place (law 7).
 * - `subject`'s candidates point at STATE FIELDS with fixed wording, rather
 *   than quoting the project name into the criteria. The value is already in
 *   `project` / `git_branch` / `meeting_title` / `window_titles[0]`; quoting
 *   it made every moment its own question id, and a threshold cannot be
 *   learned for a question asked once.
 *
 * Graduation (J1.2) re-runs the bench on this exact wording before a rule
 * reads it; the lab's numbers are for the lab's wording.
 */
import type { MomentRollup } from '@sundial/kernel/types.js';
import { choice, clip, noul, score, type QuestionSet } from './index.js';

export interface MomentFanoutInput {
  rollup: MomentRollup;
  projectId: string | null;
  durationMs: number;
  /** J2.7: the owner's open goals, as short labels, in the slot order the consuming rule keeps (≤ `MAX_GOAL_SLOTS`). */
  openGoals?: string[];
  /** J4.4: promises heard earlier and still open (`commitments` rows with `source: speech`), as the words that were heard, ≤ `MAX_PROMISE_SLOTS`. */
  openPromises?: string[];
  /** J3.5: vault notes edited today (paths inside the vault, `.md` stripped), newest first, ≤ 8 — evidence for `subject`, not a criterion of it. */
  notesEditedToday?: string[];
  /** J3.6: subjects of mail received in the last hours, newest first, ≤ 5. Evidence only. */
  mailSubjects?: string[];
}

export const MAX_PROMISE_SLOTS = 4;
export const promiseSlot = (i: number): string => `resolves_promise_p${i}`;

/** Six fixed slots, as `listen-reply` has: a goal's question is stable wording pointing at `open_goals.gN`, never the goal's own text. */
export const MAX_GOAL_SLOTS = 6;
export const goalAdvanceSlot = (i: number): string => `advances_goal_g${i}`;

/** The moment's evidence as short named fields — the same evidence `buildActivityContext` writes as a paragraph. */
export function momentFanoutState(input: MomentFanoutInput): Record<string, unknown> {
  const r = input.rollup;
  const titles = r.windowTitles ?? [];
  const state: Record<string, unknown> = {
    app: r.processName,
    project: input.projectId,
    project_confidence: r.projectConfidence ?? null,
    minutes: Math.round(input.durationMs / 60_000),
    active_minutes: Math.round((r.activeMs ?? 0) / 60_000),
    window_titles: titles.slice(-12),
    distinct_window_titles: new Set(titles).size,
    shell_commands: (r.notableCommands ?? []).slice(0, 10),
    shell_command_count: r.shellCommandCount ?? 0,
    git_commits: r.gitCommitCount ?? 0,
    git_branch: r.gitBranch ?? null,
    calendar_active: Boolean(r.calendarActive),
    meeting_title: r.meetingTitle ?? null,
    meeting_attendee_count: (r.meetingAttendees ?? []).length,
    mic_active: Boolean(r.micActive),
    camera_active: Boolean(r.cameraActive),
    playback_active: Boolean(r.playbackActive),
    typing_events: r.typingEventCount ?? 0,
    input_events: r.inputEventCount ?? 0,
  };
  // The one sentence-shaped field: speech heard near the Mac, by anyone, or
  // noise whisper transcribed. Dutch stays Dutch (O1: same pick 26/30, no translation).
  if (r.spokenExcerpt) state.heard_aloud = clip(r.spokenExcerpt);
  // J3.5: the notes the owner edited today, as names. Evidence only — adding a
  // `note` option to `subject` would be a new question id (law 4) and needs its bench.
  const notes = (input.notesEditedToday ?? []).slice(0, 8).map((n) => clip(n, 80));
  if (notes.length > 0) state.notes_edited_today = notes;
  // J3.3 / J3.4 / J3.6: what a local vision model saw, the page's own words, recent mail subjects — evidence, clipped.
  if (r.screenFacts && r.screenFacts.length > 0) state.screen_facts = r.screenFacts.slice(-3).map((f) => clip(f, 160));
  if (r.pageExcerpt) state.page_text = clip(r.pageExcerpt);
  const mail = (input.mailSubjects ?? []).slice(0, 5).map((m) => clip(m, 120));
  if (mail.length > 0) state.mail_subjects_recent = mail;
  // J2.7: the goals, as the owner stated them (law 3), clipped, under fixed keys.
  const goals = (input.openGoals ?? []).slice(0, MAX_GOAL_SLOTS);
  if (goals.length > 0) state.open_goals = Object.fromEntries(goals.map((g, i) => [`g${i}`, clip(g, 200)]));
  // J4.4: the promises heard earlier, as heard (already sanitized at ingest), under fixed keys.
  const promises = (input.openPromises ?? []).slice(0, MAX_PROMISE_SLOTS);
  if (promises.length > 0) state.open_promises = Object.fromEntries(promises.map((t, i) => [`p${i}`, clip(t, 200)]));
  return state;
}

const SUBJECT = choice('Which field of the state names the work that was being done? A field that is null or empty is not available.', {
  project: 'The work is on the project named in `project`.',
  branch: 'The work is the git branch named in `git_branch`.',
  meeting: 'The work is the meeting named in `meeting_title`.',
  spoken: 'The work is whatever the owner described out loud in `heard_aloud`.',
  commands: 'The work is what the `shell_commands` were doing.',
  window: 'The work is what the first entry of `window_titles` names.',
  app: 'Nothing in the evidence names the work; only the application in `app` can honestly be reported.',
});

const DEPTH = score('How concentrated was the owner during this session, judged from switching, typing, interruptions and duration?', [
  'Scattered: many windows in a few minutes, interruption events, almost no typing.',
  'Shallow: some switching, work happening but repeatedly broken.',
  'Steady: mostly one thing, occasional switch, typing present.',
  'Deep: one thing for a long stretch, uninterrupted, commits or heavy typing.',
]);

const WORTH = score('If the owner asked about this session a month from now, how much would it matter?', [
  'Forgettable: routine browsing or a pass-through with nothing distinctive.',
  'Minor: ordinary work, nothing that would come up again.',
  'Worth keeping: a real piece of work on a named project or with a named person.',
  'Significant: a decision, a milestone, a meeting with outcomes, or a long deep session.',
]);

export const MOMENT_FANOUT_QUESTIONS = {
  subject: SUBJECT,
  is_work: noul('Was the owner doing work, as opposed to leisure or personal activity, during this session?'),
  depth: DEPTH,
  worth_remembering: WORTH,
  contains_commitment: noul('Does the evidence — especially `heard_aloud` — show the owner taking on an obligation to someone, such as promising to send, do, or deliver something?'),
  contains_blocker: noul('Does the evidence show the owner hitting something that blocked progress, such as a failing build, an error, or a missing permission?'),
  interrupt_ok: noul('At the end of this session, would it have been acceptable for an assistant to interrupt the owner with a short message?'),
};

const baseRollup = (over: Partial<MomentRollup> = {}): MomentRollup => ({
  processName: 'Code',
  windowTitles: ['runtime.ts — sundial', 'types.ts — sundial'],
  shellCommandCount: 3,
  notableCommands: ['npx vitest run', 'git commit'],
  gitCommitCount: 1,
  gitBranch: 'main',
  calendarActive: false,
  typingEventCount: 420,
  inputEventCount: 900,
  activeMs: 25 * 60_000,
  lifeEvents: ['event:thrashing'],
  projectSource: null,
  projectConfidence: null,
  micActive: false,
  cameraActive: false,
  meetingTitle: null,
  meetingAttendees: [],
  screenTopics: [],
  screenExcerpt: null,
  ...over,
});

/** One noul per goal slot (law 6: independent labels), fixed wording so six ids serve every moment. */
export const GOAL_ADVANCE_QUESTIONS: Record<string, ReturnType<typeof noul>> = Object.fromEntries(
  Array.from({ length: MAX_GOAL_SLOTS }, (_, i) => [goalAdvanceSlot(i), noul(`Was time in this session spent on the goal described in \`open_goals.g${i}\`, so that the goal moved forward?`)]),
);

/** One noul per open promise: does this session show it being kept? Fixed wording, four ids. */
export const PROMISE_RESOLVE_QUESTIONS: Record<string, ReturnType<typeof noul>> = Object.fromEntries(
  Array.from({ length: MAX_PROMISE_SLOTS }, (_, i) => [promiseSlot(i), noul(`Does this session show the promise quoted in \`open_promises.p${i}\` being kept — the thing promised was sent, done, delivered or handed over?`)]),
);

/** The set's questions: the fixed seven, plus one slot per open goal, plus one per open promise. */
export function momentFanoutQuestions(goalCount: number, promiseCount = 0): Record<string, ReturnType<typeof noul>> {
  const g = Math.min(goalCount, MAX_GOAL_SLOTS);
  const pr = Math.min(promiseCount, MAX_PROMISE_SLOTS);
  if (g === 0 && pr === 0) return MOMENT_FANOUT_QUESTIONS;
  return {
    ...MOMENT_FANOUT_QUESTIONS,
    ...Object.fromEntries(Array.from({ length: g }, (_, i) => [goalAdvanceSlot(i), GOAL_ADVANCE_QUESTIONS[goalAdvanceSlot(i)]])),
    ...Object.fromEntries(Array.from({ length: pr }, (_, i) => [promiseSlot(i), PROMISE_RESOLVE_QUESTIONS[promiseSlot(i)]])),
  };
}

export const momentFanout: QuestionSet<[MomentFanoutInput]> = {
  id: 'moment-fanout',
  build: (input) => ({ state: momentFanoutState(input), questions: momentFanoutQuestions(input.openGoals?.length ?? 0, input.openPromises?.length ?? 0) }),
  samples: () => [
    // Full width first: `judgementTrack` reads a set's ids off its first sample.
    [{ rollup: baseRollup(), projectId: 'sundial', durationMs: 31 * 60_000, openGoals: ['a', 'b', 'c', 'd', 'e', 'f'], openPromises: ['ik stuur het vanavond door', 'I will send the deck tomorrow', 'p3', 'p4'] }],
    [{ rollup: baseRollup({ processName: 'zoom.us', micActive: true, calendarActive: true, meetingTitle: 'Standup', meetingAttendees: ['a', 'b'], spokenExcerpt: 'x'.repeat(2000) }), projectId: null, durationMs: 15 * 60_000 }],
    [{ rollup: baseRollup({ windowTitles: Array.from({ length: 40 }, (_, i) => `tab ${i}`), notableCommands: Array.from({ length: 30 }, (_, i) => `cmd ${i}`) }), projectId: null, durationMs: 3 * 60_000 }],
  ],
};
