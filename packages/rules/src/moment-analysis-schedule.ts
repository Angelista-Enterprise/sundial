import { withPersona } from '@sundial/kernel/persona.js';
import type { MomentRollup, Rule } from '@sundial/kernel/types.js';
import { isMarked } from './ingest-anomaly.js';
import { notesEditedToday } from './vault-track.js';
import { closingMomentRow, noIntentReason } from './moment-close.js';
import { goalLabel, openGoals } from './goal-checkin.js';
import { describeScreenFacts } from './screen-facts.js';
import { MAX_GOAL_SLOTS, momentFanout } from './questions/moment-fanout.js';

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
  // Typed on this Mac from the screen (`screen-facts.ts`); refs are on the line above, so not twice.
  const seen = describeScreenFacts((rollup.screenSeen ?? []).filter((f) => f.kind !== 'ticket' && f.kind !== 'pr'));
  if (seen.length > 0) lines.push(`Read off the screen: ${seen.join(' · ')}`);
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
  const durationMs = typeof closed.durationMs === 'number' ? closed.durationMs : 0;
  const projectId = typeof closed.projectId === 'string' ? closed.projectId : null;
  const notes = notesEditedToday(state);
  const fanout = momentFanout.build({ rollup: closing.rollup, projectId, durationMs, openGoals: goals.map(goalLabel), notesEditedToday: notes, mailSubjects: [] }); // the mail reader was dropped on 2026-10-14; the fan-out keeps its slot
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
          projectId,
          projectName: projectId ? (state.project.known[projectId]?.name ?? projectLabel(projectId)) : null,
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
