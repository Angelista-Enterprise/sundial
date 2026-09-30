import { describe, expect, it } from 'vitest';
import { sanitizeAtIngest } from '@sundial/helpers/sanitize-at-ingest.js';
import { DEFAULT_SUNDIAL_CONFIG, resolveSundialConfig } from '@sundial/helpers/sundial-config.js';
import { applyConfigDiff, configChange, configDiff, kernelConfigOf, restartPaths } from './config-log.js';
import { createInitialState } from './initial-state.js';

describe('config-log (W3)', () => {
  const base = kernelConfigOf(DEFAULT_SUNDIAL_CONFIG);

  it('diffs schema objects leaf by leaf and owner-keyed records whole, ignoring key order', () => {
    const next = kernelConfigOf(resolveSundialConfig({ experiments: { forecasting: true }, projectAliases: { 'puzzle box': 'puzzlebox-studio' }, budgets: { goal: 3 }, llm: { use: { intent: 'lantern' } } } as never));
    expect(configDiff(base, next).map((d) => d.path)).toEqual(['budgets', 'experiments.forecasting', 'llm.use', 'projectAliases']);
    expect(configDiff(base, next).find((d) => d.path === 'projectAliases')).toEqual({ path: 'projectAliases', was: {}, now: { 'puzzle box': 'puzzlebox-studio' } });
    expect(configDiff({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
    expect(configDiff(next, next)).toEqual([]);
  });

  it('applies a diff back onto the config it came from', () => {
    const next = kernelConfigOf(resolveSundialConfig({ vault: '~/Documents/Notes', timezone: 'Europe/Amsterdam', notifications: { pushAtMac: false } } as never));
    expect(applyConfigDiff(base, configDiff(base, next))).toEqual(next);
  });

  it('a key path never appears with its value in a payload', () => {
    const diff = configDiff({ llm: { apiKey: 'sk-live-abcdef' }, integrations: [{ env: { TOKEN: 'x' } }] }, { llm: { apiKey: 'sk-live-ghijkl' }, integrations: [{ env: { TOKEN: 'y' } }] });
    expect(diff).toEqual([{ path: 'integrations', changed: true }, { path: 'llm.apiKey', changed: true }]);
    expect(JSON.stringify(diff)).not.toMatch(/sk-live|"x"|"y"/);
  });

  it('names the restart-only leaves of a raw file change, and not the live ones', () => {
    const was = { privacy: { mail: false }, ocr: { enabled: false, retentionDays: 14 }, audio: { autoMeetings: false }, budgets: { goal: 3 }, integrations: [{ name: 'notes', env: { TOKEN: 'a' } }] };
    const now = { privacy: { mail: true }, ocr: { enabled: true, retentionDays: 7 }, audio: { autoMeetings: true }, budgets: { goal: 4 }, integrations: [{ name: 'notes', env: { TOKEN: 'b' } }], llm: { use: { intent: 'lantern' } } };
    expect(restartPaths(was, now)).toEqual(['integrations', 'ocr.enabled', 'privacy.mail']);
  });

  it('an action tool leaving or reaching off needs a restart (registered at start); ask <-> auto is live', () => {
    expect(restartPaths({}, { actions: { outward: { all: 'ask' } } })).toEqual(['actions.outward']);
    expect(restartPaths({ actions: { outward: 'auto' } }, { actions: { outward: 'off' } })).toEqual(['actions.outward']);
    expect(restartPaths({ actions: { outward: { run_shell: 'ask' } } }, { actions: { outward: { run_shell: 'off' } } })).toEqual(['actions.outward']);
    expect(restartPaths({ actions: { outward: 'ask' } }, { actions: { outward: 'auto' } })).toEqual([]);
    expect(restartPaths({}, { actions: { internal: { gnomon_assert: 'ask' } } })).toEqual([]);
    expect(restartPaths({}, { actions: { internal: 'off' } })).toEqual(['actions.internal']);
  });

  it('an owner write that moved nothing logs nothing', () => {
    expect(configChange(base, DEFAULT_SUNDIAL_CONFIG, [])).toBeNull();
    expect(configChange(base, DEFAULT_SUNDIAL_CONFIG, ['privacy.mail'])).toEqual({ source: 'owner', diff: [], restart: ['privacy.mail'] });
  });

  it('a config:changed payload survives sanitizeAtIngest: paths, rules, aliases and the vault are owner-authored, not captured', () => {
    const next = kernelConfigOf(
      resolveSundialConfig({
        vault: '~/Documents/Mira Bakker Notes',
        projectRules: [{ pathContains: '/Users/mira/Projects/puzzlebox-studio', project: 'puzzlebox-studio' }, { titleContains: 'BOX-484', urlContains: 'https://tracker.example.com/browse/BOX-484?focus=1', project: 'puzzlebox-studio' }],
        orgByPath: { '/Users/mira/Projects/lantern': 'Lantern' },
        ownerAliases: ['Mira Bakker', 'mira', 'person-1a2b3c4d'],
      } as never),
    );
    const payload = { source: 'owner', diff: configDiff(createInitialState('d1').config, next), restart: ['vault'] };
    const event = { id: 'e1', type: 'config:changed', ts: '2026-09-29T10:00:00.000Z', payload };
    expect(sanitizeAtIngest(event).payload).toEqual(JSON.parse(JSON.stringify(payload)));
  });
});
