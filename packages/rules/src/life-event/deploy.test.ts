import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { deploy } from './deploy.js';

function shellEvent(command: string): SanitizedEvent {
  return { id: 'e1', type: 'shell:command', ts: '2026-01-01T00:00:00.000Z', payload: { command }, sanitized: true };
}

describe('deploy', () => {
  it('ignores non-deploy commands', () => {
    const state = createInitialState('d1');
    const { effects } = deploy(state, shellEvent('ls -la'));
    expect(effects).toEqual([]);
  });

  it('detects npm publish and identifies the target', () => {
    const state = createInitialState('d1');
    const { effects } = deploy(state, shellEvent('npm publish'));

    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: { id: expect.any(String), type: 'event:deploy', ts: '2026-01-01T00:00:00.000Z', payload: { timestamp: '2026-01-01T00:00:00.000Z', command: 'npm publish', projectName: null, target: 'npm' } },
      },
    ]);
  });

  it('detects git push to an unambiguously deploy-related branch and includes the current project name', () => {
    const state = { ...createInitialState('d1'), project: { current: { id: '/x/gnomon', name: 'gnomon' }, org: null, known: {}, recentDetections: [], lastClosedMoment: null } };
    const { effects } = deploy(state, shellEvent('git push origin production'));

    expect(effects).toHaveLength(1);
    expect((effects[0] as any).event.payload).toMatchObject({ target: 'git-push', projectName: 'gnomon' });
  });

  it('ignores a git push to a non-default branch', () => {
    const state = createInitialState('d1');
    const { effects } = deploy(state, shellEvent('git push origin feature/foo'));
    expect(effects).toEqual([]);
  });

  it('L1: does NOT treat a routine git push to main/master as a deploy (fixes over-eager false-positive)', () => {
    const state = createInitialState('d1');
    expect(deploy(state, shellEvent('git push origin main')).effects).toEqual([]);
    expect(deploy(state, shellEvent('git push origin master')).effects).toEqual([]);
    expect(deploy(state, shellEvent('git push main')).effects).toEqual([]);
  });

  it('L1: still detects git push to prod/production/release', () => {
    const state = createInitialState('d1');
    expect(deploy(state, shellEvent('git push origin prod')).effects).toHaveLength(1);
    expect(deploy(state, shellEvent('git push origin production')).effects).toHaveLength(1);
    expect(deploy(state, shellEvent('git push origin release')).effects).toHaveLength(1);
  });
});
