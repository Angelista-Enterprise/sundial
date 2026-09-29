import { describe, expect, it } from 'vitest';
import { nowLine, nowSnapshot, projectName } from './now.js';

const NOW = Date.parse('2026-09-03T14:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

const state = (over = {}) => ({
  window: { active: { processName: 'Code', windowTitle: 'x', windowId: '1' } },
  moment: {
    id: 'm', sessionId: 's', startTime: ago(42), processName: 'Code', projectId: '~/Projects/acme/puzzlebox-studio',
    rollup: { gitBranch: 'develop', gitCommitCount: 2 },
    intent: { status: 'done', text: 'fixing the onboarding merge' },
  },
  lifeEvent: { flow: { processName: 'Code', startedAt: ago(18) }, idle: { isIdle: false }, recentSwitches: [{ at: ago(5) }, { at: ago(30) }, { at: ago(90) }] },
  notices: { deferred: [{}, {}], recentPhasic: [{ observation: 'Claude time well above usual', at: ago(200) }] },
  ...over,
});

describe('projectName', () => {
  it('takes the last path segment, tolerating a trailing slash', () => {
    expect(projectName('~/Projects/acme/puzzlebox-studio')).toBe('puzzlebox-studio');
    expect(projectName('/a/b/c/')).toBe('c');
  });
  it('is null on nothing', () => {
    expect(projectName(null)).toBeNull();
    expect(projectName('')).toBeNull();
  });
});

describe('nowSnapshot', () => {
  it('carries the judgement mark, quiet by default (J0.9)', () => {
    expect(nowSnapshot(state(), NOW).judging).toBe('none');
    expect(nowSnapshot(state({ judgement: { degraded: 'local-fallback' } }), NOW).judging).toBe('local-fallback');
    expect(nowSnapshot(state({ judgement: { degraded: 'off' } }), NOW).judging).toBe('off');
  });

  it('reads the present off the state', () => {
    expect(nowSnapshot(state(), NOW)).toEqual({
      at: '2026-09-03T14:00:00.000Z',
      app: 'Code',
      project: 'puzzlebox-studio',
      momentMin: 42,
      intent: 'fixing the onboarding merge',
      branch: 'develop',
      commits: 2,
      flowMin: 18,
      agents: null,
      hearing: { listening: false, reason: null, until: null, title: null, muted: false },
      idle: false,
      switchesLastHour: 2,
      nextStep: null,
      activity: null,
      place: null,
      placeSince: null,
      wokeAt: null,
      // The phone's body readings (sleep, and the owner's own state): none in this state.
      sleep: null,
      self: null,
      call: null,
      failing: null,
      unpushed: null,
      screenRefs: [],
      hotFile: null,
      pressure: [],
      page: null,
      working: null,
      queued: 0,
      workbench: { queue: [], recent: [], today: 0 },
      judging: 'none',
      held: 2,
      // The fixture's one phasic notice is dated today, so it counts.
      noticedToday: 1,
      lastSaidAt: ago(200),
      lastSaid: 'Claude time well above usual',
    });
  });

  // Every field nullable, and null rather than zero: "0 minutes into nothing" is
  // a sentence the record never actually says.
  it('shows the owner-state beliefs only while the judge is reading, and offers a due tap either way', () => {
    const owner = (lastJudgedAt) => ({ focus: { alpha: 3, beta: 1 }, stuck: { alpha: 1, beta: 3 }, selfReports: [], brier: { n: 0 }, perception: { input: [], lastJudgedAt } })
    const utc = { config: { timezone: 'UTC' } }
    const stale = nowSnapshot(state({ ...utc, owner: owner(null) }), NOW).self
    expect(stale).toMatchObject({ pFlow: null, pStuck: null, due: true })
    expect(nowSnapshot(state({ ...utc, owner: owner(ago(1)) }), NOW).self.pFlow).toBeCloseTo(0.75, 6)
  })

  it('is honest about nothing being observed', () => {
    const snap = nowSnapshot({}, NOW);
    expect(snap.app).toBeNull();
    expect(snap.momentMin).toBeNull();
    expect(snap.flowMin).toBeNull();
    expect(snap.switchesLastHour).toBeNull();
    expect(snap.held).toBe(0);
    expect(snap.idle).toBe(false);
  });

  it('withholds an intent that has not been decided yet', () => {
    const s = state();
    s.moment.intent = { status: 'inflight' };
    expect(nowSnapshot(s, NOW).intent).toBeNull();
  });

  it('counts only the switches inside the last hour', () => {
    expect(nowSnapshot(state(), NOW).switchesLastHour).toBe(2);
  });
});

describe('noticedToday', () => {
  it('adds the gate’s tonic count for today to the phasic ones dated today', () => {
    const s = state({ notices: { deferred: [], day: '2026-09-03', spentToday: 2, recentPhasic: [{ observation: 'a', at: ago(30) }, { observation: 'old', at: '2026-09-01T10:00:00.000Z' }] } });
    expect(nowSnapshot(s, NOW).noticedToday).toBe(3);
  });
  it('does not carry yesterday’s tonic count over', () => {
    const s = state({ notices: { deferred: [], day: '2026-09-02', spentToday: 4, recentPhasic: [] } });
    expect(nowSnapshot(s, NOW).noticedToday).toBe(0);
  });
  it('counts by the owner’s day, not the UTC one', () => {
    // 14:00Z is already 2026-09-04 in Auckland (UTC+12): the gate's day and a
    // notice from 13:30Z are both today there, and UTC would call them tomorrow.
    const s = state({ config: { timezone: 'Pacific/Auckland' }, notices: { deferred: [], day: '2026-09-04', spentToday: 2, recentPhasic: [{ observation: 'a', at: ago(30) }] } });
    expect(nowSnapshot(s, NOW).noticedToday).toBe(3);
  });
});

describe('the routine forecast', () => {
  const learned = {
    'Code/work > Warp/work > Google Chrome/work': { steps: ['Code/work', 'Warp/work', 'Google Chrome/work'], support: 40, firstSeenAt: ago(9000), lastSeenAt: ago(60) },
  };
  it('names the next step when the trail matches a learned routine', () => {
    const snap = nowSnapshot(state({ routines: { trail: ['Slack/work', 'Code/work', 'Warp/work'], learned } }), NOW);
    expect(snap.nextStep).toEqual({ process: 'Google Chrome', support: 40 });
    expect(nowLine(snap)).toContain('they usually open Google Chrome next (seen 40 times; a tendency, about 27% reliable)');
  });
  it('is null when nothing is learned, and the line says nothing about it', () => {
    const snap = nowSnapshot(state(), NOW);
    expect(snap.nextStep).toBeNull();
    expect(nowLine(snap)).not.toContain('usually open');
  });
});

describe('nowLine', () => {
  it('leads with what the owner is doing, and stays one sentence', () => {
    const line = nowLine(nowSnapshot(state(), NOW));
    expect(line).toBe(
      'Right now: the owner is in Code on puzzlebox-studio, 42 min into this stretch; doing: fixing the onboarding merge; branch develop, 2 commits so far; in sustained focus for 18 min; 2 app switches in the last hour; 2 observations held back for a better moment.',
    );
  });

  it('leads with idle when the owner is gone — flow and idle pull opposite ways', () => {
    const s = state();
    s.lifeEvent.idle.isIdle = true;
    expect(nowLine(nowSnapshot(s, NOW))).toMatch(/^Right now: the owner is idle;/);
  });

  it('names the agents waiting on the owner, longest first', () => {
    const s = state({
      agent: {
        fleet: [
          { id: 'a', cwd: '~/Projects/sundial', branch: 'main', state: 'working', since: ago(1) },
          { id: 'b', cwd: '~/Projects/acme/puzzlebox-studio', branch: 'x', state: 'waiting', since: ago(7) },
          { id: 'c', cwd: '~/hub', branch: 'main', state: 'tool', since: ago(12) },
          { id: 'e', cwd: '~/Projects/ledger', branch: 'main', state: 'permission', since: ago(9), title: 'Migrate the ledger' },
          { id: 'd', cwd: '~/old', branch: 'main', state: 'waiting', since: ago(300) },
        ],
      },
    });
    expect(nowLine(nowSnapshot(s, NOW))).toContain("5 Claude sessions open, 1 working; waiting on the owner: hub 12 min (tool call, maybe an approval), 'Migrate the ledger' in ledger 9 min (an approval), puzzlebox-studio 7 min")
  });

  it('does not announce a focus span too short to mean anything', () => {
    const s = state();
    s.lifeEvent.flow.startedAt = ago(2);
    expect(nowLine(nowSnapshot(s, NOW))).not.toContain('sustained focus');
  });

  it('says so when nothing is observed', () => {
    expect(nowLine(nowSnapshot({}, NOW))).toBe('Nothing is being observed right now.');
  });
});
