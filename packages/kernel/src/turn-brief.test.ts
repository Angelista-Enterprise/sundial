import { describe, expect, it } from 'vitest';
import { sanitizeAtIngest } from '@sundial/helpers/sanitize-at-ingest.js';
import { composeAmbientContext, type AmbientInput } from './ambient-context.js';
import { REPLY_RULES, presentLine, renderBrief, shownPayload, turnBrief } from './turn-brief.js';
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
      `Right now: the owner is in Code on puzzlebox-studio, 42 min into this stretch; doing: fixing the onboarding merge; branch develop, 2 commits so far; in sustained focus for 18 min; from here they usually open Google Chrome next (seen 40 times; a tendency: such forecasts held 12% (prior, not measured yet)); 2 app switches in the last hour; 1 observation held back for a better moment; the phone puts them at the studio, stationary; on a work call in Zoom for 12 min; 4 commands in a row have failed, last \`pnpm test --filter puzzlebox\` (exit 1); 2 Claude sessions open, 1 working; waiting on the owner: 'Fix BOX-484' in puzzlebox-studio 7 min (an approval); 263 commits not pushed yet (Sundial first saw them unpushed at ${seen}; a push clears this within a minute); on screen: BOX-484; src/board.ts has been touched 5 times today; Slack badge at 7 for 3h.`,
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

  it('renders the clock, the ambient memory as it was, the sections, then the hints, the present, and the reply rules last', () => {
    const brief = turnBrief(full(), memory, { sessionId: 's', place: 'Today', text: 'tell me when puzzlebox-studio is pushed', answering: 'Which client is BOX-484 for?' }, NOW);
    const lines = renderBrief(brief, ['The board is looking at today.']).split('\n');
    expect(lines[0]).toMatch(/^Right now it is .* Today is \d{4}-\d{2}-\d{2}; yesterday was /);
    expect(renderBrief(brief).startsWith(`${brief.clock}\n${composeAmbientContext(memory)}`)).toBe(true);
    expect(lines.indexOf('The board is looking at today.')).toBeGreaterThan(lines.indexOf(composeAmbientContext(memory).split('\n').at(-1)!));
    expect(lines.at(-1)).toBe(REPLY_RULES);
    expect(lines).toContain('The owner is looking at: Today.');
    expect(lines).toContain(presentLine(brief));
    expect(lines.some((l) => l.startsWith('The owner is asking to be told when'))).toBe(true);
    expect(lines.some((l) => l.includes('"Which client is BOX-484 for?"'))).toBe(true);
    expect(renderBrief(turnBrief(full(), null, { sessionId: 's', text: 'what am I doing?' }, NOW)).split('\n')).toHaveLength(4);
    // A work job replies to no one: the clock and the present, no reply lines.
    expect(renderBrief(turnBrief(full(), null, { sessionId: 'gnomon-work', cause: { kind: 'work' } }, NOW)).split('\n')).toHaveLength(2);
  });

  it('logs under 4 KB, survives sanitize-at-ingest unchanged, and never uses a key the classifier blanks', () => {
    const payload = shownPayload(turnBrief(full(), memory, { sessionId: 'session-7f', cause: { kind: 'owner' }, place: 'Today' }, NOW), 'brief-1');
    expect(JSON.stringify(payload).length).toBeLessThan(4096);
    expect(sanitizeAtIngest({ id: 'e', type: 'chat:shown', ts: new Date(NOW).toISOString(), payload } as never).payload).toEqual(payload);
    expect(JSON.stringify(payload)).not.toMatch(/"(processName|bundleId|path)":/);
    expect(payload).not.toHaveProperty('memory');
  });
});
