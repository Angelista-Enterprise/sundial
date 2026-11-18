import { describe, expect, it } from 'vitest';
import { allTasks, lastTurn, needsNudge, outcomeOf, taskOf, taskOfTurn, type TaskHost, type TaskLike } from './task-of.js';

const AT = '2026-11-16T09:00:00.000Z';
const task = (more: Partial<TaskLike> = {}): TaskLike => ({ id: 't1', at: AT, session: 'main', said: 'tick gift wrap and submit', ...more });
const host = (t: TaskLike, more: Partial<TaskHost> = {}): TaskHost => ({ task: t, tasks: { [t.session]: t }, ...more });
const refusedLast = { did: ['press "Gift wrap" in Testbox'], failed: ['press "Submit" in Testbox: refused, not-found'], newest: 'failed' as const };
/** The chat's own log in the task's first turn: it began after the task, and its newest tool result is an error. */
const ms = (s: number) => Date.parse(AT) + s * 1000;
const refusedResult = { type: 'tool/result', time: ms(3), data: { message: { isError: true } } };
const OWN = [{ type: 'turn/start', time: ms(1) }, { type: 'tool/result', time: ms(2), data: { message: { isError: false } } }, refusedResult];

describe('taskOf: one chat\'s task, never another\'s', () => {
  it('reads the keyed shape, and an old snapshot\'s single task as its own chat\'s', () => {
    const t = task();
    expect(taskOf(host(t), 'main')).toBe(t);
    expect(taskOf({ task: t }, 'main')).toBe(t);
    expect(taskOf({ task: t }, 'other')).toBeNull();
    expect(taskOf(host(t), '')).toBeNull();
    expect(taskOf(null, 'main')).toBeNull();
    expect(Object.keys(allTasks({ task: t, tasks: { side: task({ session: 'side' }) } })).sort()).toEqual(['main', 'side']);
  });
});

describe('needsNudge (plan 21, 2C): a refusal after the last thing done, no final, no ask, once per task', () => {
  it('nudges a task whose newest step was refused', () => {
    expect(needsNudge(host(task(refusedLast)), 'main', OWN)).toBe(true);
  });

  it('never twice in a task, never another chat, never when the newest step worked or nothing failed', () => {
    expect(needsNudge(host(task({ ...refusedLast, nudged: '2026-11-16T09:01:00.000Z' })), 'main', OWN)).toBe(false);
    expect(needsNudge(host(task(refusedLast)), 'other', OWN)).toBe(false);
    expect(needsNudge(host(task({ ...refusedLast, newest: 'did' })), 'main', OWN)).toBe(false);
    expect(needsNudge(host(task()), 'main', OWN)).toBe(false);
  });

  it('never when the owner stopped it: their hands on the keys, their words mid-turn', () => {
    expect(needsNudge(host(task({ ...refusedLast, failed: ['press "Submit" in Testbox: refused, owner-hand'] })), 'main', OWN)).toBe(false);
    expect(needsNudge(host(task({ ...refusedLast, failed: ['press "Submit" in Testbox: refused, corrected'] })), 'main', OWN)).toBe(false);
    expect(needsNudge(host(task({ ...refusedLast, corrected: { at: AT, session: 'main', text: 'leave it' } })), 'main', OWN)).toBe(false);
  });

  it('never after a final was answered in this task, or while an ask waits in this chat', () => {
    const t = task(refusedLast);
    const answered = { sessionId: 'main', kind: 'send', at: '2026-11-16T09:00:30.000Z', answeredAt: '2026-11-16T09:00:40.000Z' };
    expect(needsNudge(host(t, { approvals: { open: [], recent: [answered] } }), 'main', OWN)).toBe(false);
    expect(needsNudge(host(t, { approvals: { open: [{ sessionId: 'main', kind: 'plain', at: AT }], recent: [] } }), 'main', OWN)).toBe(false);
    // A final from an earlier task, a plain act, or another chat's ask: still nudged.
    expect(needsNudge(host(t, { approvals: { open: [{ sessionId: 'other', kind: 'send', at: AT }], recent: [{ ...answered, answeredAt: '2026-11-16T08:00:00.000Z' }, { ...answered, kind: 'plain' }] } }), 'main', OWN)).toBe(true);
  });
});

