import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { briefPoints, workbench, pickJob, MAX_JOBS_PER_DAY, MAX_QUEUED_JOBS, JOB_TIMEOUT_MS, REPEAT_GRACE_MS } from './workbench.js';

const NOW = '2026-09-04T22:30:00.000Z';
const plus = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, ts = NOW): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });

function away(): KernelState {
  const state = createInitialState('d');
  state.config.ownerAliases = ['pat'];
  state.lifeEvent.idle.isIdle = true;
  // This week's rule idea is taken, so the other jobs are what these tests see.
  state.workbench.done[RULE_IDEA_KEY] = NOW;
  return state;
}
const RULE_IDEA_KEY = `rule-idea:${Math.floor(Date.parse(NOW) / (7 * 86_400_000))}`;

function withThread(state: KernelState): KernelState {
  state.commitments.open.push({
    id: 'commitment:box-484',
    name: 'BOX-484',
    source: 'git-branch',
    branch: 'feat/BOX-484',
    projectId: 'p1',
    projectName: 'northwind',
    openedAt: '2026-08-30T09:00:00.000Z',
    lastTouchedAt: '2026-09-01T16:00:00.000Z',
    touches: 12,
    activeDays: ['2026-08-30', '2026-09-01'],
    lastTouchUnpushed: 0,
  } as KernelState['commitments']['open'][number]);
  return state;
}

describe('pickJob', () => {
  it('does nothing while the owner is present, unless a meeting is due', () => {
    const state = withThread(away());
    state.lifeEvent.idle.isIdle = false;
    state.mind.circadian = 'day';
    expect(pickJob(state, NOW)).toBeNull();
    state.schedule.upcoming.push({ title: 'Sanity certification', start: plus(10 * 60_000), end: plus(70 * 60_000), attendees: ['pat', 'Bob', 'Noah'], isAllDay: false });
    const job = pickJob(state, NOW);
    expect(job).toMatchObject({ kind: 'meeting-brief', subject: 'Sanity certification', detail: { attendees: ['Bob', 'Noah'] } });
  });

  it('a meeting with only the owner, an all-day one, or one too far off is not a job', () => {
    const state = away();
    state.schedule.upcoming.push(
      { title: 'solo', start: plus(10 * 60_000), end: plus(20 * 60_000), attendees: ['pat'], isAllDay: false },
      { title: 'day off', start: plus(10 * 60_000), end: plus(20 * 60_000), attendees: ['Bob'], isAllDay: true },
      { title: 'later', start: plus(60 * 60_000), end: plus(90 * 60_000), attendees: ['Bob'], isAllDay: false },
    );
    expect(pickJob(state, NOW)).toBeNull();
  });

  it('while away, a quiet thread with two active days earns a handoff note before any tool brief', () => {
    const state = withThread(away());
    state.memory.recentEntityIds.push('topic:readbody', 'tool:scscreenshotmanager');
    expect(pickJob(state, NOW)).toMatchObject({ kind: 'handoff-note', subject: 'BOX-484', key: 'handoff:commitment:box-484:2026-09-01', detail: { branch: 'feat/BOX-484', project: 'northwind' } });
    state.workbench.done['handoff:commitment:box-484:2026-09-01'] = NOW;
    // Topics are code identifiers on this record; only tools are briefed.
    expect(pickJob(state, NOW)).toMatchObject({ kind: 'topic-brief', subject: 'scscreenshotmanager' });
    state.workbench.done['brief:tool:scscreenshotmanager'] = NOW;
    expect(pickJob(state, NOW)).toBeNull();
  });

  it('once a week, while away, a rule idea comes after handoffs and before tool briefs', () => {
    const state = away();
    delete state.workbench.done[RULE_IDEA_KEY];
    state.memory.recentEntityIds.push('tool:zed');
    expect(pickJob(state, NOW)).toMatchObject({ kind: 'rule-idea', key: RULE_IDEA_KEY });
    state.workbench.done[RULE_IDEA_KEY] = NOW;
    expect(pickJob(state, NOW)).toMatchObject({ kind: 'topic-brief', subject: 'zed' });
  });

  it('respects the daily cap and the gap after the last job', () => {
    const state = withThread(away());
    state.workbench.countToday = MAX_JOBS_PER_DAY;
    expect(pickJob(state, NOW)).toBeNull();
    state.workbench.countToday = 0;
    state.workbench.recent.push({ id: 'j0', kind: 'topic-brief', key: 'k', subject: 's', reason: 'r', detail: {}, openedAt: plus(-40 * 60_000), closedAt: plus(-10 * 60_000), outcome: 'nothing', title: null });
    expect(pickJob(state, NOW)).toBeNull();
  });
});

