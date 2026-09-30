import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { reduce } from '@sundial/kernel/reduce.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { configTrack } from './config-track.js';
import { RULE_MANIFEST } from './manifest.js';

const ev = (type: string, ts: string, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${ts}`, type, ts, payload, sanitized: true });

describe('configTrack (W3: config in the log)', () => {
  it('applies the diff, adds an owner change\'s restart paths, and a boot clears them', () => {
    let state = createInitialState('d1');
    state = configTrack(state, ev('config:changed', '2026-09-29T10:00:00.000Z', { source: 'owner', diff: [{ path: 'budgets', was: {}, now: { goal: 3 } }, { path: 'experiments.forecasting', was: false, now: true }], restart: ['ocr.enabled'] })).state;
    state = configTrack(state, ev('config:changed', '2026-09-29T10:01:00.000Z', { source: 'owner', diff: [], restart: ['privacy.mail', 'ocr.enabled'] })).state;
    expect(state.config.budgets).toEqual({ goal: 3 });
    expect(state.config.experiments.forecasting).toBe(true);
    expect(state.config.experiments.presence).toBe(false);
    expect(state.config.pendingRestart).toEqual(['ocr.enabled', 'privacy.mail']);
    expect(configTrack(state, ev('config:changed', '2026-09-29T11:00:00.000Z', { source: 'boot', diff: [] })).state.config.pendingRestart).toEqual([]);
  });

  it('never applies a secret entry', () => {
    const state = configTrack(createInitialState('d1'), ev('config:changed', '2026-09-29T10:00:00.000Z', { source: 'owner', diff: [{ path: 'llm.apiKey', changed: true }, { path: 'llm.apiKey', now: 'sk-abcdefgh' }] })).state;
    expect(JSON.stringify(state.config)).not.toContain('apiKey');
  });

  it('a mid-day projectRules change replays to the same moments, whatever the file says later', () => {
    // Made-up day: one title, a rule that files it under puzzlebox-studio until noon and lantern after.
    const events: SanitizedEvent[] = [];
    const at = (h: number, m: number) => `2026-09-29T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
    const rules = (project: string) => [{ titleContains: 'BOX-484', project, confidence: 'certain' as const }];
    for (let h = 9; h < 15; h++) {
      if (h === 12) events.push(ev('config:changed', at(12, 0), { source: 'owner', diff: [{ path: 'projectRules', was: rules('puzzlebox-studio'), now: rules('lantern') }], restart: [] }));
      events.push(ev('window:changed', at(h, 5), { processName: 'Arc', windowTitle: 'BOX-484 spec — Mira Bakker' }));
      for (let m = 6; m <= 50; m++) events.push(ev('clock:tick', at(h, m)));
      events.push(ev('window:changed', at(h, 51), { processName: 'Finder', windowTitle: 'Downloads' }));
    }
    const snapshot: KernelState = { ...createInitialState('d1'), config: { ...createInitialState('d1').config, projectRules: rules('puzzlebox-studio') } };
    const fold = (start: KernelState) => {
      let s = start;
      const moments: string[] = [];
      for (const e of events) {
        const r = reduce(s, e, RULE_MANIFEST);
        s = r.state;
        for (const { effect } of r.effects) if (effect.type === 'WriteDB' && effect.table === 'moments' && effect.row.processName === 'Arc') moments.push(`${effect.row.startTime} ${effect.row.projectId}`);
      }
      return moments;
    };
    const live = fold(snapshot);
    expect(live.length).toBeGreaterThanOrEqual(5);
    expect(live.filter((m) => m.includes('puzzlebox-studio')).length).toBeGreaterThan(0);
    expect(live.filter((m) => m.includes('lantern')).length).toBeGreaterThan(0);
    // Replay from the same snapshot: the log's config, not today's file.
    expect(fold(snapshot)).toEqual(live);
    // What the boot overwrite did before W3: today's file (lantern) over the snapshot, so the morning moved.
    expect(fold({ ...snapshot, config: { ...snapshot.config, projectRules: rules('lantern') } })).not.toEqual(live);
  });
});
