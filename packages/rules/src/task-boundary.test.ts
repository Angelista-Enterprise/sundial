import { describe, expect, it } from 'vitest';
import { needsNudge, taskOf } from '@sundial/helpers/task-of.js';
import { createInitialState, hydrateSnapshot } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { TASK_KEEP, TASKS_KEEP, taskBoundary } from './task-boundary.js';

const started = (id: string, ts: string, text: string): SanitizedEvent =>
  ({ id, type: 'task:started', ts, payload: { sessionId: 'chat', text } }) as unknown as SanitizedEvent;

describe('taskBoundary (run 14: nothing marked where a task began)', () => {
  it('holds the task in flight, and the next request replaces it', () => {
    const one = taskBoundary(createInitialState('d'), started('e1', '2026-11-13T12:00:00.000Z', 'open the note')).state;
    expect(one.task).toEqual({ id: 'e1', at: '2026-11-13T12:00:00.000Z', session: 'chat', said: 'open the note' });
    const two = taskBoundary(one, started('e2', '2026-11-13T12:05:00.000Z', 'play the album')).state;
    expect(two.task).toMatchObject({ id: 'e2', said: 'play the album' });
  });

  it('cuts a long request and ignores every other event', () => {
    expect(taskBoundary(createInitialState('d'), started('e3', '2026-11-13T12:00:00.000Z', 'x'.repeat(400))).state.task?.said).toHaveLength(240);
    const other = { id: 'e4', type: 'window:changed', ts: '2026-11-13T12:00:00.000Z', payload: {} } as unknown as SanitizedEvent;
    expect(taskBoundary(createInitialState('d'), other).state.task).toBeNull();
  });

  it('a correction mid-task (Set 2 R4) rides on the task in flight, keeps its id, and the next request clears it', () => {
    const corrected = (id: string, ts: string, text: unknown): SanitizedEvent => ({ id, type: 'task:corrected', ts, payload: { session: 'chat', text } }) as unknown as SanitizedEvent;
    expect(taskBoundary(createInitialState('d'), corrected('c0', '2026-11-13T12:00:01.000Z', 'no')).state.task, 'no task to correct').toBeNull();
    const one = taskBoundary(createInitialState('d'), started('e1', '2026-11-13T12:00:00.000Z', 'save it as Kestrel')).state;
    const fixed = taskBoundary(one, corrected('c1', '2026-11-13T12:00:02.000Z', 'no, I meant Juniper, not Kestrel')).state;
    expect(fixed.task).toEqual({ id: 'e1', at: '2026-11-13T12:00:00.000Z', session: 'chat', said: 'save it as Kestrel', corrected: { at: '2026-11-13T12:00:02.000Z', session: 'chat', text: 'no, I meant Juniper, not Kestrel' } });
    expect(taskBoundary(fixed, corrected('c2', '2026-11-13T12:00:03.000Z', 'y'.repeat(400))).state.task?.corrected?.text).toHaveLength(240);
    expect(taskBoundary(fixed, corrected('c3', '2026-11-13T12:00:03.000Z', 42)).state).toBe(fixed);
    expect(taskBoundary(fixed, started('e2', '2026-11-13T12:05:00.000Z', 'play the album')).state.task?.corrected).toBeUndefined();
  });
});