describe('workbench', () => {
  it('opens one job on a tick, hands it over on the work-job channel, and closes it when the result is shelved', () => {
    const { state: opened, effects } = workbench(withThread(away()), ev('clock:tick'));
    expect(opened.workbench.open?.kind).toBe('handoff-note');
    expect(opened.workbench.countToday).toBe(1);
    expect(effects).toEqual([{ type: 'StartSubagent', job: expect.objectContaining({ kind: 'handoff-note', subject: 'BOX-484' }) }]);

    // A second tick does not open a second job.
    expect(workbench(opened, ev('clock:tick', {}, plus(60_000))).effects).toEqual([]);

    const jobId = opened.workbench.open!.id;
    const { state: closed, effects: shelfEffects } = workbench(opened, ev('work:shelved', { jobId, title: 'BOX-484 — where it stands', body: 'Last touched the migration…', sources: ['branch feat/BOX-484'] }, plus(120_000)));
    expect(closed.workbench.open).toBeNull();
    expect(closed.workbench.recent.at(-1)).toMatchObject({ id: jobId, outcome: 'shelved', title: 'BOX-484 — where it stands' });
    expect(closed.workbench.done['handoff:commitment:box-484:2026-09-01']).toBe(plus(120_000));
    // A tonic candidate (Gnomon's own pick) and the shelf row — nothing else.
    expect(shelfEffects).toEqual([
      expect.objectContaining({ type: 'EmitEvent', event: expect.objectContaining({ type: 'notice:candidate', payload: expect.objectContaining({ kind: 'work-shelved', surprise: 1 }) }) }),
      expect.objectContaining({
        type: 'WriteDB',
        table: 'knowledge_entries',
        row: expect.objectContaining({ kind: 'shelf', title: 'BOX-484 — where it stands', dedupeKey: `shelf:${jobId}`, importanceScore: 6 }),
      }),
    ]);
    expect((shelfEffects[1] as { row: { body: string } }).row.body).toContain('Sources:\n- branch feat/BOX-484');
  });

  it('a shelved result with no matching job still lands on the shelf', () => {
    const { state, effects } = workbench(away(), ev('work:shelved', { jobId: 'stray', title: 'A note', body: 'Body.' }));
    expect(state.workbench.recent).toEqual([]);
    expect(effects).toHaveLength(1);
  });

  it('closes a job with nothing to shelve, and times out a job the worker never finished', () => {
    const { state: opened } = workbench(withThread(away()), ev('clock:tick'));
    const jobId = opened.workbench.open!.id;
    const { state: nothing } = workbench(opened, ev('work:closed', { jobId, outcome: 'nothing', note: 'no evidence' }, plus(60_000)));
    expect(nothing.workbench.open).toBeNull();
    expect(nothing.workbench.recent.at(-1)?.outcome).toBe('nothing');

    const { state: late } = workbench(opened, ev('clock:tick', {}, plus(JOB_TIMEOUT_MS + 1)));
    expect(late.workbench.open).toBeNull();
    expect(late.workbench.recent.at(-1)?.outcome).toBe('timed-out');
  });

  it('the day boundary resets the count and keeps the done keys', () => {
    const { state: opened } = workbench(withThread(away()), ev('clock:tick'));
    const { state: reset } = workbench(opened, ev('day:boundary', {}, plus(3_600_000)));
    expect(reset.workbench.countToday).toBe(0);
    expect(reset.workbench.day).toBeNull();
    expect(reset.workbench.open).not.toBeNull();
  });
});


