import { describe, expect, it, vi } from 'vitest';
import type { KernelState } from '../types.js';
import { learned, ownSteps, readRoutes, routeApps, routesOf, stepsOf, type StepRow } from './routes.js';

// Made-up apps and goals.
const state = {
  window: { active: { processName: 'Code' } },
  marks: { lastLook: { id: 'l', app: 'Mail', n: 9, at: '2026-11-15T09:00:00.000Z' } },
  apps: { used: { Code: { n: 40, last: '2026-11-15T09:00:00.000Z' }, Spotify: { n: 12, last: '2026-11-15T08:00:00.000Z' }, Notes: { n: 3, last: '2026-11-14T08:00:00.000Z' } } },
} as unknown as KernelState;

const route = (app: string): StepRow[] => [{ verb: 'press', role: 'button', screenText: ['New Note'], goal: `a note in ${app}`, session: 's', ok: true, changed: true, at: '2026-11-15T08:00:00.000Z' }];

describe('routeApps', () => {
  it('names the apps the message names, whatever their case, then the front app; never the app of the last look', () => {
    expect(routeApps(state, 'queue a song on spotify and add it to Notes')).toEqual(['Spotify', 'Notes', 'Code']);
    expect(routeApps(state, 'and in Obsidian')).toEqual(['Obsidian', 'Code']);
    expect(routeApps(null, '')).toEqual([]);
  });
});

describe('readRoutes', () => {
  it('prints what worked before for at most three apps, and skips an app with nothing learned', async () => {
    const steps = vi.fn(async (app: string) => (app === 'Notes' ? [] : route(app)));
    const out = await readRoutes({ state, text: 'Spotify, Notes, Slack and Figma', steps });
    expect(out.map((r) => r.app)).toEqual(['Spotify', 'Slack', 'Figma']);
    expect(out[0]!.text).toContain('Worked here before in Spotify');
    expect(out[0]!.text).toMatch(/\n- r\d{5}: a note in spotify \(nothing typed\), worked once: do its steps yourself, by id after 2 runs: press "New Note"$/);
    expect(steps).not.toHaveBeenCalledWith('Code'); // three found before the front app
  });

  it('puts the routes whose goal shares the message\'s words first: newer routes of other tasks never push it out (run 183 T19)', async () => {
    const one = (goal: string, label: string, at: string): StepRow => ({ verb: 'press', role: 'button', screenText: [label], goal, session: `s-${label}`, ok: true, changed: true, at });
    const rows = [one('start a new message to mira@example.org with the subject Kestrel', 'New message', '2026-11-15T08:00:00.000Z'), ...['Save', 'Start order', 'Later', 'Gift wrap', 'Submit'].map((l, i) => one(`${l.toLowerCase()} on the desk`, l, `2026-11-15T08:0${i + 1}:00.000Z`))]
    const steps = async () => rows;
    const text = 'In Zen: start a new message to mira@example.org with the subject Juniper, then discard it.';
    const first = (await readRoutes({ state, text, steps }))[0]!.text;
    expect(first.split('\n')[1]).toMatch(/^- r\d{5}: start a new message \(nothing typed\), worked once: do its steps yourself, by id after 2 runs: press "New message"$/);
    // Set 5 2A: the name stops before the run's own values (runs 211 to 230: the model copied them).
    expect(first).not.toMatch(/mira|kestrel/i);
    // With no words to match, the newest five, as before.
    expect(learned(rows, 'Zen')).not.toContain('start a new message');
  });

  it("gives the rig's own chat the rig's routes, as screen_act replays them, and never the owner's chat (runs 179-182 T19)", async () => {
    const rig = (app: string): StepRow[] => route(app).map((s) => ({ ...s, windowTitle: 'Testbox' }));
    const withRig = { ...state, rigSessions: { 'session-rig': { at: '2026-11-15T08:00:00.000Z' } } } as unknown as KernelState;
    const steps = async (app: string) => rig(app);
    expect((await readRoutes({ state: withRig, text: 'in Zen', steps, sessionId: 'session-rig' })).map((r) => r.app)).toEqual(['Zen', 'Code']);
    expect(await readRoutes({ state: withRig, text: 'in Zen', steps, sessionId: 'session-owner' })).toEqual([]);
  });
});