describe('Review S5R1 H1: the nudge belongs to the task\'s own turn', () => {
  it('never once the task has ended (a Stop folds `stopped`), never in a later turn of the chat, never with no log', () => {
    const t = task(refusedLast);
    expect(needsNudge(host({ ...t, ended: { at: AT, outcome: 'stopped' } }), 'main', OWN)).toBe(false);
    // A notice turn an hour later: the task's own turn ended before it began.
    const later = [{ type: 'turn/start', time: ms(1) }, refusedResult, { type: 'turn/end', time: ms(4) }, { type: 'turn/start', time: ms(3600) }, { ...refusedResult, time: ms(3601) }];
    expect(needsNudge(host(t), 'main', later)).toBe(false);
    expect(needsNudge(host(t), 'main', undefined)).toBe(false);
    expect(needsNudge(host(t), 'main', [])).toBe(false);
    // An earlier task's turn ended before this task began: this turn is still the task's own.
    expect(needsNudge(host(t), 'main', [{ type: 'turn/end', time: ms(-60) }, ...OWN])).toBe(true);
  });
});

describe('Review S5R1 H2: never past a refusal that protects the owner', () => {
  const failing = (...failed: string[]) => host(task({ ...refusedLast, failed }));
  it('nudges only after a refusal the model can recover from', () => {
    for (const reason of ['not-found', 'look again', 'covered', 'no-such-window', 'not-responding', 'app-changed']) expect(needsNudge(failing(`press "Submit" in Testbox: refused, ${reason}`), 'main', OWN)).toBe(true);
    expect(needsNudge(failing('shell "make" exited 2'), 'main', OWN)).toBe(true);
  });

  it('never after the owner\'s text, a private app, a no-access, a cut, a stop or an unknown reason', () => {
    for (const line of [
      'set-value "Body" in Notes: refused, replaced the owner\'s own text',
      'set-value "Body" in Notes: refused, would-replace',
      'look at a private app: refused',
      'press "x" in Testbox: refused, protected-app',
      'press "x" in Testbox: refused, no-access',
      'press "x" in Testbox: refused, stopped',
      'press "x" in Testbox: refused, owner-moved',
      'press "x" in Testbox: refused, unknown',
      'a shell command: refused, wipes a folder',
    ]) expect(needsNudge(failing(line), 'main', OWN)).toBe(false);
  });

  it('never when any failed line of the task is the owner\'s, not only the last', () => {
    expect(needsNudge(failing('press "Submit" in Testbox: refused, owner-hand', 'press "Submit" in Testbox: refused, not-found'), 'main', OWN)).toBe(false);
    expect(needsNudge(failing('set-value "Body" in Notes: refused, would-replace', 'press "Submit" in Testbox: refused, not-found'), 'main', OWN)).toBe(false);
  });

  it('never when an ask of this chat since the task began was answered no, a plain act or an egress included', () => {
    const no = { sessionId: 'main', kind: 'plain', at: '2026-11-16T09:00:30.000Z', answeredAt: '2026-11-16T09:00:40.000Z', answer: 'rejected' };
    expect(needsNudge(host(task(refusedLast), { approvals: { open: [], recent: [no] } }), 'main', OWN)).toBe(false);
    // A yes to a plain act, a no in another chat or before the task: still nudged.
    expect(needsNudge(host(task(refusedLast), { approvals: { open: [], recent: [{ ...no, answer: 'approved' }, { ...no, sessionId: 'other' }, { ...no, answeredAt: '2026-11-16T08:00:00.000Z' }] } }), 'main', OWN)).toBe(true);
  });
});

