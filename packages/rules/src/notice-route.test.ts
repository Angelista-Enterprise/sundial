// lane D — #6 the right channel: one router, read by the gate, carried to delivery.
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, NoticeCandidate, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { callSpanTrack } from './call-span-track.js';
import { focusModeTrack } from './focus-mode-track.js';
import { inCall, noticeGate } from './notice-gate.js';
import { noticeRoute, routeFor } from './notice-route.js';
import { scheduleTrack } from './schedule-track.js';

const T0 = '2026-03-10T08:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const ev = (type: string, payload: Record<string, unknown>, ts: string, id = `${type}-${ts}`): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });
const RULES = [callSpanTrack, scheduleTrack, focusModeTrack, noticeRoute, noticeGate];

function fold(events: SanitizedEvent[], state: KernelState = createInitialState('d1')) {
  const effects: Effect[] = [];
  for (const e of events)
    for (const rule of RULES) {
      const out = rule(state, e);
      state = out.state;
      effects.push(...out.effects);
    }
  return { state, effects };
}

/** Weight 2.7 and a 30-minute half-life: urgent, and heavy enough to break into a call on cost alone (2.7 − 0.8 ≥ 1.6). */
function urgent(over: Partial<NoticeCandidate> = {}): NoticeCandidate {
  return { shape: 'omission', kind: 'agent-permission', key: 'agent-permission:s1', surprise: 3, precision: 0.9, valueHalfLifeMs: 30 * 60_000, observation: 'An agent waits on you', evidence: [], concerns: [], ...over };
}
const offer = (c: NoticeCandidate, ts: string) => ev('notice:candidate', { timestamp: ts, ...c }, ts, `c-${c.key}-${ts}`);
const mic = (on: boolean, ts: string) => ev('media:state', { audioInput: on, audioInputProcess: on ? 'zoom.us' : null, camera: false }, ts);
const notifies = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'Notify' }> => e.type === 'Notify');
const records = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'RecordGateDecision' }> => e.type === 'RecordGateDecision');

describe('noticeRoute', () => {
  it('is mac at the Mac, phone while idle or asleep, hold in a call or a meeting or a focus mode', () => {
    const route = (events: SanitizedEvent[]) => fold(events).state.route;
    expect(route([ev('input:activity', { keyDownCount: 4 }, at(0))])).toMatchObject({ channel: 'mac', reason: 'active' });
    expect(route([ev('idle:start', {}, at(0))])).toMatchObject({ channel: 'phone', reason: 'away', awaySince: at(0) });
    expect(route([ev('system:sleep-wake', { kind: 'sleep' }, at(0))])).toMatchObject({ channel: 'phone', reason: 'away' });
    // A dark wake is not a return; real input is.
    expect(route([ev('idle:start', {}, at(0)), ev('system:sleep-wake', { kind: 'wake' }, at(5)), ev('input:activity', { keyDownCount: 0 }, at(6))])).toMatchObject({ channel: 'phone' });
    expect(route([ev('idle:start', {}, at(0)), ev('input:activity', { mouseClickCount: 1 }, at(9))])).toMatchObject({ channel: 'mac', since: at(9), awaySince: null });
    expect(route([mic(true, at(0))])).toMatchObject({ channel: 'hold', reason: 'call' });
    expect(route([mic(true, at(0)), mic(false, at(30))])).toMatchObject({ channel: 'mac', since: at(30) });
    expect(route([ev('focus-mode:changed', { state: 'do-not-disturb' }, at(0))])).toMatchObject({ channel: 'hold', reason: 'focus' });
    // A calendar meeting holds until its end, and the tick after the end lets go.
    const meeting = ev('calendar:active', { event: { title: 'Planning', startDate: at(0), endDate: at(30), attendees: ['Mira Bakker'] } }, at(1));
    expect(route([meeting, ev('clock:tick', {}, at(20))])).toMatchObject({ channel: 'hold', reason: 'call' });
    expect(route([meeting, ev('clock:tick', {}, at(31))])).toMatchObject({ channel: 'mac', reason: 'active' });
    // A call away from the Mac is still a call.
    expect(route([ev('idle:start', {}, at(0)), meeting])).toMatchObject({ channel: 'hold', reason: 'call' });
    // A block with nobody else in it (focus time, lunch) is not a call.
    const solo = ev('calendar:active', { event: { title: 'Focus', startDate: at(0), endDate: at(180) } }, at(1));
    expect(route([ev('idle:start', {}, at(0)), solo])).toMatchObject({ channel: 'phone', reason: 'away' });
  });

  it('lets an owner question through a focus mode, never through a call', () => {
    const focus = { channel: 'hold', reason: 'focus', since: T0, awaySince: null } as const;
    expect(routeFor(focus, 'owner-question')).toBe('mac');
    expect(routeFor({ ...focus, awaySince: T0 }, 'owner-question')).toBe('phone');
    expect(routeFor(focus, 'agent-permission')).toBe('hold');
    expect(routeFor({ ...focus, reason: 'call' }, 'owner-question')).toBe('hold');
  });

  it('writes nothing while nothing changes', () => {
    const { state } = fold([ev('input:activity', { keyDownCount: 1 }, at(0))]);
    expect(noticeRoute(state, ev('input:activity', { keyDownCount: 2 }, at(1))).state).toBe(state);
  });

  it('first event after deploy: an owner the gate already holds as away is routed to the phone', () => {
    const old = createInitialState('d1');
    const deployed = { ...old, notices: { ...old.notices, away: { since: at(-50), held: [] } } };
    expect(fold([ev('clock:tick', {}, at(0))], deployed).state.route).toMatchObject({ channel: 'phone', awaySince: at(-50) });
  });
});

