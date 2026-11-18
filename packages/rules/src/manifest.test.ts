import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { RULE_MANIFEST } from './manifest.js';

const FLAGGED = {
  forecasting: ['hourFragmentedForecast', 'projectTouchForecast', 'forecastTournament', 'uncertaintyMap', 'researchGoals'],
  gateFeatures: ['gateFeaturesJudge', 'applyGateFeatures'],
} as const;

describe('experiment switches in the manifest', () => {
  const event = { type: 'clock:tick', timestamp: '2026-09-24T12:00:00.000Z', payload: {} } as unknown as SanitizedEvent;

  it.each(Object.entries(FLAGGED))('%s: off by default, and each rule then folds nothing', (_flag, names) => {
    const state = createInitialState('test');
    for (const name of names) {
      const rule = RULE_MANIFEST.find((r) => r.name === name);
      expect(rule, name).toBeDefined();
      const out = rule!(state, event);
      expect(out.state).toBe(state);
      expect(out.effects).toEqual([]);
    }
  });
});
