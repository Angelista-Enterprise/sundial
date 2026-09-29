import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { EMPTY_DRIFT, EMPTY_DRIFT_DAY } from '@sundial/kernel/drift.js';
import { factRecordLine, leadingClock, testableFacts } from '@sundial/kernel/fact-tests.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { factTestTrack } from './fact-test-track.js';

let seq = 0;
const tick = (ts: string): SanitizedEvent => ({ id: `t${++seq}`, type: 'clock:tick', ts, payload: {}, sanitized: true });
const seen = (ts: string, entityId: string, predicate: string, object: string): SanitizedEvent => ({
  id: `c${++seq}`,
  type: 'entity:fact-candidate',
  ts,
  payload: { entityId, entityKind: 'project', canonicalName: 'x', predicate, object, confidence: 70, sourceEventId: 's', provenance: 'inference' },
  sanitized: true,
});
const entry = (object: string, factId: string) => ({ object, factId, confidence: 90, pendingObject: null, pendingCount: 0, projectId: null });

function base(): KernelState {
  const s = createInitialState('t');
  return {
    ...s,
    memory: {
      ...s.memory,
      factCursor: {
        'project:puzzlebox-studio:usesTool:Code': entry('Code', 'f-code'),
        'project:puzzlebox-studio:usesTool:Slack': entry('Slack', 'f-slack'),
        'owner:mira-bakker:dayBeginsAt': entry('~08:00 (opens the laptop at 8)', 'f-begin'),
        'owner:mira-bakker:asleepBy': entry('no fixed bedtime, earlier said ~22:00', 'f-sleep'),
      },
    },
  };
}
const run = (state: KernelState, events: SanitizedEvent[]) => {
  const effects: unknown[] = [];
  for (const e of events) {
    const out = factTestTrack(state, e);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
};

describe('which facts are testable', () => {
  it('reads confirmed usesTool and the owner clock facts off the cursor, and only a LEADING clock', () => {
    expect(testableFacts(base().memory.factCursor).map((f) => [f.factId, f.entityId, f.predicate])).toEqual([
      ['f-code', 'project:puzzlebox-studio', 'usesTool'],
      ['f-slack', 'project:puzzlebox-studio', 'usesTool'],
      ['f-begin', 'owner:mira-bakker', 'dayBeginsAt'],
    ]);
    expect(leadingClock('~08:00 (opens the laptop at 8)')).toBe(240);
    expect(leadingClock('22:30')).toBe(1110);
  });
});

describe('factTestTrack', () => {
  // 2026-03-02 is a Monday; ticks at 10:00 UTC sit well inside each waking day.
  it('scores a project day: the tool used was right, the tool not used was wrong — from the day after first sight', () => {
    const { state, effects } = run(base(), [
      tick('2026-03-02T10:00:00.000Z'), // starts collecting
      tick('2026-03-03T10:00:00.000Z'), // records start; nothing tested yet
      seen('2026-03-03T11:00:00.000Z', 'project:puzzlebox-studio', 'usesTool', 'Code'),
      seen('2026-03-03T12:00:00.000Z', 'project:puzzlebox-studio', 'usesTool', 'Google Chrome'),
      seen('2026-03-03T13:00:00.000Z', 'project:puzzlebox-studio', 'usesTool', 'Code'),
      tick('2026-03-04T10:00:00.000Z'),
    ]);
    const r = state.factTests!.records;
    expect([r['f-code']!.right, r['f-code']!.wrong, r['f-slack']!.right, r['f-slack']!.wrong]).toEqual([1, 0, 0, 1]);
    expect(factRecordLine(r['f-code']!)).toBe('right 1 of 1, gathering');
    expect(effects).toEqual([]);
  });

  it('does not test a project on a day with fewer than three observations of it', () => {
    const { state } = run(base(), [tick('2026-03-02T10:00:00.000Z'), tick('2026-03-03T10:00:00.000Z'), seen('2026-03-03T11:00:00.000Z', 'project:puzzlebox-studio', 'usesTool', 'Code'), tick('2026-03-04T10:00:00.000Z')]);
    expect(state.factTests!.records['f-code']!.right + state.factTests!.records['f-code']!.wrong).toBe(0);
  });

  it('scores the day-begins clock on a working weekday from the waking day, and skips a weekend', () => {
    const withDrift = (days: Record<string, typeof EMPTY_DRIFT_DAY>): KernelState => ({ ...base(), drift: { ...EMPTY_DRIFT, days } });
    const day = { ...EMPTY_DRIFT_DAY, first: 250, last: 800, active: 500 };
    const weekday = run(withDrift({ '2026-03-03': day }), [tick('2026-03-02T10:00:00.000Z'), tick('2026-03-03T10:00:00.000Z'), tick('2026-03-04T10:00:00.000Z')]);
    expect(weekday.state.factTests!.records['f-begin']).toMatchObject({ right: 1, wrong: 0 });
    const saturday = run(withDrift({ '2026-03-07': day }), [tick('2026-03-06T10:00:00.000Z'), tick('2026-03-07T10:00:00.000Z'), tick('2026-03-08T10:00:00.000Z')]);
    expect(saturday.state.factTests!.records['f-begin']).toMatchObject({ right: 0, wrong: 0 });
  });

  it('moves belief only from twenty outcomes on: a miss against, a clock hit for, a tool hit not twice', () => {
    const s = base();
    const rec = (right: number, wrong: number, predicate: string, entityId: string, object: string) => ({ entityId, predicate, object, since: '2026-01-01', right, wrong, lastDay: null });
    const state: KernelState = {
      ...s,
      drift: { ...EMPTY_DRIFT, days: { '2026-03-03': { ...EMPTY_DRIFT_DAY, first: 250, last: 800, active: 500 } } },
      factTests: {
        day: '2026-03-03',
        seen: { 'project:puzzlebox-studio|usesTool': { n: 3, objects: ['Code'] } },
        records: {
          'f-code': rec(19, 1, 'usesTool', 'project:puzzlebox-studio', 'Code'),
          'f-slack': rec(15, 5, 'usesTool', 'project:puzzlebox-studio', 'Slack'),
          'f-begin': rec(20, 0, 'dayBeginsAt', 'owner:mira-bakker', '~08:00 (opens the laptop at 8)'),
        },
      } as KernelState['factTests'],
    };
    const { effects } = run(state, [tick('2026-03-04T10:00:00.000Z')]);
    expect(effects).toEqual([
      { type: 'ReinforceFact', factId: 'f-slack', delta: 1, ts: '2026-03-04T10:00:00.000Z', side: 'beta' },
      { type: 'ReinforceFact', factId: 'f-begin', delta: 1, ts: '2026-03-04T10:00:00.000Z', side: 'alpha' },
    ]);
  });

  it('drops the record of a fact no longer believed', () => {
    const { state } = run(base(), [tick('2026-03-02T10:00:00.000Z'), tick('2026-03-03T10:00:00.000Z')]);
    expect(Object.keys(state.factTests!.records)).toContain('f-slack');
    const cursor = { ...state.memory.factCursor };
    delete cursor['project:puzzlebox-studio:usesTool:Slack'];
    const after = run({ ...state, memory: { ...state.memory, factCursor: cursor } }, [tick('2026-03-04T10:00:00.000Z')]);
    expect(Object.keys(after.state.factTests!.records)).not.toContain('f-slack');
  });
});
