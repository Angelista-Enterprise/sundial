import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, MomentRollup, SanitizedEvent } from '@sundial/kernel/types.js';
import { momentAnalysisSchedule } from './moment-analysis-schedule.js';

function withMoment(
  state: KernelState,
  windowTitles: string[],
  processName = 'Code',
  startTime = '2026-01-01T00:00:00.000Z',
  rollupOverrides: Partial<MomentRollup> = {},
): KernelState {
  return {
    ...state,
    moment: {
      id: 'm1',
      sessionId: 's1',
      startTime,
      processName,
      projectId: null,
      rollup: {
        processName,
        windowTitles,
        shellCommandCount: 0,
        notableCommands: [],
        gitCommitCount: 0,
        gitBranch: null,
        calendarActive: false,
        typingEventCount: 0, inputEventCount: 0, activeMs: 0,
        lifeEvents: [],
        projectSource: null,
        projectConfidence: null,
        micActive: false,
        cameraActive: false,
        meetingTitle: null,
        meetingAttendees: [],
        screenTopics: [],
        screenExcerpt: null,
        ...rollupOverrides,
      },
      intent: { status: 'none' },
    },
  };
}

function windowEvent(ts = '2026-01-01T00:05:00.000Z', processName = 'Warp'): SanitizedEvent {
  return { id: 'e1', type: 'window:changed', ts, payload: { processName }, sanitized: true };
}

