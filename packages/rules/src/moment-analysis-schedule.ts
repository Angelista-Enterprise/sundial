import { withPersona } from '@sundial/kernel/persona.js';
import type { Commitment, KernelState, MomentRollup, Rule } from '@sundial/kernel/types.js';
import { namesDeliverable, samePerson } from './promise-terms.js';
import { isMarked } from './ingest-anomaly.js';
import { notesEditedToday } from './vault-track.js';
import { recentMailSubjects } from './mail-track.js';
import { closingMomentRow, noIntentReason } from './moment-close.js';
import { goalLabel, openGoals } from './goal-checkin.js';
import { clip } from './questions/index.js';
import { MAX_GOAL_SLOTS, MAX_PROMISE_SLOTS, momentFanout } from './questions/moment-fanout.js';

interface WindowChangedPayload {
  processName?: string;
}

const ANALYSIS_DELAY_MS = 10_000;

/**
 * B4 — the prompt now reads from the whole enriched rollup `momentRollup`
 * accumulates, not just `windowTitles`: shell/git activity, calendar
 * presence, and derived life events all sat in the log unused by this
 * prompt before B4 gave this rule somewhere to read them from.
 *
 * D5 (docs/audit/production-proposal-and-enhancements.md, addresses A§5.1,
 * A§5.5) — `priorities` (the daily reflection's "top entities/projects of
 * the week," `state.memory.priorities`) is appended when non-empty. This is
 * the actual "loop back into perception" the proposal names: memory
 * (reflection output) now shapes how a NEW moment gets interpreted, not
 * just what gets displayed after the fact.
 */
/** `named:gnomon` and `~/Projects/sundial` both become something a sentence can hold. */
function projectLabel(projectId: string | null): string | null {
  if (!projectId) return null;
  if (projectId.startsWith('named:')) return projectId.slice(6);
  const leaf = projectId.split('/').filter(Boolean).at(-1);
  return leaf && leaf !== '~' ? leaf : projectId;
}

/**
 * What the model is told about a closed moment.
 *
 * The audit's worst line came from here: a 31-minute session of dictation and
 * 32 shell commands inside `sundial` was named "Working in Arc browser". The
 * model was not wrong — it was told the process name, a list of browser tab
 * titles and nothing else, and then told that if the work cannot be identified
 * it should say what was on screen. It did exactly that.
 *
 * Everything added here already existed on the rollup and never reached the
 * prompt: which project the moment was attributed to, how long it ran and how
 * much of that was active, what was said aloud, and which commands were run
 * (empty until the notability filter beside this was fixed). The spoken
 * excerpt goes first among the evidence, labelled for what it is: speech heard
 * near the Mac, by anyone, or whisper's invention on noise. It is not the
 * owner's word (the sensor claims no speaker), so it outranks nothing.
 */
