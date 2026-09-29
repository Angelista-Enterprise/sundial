import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { addDays, EMPTY_DRIFT, EMPTY_DRIFT_DAY, heldTrends, weeklyDrift, type DriftDay } from '@sundial/kernel/drift.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { driftTrack, foldDriftRows } from './drift-track.js';

let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });
const input = (ts: string, keys = 5) => ev('input:activity', ts, { keyDownCount: keys, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0 });
const fold = (state: KernelState, events: SanitizedEvent[]) => events.reduce((s, e) => driftTrack(s, e).state, state);

describe('driftTrack: the waking day', () => {
  it('keeps first and last real input, and work past midnight on the day it belongs to', () => {
    const s = fold(createInitialState('t'), [input('2026-03-02T08:30:00.000Z'), input('2026-03-02T17:00:00.000Z'), input('2026-03-03T00:30:00.000Z'), input('2026-03-03T01:00:00.000Z', 0)]);
    const day = s.drift!.days['2026-03-02']!;
    expect(day.first).toBe(270); // 08:30 is 4.5 h after 04:00
    expect(day.last).toBe(1230); // 00:30 the next morning
    expect(day.active).toBe(3);
    expect(Object.keys(s.drift!.days)).toEqual(['2026-03-02']);
  });

  it('marks a day the machine ran as present even without input', () => {
    const s = fold(createInitialState('t'), [input('2026-03-04T10:00:00.000Z', 0)]);
    expect(s.drift!.days['2026-03-04']).toEqual(EMPTY_DRIFT_DAY);
  });

  it('counts a meeting once however often it polls, and never an all-day event', () => {
    const meeting = { event: { eventId: 'evt-1', startDate: '2026-03-02T09:00:00.000Z', endDate: '2026-03-02T09:30:00.000Z', isAllDay: false } };
    const allDay = { event: { eventId: 'evt-2', startDate: '2026-03-02T00:00:00.000Z', endDate: '2026-03-03T00:00:00.000Z', isAllDay: true } };
    const s = fold(createInitialState('t'), [ev('calendar:active', '2026-03-02T09:01:00.000Z', meeting), ev('calendar:active', '2026-03-02T09:11:00.000Z', meeting), ev('calendar:active', '2026-03-02T09:01:00.000Z', allDay)]);
    expect(s.drift!.days['2026-03-02']!.meetingMin).toBe(30);
  });

  it('counts each occurrence of a recurring series, which shares one eventId', () => {
    const on = (day: string) => ev('calendar:active', `${day}T09:01:00.000Z`, { event: { eventId: 'series-1', startDate: `${day}T09:00:00.000Z`, endDate: `${day}T09:15:00.000Z`, isAllDay: false } });
    const s = fold(createInitialState('t'), [on('2026-03-02'), on('2026-03-04')]);
    expect([s.drift!.days['2026-03-02']!.meetingMin, s.drift!.days['2026-03-04']!.meetingMin]).toEqual([15, 15]);
  });

  it('counts a commit after 22:00 as late, and a back-filled one never', () => {
    const s = fold(createInitialState('t'), [ev('git:commit', '2026-03-02T21:00:00.000Z'), ev('git:commit', '2026-03-02T23:10:00.000Z'), ev('git:commit', '2026-03-03T01:10:00.000Z'), ev('git:commit', '2026-03-02T23:30:00.000Z', { backfill: true })]);
    expect(s.drift!.days['2026-03-02']!.late).toBe(2);
  });

  it('keeps at most thirteen weeks of days', () => {
    const events = Array.from({ length: 100 }, (_, i) => input(`${addDays('2026-01-01', i)}T10:00:00.000Z`));
    expect(Object.keys(fold(createInitialState('t'), events).drift!.days)).toHaveLength(91);
  });
});

/** Seven weeks of days ending the day before `from + 49`: four ordinary weeks, then three with the day ending `lateBy` minutes later. */
function weeksOfDays(from: string, lateBy: number): Record<string, DriftDay> {
  const days: Record<string, DriftDay> = {};
  for (let i = 0; i < 49; i++) {
    const day = addDays(from, i);
    days[day] = { ...EMPTY_DRIFT_DAY, first: 300, last: 840 + (i >= 28 ? lateBy : 0), active: 2000, switches: 40 };
  }
  return days;
}

describe('driftTrack: the weekly check', () => {
  const monday = '2026-03-02'; // a Monday
  const tick = (day: string) => ev('clock:tick', `${day}T10:00:00.000Z`);
  const withDays = (days: Record<string, DriftDay>, checkedWeek: string | null): KernelState => ({ ...createInitialState('t'), drift: { ...EMPTY_DRIFT, days, checkedWeek } });

  it('finds a day end that held 60 minutes later for three weeks, and nothing else', () => {
    const weeks = weeklyDrift(weeksOfDays(monday, 60));
    const trends = heldTrends(weeks, addDays(monday, 49));
    expect(trends.map((t) => [t.metric, t.direction])).toEqual([['dayEnd', 'up']]);
    expect(trends[0]!.baselineWeeks).toBe(4);
  });

  it('says it once, when it starts to hold, through a notice candidate', () => {
    const state = withDays(weeksOfDays(monday, 60), addDays(monday, 42));
    const out = driftTrack(state, tick(addDays(monday, 49)));
    expect(out.effects).toHaveLength(1);
    const payload = (out.effects[0] as { event: { type: string; payload: Record<string, unknown> } }).event;
    expect(payload.type).toBe('notice:candidate');
    expect(payload.payload).toMatchObject({ kind: 'weekly-drift', key: 'weekly-drift:dayEnd:up', shape: 'drift', valueHalfLifeMs: null });
    expect(String(payload.payload.observation)).toContain('for 3 weeks in a row');
    expect(payload.payload.evidence).toContain('n = 5 + 5 + 5 days');
    // The same week again, and the next week while it still holds: nothing new.
    expect(driftTrack(out.state, tick(addDays(monday, 50))).effects).toEqual([]);
    expect(out.state.drift!.holding).toEqual({ dayEnd: 'up' });
  });

  it('stays quiet when the change is under the threshold, and on the first check ever', () => {
    expect(driftTrack(withDays(weeksOfDays(monday, 20), addDays(monday, 42)), tick(addDays(monday, 49))).effects).toEqual([]);
    const first = driftTrack(withDays(weeksOfDays(monday, 60), null), tick(addDays(monday, 49)));
    expect(first.effects).toEqual([]);
    expect(first.state.drift!.holding).toEqual({ dayEnd: 'up' });
  });

  it('needs three weeks of baseline', () => {
    const days = Object.fromEntries(Object.entries(weeksOfDays(monday, 60)).filter(([day]) => day >= addDays(monday, 14)));
    expect(driftTrack(withDays(days, addDays(monday, 42)), tick(addDays(monday, 49))).effects).toEqual([]);
  });

  it('rebuilds from rows without running the weekly check', () => {
    const s = foldDriftRows(createInitialState('t'), [input('2026-03-02T08:30:00.000Z'), tick('2026-03-09')]);
    expect(s.drift!.checkedWeek).toBeNull();
    expect(s.drift!.days['2026-03-02']!.active).toBe(1);
  });
});
