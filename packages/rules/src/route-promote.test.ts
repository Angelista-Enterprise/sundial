import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { byGnomon } from './by-gnomon.js';
import { contradictionCheck } from './contradiction-check.js';
import { routeKey, routePromote } from './route-promote.js';

let seq = 0;
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (type: string, s: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `e${++seq}`, type, ts: at(s), payload, sanitized: true });
const step = (s: number, extra: Record<string, unknown> = {}) => ev('screen:step', s, { processName: 'Spotify', verb: 'press', role: 'button', screenText: ['Play'], goal: 'play the album', session: 's1', ok: true, changed: true, ...extra });
const performed = (s: number, outcome = 'ok') => ev('action:performed', s, { tool: 'screen_act', outcome });

function fold(events: SanitizedEvent[], state: KernelState = createInitialState('d')) {
  const effects: { type: string; event?: SanitizedEvent }[] = [];
  for (const event of events) {
    state = byGnomon(state, event).state;
    const out = routePromote(state, event);
    state = out.state;
    effects.push(...(out.effects as typeof effects));
  }
  return { state, candidates: effects.filter((e) => e.type === 'EmitEvent').map((e) => e.event!) };
}

describe('routePromote: a route that ran clean becomes a fact candidate about its app', () => {
  it('offers `app routeWorks <route key>`, provenance act, with the key routesOf keeps', () => {
    const { candidates } = fold([step(0, { verb: 'key', role: undefined, screenText: undefined, key: 'cmd+l', changed: true }), step(1), performed(2)]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.type).toBe('entity:fact-candidate');
    expect(candidates[0]!.payload).toMatchObject({ entityId: 'app:spotify', entityKind: 'app', canonicalName: 'Spotify', predicate: 'routeWorks', object: 'key cmd+l > press button "Play"', provenance: 'act', projectId: null });
  });

  it('a failed route offers nothing: a last step that failed, one that changed nothing, or a call that did not end ok', () => {
    expect(fold([step(0), step(1, { ok: false, reason: 'not-found' }), performed(2)]).candidates).toEqual([]);
    expect(fold([step(0, { changed: false }), performed(1)]).candidates).toEqual([]);
    expect(fold([step(0), performed(1, 'error')]).candidates).toEqual([]);
  });

  it('the key is stable across goals that differ only in what was typed, and never holds the goal text', () => {
    const typed = (goal: string, s: number) => [ev('screen:step', s, { processName: 'Spotify', verb: 'set-value', role: 'text field', screenText: ['Search'], goal, session: 's1', ok: true, changed: true, typed: 10 }), ev('screen:step', s + 1, { processName: 'Spotify', verb: 'key', key: 'return', goal, session: 's1', ok: true, changed: true })];
    const a = routeKey(typed('play giant steps', 0).map((e) => ({ ...e.payload, at: e.ts })));
    const b = routeKey(typed('play blue train', 10).map((e) => ({ ...e.payload, at: e.ts })));
    expect(a).toBe('set-value text field "Search" > key return');
    expect(b).toBe(a);
    expect(a).not.toMatch(/giant|blue/);
  });

  it('offers a run\'s route once, and the second clean run is the second observation that promotes it', () => {
    const { state, candidates } = fold([step(0), performed(1), step(2), performed(3), step(10, { session: 's2' }), performed(11)]);
    expect(candidates).toHaveLength(2);
    let memory = state;
    const upserts = candidates.flatMap((c) => {
      const out = contradictionCheck(memory, c);
      memory = out.state;
      return out.effects.filter((e) => e.type === 'UpsertEntityFact');
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ entityKind: 'app', predicate: 'routeWorks', provenance: 'act' });
  });

  it("learns nothing in the rig's test window", () => {
    expect(fold([step(0, { windowTitle: 'Rig fixture: notes run3' }), performed(1)]).candidates).toEqual([]);
  });

  it('drops a whole rig run, so two rig runs in two sessions never promote its route', () => {
    // A rig run's first step is the app switch, with no window title of its own; the next one is in the Testbox.
    const run = (s: number, session: string) => [
      step(s, { verb: 'open', role: undefined, screenText: undefined, session }),
      step(s + 1, { windowTitle: 'Inbox - Testbox', session }),
      performed(s + 2),
    ];
    const { state, candidates } = fold([...run(0, 's1'), ...run(10, 's2')]);
    expect(candidates).toEqual([]);
    expect(Object.values(state.routePromote!.runs).every((steps) => steps.some((s) => s.rig === true))).toBe(true);
    // The same when only the window in front was the rig's: no step carries a title at all.
    const focused = (s: number, session: string) => [ev('window:changed', s, { processName: 'Zen', windowTitle: 'Inbox - Testbox' }), step(s + 1, { session }), performed(s + 2)];
    expect(fold([...focused(20, 's3'), ...focused(30, 's4')]).candidates).toEqual([]);
    // An owner run in the same app afterwards still offers its route.
    expect(fold([ev('window:changed', 40, { processName: 'Zen', windowTitle: 'notes' }), step(41, { session: 's5' }), performed(42)]).candidates).toHaveLength(1);
  });

  it('stays bounded: 8 runs of 16 steps', () => {
    const events = Array.from({ length: 40 }, (_, i) => step(i, { session: `s${i % 12}` }));
    const { state } = fold(events);
    expect(Object.keys(state.routePromote!.runs)).toHaveLength(8);
    const long = fold(Array.from({ length: 30 }, (_, i) => step(i))).state;
    expect(Object.values(long.routePromote!.runs)[0]).toHaveLength(16);
  });
});