describe('Review S5R1 M1: the turn\'s own last tool result decides', () => {
  it('no nudge after a clean finish by another tool (a shell exit 0, a fetch); the outcome is not failed', () => {
    const t = task(refusedLast);
    const clean = [...OWN, { type: 'tool/call', time: ms(4) }, { type: 'tool/result', time: ms(5), data: { message: { isError: false } } }];
    expect(needsNudge(host(t), 'main', clean)).toBe(false);
    expect(outcomeOf(host(task({ failed: ['y: refused, not-found'], newest: 'failed' })), 'main', { kind: 'completed' }, clean)).toBe('done');
    expect(outcomeOf(host(t), 'main', { kind: 'completed' }, clean)).toBe('done');
    // A turn with no tool result at all (an answer in words) is not nudged either.
    expect(needsNudge(host(t), 'main', [{ type: 'turn/start', time: ms(1) }])).toBe(false);
  });
});

describe('outcomeOf: task:ended\'s outcome', () => {
  it('a Stop or another abort is stopped; an error or a blocked turn failed', () => {
    expect(outcomeOf(host(task()), 'main', { kind: 'aborted' })).toBe('stopped');
    expect(outcomeOf(host(task()), 'main', { kind: 'error' })).toBe('failed');
    expect(outcomeOf(host(task()), 'main', { kind: 'blocked' })).toBe('failed');
  });

  it('a completed turn: done; with a refusal after the last thing done, partial (or failed when nothing was done); a job still open, partial', () => {
    expect(outcomeOf(host(task({ did: ['x'], newest: 'did' })), 'main', { kind: 'completed' })).toBe('done');
    expect(outcomeOf(host(task(refusedLast)), 'main', { kind: 'completed' })).toBe('partial');
    expect(outcomeOf(host(task({ failed: ['y: refused, not-found'], newest: 'failed' })), 'main', { kind: 'completed' })).toBe('failed');
    expect(outcomeOf(host(task({ open: ['job-a1 running: gnomon_await it'] })), 'main', { kind: 'completed' })).toBe('partial');
    expect(outcomeOf(host(task({ ...refusedLast, failed: ['press "Submit" in Testbox: refused, owner-hand'] })), 'main', { kind: 'completed' })).toBe('stopped');
  });
});

describe('the task\'s turns, by number: dsh logs turn/start a few ms before the kernel stamps task:started', () => {
  const early = { type: 'turn/start', time: Date.parse(AT) - 3, data: { turn: 4 } };
  it('lastTurn reads the chat\'s newest turn/start; 0 for none, undefined with no log', () => {
    expect(lastTurn([{ type: 'turn/start', data: { turn: 2 } }, { type: 'turn/end', data: { turn: 2 } }, { type: 'turn/start', data: { turn: 3 } }])).toBe(3);
    expect(lastTurn([])).toBe(0);
    expect(lastTurn(undefined)).toBeUndefined();
  });

  it('taskOfTurn: a turn above afterTurn is the task\'s however early it began; a turn at or below it is not', () => {
    const t = task({ afterTurn: 3 });
    expect(taskOfTurn(host(t), 'main', [early], 4)).toBe(t);
    expect(taskOfTurn(host(t), 'main', [early], 3)).toBeNull();
    // A task from before afterTurn: by clock, with slack. A few ms early is its own; a stale turn minutes before is not.
    expect(taskOfTurn(host(task()), 'main', [early], 4)).not.toBeNull();
    expect(taskOfTurn(host(task()), 'main', [{ ...early, time: ms(-600) }], 4)).toBeNull();
  });

  it('ownTurn: the stale turn\'s end after the task began does not count; the task\'s own turn end does', () => {
    const t = task({ ...refusedLast, afterTurn: 3 });
    const log = [{ type: 'turn/start', time: ms(-600), data: { turn: 3 } }, { type: 'turn/end', time: ms(1), data: { turn: 3 } }, early, { ...refusedResult, data: { message: { isError: true } } }];
    expect(needsNudge(host(t), 'main', log)).toBe(true);
    expect(needsNudge(host(t), 'main', [...log, { type: 'turn/end', time: ms(5), data: { turn: 4 } }, { type: 'turn/start', time: ms(60), data: { turn: 5 } }, refusedResult])).toBe(false);
    expect(needsNudge(host(t), 'main', [{ type: 'turn/start', time: ms(-600), data: { turn: 3 } }, refusedResult])).toBe(false);
  });
});
