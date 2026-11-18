import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { expect, it } from 'vitest';
import { witnessPairs } from './witness-pairs.js';

const T0 = Date.parse('2026-09-01T09:00:00.000Z');
let seq = 0;
const ev = (type: string, seconds: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${seq++}`, type, ts: new Date(T0 + seconds * 1000).toISOString(), payload, sanitized: true });
const start = (sensorsOn = { ocr: true, audio: true }): KernelState => {
  const state = createInitialState('d1');
  return { ...state, config: { ...state.config, sensorsOn } };
};
function fold(state: KernelState, events: SanitizedEvent[]): { state: KernelState; emitted: { type: string; pair: unknown }[] } {
  const emitted: { type: string; pair: unknown }[] = [];
  for (const event of events) {
    const out = witnessPairs(state, event);
    state = out.state;
    for (const e of out.effects) if (e.type === 'EmitEvent') emitted.push({ type: e.event.type, pair: (e.event.payload as { pair?: unknown }).pair });
  }
  return { state, emitted };
}
const typing = (seconds: number) => ev('input:activity', seconds, { keyDownCount: 12 });
const editor = ev('window:changed', 0, { processName: 'Code', windowTitle: 'notes.md' });
/** `minutes` of typing, one window and one tick per minute, from `from` seconds. */
const typed = (minutes: number, from = 0) => Array.from({ length: minutes }, (_, m) => [typing(from + m * 60 + 30), ev('clock:tick', from + m * 60 + 60)]).flat();

it('W6 D6: 30 minutes of typing with no screen text is one sensor:blind; the next screen:ocr is one sensor:sighted', () => {
  const run = fold(start(), [editor, ...typed(29)]);
  expect(run.emitted).toEqual([]);
  const blind = fold(run.state, typed(3, 29 * 60));
  expect(blind.emitted).toEqual([{ type: 'sensor:blind', pair: 'screen' }]);
  expect(blind.state.witness?.pairs.screen).toMatchObject({ told: true, brokenSince: new Date(T0 + 30_000).toISOString() });
  const back = fold(blind.state, [ev('screen:ocr', 40 * 60)]);
  expect(back.emitted).toEqual([{ type: 'sensor:sighted', pair: 'screen' }]);
  expect(back.state.witness?.pairs.screen).toMatchObject({ told: false, leftMs: 0, brokenSince: null });
});

it('a screen:ocr inside the half hour starts the count again, and idle minutes and a sleep count nothing', () => {
  const idle = Array.from({ length: 120 }, (_, m) => ev('clock:tick', 3600 + m * 60));
  const run = fold(start(), [editor, ...typed(20), ev('screen:ocr', 20 * 60 + 5), ...typed(20, 21 * 60), ...idle, ev('clock:tick', 9 * 3600)]);
  expect(run.emitted).toEqual([]);
  expect(run.state.witness?.pairs.screen?.leftMs).toBe(20 * 60_000);
});

it('a private window, Sundial itself, and a sensor that is off are no evidence', () => {
  for (const front of [{ processName: '[hidden]', windowTitle: '[hidden]' }, { processName: 'Notes', windowTitle: '[private]' }, { processName: 'Sundial', windowTitle: 'Today' }]) {
    expect(fold(start(), [ev('window:changed', 0, front), ...typed(40)]).emitted).toEqual([]);
  }
  const off = fold(start({ ocr: false, audio: false }), [editor, ...typed(40)]);
  expect(off.emitted).toEqual([]);
  expect(Object.keys(off.state.witness?.pairs ?? {})).toEqual(['browser']);
});

it('a browser in front with new titles and no browser:tab is blind after 30 such minutes; the same title again is no evidence', () => {
  const page = (m: number, title: string) => [ev('window:changed', m * 60 + 10, { processName: 'Opera', windowTitle: title }), ev('clock:tick', m * 60 + 60)];
  const same = fold(start({ ocr: false, audio: false }), Array.from({ length: 40 }, (_, m) => page(m, 'Guide')).flat());
  expect(same.emitted).toEqual([]);
  expect(same.state.witness?.pairs.browser?.leftMs).toBe(60_000);
  const hidden = fold(start({ ocr: false, audio: false }), Array.from({ length: 40 }, (_, m) => page(m, `Page ${m} (Private Browsing)`)).flat());
  expect(hidden.emitted).toEqual([]);
  const blind = fold(start({ ocr: false, audio: false }), Array.from({ length: 40 }, (_, m) => page(m, `Page ${m}`)).flat());
  expect(blind.emitted).toEqual([{ type: 'sensor:blind', pair: 'browser' }]);
  const read = fold(start({ ocr: false, audio: false }), Array.from({ length: 40 }, (_, m) => [...page(m, `Page ${m}`), ev('browser:tab', m * 60 + 20)]).flat());
  expect(read.emitted).toEqual([]);
});

it('a call that holds the microphone while hearing is on, with no transcript for 30 minutes, is blind', () => {
  const state = start();
  const onCall: KernelState = { ...state, hearing: { ...state.hearing, listening: true }, av: { ...state.av, call: { app: 'Zoom', kind: 'work-call', since: new Date(T0).toISOString(), cameraEver: false } } };
  const ticks = Array.from({ length: 31 }, (_, m) => ev('clock:tick', m * 60));
  expect(fold(onCall, ticks).emitted).toEqual([{ type: 'sensor:blind', pair: 'audio' }]);
  expect(fold(state, ticks).emitted).toEqual([]);
});
