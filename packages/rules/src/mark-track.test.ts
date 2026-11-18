import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { JUDGE_FIRST, MAX_CHATS, MAX_MARKS, clip, markTrack } from './mark-track.js';

const T0 = Date.parse('2026-03-10T09:00:00.000Z');
const ev = (type: string, sec: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${sec}`, type, ts: new Date(T0 + sec * 1000).toISOString(), payload, sanitized: true });
const SEND = { app: 'Mail', role: 'button', label: 'Send' };
const STEPS = [
  { target: { app: 'Xcode', role: 'menu item', label: 'Scheme' }, line: 'Open the scheme menu' },
  { target: { app: 'Xcode', role: 'menu item', label: 'Edit Scheme' }, line: 'Choose Edit Scheme' },
];

function fold(events: SanitizedEvent[], state: KernelState = createInitialState('d1')) {
  const effects: Effect[] = [];
  for (const e of events) {
    const out = markTrack(state, e);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}
const drawn = (effects: Effect[]) => effects.filter((e) => e.type === 'Mark') as Extract<Effect, { type: 'Mark' }>[];

describe('markTrack (plan 15 steps 6 to 8)', () => {
  it('a mark is drawn whole, judged for the first marks, and cleared on request', () => {
    const { state, effects } = fold([ev('screen:mark', 0, { id: 'm1', target: SEND, shape: 'ring', label: 'This one' }), ev('screen:mark', 1, { clear: true })]);
    expect(drawn(effects)[0]).toEqual({ type: 'Mark', marks: [{ id: 'm1', target: SEND, shape: 'ring', label: 'This one' }], judge: true });
    expect(drawn(effects)[1].marks).toEqual([]);
    expect(state.marks?.now).toEqual([]);
  });

  it('clears one mark by id, and a placed id goes with its mark', () => {
    const { state } = fold([ev('screen:mark', 0, { id: 'm1', target: SEND }), ev('screen:mark', 1, { id: 'ask:a1', target: SEND }), ev('screen:mark-placed', 2, { id: 'ask:a1' }), ev('screen:mark', 3, { clear: true, id: 'ask:a1' })]);
    expect(state.marks?.now.map((m) => m.id)).toEqual(['m1']);
    expect(state.marks?.placed).toEqual([]);
  });

  it('cuts a long label at a word, never mid-word', () => {
    expect(clip('Click New Message to open a fresh compose window for Mira Bakker.')).toBe('Click New Message to open a fresh compose window for Mira…');
    expect(clip('Click Send.')).toBe('Click Send.');
  });

  it('refuses a target with no app, or with nothing to find it by', () => {
    expect(fold([ev('screen:mark', 0, { target: { role: 'button' } }), ev('screen:mark', 1, { target: { app: 'Mail' } })]).effects).toEqual([]);
  });

  it('keeps 12 marks at most, and drops one the app could not find or saw go', () => {
    const many = Array.from({ length: MAX_MARKS + 3 }, (_, i) => ev('screen:mark', i, { id: `m${i}`, target: SEND }));
    const { state } = fold([...many, ev('screen:mark-cleared', 30, { id: 'm14', reason: 'gone' })]);
    expect(state.marks?.now.map((m) => m.id)).toEqual(Array.from({ length: MAX_MARKS - 1 }, (_, i) => `m${i + 3}`));
  });

  it('stops asking to judge after 20 judged marks', () => {
    const judged = Array.from({ length: JUDGE_FIRST }, (_, i) => ev('screen:mark-judged', i, { id: `m${i}`, right: true }));
    const { effects } = fold([...judged, ev('screen:mark', 30, { id: 'm1', target: SEND })]);
    expect(drawn(effects)[0].judge).toBeUndefined();
  });

  it('a guide rings one step at a time and ends itself after the last', () => {
    const { state, effects } = fold([ev('guide:started', 0, { taskKey: 'edit-scheme', steps: STEPS }), ev('guide:step', 5, { taskKey: 'edit-scheme' }), ev('guide:step', 9, { taskKey: 'edit-scheme' })]);
    expect(drawn(effects).map((e) => e.marks.map((m) => [m.label, m.step]))).toEqual([[['Open the scheme menu', 1]], [['Choose Edit Scheme', 2]], []]);
    expect(effects.some((e) => e.type === 'EmitEvent' && e.event.type === 'guide:ended' && e.event.payload.reason === 'done')).toBe(true);
    expect(state.marks?.guide).toBeNull();
  });

  it('the help fades: rings without lines the second time, nothing drawn the third', () => {
    const run = (n: number) => Array.from({ length: n }, (_, i) => [ev('guide:started', i * 10, { taskKey: 'edit-scheme', steps: STEPS }), ev('guide:ended', i * 10 + 1, { taskKey: 'edit-scheme', reason: 'esc' })]).flat();
    const second = fold([...run(1), ev('guide:started', 50, { taskKey: 'edit-scheme', steps: STEPS })]);
    expect(drawn(second.effects).at(-1)?.marks).toEqual([{ id: 'guide:edit-scheme:0', target: STEPS[0].target, shape: 'ring', step: 1, of: 2, guide: 'edit-scheme' }]);
    const third = fold([...run(2), ev('guide:started', 50, { taskKey: 'edit-scheme', steps: STEPS })]);
    expect(third.state.marks?.guide?.shown).toBeUndefined();
    expect(drawn(third.effects).at(-1)?.marks).toEqual([]);
  });

  it("holds the app's answer to an act for the tool that waits, with what it replaced", () => {
    const { state } = fold([ev('screen:acted', 0, { id: 'act-1', outcome: 'performed', replacedChars: 5, target: { app: 'Notes', role: 'text field', label: 'Title' } })]);
    expect(state.marks?.lastAct).toEqual({ id: 'act-1', at: expect.any(String), outcome: 'performed', replaced: true, target: { app: 'Notes', role: 'text field', label: 'Title' } });
  });

  it('run 230: a set-value into an empty field (or one showing only its placeholder) replaced nothing', () => {
    const { state } = fold([ev('screen:acted', 0, { id: 'act-2', outcome: 'performed', replacedChars: 0, target: { app: 'Chrome', role: 'text field', label: 'Item' } })]);
    expect(state.marks?.lastAct?.replaced).toBeUndefined();
  });

  it('a look folds to a pointer: no element reaches the state; a private app or a refusal is refused (doc 16)', () => {
    const elements = [{ ref: 'e1', role: 'AXButton', screenText: ['New Note', '', 'toolbar'] }, { ref: 'e7', role: 'AXTextField', screenText: ['Search', '', 'toolbar'] }];
    const { state, effects } = fold([ev('screen:looked', 0, { id: 'look-1', after: 'act-1', processName: 'Notes', windowTitle: 'Lunch Thursday', screenText: ['File'], elements })]);
    expect(state.marks?.lastLook).toEqual({ id: 'look-1', app: 'Notes', window: 'Lunch Thursday', n: 2, at: '2026-03-10T09:00:00.000Z', after: 'act-1' });
    expect(effects).toEqual([]);
    expect(JSON.stringify(state.marks)).not.toContain('Search');
    expect(fold([ev('screen:looked', 0, { id: 'look-2', processName: 'Mail', windowTitle: '[private]', elements })]).state.marks?.lastLook).toMatchObject({ id: 'look-2', app: 'Mail', window: '[private]', n: 2, refused: 'private app' });
    expect(fold([ev('screen:looked', 0, { id: 'look-4', processName: 'Notes', n: 600, elements })]).state.marks?.lastLook?.n).toBe(600);
    expect(fold([ev('screen:looked', 0, { id: 'look-3', refused: 'secure input' })]).state.marks?.lastLook).toMatchObject({ id: 'look-3', app: '', n: 0, refused: 'secure input' });
    expect(fold([ev('screen:looked', 0, { refused: 'secure input' })]).state.marks?.lastLook).toBeUndefined();
  });

  it('a mark and a guide step take a ref with its look: named, or by the tag of the last look; a bare ref or an older tag is no target', () => {
    const looked = ev('screen:looked', 0, { id: 'look-1', processName: 'Notes', windowTitle: 'Lunch Thursday', elements: [] });
    const { effects } = fold([looked, ev('screen:mark', 1, { id: 'm1', target: { ref: 'e7@ok-1' } }), ev('screen:mark', 2, { id: 'm2', target: { app: 'Notes', look: 'look-0', ref: 'e2' } }), ev('guide:started', 3, { taskKey: 'find-a-note', steps: [{ target: { ref: 'e7@ok-1' }, line: 'Type a word' }] })]);
    expect(drawn(effects).at(-1)?.marks.map((m) => m.target)).toEqual([{ app: 'Notes', look: 'look-1', ref: 'e7' }, { app: 'Notes', look: 'look-0', ref: 'e2' }, { app: 'Notes', look: 'look-1', ref: 'e7' }]);
    expect(fold([ev('screen:mark', 0, { target: { ref: 'e7' } })]).effects).toEqual([]);
    for (const ref of ['e7', 'e7@ok-0']) expect(fold([looked, ev('screen:mark', 1, { target: { ref } })]).effects).toEqual([]);
    expect(fold([ev('screen:looked', 0, { id: 'look-2', processName: 'Mail', windowTitle: '[private]' }), ev('screen:mark', 1, { target: { ref: 'e7@ok-2' } })]).effects).toEqual([]);
  });

  it('an act keeps its target under the names the redaction pass gave it', () => {
    const { state } = fold([ev('screen:acted', 0, { id: 'act-1', outcome: 'performed', target: { processName: 'Mail', windowTitle: 'Inbox', role: 'button', label: 'Send' } })]);
    expect(state.marks?.lastAct?.target).toEqual({ app: 'Mail', window: 'Inbox', role: 'button', label: 'Send' });
  });

  it("a refusal keeps the menu words the app put in its target (runs 42, 50, 57)", () => {
    const { state } = fold([ev('screen:acted', 0, { id: 'act-1', outcome: 'refused', reason: 'submenu', target: { processName: 'Notes', role: 'menu item', label: 'Sort By', screenText: ['Name', '', 7, 'Size'] } })]);
    expect(state.marks?.lastAct).toMatchObject({ reason: 'submenu', names: ['Name', 'Size'] });
    expect(fold([ev('screen:acted', 0, { id: 'act-2', outcome: 'refused', reason: 'covered', target: { processName: 'Notes', label: 'x' } })]).state.marks?.lastAct?.names).toBeUndefined();
  });

  it('Round 2: a printed look and a step fold per chat: the look, when each app was printed, the last app, a quit', () => {
    const { state } = fold([
      ev('screen:printed', 0, { session: 'chat-a', look: 'look-1', tag: 'ab12', app: 'Notes', act: null }),
      ev('screen:printed', 5, { session: 'chat-a', look: 'look-2', app: 'Spotify', act: 'act-0' }),
      ev('screen:step', 9, { id: 'act-1', session: 'chat-a', processName: 'Calculator', verb: 'pick-menu', ok: true, quit: true }),
      ev('screen:step', 10, { id: 'act-2', processName: 'Zen', verb: 'open', ok: true }),
    ]);
    expect(state.marks?.chats?.['chat-a']).toEqual({ look: { id: 'look-2', app: 'Spotify', at: ev('', 5).ts, act: 'act-0' }, apps: { Notes: ev('', 0).ts, Spotify: ev('', 5).ts }, app: { app: 'Calculator', at: ev('', 9).ts }, step: { id: 'act-1', app: 'Calculator', at: ev('', 9).ts }, quit: { app: 'Calculator', at: ev('', 9).ts } });
    // A step with no chat is kept under '', as the tools key it.
    expect(state.marks?.chats?.['']).toEqual({ app: { app: 'Zen', at: ev('', 10).ts }, step: { id: 'act-2', app: 'Zen', at: ev('', 10).ts } });
    const many = fold(Array.from({ length: MAX_CHATS + 3 }, (_, i) => ev('screen:printed', i, { session: `chat-${i}`, look: `look-${i}`, app: 'Notes' }))).state;
    expect(Object.keys(many.marks?.chats ?? {})).toHaveLength(MAX_CHATS);
    expect(many.marks?.chats?.['chat-0']).toBeUndefined();
  });

  it('Round 2: a Send\'s proof on its step: unconfirmed is kept per app (and on the last act), confirmed clears it', () => {
    const acted = ev('screen:acted', 0, { id: 'act-1', outcome: 'performed' });
    const { state } = fold([acted, ev('screen:step', 1, { id: 'act-1', session: 'chat-a', processName: 'Mail', verb: 'press', ok: true, proof: 'unconfirmed' })]);
    expect(state.marks?.unsent).toEqual({ Mail: ev('', 1).ts });
    expect(state.marks?.lastAct).toMatchObject({ id: 'act-1', proof: 'unconfirmed' });
    const sent = fold([ev('screen:step', 30, { id: 'act-2', processName: 'Mail', verb: 'press', ok: true, proof: 'confirmed' })], state).state;
    expect(sent.marks?.unsent).toEqual({});
    expect(sent.marks?.lastAct?.proof).toBe('unconfirmed');
  });
});