describe('the task object (Set 4 R1): known, did, failed, open, folded from this task\'s own chat', () => {
  const ev = (type: string, sec: number, payload: Record<string, unknown>): SanitizedEvent =>
    ({ id: `${type}-${sec}`, type, ts: new Date(Date.parse('2026-11-16T09:00:00.000Z') + sec * 1000).toISOString(), payload }) as unknown as SanitizedEvent;
  const fold = (events: SanitizedEvent[], state = createInitialState('d')) => events.reduce((s, e) => taskBoundary(s, e).state, state);
  const begun = () => fold([started('t1', '2026-11-16T09:00:00.000Z', 'append Kestrel to notes.txt')]);

  it('a refused step is failed, a step that worked is did, and another chat\'s steps are not this task\'s', () => {
    const task = fold(
      [
        ev('screen:step', 1, { session: 'chat', processName: 'TextEdit', verb: 'pick-menu', screenText: ['File > Save'], ok: false, reason: 'not-found' }),
        ev('screen:step', 2, { session: 'chat', processName: 'TextEdit', verb: 'key', screenText: ['cmd+s'], ok: true, then: { windowTitle: 'notes.txt' } }),
        ev('screen:step', 3, { session: 'other', processName: 'Notes', verb: 'press', screenText: ['New Note'], ok: false, reason: 'covered' }),
      ],
      begun(),
    ).task;
    expect(task?.failed).toEqual(['pick-menu "File > Save" in TextEdit: refused, not-found']);
    expect(task?.did).toEqual(['key "cmd+s" in TextEdit, then window "notes.txt"']);
    expect(task?.id).toBe('t1');
  });

  it('a look is known (one line per app, the newest), a refused look is failed; the chat comes from screen:asked', () => {
    let s = begun();
    s = { ...s, privateReads: { chats: {}, asked: { 'look-1': 'chat', 'look-2': 'chat', 'look-3': 'chat', 'look-9': 'other' } } };
    const task = fold(
      [
        ev('screen:looked', 1, { id: 'look-1', processName: 'Finder', windowTitle: 'Testbox', n: 12 }),
        ev('screen:looked', 2, { id: 'look-2', processName: 'Finder', windowTitle: 'Testbox-rename', n: 9 }),
        ev('screen:looked', 3, { id: 'look-3', processName: 'TextEdit', refused: 'not-responding' }),
        ev('screen:looked', 4, { id: 'look-9', processName: 'Mail', n: 40 }),
      ],
      s,
    ).task;
    expect(task?.known).toEqual(['Finder window "Testbox-rename": 9 things on screen']);
    expect(task?.failed).toEqual(['look at TextEdit: refused, not-responding']);
  });

  it('a background job is open until it exits; a non-zero exit is failed, a zero exit did', () => {
    const task = fold(
      [
        ev('shell:started', 1, { session: 'chat', jobId: 'job-a1' }),
        ev('shell:started', 2, { session: 'chat', jobId: 'job-b2' }),
        ev('shell:started', 3, { session: 'chat', failed: true }),
        ev('shell:exited', 4, { jobId: 'job-a1', exitCode: 1, lastLine: 'Permission denied' }),
        ev('shell:exited', 5, { jobId: 'job-zz', exitCode: 0, lastLine: 'not ours' }),
      ],
      begun(),
    ).task;
    expect(task?.open).toEqual(['job-b2 running: gnomon_await it']);
    expect(task?.failed).toEqual(['a shell command: refused or could not start', 'job-a1 exited 1: Permission denied']);
    expect(task?.did).toBeUndefined();
    const done = taskBoundary({ ...createInitialState('d'), task: task! }, ev('shell:exited', 6, { jobId: 'job-b2', exitCode: 0, lastLine: 'ok' })).state.task;
    expect(done?.open).toEqual([]);
    expect(done?.did).toEqual(['job-b2 finished: ok']);
  });

  it('a shell refusal names its reason, and a command run_shell waited for that exited non-zero is failed, for its own chat only', () => {
    const task = fold(
      [
        ev('shell:started', 1, { session: 'chat', failed: true, reason: 'Waiting by sleeping is refused: use gnomon_await' }),
        ev('shell:command', 2, { session: 'chat', command: 'cat /tmp/gnomon-run/notes.txt', exitCode: 1, actor: 'agent' }),
        ev('shell:command', 3, { session: 'chat', command: 'ls', exitCode: 0 }),
        ev('shell:command', 4, { command: 'pnpm test', exitCode: 1, actor: 'owner' }),
        ev('shell:command', 5, { session: 'other', command: 'false', exitCode: 1 }),
      ],
      begun(),
    ).task;
    expect(task?.failed).toEqual(['a shell command: refused, Waiting by sleeping is refused: use gnomon_await', 'shell "cat /tmp/gnomon-run/notes.txt" exited 1']);
    expect(task?.did).toBeUndefined();
  });

  it('the same long step twice is one line: cut before it is compared (Fable L1)', () => {
    const step = (sec: number) => ev('screen:step', sec, { session: 'chat', processName: `Testbox ${'Viewer '.repeat(6)}`, verb: 'press', screenText: [`${'Testbox-rename '.repeat(6)}`], ok: false, reason: `not-found ${'x'.repeat(80)}` });
    const task = fold([step(1), step(2)], begun()).task;
    expect(task?.failed).toHaveLength(1);
    expect(task?.failed?.[0]).toHaveLength(140);
  });

  it('each list keeps the newest TASK_KEEP, each line is cut, a new request starts empty, nothing before a task', () => {
    const steps = Array.from({ length: 30 }, (_, i) => ev('screen:step', i + 1, { session: 'chat', processName: 'Finder', verb: 'press', screenText: [`row ${i} ${'x'.repeat(200)}`], ok: true }));
    const task = fold(steps, begun()).task!;
    expect(task.did).toHaveLength(TASK_KEEP);
    expect(task.did?.[TASK_KEEP - 1]).toContain('row 29');
    expect(Math.max(...task.did!.map((l) => l.length))).toBeLessThanOrEqual(140);
    expect(taskBoundary({ ...createInitialState('d'), task }, started('t2', '2026-11-16T10:00:00.000Z', 'next')).state.task).toEqual({ id: 't2', at: '2026-11-16T10:00:00.000Z', session: 'chat', said: 'next' });
    const none = createInitialState('d');
    expect(taskBoundary(none, steps[0]!).state).toBe(none);
  });

  it('a private app\'s step leaves no name behind', () => {
    const task = fold([ev('screen:step', 1, { session: 'chat', processName: '[private]', verb: 'press', screenText: ['x'], ok: false, reason: 'private' })], begun()).task;
    expect(task?.failed).toBeUndefined();
  });
});

