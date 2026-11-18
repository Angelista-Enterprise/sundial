import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ALLOWED, APP_COMMANDS, APP_EVENTS, lookForLog, sendAppCommand, watchAppEvents } from './app-channel.js';

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-app-channel-'));
const AT = '2026-11-11T15:00:00.000Z';

describe('the app channel (plan 15, 2.2)', () => {
  it('writes one command per line, with an id and a UTC time', () => {
    const dir = folder();
    sendAppCommand({ type: 'speak', text: 'Mira Bakker is waiting.' }, dir, new Date(AT));
    sendAppCommand({ type: 'marks', marks: [] }, dir, new Date(AT));
    const lines = fs.readFileSync(path.join(dir, APP_COMMANDS), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toMatchObject([{ type: 'speak', text: 'Mira Bakker is waiting.', at: AT }, { type: 'marks', marks: [], at: AT }]);
    expect(lines[0].id).not.toBe(lines[1].id);
    // An act keeps its id: the tool waits for the app's answer by it (it was overwritten, and every act timed out).
    sendAppCommand({ type: 'act', id: 'act-1' }, dir, new Date(AT));
    sendAppCommand({ type: 'look', id: 'look-1' }, dir, new Date(AT));
    const [speak, , act, look] = fs.readFileSync(path.join(dir, APP_COMMANDS), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(act.id).toBe('act-1');
    // A look and an act carry the private list, lowercase: the app refuses such an app before it reads it.
    expect(speak).not.toHaveProperty('private');
    for (const command of [act, look]) {
      expect(command.private).toContain('1password');
      expect(command.private.every((name: string) => name === name.toLowerCase())).toBe(true);
      // Item 4 (2026-11-17): the names a private app goes by in other languages ride along as "=name", matched whole by the app.
      expect(command.private).toEqual(expect.arrayContaining(['=notities', '=herinneringen', "=trousseaux d'accès"]));
    }
  });

  it('cuts both files at boot, folds an allowed event once, and drops the rest', () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, APP_COMMANDS), '{"type":"speak","text":"old"}\n');
    fs.writeFileSync(path.join(dir, APP_EVENTS), `{"type":"voice:go","at":"${AT}"}\n`);
    const seen: unknown[] = [];
    const watch = watchAppEvents((type, payload, ts) => seen.push({ type, payload, ts }), dir);
    expect(fs.readFileSync(path.join(dir, APP_COMMANDS), 'utf8')).toBe('');
    watch.poll();
    expect(seen).toEqual([]);

    const append = (line: string) => fs.appendFileSync(path.join(dir, APP_EVENTS), line);
    append(`{"id":"a1","type":"voice:declined","at":"${AT}","noticeKey":"pr:box-484"}\n`);
    append(`{"type":"approval:answered","at":"${AT}"}\n{"type":"overlay:summoned"}\nnot json\n`);
    append(`{"type":"screen:mark-placed","at":"2026-11-11T16:00:00+01:00","id":`);
    watch.poll();
    append(`"m1"}\n`);
    watch.poll();
    watch.poll();
    watch.stop();
    expect(seen).toEqual([
      { type: 'voice:declined', payload: { id: 'a1', noticeKey: 'pr:box-484' }, ts: AT },
      // The mark's own id reaches the fold: the tool that drew it waits on it (it was dropped, and every mark and act timed out).
      { type: 'screen:mark-placed', payload: { id: 'm1' }, ts: AT },
    ]);
    expect(watch.dropped()).toBe(3);
  });

  it('takes a look of 80 KB whole, also when a read ends inside a line or inside a character (doc 16)', () => {
    const dir = folder();
    const seen: { type: string; payload: Record<string, unknown> }[] = [];
    const watch = watchAppEvents((type, payload) => seen.push({ type, payload }), dir);
    const elements = Array.from({ length: 600 }, (_, i) => ({ ref: `e${i}`, role: 'AXButton', label: `Café ${i} ${'x'.repeat(90)}`, value: '', frame: [i, 0, 10, 10], actions: ['AXPress'], settable: false, enabled: true, in: 'toolbar' }));
    const bytes = Buffer.from(`${JSON.stringify({ type: 'screen:looked', at: AT, id: 'look-1', app: 'Notes', bundleId: 'com.apple.Notes', window: 'Lunch Thursday', menus: ['File'], elements })}\n`);
    expect(bytes.length).toBeGreaterThan(80_000);
    const cut = bytes.indexOf(0xc3, 40_000) + 1;
    fs.appendFileSync(path.join(dir, APP_EVENTS), bytes.subarray(0, cut));
    watch.poll();
    expect(seen).toEqual([]);
    fs.appendFileSync(path.join(dir, APP_EVENTS), bytes.subarray(cut));
    watch.poll();
    watch.stop();
    expect(watch.dropped()).toBe(0);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0].payload)).not.toContain('\ufffd');
    // The log's names: the redaction pass knows the app as processName and screen words as screenText.
    expect(seen[0].payload).toMatchObject({ id: 'look-1', processName: 'Notes', windowTitle: 'Lunch Thursday', screenText: ['File'] });
    expect(seen[0].payload).toMatchObject({ bundleId: 'com.apple.Notes', n: 600 });
    // What the app read does not stay on disk outside the log.
    expect(fs.readFileSync(path.join(dir, APP_EVENTS), 'utf8')).toBe('');
    expect((seen[0].payload.elements as unknown[])[599]).toMatchObject({ ref: 'e599', screenText: [`Café 599 ${'x'.repeat(90)}`, '', 'toolbar'] });
  });

  it('a refused look, and an element with no value, keep their shape', () => {
    expect(lookForLog({ id: 'look-2', refused: 'secure input' })).toEqual({ id: 'look-2', refused: 'secure input' });
    expect(lookForLog({ id: 'look-3', app: 'Notes', elements: [{ ref: 't1', role: 'text', label: 'BOX-484', in: 'ocr' }] })).toEqual({ id: 'look-3', processName: 'Notes', windowTitle: '', n: 1, elements: [{ ref: 't1', role: 'text', actions: [], screenText: ['BOX-484', '', 'ocr'] }] });
  });

  it('S5R1: the window\'s default button keeps its ref alone: its words are its part\'s, under the name the redaction pass knows', () => {
    const look = lookForLog({ id: 'look-7', app: 'Notes', defaultButton: { ref: 'e3', label: 'Delete BOX-484' }, elements: [{ ref: 'e3', role: 'AXButton', label: 'Delete BOX-484', actions: ['AXPress'], default: true }] });
    expect(look.defaultButton).toEqual({ ref: 'e3' });
    expect(look.elements).toEqual([{ ref: 'e3', role: 'AXButton', actions: ['AXPress'], default: true, screenText: ['Delete BOX-484', '', ''] }]);
    expect(lookForLog({ id: 'look-8', app: 'Notes', defaultButton: 'e3' })).not.toHaveProperty('defaultButton');
  });

  it('a look keeps what says or does something and the system\'s own action names; the app\'s word for a private app is the fold\'s', () => {
    const thing = (ref: string, more = {}) => ({ ref, role: 'AXGroup', label: '', value: '', in: '', actions: [], ...more });
    const look = lookForLog({ id: 'look-4', app: 'Notes', focused: 'e3', elements: [thing('e1'), thing('e2', { actions: ['AXPress', 'Reply to Mira Bakker'] }), thing('e3'), thing('e4', { settable: true })] });
    expect(look.n).toBe(4);
    expect((look.elements as { ref: string; actions: string[] }[]).map((e) => [e.ref, e.actions])).toEqual([['e2', ['AXPress']], ['e3', []], ['e4', []]]);
    expect(lookForLog({ id: 'look-5', after: 'act-1', refused: 'private-app' })).toEqual({ id: 'look-5', after: 'act-1', refused: 'private app' });
    // The other windows' titles go under the name the redaction pass knows for a title.
    expect(lookForLog({ id: 'look-6', app: 'Notes', windows: [{ title: 'BOX-484', main: true }, { title: 7, minimized: true }] }).windows).toEqual([{ windowTitle: 'BOX-484', main: true, minimized: false }, { windowTitle: '', main: false, minimized: true }]);
  });

  it('an act\'s answer names its app and window as the redaction pass knows them, and the file is cut only when it is read to its end', () => {
    const dir = folder();
    const seen: Record<string, unknown>[] = [];
    const watch = watchAppEvents((_type, payload) => seen.push(payload), dir);
    const file = path.join(dir, APP_EVENTS);
    fs.appendFileSync(file, `${JSON.stringify({ type: 'screen:acted', at: AT, id: 'act-1', outcome: 'refused', reason: 'private-app', target: { app: 'Mail', window: 'Inbox', role: 'button', label: 'Send' } })}\n{"type":"screen:mark-placed",`);
    watch.poll();
    expect(seen).toEqual([{ id: 'act-1', outcome: 'refused', reason: 'private app', target: { processName: 'Mail', windowTitle: 'Inbox', role: 'button', label: 'Send' } }]);
    expect(fs.statSync(file).size).toBeGreaterThan(0);
    fs.appendFileSync(file, `"at":"${AT}","id":"m1"}\n`);
    watch.poll();
    expect(fs.statSync(file).size).toBe(0);
    fs.appendFileSync(file, `{"type":"screen:mark-cleared","at":"${AT}","id":"m1"}\n`);
    watch.poll();
    watch.stop();
    expect(seen.slice(1)).toEqual([{ id: 'm1' }, { id: 'm1' }]);
  });

  it('lets in every event the app emits (plan 15 review: screen:acted and guide:ended were dropped)', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/macos');
    const swift = fs.readdirSync(dir).filter((f) => f.endsWith('.swift')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const names = [...new Set([...swift.matchAll(/\bemit\("([a-z]+:[a-z-]+)"/g)].map((m) => m[1]))];
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => !ALLOWED.test(n))).toEqual([]);
    expect(swift).not.toMatch(/line\["id"\] = UUID/);
  });
});
