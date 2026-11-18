import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { reduce } from '@sundial/kernel/reduce.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { byGnomon, byGnomonMarked, isRigWindow, SETTLE_MS } from './by-gnomon.js';
import { RULE_MANIFEST } from './manifest.js';

let seq = 0;
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (type: string, s: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `e${++seq}`, type, ts: at(s), payload, sanitized: true });
const focus = (s: number, processName: string, windowTitle = 'a window') => ev('window:changed', s, { processName, windowTitle });
const decided = (s: number, verdict = 'ask') => ev('action:decided', s, { tool: 'screen_act', verdict });
const acted = (s: number, app: string) => ev('screen:acted', s, { id: `act-${s}`, outcome: 'performed', target: { processName: app } });
const step = (s: number, app: string, extra: Record<string, unknown> = {}) => ev('screen:step', s, { id: `act-${s}`, processName: app, verb: 'press', role: 'button', screenText: ['Play'], goal: 'play the album', session: 's1', ok: true, changed: true, ...extra });
const performed = (s: number, outcome = 'ok') => ev('action:performed', s, { tool: 'screen_act', outcome });

/** Folds the marker alone and says, per event, why it was not the owner's. */
function marks(events: SanitizedEvent[], state = createInitialState('d')) {
  const out: (string | null)[] = [];
  for (const event of events) {
    state = byGnomon(state, event).state;
    out.push(byGnomonMarked(state, event));
  }
  return { state, out };
}

describe('byGnomon: the mark on the rows Gnomon caused', () => {
  it("a Gnomon act's focus change is not the owner's; an owner change after the settle is", () => {
    const { out } = marks([decided(0, 'allow'), focus(0.07, 'Spotify'), acted(0.5, 'Spotify'), step(0.9, 'Spotify'), performed(1), focus(1 + SETTLE_MS / 1000 + 0.5, 'Spotify')]);
    expect(out).toEqual([null, 'act', null, null, null, null]);
  });

  it('an ask not yet answered, and a yes, mark no focus change in any app; the act\'s own app, once named, is Gnomon\'s', () => {
    const answered = (s: number) => ev('approval:answered', s, { tool: 'screen_act', answer: 'allowed-once', by: 'owner' });
    const { out } = marks([decided(0, 'ask'), focus(0.5, 'Sundial'), answered(5), focus(5.3, 'Zed'), acted(5.6, 'Spotify'), focus(5.8, 'Spotify'), focus(6, 'Zed')]);
    expect(out).toEqual([null, null, null, null, null, 'act', null]);
  });

  it('a yes extends a window that is already open', () => {
    const { out } = marks([decided(0, 'allow'), acted(0.5, 'Spotify'), ev('approval:answered', 3, { tool: 'screen_act', answer: 'allowed-once' }), focus(5.5, 'Spotify')]);
    expect(out.at(-1)).toBe('act');
  });

  it('inside the window, a focus change in another app than the run acted in stays the owner\'s', () => {
    const { out } = marks([decided(0), acted(0.3, 'Spotify'), focus(0.6, 'Spotify'), focus(1.2, 'Zed'), ev('browser:tab', 1.5, { app: 'Spotify', title: 'a page' })]);
    expect(out.slice(2)).toEqual(['act', null, 'act']);
  });

  it('a denied act opens nothing, and nothing is marked before the first act', () => {
    expect(marks([focus(0, 'Zed'), decided(1, 'deny'), focus(1.1, 'Spotify')]).out).toEqual([null, null, null]);
  });

  it('an input window wholly inside the run is Gnomon\'s; one that began before it is the owner\'s', () => {
    const { out } = marks([decided(0), acted(1, 'Spotify'), step(2, 'Spotify'), step(4, 'Spotify'), step(6, 'Spotify'), ev('input:activity', 6.5, { windowMs: 5000, keyDownCount: 3 }), ev('input:activity', 7, { windowMs: 10_000, keyDownCount: 3 })]);
    expect(out.slice(-2)).toEqual(['act', null]);
  });

  it('a project row right after a marked focus change inherits the mark', () => {
    const { out } = marks([decided(0, 'allow'), focus(0.1, 'TextEdit'), ev('project:detected', 0.2, { projectId: 'p1' }), ev('project:detected', 9, { projectId: 'p1' })]);
    expect(out.slice(1)).toEqual(['act', 'act', null]);
  });

  it("the rig's test windows are never the owner's, whenever they come", () => {
    expect(isRigWindow('Inbox - Testbox')).toBe(true);
    expect(isRigWindow('Rig fixture: notes run12')).toBe(true);
    expect(isRigWindow('My rig fixture: notes')).toBe(false);
    const { state, out } = marks([focus(0, 'Zen', 'Inbox - Testbox'), ev('project:detected', 0.1, {}), focus(100, 'TextEdit', 'Rig fixture: notes run12'), ev('screen:ocr', 101, { processName: 'TextEdit', windowTitle: 'Rig fixture: notes run12' }), focus(200, 'Zed')]);
    expect(out).toEqual(['rig', 'rig', 'rig', 'rig', null]);
    expect(state.byGnomon.n).toEqual({ act: 0, rig: 4 });
    expect(state.byGnomon.focus).toBeNull();
  });

  it('stays bounded: one run, the newest four apps, one mark', () => {
    const apps = ['A', 'B', 'C', 'D', 'E', 'F'];
    const { state } = marks([decided(0), ...apps.map((a, i) => acted(0.2 * (i + 1), a)), focus(2, 'F')]);
    expect(state.byGnomon.apps).toEqual(['C', 'D', 'E', 'F']);
    expect(state.byGnomon.marked?.why).toBe('act');
    expect(Object.keys(state.byGnomon).sort()).toEqual(['anyApp', 'apps', 'focus', 'marked', 'n', 'since', 'until']);
  });

  it('leaves the state object alone on a row it has nothing to say about', () => {
    const state = createInitialState('d');
    expect(byGnomon(state, ev('clock:tick', 0)).state).toBe(state);
    expect(byGnomon(state, focus(0, 'Zed')).state).toBe(state);
  });
});

