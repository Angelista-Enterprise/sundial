import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { AgentFleetEntry, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { DEFAULT_SUNDIAL_CONFIG } from '@sundial/helpers/sundial-config.js';
import { RULE_MANIFEST } from './manifest.js';
import { reduce } from '@sundial/kernel/reduce.js';
import { nightShift, jobFolderTail, MAX_QUEUED_NIGHT_JOBS, NIGHT_SHIFT_CHANNEL, RUNNER_REPLY_MS } from './night-shift.js';

const NOW = '2026-09-29T22:30:00.000Z';
const plus = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, ts = NOW): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });
const ROOT = '~/Projects/puzzlebox-studio';
const ON = { ...DEFAULT_SUNDIAL_CONFIG.jobs, enabled: true };

function base(jobs: KernelState['config']['jobs'] | 'unset' = ON): KernelState {
  const state = createInitialState('d');
  if (jobs !== 'unset') state.config.jobs = jobs;
  state.lifeEvent.idle.isIdle = true;
  state.project.known[ROOT] = { name: 'puzzlebox-studio', org: null, remote: null, branch: 'main' };
  return state;
}
const request = (over: Record<string, unknown> = {}) => ev('job:requested', { repo: ROOT, subject: 'Fix the retry test', brief: 'Make BOX-484 pass without sleeping.', ...over });