describe('briefPoints', () => {
  it('takes the bold openers of a brief as tap-sized points, two at most', () => {
    const body = [
      "**Who's in the room** — invite says puzzlebox-team (12 people).",
      '**Last time this topic came up** — the recurring Stand-up meeting.',
      '**Open threads worth a slot** — all puzzlebox-studio.',
    ].join('\n');
    expect(briefPoints(body)).toEqual(["Who's in the room", 'Last time this topic came up']);
  });

  it('falls back to the first words of bullets, and drops what would not fit a button', () => {
    const body = ['- PDF print board differs from the game board — see #4301', '- ' + 'x'.repeat(60), '- Safe-area issue with the end screen'].join('\n');
    expect(briefPoints(body)).toEqual(['PDF print board differs from the game board', 'Safe-area issue with the end screen']);
  });
});

describe('owner-requested jobs', () => {
  it('opens at once when the slot is free — present owner, cap and gap notwithstanding — and is not counted', () => {
    const state = away();
    state.lifeEvent.idle.isIdle = false;
    state.workbench.countToday = MAX_JOBS_PER_DAY;
    const { state: opened, effects } = workbench(state, ev('work:requested', { subject: 'Zed vs Cursor', brief: 'Which is better for TS monorepos?' }));
    expect(opened.workbench.open).toMatchObject({ kind: 'owner-request', subject: 'Zed vs Cursor', detail: { brief: 'Which is better for TS monorepos?' } });
    expect(opened.workbench.countToday).toBe(MAX_JOBS_PER_DAY);
    expect(effects).toEqual([{ type: 'StartSubagent', job: expect.objectContaining({ kind: 'owner-request' }) }]);
  });

  it('a watch rule\'s job spends the day\'s job budget, and past it is dropped (U4-F19)', () => {
    const state = away();
    state.workbench.day = null;
    state.workbench.countToday = 0;
    let s = state;
    const opened: string[] = [];
    for (let i = 0; i < MAX_JOBS_PER_DAY + 1; i++) {
      s = workbench(s, ev('work:requested', { subject: `R${i}`, brief: 'b', by: 'rule', rule: 'ci-failed' }, plus(i * 1000))).state;
      opened.push(...[s.workbench.open, ...(s.workbench.queue ?? [])].filter(Boolean).map((j) => j!.subject));
    }
    expect([...new Set(opened)]).toEqual(['R0', 'R1', 'R2']);
    expect(s.workbench.open).toMatchObject({ reason: 'a rule you adopted fired' });
  });

  it('queues behind an open job and opens on its close, stamping openedAt then', () => {
    const { state: busy } = workbench(withThread(away()), ev('clock:tick'));
    const { state: queued, effects } = workbench(busy, ev('work:requested', { subject: 'A', brief: 'b' }, plus(1000)));
    expect(effects).toEqual([]);
    expect(queued.workbench.queue).toHaveLength(1);

    const { state: next, effects: closeEffects } = workbench(queued, ev('work:closed', { jobId: busy.workbench.open!.id, outcome: 'nothing' }, plus(5000)));
    expect(next.workbench.open?.subject).toBe('A');
    expect(next.workbench.open?.openedAt).toBe(plus(5000));
    expect(next.workbench.queue).toEqual([]);
    expect(closeEffects).toEqual([{ type: 'StartSubagent', job: expect.objectContaining({ subject: 'A' }) }]);
  });

  it('a shelved job tells the owner through the gate: a candidate, phasic-weighted when they asked for it', () => {
    const { state: opened } = workbench(away(), ev('work:requested', { subject: 'A', brief: 'b' }));
    const { effects } = workbench(opened, ev('work:shelved', { jobId: opened.workbench.open!.id, title: 'A, briefly', body: 'Body.' }, plus(1000)));
    const candidate = effects.find((e) => e.type === 'EmitEvent') as Extract<Effect, { type: 'EmitEvent' }>;
    expect(candidate.event.type).toBe('notice:candidate');
    expect(candidate.event.payload).toMatchObject({ kind: 'work-shelved', surprise: 2, precision: 1 });
    expect(candidate.event.payload.observation).toContain('A, briefly');
  });

  it('an owner-requested job that closes empty tells the owner; Gnomon\'s own does not', () => {
    const { state: mine } = workbench(away(), ev('work:requested', { subject: 'A', brief: 'b' }));
    const { effects } = workbench(mine, ev('work:closed', { jobId: mine.workbench.open!.id, outcome: 'failed', note: 'the worker ended without reporting' }, plus(1000)));
    const candidate = effects.find((e) => e.type === 'EmitEvent') as Extract<Effect, { type: 'EmitEvent' }>;
    expect(candidate.event.payload).toMatchObject({ kind: 'work-closed', surprise: 2 });
    expect(candidate.event.payload.observation).toContain('without reporting');

    const { state: own } = workbench(withThread(away()), ev('clock:tick'));
    expect(workbench(own, ev('work:closed', { jobId: own.workbench.open!.id, outcome: 'nothing' }, plus(1000))).effects).toEqual([]);
  });

  it('refuses a sixth queued request and an empty one', () => {
    let state = away();
    ({ state } = workbench(state, ev('work:requested', { subject: 'open', brief: 'b' })));
    for (let i = 0; i < MAX_QUEUED_JOBS; i += 1) ({ state } = workbench(state, ev('work:requested', { subject: `q${i}`, brief: 'b' })));
    expect(state.workbench.queue).toHaveLength(MAX_QUEUED_JOBS);
    expect(workbench(state, ev('work:requested', { subject: 'one too many', brief: 'b' })).state).toBe(state);
    expect(workbench(away(), ev('work:requested', { subject: '', brief: 'b' })).effects).toEqual([]);
  });
});