function buildActivityContext(rollup: MomentRollup, titles: string[], newProcessName: string | null, priorities: string[], projectId: string | null, durationMs: number, notes: string[] = []): string {
  const project = projectLabel(projectId);
  const minutes = Math.round(durationMs / 60_000);
  const activeMin = Math.round(rollup.activeMs / 60_000);
  const lines = [`Process: ${rollup.processName}`];
  // Attribution is the single most load-bearing fact about a work moment, and
  // its absence is information too: "no project" stops the model inventing one.
  lines.push(project ? `Project: ${project}${rollup.projectConfidence ? ` (${rollup.projectConfidence} attribution)` : ''}` : 'Project: not attributable from this window.');
  if (minutes > 0) lines.push(`Lasted ${minutes} min${activeMin > 0 && activeMin !== minutes ? `, ${activeMin} min of it active` : ''}.`);
  // Heard near the Mac: no speaker is known, and silence transcribes as
  // confident sentences, so the prompt is told to weigh it, not to obey it.
  if (rollup.spokenExcerpt) lines.push(`HEARD ALOUD during this moment — heard nearby; may be anyone, may be noise: “${rollup.spokenExcerpt}”`);
  lines.push(`Window titles seen, in order: ${titles.join(' -> ')}`);
  if (rollup.gitCommitCount > 0) lines.push(`Git commits: ${rollup.gitCommitCount}${rollup.gitBranch ? ` (branch ${rollup.gitBranch})` : ''}`);
  // The count rides along only when it says something the list does not: that
  // more was run than is named here.
  if (rollup.notableCommands.length > 0) lines.push(`Shell commands run${rollup.shellCommandCount > rollup.notableCommands.length ? ` (${rollup.shellCommandCount} in all)` : ''}: ${rollup.notableCommands.join(' · ')}`);
  else if (rollup.shellCommandCount > 0) lines.push(`Shell commands run: ${rollup.shellCommandCount}`);
  if (rollup.calendarActive) lines.push('A calendar event was active during this session.');
  if (rollup.lifeEvents.length > 0) lines.push(`Notable activity detected: ${rollup.lifeEvents.join(', ')}`);
  if (rollup.screenRefs && rollup.screenRefs.length > 0) lines.push(`Tickets / PRs on screen: ${rollup.screenRefs.join(', ')}`);
  if (rollup.symbolsEdited && rollup.symbolsEdited.length > 0) lines.push(`Code symbols edited: ${rollup.symbolsEdited.join(', ')}`);
  // Omitted, not filled with "unknown", when the moment did not end by moving
  // to another window — a moment closed by idle, sleep, or the thirty-minute
  // split has no next window, and asserting one is a fact the model will use.
  if (newProcessName) lines.push(`Next window the user moved to: ${newProcessName}`);
  if (priorities.length > 0) lines.push(`This week's priorities (most time spent): ${priorities.join(', ')}`);
  // J3.5: a note edited today is a candidate for what the work was about.
  if (notes.length > 0) lines.push(`Vault notes edited today: ${notes.join(', ')}`);
  return lines.join('\n');
}

/**
 * Reacts to any event that closes a moment — all five of `momentClose`'s
 * triggers, asked via `closingMomentRow` rather than re-derived here — under the
 * "runs before `momentClose`" ordering requirement `momentClose`'s doc comment
 * describes for the other about-to-close-moment readers: it reads `state.moment`
 * before `momentClose` overwrites it for this same event.
 *
 * B2 (docs/audit/production-proposal-and-enhancements.md) replaces the
 * former `intentSchedule`/`narrateOnClose` pair with this one rule and one
 * `ScheduleLLM` effect asking for strict JSON `{"intent": "...",
 * "narrative": "..."}` — halves the LLM call volume per closing moment and
 * guarantees the two descriptions can't drift apart (`applyLlmResult`
 * parses both fields out of the same completion). Skips scheduling
 * entirely for a moment under `MIN_MOMENT_DURATION_MS` — `momentClose` is
 * about to drop that same moment as too-thin-to-count, so there's no DB row
 * for the eventual result to attach to anyway.
 *
 * `delayMs: ANALYSIS_DELAY_MS` (not `0`) matches the proposal's stated
 * mechanism, but this pass does **not** implement its paired executor-side
 * coalescing ("drop the call if the same process reopens immediately,
 * keyed by deterministic momentId") — that needs the executor to track and
 * cancel pending scheduled calls in a way that interacts with A2's effect
 * journal (a coalesced-away `ScheduleLLM` must still be marked applied so
 * replay doesn't re-schedule it, but must never produce an `llm:result` of
 * its own), which deserves its own scoped pass rather than folding in here.
 * Real, honest gap left open: a rapid genuine process-to-process-and-back
 * bounce (each leg individually above `MIN_MOMENT_DURATION_MS`, so neither
 * gets dropped by B1) still schedules two separate calls today.
 */
/** UC1 (U1-F23): the promises most worth a resolve slot in this moment. */
export function slotPromises(promises: readonly Commitment[], rollup: Pick<MomentRollup, 'meetingAttendees' | 'windowTitles'>): Commitment[] {
  const titles = rollup.windowTitles.join(' ');
  const score = (c: Commitment): number => (rollup.meetingAttendees.some((a) => samePerson(a, c.promise?.counterparty)) ? 2 : 0) + (c.promise && namesDeliverable(c.promise.keys, titles) ? 1 : 0);
  return promises
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, MAX_PROMISE_SLOTS)
    .map(({ c }) => c);
}

