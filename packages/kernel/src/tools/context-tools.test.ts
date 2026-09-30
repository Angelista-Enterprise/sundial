import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CONTEXT_TOOLS } from './context-tools.js';
import { DEFAULT_PAGE_ROWS } from './evidence-tools.js';
import { toolEnv } from '../tool-env.js';

const mocks = vi.hoisted(() => ({
  getMomentById: vi.fn(),
  getMomentCost: vi.fn(),
  getMomentsForDate: vi.fn(),
  getMomentsForProject: vi.fn(),
  getMultiDayCommitments: vi.fn(),
  getOpenCommitments: vi.fn(),
  getRecentSignals: vi.fn(),
  getSignalsForDate: vi.fn(),
  getKnowledgeEntriesForDate: vi.fn(),
  getAllProjects: vi.fn(),
}));

vi.mock('@sundial/db/index.js', () => mocks);
vi.mock('@sundial/helpers/sundial-config.js', () => ({
  loadSundialConfig: () => ({ timezone: 'UTC', projectAliases: {} }),
  canonicalProjectName: (name: string) => name,
}));

const tool = (name: string) => CONTEXT_TOOLS.find((t) => t.name === name)!;

/** A stored moment, with the bulk fields a real row carries. `spoken` gives it ambient hearing. */
function moment(id: string, startMin: number, durationMin: number, process = 'Code', spoken: string | null = null) {
  const start = new Date(Date.UTC(2026, 8, 9, 9, startMin)).toISOString();
  return {
    id,
    startTime: start,
    endTime: new Date(Date.parse(start) + durationMin * 60_000).toISOString(),
    durationMs: durationMin * 60_000,
    processName: process,
    importanceScore: 5,
    lastAccessedAt: null,
    projectId: null,
    data: {
      processName: process,
      kind: 'focus',
      focusScore: 70,
      focusQuality: 'steady',
      intent: { text: `working in ${process}` },
      narrative: 'A long narrative sentence that exists only to add weight to the row.',
      // The bulk. On the live record these are why a day was 479,384 characters.
      windowTitles: Array.from({ length: 40 }, (_, i) => `a window title number ${i} with plenty of text in it`),
      pages: Array.from({ length: 20 }, (_, i) => `example.com/some/long/path/${i}`),
      screenExcerpt: 'x'.repeat(2000),
      lifeEvents: ['event:big-commit'],
      notableCommands: ['git commit -m "something"'],
      ...(spoken !== null ? { spokenExcerpt: spoken } : {}),
    },
  };
}

