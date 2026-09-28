import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, ProjectRule, SanitizedEvent } from '@sundial/kernel/types.js';
import { projectRuleRegister } from './project-rule-register.js';

function windowChanged(processName: string, windowTitle: string): SanitizedEvent {
  return { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: { processName, windowTitle }, sanitized: true };
}

function withRules(projectRules: ProjectRule[], projectAliases: Record<string, string> = {}): KernelState {
  const base = createInitialState('d1');
  return { ...base, config: { ...base.config, projectRules, projectAliases } };
}

describe('projectRuleRegister', () => {
  it('emits a synthetic project:detected for a rootless rule-matched project', () => {
    const state = withRules([{ urlContains: 'localhost:3000', project: 'overture' }]);
    const { effects } = projectRuleRegister(state, windowChanged('Google Chrome', 'Home — localhost:3000'));
    expect(effects).toHaveLength(1);
    const eff = effects[0];
    expect(eff.type).toBe('EmitEvent');
    if (eff.type !== 'EmitEvent') return;
    expect(eff.event.type).toBe('project:detected');
    expect(eff.event.payload).toMatchObject({ projectRoot: 'named:overture', projectName: 'overture' });
  });

  it('does NOT emit when a real repo already owns the canonical name (it merges instead)', () => {
    const base = withRules([{ urlContains: 'overture-staging', project: 'overture' }]);
    const state: KernelState = {
      ...base,
      project: { ...base.project, known: { '~/proj/overture': { name: 'overture', org: null, remote: null, branch: null } } },
    };
    const { effects } = projectRuleRegister(state, windowChanged('Google Chrome', 'x — overture-staging.studiohq.nl'));
    expect(effects).toEqual([]);
  });

  it('is self-limiting — no re-emit once the synthetic project is in known', () => {
    const base = withRules([{ urlContains: 'localhost:3000', project: 'overture' }]);
    const state: KernelState = {
      ...base,
      project: { ...base.project, known: { 'named:overture': { name: 'overture', org: null, remote: null, branch: null } } },
    };
    const { effects } = projectRuleRegister(state, windowChanged('Google Chrome', 'localhost:3000'));
    expect(effects).toEqual([]);
  });

  it('does nothing when no rule matches', () => {
    const state = withRules([{ urlContains: 'localhost:3000', project: 'overture' }]);
    const { effects } = projectRuleRegister(state, windowChanged('Google Chrome', 'unrelated page'));
    expect(effects).toEqual([]);
  });

  it('ignores non-window:changed events', () => {
    const state = withRules([{ urlContains: 'x', project: 'y' }]);
    const { effects } = projectRuleRegister(state, { id: 'e1', type: 'idle:start', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true });
    expect(effects).toEqual([]);
  });
});
