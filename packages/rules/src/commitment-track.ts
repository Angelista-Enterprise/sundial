import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate as localDay } from '@sundial/helpers/local-day.js';
import type { ClosedCommitment, Commitment, CommitmentRow, Effect, KernelState, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { BASE_BRANCH, namesAKnownProject, slugifyEntityName, taskIdentity } from './entity-extract.js';
import { isMomentClosingBoundary } from './moment-close.js';

/**
 * How long a thread may go untouched before it is considered to have gone quiet.
 *
 * Fourteen days rather than seven: the ledger's whole reason for existing is
 * work that spans "hours to weeks", and a week-long gap is a normal shape for
 * that — a branch parked over a holiday, or behind review. Closing at seven
 * would classify the exact case the tier was built for as abandoned.
 *
 * This is a display decision, not a destructive one. Closing moves a thread out
 * of `open`; the row stays in the `commitments` table either way.
 */
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Bounded for the same reason `predictions.recentResolved` is: this slice rides
 * in every snapshot. Twenty open threads is already more than a person is
 * actually carrying, and the durable record is the table.
 */
const MAX_OPEN = 20;
const MAX_RECENT_CLOSED = 20;
/** Enough to show a thread's shape without letting one long-running branch grow its own row without bound. */
const MAX_ACTIVE_DAYS = 30;

export function rowFor(commitment: Commitment, closed: { closedAt: string; closedBecause: string } | null): CommitmentRow {
  return {
    id: commitment.id,
    name: commitment.name,
    source: commitment.source,
    branch: commitment.branch,
    projectId: commitment.projectId,
    projectName: commitment.projectName,
    openedAt: commitment.openedAt,
    lastTouchedAt: commitment.lastTouchedAt,
    touches: commitment.touches,
    activeDays: commitment.activeDays.length,
    closedAt: closed?.closedAt ?? null,
    closedBecause: closed?.closedBecause ?? null,
    promise: commitment.promise ?? null,
  };
}

/** Touch (or open) the thread the closing moment's branch names. */
function trackBranch(state: KernelState, event: SanitizedEvent): { state: KernelState; effects: Effect[] } {
  const moment = state.moment;
  if (!moment) return { state, effects: [] };

  const branch = moment.rollup.gitBranch;
  if (!branch || BASE_BRANCH.test(branch)) return { state, effects: [] };

  // Same derivation `entityExtract` uses for the `task` ENTITY, so the ledger
  // and the knowledge graph agree on what a piece of work is called. A reader
  // who finds `BOX-508` in one can look it up in the other.
  const name = taskIdentity(branch, moment.rollup.windowTitles.join(' '));
  if (!name) return { state, effects: [] };

  // A branch named after a repository is the trunk wearing the project's name —
  // the same skip `entityExtract` applies, through the same shared predicate so
  // the two cannot disagree about what counts as a piece of work. It reads the
  // project REGISTRY rather than the resolved project, which is what makes it
  // work here: this rule runs on unattributed moments too, and the corpus case it
  // was missing (`gnomon`, 336 moments) is precisely a branch whose name never
  // matches the project it resolves to.
  if (namesAKnownProject(name, state)) return { state, effects: [] };

  const id = `commitment:${slugifyEntityName(name)}`;
  const day = localDay(event.ts, state.config.timezone);
  const existing = state.commitments.open.find((c) => c.id === id);

  /**
   * The CLOSING MOMENT's own attribution, not `state.project.current`.
   *
   * `current` is a damped pointer over the recent detection window, and the
   * detection stream is a round-robin poll across every known root — ten roots,
   * one detection each, so no root ever holds the strict majority `nextCurrent`
   * demands and the pointer freezes wherever it last landed. The live corpus
   * showed every thread in the ledger stamped `puzzlebox-studio`, including
   * branches whose own moments resolved to `~/Projects/sundial`. The moment's
   * `projectId` comes from `resolveAttribution` and is the authority; the
   * ambient pointer is only a fallback for a moment that resolved to nothing.
   */
  const projectId = moment.projectId ?? state.project.current?.id ?? null;
  const projectName = projectId ? (state.project.known[projectId]?.name ?? (projectId === state.project.current?.id ? state.project.current.name : projectId)) : null;

  if (!existing) {
    const opened: Commitment = {
      id,
      name,
      source: 'git-branch',
      branch,
      // Attribution is recorded but never REQUIRED: roughly 78% of moments
      // resolve to no project (decisions/no-ambient-project-attribution), and a
      // ledger that only tracked attributed work would miss most of it.
      projectId,
      projectName,
      openedAt: event.ts,
      lastTouchedAt: event.ts,
      touches: 1,
      activeDays: [day],
      lastTouchUnpushed: moment.rollup.unpushedCommits ?? 0,
      merged: prFinished(moment.rollup.pr),
      pr: moment.rollup.pr ?? null,
    };
    return {
      state: {
        ...state,
        // Oldest-first eviction. A thread that has been open longest without
        // being closed is the one the staleness sweep is about to take anyway.
        commitments: { ...state.commitments, open: [...state.commitments.open, opened].slice(-MAX_OPEN) },
      },
      effects: [{ type: 'WriteDB', table: 'commitments', row: rowFor(opened, null) }],
    };
  }

  const isNewDay = !existing.activeDays.includes(day);
  const touched: Commitment = {
    ...existing,
    branch,
    // A moment that RESOLVED a project corrects the thread's attribution — the
    // first touch may have fallen back to the frozen ambient pointer, and a
    // later resolution is strictly better evidence. A moment that resolved to
    // nothing never erases an attribution the thread already carries.
    projectId: moment.projectId ?? existing.projectId ?? projectId,
    projectName: moment.projectId ? projectName : (existing.projectName ?? projectName),
    lastTouchedAt: event.ts,
    touches: existing.touches + 1,
    activeDays: isNewDay ? [...existing.activeDays, day].slice(-MAX_ACTIVE_DAYS) : existing.activeDays,
    // The LAST touch's tree state is what matters, so this overwrites rather than
    // accumulates: a branch left dirty on Tuesday and cleaned on Wednesday was finished,
    // not abandoned.
    lastTouchUnpushed: moment.rollup.unpushedCommits ?? 0,
    // Merged is sticky. A pull request does not un-merge, and a later touch on the same
    // branch (a follow-up fix) must not erase the fact that the work shipped.
    merged: existing.merged || prFinished(moment.rollup.pr),
    pr: moment.rollup.pr ?? existing.pr ?? null,
  };

  return {
    state: { ...state, commitments: { ...state.commitments, open: state.commitments.open.map((c) => (c.id === id ? touched : c)) } },
    /**
     * Written on EVERY touch.
     *
     * This used to be new-days-only, to keep a rule that fires on every moment
     * close from being the chattiest writer in the manifest. That reasoning
     * held only as long as nothing READ the row within the day — and the web
     * client's Threads row does, out of `getOpenCommitments`. The saving bought
     * a ledger that was a full day stale: a thread touched thirty times since
     * midnight showed "one touch, quiet since" its first commit, which is the
     * opposite of what a ledger of live work is for. One upsert per closing
     * moment is a few hundred a day against a local SQLite file.
     */
    effects: [{ type: 'WriteDB', table: 'commitments', row: rowFor(touched, null) }],
  };
}

/**
 * Threads worth mentioning when they go quiet.
 *
 * A single afternoon's branch going quiet is not news; a thread that was returned to
 * across several days and then stopped is exactly the "where was I" case the ledger
 * exists for. `activeDays` is the discriminator, and it is the one number a
 * single-session branch cannot have.
 */
const NOTABLE_ACTIVE_DAYS = 2;

/** Quiet this long, and still open, is worth a word before the ledger closes it. */
const FADING_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** A thread mentioned as fading must have been real work: this many sessions at least. */
const FADING_MIN_TOUCHES = 5;

/**
 * A pull request that reached a terminal state. Only this means the work is
 * finished. The first version treated ANY `git:pr-status` event as merged,
 * so a PR getting a review comment closed its thread's mouth for good — on the
 * live ledger BOX-484 (31 sessions, open PR under review) could never be
 * noticed going quiet.
 */
export function prFinished(pr: { state: string } | null | undefined): boolean {
  return pr?.state === 'MERGED' || pr?.state === 'CLOSED';
}

/**
 * Whether a quiet, fully-pushed thread with NO known pull request may be
 * finished work rather than abandoned work. Nothing observable settles it, so
 * the candidate goes out at half precision instead of not at all: the old rule
 * treated "pushed" as "done", and since every branch here is pushed, no quiet
 * notice fired in thirty days while fifteen threads sat open.
 */
function maybeFinished(thread: { lastTouchUnpushed: number; pr?: { state: string } | null }): boolean {
  return thread.lastTouchUnpushed === 0 && (thread.pr === null || thread.pr === undefined);
}

/**
 * A branch a Claude session made for its own worktree (`claude/…`, `claude-…`).
 * Its going quiet is the agent's work ending, not the owner's thread fading:
 * 6 of 33 quiet and fading lines on the record were about one.
 */
const AGENT_BRANCH = /^claude[/-]/i;

/**
 * A thread worth a word: returned to on more than one day, OR worked in
 * several sessions. `activeDays >= 2 && touches >= 5` together let nothing on
 * the live ledger through for a month.
 */
function notable(thread: { activeDays: string[]; touches: number; branch: string }): boolean {
  if (AGENT_BRANCH.test(thread.branch)) return false;
  return (thread.activeDays.length >= NOTABLE_ACTIVE_DAYS && thread.touches >= 3) || thread.touches >= FADING_MIN_TOUCHES;
}

function precisionOf(thread: { activeDays: string[]; touches: number }, unsure: boolean): number {
  return Math.min(1, Math.max(thread.activeDays.length, thread.touches / 5) / 5) * (unsure ? 0.5 : 1);
}

/**
 * The nudge BEFORE the close.
 *
 * `commitment-quiet` fires when a thread is retired at fourteen days — which is
 * the right moment to record that it went quiet, and far too late to be useful:
 * by then the owner has moved on twice. On the live ledger twelve threads were
 * open, none closed, and the most-touched of them (83 sessions) had been quiet
 * three days with nothing said. This is the earlier, tonic word: "you have not
 * touched BOX-484 since Monday", said once per silence, priced by the gate like
 * everything else.
 *
 * ONCE PER SILENCE is derived, not stored-and-cleared: a thread counts as
 * un-noticed when its `fadingNoticedAt` is absent or OLDER than its last touch,
 * so picking a thread up and dropping it again earns a second mention without
 * the touch path having to know this rule exists.
 */
function noticeFading(state: KernelState, event: SanitizedEvent, now: number): { state: KernelState; effects: Effect[] } {
  const effects: Effect[] = [];
  let changed = false;
  const open = state.commitments.open.map((thread) => {
    const quietMs = now - new Date(thread.lastTouchedAt).getTime();
    if (quietMs < FADING_AFTER_MS || quietMs >= STALE_AFTER_MS) return thread;
    if (!notable(thread)) return thread;
    if (thread.merged) return thread;
    if (thread.fadingNoticedAt !== undefined && thread.fadingNoticedAt >= thread.lastTouchedAt) return thread;

    const days = Math.round(quietMs / (24 * 60 * 60 * 1000));
    const unsure = maybeFinished(thread);
    const prNote = thread.pr ? `PR #${thread.pr.number} ${thread.pr.state.toLowerCase()}${thread.pr.reviewState ? `, ${thread.pr.reviewState.replace('_', ' ')}` : ''}` : null;
    const treeNote = thread.lastTouchUnpushed > 0 ? ', with unpushed changes' : prNote ? ` (${prNote})` : ', everything pushed';
    effects.push({
      type: 'EmitEvent',
      event: {
        id: deriveId(event.ts, event.id, 'commitment-track', `fading:${thread.id}:${thread.lastTouchedAt}`),
        type: 'notice:candidate',
        ts: event.ts,
        payload: {
          timestamp: event.ts,
          shape: 'transition',
          kind: 'commitment-fading',
          key: `commitment-fading:${thread.id}`,
          // Grows from ~0.5 at three days towards 1 as the close approaches — a
          // thread a week quiet is more of a finding than one three days quiet.
          surprise: 0.5 + 0.5 * Math.min(1, (quietMs - FADING_AFTER_MS) / (STALE_AFTER_MS - FADING_AFTER_MS)),
          precision: precisionOf(thread, unsure),
          // Tonic. This is context for the next conversation, not an interruption.
          valueHalfLifeMs: null,
          observation: `You have not touched ${thread.name} in ${days} days — ${thread.activeDays.length} day${thread.activeDays.length === 1 ? '' : 's'} of work across ${thread.touches} session${thread.touches === 1 ? '' : 's'}${treeNote}.`,
          evidence: [`branch ${thread.branch}`, `last touched ${thread.lastTouchedAt.slice(0, 10)}`, thread.projectName ? `project ${thread.projectName}` : 'no project attribution', ...(prNote ? [prNote] : []), ...(unsure ? ['no pull request seen — may be finished'] : [])],
          concerns: [thread.id],
        },
      },
    });
    changed = true;
    return { ...thread, fadingNoticedAt: event.ts };
  });
  return changed ? { state: { ...state, commitments: { ...state.commitments, open } }, effects } : { state, effects };
}

/** Move every thread that has gone quiet out of `open`. */
function closeStale(state: KernelState, event: SanitizedEvent): { state: KernelState; effects: Effect[] } {
  const now = new Date(event.ts).getTime();
  const stale = state.commitments.open.filter((c) => now - new Date(c.lastTouchedAt).getTime() >= STALE_AFTER_MS);
  if (stale.length === 0) return { state, effects: [] };

  const closed: ClosedCommitment[] = stale.map((c) => ({ ...c, closedAt: event.ts, closedBecause: 'went-quiet' }));

  const effects: Effect[] = closed.map((c) => ({ type: 'WriteDB', table: 'commitments', row: rowFor(c, { closedAt: c.closedAt, closedBecause: c.closedBecause }) }));

  /**
   * A `transition` notice candidate per notable thread — the noticing pipeline's
   * highest-value producer, and the reason a thread going quiet is a TRANSITION rather
   * than an omission.
   *
   * The distinction is not pedantry: the first attempt labelled this an absent
   * `repo` stream, and it could never fire. A repository keeps being touched while one
   * branch inside it is abandoned, so the repo's occurrence stream never goes quiet at
   * all. The unit that went quiet is the thread, and the ledger is the only thing that
   * tracks threads.
   *
   * Naturally edge-triggered: a thread crosses out of `open` exactly once, so there is
   * no marker to keep and nothing to re-arm.
   */
  for (const thread of closed) {
    if (!notable(thread)) continue;
    /**
     * Silence after finished work means DONE, and saying otherwise is the worst thing
     * this producer can do.
     *
     * Nothing observable tells Gnomon a branch was merged in general — the ledger's own
     * doc comment says so — but two things it does see are enough here: an open pull
     * request that reached a terminal state, and a clean tree with nothing left to push.
     * A thread that ends either way went quiet because it was completed.
     *
     * Every gate variant fired on the merged twin until this check existed. The twin is
     * in the corpus precisely because the two shapes are indistinguishable to a
     * staleness sweep, and only this field separates them.
     */
    if (thread.merged) continue;
    const quietMs = now - new Date(thread.lastTouchedAt).getTime();
    const unsure = maybeFinished(thread);
    const days = Math.round(quietMs / (24 * 60 * 60 * 1000));
    effects.push({
      type: 'EmitEvent',
      event: {
        id: deriveId(event.ts, event.id, 'commitment-track', `quiet:${thread.id}`),
        type: 'notice:candidate',
        ts: event.ts,
        payload: {
          timestamp: event.ts,
          shape: 'transition',
          kind: 'commitment-quiet',
          key: `commitment-quiet:${thread.id}`,
          // Days quiet, in multiples of the staleness window — the same "how many times
          // over is this" shape `absenceSurprise` uses, so the two are comparable when
          // the gate ranks them against each other.
          surprise: quietMs / STALE_AFTER_MS,
          // A thread returned to over more days is a better-evidenced claim that it
          // mattered. Full confidence at a working week.
          precision: precisionOf(thread, unsure),
          // Reads the same next week.
          valueHalfLifeMs: null,
          observation: `${thread.name} has been quiet ${days} days, after ${thread.activeDays.length} days of work across ${thread.touches} sessions`,
          evidence: [
            `branch ${thread.branch}`,
            `${thread.activeDays.length} active days`,
            `last touched ${thread.lastTouchedAt.slice(0, 10)}`,
            thread.projectName ? `project ${thread.projectName}` : 'no project attribution',
            ...(thread.pr ? [`PR #${thread.pr.number} ${thread.pr.state.toLowerCase()}`] : []),
            ...(unsure ? ['no pull request seen — may be finished'] : []),
          ],
          concerns: [thread.id],
        },
      },
    });
  }

  return {
    state: {
      ...state,
      commitments: {
        ...state.commitments,
        open: state.commitments.open.filter((c) => !stale.some((s) => s.id === c.id)),
        recentClosed: [...state.commitments.recentClosed, ...closed].slice(-MAX_RECENT_CLOSED),
      },
    },
    effects,
  };
}

/**
 * The commitment ledger — the memory tier between a calendar day and a durable
 * fact, which `decisions/assistant-as-an-event-source` identified as the hole
 * in the four-tier model: nothing covered "a single piece of work spanning
 * hours to weeks", and that is the unit a person plans in.
 *
 * Sources, deliberately deterministic. A thread is opened by the git branch a
 * closing moment carried, via the same `taskIdentity` derivation `entityExtract`
 * uses for the `task` entity. LLM extraction of promises from moment summaries
 * is the interesting version and is NOT here: it is also where false positives
 * come from, and a ledger nobody trusts is worse than no ledger. The boring
 * source ships first and earns the second.
 *
 * There is no forecaster attached, and that is a measurement rather than an
 * omission. "Will this thread be picked up again after today" was tested first,
 * per `guides/measure-forecast-skill`: the reference corpus holds 17 task
 * branches, 5 of which span more than one day, and the only conditioning
 * feature available at open time (does the name carry a ticket id) splits them
 * 4-of-9 against 1-of-8 — two-sided Fisher p = 0.29, in the opposite direction
 * to intuition. Fitting a prior to that would be `project-continuity` again.
 *
 * Reacts to `window:changed` (a moment closing, carrying a branch) and
 * `clock:tick` (the staleness sweep), so it rides the existing heartbeat rather
 * than adding a timer — D2, and "the law".
 *
 * Must sit BEFORE `momentClose` in `RULE_MANIFEST`, the same requirement
 * `entityExtract` carries and for the same reason: it reads the about-to-close
 * `state.moment`.
 */
/** Close one open thread for a reason. Unknown id: nothing. */
function closeThread(state: KernelState, id: string, closedBecause: ClosedCommitment['closedBecause'], ts: string): { state: KernelState; effects: Effect[] } {
  const thread = state.commitments.open.find((c) => c.id === id);
  if (!thread) return { state, effects: [] };
  const closed: ClosedCommitment = { ...thread, closedAt: ts, closedBecause };
  return {
    state: {
      ...state,
      commitments: { ...state.commitments, open: state.commitments.open.filter((c) => c.id !== id), recentClosed: [...state.commitments.recentClosed, closed].slice(-MAX_RECENT_CLOSED) },
    },
    effects: [{ type: 'WriteDB', table: 'commitments', row: rowFor(closed, { closedAt: ts, closedBecause }) }],
  };
}

export const commitmentTrack: Rule = (state, event) => {
  // A promise heard aloud (`commitment:heard`) is `promiseTrack`'s since UC1:
  // promises have their own list and cap. A speech thread opened here before
  // that still closes here, by the owner or the sweep.
  if (event.type === 'commitment:resolved' || event.type === 'commitment:closed') {
    const { id, due } = event.payload as { id?: unknown; due?: unknown };
    // A new due date moves a promise (`promiseTrack`); it never closes a thread.
    if (due !== undefined) return { state, effects: [] };
    return typeof id === 'string' ? closeThread(state, id, event.type === 'commitment:resolved' ? 'seen-done' : 'owner', event.ts) : { state, effects: [] };
  }
  if (event.type === 'clock:tick') {
    const faded = noticeFading(state, event, new Date(event.ts).getTime());
    const closed = closeStale(faded.state, event);
    return { state: closed.state, effects: [...faded.effects, ...closed.effects] };
  }
  if (event.type !== 'window:changed') return { state, effects: [] };
  // A same-process title change appends to the open moment rather than closing
  // it (see `momentClose`'s `isMomentClosingBoundary`), so counting it as a
  // touch would inflate `touches` by every keystroke that retitled a window.
  if (!isMomentClosingBoundary(state, event)) return { state, effects: [] };
  return trackBranch(state, event);
};

/** Exported for the staleness test and for anything that needs to explain the window to a reader. */
export const COMMITMENT_STALE_AFTER_MS = STALE_AFTER_MS;