describe('momentAnalysisSchedule', () => {
  it('schedules one merged ScheduleLLM call (purpose=intent) for a closing moment above the min-duration floor', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts', 'reduce.ts']);
    const { effects } = momentAnalysisSchedule(state, windowEvent());

    // J1.2 (option A): the fan-out Judge rides beside the render, same moment, same delay.
    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatchObject({ type: 'Judge', purpose: 'classify', questionSetId: 'moment-fanout', momentId: 'm1', delayMs: 10_000 });
    expect((effects[0] as any).state).toMatchObject({ app: 'Code', window_titles: expect.any(Array) });
    expect((effects[0] as any).state).not.toHaveProperty('life_events');
    expect(effects[1]).toMatchObject({ type: 'ScheduleLLM', purpose: 'intent', momentId: 'm1', delayMs: 10_000 });
    // The render carries the same evidence the judge read (J1.1).
    expect((effects[1] as any).metadata.evidence).toEqual((effects[0] as any).state);
    expect((effects[1] as any).messages).toHaveLength(2);
    expect((effects[1] as any).messages[0].content).toContain('"intent"');
    expect((effects[1] as any).messages[0].content).toContain('"narrative"');
    expect((effects[1] as any).messages[1].content).toContain('index.ts -> reduce.ts');
  });

  it("D5: includes state.memory.priorities in the prompt when non-empty", () => {
    let state = withMoment(createInitialState('d1'), ['index.ts', 'reduce.ts']);
    state = { ...state, memory: { ...state.memory, priorities: ['Code', 'Terminal'] } };
    const { effects } = momentAnalysisSchedule(state, windowEvent());

    expect((effects[1] as any).messages[1].content).toContain("This week's priorities (most time spent): Code, Terminal");
  });

  it('D5: omits the priorities line entirely when state.memory.priorities is empty', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts', 'reduce.ts']);
    const { effects } = momentAnalysisSchedule(state, windowEvent());

    expect((effects[1] as any).messages[1].content).not.toContain("This week's priorities");
  });

  it('does not schedule when there is no moment open', () => {
    const state = createInitialState('d1');
    expect(momentAnalysisSchedule(state, windowEvent()).effects).toEqual([]);
  });

  it('does not schedule for a moment with no real window titles', () => {
    const state = withMoment(createInitialState('d1'), []);
    expect(momentAnalysisSchedule(state, windowEvent()).effects).toEqual([]);
  });

  it('does not schedule when the only title equals the process name itself', () => {
    const state = withMoment(createInitialState('d1'), ['Code'], 'Code');
    expect(momentAnalysisSchedule(state, windowEvent()).effects).toEqual([]);
  });

  it('B2/B1: does not schedule for a moment under the 20s min-duration floor (momentClose is about to drop it anyway)', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts'], 'Code', '2026-01-01T00:00:00.000Z');
    const { effects } = momentAnalysisSchedule(state, windowEvent('2026-01-01T00:00:05.000Z'));
    expect(effects).toEqual([]);
  });

  it('does schedule right at the 20s floor and above', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts'], 'Code', '2026-01-01T00:00:00.000Z');
    const { effects } = momentAnalysisSchedule(state, windowEvent('2026-01-01T00:00:20.000Z'));
    expect(effects).toHaveLength(2);
  });

  it('B4: includes the enriched rollup (git/shell/calendar/life-events) in the prompt, not just window titles', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts'], 'Code', '2026-01-01T00:00:00.000Z', {
      gitCommitCount: 2,
      gitBranch: 'feature/x',
      notableCommands: ['git commit -m "fix"'],
      calendarActive: true,
      lifeEvents: ['event:big-commit', 'event:thrashing'],
    });
    const { effects } = momentAnalysisSchedule(state, windowEvent());

    const content = (effects[1] as any).messages[1].content as string;
    expect(content).toContain('Git commits: 2 (branch feature/x)');
    expect(content).toContain('Shell commands run: git commit -m "fix"');
    expect(content).toContain('A calendar event was active during this session.');
    expect(content).toContain('Notable activity detected: event:big-commit, event:thrashing');
  });

  it('tells the model what the moment WAS — project, length, and what was said aloud', () => {
    // The audit's worst intent, "Working in Arc browser" on a 31-minute
    // dictated session inside a project, came from a prompt that carried the
    // process name and tab titles and nothing else. All of this already sat on
    // the rollup.
    const state = withMoment(createInitialState('d1'), ['Gnomon — memory', 'sundial'], 'Arc', '2026-01-01T00:00:00.000Z', {
      activeMs: 25 * 60_000,
      shellCommandCount: 32,
      notableCommands: ['npx vitest run packages/rules', 'git status --short'],
      spokenExcerpt: 'it goes into the memory so it can pick it up later',
    });
    const { effects } = momentAnalysisSchedule(state, windowEvent('2026-01-01T00:31:00.000Z'));
    const content = (effects[1] as any).messages[1].content as string;

    expect(content).toContain('Lasted 31 min, 25 min of it active.');
    // Heard speech, labelled as heard by anyone rather than as the owner's word.
    expect(content).toContain('it goes into the memory');
    expect(content).toContain('heard nearby; may be anyone, may be noise');
    expect(content).not.toContain('outrank');
    expect(content.indexOf('HEARD ALOUD')).toBeLessThan(content.indexOf('Window titles seen'));
    // Named commands AND the count, because the count says more ran than is listed.
    expect(content).toContain('Shell commands run (32 in all): npx vitest run packages/rules · git status --short');
    // No attribution is said out loud, so the model does not invent one.
    expect(content).toContain('Project: not attributable from this window.');

    const system = (effects[1] as any).messages[0].content as string;
    expect(system).toContain('Name the WORK, not the window.');
  });

  it('names the project the closing row settled on, not the raw id', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts'], 'Code', '2026-01-01T00:00:00.000Z', { projectConfidence: 'certain' });
    state.project.known = { '~/Projects/sundial': { name: 'sundial', lastSeen: '2026-01-01T00:00:00.000Z' } } as never;
    state.moment!.projectId = 'named:sundial';
    const { effects } = momentAnalysisSchedule(state, windowEvent('2026-01-01T00:10:00.000Z'));
    const content = (effects[1] as any).messages[1].content as string;
    expect(content).toContain('Project: sundial (certain attribution)');
  });

  it('ignores an event that closes no moment', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts']);
    const event: SanitizedEvent = { id: 'e1', type: 'input:activity', ts: '2026-01-01T00:05:00.000Z', payload: {}, sanitized: true };
    expect(momentAnalysisSchedule(state, event).effects).toEqual([]);
  });

  // The defect these cover: this rule used to guard on `window:changed` alone,
  // so a moment ended by idle, sleep, the thirty-minute split or a gap
  // reconcile was never analyzed. On a 41-day live record none of the ten
  // moments over thirty minutes had a narrative, against 74% of the sub-minute
  // ones. The tick-split branch of `momentClose` documents itself as existing
  // so a long session is not "one giant, never-analyzed row" — which is exactly
  // what it produced.
  it('schedules for a moment closed by idle:start, and omits the next-window line (there is no next window)', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts', 'reduce.ts']);
    const event: SanitizedEvent = { id: 'e1', type: 'idle:start', ts: '2026-01-01T00:40:00.000Z', payload: {}, sanitized: true };

    const { effects } = momentAnalysisSchedule(state, event);
    expect(effects).toHaveLength(2);
    expect(effects[1]).toMatchObject({ type: 'ScheduleLLM', purpose: 'intent', momentId: 'm1' });
    const content = (effects[1] as any).messages[1].content as string;
    expect(content).toContain('index.ts -> reduce.ts');
    expect(content).not.toContain('Next window the user moved to');
  });

  it('schedules for a moment closed by the MAX_MOMENT_DURATION_MS clock:tick split', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts']);
    const event: SanitizedEvent = { id: 'e1', type: 'clock:tick', ts: '2026-01-01T00:31:00.000Z', payload: {}, sanitized: true };

    expect(momentAnalysisSchedule(state, event).effects).toHaveLength(2);
  });

  it('does not schedule on a clock:tick that leaves the moment open (under the split threshold)', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts']);
    const event: SanitizedEvent = { id: 'e1', type: 'clock:tick', ts: '2026-01-01T00:20:00.000Z', payload: {}, sanitized: true };
    expect(momentAnalysisSchedule(state, event).effects).toEqual([]);
  });

  it('E3: does not schedule when every window title is a [private]/[hidden] redaction placeholder', () => {
    const state = withMoment(createInitialState('d1'), ['[private]', '[private]'], 'WhatsApp', '2026-01-01T00:00:00.000Z');
    const { effects } = momentAnalysisSchedule(state, windowEvent('2026-01-01T00:01:00.000Z'));
    expect(effects).toEqual([]);
  });

  it('E3: does schedule when only some titles are redacted', () => {
    const state = withMoment(createInitialState('d1'), ['[private]', 'a real title'], 'WhatsApp', '2026-01-01T00:00:00.000Z');
    const { effects } = momentAnalysisSchedule(state, windowEvent('2026-01-01T00:01:00.000Z'));
    expect(effects).toHaveLength(2);
  });

  it('D2-adjacent fix: does NOT re-schedule on a same-process, same-project title change (B1 append, not a real close)', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts'], 'Code', '2026-01-01T00:00:00.000Z');
    // Same process ('Code') as the open moment — B1's momentClose would
    // append this title, not close. Before the fix, this rule had no way
    // to tell the difference and would schedule another LLM call anyway.
    const { effects } = momentAnalysisSchedule(state, windowEvent('2026-01-01T00:01:00.000Z', 'Code'));
    expect(effects).toEqual([]);
  });

  it('D2-adjacent fix: does still schedule on a real close (different process) even after several same-process appends', () => {
    const state = withMoment(createInitialState('d1'), ['index.ts', 'reduce.ts', 'types.ts'], 'Code', '2026-01-01T00:00:00.000Z');
    const { effects } = momentAnalysisSchedule(state, windowEvent('2026-01-01T00:05:00.000Z', 'Warp'));
    expect(effects).toHaveLength(2);
  });
});

describe('UC1: resolve slots by relevance (U1-F23)', () => {
  it('puts the promise to someone in this meeting, or whose thing a title names, in a slot before older ones', async () => {
    const { slotPromises } = await import('./moment-analysis-schedule.js');
    const p = (id: string, counterparty: string, keys: string[]) => ({ id, promise: { counterparty, keys } }) as never;
    const five = [p('a', 'Bob', ['x']), p('b', 'Bob', ['y']), p('c', 'Bob', ['z']), p('d', 'Bob', ['w']), p('mira', 'Mira Bakker', ['draft'])];
    expect(slotPromises(five, { meetingAttendees: ['Mira Bakker'], windowTitles: [] }).map((c: { id: string }) => c.id)).toEqual(['mira', 'a', 'b', 'c']);
    expect(slotPromises(five, { meetingAttendees: [], windowTitles: ['Draft — Docs'] })[0]).toMatchObject({ id: 'mira' });
  });
});
