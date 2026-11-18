// Set 5 R2 (plan 21, 2E): what Gnomon opened and is still open. Made-up values only.
import { describe, expect, it } from 'vitest';
import { leftModal, leftOpen, openedLine } from '@sundial/kernel/read/opened.js';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { renderBrief, turnBrief } from '@sundial/kernel/turn-brief.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { OPENED_CHATS, OPENED_ITEMS, openedTrack } from './opened-track.js';
import { taskBoundary } from './task-boundary.js';

const T0 = Date.parse('2026-11-16T09:00:00.000Z');
let n = 0;
const ev = (type: string, sec: number, payload: Record<string, unknown>): SanitizedEvent =>
  ({ id: `${type}-${++n}`, type, ts: new Date(T0 + sec * 1000).toISOString(), payload }) as unknown as SanitizedEvent;
const fold = (events: SanitizedEvent[], state: KernelState = createInitialState('d')) =>
  events.reduce((s, e) => openedTrack(taskBoundary(s, e).state, e).state, state);
const step = (sec: number, id: string, p: Record<string, unknown>) => ev('screen:step', sec, { id, session: 'chat', processName: 'TextEdit', ok: true, ...p });
const look = (sec: number, id: string, p: Record<string, unknown>) => ev('screen:looked', sec, { id, processName: 'TextEdit', windowTitle: 'notes.txt', ...p });
const begun = (session = 'chat', sec = 0) => ev('task:started', sec, { sessionId: session, text: 'save notes as Kestrel' });
const items = (s: KernelState, chat = 'chat') => s.opened?.chats[chat]?.items ?? [];

