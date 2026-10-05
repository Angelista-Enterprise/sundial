import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { formatParam, param } from '@sundial/kernel/calibrated.js';
import type { DeliveredNotice, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { calibrate } from './calibrate.js';

// Made-up values only (Mira Bakker's machine, puzzlebox-studio).
const T0 = Date.parse('2026-09-20T09:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });

const item = (over: Partial<DeliveredNotice> = {}): DeliveredNotice => ({ key: 'k:1', kind: 'return-from-break', channel: 'tonic', cost: 0, evidence: [], sessionId: null, askId: null, ...over });
/** The gate's delivery on `ts`, then this rule on the same event. */
function deliver(state: KernelState, ts: string, items: DeliveredNotice[]) {
  return calibrate({ ...state, notices: { ...state.notices, lastDelivered: { at: ts, items } } }, ev('notice:candidate', ts, { key: items[0]!.key }));
}
const fold = (state: KernelState, events: SanitizedEvent[]) => events.reduce((s, e) => calibrate(s, e).state, state);
const verdict = (ts: string, artifactId: string, v: string, artifactKind = 'notice') => ev('feedback:verdict', ts, { artifactKind, artifactId, verdict: v });
const input = (ts: string) => ev('input:activity', ts, { keyDownCount: 3 });

describe('calibrate: parameters (W5 step 3)', () => {
  it('a fold of verdicts reproduces the hand-computed posterior, pooled toward its parent', () => {
    let s = createInitialState('d1');
    for (let i = 0; i < 3; i++) s = deliver(s, at(i * 60), [item({ key: `k:${i}`, kind: 'agent-waiting' })]).state;
    s = fold(s, [verdict(at(200), 'k:0', 'useful'), verdict(at(201), 'k:1', 'useful'), verdict(at(202), 'k:2', 'wrong'), verdict(at(203), 'k:2', 'useful')]);
    // The third notice's verdict was corrected: the latest counts, once.
    expect(s.calibrated.params['notice.precision:agent-waiting']).toMatchObject({ n: 3, hits: 3 });
    expect(s.calibrated.noticeByKind['agent-waiting']!['2026-09-20']).toMatchObject({ delivered: 3, labelled: 3, useful: 3, wrong: 0 });
    // Parent: (0.6 · 10 + 3) / 13; leaf: (parent · 10 + 3) / 13.
    const parent = (0.6 * 10 + 3) / 13;
    expect(param(s, 'notice.precision').value).toBeCloseTo(parent, 10);
    expect(param(s, 'notice.precision:agent-waiting').value).toBeCloseTo((parent * 10 + 3) / 13, 10);
    expect(param(s, 'gate.precision:tonic')).toMatchObject({ n: 3 });
  });

  it('below priorN a leaf reads as its parent; well measured it reads as itself', () => {
    const s = createInitialState('d1');
    s.calibrated.params['notice.precision'] = { n: 40, hits: 10, sum: 10, updatedAt: null };
    expect(param(s, 'notice.precision:never-seen').value).toBeCloseTo(param(s, 'notice.precision').value, 10);
    s.calibrated.params['notice.precision:loud'] = { n: 1000, hits: 900, sum: 900, updatedAt: null };
    expect(param(s, 'notice.precision:loud').value).toBeGreaterThan(0.89);
    // The caller's prior (a producer's own precision) replaces the parent's.
    expect(param(s, 'notice.precision:never-seen', 0.95).value).toBe(0.95);
  });

  it('formatParam says the n, and says when there is none', () => {
    const s = createInitialState('d1');
    expect(formatParam(param(s, 'routine.next'))).toBe('12% (prior, not measured yet)');
    s.calibrated.params['routine.next'] = { n: 312, hits: 84, sum: 84, updatedAt: null };
    expect(formatParam(param(s, 'routine.next'))).toBe('about 26% (measured, n = 312)');
    s.calibrated.params['routine.next'] = { n: 12, hits: 6, sum: 6, updatedAt: null };
    expect(formatParam(param(s, 'routine.next'))).toMatch(/^about \d+% \(measured, n = 12, too small to trust\)$/);
    expect(() => param(s, 'no.such.thing')).toThrow(/PARAMETERS/);
  });

  it('loop D: a forecaster prior moves with the outcomes its own calibration counts', () => {
    const s = createInitialState('d1');
    expect(param(s, 'forecast.base:project-touched').value).toBeCloseTo(0.42, 10);
    s.predictions.calibration['project-touched'] = { n: 742, hits: 193, brierSum: 0 };
    expect(param(s, 'forecast.base:project-touched').value).toBeCloseTo((0.42 * 20 + 193) / 762, 10);
  });

  it('loop I: a routine forecast is scored at the next step the trail takes', () => {
    let s = createInitialState('d1');
    s.routines.learned = { r: { steps: ['Mail/work', 'Warp/work'], support: 9, firstSeenAt: at(0), lastSeenAt: at(0) } };
    s.routines.trail = ['Mail/work'];
    s = calibrate(s, ev('window:changed', at(1), { processName: 'Mail' })).state;
    expect(s.calibrated.routine).toMatchObject({ from: 'Mail/work', expected: 'Warp/work' });
    s.routines.trail = ['Mail/work', 'Warp/work'];
    s = calibrate(s, ev('window:changed', at(2), { processName: 'Warp' })).state;
    expect(s.calibrated.params['routine.next']).toMatchObject({ n: 1, hits: 1 });
    // A title change inside one step scores nothing.
    expect(calibrate(s, ev('window:changed', at(3), { processName: 'Warp' })).state.calibrated.params['routine.next']).toMatchObject({ n: 1 });
  });

  it('row 11: actions verified and performed, per tool', () => {
    const s = fold(createInitialState('d1'), [
      ev('action:verified', at(1), { tool: 'calendar_create', failed: false, outward: true }),
      ev('action:verified', at(2), { tool: 'calendar_create', failed: true, outward: true }),
      // R11: a verdict from before the outward-only rule (a read, a no-op, a refusal) is not counted.
      ev('action:verified', at(2), { tool: 'calendar_create', failed: true }),
      ev('action:performed', at(3), { tool: 'run_shell', outcome: 'ok' }),
      ev('action:performed', at(4), { tool: 'run_shell', refused: 'not allowed' }),
      ev('action:performed', at(5), { tool: 'reminder_create', reminderId: 'r1' }),
    ]);
    expect(s.calibrated.params['action.outward:calendar_create']).toMatchObject({ n: 2, hits: 1 });
    expect(s.calibrated.params['action.performed:run_shell']).toMatchObject({ n: 2, hits: 1 });
    expect(s.calibrated.params['action.performed:reminder_create']).toMatchObject({ n: 1, hits: 1 });
  });

  it('the interruption cost evidence: a question answered within 10 min, by the cost it landed at', () => {
    let s = deliver(createInitialState('d1'), at(0), [item({ key: 'owner-ask:a1', kind: 'owner-question', channel: 'phasic', cost: 0.9, askId: 'a1' })]).state;
    s = deliver(s, at(30), [item({ key: 'owner-ask:a2', kind: 'owner-question', channel: 'phasic', cost: 0.1, askId: 'a2' })]).state;
    s = fold(s, [ev('ask:owner-answered', at(4), { askId: 'a1' }), ev('ask:owner-answered', at(90), { askId: 'a2' })]);
    expect(s.calibrated.params['gate.answered:high']).toMatchObject({ n: 1, hits: 1 });
    expect(s.calibrated.params['gate.answered:low']).toMatchObject({ n: 1, hits: 0 });
    // Answering is the question's own action, whenever it comes within the day.
    expect(s.calibrated.params['notice.acted:owner-question']).toMatchObject({ n: 2, hits: 2 });
  });

  it('the minutes back to the app a phasic notice pulled the owner from', () => {
    let s = calibrate(createInitialState('d1'), ev('window:changed', at(0), { processName: 'Xcode' })).state;
    s = deliver(s, at(1), [item({ channel: 'phasic', kind: 'agent-waiting' })]).state;
    s = fold(s, [ev('window:changed', at(2), { processName: 'Slack' }), ev('window:changed', at(5), { processName: 'Xcode' })]);
    expect(s.calibrated.params['gate.returnLag']).toMatchObject({ n: 1, sum: 3 });
  });
});

describe('calibrate: implicit labels (W5 step 5)', () => {
  it('"seen" is the owner at the Mac within 5 minutes — once, as a seen-rate, never as precision', () => {
    let s = deliver(createInitialState('d1'), at(0), [item()]).state;
    const seen = calibrate(s, input(at(3)));
    expect(seen.effects).toEqual([expect.objectContaining({ type: 'EmitEvent', event: expect.objectContaining({ type: 'feedback:implicit', payload: { noticeKey: 'k:1', kind: 'return-from-break', signal: 'seen', lagMs: 180_000 } }) })]);
    s = calibrate(seen.state, input(at(4))).state;
    expect(s.calibrated.params['notice.seen:return-from-break']).toMatchObject({ n: 1, hits: 1 });
    expect(s.calibrated.params['notice.precision:return-from-break']).toBeUndefined();
    expect(s.calibrated.noticeByKind['return-from-break']!['2026-09-20']).toMatchObject({ delivered: 1, seen: 1, labelled: 1 });
    // After 5 minutes, input is not "seen".
    const late = calibrate(deliver(createInitialState('d1'), at(0), [item()]).state, input(at(6)));
    expect(late.effects).toEqual([]);
    expect(late.state.calibrated.params['notice.seen:return-from-break']).toMatchObject({ n: 1, hits: 0 });
  });

  it('W6 P18: a line the client saw in view (notice:seen) is seen, for that notice only', () => {
    const s = deliver(createInitialState('d1'), at(0), [item(), item({ key: 'k:2' })]).state;
    const seen = calibrate(s, ev('notice:seen', at(2), { noticeKey: 'k:2', surface: 'page' }));
    expect(seen.state.calibrated.watch.map((w) => [w.key, w.seen === true])).toEqual([['k:1', false], ['k:2', true]]);
  });

  it('agent-waiting: a prompt in that session within 10 minutes', () => {
    const waiting = item({ key: 'agent-waiting:~/Projects/puzzlebox-studio:2026-09-20', kind: 'agent-waiting', evidence: ['session s-42 in ~/Projects/puzzlebox-studio'] });
    const s = deliver(createInitialState('d1'), at(0), [waiting]).state;
    const other = calibrate(s, ev('agent:hook', at(2), { session: 's-7', event: 'UserPromptSubmit' }));
    expect(other.state.calibrated.params['notice.acted:agent-waiting']).toMatchObject({ n: 1, hits: 0 });
    expect(calibrate(s, ev('agent:hook', at(9), { session: 's-42', event: 'UserPromptSubmit' })).state.calibrated.params['notice.acted:agent-waiting']).toMatchObject({ hits: 1 });
    expect(calibrate(s, ev('agent:hook', at(11), { session: 's-42', event: 'UserPromptSubmit' })).state.calibrated.params['notice.acted:agent-waiting']).toMatchObject({ hits: 0 });
  });

  it('return-from-break: a piece the line named opened within 30 minutes', () => {
    const s = deliver(createInitialState('d1'), at(0), [item()]).state;
    expect(calibrate(s, ev('resume:opened', at(29), { piece: 'branch' })).state.calibrated.params['notice.acted:return-from-break']).toMatchObject({ hits: 1 });
    expect(calibrate(s, ev('resume:opened', at(31), { piece: 'branch' })).state.calibrated.params['notice.acted:return-from-break']).toMatchObject({ hits: 0 });
  });

  it('commitment-quiet: a commit on that branch within 24 hours', () => {
    const quiet = item({ key: 'commitment-quiet:commitment:box-484', kind: 'commitment-quiet', evidence: ['branch feature/box-484', '2 active days'] });
    const s = deliver(createInitialState('d1'), at(0), [quiet]).state;
    expect(calibrate(s, ev('git:commit', at(60), { branch: 'main' })).state.calibrated.params['notice.acted:commitment-quiet']).toMatchObject({ hits: 0 });
    expect(calibrate(s, ev('git:commit', at(23 * 60), { branch: 'feature/box-484' })).state.calibrated.params['notice.acted:commitment-quiet']).toMatchObject({ hits: 1 });
  });

  it('followup:*: the owner\'s next turn in that thread', () => {
    const line = item({ key: 'followup:unpushed:puzzlebox-studio', kind: 'followup:unpushed', sessionId: 'S1' });
    const s = deliver(createInitialState('d1'), at(0), [line]).state;
    expect(calibrate(s, ev('chat:owner', at(40), { sessionId: 'S2', turnId: 't' })).state.calibrated.params['notice.acted:followup:unpushed']).toMatchObject({ hits: 0 });
    expect(calibrate(s, ev('chat:owner', at(40), { sessionId: 'S1', turnId: 't' })).state.calibrated.params['notice.acted:followup:unpushed']).toMatchObject({ hits: 1 });
  });

  it('a notice with no behaviour after it stays unlabelled', () => {
    let s = deliver(createInitialState('d1'), at(0), [item({ kind: 'day-end-drift' })]).state;
    s = fold(s, [ev('window:changed', at(20), { processName: 'Mail' }), ev('clock:tick', at(30)), input(at(40))]);
    expect(s.calibrated.noticeByKind['day-end-drift']!['2026-09-20']).toMatchObject({ delivered: 1, labelled: 0, seen: 0, acted: 0 });
  });

  it('the presence baseline: fixed times scored the same way', () => {
    const s = fold(createInitialState('d1'), [ev('clock:tick', at(0)), input(at(2)), ev('clock:tick', at(15)), input(at(25))]);
    expect(s.calibrated.params['presence.baseline']).toMatchObject({ n: 2, hits: 1 });
  });
});
