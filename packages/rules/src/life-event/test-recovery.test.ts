import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { testRecovery, testKey } from './test-recovery.js';

function shellEvent(ts: string, command: string, exitCode: number | null, cwd = '/x/gnomon'): SanitizedEvent {
  return { id: 'e1', type: 'shell:command', ts, payload: { command, exitCode, cwd }, sanitized: true };
}

describe('testKey', () => {
  it('normalizes npm run test to npm test', () => {
    expect(testKey('npm run test --watch')).toBe('npm test');
  });

  it('returns null for a non-test command', () => {
    expect(testKey('ls -la')).toBeNull();
  });
});

describe('testRecovery', () => {
  it('records a failure and does not emit yet', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = testRecovery(state, shellEvent('2026-01-01T00:00:00.000Z', 'npm test', 1));

    expect(effects).toEqual([]);
    expect(next.lifeEvent.failedTests['/x/gnomon|npm test']).toEqual({ command: 'npm test', failedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('emits event:test-recovery when a passing run follows a failure within the window', () => {
    const state = createInitialState('d1');
    const afterFail = testRecovery(state, shellEvent('2026-01-01T00:00:00.000Z', 'npm test', 1)).state;

    const { state: next, effects } = testRecovery(afterFail, shellEvent('2026-01-01T00:02:00.000Z', 'npm test', 0));

    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: {
          id: expect.any(String),
          type: 'event:test-recovery',
          ts: '2026-01-01T00:02:00.000Z',
          payload: { timestamp: '2026-01-01T00:02:00.000Z', failedCommand: 'npm test', recoveredCommand: 'npm test', recoveryMs: 120_000, cwd: '/x/gnomon' },
        },
      },
    ]);
    expect(next.lifeEvent.failedTests['/x/gnomon|npm test']).toBeUndefined();
  });

  it('does not emit when a passing run has no prior failure', () => {
    const state = createInitialState('d1');
    const { effects } = testRecovery(state, shellEvent('2026-01-01T00:00:00.000Z', 'npm test', 0));
    expect(effects).toEqual([]);
  });

  it('does not emit recovery outside the recovery window', () => {
    const state = createInitialState('d1');
    const afterFail = testRecovery(state, shellEvent('2026-01-01T00:00:00.000Z', 'npm test', 1)).state;
    const { effects } = testRecovery(afterFail, shellEvent('2026-01-01T00:20:00.000Z', 'npm test', 0));
    expect(effects).toEqual([]);
  });

  it('ignores commands with no exitCode (non-hook shell path)', () => {
    const state = createInitialState('d1');
    const { effects } = testRecovery(state, shellEvent('2026-01-01T00:00:00.000Z', 'npm test', null));
    expect(effects).toEqual([]);
  });
});