describe('routesOf', () => {
  it('never takes a field\'s own label for typed words (runs 179-182: "Message" of the goal became "<what was typed>")', () => {
    const goal = 'start a new message to mira@example.org with the subject Skill R1, then discard it';
    const step = (verb: string, label: string, typed?: number): StepRow => ({ verb, role: 'text field', screenText: [label], goal, session: 's', ok: true, changed: true, ...(typed ? { typed } : {}), at: '2026-11-15T08:00:00.000Z' });
    const [r] = routesOf([step('type', 'To', 16), step('focus', 'Message'), step('type', 'Message', 5), { ...step('press', 'Discard'), role: 'button' }]);
    expect(r!.steps.map((s) => s.screenText?.[0])).toEqual(['To', 'Message', 'Message', 'Discard']);
    expect(r!.goal).toBe(goal);
  });

  it('drops a typing the run aimed again at the same field and typed again (run 218 T03: the copy typed the address twice into To)', () => {
    const goal = 'write a mail to [email] with the subject crate run';
    const step = (verb: string, label: string, typed?: number, role = 'text field'): StepRow => ({ verb, role, screenText: [label], goal, session: 's', ok: true, changed: true, ...(typed ? { typed } : {}), at: '2026-11-15T08:00:00.000Z' });
    const [r] = routesOf([step('type', 'To', 16), step('click', 'To'), step('type', 'To', 16), step('click', 'Subject'), step('type', 'Subject', 10), step('press', 'Send', undefined, 'button')]);
    expect(r!.steps.map((s) => `${s.verb} ${s.screenText?.[0]}`)).toEqual(['click To', 'type To', 'click Subject', 'type Subject', 'press Send']);
    // A title, Return and the body, typed into one text area with no click between: both typings stay.
    const [notes] = routesOf([step('press', 'New Note', undefined, 'button'), step('type', 'Body', 5, 'text area'), { ...step('key', ''), key: 'return' }, step('type', 'Body', 9, 'text area')]);
    expect(notes!.steps.map((s) => s.verb)).toEqual(['press', 'type', 'key', 'type']);
    // Runs 222 to 226: one draft done twice in one chat (T14, then T27): the first block's typings are no miss, and the route is the block once.
    const block = [step('click', 'To'), step('type', 'To', 16), step('click', 'Subject'), step('type', 'Subject', 10), step('press', 'Discard', undefined, 'button')];
    const [twice] = routesOf([...block, ...block]);
    expect(twice!.steps.map((s) => `${s.verb} ${s.screenText?.[0]}`)).toEqual(['click To', 'type To', 'click Subject', 'type Subject', 'press Discard']);
  });
});

describe('ownSteps', () => {
  it("leaves out every session that ran a step on a rig test page, so the rig's routes never reach the owner's chat", () => {
    const rows: StepRow[] = [
      { verb: 'press', session: 'rig-1', windowTitle: 'Inbox' },
      { verb: 'press', session: 'rig-1', windowTitle: 'Testbox - Zen' },
      { verb: 'press', session: 'rig-2', windowTitle: 'Rig fixture: the form' },
      { verb: 'press', windowTitle: 'Rig fixture: no session' },
      { verb: 'press', session: 'owner', windowTitle: 'Inbox' },
    ];
    expect(ownSteps(rows)).toEqual([{ verb: 'press', session: 'owner', windowTitle: 'Inbox' }]);
  });
});

describe('stepsOf', () => {
  it('asks the log for the newest 200 steps of the app in the last 30 days, and every drop of it from any day; nothing for a hidden app', async () => {
    const getSignalsInRange = vi.fn(async (_from: string, _to: string, _limit?: number, types?: string[]) =>
      types?.[0] === 'screen:route-dropped' ? [{ data: { app: 'Notes', routeKey: 'make a note' }, capturedAt: '2026-11-01T08:00:00.000Z' }] : [{ data: { verb: 'press' }, capturedAt: '2026-11-15T08:00:00.000Z' }],
    );
    const queries = { countSignalsInRange: vi.fn(async () => 250), getSignalsInRange };
    const now = Date.parse('2026-11-15T10:00:00.000Z');
    expect(await stepsOf(queries, 'Notes', now)).toEqual([{ verb: 'press', at: '2026-11-15T08:00:00.000Z' }, { dropped: 'make a note', at: '2026-11-01T08:00:00.000Z' }]);
    expect(getSignalsInRange).toHaveBeenCalledWith('2026-10-16T10:00:00.000Z', '2026-11-15T10:00:05.000Z', 200, ['screen:step'], 50, '"processname":"notes"');
    expect(getSignalsInRange).toHaveBeenCalledWith('1970-01-01T00:00:00.000Z', '2026-11-15T10:00:05.000Z', 500, ['screen:route-dropped'], 0, '"app":"notes"');
    expect(await stepsOf(queries, '[private]', now)).toEqual([]);
  });
});

describe('a dropped route', () => {
  const run = (session: string, goal: string, at: string): StepRow[] => [
    { verb: 'press', role: 'button', screenText: [goal === 'pin a note' ? 'Pin' : 'New Note'], goal, session, ok: true, changed: true, at },
  ];
  const rows = [...run('s1', 'make a note', '2026-11-10T08:00:00.000Z'), ...run('s2', 'make a note', '2026-11-12T08:00:00.000Z'), ...run('s3', 'pin a note', '2026-11-11T08:00:00.000Z')];

  it('carries its key and how many runs proved it', () => {
    expect(routesOf(rows).map((r) => [r.key, r.n])).toEqual([['make a note', 2], ['pin a note', 1]]);
  });

  it('is never offered again, not even after it worked once more, in the routes, the brief or screen_act', () => {
    const dropped = [...rows, { dropped: 'make a note', at: '2026-11-13T08:00:00.000Z' }, ...run('s4', 'make a note', '2026-11-14T08:00:00.000Z')];
    expect(routesOf(dropped).map((r) => r.key)).toEqual(['pin a note']);
    expect(learned(dropped, 'Notes')).not.toContain('make a note');
  });
});
