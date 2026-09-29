import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { agentSessionTrack } from './agent-session-track.js';

const ev = (payload: Record<string, unknown>): SanitizedEvent => ({ id: 'e1', type: 'agent:session', ts: '2026-09-28T10:00:00.000Z', payload, sanitized: true });

describe('agentSessionTrack', () => {
  it('a focus change keeps the fleet and the nudge memory (U3-F1)', () => {
    const s = createInitialState('d');
    const fleet = [{ id: 'a1', cwd: '~/Projects/acme', branch: null, state: 'waiting' as const, since: '2026-09-28T09:00:00.000Z' }];
    const before = { ...s, agent: { ...s.agent, fleet, nudged: ['collide:~/Projects/acme'] } };
    const after = agentSessionTrack(before, ev({ cwd: '~/Projects/other', branch: 'main' })).state;
    expect(after.agent).toEqual({ session: { cwd: '~/Projects/other', branch: 'main' }, fleet, nudged: ['collide:~/Projects/acme'] });
    expect(agentSessionTrack(after, ev({ cwd: null })).state.agent.fleet).toBe(fleet);
  });
});