describe('Set 5 R1: one task per chat, how its turn ended, and the nudge row', () => {
  const ev = (type: string, sec: number, payload: Record<string, unknown>): SanitizedEvent =>
    ({ id: `${type}-${sec}`, type, ts: new Date(Date.parse('2026-11-16T09:00:00.000Z') + sec * 1000).toISOString(), payload }) as unknown as SanitizedEvent;
  const fold = (events: SanitizedEvent[], state = createInitialState('d')) => events.reduce((s, e) => taskBoundary(s, e).state, state);
  const start = (sec: number, sessionId: string, text: string) => ev('task:started', sec, { sessionId, text });
  const step = (sec: number, session: string, ok: boolean) => ev('screen:step', sec, { session, processName: 'Testbox', verb: 'press', screenText: [ok ? 'Save' : 'Submit'], ok, ...(ok ? {} : { reason: 'not-found' }) });

  it('two chats keep two tasks: the second request does not overwrite the first, and each chat folds only its own steps', () => {
    const s = fold([start(0, 'main', 'fill the order form'), step(1, 'main', true), start(2, 'second', 'what is 14 percent of 380'), step(3, 'main', false), step(4, 'second', true)]);
    expect(taskOf(s, 'main')).toMatchObject({ id: 'task:started-0', said: 'fill the order form', did: ['press "Save" in Testbox'], failed: ['press "Submit" in Testbox: refused, not-found'], newest: 'failed' });
    expect(taskOf(s, 'second')).toMatchObject({ id: 'task:started-2', did: ['press "Save" in Testbox'], newest: 'did' });
    expect(taskOf(s, 'second')?.failed).toBeUndefined();
    // `state.task` stays the newest request, the same object as its chat's.
    expect(s.task).toBe(s.tasks?.second);
  });

  it('a side thread (task:aside) is its own task beside its parent, and never replaces `state.task`', () => {
    const s = fold([start(0, 'main', 'rename the three files'), ev('task:aside', 1, { sessionId: 'side', parent: 'main', text: 'what time is it in Lima' }), step(2, 'side', true)]);
    expect(s.task?.session).toBe('main');
    expect(taskOf(s, 'side')).toMatchObject({ said: 'what time is it in Lima', parent: 'main', did: ['press "Save" in Testbox'] });
    expect(taskOf(s, 'main')?.did).toBeUndefined();
  });

  it('a correction lands on its own chat\'s task only', () => {
    const s = fold([start(0, 'main', 'save it as Kestrel'), start(1, 'second', 'play the album'), ev('task:corrected', 2, { session: 'main', text: 'no, Juniper' })]);
    expect(taskOf(s, 'main')?.corrected?.text).toBe('no, Juniper');
    expect(taskOf(s, 'second')?.corrected).toBeUndefined();
    expect(fold([ev('task:corrected', 3, { session: 'nobody', text: 'x' })], s)).toBe(s);
  });

  it('task:ended folds the outcome on its chat\'s task; a strange outcome or an unknown chat is ignored; the next request starts clean', () => {
    const s = fold([start(0, 'main', 'send the mail'), step(1, 'main', true), ev('task:ended', 2, { sessionId: 'main', outcome: 'partial', turn: 1 })]);
    expect(taskOf(s, 'main')?.ended).toEqual({ at: '2026-11-16T09:00:02.000Z', outcome: 'partial' });
    expect(fold([ev('task:ended', 3, { sessionId: 'main', outcome: 'maybe' })], s)).toBe(s);
    expect(fold([ev('task:ended', 3, { sessionId: 'other', outcome: 'done' })], s)).toBe(s);
    expect(taskOf(fold([start(4, 'main', 'next')], s), 'main')).toEqual({ id: 'task:started-4', at: '2026-11-16T09:00:04.000Z', session: 'main', said: 'next' });
  });

  it('task:started and task:aside keep the chat\'s newest turn number (afterTurn); a strange one is dropped', () => {
    const s = fold([ev('task:started', 0, { sessionId: 'main', text: 'x', afterTurn: 3 }), ev('task:aside', 1, { sessionId: 'side', parent: 'main', text: 'y', afterTurn: 0 }), ev('task:started', 2, { sessionId: 'b', text: 'z', afterTurn: '3' })]);
    expect(taskOf(s, 'main')?.afterTurn).toBe(3);
    expect(taskOf(s, 'side')?.afterTurn).toBe(0);
    expect(taskOf(s, 'b')).not.toHaveProperty('afterTurn');
  });

  it('Review S5R1 L2: task:ended for another task id of the chat is ignored; its own id, or none (an older row), folds', () => {
    const s = fold([start(0, 'main', 'send the mail')]);
    const id = taskOf(s, 'main')!.id;
    expect(fold([ev('task:ended', 2, { sessionId: 'main', taskId: 'task:started-old', outcome: 'stopped', turn: 1 })], s)).toBe(s);
    expect(taskOf(fold([ev('task:ended', 2, { sessionId: 'main', taskId: id, outcome: 'done', turn: 2 })], s), 'main')?.ended?.outcome).toBe('done');
    expect(taskOf(fold([ev('task:ended', 2, { sessionId: 'main', outcome: 'done', turn: 2 })], s), 'main')?.ended?.outcome).toBe('done');
  });

  it(`Review S5R1: a protective refusal keeps the task guarded after ${TASK_KEEP} newer refusals push its line out of failed`, () => {
    const kept = ev('screen:step', 1, { session: 'main', processName: 'Notes', verb: 'set-value', screenText: ['Body'], ok: false, reason: "replaced the owner's own text" });
    const misses = Array.from({ length: TASK_KEEP }, (_, i) => ev('screen:step', 2 + i, { session: 'main', processName: 'Testbox', verb: 'press', screenText: [`Archive ${i}`], ok: false, reason: 'not-found' }));
    const s = fold([start(0, 'main', 'add a line to the note'), kept, ...misses]);
    const task = taskOf(s, 'main')!;
    expect(task.failed?.some((l) => l.includes('owner'))).toBe(false);
    expect(task.guarded).toBe(true);
    const log = [{ type: 'turn/start', time: Date.parse('2026-11-16T09:00:00.500Z') }, { type: 'tool/result', time: Date.parse('2026-11-16T09:00:20.000Z'), data: { message: { isError: true } } }];
    expect(needsNudge(s, 'main', log)).toBe(false);
    // Only recoverable refusals: not guarded, the nudge may come.
    const plain = fold([start(0, 'main', 'press Archive'), ...misses]);
    expect(taskOf(plain, 'main')?.guarded).toBeUndefined();
    expect(needsNudge(plain, 'main', log)).toBe(true);
  });

  it('task:nudged marks the task', () => {
    const s = fold([start(0, 'main', 'tick gift wrap and submit'), ev('task:nudged', 5, { sessionId: 'main', turn: 1 })]);
    expect(taskOf(s, 'main')?.nudged).toBe('2026-11-16T09:00:05.000Z');
  });

  it(`keeps the newest ${TASKS_KEEP} chats by start, dropping the oldest`, () => {
    const s = fold(Array.from({ length: TASKS_KEEP + 3 }, (_, i) => start(i, `chat-${i}`, `request ${i}`)));
    expect(Object.keys(s.tasks ?? {}).sort()).toEqual(Array.from({ length: TASKS_KEEP }, (_, i) => `chat-${i + 3}`).sort());
    expect(taskOf(s, 'chat-0')).toBeNull();
  });

  it(`Review S5R1 L1: rig chats are cut apart from the owner's, so ${TASKS_KEEP + 1} rig chats never push the owner's task out`, () => {
    const rig = Array.from({ length: TASKS_KEEP + 1 }, (_, i) => `rig-${i}`);
    const state = { ...createInitialState('d'), rigSessions: Object.fromEntries(rig.map((r) => [r, '2026-11-16T08:00:00.000Z'])) };
    const s = fold([start(0, 'main', 'tidy the notes'), ...rig.map((r, i) => start(i + 1, r, `rig task ${i}`))], state);
    expect(taskOf(s, 'main')?.said).toBe('tidy the notes');
    expect(taskOf(s, 'rig-0')).toBeNull();
    expect(taskOf(s, `rig-${TASKS_KEEP}`)?.said).toBe(`rig task ${TASKS_KEEP}`);
    expect(Object.keys(s.tasks ?? {})).toHaveLength(TASKS_KEEP + 1);
  });

  it('an old snapshot (one task, no `tasks`) loads: its task reads as its chat\'s, and the first step writes the keyed shape', () => {
    const old: Record<string, unknown> = { ...createInitialState('d'), task: { id: 't-old', at: '2026-11-16T08:00:00.000Z', session: 'main', said: 'open the note', did: ['look'] } };
    delete old.tasks;
    const loaded = hydrateSnapshot('d', JSON.parse(JSON.stringify(old)) as Partial<KernelState>);
    expect(loaded.tasks).toBeUndefined();
    expect(taskOf(loaded, 'main')?.id).toBe('t-old');
    const s = fold([step(1, 'main', false)], loaded);
    expect(s.tasks?.main).toMatchObject({ id: 't-old', did: ['look'], failed: ['press "Submit" in Testbox: refused, not-found'] });
    expect(s.task).toBe(s.tasks?.main);
  });
});