describe('openedTrack: folded open, and closed when the log shows it', () => {
  it('cmd+s whose after-look shows a sheet is a Save sheet; a look with none closes it', () => {
    const open = fold([begun(), look(1, 'l1', {}), look(2, 'l2', { after: 'a1', dialog: true }), step(3, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: 'notes.txt' })]);
    expect(items(open)).toEqual([{ kind: 'sheet', app: 'TextEdit', label: 'Save sheet', window: 'notes.txt', at: new Date(T0 + 3000).toISOString(), step: 'a1', task: open.task!.id }]);
    const closed = fold([look(4, 'l3', { after: 'a2', dialog: false })], open);
    expect(closed.opened?.chats).toEqual({});
  });

  it('a cmd+s whose after-look shows no sheet saved in place: nothing opened', () => {
    const s = fold([begun(), look(1, 'l1', {}), look(2, 'l2', { after: 'a1' }), step(3, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'] })]);
    expect(items(s)).toEqual([]);
  });

  it('a press whose after-look shows a sheet the look before did not is a sheet, with no pattern', () => {
    const s = fold([begun(), look(1, 'l1', {}), look(2, 'l2', { after: 'a1', dialog: true }), step(3, 'a1', { verb: 'press', role: 'button', screenText: ['Export'] })]);
    expect(items(s).map((i) => i.label)).toEqual(['sheet after "Export"']);
  });

  it('a sheet already in front before the step is not this step\'s', () => {
    const s = fold([begun(), look(1, 'l1', { dialog: true }), look(2, 'l2', { after: 'a1', dialog: true }), step(3, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'] })]);
    expect(items(s)).toEqual([]);
  });

  it('a web address and cmd+t are tabs, cmd+n and File > New a window, an ellipsis item a sheet; a refused step opens nothing', () => {
    const s = fold([
      begun(),
      ev('screen:step', 1, { id: 'u1', session: 'chat', processName: 'Zen', verb: 'open', screenText: ['example.org/testbox'], ok: true, then: { windowTitle: 'Testbox' } }),
      step(2, 'n1', { verb: 'key', key: 'cmd+n', screenText: ['cmd+n'], then: { windowTitle: 'Untitled' } }),
      step(3, 'm1', { verb: 'pick-menu', screenText: ['File > Save As…'] }),
      step(4, 'm2', { verb: 'pick-menu', screenText: ['File > Export…'], ok: false, reason: 'not-found' }),
      step(5, 'k1', { verb: 'key', key: 'escape', screenText: ['escape'] }),
    ]);
    expect(items(s).map((i) => [i.kind, i.label, i.name])).toEqual([
      ['tab', 'Testbox tab', 'Testbox'],
      ['window', '"Untitled" window', 'Untitled'],
      ['sheet', 'Save As sheet', undefined],
    ]);
  });

  it('a look whose window list lacks the window closes it; cmd+w in its window closes it; a quit closes every item of the app', () => {
    const opened = fold([begun(), step(1, 'n1', { verb: 'key', key: 'cmd+n', screenText: ['cmd+n'], then: { windowTitle: 'Untitled' } })]);
    expect(items(fold([look(2, 'l1', { windows: [{ windowTitle: 'Untitled' }, { windowTitle: 'notes.txt' }] })], opened))).toHaveLength(1);
    expect(items(fold([look(2, 'l1', { windows: [{ windowTitle: 'notes.txt' }] })], opened))).toEqual([]);
    expect(items(fold([step(2, 'w1', { verb: 'key', key: 'cmd+w', screenText: ['cmd+w'], windowTitle: 'notes.txt' })], opened)), 'another window closed').toHaveLength(1);
    expect(items(fold([step(2, 'w1', { verb: 'key', key: 'cmd+w', screenText: ['cmd+w'], windowTitle: 'Untitled' })], opened))).toEqual([]);
    const quit = fold([step(2, 'q1', { session: 'other', verb: 'pick-menu', screenText: ['TextEdit > Quit TextEdit'], quit: true })], opened);
    expect(quit.opened?.chats).toEqual({});
    expect(quit.opened?.fronts.TextEdit).toBeUndefined();
  });

  it('a refused look says nothing; a private app\'s step is not kept', () => {
    const opened = fold([begun(), step(1, 'n1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: 'notes.txt' })]);
    expect(fold([look(2, 'l1', { refused: 'no-such-window' })], opened)).toBe(opened);
    expect(fold([step(1, 'p1', { processName: '[private]', verb: 'key', key: 'cmd+n', screenText: ['cmd+n'] })]).opened).toBeUndefined();
  });
});

describe('openedTrack: bounded, per chat, the rig evicted first', () => {
  it('keeps the newest OPENED_ITEMS of a chat', () => {
    const steps = Array.from({ length: OPENED_ITEMS + 2 }, (_, i) => step(i + 1, `n${i}`, { verb: 'key', key: 'cmd+n', screenText: ['cmd+n'], then: { windowTitle: `Untitled ${i}` } }));
    const s = fold([begun(), ...steps]);
    expect(items(s)).toHaveLength(OPENED_ITEMS);
    expect(items(s)[0]!.name).toBe('Untitled 2');
  });

  it('past OPENED_CHATS, the oldest rig chat goes before the owner\'s oldest; with no rig chat left, the oldest owner chat', () => {
    const rigs = Array.from({ length: OPENED_CHATS }, (_, i) => `rig-${i}`);
    const base = { ...createInitialState('d'), rigSessions: Object.fromEntries(rigs.map((r) => [r, 'rig'])) } as KernelState;
    const opens = (session: string, sec: number) => step(sec, `s-${session}`, { session, verb: 'key', key: 'cmd+n', screenText: ['cmd+n'] });
    const s = fold([opens('owner', 1), ...rigs.map((r, i) => opens(r, i + 2))], base);
    expect(Object.keys(s.opened!.chats)).toHaveLength(OPENED_CHATS);
    expect(s.opened!.chats.owner, 'the owner\'s chat outlives a rig flood').toBeDefined();
    expect(s.opened!.chats['rig-0']).toBeUndefined();
    const owners = Array.from({ length: OPENED_CHATS + 1 }, (_, i) => opens(`owner-${i}`, i + 1));
    expect(Object.keys(fold(owners).opened!.chats)).toEqual(owners.slice(1).map((e) => (e.payload as { session: string }).session));
  });
});

describe('what the brief and screen_act read', () => {
  const now = T0 + 60_000;
  it('the brief says what this chat opened and is still open, this task\'s first, after the task block', () => {
    const s = fold([
      begun(),
      ev('screen:step', 1, { id: 'u1', session: 'chat', processName: 'Zen', verb: 'open', screenText: ['example.org/testbox'], ok: true, then: { windowTitle: 'Testbox' } }),
      look(2, 'l1', {}),
      look(3, 'l2', { after: 'a1', dialog: true }),
      step(4, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: 'notes.txt' }),
    ]);
    expect(openedLine(s, 'chat')).toBe('Still open from this task: Testbox tab in Zen; Save sheet in TextEdit.');
    expect(openedLine(s, 'other')).toBeNull();
    const brief = turnBrief(s, null, { sessionId: 'chat' }, now);
    expect(brief.facts.find((f) => f.key === 'task.opened')?.value).toEqual({ items: [{ kind: 'tab', app: 'Zen', label: 'Testbox tab' }, { kind: 'sheet', app: 'TextEdit', label: 'Save sheet' }] });
    const text = renderBrief(brief);
    expect(text).toContain('\nStill open from this task: Testbox tab in Zen; Save sheet in TextEdit.\n');
    expect(text).not.toMatch(/Right now:.*Still open/);
    // The next request: the same items are an earlier task's.
    expect(openedLine(fold([begun('chat', 5)], s), 'chat')).toBe('Still open from an earlier task in this chat: Testbox tab in Zen; Save sheet in TextEdit.');
  });

  it('a sheet in front that this task did not open is said before a key; not once this chat was shown that look, nor for its own sheet', () => {
    const left = fold([look(1, 'l1', { dialog: true })]);
    const started = fold([begun('chat', 2)], left);
    expect(leftModal(started, 'chat', 'textedit', now)).toBe('TextEdit has a sheet or dialog in front of "notes.txt", and this task did not open it: a key sent now goes into it. screen_look TextEdit first, then close it (key escape, or its Cancel) or finish it.');
    expect(leftModal(started, 'chat', 'Notes', now), 'another app').toBeNull();
    expect(leftModal(started, 'chat', 'TextEdit', T0 + 3 * 3_600_000), 'a stale look').toBeNull();
    const shown = { ...started, marks: { ...started.marks!, chats: { chat: { look: { id: 'l1', app: 'TextEdit', at: new Date(T0).toISOString(), act: null } } } } };
    expect(leftModal(shown, 'chat', 'TextEdit', now)).toBeNull();
    // This task's own Save sheet goes through; the same sheet in the next task is an earlier task's.
    const own = fold([begun(), look(1, 'l1', {}), look(2, 'l2', { after: 'a1', dialog: true }), step(3, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: 'notes.txt' })]);
    expect(leftModal(own, 'chat', 'TextEdit', now)).toBeNull();
    expect(leftModal(fold([begun('chat', 4)], own), 'chat', 'TextEdit', now)).toMatch(/^TextEdit has a sheet or dialog in front of "notes\.txt", and you opened it in an earlier task \(Save sheet\)/);
    expect(leftModal(fold([look(4, 'l3', {})], own), 'chat', 'TextEdit', now), 'closed since').toBeNull();
  });
});

describe('review S5R2 M3: a sheet shown to this chat stays shown for every act after it', () => {
  const now = T0 + 60_000;
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  const printed = (s: KernelState, id: string, sec: number) => ({ ...s, marks: { ...s.marks!, chats: { chat: { look: { id, app: 'TextEdit', at: at(sec), act: null } } } } });

  it('a look printed since the sheet showed passes every later act, whose after-look (unkept, no step row) replaced the newest', () => {
    const shown = printed(fold([begun(), look(1, 'l1', { dialog: true })]), 'l1', 2);
    expect(leftModal(shown, 'chat', 'TextEdit', now)).toBeNull();
    const acted = fold([look(3, 'l2', { after: 'u1', dialog: true }), look(4, 'l3', { after: 'u2', dialog: true })], shown);
    expect(acted.opened?.fronts.TextEdit).toMatchObject({ look: 'l3', since: at(1) });
    expect(leftModal(acted, 'chat', 'TextEdit', now)).toBeNull();
  });

  it('a leftover sheet is still refused before the first key: a print from before it showed, or from before the task, is no sighting', () => {
    const before = printed(fold([begun(), look(1, 'l0', {}), look(3, 'l1', { dialog: true })]), 'l0', 2);
    expect(leftModal(before, 'chat', 'TextEdit', now)).toMatch(/this task did not open it/);
    const earlier = printed(fold([look(1, 'l1', { dialog: true }), look(3, 'l2', { after: 'u1', dialog: true }), begun('chat', 4)]), 'l1', 2);
    expect(leftModal(earlier, 'chat', 'TextEdit', now)).toMatch(/this task did not open it/);
    // The sheet closed and a new one came: shown no more.
    const again = fold([look(5, 'l4', {}), look(6, 'l5', { dialog: true })], printed(fold([begun(), look(1, 'l1', { dialog: true })]), 'l1', 2));
    expect(again.opened?.fronts.TextEdit?.since).toBe(at(6));
    expect(leftModal(again, 'chat', 'TextEdit', now)).toMatch(/this task did not open it/);
  });

  it('an after-look of this chat\'s own step that showed the sheet is a sighting in this task; another chat\'s is not', () => {
    const own = fold([begun(), look(1, 'l1', { dialog: true }), look(2, 'l2', { after: 'r1', dialog: true }), step(3, 'r1', { verb: 'raise', screenText: ['notes.txt'] })]);
    expect(own.opened?.fronts.TextEdit?.seen).toEqual([{ chat: 'chat', task: own.task!.id }]);
    expect(leftModal(own, 'chat', 'TextEdit', now)).toBeNull();
    expect(leftModal(fold([look(4, 'l3', { after: 'u1', dialog: true })], own), 'chat', 'TextEdit', now), 'an unkept act since').toBeNull();
    expect(leftModal(own, 'other', 'TextEdit', now)).toMatch(/this task did not open it/);
    expect(leftModal(fold([begun('chat', 4)], own), 'chat', 'TextEdit', now), 'the next task').toMatch(/this task did not open it/);
  });

  it('a chat with no task that opened the sheet itself goes on', () => {
    const own = fold([look(1, 'l1', {}), look(2, 'l2', { after: 'a1', dialog: true }), step(3, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: 'notes.txt' })]);
    expect(own.task ?? null).toBeNull();
    expect(leftModal(fold([look(4, 'l3', { after: 'u1', dialog: true })], own), 'chat', 'TextEdit', now)).toBeNull();
  });
});

describe('review S5R2 L1: an opened window keeps its item when its title gains the Edited tail', () => {
  it('"Untitled" listed as "Untitled \u2014 Edited" is still open; cmd+w in "Untitled - Edited" closes it', () => {
    const opened = fold([begun(), step(1, 'n1', { verb: 'key', key: 'cmd+n', screenText: ['cmd+n'], then: { windowTitle: 'Untitled' } })]);
    const edited = fold([look(2, 'l1', { windowTitle: 'Untitled \u2014 Edited', windows: [{ windowTitle: 'Untitled \u2014 Edited' }, { windowTitle: 'notes.txt' }] })], opened);
    expect(items(edited).map((i) => i.name)).toEqual(['Untitled']);
    expect(items(fold([step(3, 'w1', { verb: 'key', key: 'cmd+w', screenText: ['cmd+w'], windowTitle: 'Untitled - Edited' })], edited))).toEqual([]);
  });
});

describe('S5R2 (owner, 2026-11-17): a sheet someone else left open is named, never touched', () => {
  const now = T0 + 60_000;
  const LEFT = 'Left open by someone else';
  // The window sensor: TextEdit came up with a Save sheet, then the owner went to Mail and it stayed behind.
  const win = (sec: number, p: Record<string, unknown>, previousWindow: Record<string, unknown> | null = null) =>
    ev('window:changed', sec, { windowId: `w-${sec}`, documentPath: null, reason: 'focus', previousWindow, ...p });
  const left = [win(1, { processName: 'TextEdit', windowTitle: 'notes.txt', sheet: true }), win(2, { processName: 'Mail', windowTitle: 'Inbox' }, { processName: 'TextEdit', windowTitle: 'notes.txt', windowId: 'w-1', sheet: true })];
  const brief = (s: KernelState, text = 'send Mira Bakker a mail that the draft is in') => renderBrief(turnBrief(s, null, { sessionId: 'chat', text }, now));
  const count = (text: string) => text.split(LEFT).length - 1;

  it('a sheet the sensor saw left in another app is named once in the brief, after the task block', () => {
    const s = fold([...left, begun('chat', 3)]);
    expect(leftOpen(s, 'chat', now)).toEqual([{ app: 'TextEdit', window: 'notes.txt' }]);
    const text = brief(s);
    expect(count(text)).toBe(1);
    expect(text).toContain('\nLeft open by someone else: TextEdit has a sheet or dialog in front of "notes.txt". Do not touch it; when you answer after a task, say it is still open and that you left it alone.\n');
    expect(text).not.toMatch(/Right now:.*Left open/);
  });

  it('a leftover Gnomon\'s own look found in an app the task touched is named too; one it later saw closed is not', () => {
    const s = fold([begun(), look(1, 'l1', { dialog: true })]);
    expect(leftOpen(s, 'chat', now)).toEqual([{ app: 'TextEdit', window: 'notes.txt' }]);
    expect(leftOpen(fold([win(2, { processName: 'TextEdit', windowTitle: 'notes.txt' })], s), 'chat', now), 'the sensor saw it gone since').toEqual([]);
    expect(leftOpen(fold([win(2, { processName: 'TextEdit', windowTitle: 'notes.txt' }), look(3, 'l2', { dialog: true })], s), 'chat', now), 'and a newer look again').toHaveLength(1);
  });

  it('the sensor seeing the app again with no sheet clears it; a stale sighting is not said', () => {
    expect(leftOpen(fold([...left, win(3, { processName: 'TextEdit', windowTitle: 'notes.txt' }, { processName: 'Mail', windowTitle: 'Inbox' })]), 'chat', now)).toEqual([]);
    expect(leftOpen(fold(left), 'chat', T0 + 3 * 3_600_000)).toEqual([]);
  });

  it('a sheet this chat opened is "Still open from this task", not left open by someone else', () => {
    const s = fold([begun(), look(1, 'l1', {}), look(2, 'l2', { after: 'a1', dialog: true }), step(3, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: 'notes.txt' }), win(4, { processName: 'Mail', windowTitle: 'Inbox' }, { processName: 'TextEdit', windowTitle: 'notes.txt', sheet: true })]);
    expect(leftOpen(s, 'chat', now)).toEqual([]);
    const text = brief(s);
    expect(text).toContain('Still open from this task: Save sheet in TextEdit.');
    expect(count(text)).toBe(0);
    expect(leftOpen(s, 'other', now), 'another chat did not open it').toEqual([{ app: 'TextEdit', window: 'notes.txt' }]);
  });

  it('runs 252, 253: a sheet this chat opened with no window on record hides no other window\'s sheet', () => {
    const own = fold([begun(), step(1, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: '' })]);
    expect(items(own).map((i) => [i.label, i.window])).toEqual([['Save sheet', undefined]]);
    const s = fold([win(2, { processName: 'TextEdit', windowTitle: 'draft.txt', sheet: true }), win(3, { processName: 'Mail', windowTitle: 'Inbox' }, { processName: 'TextEdit', windowTitle: 'draft.txt', sheet: true })], own);
    expect(leftOpen(s, 'chat', now)).toEqual([{ app: 'TextEdit', window: 'draft.txt' }]);
  });

  it('runs 252, 253: a sheet in front of a look with no title sits on the main window; a cmd+s whose after-look was replaced takes the newest look\'s', () => {
    const windows = [{ windowTitle: 'Untitled (notes copy)', main: true }, { windowTitle: '', main: false }, { windowTitle: 'draft.txt', main: false }];
    const sheetLook = (sec: number, id: string, p: Record<string, unknown> = {}) => look(sec, id, { windowTitle: '', dialog: true, windows, ...p });
    const s = fold([begun(), look(1, 'l1', { windowTitle: 'Untitled (notes copy)' }), sheetLook(2, 'l2', { after: 'a1' }), step(3, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: 'Untitled (notes copy)' })]);
    expect(s.opened?.fronts.TextEdit?.window).toBe('Untitled (notes copy)');
    expect(items(s).map((i) => [i.label, i.window])).toEqual([['Save sheet', 'Untitled (notes copy)']]);
    // Run 252 12:53:38: the step's after-look and then a plain look landed before its row, and the step's own window was blank.
    const late = fold([begun(), look(1, 'l1', { windowTitle: 'Untitled (notes copy)' }), sheetLook(2, 'l2', { after: 'a1' }), sheetLook(3, 'l3'), step(4, 'a1', { verb: 'key', key: 'cmd+s', screenText: ['cmd+s'], windowTitle: '' })]);
    expect(items(late).map((i) => [i.label, i.window])).toEqual([['Save sheet', 'Untitled (notes copy)']]);
  });

  it('a private app gives no mention, and its earlier sighting goes', () => {
    const priv = fold([win(1, { processName: 'Vaultkeeper', windowTitle: '[private]', sheet: true }), win(2, { processName: 'Mail', windowTitle: 'Inbox' }, { processName: 'Vaultkeeper', windowTitle: '[private]', sheet: true }), begun('chat', 3)]);
    expect(priv.opened?.sensed ?? {}).toEqual({});
    expect(count(brief(priv))).toBe(0);
    const was = fold([win(1, { processName: 'Vaultkeeper', windowTitle: 'notes', sheet: true })]);
    expect(fold([win(2, { processName: 'Vaultkeeper', windowTitle: '[private]' })], was).opened?.sensed).toEqual({});
    expect(fold([win(1, { processName: '[hidden]', windowTitle: '[hidden]', sheet: true })]).opened).toBeUndefined();
  });

  it('no sheet gives nothing: the fold writes nothing and the brief says nothing', () => {
    const s = fold([win(1, { processName: 'TextEdit', windowTitle: 'notes.txt' }), win(2, { processName: 'Mail', windowTitle: 'Inbox' }, { processName: 'TextEdit', windowTitle: 'notes.txt' }), begun('chat', 3)]);
    expect(s.opened).toBeUndefined();
    expect(count(brief(s))).toBe(0);
    expect(count(brief(fold([...left, begun('chat', 3)]), 'thanks!')), 'small talk').toBe(0);
  });
});
