import { describe, expect, it } from 'vitest';
import { sanitizeAtIngest } from '@sundial/helpers/sanitize-at-ingest.js';
import { routeIdOfKey } from '@sundial/helpers/screen-routes.js';
import { composeAmbientContext, type AmbientInput } from './ambient-context.js';
import { RECOVERY_RULE, REPLY_RULES, STANCE_LINE, briefParts, presentLine, renderBrief, shownPayload, stanceOf, taskLines, turnBrief } from './turn-brief.js';
import type { KernelState } from './types.js';

const NOW = Date.parse('2026-09-03T14:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

/** Every clause the present line can say, at once. Made-up values. */
const full = () =>
  ({
    config: { timezone: 'Europe/Amsterdam' },
    window: { active: { processName: 'Code', windowTitle: 'x', windowId: '1' } },
    moment: { id: 'm', startTime: ago(42), processName: 'Code', projectId: '~/Projects/acme/puzzlebox-studio', rollup: { gitBranch: 'develop', gitCommitCount: 2 }, intent: { status: 'done', text: 'fixing the onboarding merge' } },
    lifeEvent: { flow: { processName: 'Code', startedAt: ago(18) }, idle: { isIdle: false }, recentSwitches: [{ at: ago(5) }, { at: ago(30) }] },
    notices: { deferred: [{}], recentPhasic: [] },
    routines: { trail: ['Slack/work', 'Code/work', 'Warp/work'], learned: { r: { steps: ['Code/work', 'Warp/work', 'Google Chrome/work'], support: 40, firstSeenAt: ago(9000), lastSeenAt: ago(60) } } },
    coverage: { place: 'the studio', placeSince: ago(120), activity: 'stationary', activitySince: ago(10) },
    av: { call: { app: 'Zoom', kind: 'work-call', since: ago(12) } },
    shell: { streak: { count: 4, command: 'pnpm test --filter puzzlebox', exitCode: 1, lastAt: ago(3) } },
    agent: { fleet: [{ id: 'a', cwd: '~/Projects/sundial', state: 'working', since: ago(1) }, { id: 'b', cwd: '~/Projects/acme/puzzlebox-studio', state: 'permission', since: ago(7), title: 'Fix BOX-484' }] },
    git: { unpushed: { '~/Projects/acme/puzzlebox-studio': { branch: 'develop', ahead: 263, since: ago(90), updatedAt: ago(1) } } },
    screen: { refs: ['BOX-484'] },
    files: { hot: { a: { relPath: 'src/board.ts', changes: 5 } } },
    pressure: { byApp: { Slack: { count: 7, since: ago(200) } } },
    predictions: { calibration: {} },
  }) as unknown as KernelState;

const memory: AmbientInput = {
  now: new Date(NOW).toISOString(),
  ownerFacts: [{ predicate: 'worksAt', object: 'puzzlebox-studio', provenance: 'assertion', validFrom: ago(9000) }],
  goals: [],
  today: { sessions: 4, minutes: 180, mostRecentProcess: 'Code' },
  commitments: [],
  wakeups: [],
  ownerAsk: null,
  researchGoal: null,
  recentKnowledge: [],
  assistant: null,
};

describe('turnBrief', () => {
  // Pinned from the old `nowLine` on this fixture (it matched clause for clause until nowLine was deleted), apart from the routine precision.
  it('says what nowLine said, clause for clause, apart from the routine precision', () => {
    const brief = turnBrief(full(), null, { sessionId: 's' }, NOW);
    const seen = new Date(ago(90)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(presentLine(brief)).toBe(
      `Right now: the owner is in Code on puzzlebox-studio, 42 min into this stretch; doing: fixing the onboarding merge; branch develop, 2 commits so far; in sustained focus for 18 min; from here they usually open Google Chrome next (seen 40 times; a tendency: such forecasts held 12% (prior, not measured yet)); 2 app switches in the last hour; 1 observation held back for a better moment; the phone puts them at the studio, stationary; on a work call in Zoom for 12 min; 4 commands in a row have failed, last \`pnpm test --filter puzzlebox\` (exit 1); 2 coding sessions open, 1 working; waiting on the owner: 'Fix BOX-484' in puzzlebox-studio 7 min (an approval); 263 commits not pushed yet (Sundial first saw them unpushed at ${seen}; a push clears this within a minute); on screen: BOX-484; src/board.ts has been touched 5 times today; Slack badge at 7 for 3h.`,
    );
    expect(brief.facts.map((f) => f.key)).toContain('git.unpushed');
    expect(brief.facts.find((f) => f.key === 'git.unpushed')?.value).toMatchObject({ total: 263, repos: [{ cwd: '~/Projects/acme/puzzlebox-studio', ahead: 263 }] });
    expect(presentLine(turnBrief({} as KernelState, null, { sessionId: 's' }, NOW))).toBe('Nothing is being observed right now.');
  });

  it('gives the routine its measured reliability with n (W5 step 6: formatParam)', () => {
    const s = full();
    s.calibrated = { params: { 'routine.next': { n: 312, hits: 84, sum: 84, updatedAt: null } } } as unknown as KernelState['calibrated'];
    expect(presentLine(turnBrief(s, null, { sessionId: 's' }, NOW))).toContain('(seen 40 times; a tendency: such forecasts held about 26% (measured, n = 312))');
    s.calibrated.params['routine.next'] = { n: 12, hits: 1, sum: 1, updatedAt: null };
    expect(presentLine(turnBrief(s, null, { sessionId: 's' }, NOW))).toContain('(measured, n = 12, too small to trust)');
  });

  it('renders what stands (the apps and routes, memory, sections), then the hints, the clock, the day so far, the present, and the reply rules last', () => {
    const brief = turnBrief(full(), memory, { sessionId: 's', place: 'Today', text: 'tell me when puzzlebox-studio is pushed', answering: 'Which client is BOX-484 for?' }, NOW);
    const lines = renderBrief(brief, ['The board is looking at today.']).split('\n');
    const [head, facts, today] = composeAmbientContext(memory).split('\n\n');
    expect(renderBrief({ ...brief, facts: [], routes: [] }).startsWith(`${head}\n\n${facts}\n`)).toBe(true);
    // Runs 218 and 220 T27: an app's routes, behind 26k characters of memory and board cards, were not followed. They lead.
    const routed = { ...brief, routes: [{ app: 'Zen', text: 'Worked here before in Zen (...):\n- discard a draft: screen_act {}' }] };
    const text = renderBrief(routed, ['The board is looking at today.']);
    expect(text.indexOf('Learned in Zen')).toBeGreaterThan(-1);
    expect(text.indexOf('Learned in Zen')).toBeLessThan(text.indexOf(head!));
    expect(lines.indexOf('The board is looking at today.')).toBeGreaterThan(lines.indexOf(facts!.split('\n').at(-1)!));
    expect(lines.indexOf(brief.clock)).toBeGreaterThan(lines.indexOf('The board is looking at today.'));
    expect(lines.indexOf(today!)).toBe(lines.indexOf(brief.clock) + 1);
    expect(lines.indexOf(presentLine(brief))).toBe(lines.indexOf(today!) + 1);
    expect(lines.at(-1)).toBe(REPLY_RULES);
    expect(lines).toContain('The owner is looking at: Today.');
    expect(lines).toContain(presentLine(brief));
    expect(lines.some((l) => l.startsWith('The owner is asking to be told when'))).toBe(true);
    expect(lines.some((l) => l.includes('"Which client is BOX-484 for?"'))).toBe(true);
    // clock, present, the screen line, the moment (they are on a call), the stance, the rules
    expect(renderBrief(turnBrief(full(), null, { sessionId: 's', text: 'what am I doing?' }, NOW)).split('\n')).toHaveLength(6);
    // A work job replies to no one: the clock and the present, no reply lines.
    expect(renderBrief(turnBrief(full(), null, { sessionId: 'gnomon-work', cause: { kind: 'work' } }, NOW)).split('\n')).toHaveLength(2);
  });

  it('keeps everything before the changing facts byte-identical across turns with another time, app and look (Set 2 Round 2 item 3)', () => {
    const at = (now: number, app: string, look: string) =>
      ({ ...full(), window: { active: { processName: app, windowTitle: 'x', windowId: '1' } }, moment: { ...full().moment, processName: app }, marks: { lastLook: { id: look, app, n: 12, at: new Date(now - 60_000).toISOString() } } }) as unknown as KernelState;
    const asked = (now: number, minutes: number): AmbientInput => ({ ...memory, now: new Date(now).toISOString(), today: { sessions: 4, minutes, mostRecentProcess: 'Code' }, ownerAsk: { question: 'Which client is BOX-484 for?', askId: 'a1' } as AmbientInput['ownerAsk'] });
    const sections = ['The board is looking at today.'];
    const one = turnBrief(at(NOW, 'Code', 'look-1'), asked(NOW, 180), { sessionId: 's', text: 'plan my afternoon around BOX-484' }, NOW);
    const later = NOW + 7 * 60_000;
    const two = turnBrief(at(later, 'Notes', 'look-2'), asked(later, 187), { sessionId: 's', text: 'plan my afternoon around BOX-484' }, later);
    const [a, b] = [renderBrief(one, sections), renderBrief(two, sections)];
    expect(one.clock).not.toBe(two.clock);
    // The standing part ends where the clock starts; up to there the two briefs are the same bytes.
    const cut = (text: string, brief: typeof one) => text.slice(0, text.indexOf(brief.clock));
    expect(cut(a, one)).toBe(cut(b, two));
    expect(cut(a, one)).toContain('What you know about the owner');
    expect(cut(a, one)).toContain('The board is looking at today.');
    // Every changing fact is after it: the clock, the day so far, the open ask, the front app, the last look.
    for (const fact of ['Today so far', 'You are waiting on the owner', 'the owner is in Notes', 'you last looked at Notes']) {
      expect(b.indexOf(fact)).toBeGreaterThan(b.indexOf(two.clock));
      expect(cut(b, two)).not.toContain(fact);
    }
    // A changing block is never remembered as given, so it can never be held back as "unchanged".
    expect(briefParts(two, sections).some((part) => /^(Today so far|You are waiting on the owner|Right now it is)/.test(part))).toBe(false);
    // Given the standing parts, the next turn's brief is the changing part alone.
    const next = renderBrief(two, sections, new Set(briefParts(one, sections)));
    expect(next.startsWith(two.clock)).toBe(true);
  });

  it('picks a stance from the words (lab/chat word rules)', () => {
    expect(stanceOf('Hey gnomon')).toBe('light');
    expect(stanceOf('not now')).toBe('light');
    expect(stanceOf("what's up?")).toBe('quick');
    expect(stanceOf('cool lets continue')).toBe('task');
    expect(stanceOf('hmm')).toBe('light');
    expect(stanceOf("long day. i'm wiped")).toBe('feeling');
    expect(stanceOf('did I push puzzlebox-studio?')).toBe('quick');
    expect(stanceOf('plan my afternoon around BOX-484')).toBe('task');
    expect(stanceOf('yes', 'Want me to draft it?')).toBe('task');
    expect(stanceOf('yes', 'Done — pushed.')).toBe('light');
  });

  it('sizes small talk down, says the moment and where the chat is, and only for the owner', () => {
    const s = full();
    (s as unknown as { conversation: unknown }).conversation = { sessions: { s: { lastAt: ago(90), shown: null, cause: null, turns: [{ at: ago(95), by: 'owner', turnId: 't1', text: 'did I push puzzlebox-studio?' }, { at: ago(94), by: 'gnomon', turnId: 't1', text: 'No — 263 commits on develop.' }] } }, said: [] };
    const asked: AmbientInput = { ...memory, ownerAsk: { question: 'Which client is BOX-484 for?', askId: 'a1' } as AmbientInput['ownerAsk'] };
    const hey = turnBrief(s, asked, { sessionId: 's', text: 'hey' }, NOW);
    const text = renderBrief(hey);
    expect(hey.hints.stance).toBe('light');
    expect(text).not.toContain('What you know about the owner');
    expect(text).toContain('You are waiting on the owner');
    expect(text).toContain('Where the conversation is (the last message in this chat was 2 hours ago');
    expect(text).toContain('they last said "did I push puzzlebox-studio?"');
    expect(text).toContain('They are on a call');
    expect(text.split('\n').at(-2)).toBe(STANCE_LINE.light);
    const task = renderBrief(turnBrief(s, asked, { sessionId: 's', text: 'plan my afternoon around BOX-484' }, NOW));
    expect(task).toContain('What you know about the owner');
    const notice = turnBrief(s, asked, { sessionId: 's', cause: { kind: 'notice', noticeKey: 'k' } }, NOW);
    expect(notice.hints.stance).toBeNull();
    expect(notice.hints.moment).toBeNull();
  });

  it('logs under 4 KB, survives sanitize-at-ingest unchanged, and never uses a key the classifier blanks', () => {
    const payload = shownPayload(turnBrief(full(), memory, { sessionId: 'session-7f', cause: { kind: 'owner' }, place: 'Today' }, NOW), 'brief-1');
    expect(JSON.stringify(payload).length).toBeLessThan(4096);
    expect(sanitizeAtIngest({ id: 'e', type: 'chat:shown', ts: new Date(NOW).toISOString(), payload } as never).payload).toEqual(payload);
    expect(JSON.stringify(payload)).not.toMatch(/"(processName|bundleId|path)":/);
    expect(payload).not.toHaveProperty('memory');
  });

  it('says the last look while it is fresh, the owner\'s apps as a part of its own, and the routes once while they hold (Round 2, item 4)', () => {
    const s = {
      ...full(),
      marks: { lastLook: { id: 'look-1', app: 'Notes', window: 'BOX-484 notes', n: 41, at: ago(3) } },
      apps: { used: { Code: { n: 412, last: ago(1) }, Slack: { n: 233, last: ago(5) }, Notes: { n: 61, last: ago(3) }, Mail: { n: 9, last: ago(60 * 24 * 30) } }, workspaces: { Obsidian: { 'puzzlebox-vault': 31 } } },
    } as unknown as KernelState;
    const routes = [
      { app: 'Notes', text: 'Worked here before in Notes (...):\n- new note: screen_act {"app":"Notes","steps":[{"action":"press","role":"button","label":"New Note"}]}' },
      { app: 'Mail', text: 'Worked here before in Mail (...):\n- new mail: screen_act {"app":"Mail","steps":[{"action":"press","label":"New Message"}]}' },
    ];
    const brief = turnBrief(s, null, { sessionId: 's', text: 'add this to my Notes' }, NOW, routes);
    expect(brief.v).toBe(6);
    expect(presentLine(brief)).toContain('you last looked at Notes, window "BOX-484 notes", 3 min ago (41 things)');
    expect(presentLine(brief)).not.toContain('The apps the owner works in');
    const text = renderBrief(brief);
    expect(text).toContain('The apps the owner works in, most used first: Code (412), Slack (233), Notes (61). An app that is not in this list');
    expect(text).not.toContain('Mail (9)'); // a month untouched: not where they work
    expect(text).toContain('Workspaces their own windows name (a vault, a profile): Obsidian: puzzlebox-vault (seen 31).');
    expect(text).toContain('Learned in Notes, from your own past steps:\nWorked here before in Notes');
    // Told once while unchanged, like a section, one part per app: a new route in Mail re-sends Mail's part only.
    const given = new Set(briefParts(brief));
    const again = renderBrief(brief, [], given);
    expect(again).not.toContain('Learned in');
    expect(again).not.toContain('The apps the owner works in');
    expect(again).toContain('you last looked at Notes');
    const grown = turnBrief(s, null, { sessionId: 's', text: 'add this to my Notes' }, NOW, [routes[0]!, { app: 'Mail', text: `${routes[1]!.text}\n- reply: screen_act {}` }]);
    const resent = renderBrief(grown, [], given);
    expect(resent).toContain('Learned in Mail');
    expect(resent).not.toContain('Learned in Notes');
    // The log gets the app names of the routes, never their text.
    const payload = shownPayload(brief, 'b1');
    expect(payload.routes).toEqual(['Notes', 'Mail']);
    expect(JSON.stringify(payload)).not.toContain('screen_act');
    expect(sanitizeAtIngest({ id: 'e', type: 'chat:shown', ts: new Date(NOW).toISOString(), payload } as never).payload).toEqual(payload);
    // A look an hour old is not where Gnomon is working.
    const old = { ...s, marks: { lastLook: { id: 'look-0', app: 'Notes', n: 3, at: ago(90) } } } as unknown as KernelState;
    expect(turnBrief(old, null, { sessionId: 's' }, NOW).facts.map((f) => f.key)).not.toContain('screen.lastLook');
    expect(turnBrief(full(), null, { sessionId: 's' }, NOW).routes).toEqual([]);
  });

  it('a summon says the guess, the last boundary and the selected text, and logs only that text was there (plan 15 step 2)', () => {
    const s = { ...full(), lifeEvent: { ...full().lifeEvent, failedTests: { k: { command: 'pnpm test --filter puzzlebox', failedAt: ago(3) } } }, overlay: { open: { summonId: 's1', at: ago(0), evidence: ['red'], guess: 'red', firstMove: null }, tally: {} }, boundary: { last: { kind: 'commit', at: ago(12) } } } as unknown as KernelState;
    const brief = turnBrief(s, null, { sessionId: 's', cause: { kind: 'summon' }, text: 'why does this fail?', place: 'Code', selected: 'expect(board).toBe(3)' }, NOW);
    expect(brief.hints.summon).toEqual({ line: '`pnpm test --filter puzzlebox` failed 3 min ago.', boundary: { kind: 'commit', min: 12 }, selected: true });
    const text = renderBrief(brief);
    expect(text).toContain('What they may have come for (a guess, not a fact): `pnpm test --filter puzzlebox` failed 3 min ago.');
    expect(text).toContain('Their last task boundary: commit, 12 min ago.');
    expect(text).toContain('expect(board).toBe(3)');
    expect(JSON.stringify(shownPayload(brief, 'b1'))).not.toContain('toBe(3)');
    expect(turnBrief(s, null, { sessionId: 's', text: 'hi', selected: 'expect(board).toBe(3)' }, NOW)).not.toHaveProperty('selected');
  });

  it('names the kept skills in one line with the routes, the rig\'s only in the rig\'s chat and only those there (Set 2 R3)', () => {
    const id = (key: string) => routeIdOfKey('Notes', key);
    const line = `Skills the owner kept, each run by its id in one call, a text for each place from this task (gnomon_skill {"name": "<its id>", "values": {...}}): ${id('press button "New Note"')} "new note" in Notes.`;
    expect(renderBrief(turnBrief(full(), null, { sessionId: 's' }, NOW))).not.toContain('gnomon_skill');
    const s = { ...full(), rigSessions: { 'rig-run': ago(5) }, selfReview: { skills: { 'new note': { app: 'Notes', routeKey: 'press button "New Note"', at: ago(60) }, 'rig chore': { app: 'Notes', routeKey: 'press button "Delete"', at: ago(60), rig: true } } } } as unknown as KernelState;
    const own = turnBrief(s, null, { sessionId: 's', text: 'run new note' }, NOW);
    expect(own.skills).toEqual([`${id('press button "New Note"')} "new note" in Notes`]);
    expect(renderBrief(own)).toContain(line);
    expect(briefParts(own)).toContain(line);
    expect(turnBrief(s, null, { sessionId: 'rig-run', text: 'run rig chore' }, NOW).skills).toEqual([`${id('press button "Delete"')} "rig chore" in Notes`]);
  });

  it('Set 5 R1: a kept skill whose name is an old run\'s goal is printed by its id and the words before any value', () => {
    const skills = { 'start a new message to [email] with the subject kestrel 214, then': { app: 'Zen', routeKey: 'type text field "To"', at: ago(60) }, '[email] 214': { app: 'Zen', routeKey: 'press button "Send"', at: ago(60) } };
    const brief = turnBrief({ ...full(), selfReview: { skills } } as unknown as KernelState, null, { sessionId: 's', text: 'mail Mira' }, NOW);
    expect(brief.skills).toEqual([`${routeIdOfKey('Zen', 'type text field "To"')} "start a new message" in Zen`, `${routeIdOfKey('Zen', 'press button "Send"')} in Zen`]);
    expect(renderBrief(brief)).not.toMatch(/kestrel|214|\[email\]/);
  });

  it('carries the notes the owner kept from a self-review: the turn\'s apps and Gnomon\'s own, no other app (Set 3 R4)', () => {
    const notes = [{ app: 'Notes', line: 'New Note sits under the File menu.', at: ago(60) }, { app: 'Gnomon', line: 'Say sent only after the send act ran.', at: ago(30) }, { app: 'Mail', line: 'The draft list scrolls.', at: ago(10) }];
    const s = { ...full(), selfReview: { notes } } as unknown as KernelState;
    const brief = turnBrief(s, null, { sessionId: 's', text: 'new note' }, NOW, [{ app: 'Notes', text: 'press button "New Note"' }]);
    expect(brief.notes).toEqual([{ app: 'Notes', line: 'New Note sits under the File menu.' }, { app: 'Gnomon', line: 'Say sent only after the send act ran.' }]);
    expect(briefParts(brief)).toContain('Kept from your own review of Gnomon: Say sent only after the send act ran.');
    expect(renderBrief(brief)).not.toContain('draft list');
  });

  describe('the task object (Set 4 R1)', () => {
    const task = {
      id: 't1', at: ago(2), session: 's', said: 'append the line Kestrel to notes.txt; if it will not save, save a copy beside it',
      known: ['Finder window "Testbox": 3 things on screen'],
      did: ['key "cmd+shift+s" in TextEdit', 'type "notes copy.txt" in TextEdit'],
      failed: ['key "cmd+s" in TextEdit: refused, not-found'],
      open: ['job-a1 running: gnomon_await it'],
    };

    it('prints at most 6 lines: what was asked and each list on one line; the recovery rule is never in this data block (Fable L3)', () => {
      const now = taskLines(task, 'now').split('\n');
      expect(now.length).toBeLessThanOrEqual(6);
      expect(now).toContain('failed, do not repeat (1): key "cmd+s" in TextEdit: refused, not-found');
      expect(now).toContain('did (2): key "cmd+shift+s" in TextEdit | type "notes copy.txt" in TextEdit');
      expect(taskLines(task, 'now')).not.toContain(RECOVERY_RULE);
      expect(taskLines(task, 'last')).not.toContain(RECOVERY_RULE);
      const full12 = { ...task, known: Array.from({ length: 12 }, (_, i) => `k${i}`), did: Array.from({ length: 12 }, (_, i) => `d${i}`), failed: Array.from({ length: 12 }, (_, i) => `f${i}`), open: Array.from({ length: 12 }, (_, i) => `o${i}`), corrected: { at: ago(1), session: 's', text: 'no, Juniper' } };
      expect(taskLines(full12, 'now').split('\n').length).toBeLessThanOrEqual(6);
      expect(taskLines({ ...task, known: [], did: undefined, open: undefined }, 'now').split('\n')).toHaveLength(3);
    });

    it('the brief carries this chat\'s last task, when it holds a step, and never another chat\'s', () => {
      const s = { ...full(), task } as unknown as KernelState;
      const brief = turnBrief(s, null, { sessionId: 's', text: 'and the other one?' }, NOW);
      expect(brief.task?.id).toBe('t1');
      expect(renderBrief(brief)).toContain('The last task in this chat');
      expect(renderBrief(brief)).toContain('failed, do not repeat (1)');
      expect(turnBrief(s, null, { sessionId: 'other', text: 'hi there friend' }, NOW).task).toBeUndefined();
      const empty = { ...full(), task: { id: 't0', at: ago(2), session: 's', said: 'hi' } } as unknown as KernelState;
      expect(turnBrief(empty, null, { sessionId: 's', text: 'and now?' }, NOW).task).toBeUndefined();
    });

    it('Set 5 R1: a newer request in another chat leaves this chat\'s last task in its brief, with how its turn ended', () => {
      const other = { id: 't2', at: ago(1), session: 'side', said: 'what time is it in Lima' };
      const s = { ...full(), task: other, tasks: { s: { ...task, ended: { at: ago(1), outcome: 'partial' } }, side: other } } as unknown as KernelState;
      const brief = turnBrief(s, null, { sessionId: 's', text: 'and the other one?' }, NOW);
      expect(brief.task?.id).toBe('t1');
      expect(renderBrief(brief)).toContain('; its turn ended partial');
      expect(taskLines(brief.task!, 'now')).not.toContain('its turn ended');
    });
  });

  describe('the hand-off and the follow-up (Set 4 R2)', () => {
    const NOW_ISO = new Date(NOW).toISOString();
    const sec = (s: number) => new Date(NOW - s * 1000).toISOString();
    /** A calc task answered 20 s ago in this chat, its Calculator look 30 s old and still in front. Made-up values. */
    const calc = (over: Record<string, unknown> = {}) =>
      ({
        ...full(),
        window: { active: { processName: 'Calculator', windowTitle: 'Calculator', windowId: '7' } },
        marks: { lastLook: { id: 'look-c1', app: 'Calculator', window: 'Calculator', n: 29, at: sec(30) } },
        apps: { used: { Calculator: { n: 40, last: sec(30) }, TextEdit: { n: 30, last: ago(5) }, Zen: { n: 50, last: ago(9) } }, workspaces: {} },
        task: { id: 't7', at: sec(60), session: 's', said: 'what is 17 times 23', known: ['Calculator window "Calculator": 29 things on screen'], did: ['type "17*23=" in Calculator'] },
        conversation: { sessions: { s: { turns: [{ by: 'owner', text: 'what is 17 times 23', at: sec(60) }, { by: 'gnomon', text: '17 × 23 is 391, read off Calculator. Saved to notes.txt and "totals 2026.csv".', at: sec(20) }] } } },
        ...over,
      }) as unknown as KernelState;

    it('the last look says when it is still in front with nothing done since, and the last task\'s known list is keyed for the log', () => {
      const brief = turnBrief(calc(), null, { sessionId: 's', text: 'and divided by 2?' }, NOW);
      const look = brief.facts.find((f) => f.key === 'screen.lastLook');
      expect(look?.value).toMatchObject({ app: 'Calculator', window: 'Calculator', n: 29, front: true });
      expect(look?.says).toContain('you last looked at Calculator, window "Calculator", 1 min ago (29 things), and it is still in front with nothing done in it since');
      expect(brief.facts.find((f) => f.key === 'task.known')?.value).toEqual({ task: 't7', known: ['Calculator window "Calculator": 29 things on screen'] });
      // Printed once: in the task block, not again in the present line.
      expect(presentLine(brief)).not.toContain('known from the last task');
      expect(renderBrief(brief).split('Calculator window "Calculator": 29 things on screen')).toHaveLength(2);
      // An act since, another window in front, or another chat: not in front, and no known list.
      const acted = calc({ marks: { lastLook: { id: 'look-c1', app: 'Calculator', window: 'Calculator', n: 29, at: sec(30) }, lastAct: { id: 'act-1', at: sec(10), outcome: 'performed' } } });
      expect(turnBrief(acted, null, { sessionId: 's', text: 'and divided by 2?' }, NOW).facts.find((f) => f.key === 'screen.lastLook')?.value).not.toHaveProperty('front');
      const moved = calc({ window: { active: { processName: 'TextEdit', windowTitle: 'notes.txt', windowId: '8' } } });
      expect(turnBrief(moved, null, { sessionId: 's', text: 'and divided by 2?' }, NOW).facts.find((f) => f.key === 'screen.lastLook')?.value).not.toHaveProperty('front');
      expect(turnBrief(calc(), null, { sessionId: 'other', text: 'and divided by 2?' }, NOW).facts.map((f) => f.key)).not.toContain('task.known');
    });

    it('a follow-up gets the last answer\'s files, numbers and apps and the last look as its referents, and the rule to answer from them first', () => {
      const brief = turnBrief(calc(), null, { sessionId: 's', text: 'and divided by 2?' }, NOW);
      expect(brief.hints.referents).toEqual({ files: ['notes.txt', 'totals 2026.csv'], numbers: ['17', '23', '391'], apps: ['Calculator'], look: { app: 'Calculator', window: 'Calculator' } });
      expect(renderBrief(brief)).toContain('What "it", "that file", "the other one" or "and divided by 2" can mean: your last answer named file notes.txt, totals 2026.csv; number 17, 23, 391; app Calculator; your last look was Calculator, window "Calculator".');
      expect(REPLY_RULES).toContain('A follow-up with no place of its own ("and divided by 2?", "the other one") goes on from your last answer or look: answer from them before any new look.');
      // Logged with the brief, and unchanged by sanitize-at-ingest.
      const payload = shownPayload(brief, 'b1');
      expect(sanitizeAtIngest({ id: 'e', type: 'chat:shown', ts: NOW_ISO, payload } as never).payload).toEqual(payload);
      // Small talk, a notice, or a chat with no answer yet: none.
      expect(turnBrief(calc(), null, { sessionId: 's', text: 'thanks' }, NOW).hints.referents).toBeUndefined();
      expect(turnBrief(calc(), null, { sessionId: 's', cause: { kind: 'notice', noticeKey: 'k' } }, NOW).hints.referents).toBeUndefined();
      expect(turnBrief(calc(), null, { sessionId: 'other', text: 'and divided by 2?' }, NOW).hints.referents).toBeUndefined();
      // A refused look is never a referent.
      const refused = calc({ marks: { lastLook: { id: 'look-m', app: 'Messages', n: 0, at: sec(30), refused: 'private app' } } });
      expect(turnBrief(refused, null, { sessionId: 's', text: 'and divided by 2?' }, NOW).hints.referents).not.toHaveProperty('look');
    });
  });
});
