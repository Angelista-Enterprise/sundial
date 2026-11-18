import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { appNotesFor, appNotesText } from '@sundial/helpers/app-notes.js';
import { APPS_KEPT, NOTE_AFTER, appLearn, appNotes, workspaceOf } from './app-learn.js';
import { taskBoundary } from './task-boundary.js';

const focus = (processName: string, windowTitle: string, ts = '2026-11-13T09:00:00.000Z'): SanitizedEvent =>
  ({ id: `e-${processName}-${windowTitle}-${ts}`, type: 'window:changed', ts, payload: { processName, windowTitle } }) as unknown as SanitizedEvent;
const fold = (events: SanitizedEvent[], state: KernelState = createInitialState('test-device')) => events.reduce((s, e) => appLearn(s, e).state, state);

describe('appLearn (the owner, counted)', () => {
  it('reads a workspace only from a title that names the app last', () => {
    expect(workspaceOf('Obsidian', 'REPORT - puzzlebox - Obsidian 1.15.0')).toBe('puzzlebox');
    expect(workspaceOf('Obsidian', 'Obsidian')).toBeNull();
    expect(workspaceOf('Zen', 'a - b - c')).toBeNull();
    expect(workspaceOf('Zen', 'Sundial - Wikipedia')).toBeNull();
    expect(workspaceOf('Obsidian', `x - ${'v'.repeat(61)} - Obsidian 1.15`)).toBeNull();
  });

  it('counts how often each app came to the front, and the workspaces it named', () => {
    const state = fold([
      focus('Obsidian', 'REPORT - puzzlebox - Obsidian 1.15.0'),
      focus('Obsidian', 'NOTES - puzzlebox - Obsidian 1.15.0'),
      focus('Obsidian', 'PLAN - sketches - Obsidian 1.15.0'),
      focus('Zen', 'Sundial - Wikipedia'),
    ]);
    expect(state.apps.used).toEqual({ Obsidian: { n: 3, last: '2026-11-13T09:00:00.000Z' }, Zen: { n: 1, last: '2026-11-13T09:00:00.000Z' } });
    expect(state.apps.workspaces).toEqual({ Obsidian: { puzzlebox: 2, sketches: 1 } });
  });

  it('stays bounded, keeps the ones used last, and ignores an event with no app', () => {
    const day = (i: number) => `2026-10-${String(1 + i).padStart(2, '0')}T09:00:00.000Z`;
    // One app a day. The oldest ones fall off, however heavily they were used back then.
    const heavyThenGone = Array.from({ length: 40 }, () => focus('OldBrowser', 'x', day(0)));
    const state = fold([...heavyThenGone, ...Array.from({ length: APPS_KEPT }, (_, i) => focus(`App${i}`, 'x', day(i + 1))), focus('', 'x', day(26))]);
    expect(Object.keys(state.apps.used)).toHaveLength(APPS_KEPT);
    expect(state.apps.used.OldBrowser).toBeUndefined();
    expect(state.apps.used[`App${APPS_KEPT - 1}`]).toEqual({ n: 1, last: day(APPS_KEPT) });
  });
});

