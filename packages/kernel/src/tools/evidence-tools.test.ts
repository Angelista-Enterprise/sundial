// The paging contract, which is the whole of what a cut result is allowed to
// say to a model.
//
// Before this, a result that did not fit told the model to "narrow with
// signalType, or a smaller limit and a later date" — an instruction to ask the
// SAME question again with different filters. Measured on the live dsh session
// log: 70% of `gnomon_signals` results came back cut, and 36% of all cut
// results were followed by the same tool being called again within three steps.
// Both copies of the overlapping rows then stayed in the prompt for the rest of
// the turn.
//
// These tests pin the two properties that fix it: a page reports the TRUE total
// so a small default is a cheap look rather than a gamble, and `nextOffset`
// returns rows the model has NOT already seen.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSignalsInRange: vi.fn(),
  countSignalsInRange: vi.fn(),
  getCodeActivityForDate: vi.fn(),
}));

vi.mock('@sundial/db/index.js', () => mocks);
vi.mock('@sundial/helpers/sundial-config.js', () => ({
  loadSundialConfig: () => ({ timezone: 'UTC', projectAliases: {} }),
  canonicalProjectName: (name: string) => name,
}));

const { DEFAULT_PAGE_ROWS, EVIDENCE_TOOLS, pageWithinBudget, RESULT_BUDGET_CHARS } = await import('./evidence-tools.js');

const tool = (name: string) => EVIDENCE_TOOLS.find((t) => t.name === name)!;

/** A signal row as the query layer returns it. */
function signal(i: number) {
  return {
    id: `s${i}`,
    signalType: 'shell',
    eventType: 'command',
    sessionId: null,
    capturedAt: new Date(Date.UTC(2026, 8, 12, 9, i)).toISOString(),
    data: { command: `echo ${i}` },
  };
}

describe('pageWithinBudget', () => {
  const budget = 10_000;

  it('states the TRUE total, not the size of the page it returned', () => {
    // The blindness this fixes: a model handed 25 rows and nothing else cannot
    // tell a quiet day from a capped one, so it stops trusting the limit and
    // asks for the maximum every time.
    const page = pageWithinBudget(Array.from({ length: 412 }, (_, i) => i), { limit: 25, budget });
    expect(page.rows).toHaveLength(25);
    expect(page.total).toBe(412);
  });

  it('points at the next page and says so in words the model can act on', () => {
    const page = pageWithinBudget(Array.from({ length: 100 }, (_, i) => i), { limit: 25, budget });
    expect(page.nextOffset).toBe(25);
    expect(page.note).toContain('offset: 25');
    // The instruction that must NOT come back: re-running the same query is
    // exactly the behaviour that put duplicate rows in the prompt.
    expect(page.note).toContain('Do NOT re-run');
  });

  it('returns rows the caller has not seen, which is the point of an offset', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const first = pageWithinBudget(items, { limit: 25, budget });
    const second = pageWithinBudget(items, { offset: first.nextOffset, limit: 25, budget });
    expect(second.offset).toBe(25);
    expect(second.rows[0]).toBe(25);
    expect(new Set([...first.rows, ...second.rows]).size).toBe(50);
  });

  it('offers no next page at the end of the list', () => {
    const page = pageWithinBudget([1, 2, 3], { limit: 25, budget });
    expect(page.rows).toEqual([1, 2, 3]);
    expect(page.nextOffset).toBeUndefined();
    expect(page.note).toBeUndefined();
  });

  it('clamps an offset past the end instead of failing, and reports the total anyway', () => {
    // Walking off a list that shrank between two calls is ordinary. An empty
    // final page is the truthful answer; an error would be a broken tool.
    const page = pageWithinBudget([1, 2, 3], { offset: 999, limit: 25, budget });
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(3);
    expect(page.offset).toBe(3);
    expect(page.nextOffset).toBeUndefined();
  });

  it('stops at the character budget before the limit, and the next offset follows the budget', () => {
    // A page that ends early because of SIZE must still hand back an offset
    // that resumes exactly where it stopped — otherwise the budget silently
    // eats rows nobody can ask for again.
    const fat = Array.from({ length: 50 }, (_, i) => ({ i, blob: 'x'.repeat(200) }));
    const page = pageWithinBudget(fat, { limit: 50, budget: 1_000 });
    expect(page.rows.length).toBeLessThan(50);
    expect(page.nextOffset).toBe(page.rows.length);
    expect(page.total).toBe(50);
  });

  it('defaults to a small page, because the total is what makes a small page safe', () => {
    const page = pageWithinBudget(Array.from({ length: 500 }, (_, i) => i), { budget });
    expect(page.rows).toHaveLength(DEFAULT_PAGE_ROWS);
    expect(DEFAULT_PAGE_ROWS).toBe(25);
  });
});

