import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { identityResolve } from './identity-resolve.js';

const tick = (ts: string): SanitizedEvent => ({ id: `t-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true });
const sweeps = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'ResolveAliases' }> => e.type === 'ResolveAliases');

function withAttendees(attendees: string[]): KernelState {
  const base = createInitialState('d1');
  return { ...base, meetings: { seen: { m1: { title: 'Standup', start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T09:30:00.000Z', attendees, askedAt: null } } } };
}

describe('identityResolve', () => {
  it('asks for a sweep, carrying no alias list of its own', () => {
    const state = withAttendees(['person-c205ca11f2', 'person-d1feb17d9f', 'Alex']);
    const [sweep] = sweeps(identityResolve(state, tick('2026-09-07T10:00:00.000Z')).effects);
    expect(sweep).toEqual({ type: 'ResolveAliases', ts: '2026-09-07T10:00:00.000Z' });
  });

  /**
   * The first version of this rule listed the aliases itself, from
   * `state.meetings.seen`. That map holds only RECENT meetings, so on the live
   * machine the sweep ran and found nothing to do while 25 hashed people sat in
   * the `entities` table. Which aliases is the executor's question — it is the
   * only side that can query that table.
   */
  it('asks for a sweep even when no recent meeting has an unnamed attendee', () => {
    const state = withAttendees(['Alex']);
    expect(sweeps(identityResolve(state, tick('2026-09-07T10:00:00.000Z')).effects)).toHaveLength(1);
  });

  it('sweeps once a day, not once a tick', () => {
    const state = withAttendees(['person-c205ca11f2']);
    const { state: after, effects } = identityResolve(state, tick('2026-09-07T10:00:00.000Z'));
    expect(sweeps(effects)).toHaveLength(1);
    // A sweep reads git history in every known root; a minute later is not due.
    expect(identityResolve(after, tick('2026-09-07T10:01:00.000Z')).effects).toEqual([]);
    expect(sweeps(identityResolve(after, tick('2026-09-08T10:01:00.000Z')).effects)).toHaveLength(1);
  });

  it('stamps the sweep clock, which is what makes it once a day', () => {
    const state = withAttendees(['person-c205ca11f2']);
    const { state: after } = identityResolve(state, tick('2026-09-07T10:00:00.000Z'));
    expect(after.people.resolvedAt).toBe('2026-09-07T10:00:00.000Z');
  });

  it('ignores anything that is not a tick', () => {
    const state = withAttendees(['person-c205ca11f2']);
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-09-07T10:00:00.000Z', payload: {}, sanitized: true };
    expect(identityResolve(state, event)).toEqual({ state, effects: [] });
  });
});