describe("appNotes (Set 5 R2: what an app does to Gnomon's own steps)", () => {
  let i = 0;
  const at = () => `2026-11-15T09:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
  const ev = (type: string, payload: Record<string, unknown>): SanitizedEvent => { i++; return { id: `e${i}`, type, ts: at(), payload } as unknown as SanitizedEvent; };
  const start = (session: string) => ev('task:started', { sessionId: session, text: 'a made-up task' });
  const step = (session: string, verb: string, role: string, more: Record<string, unknown> = {}) =>
    ev('screen:step', { processName: 'Notes', verb, role, screenText: ['Kind'], windowTitle: 'Groceries', session, ok: true, ...more });
  const fail = (session: string, verb = 'set-value', role = 'popup', reason = 'not-found', more: Record<string, unknown> = {}) => step(session, verb, role, { ok: false, reason, ...more });
  const run = (events: SanitizedEvent[], state: KernelState = createInitialState('test-device')) =>
    events.reduce((s, e) => appNotes(taskBoundary(s, e).state, e).state, state);
  /** One task in `session`: the pop-up refused, then pressed. */
  const task = (session: string) => [start(session), fail(session), step(session, 'press', 'pop up button')];
  const NOTE = 'set-value popup is refused here (not-found); press pop up button worked after it';

  it('folds a note at the third task with the same failure and the same fix, never twice in one task', () => {
    const two = run([...task('chat-a'), fail('chat-a'), step('chat-a', 'press', 'pop up button'), ...task('chat-b')]);
    expect(two.appNotes?.owner.notes).toEqual([]);
    const three = run(task('chat-c'), two);
    expect(three.appNotes?.owner.notes).toEqual([{ app: 'Notes', note: NOTE, n: NOTE_AFTER, lastAt: expect.any(String) }]);
    expect(appNotesText(three, 'notes', 'chat-a')).toBe(`What this app did to your own steps before (n = tasks it was seen in):\n- ${NOTE} (n 3)`);
    // The name the step acted on (an old task's value) is never in a note.
    expect(JSON.stringify(three.appNotes)).not.toContain('Kind');
  });

  it('Set 5 R3: the owner keeps a note (off the card, still in use) or drops it (out of every brief, never mined again)', () => {
    const three = run([...task('chat-a'), ...task('chat-b'), ...task('chat-c')]);
    const key = `Notes\n${NOTE}`;
    const kept = run([ev('proposal:answered', { kind: 'app-note', key, verdict: 'accepted' })], three);
    expect(kept.appNotes?.answered).toEqual({ [key]: 'kept' });
    expect(appNotesFor(kept, 'Notes')).toHaveLength(1);
    const dropped = run([ev('proposal:answered', { kind: 'app-note', key, verdict: 'dismissed' })], three);
    expect(dropped.appNotes?.owner.notes).toEqual([]);
    expect(appNotesFor(run(task('chat-d'), dropped), 'Notes'), 'a fourth task does not bring it back').toEqual([]);
    expect(run(task('chat-d'), dropped).appNotes?.owner.notes).toEqual([]);
  });

  it('learns nothing from a retry of the same move, a reason about Gnomon or the owner, or a fix in another task', () => {
    const s = run([1, 2, 3].flatMap((k) => [
      start(`r${k}`), fail(`r${k}`), step(`r${k}`, 'set-value', 'popup'),
      fail(`r${k}`, 'press', 'button', 'look again'), step(`r${k}`, 'click', 'button'),
      fail(`r${k}`, 'press', 'button', 'covered'), start(`r${k}`), step(`r${k}`, 'open', ''),
    ]));
    expect(s.appNotes?.owner.notes).toEqual([]);
    expect(s.appNotes?.owner.tally).toEqual({});
  });

  it('a failure followed by a different move each time has no fix: no note until one move is most of them', () => {
    const other = (session: string, verb: string) => [start(session), fail(session), step(session, verb, 'menu item')];
    const s = run([...task('a'), ...task('b'), ...task('c'), ...other('d', 'click'), ...other('e', 'pick-menu'), ...other('f', 'focus')]);
    expect(s.appNotes?.owner.notes).toEqual([]);
    expect(run([...task('g'), ...task('h')], s).appNotes?.owner.notes.map((n) => n.n)).toEqual([5]);
  });

  it("keeps the rig's notes apart: a rig chat or a rig window never writes the owner's, nor sees them", () => {
    const rigChat = { ...createInitialState('test-device'), rigSessions: { 'rig-1': 'x', 'rig-2': 'x', 'rig-3': 'x' } };
    const s = run([...task('rig-1'), ...task('rig-2'), ...task('rig-3')], rigChat);
    expect(s.appNotes?.owner.notes).toEqual([]);
    expect(s.appNotes?.rig.notes).toHaveLength(1);
    expect(appNotesFor(s, 'Notes', 'rig-1')).toHaveLength(1);
    expect(appNotesFor(s, 'Notes', 'owner-chat')).toEqual([]);
    const window = run([1, 2, 3].flatMap((k) => [start(`w${k}`), fail(`w${k}`), step(`w${k}`, 'press', 'pop up button', { windowTitle: 'Rig fixture: Order form' })]));
    expect([window.appNotes?.owner.notes.length, window.appNotes?.rig.notes.length]).toEqual([0, 1]);
  });

  it('stays bounded: three notes an app, twelve in all, eight open failures, 48 patterns', () => {
    const many = Array.from({ length: 30 }, (_, k) => k).flatMap((k) => [1, 2, 3].flatMap((t) => [
      start(`c${k}-${t}`),
      fail(`c${k}-${t}`, 'press', `role${k}`, 'not-found', { processName: `App${k % 5}` }),
      step(`c${k}-${t}`, 'click', `role${k}`, { processName: `App${k % 5}` }),
    ]));
    const s = run([...many, ...Array.from({ length: 20 }, (_, k) => fail(`d${k}`))]);
    const notes = s.appNotes!.owner.notes;
    expect(notes).toHaveLength(12);
    expect(Math.max(...[0, 1, 2, 3, 4].map((a) => notes.filter((n) => n.app === `App${a}`).length))).toBe(3);
    expect(Object.keys(s.appNotes!.open)).toHaveLength(8);
    expect(Object.keys(s.appNotes!.owner.tally).length).toBeLessThanOrEqual(48);
  });
  it('review S5R2 L4: a bench with many failing apps never pushes out the owner\'s waiting failure', () => {
    const rigChat = { ...createInitialState('test-device'), rigSessions: Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`rig-${k}`, 'x'])) };
    const s = run([start('owner'), fail('owner'), ...Array.from({ length: 20 }, (_, k) => fail(`rig-${k}`, 'press', 'button', 'not-found', { processName: `App${k}` }))], rigChat);
    const open = Object.entries(s.appNotes!.open);
    expect(open.filter(([, o]) => o.rig === true)).toHaveLength(8);
    expect(open.filter(([k]) => k === 'owner\nNotes')).toHaveLength(1);
    // And the owner's fix still teaches.
    expect(run([step('owner', 'press', 'pop up button')], s).appNotes!.owner.tally).not.toEqual({});
  });

  it('review S5R2 L5: a failed key step keeps the key name only, never other text it carried', () => {
    const typed = run([start('k'), fail('k', 'key', '', 'not-found', { key: 'Mira Bakker 4821' })]);
    expect(JSON.stringify(typed.appNotes)).not.toContain('Mira');
    expect(Object.values(typed.appNotes!.open)[0]?.failed).toBe('key');
    const named = run([start('n'), fail('n', 'key', '', 'not-found', { key: 'cmd+shift+s' })]);
    expect(Object.values(named.appNotes!.open)[0]?.failed).toBe('key cmd+shift+s');
  });
});