describe('the owner-learning rules fold nothing on a marked row', () => {
  // Every rule `ownerOnly` wraps in the manifest: the learners that read focus, tab, screen-text, input or project rows.
  const FENCED = [
    'contextSwitch', 'momentAnalysisSchedule', 'transcriptClean', 'transcriptAccept', 'anomalyZscore', 'entityExtract', 'commitmentTrack', 'promiseTrack',
    'embeddingIndex', 'screenTrack', 'screenRead', 'momentRollup', 'momentClose', 'appLearn', 'attributionPropose', 'projectTrack', 'ticketTrack',
    'browserTrack', 'contextUrlClassify', 'projectRuleRegister', 'focusFlow', 'returnFromBreak', 'stuckSigns', 'thrashing', 'routineLearn',
    'projectTouchForecast', 'expectationLearn', 'expectationWatch', 'calibrate',
  ];
  const base = createInitialState('d');
  const on: KernelState = { ...base, config: { ...base.config, experiments: { ...base.config.experiments, stuckSigns: true, forecasting: true } } };
  // An open moment in the owner's editor, so a focus change would close it.
  const opened = reduce(on, focus(0, 'Zed', 'main.ts'), RULE_MANIFEST).state;

  it.each(FENCED)('%s', (name) => {
    const rule = RULE_MANIFEST.find((r) => r.name === name);
    expect(rule, name).toBeDefined();
    for (const event of [focus(60, 'Spotify', 'Spotify Premium'), ev('browser:tab', 61, { app: 'Zen', host: 'example.com', title: 'a page' }), ev('screen:ocr', 62, { processName: 'Spotify', screenText: 'words', topics: ['music'] }), ev('input:activity', 63, { windowMs: 1000, keyDownCount: 9 }), ev('project:detected', 64, { projectId: 'p', projectName: 'p', projectRoot: '/p' })]) {
      const state: KernelState = { ...opened, byGnomon: { ...opened.byGnomon, marked: { id: event.id, why: 'act' } } };
      const out = rule!(state, event);
      expect(out.state, `${name} on ${event.type}`).toBe(state);
      expect(out.effects).toEqual([]);
    }
  });

  it('through the whole fold: Gnomon in a music app is not the owner there; the owner going there after is', () => {
    let state = opened;
    const effects: unknown[] = [];
    const run = (e: SanitizedEvent) => {
      const out = reduce(state, e, RULE_MANIFEST);
      state = out.state;
      effects.push(...out.effects.map((x) => x.effect));
    };
    const moment = state.moment!.id;
    for (const e of [decided(60, 'allow'), focus(60.07, 'Spotify', 'Spotify Premium'), acted(60.5, 'Spotify'), step(61, 'Spotify'), performed(61.2)]) run(e);
    expect(state.apps.used.Spotify).toBeUndefined();
    expect(state.routines.trail.some((s) => s.startsWith('Spotify/'))).toBe(false);
    expect(state.moment?.id).toBe(moment);
    expect(state.moment?.rollup.acts).toMatchObject({ n: 1, apps: ['Spotify'] });
    expect(state.window.active?.processName).toBe('Spotify');
    expect(JSON.stringify(effects)).not.toMatch(/usesTool/);

    run(focus(90, 'Spotify', 'Spotify Premium - album'));
    expect(state.apps.used.Spotify?.n).toBe(1);
    expect(state.moment?.processName).toBe('Spotify');
  });
});