describe('repeating jobs', () => {
  // 2026-09-24 is a Thursday; the owner asks for a Monday-morning standup.
  const ASKED = '2026-09-24T10:00:00.000Z';
  const MONDAY_9 = '2026-09-28T07:00:00.000Z';
  const at = (iso: string, ms = 0) => new Date(Date.parse(iso) + ms).toISOString();
  function asked(): KernelState {
    const state = away();
    state.lifeEvent.idle.isIdle = false;
    state.config.timezone = 'Europe/Amsterdam';
    return workbench(state, ev('work:requested', { subject: 'Standup', brief: 'What I did last week, per project.', repeat: 'every monday at 9am' }, ASKED)).state;
  }

  it('keeps the job instead of running it, and runs it when Monday 9:00 comes', () => {
    const state = asked();
    expect(state.workbench.open).toBeNull();
    expect(state.workbench.repeats).toEqual({ standup: { subject: 'Standup', brief: 'What I did last week, per project.', schedule: 'every monday at 9am', lastRunAt: ASKED } });

    const early = workbench(state, ev('clock:tick', {}, at(MONDAY_9, -60_000)));
    expect(early.effects).toEqual([]);

    const due = workbench(state, ev('clock:tick', {}, at(MONDAY_9, 60_000)));
    expect(due.state.workbench.open).toMatchObject({ kind: 'owner-request', subject: 'Standup', reason: 'you asked for this every monday at 9am', detail: { brief: 'What I did last week, per project.' } });
    expect(due.effects).toEqual([{ type: 'StartSubagent', job: expect.objectContaining({ subject: 'Standup' }) }]);
    expect(due.state.workbench.repeats!.standup!.lastRunAt).toBe(MONDAY_9);

    // The next tick, or a replay of it, does not queue Monday again.
    const again = workbench(due.state, ev('clock:tick', {}, at(MONDAY_9, 120_000)));
    expect(again.state.workbench.queue ?? []).toEqual([]);
  });

  it('skips an occurrence missed by more than the grace window, without running it late', () => {
    const late = workbench(asked(), ev('clock:tick', {}, at(MONDAY_9, REPEAT_GRACE_MS + 60_000)));
    expect(late.state.workbench.open).toBeNull();
    expect(late.state.workbench.repeats!.standup!.lastRunAt).toBe(MONDAY_9);
  });

  it('stops on request, by subject', () => {
    const stopped = workbench(asked(), ev('work:repeat-stopped', { subject: 'standup' }, at(ASKED, 1000)));
    expect(stopped.state.workbench.repeats).toEqual({});
  });

  it('ignores a schedule it cannot read', () => {
    const state = away();
    const { state: next } = workbench(state, ev('work:requested', { subject: 'X', brief: 'y', repeat: 'every 2 hours' }));
    expect(next.workbench.repeats).toBeUndefined();
    expect(next.workbench.open).toBeNull();
  });
});