/** A mail sent, or a message the owner wrote, inside the moment. */
function sentDuring(state: KernelState, from: string, to: string): boolean {
  const inside = (at: string) => at >= from && at <= to;
  return (state.mail?.sent ?? []).some((m) => inside(m.at)) || (state.mail?.messages ?? []).some((m) => m.fromMe && inside(m.at));
}

export const momentAnalysisSchedule: Rule = (state, event) => {
  // D2-adjacent fix (see moment-close.ts's `closingMomentRow` doc comment) —
  // a same-process/same-project title change appends to the open moment (B1)
  // instead of closing it; without this check, a long single-process session
  // re-scheduled a fresh LLM call on every title change, all analyzing the
  // same still-open moment id. Asking `closingMomentRow` rather than the
  // `window:changed`-only boundary test also covers the four other triggers
  // `momentClose` closes on, whose moments were never analyzed at all.
  //
  // A null row also means the moment was under `MIN_MOMENT_DURATION_MS` and is
  // being dropped rather than written, so there would be no row for the
  // eventual `llm:result` to attach to.
  const closed = closingMomentRow(state, event);
  if (!closed || !state.moment) return { state, effects: [] };

  // J3.7: a title the anomaly check marked as a claim or an instruction never
  // reaches the judge or the text model. It stays in the log and on the row.
  const closing = { ...state.moment, rollup: { ...state.moment.rollup, windowTitles: state.moment.rollup.windowTitles.filter((t) => !isMarked(state, t)), pageExcerpt: state.moment.rollup.pageExcerpt && !isMarked(state, state.moment.rollup.pageExcerpt) ? state.moment.rollup.pageExcerpt : null } };
  // A closing moment with no title but the process name is too thin to analyze — a single
  // instantaneous window flick, not real content. E3 (fixes A§6.3): one whose every title
  // `sanitizeAtIngest` blanked to `[private]`/`[hidden]` has nothing left to analyze either;
  // the prompt would be pure noise. `noIntentReason` is the one test, shared with the close.
  if (noIntentReason(closing.processName, closing.rollup.windowTitles) !== null) return { state, effects: [] };
  const titles = closing.rollup.windowTitles.filter((t) => t && t !== closing.processName);

  const newProcessName = event.type === 'window:changed' && typeof (event.payload as WindowChangedPayload).processName === 'string' ? (event.payload as WindowChangedPayload).processName! : null;

  // J1.2 (option A): the fan-out rides every close. Jev answers subject,
  // depth, worth, commitment, blocker, is_work from the same evidence the
  // render reads; `applyMomentJudgement` stores them on the moment as
  // numbers. The render stays — the side-by-side (O6) said the model's line
  // is the better record 31/40 — and the fan-out's `state` doubles as the
  // evidence that travels with the render for `verifyLine` (J1.1).
  // J2.7: one slot per open goal rides along; the slot → goal map travels in
  // the metadata so `applyMomentJudgement` credits THE goal that was in the
  // slot, not whichever is open when the answer lands.
  const goals = openGoals(state.memory.factCursor).slice(0, MAX_GOAL_SLOTS);
  // J4.4: the promises still open, so a kept one can be closed — the fallback
  // to UC1's deterministic evidence. Four slots, filled by relevance rather
  // than age (U1-F23): a promise to someone in this moment's meeting, or whose
  // deliverable a title names, first; then the oldest. A fifth promise was
  // never in a slot before, so it could never be closed this way.
  const promises = slotPromises(state.commitments.promises, closing.rollup);
  const durationMs = typeof closed.durationMs === 'number' ? closed.durationMs : 0;
  const projectId = typeof closed.projectId === 'string' ? closed.projectId : null;
  const notes = notesEditedToday(state);
  const fanout = momentFanout.build({ rollup: closing.rollup, projectId, durationMs, openGoals: goals.map(goalLabel), openPromises: promises.map((c) => c.promise?.quote ?? c.name), notesEditedToday: notes, mailSubjects: recentMailSubjects(state, event.ts) });
  const r = closing.rollup;

  return {
    state,
    effects: [
      {
        type: 'Judge',
        purpose: 'classify',
        questionSetId: momentFanout.id,
        momentId: closed.id,
        delayMs: ANALYSIS_DELAY_MS,
        state: fanout.state,
        questions: fanout.questions,
        metadata: {
          durationMs,
          goals: goals.map((g) => g.entityId),
          promises: promises.map((c) => c.id),
          projectId,
          projectName: projectId ? (state.project.known[projectId]?.name ?? projectLabel(projectId)) : null,
          // J4.4's second key (docs/jarvis/05): closing a promise needs evidence a
          // third party could not have typed into a title — a commit, commands run,
          // a meeting on the calendar, the mic open.
          // U1-F25: a mail sent or a message written in the moment is such evidence too.
          nonText: r.gitCommitCount > 0 || r.shellCommandCount > 0 || Boolean(r.calendarActive) || Boolean(r.micActive) || sentDuring(state, closing.startTime, event.ts),
          // The words the promise would be quoted from, clipped; absent when nothing was heard.
          ...(r.spokenExcerpt ? { spoken: clip(r.spokenExcerpt, 160) } : {}),
        },
      },
      {
        type: 'ScheduleLLM',
        purpose: 'intent',
        momentId: closed.id,
        delayMs: ANALYSIS_DELAY_MS,
        // J1.1: the evidence the line is written from travels with the render,
        // so `verifyLine` can judge the line against it after this moment has
        // closed and `state.moment` is the next one.
        metadata: { evidence: fanout.state, attempt: 1 },
        messages: [
          {
            role: 'system',
            // `intent` is rendered directly in Memory · Recorded, one line per
            // moment, so it is written to be READ rather than to be summarised.
            //
            // The previous wording — "stating what the user was likely doing" —
            // produced exactly what it asked for: "The user is working in Gnomon,
            // likely on a coding or development-related task." Three quarters of
            // that line is preamble and hedging, and on a row whose title is just
            // "Gnomon" it was the only text with any content in it. Naming the
            // subject and banning the hedge is the whole fix; the honest
            // uncertainty is carried by the `inferred` mark the row draws it in,
            // not by the word "likely" inside the sentence.
            content: withPersona(
              'You are reading a short window of that activity and naming what it was.',
              'Respond with STRICT JSON only, no markdown fencing, matching exactly: {"intent": "...", "narrative": "..."}. "intent": a single short phrase naming the concrete work, under 70 characters, written as a bare verb phrase ("Debugging the moment-close rule", "Reviewing a pull request"). Never begin with "The user" and never hedge with "likely", "probably", "appears to" or "seems" — state the reading plainly; the interface marks it as inferred. "narrative": a one-sentence, past-tense journal entry describing the same work session — no preamble, no quotes.',
              // Downstream this line becomes the `[bracketed]` hint the journal
              // and the ask persona are both told to distrust. It is the FIRST
              // model output in the chain, so an invented project name here is
              // one the later passes can only inherit.
              //
              // "Say what was on screen" used to stand alone here, and on a
              // moment whose only rich field was a list of browser tabs it was
              // read as permission: 31 minutes of dictated work inside a
              // project came back as "Working in Arc browser". The escape hatch
              // stays — a moment with nothing in it must not be guessed at —
              // but it is now the LAST resort, after the evidence the prompt
              // actually carries.
              'Name the WORK, not the window. Weigh the evidence in this order: what was heard aloud, then the project and the commands and commits, then the window titles. An application name ("Arc", "Warp", "Code") is never an intent on its own — if the other evidence says what was being worked on, say that instead. Only when there is no such evidence may you describe what was on screen, and never guess a purpose beyond it.',
            ),
          },
          {
            role: 'user',
            // The CLOSED row's project and duration, not the open moment's:
            // `closeMoment` resolves attribution (git-activity fallback, brief
            // excursions absorbed) on the way out, and the prompt should read
            // what was written, not what was pending.
            content: buildActivityContext(closing.rollup, titles, newProcessName, state.memory.priorities, projectId, durationMs, notes),
          },
        ],
      },
    ],
  };
};