describe('gnomon_today_summary', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.getSignalsForDate.mockResolvedValue([]);
    mocks.getKnowledgeEntriesForDate.mockResolvedValue([]);
    // Nothing spent, unless a test says otherwise. `mockReset` above clears any
    // implementation given at construction, so the default belongs here.
    mocks.getMomentCost.mockResolvedValue({ calls: 0, failed: 0, costUsd: 0, purposes: [] });
    mocks.getAllProjects.mockResolvedValue([]);
  });

  /**
   * The defect this tool carried: it returned `getMomentsForDate` — the raw
   * `moments` table, 479,384 characters on the live record, which is very nearly
   * the whole 128,000-token context window in ONE tool result.
   */
  it('is a summary, not the table: no window titles, pages or screen text', async () => {
    mocks.getMomentsForDate.mockResolvedValue([moment('m1', 0, 30), moment('m2', 40, 25)]);

    const out = JSON.stringify(await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv()));

    expect(out).not.toContain('a window title number');
    expect(out).not.toContain('example.com/some/long/path');
    expect(out).not.toContain('xxxxxxxxxx');
    expect(out).not.toContain('A long narrative sentence');
  });

  // 2026-09-14: asked for a meeting transcript, the live model read this
  // summary, saw no trace of speech in it, and answered that ambient hearing
  // had recorded nothing and that the feature was unbuilt — while that same
  // morning held 57 moments and 24,544 characters of the standup. The summary
  // is right to drop the WORDS; dropping every trace of them is what made a
  // held transcript unofferable.
  describe('ambient hearing is findable from the day', () => {
    it('marks a session that heard speech with the count, and says how to read it', async () => {
      mocks.getMomentsForDate.mockResolvedValue([moment('m1', 0, 30, 'Chrome', 'we agreed to ship on Friday'), moment('m2', 40, 25)]);

      const out = (await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as Record<string, unknown>;
      const sessions = out.sessions as { id: string; heardChars?: number }[];

      expect(sessions.find((s) => s.id === 'm1')?.heardChars).toBe(27);
      expect(String(out.heardNote)).toContain('gnomon_moment_detail');
      // The words themselves stay out: the count is the whole point.
      expect(JSON.stringify(out)).not.toContain('ship on Friday');
    });

    it('leaves the mark OFF a session that heard nothing — absent, never zero', async () => {
      mocks.getMomentsForDate.mockResolvedValue([moment('m1', 0, 30, 'Chrome', 'said something'), moment('m2', 40, 25)]);

      const sessions = ((await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as Record<string, unknown>)
        .sessions as Record<string, unknown>[];

      // A `0` would read as "the microphone was on and the room was silent",
      // which is a different and false claim.
      expect(sessions.find((s) => s.id === 'm2')).not.toHaveProperty('heardChars');
    });

    it('adds no note at all to a day that heard nothing, so its presence answers "was anything recorded"', async () => {
      mocks.getMomentsForDate.mockResolvedValue([moment('m1', 0, 30), moment('m2', 40, 25)]);

      const out = (await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as Record<string, unknown>;

      expect(out).not.toHaveProperty('heardNote');
    });
  });

  it('keeps the sessions worth reading and says how many it left out', async () => {
    mocks.getMomentsForDate.mockResolvedValue([
      moment('long-1', 0, 30),
      moment('flick-1', 35, 1),
      moment('flick-2', 37, 2),
      moment('long-2', 40, 12),
    ]);

    const out = (await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as {
      sessions: { id: string; min: number }[];
      sessionsNote: string;
    };

    expect(out.sessions.map((s) => s.id)).toEqual(['long-1', 'long-2']);
    // Not silently: a gap in the clock the model cannot account for reads as
    // absence of work rather than absence of detail.
    expect(out.sessionsNote).toContain('2 were shorter');
  });

  it('carries an id on every session, so gnomon_moment_detail is the way to the rest', async () => {
    mocks.getMomentsForDate.mockResolvedValue([moment('m1', 0, 30)]);
    mocks.getMomentById.mockResolvedValue(moment('m1', 0, 30));

    const out = (await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as { sessions: { id: string }[] };
    const id = out.sessions[0]!.id;
    expect(id).toBe('m1');

    // The drill-down still holds everything the summary dropped.
    const detail = JSON.stringify(await tool('gnomon_moment_detail').handler({ momentId: id } as never, toolEnv()));
    expect(detail).toContain('a window title number');
    // Nothing was spent on this one, so no cost is carried: `$0.00` on every
    // moment would train the eye to skip the line.
    expect(detail).not.toContain('cost');

    mocks.getMomentCost.mockResolvedValueOnce({ calls: 63, failed: 3, costUsd: 1.250144, purposes: ['ask', 'intent'] });
    const priced = (await tool('gnomon_moment_detail').handler({ momentId: id } as never, toolEnv())) as { data: { cost?: { calls: number } } };
    expect(priced.data.cost?.calls).toBe(63);
  });

  /**
   * `buildDailyContext` caps its timeline at 200 entries and slices
   * CHRONOLOGICALLY. On 2026-09-09 the day held 316 moments, 50 over three
   * minutes, and 29 of those 50 fell after the 200th — a morning of flicks spent
   * the budget and an afternoon of real work was dropped. The summary raises the
   * cap so its own duration filter is what reduces the day.
   */
  it('does not lose a long session late in a fragmented day', async () => {
    const flicks = Array.from({ length: 250 }, (_, i) => moment(`flick-${i}`, i, 1));
    mocks.getMomentsForDate.mockResolvedValue([...flicks, moment('afternoon', 300, 45)]);

    const out = (await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as { sessions: { id: string }[] };

    expect(out.sessions.map((s) => s.id)).toContain('afternoon');
  });
});

describe('gnomon_recent_activity', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
  });

  /**
   * `screenText` is 7,095 of the largest `screen:ocr` row's 7,173 characters.
   * Twenty such rows made this tool 15,003 characters of verbatim screen dump.
   */
  it('caps a long text field and says that it did', async () => {
    mocks.getRecentSignals.mockResolvedValue([
      { id: 's1', signalType: 'screen', eventType: 'ocr', sessionId: null, capturedAt: '2026-09-09T09:00:00.000Z', data: { screenText: 'y'.repeat(3000), topics: ['terminal'], lineCount: 116 } },
    ]);

    const out = (await tool('gnomon_recent_activity').handler({} as never, toolEnv())) as { signals: { data: Record<string, unknown> }[] };
    const data = out.signals[0]!.data;

    expect((data.screenText as string).length).toBeLessThan(250);
    expect(data.truncated).toBe(true);
    // The digest the payload already carried is untouched — the cap is on
    // length, not on which fields matter.
    expect(data.topics).toEqual(['terminal']);
    expect(data.lineCount).toBe(116);
  });

  it('leaves a short row exactly as it was, with no truncated marker', async () => {
    mocks.getRecentSignals.mockResolvedValue([
      { id: 's1', signalType: 'window', eventType: 'changed', sessionId: null, capturedAt: '2026-09-09T09:00:00.000Z', data: { processName: 'Code', windowTitle: 'index.ts' } },
    ]);

    const out = (await tool('gnomon_recent_activity').handler({} as never, toolEnv())) as { signals: { data: Record<string, unknown> }[] };
    expect(out.signals[0]!.data).toEqual({ processName: 'Code', windowTitle: 'index.ts' });
  });

  /**
   * The usefulness half. `screen:ocr` (38,509 rows) and `input:activity`
   * (110,433) are the highest-volume sensors on the live record, so an
   * unfiltered "newest 20" answered "what just happened" with neither.
   */
  it('asks the query for owner-evidence types, so volume cannot crowd out activity', async () => {
    mocks.getRecentSignals.mockResolvedValue([]);

    await tool('gnomon_recent_activity').handler({} as never, toolEnv());

    const [limit, types] = mocks.getRecentSignals.mock.calls[0]!;
    // The default page, plus the offset of 0 this call implies.
    expect(limit).toBe(DEFAULT_PAGE_ROWS);
    expect(types).toContain('window');
    expect(types).toContain('git');
    expect(types).not.toContain('screen');
    expect(types).not.toContain('input');
  });
});

/**
 * `renderResultText` (plugins/sundial-tools/render.js) caps a rendered result at
 * 12,000 bytes, and an OBJECT over that becomes a 60%-length preview STRING —
 * a broken answer, not a shorter one. Both object-shaped tools were hitting it:
 * 13,324 bytes for the summary and 49,328 for `gnomon_signals`. The live model
 * reported the damage itself: "the session timeline came back size-truncated".
 */
describe('a summary bounds itself, so it never becomes a preview', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.getSignalsForDate.mockResolvedValue([]);
    mocks.getKnowledgeEntriesForDate.mockResolvedValue([]);
    mocks.getAllProjects.mockResolvedValue([]);
  });

  it('stays under the per-result budget on a very long day', async () => {
    // 400 sessions, every one long enough to be worth reading.
    mocks.getMomentsForDate.mockResolvedValue(Array.from({ length: 400 }, (_, i) => moment(`m${i}`, i * 10, 8)));

    const out = await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv());

    expect(JSON.stringify(out).length).toBeLessThan(12_000);
  });

  it('drops the SHORTEST sessions to fit, never the latest', async () => {
    const shorts = Array.from({ length: 300 }, (_, i) => moment(`short-${i}`, i, 3));
    mocks.getMomentsForDate.mockResolvedValue([...shorts, moment('the-long-one', 400, 90)]);

    const out = (await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as {
      sessions: { id: string; start: string }[];
      sessionsNote: string;
      sessionCount: number;
      nextSessionOffset?: number;
    };

    expect(out.sessions.map((s) => s.id)).toContain('the-long-one');
    // The note no longer reports a dead end. What is left out is on a NEXT
    // PAGE, and the note says how to ask for it — the whole point of the
    // offset: re-running the day with a different limit re-reads sessions the
    // model already has, which is what 36% of cut results did on the live log.
    expect(out.sessionsNote).toContain('next page');
    expect(out.sessionsNote).toContain(`offset: ${out.nextSessionOffset}`);
    expect(out.sessionCount).toBe(301);
    expect(out.nextSessionOffset).toBe(out.sessions.length);
    // Kept sessions are still in clock order — a day is read forwards.
    const starts = out.sessions.map((s) => s.start);
    expect([...starts].sort()).toEqual(starts);
  });

  it('hands back the NEXT sessions on the second page, not the same ones again', async () => {
    const shorts = Array.from({ length: 300 }, (_, i) => moment(`short-${i}`, i, 3));
    mocks.getMomentsForDate.mockResolvedValue([...shorts, moment('the-long-one', 400, 90)]);

    const first = (await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as {
      sessions: { id: string }[];
      nextSessionOffset: number;
    };
    const second = (await tool('gnomon_today_summary').handler({ date: '2026-09-09', offset: first.nextSessionOffset } as never, toolEnv())) as {
      sessions: { id: string }[];
      sessionOffset: number;
    };

    expect(second.sessionOffset).toBe(first.nextSessionOffset);
    expect(second.sessions.length).toBeGreaterThan(0);
    // No row appears on both pages. This is the property the whole change
    // exists for: a second page costs new tokens for new evidence, where a
    // re-run costs new tokens for evidence already in the prompt.
    const firstIds = new Set(first.sessions.map((s) => s.id));
    expect(second.sessions.some((s) => firstIds.has(s.id))).toBe(false);
  });

  it('ends the walk rather than looping: a page past the end is empty and offers no next', async () => {
    mocks.getMomentsForDate.mockResolvedValue([moment('only-one', 0, 30)]);

    const out = (await tool('gnomon_today_summary').handler({ date: '2026-09-09', offset: 999 } as never, toolEnv())) as {
      sessions: unknown[];
      sessionCount: number;
      nextSessionOffset?: number;
    };

    expect(out.sessions).toEqual([]);
    expect(out.sessionCount).toBe(1);
    expect(out.nextSessionOffset).toBeUndefined();
  });

  it('says what it left out and where the rest is', async () => {
    mocks.getMomentsForDate.mockResolvedValue([moment('long', 0, 30), moment('flick', 40, 1)]);

    const out = (await tool('gnomon_today_summary').handler({ date: '2026-09-09' } as never, toolEnv())) as { sessionsNote: string };

    // Says what is PRESENT and that the ranking is intact — a field that led
    // with what was missing made the model call the whole result truncated.
    expect(out.sessionsNote).toContain('longest kept first');
    expect(out.sessionsNote).toContain('complete');
    expect(out.sessionsNote).toContain('gnomon_signals');
  });
});