/** Fold events through the one rule, keeping every effect. */
function fold(state: KernelState, events: SanitizedEvent[]) {
  const effects = [];
  for (const e of events) {
    const r = nightShift(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}
const notifies = (effects: { type: string }[]) => effects.filter((e) => e.type === 'Notify') as { type: 'Notify'; channel: string; payload: Record<string, unknown> }[];

function running(): { state: KernelState; id: string } {
  const { state } = fold(base(), [request(), ev('clock:tick')]);
  const id = state.nightShift!.open!.id;
  const started = nightShift(state, ev('job:started', { jobId: id, worktree: `~/.sundial${jobFolderTail(id)}`, branch: 'night/abc', base: 'a1b2c3d4e5' })).state;
  return { state: started, id };
}
const withFleet = (state: KernelState, entry: Partial<AgentFleetEntry>): KernelState => ({ ...state, agent: { ...state.agent, fleet: [{ id: 's1', cwd: state.nightShift!.open!.worktree!, branch: 'night/abc', state: 'working', since: NOW, ...entry } as AgentFleetEntry] } });

describe('nightShift (#12): the switch', () => {
  it('nothing can start a job while jobs.enabled is off: no queue, no Notify, whatever arrives', () => {
    for (const jobs of ['unset', { ...ON, enabled: false }] as const) {
      const state = base(jobs);
      state.mind.circadian = 'night';
      const events = [request(), ev('clock:tick'), ev('clock:tick', {}, plus(3_600_000)), ev('job:started', { jobId: 'x' }), ev('agent:fleet')];
      const { state: after, effects } = fold(state, events);
      expect(effects).toEqual([]);
      expect(after).toBe(state);
    }
  });

  it('the whole manifest, off by default, never emits a night-shift Notify (and on, it does)', () => {
    const run = (jobs: KernelState['config']['jobs'] | 'unset') => {
      let s = base(jobs);
      const all: { type: string; channel?: string }[] = [];
      for (const e of [request(), ev('clock:tick'), ev('clock:tick', {}, plus(60_000))]) {
        const r = reduce(s, e, RULE_MANIFEST);
        s = r.state;
        all.push(...r.effects.map((a) => a.effect as { type: string; channel?: string }));
      }
      return { s, night: all.filter((e) => e.channel === NIGHT_SHIFT_CHANNEL) };
    };
    const off = run('unset');
    expect(off.night).toEqual([]);
    expect(off.s.nightShift).toEqual(base('unset').nightShift);
    expect(run(ON).night).toHaveLength(1);
  });

  it('switched off with a job under way, the job is stopped', () => {
    const { state, id } = running();
    const off = { ...state, config: { ...state.config, jobs: { ...ON, enabled: false } } };
    const { effects } = fold(off, [ev('clock:tick', {}, plus(60_000))]);
    expect(notifies(effects)).toEqual([{ type: 'Notify', channel: NIGHT_SHIFT_CHANNEL, payload: { action: 'stop', jobId: id, reason: 'switched-off' } }]);
  });

  it('switched off and the runner never answers the stop, the slot still frees', () => {
    const { state } = running();
    const off = { ...state, config: { ...state.config, jobs: { ...ON, enabled: false } } };
    const { state: after } = fold(off, [ev('clock:tick', {}, plus(60_000)), ev('clock:tick', {}, plus(60_000 + RUNNER_REPLY_MS + 60_000))]);
    expect(after.nightShift?.open ?? null).toBeNull();
  });
});

describe('nightShift (#12): the lifecycle', () => {
  it('queues a job for a known project only, three at most', () => {
    const { state } = fold(base(), [request({ repo: '~/Projects/unknown' }), request({ subject: '' }), request(), request(), request(), request()]);
    expect(state.nightShift!.queue).toHaveLength(MAX_QUEUED_NIGHT_JOBS);
    expect(state.nightShift!.queue[0]).toMatchObject({ repo: ROOT, project: 'puzzlebox-studio', status: 'queued' });
  });

  it('starts only while the owner is away, and asks the runner with the job and the time cap', () => {
    const present = base();
    present.lifeEvent.idle.isIdle = false;
    present.mind.circadian = 'day';
    expect(notifies(fold(present, [request(), ev('clock:tick')]).effects)).toEqual([]);
    const { state, effects } = fold(base(), [request(), ev('clock:tick')]);
    const [start] = notifies(effects);
    expect(start.payload).toMatchObject({ action: 'start', job: { repo: ROOT, subject: 'Fix the retry test' }, maxMinutes: ON.maxMinutes });
    expect(state.nightShift!.open!.status).toBe('starting');
  });

  it('holds the night caps: jobs per night and dollars per night', () => {
    let { state } = fold(base({ ...ON, maxJobsPerNight: 1 }), [request(), request(), ev('clock:tick')]);
    const id = state.nightShift!.open!.id;
    state = fold(state, [ev('job:finished', { jobId: id, outcome: 'done', costUsd: 0.5 }, plus(60_000))]).state;
    expect(notifies(fold(state, [ev('clock:tick', {}, plus(120_000))]).effects)).toEqual([]);
    let spent = fold(base({ ...ON, maxUsdPerNight: 1 }), [request(), request(), ev('clock:tick')]).state;
    spent = fold(spent, [ev('job:finished', { jobId: spent.nightShift!.open!.id, outcome: 'done', costUsd: 1.2 }, plus(60_000))]).state;
    expect(notifies(fold(spent, [ev('clock:tick', {}, plus(120_000))]).effects)).toEqual([]);
    // The next night counts afresh.
    expect(notifies(fold(spent, [ev('clock:tick', {}, plus(24 * 3_600_000))]).effects)[0]?.payload.action).toBe('start');
  });

  it('waits on a permission without approving it, then collects when the turn is over', () => {
    const { state, id } = running();
    const waiting = fold(withFleet(state, { state: 'permission' }), [ev('agent:fleet')]);
    expect(waiting.effects).toEqual([]);
    expect(waiting.state.nightShift!.open!.status).toBe('waiting');
    // A turn over before any work is not the end.
    const early = fold(withFleet(state, { state: 'waiting' }), [ev('agent:fleet')]);
    expect(notifies(early.effects)).toEqual([]);
    const worked = fold(withFleet(state, { state: 'working' }), [ev('agent:fleet')]).state;
    const done = fold(withFleet(worked, { state: 'waiting' }), [ev('agent:fleet')]);
    expect(notifies(done.effects)).toEqual([{ type: 'Notify', channel: NIGHT_SHIFT_CHANNEL, payload: { action: 'finish', jobId: id, failed: false } }]);
  });

  it('stops a job over its dollar cap or its time cap', () => {
    const { state, id } = running();
    const costly = fold(withFleet(state, { state: 'working', costUsd: ON.maxUsdPerJob + 0.01 }), [ev('agent:fleet')]);
    expect(notifies(costly.effects)[0].payload).toEqual({ action: 'stop', jobId: id, reason: 'budget' });
    const late = fold(state, [ev('clock:tick', {}, plus(ON.maxMinutes * 60_000 + 60_000))]);
    expect(notifies(late.effects)[0].payload).toEqual({ action: 'stop', jobId: id, reason: 'time' });
    // Asked once: a second tick does not ask again.
    expect(notifies(fold(late.state, [ev('clock:tick', {}, plus(ON.maxMinutes * 60_000 + 120_000))]).effects)).toEqual([]);
  });

  it('puts the result on the shelf when the runner reports, and frees the slot when it never does', () => {
    const { state, id } = running();
    const finished = fold(state, [ev('job:finished', { jobId: id, outcome: 'done', commits: 3, costUsd: 0.8, note: 'Retry test passes.' }, plus(60_000))]);
    const [row] = finished.effects as { type: string; table: string; row: { kind: string; title: string; body: string; dedupeKey: string } }[];
    expect(row).toMatchObject({ type: 'WriteDB', table: 'knowledge_entries', row: { kind: 'shelf', title: 'Night shift: Fix the retry test', dedupeKey: `shelf:night:${id}` } });
    expect(row.row.body).toContain('3 commits');
    expect(row.row.body).toContain('Nothing was pushed or merged.');
    expect(finished.state.nightShift).toMatchObject({ open: null, spentUsdTonight: 0.8 });
    const lost = fold(base(), [request(), ev('clock:tick'), ev('clock:tick', {}, plus(RUNNER_REPLY_MS + 60_000))]);
    expect(lost.state.nightShift!.open).toBeNull();
    expect(lost.state.nightShift!.recent[0]).toMatchObject({ status: 'failed', note: 'the runner did not answer' });
  });

  it('the owner stops a queued or a running job', () => {
    const q = fold(base(), [request()]).state;
    const qid = q.nightShift!.queue[0].id;
    expect(fold(q, [ev('job:stop-requested', { jobId: qid })]).state.nightShift!.queue).toEqual([]);
    const { state, id } = running();
    expect(notifies(fold(state, [ev('job:stop-requested', { jobId: id })]).effects)[0].payload).toEqual({ action: 'stop', jobId: id, reason: 'owner' });
  });
});
