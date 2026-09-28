import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { CommitmentRow, Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { commitmentTrack, COMMITMENT_STALE_AFTER_MS } from './commitment-track.js';

/** Local wall-clock intent, for the same reason `day-shape-forecast.test.ts` builds its fixtures this way — the rule buckets on the LOCAL day. */
function localTs(year: number, month: number, day: number, hour = 10, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

function windowChanged(ts: string, id: string, processName = 'Code'): SanitizedEvent {
  return { id, type: 'window:changed', ts, payload: { processName, windowTitle: 'x', windowId: 'w1' }, sanitized: true };
}

function tick(ts: string, id: string): SanitizedEvent {
  return { id, type: 'clock:tick', ts, payload: {}, sanitized: true };
}

/**
 * A state with an open moment carrying `branch`, on a process DIFFERENT from
 * the incoming event's — which is what makes the next `window:changed` a real
 * moment-closing boundary rather than a title change.
 */
function withMoment(base: KernelState, branch: string | null, opts: { project?: { id: string; name: string } | null; titles?: string[]; unpushed?: number; merged?: boolean; pr?: { number: number; state: string; reviewState: string | null } | null } = {}): KernelState {
  const project = opts.project === undefined ? { id: 'p1', name: 'gnomon' } : opts.project;
  return {
    ...base,
    project: { ...base.project, current: project === null ? null : { id: project.id, name: project.name } },
    moment: {
      id: 'm1',
      sessionId: 's1',
      startTime: localTs(2026, 8, 1, 9),
      processName: 'Terminal',
      projectId: project?.id ?? null,
      // A MERGED pull request is what marks work finished; a status event alone
      // used to, which is why an open PR under review looked done.
      rollup: { ...createInitialState('d1').moment?.rollup, gitBranch: branch, windowTitles: opts.titles ?? [], unpushedCommits: opts.unpushed ?? 0, lifeEvents: opts.merged || opts.pr ? ['git:pr-status'] : [], pr: opts.merged ? { number: 1, state: 'MERGED', reviewState: null } : (opts.pr ?? null) } as KernelState['moment'] extends null ? never : NonNullable<KernelState['moment']>['rollup'],
      intent: { status: 'none' },
    },
  };
}

const rowOf = (effects: Effect[]): CommitmentRow | undefined =>
  effects.filter((e): e is Extract<Effect, { type: 'WriteDB'; table: 'commitments' }> => e.type === 'WriteDB' && e.table === 'commitments')[0]?.row;

describe('commitmentTrack', () => {
  it('opens a thread from the branch a closing moment carried, named the way entityExtract names the task entity', () => {
    const state = withMoment(createInitialState('d1'), 'feat/redesign-and-ios');

    const { state: next, effects } = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1'));

    expect(next.commitments.open).toHaveLength(1);
    expect(next.commitments.open[0]).toMatchObject({
      id: 'commitment:redesign-and-ios',
      name: 'redesign-and-ios',
      source: 'git-branch',
      branch: 'feat/redesign-and-ios',
      touches: 1,
      activeDays: ['2026-08-01'],
    });
    expect(rowOf(effects)).toMatchObject({ id: 'commitment:redesign-and-ios', activeDays: 1, closedAt: null });
  });

  it('prefers a ticket id over the branch text, so the ledger and the task entity agree', () => {
    const state = withMoment(createInitialState('d1'), 'fix/BOX-411-compact-header');

    const { state: next } = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1'));

    expect(next.commitments.open[0]?.name).toBe('BOX-411');
    expect(next.commitments.open[0]?.id).toBe('commitment:box-411');
  });

  /**
   * One ticket, one thread, however the branch spelled it.
   *
   * This test previously pinned the opposite — `taskIdentity`'s ticket pattern
   * was uppercase-only, so `fix/BOX-508-…` and `box-508/…` opened two threads
   * and minted two `task` entities for one piece of work. It was written to
   * fail loudly the day that was fixed rather than let a change silently
   * re-identify history, and it did.
   */
  it('recognises a ticket id whatever case the branch used — one ticket, one thread', () => {
    const upper = commitmentTrack(withMoment(createInitialState('d1'), 'fix/BOX-508-end-screen'), windowChanged(localTs(2026, 8, 1, 10), 'e1'));
    const lower = commitmentTrack(withMoment(createInitialState('d1'), 'box-508/end-screen-button'), windowChanged(localTs(2026, 8, 1, 10), 'e2'));

    expect(upper.state.commitments.open[0]?.name).toBe('BOX-508');
    expect(lower.state.commitments.open[0]?.name).toBe('BOX-508');
    expect(upper.state.commitments.open[0]?.id).toBe(lower.state.commitments.open[0]?.id);
  });

  /**
   * The cost of widening that pattern, pinned so it stays visible.
   *
   * A branch suffix shaped like `word-number` is now read as a ticket unless the
   * key is in `NOT_A_TICKET_KEY`. That list cannot be complete, so some ordinary
   * branch names will be renamed into ticket-looking threads. The failure is
   * cosmetic — a thread called `THREAD-29` rather than `thread-29`, still one
   * thread for one branch — which is why it is worth the merge it buys, but it
   * is a real edge and this is where it is recorded.
   */
  it('reads an ordinary word-number branch suffix as a ticket, which is the known cost of the merge', () => {
    const { state } = commitmentTrack(withMoment(createInitialState('d1'), 'feat/thread-29'), windowChanged(localTs(2026, 8, 1, 10), 'e1'));

    expect(state.commitments.open[0]?.name).toBe('THREAD-29');
  });

  /** A trunk is not a piece of work. Same list `entityExtract` skips, shared rather than re-spelled. */
  it('ignores a base branch', () => {
    for (const branch of ['main', 'develop', 'release/2026.8', 'production', 'stable']) {
      const { state: next, effects } = commitmentTrack(withMoment(createInitialState('d1'), branch), windowChanged(localTs(2026, 8, 1, 10), 'e1'));
      expect(next.commitments.open, branch).toHaveLength(0);
      expect(effects, branch).toEqual([]);
    }
  });

  it('ignores a branch named after the project itself — the trunk wearing the repo name', () => {
    const state = withMoment(createInitialState('d1'), 'gnomon', { project: { id: 'p1', name: 'gnomon' } });

    expect(commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state.commitments.open).toHaveLength(0);
  });

  /**
   * The case that made this rule's largest thread a trunk. In the reference
   * corpus the branch `gnomon` resolved to five projects and never to one called
   * `gnomon`, so a guard comparing against the RESOLVED project never fired and
   * the ledger reported 336 touches over 6 days as the thing most carried.
   */
  it('ignores a branch naming a known project it did not resolve to', () => {
    const base = withMoment(createInitialState('d1'), 'gnomon', { project: { id: 'p2', name: 'puzzlebox-studio' } });
    const state: KernelState = { ...base, project: { ...base.project, known: { '~/p/gnomon': { name: 'gnomon', org: null, remote: null, branch: null } } } };

    const { state: next, effects } = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1'));

    expect(next.commitments.open).toHaveLength(0);
    expect(effects).toEqual([]);
  });

  /** Unattributed moments are the majority, and a trunk among them is still a trunk. */
  it('ignores a branch naming a known project even when the moment resolved to no project at all', () => {
    const base = withMoment(createInitialState('d1'), 'gnomon', { project: null });
    const state: KernelState = { ...base, project: { ...base.project, known: { '~/p/gnomon': { name: 'gnomon', org: null, remote: null, branch: null } } } };

    expect(commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state.commitments.open).toHaveLength(0);
  });

  /**
   * Roughly 78% of moments resolve to no project. A ledger that only tracked
   * attributed work would miss most of what the owner actually did.
   */
  it('tracks a thread with no attributed project', () => {
    const state = withMoment(createInitialState('d1'), 'fix/wm-churn', { project: null });

    const { state: next } = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1'));

    expect(next.commitments.open).toHaveLength(1);
    expect(next.commitments.open[0]).toMatchObject({ name: 'wm-churn', projectId: null, projectName: null });
  });

  it('adopts attribution later rather than requiring it up front', () => {
    let state = withMoment(createInitialState('d1'), 'fix/wm-churn', { project: null });
    state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state;

    state = withMoment(state, 'fix/wm-churn', { project: { id: 'p9', name: 'website' } });
    state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 11), 'e2')).state;

    expect(state.commitments.open[0]).toMatchObject({ projectId: 'p9', projectName: 'website' });
  });

  /**
   * The ledger's attribution comes from the moment, not from the ambient
   * pointer. `state.project.current` moves only when a root holds a strict
   * majority of the recent detection window, and the detection stream is a
   * round-robin poll across every known root — so in the live corpus it froze,
   * and every thread in the ledger read `puzzlebox-studio` including branches
   * whose own moments resolved elsewhere.
   */
  it('attributes a thread to the closing moment, not to the frozen ambient pointer', () => {
    const base = createInitialState('d1');
    let state = withMoment(base, 'ledger-failure-views', { project: { id: '~/Projects/acme/puzzlebox-studio', name: 'puzzlebox-studio' } });
    state = {
      ...state,
      project: { ...state.project, known: { '~/Projects/sundial': { name: 'sundial', org: 'Acme', remote: null, branch: null } } },
      moment: { ...state.moment!, projectId: '~/Projects/sundial' },
    };

    const { state: next, effects } = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1'));

    expect(next.commitments.open[0]).toMatchObject({ projectId: '~/Projects/sundial', projectName: 'sundial' });
    expect(rowOf(effects)).toMatchObject({ projectName: 'sundial' });
  });

  it('lets a later resolved moment correct an attribution the ambient pointer got wrong', () => {
    let state = withMoment(createInitialState('d1'), 'ledger-failure-views', { project: { id: 'p1', name: 'puzzlebox-studio' } });
    state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state;
    expect(state.commitments.open[0]).toMatchObject({ projectName: 'puzzlebox-studio' });

    state = withMoment(state, 'ledger-failure-views', { project: { id: 'p1', name: 'puzzlebox-studio' } });
    state = {
      ...state,
      project: { ...state.project, known: { '~/Projects/sundial': { name: 'sundial', org: 'Acme', remote: null, branch: null } } },
      moment: { ...state.moment!, projectId: '~/Projects/sundial' },
    };
    state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 11), 'e2')).state;

    expect(state.commitments.open[0]).toMatchObject({ projectId: '~/Projects/sundial', projectName: 'sundial' });
  });

  it('touches the same thread rather than opening a second one', () => {
    let state = withMoment(createInitialState('d1'), 'feat/redesign-and-ios');
    state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state;

    state = withMoment(state, 'feat/redesign-and-ios');
    const { state: next, effects } = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 11), 'e2'));

    expect(next.commitments.open).toHaveLength(1);
    expect(next.commitments.open[0]).toMatchObject({ touches: 2, activeDays: ['2026-08-01'] });
    expect(rowOf(effects)).toMatchObject({ touches: 2, activeDays: 1 });
  });

  /**
   * The write cadence is the point, and it is EVERY touch. New-days-only left
   * the table a full day behind the fold: the web client's Threads row reads
   * `commitments`, so a branch touched thirty times since midnight rendered as
   * "one touch, quiet since" its first commit.
   */
  it('writes the running totals on every touch, not once a day', () => {
    let state = withMoment(createInitialState('d1'), 'feat/redesign-and-ios');
    state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state;

    state = withMoment(state, 'feat/redesign-and-ios');
    const sameDay = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 16), 'e2'));
    expect(rowOf(sameDay.effects)).toMatchObject({ touches: 2, lastTouchedAt: localTs(2026, 8, 1, 16) });

    state = withMoment(sameDay.state, 'feat/redesign-and-ios');
    const nextDay = commitmentTrack(state, windowChanged(localTs(2026, 8, 2, 9), 'e3'));

    expect(nextDay.state.commitments.open[0]?.activeDays).toEqual(['2026-08-01', '2026-08-02']);
    expect(rowOf(nextDay.effects)).toMatchObject({ activeDays: 2, touches: 3 });
  });

  it('records one active day per calendar day the branch was touched', () => {
    // The definitive separation of product from corpus. If this passes, `activeDays` is
    // correct and any shortfall in the synthetic corpus's abandonment label is the
    // generator's placement, not the producer's counting.
    let state: KernelState = createInitialState('d1');
    for (const day of [1, 2, 3]) {
      state = withMoment(state, 'feat/payment-retry', { unpushed: 4 });
      state = commitmentTrack(state, windowChanged(localTs(2026, 8, day, 10), `e${day}`)).state;
    }
    expect(state.commitments.open[0]?.activeDays).toHaveLength(3);
    expect(state.commitments.open[0]?.touches).toBe(3);
  });

  it('closes a thread that has gone quiet, and writes the closure', () => {
    let state = withMoment(createInitialState('d1'), 'feat/redesign-and-ios');
    state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state;

    const later = new Date(new Date(localTs(2026, 8, 1, 10)).getTime() + COMMITMENT_STALE_AFTER_MS + 1000).toISOString();
    const { state: next, effects } = commitmentTrack(state, tick(later, 't1'));

    expect(next.commitments.open).toHaveLength(0);
    expect(next.commitments.recentClosed).toHaveLength(1);
    expect(next.commitments.recentClosed[0]).toMatchObject({ name: 'redesign-and-ios', closedBecause: 'went-quiet' });
    expect(rowOf(effects)).toMatchObject({ closedAt: later, closedBecause: 'went-quiet' });
  });

  /**
   * Fourteen days, not seven. A week-long gap — a branch parked over a holiday
   * or behind review — is a normal shape for the exact kind of work this tier
   * exists to hold, and closing at seven would call it abandoned.
   */
  it('leaves a thread open across a week-long gap', () => {
    let state = withMoment(createInitialState('d1'), 'feat/redesign-and-ios');
    state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state;

    const { state: next, effects } = commitmentTrack(state, tick(localTs(2026, 8, 9, 10), 't1'));

    expect(next.commitments.open).toHaveLength(1);
    expect(effects).toEqual([]);
  });

  it('does nothing on a tick when nothing is open', () => {
    const { state: next, effects } = commitmentTrack(createInitialState('d1'), tick(localTs(2026, 8, 1, 10), 't1'));

    expect(next.commitments.open).toEqual([]);
    expect(effects).toEqual([]);
  });

  it('ignores a moment with no branch at all', () => {
    const { state: next, effects } = commitmentTrack(withMoment(createInitialState('d1'), null), windowChanged(localTs(2026, 8, 1, 10), 'e1'));

    expect(next.commitments.open).toEqual([]);
    expect(effects).toEqual([]);
  });

  /** A same-process title change appends to the open moment; counting it would inflate `touches` by every window retitle. */
  it('does not count a title change within the same process as a touch', () => {
    const state = withMoment(createInitialState('d1'), 'feat/redesign-and-ios');
    // The moment's own process, so this is not a closing boundary.
    const { state: next, effects } = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1', 'Terminal'));

    expect(next.commitments.open).toEqual([]);
    expect(effects).toEqual([]);
  });

  /**
   * Silence after finished work means DONE.
   *
   * These four cases are the discriminator the synthetic corpus demanded: it plants an
   * abandoned branch and a merged one with identical shapes, and every gate variant
   * announced the merged one as abandoned until `lastTouchUnpushed`/`merged` existed.
   */
  describe('a thread fading is mentioned once, before the ledger closes it', () => {
    const DAY = 24 * 60 * 60 * 1000;
    /** Touch `branch` in `touches` sessions over two days, then tick `daysLater` after the last touch. */
    function fadeAfter(daysLater: number, opts: { unpushed?: number; merged?: boolean; touches?: number; pr?: { number: number; state: string; reviewState: string | null } | null } = {}) {
      let state: KernelState = createInitialState('d1');
      const touches = opts.touches ?? 6;
      for (let i = 0; i < touches; i++) {
        state = withMoment(state, 'feat/payment-retry', opts);
        state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1 + (i % 2), 9 + i), `e${i}`)).state;
      }
      const last = state.commitments.open[0]?.lastTouchedAt ?? localTs(2026, 8, 2, 10);
      const later = new Date(new Date(last).getTime() + daysLater * DAY + 1000).toISOString();
      return commitmentTrack(state, tick(later, `t-${daysLater}`));
    }
    const kinds = (effects: Effect[]) =>
      effects.filter((e): e is Extract<Effect, { type: 'EmitEvent' }> => e.type === 'EmitEvent').map((e) => (e.event.payload as { kind: string }).kind);

    it('says nothing at two days, and speaks at three', () => {
      expect(kinds(fadeAfter(2, { unpushed: 2 }).effects)).toEqual([]);
      const { state, effects } = fadeAfter(3, { unpushed: 2 });
      expect(kinds(effects)).toEqual(['commitment-fading']);
      const notice = (effects[0] as Extract<Effect, { type: 'EmitEvent' }>).event.payload as Record<string, unknown>;
      // Tonic, not urgent: a fading thread is context for the next conversation.
      expect(notice.valueHalfLifeMs).toBeNull();
      // The thread's NAME drops the branch prefix; the branch itself is in the evidence.
      expect(String(notice.observation)).toContain('payment-retry');
      expect(notice.evidence).toContain('branch feat/payment-retry');
      expect(state.commitments.open[0].fadingNoticedAt).toBeDefined();
    });

    it('does not repeat itself on the next tick', () => {
      const first = fadeAfter(3, { unpushed: 2 });
      const again = commitmentTrack(first.state, tick(new Date(Date.parse(first.state.commitments.open[0].fadingNoticedAt!) + DAY).toISOString(), 't-again'));
      expect(kinds(again.effects)).toEqual([]);
    });

    it('stays quiet for merged work and for an afternoon; pushed work with no pull request speaks at half precision', () => {
      expect(kinds(fadeAfter(3, { merged: true, unpushed: 2 }).effects)).toEqual([]);
      expect(kinds(fadeAfter(3, { unpushed: 2, touches: 2 }).effects)).toEqual([]);
      // Pushed and no PR in sight: maybe finished, maybe not. Nothing observable settles
      // it, so it goes out hedged rather than not at all — "pushed means done" left every
      // branch on the live ledger silent for a month, since every branch was pushed.
      const pushed = fadeAfter(3, { unpushed: 0 });
      expect(kinds(pushed.effects)).toEqual(['commitment-fading']);
      const hedged = (pushed.effects[0] as Extract<Effect, { type: 'EmitEvent' }>).event.payload as Record<string, unknown>;
      expect(hedged.evidence).toContain('no pull request seen — may be finished');
      // Pushed with an OPEN pull request under review is unambiguously unfinished: full precision.
      const reviewed = fadeAfter(3, { unpushed: 0, pr: { number: 42, state: 'OPEN', reviewState: 'changes_requested' } });
      const sure = (reviewed.effects[0] as Extract<Effect, { type: 'EmitEvent' }>).event.payload as Record<string, unknown>;
      expect(sure.evidence).toContain('PR #42 open, changes requested');
      expect(Number(sure.precision)).toBeCloseTo(Number(hedged.precision) * 2, 5);
    });

    it('leaves the fourteen-day close to say its own thing', () => {
      expect(kinds(fadeAfter(15, { unpushed: 2 }).effects)).toEqual(['commitment-quiet']);
    });
  });

  describe('a thread going quiet is only worth mentioning if it was left unfinished', () => {
    /** Touch `branch` on two separate days, then let the staleness sweep run. */
    function quietAfterTwoDays(opts: { unpushed?: number; merged?: boolean; touches?: number }): Effect[] {
      let state: KernelState = createInitialState('d1');
      const touches = opts.touches ?? 3;
      for (let i = 0; i < touches; i++) {
        state = withMoment(state, 'feat/payment-retry', opts);
        state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1 + (i % 2), 10 + Math.floor(i / 2)), `e${i}`)).state;
      }

      const later = new Date(new Date(localTs(2026, 8, 2, 10)).getTime() + COMMITMENT_STALE_AFTER_MS + 1000).toISOString();
      return commitmentTrack(state, tick(later, 't1')).effects;
    }

    const noticesIn = (effects: Effect[]): Record<string, unknown>[] =>
      effects.filter((e): e is Extract<Effect, { type: 'EmitEvent' }> => e.type === 'EmitEvent').map((e) => e.event.payload as Record<string, unknown>);

    it('mentions a thread left with unpushed work', () => {
      const notices = noticesIn(quietAfterTwoDays({ unpushed: 4 }));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: 'commitment-quiet', shape: 'transition' });
      expect(String(notices[0]!.observation)).toContain('payment-retry');
    });

    it('hedges about a thread whose tree was clean and had no pull request', () => {
      const notices = noticesIn(quietAfterTwoDays({ unpushed: 0, touches: 3 }));
      expect(notices).toHaveLength(1);
      expect(notices[0]!.evidence).toContain('no pull request seen — may be finished');
    });

    it('says nothing about a thread that was merged, even with work left unpushed', () => {
      // Merged is sticky: a follow-up commit after the pull request landed does not make
      // the work unfinished again.
      expect(noticesIn(quietAfterTwoDays({ unpushed: 4, merged: true }))).toEqual([]);
    });

    it('still closes the thread and writes the row either way', () => {
      // Suppressing the NOTICE must not suppress the ledger bookkeeping.
      const effects = quietAfterTwoDays({ unpushed: 0 });
      expect(rowOf(effects)).toMatchObject({ closedBecause: 'went-quiet' });
    });

    it('says nothing about a single-session branch however dirty it was left', () => {
      let state: KernelState = createInitialState('d1');
      state = withMoment(state, 'feat/one-afternoon', { unpushed: 9 });
      state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10), 'e1')).state;
      const later = new Date(new Date(localTs(2026, 8, 1, 10)).getTime() + COMMITMENT_STALE_AFTER_MS + 1000).toISOString();
      expect(noticesIn(commitmentTrack(state, tick(later, 't1')).effects)).toEqual([]);
    });
  });

  it('keeps both lists bounded so the snapshot cannot grow without limit', () => {
    // Branch names with no `word-number` suffix, so `taskIdentity` reads them as
    // plain names rather than renaming them into tickets — this test is about
    // eviction, and a fixture that also exercises ticket parsing would fail for
    // the wrong reason.
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
                   'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango',
                   'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu', 'anchor', 'beacon', 'cinder', 'dune'];
    let state: KernelState = createInitialState('d1');
    for (const [i, name] of names.entries()) {
      state = withMoment(state, `feat/${name}`);
      state = commitmentTrack(state, windowChanged(localTs(2026, 8, 1, 10, i), `e${i}`)).state;
    }

    expect(state.commitments.open).toHaveLength(20);
    // Oldest evicted, newest kept.
    expect(state.commitments.open.at(-1)?.name).toBe('dune');
  });

  describe('J4.4 promises heard aloud', () => {
    const heard = (momentId: string, text = 'dan zal ik Marco jouw feedback zetten erin'): SanitizedEvent => ({ id: `h-${momentId}`, type: 'commitment:heard', ts: localTs(2026, 9, 22, 10), payload: { momentId, text, p: 0.9, projectId: 'p1', projectName: 'puzzles' }, sanitized: true });

    it('opens a speech thread named by the words, keyed by the moment, once', () => {
      const first = commitmentTrack(createInitialState('d1'), heard('m1'));
      expect(first.state.commitments.open[0]).toMatchObject({ id: 'commitment:speech:m1', source: 'speech', branch: '', name: 'dan zal ik Marco jouw feedback zetten erin', projectName: 'puzzles', heardIn: { momentId: 'm1', p: 0.9 } });
      expect(rowOf(first.effects)).toMatchObject({ id: 'commitment:speech:m1', source: 'speech', closedAt: null });
      const again = commitmentTrack(first.state, heard('m1'));
      expect(again.state).toBe(first.state);
      expect(again.effects).toEqual([]);
    });

    it('a later moment resolving it closes it as seen-done; the owner closes it as owner; an unknown id does nothing', () => {
      const opened = commitmentTrack(createInitialState('d1'), heard('m1')).state;
      const resolved = commitmentTrack(opened, { id: 'r1', type: 'commitment:resolved', ts: localTs(2026, 9, 23, 10), payload: { id: 'commitment:speech:m1', momentId: 'm2', p: 0.8 }, sanitized: true });
      expect(resolved.state.commitments.open).toHaveLength(0);
      expect(resolved.state.commitments.recentClosed[0]).toMatchObject({ id: 'commitment:speech:m1', closedBecause: 'seen-done' });
      expect(rowOf(resolved.effects)).toMatchObject({ id: 'commitment:speech:m1', closedBecause: 'seen-done' });
      const owner = commitmentTrack(opened, { id: 'c1', type: 'commitment:closed', ts: localTs(2026, 9, 23, 10), payload: { id: 'commitment:speech:m1', by: 'owner' }, sanitized: true });
      expect(owner.state.commitments.recentClosed[0]).toMatchObject({ closedBecause: 'owner' });
      expect(commitmentTrack(opened, { id: 'c2', type: 'commitment:closed', ts: localTs(2026, 9, 23, 10), payload: { id: 'nope' }, sanitized: true }).effects).toEqual([]);
    });
  });
});