describe('noticeGate · the route', () => {
  it('names the channel on the phasic Notify: mac at the Mac, phone when away', () => {
    const here = fold([ev('input:activity', { keyDownCount: 1 }, at(0)), offer(urgent(), at(1))]);
    expect(notifies(here.effects).map((n) => n.payload.route)).toEqual(['mac']);
    const away = fold([ev('idle:start', {}, at(0)), offer(urgent(), at(1))]);
    expect(notifies(away.effects).map((n) => n.payload.route)).toEqual(['phone']);
  });

  it('holds an interruption through a call and says it once, after the call, on the next tick', () => {
    const { state, effects } = fold([mic(true, at(0)), offer(urgent(), at(5)), ev('clock:tick', {}, at(10)), mic(false, at(20)), ev('clock:tick', {}, at(21)), ev('clock:tick', {}, at(23))]);
    expect(records(effects).map((r) => [r.channel, r.reason])).toEqual([
      ['deferred', 'held-call'],
      ['phasic', 'admitted'],
    ]);
    const said = notifies(effects);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ channel: 'phasic-notice', payload: { route: 'mac', noticeKey: 'agent-permission:s1' } });
    expect(state.notices.deferred).toEqual([]);
  });

  it('lets a held interruption expire WITH a record when the call outlasts its half-life', () => {
    const { state, effects } = fold([mic(true, at(0)), offer(urgent(), at(5)), ev('clock:tick', {}, at(40)), mic(false, at(60)), ev('clock:tick', {}, at(61))]);
    expect(notifies(effects)).toEqual([]);
    expect(records(effects).map((r) => r.reason)).toEqual(['held-call', 'expired']);
    expect(state.notices.deferred).toEqual([]);
  });

  it('holds everything but an owner question in a focus mode', () => {
    const { effects } = fold([ev('focus-mode:changed', { state: 'work' }, at(0)), offer(urgent(), at(1)), offer(urgent({ kind: 'owner-question', key: 'owner-ask:a1' }), at(2))]);
    expect(records(effects).map((r) => [r.kind, r.reason])).toEqual([
      ['agent-permission', 'held-focus'],
      ['owner-question', 'admitted'],
    ]);
    expect(notifies(effects).map((n) => n.payload.noticeKey)).toEqual(['owner-ask:a1']);
  });

  it('records the oldest held notice as displaced when the ring is full, instead of dropping it', () => {
    const offers = Array.from({ length: 9 }, (_, i) => offer(urgent({ key: `agent-permission:s${i}` }), at(1 + i)));
    const { state, effects } = fold([mic(true, at(0)), ...offers]);
    expect(state.notices.deferred).toHaveLength(8);
    const displaced = records(effects).filter((r) => r.reason === 'displaced');
    expect(displaced.map((r) => r.noticeKey)).toEqual(['agent-permission:s0']);
  });
});

describe('inCall', () => {
  it("is another app on the mic, never Gnomon's own hearing", () => {
    const s = createInitialState('d1');
    const span = (app: string) => ({ app, kind: 'call' as const, since: T0, cameraEver: false });
    expect(inCall({ ...s, av: { ...s.av, call: span('Sundial') } })).toBe(false);
    expect(inCall({ ...s, av: { ...s.av, call: span('zoom.us') } })).toBe(true);
  });
});