describe('gnomon_signals paging', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
  });

  it('asks the database for one page, and for the true day count separately', async () => {
    mocks.countSignalsInRange.mockResolvedValue(412);
    mocks.getSignalsInRange.mockResolvedValue([signal(1), signal(2)]);

    const out = (await tool('gnomon_signals').handler({ date: '2026-09-12' } as never)) as { total: number; count: number; nextOffset?: number; note?: string };

    // The count cannot come from `rows.length` — rows is one page. A separate
    // indexed COUNT is what buys the small default its honesty.
    expect(mocks.countSignalsInRange).toHaveBeenCalledTimes(1);
    // getSignalsInRange(from, to, limit, signalTypes, offset)
    const call = mocks.getSignalsInRange.mock.calls[0]!;
    expect(call[2]).toBe(DEFAULT_PAGE_ROWS);
    expect(call[4]).toBe(0);
    expect(out.total).toBe(412);
    expect(out.count).toBe(2);
  });

  it('names the next page rather than telling the model to ask the day again', async () => {
    mocks.countSignalsInRange.mockResolvedValue(100);
    mocks.getSignalsInRange.mockResolvedValue(Array.from({ length: 25 }, (_, i) => signal(i)));

    const out = (await tool('gnomon_signals').handler({ date: '2026-09-12' } as never)) as { nextOffset: number; note: string };

    expect(out.nextOffset).toBe(25);
    expect(out.note).toContain('offset: 25');
    expect(out.note).toContain('Do NOT re-run');
  });

  it('passes the caller offset through to the query, so page two is new rows', async () => {
    mocks.countSignalsInRange.mockResolvedValue(100);
    mocks.getSignalsInRange.mockResolvedValue([signal(25)]);

    const out = (await tool('gnomon_signals').handler({ date: '2026-09-12', offset: 25 } as never)) as { offset: number };

    expect(mocks.getSignalsInRange.mock.calls[0]![4]).toBe(25);
    expect(out.offset).toBe(25);
  });

  it('narrows to a time window and to rows holding some words, and keeps speech long enough to quote', async () => {
    const said = 'Ik denk dat we de hint-strategie moeten omgooien, '.repeat(12);
    mocks.countSignalsInRange.mockResolvedValue(1);
    mocks.getSignalsInRange.mockResolvedValue([{ ...signal(1), signalType: 'audio', eventType: 'transcript', data: { spokenText: said } }]);

    const out = (await tool('gnomon_signals').handler({ date: '2026-09-22', signalType: 'audio', from: '09:00', to: '09:30', contains: 'hint' } as never)) as { rows?: unknown; from: string; contains: string } & Record<string, unknown>;

    const [start, end, , types, , contains] = mocks.getSignalsInRange.mock.calls[0]!;
    expect([start, end]).toEqual(['2026-09-22T09:00:00.000Z', '2026-09-22T09:30:00.000Z']);
    expect(types).toEqual(['audio']);
    expect(contains).toBe('hint');
    expect(mocks.countSignalsInRange.mock.calls[0]![3]).toBe('hint');
    expect(out.from).toBe('09:00');
    // 600 characters said: kept whole, where the old 200-character cap cut it.
    expect(JSON.stringify(out)).toContain(said.slice(0, 590));
  });

  it('offers no next page when the day is exhausted', async () => {
    mocks.countSignalsInRange.mockResolvedValue(2);
    mocks.getSignalsInRange.mockResolvedValue([signal(1), signal(2)]);

    const out = (await tool('gnomon_signals').handler({ date: '2026-09-12' } as never)) as { nextOffset?: number; note?: string };

    expect(out.nextOffset).toBeUndefined();
    expect(out.note).toBeUndefined();
  });

  it('keeps the result inside the per-result budget, so it never reaches the object-preview path', async () => {
    // `renderResultText` replaces an over-long OBJECT with a 60%-length preview
    // STRING — a broken answer, not a smaller one. This result is an object, so
    // it has to bound its own list.
    mocks.countSignalsInRange.mockResolvedValue(5_000);
    mocks.getSignalsInRange.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ ...signal(i), data: { command: 'x'.repeat(500) } })),
    );

    const out = await tool('gnomon_signals').handler({ date: '2026-09-12', limit: 200 } as never);

    expect(JSON.stringify(out).length).toBeLessThan(RESULT_BUDGET_CHARS + 1_000);
  });
});

describe('gnomon_code_activity paging', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
  });

  const summary = (fileCount: number) => ({
    date: '2026-09-12',
    projectRoot: null,
    projectsTouched: ['~/Projects/sundial'],
    branches: ['main'],
    files: Array.from({ length: fileCount }, (_, i) => ({ file: `src/f${i}.ts`, symbols: ['run'], edits: fileCount - i, firstEditedAt: 'a', lastEditedAt: 'b' })),
    commits: [{ sha: 'abc', subject: 'a commit' }],
  });

  it('pages the FILE list and reports how many the day holds in all', async () => {
    mocks.getCodeActivityForDate.mockResolvedValue(summary(120));

    const out = (await tool('gnomon_code_activity').handler({ date: '2026-09-12' } as never)) as {
      files: { file: string }[];
      fileCount: number;
      nextOffset?: number;
    };

    expect(out.fileCount).toBe(120);
    expect(out.files.length).toBeLessThanOrEqual(DEFAULT_PAGE_ROWS);
    expect(out.nextOffset).toBe(out.files.length);
    // Most-edited first, so page one is the day's significant work rather than
    // its alphabetical beginning.
    expect(out.files[0]!.file).toBe('src/f0.ts');
  });

  it('gives commits their own count, because one offset cannot mean two lists', async () => {
    mocks.getCodeActivityForDate.mockResolvedValue(summary(5));

    const out = (await tool('gnomon_code_activity').handler({ date: '2026-09-12' } as never)) as { commitCount: number; nextOffset?: number };

    expect(out.commitCount).toBe(1);
    expect(out.nextOffset).toBeUndefined();
  });

  it('starts where the caller asked, with no row shared with page one', async () => {
    mocks.getCodeActivityForDate.mockResolvedValue(summary(120));

    const first = (await tool('gnomon_code_activity').handler({ date: '2026-09-12' } as never)) as { files: { file: string }[]; nextOffset: number };
    const second = (await tool('gnomon_code_activity').handler({ date: '2026-09-12', offset: first.nextOffset } as never)) as { files: { file: string }[] };

    const firstFiles = new Set(first.files.map((f) => f.file));
    expect(second.files.some((f) => firstFiles.has(f.file))).toBe(false);
  });
});
