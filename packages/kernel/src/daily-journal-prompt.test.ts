import { describe, it, expect } from 'vitest';
import type { DailyContext } from './daily-context.js';
import {
  buildJournalMessages,
  serializeDailyContext,
  parseJournalResult,
  assembleJournalMarkdown,
  JOURNAL_TLDR_MAX_CHARS,
  JOURNAL_NARRATIVE_MAX_CHARS,
  JOURNAL_LIST_ITEM_MAX_CHARS,
  JOURNAL_LIST_MAX_ITEMS,
} from './daily-journal-prompt.js';

function emptyCtx(overrides: Partial<DailyContext> = {}): DailyContext {
  return {
    date: '2026-07-20',
    timeZone: 'Europe/Amsterdam',
    coverage: { trackedMin: 0, wallClockMin: 0, firstActivity: null, lastActivity: null },
    projects: [],
    noProjectMin: 0,
    phaseMix: { setup: 0, focus: 0, meeting: 0, switch: 0, browse: 0, leisure: 0 },
    focus: { deepMin: 0, steadyMin: 0, shallowMin: 0 },
    timeline: [],
    meetings: [],
    searches: [],
    flows: [],
    deepWorkBlocks: [],
    energyCurve: [],
    breaks: [],
    anomalies: [],
    continuity: [],
    redactions: { total: 0, byProperty: {} },
    ...overrides,
  };
}

describe('serializeDailyContext', () => {
  it('emits labeled sections for the populated parts and skips empty ones', () => {
    const ctx = emptyCtx({
      coverage: { trackedMin: 275, wallClockMin: 391, firstActivity: '2026-07-20T09:49:00.000Z', lastActivity: '2026-07-20T16:20:00.000Z' },
      projects: [{ name: 'wcs', minutes: 123, momentCount: 4, commits: 0, branches: ['develop'], confidence: 'certain' }],
      phaseMix: { setup: 0, focus: 120, meeting: 89, switch: 0, browse: 38, leisure: 0 },
      focus: { deepMin: 120, steadyMin: 100, shallowMin: 55 },
      meetings: [{ title: 'Standup', start: '2026-07-20T09:49:00.000Z', end: '2026-07-20T11:00:00.000Z', attendees: ['sam', 'ada'], micOn: true, camOn: false }],
      searches: [{ query: 'kuromasu fill strategy', ts: '2026-07-20T12:31:00.000Z' }],
      flows: [{ from: 'Chrome', to: 'Claude', count: 58 }],
      deepWorkBlocks: [{ start: '2026-07-20T14:20:00.000Z', end: '2026-07-20T16:20:00.000Z', durationMin: 120, project: 'wcs' }],
    });
    const text = serializeDailyContext(ctx);
    expect(text).toContain('PROJECTS: wcs 123m, branch develop (certain)');
    expect(text).toContain('MEETINGS:');
    expect(text).toContain('"Standup"');
    expect(text).toContain('sam, ada');
    expect(text).toContain('SEARCHES: "kuromasu fill strategy"');
    expect(text).toContain('FLOWS: Chrome→Claude ×58');
    expect(text).toContain('DEEP-WORK BLOCKS:');
    expect(text).not.toContain('ANOMALIES:'); // empty → skipped
  });

  it('drops system chrome and sub-2-min fragments from the timeline', () => {
    const ctx = emptyCtx({
      timeline: [
        { id: 'm2', start: '2026-07-20T09:00:00.000Z', end: '2026-07-20T09:30:00.000Z', durationMin: 30, process: 'Claude', project: 'wcs', narrative: 'Worked on the daemon.', intent: null, titles: [], lifeEvents: [], notableCommands: [], kind: 'focus', focusScore: 0.9 },
        { id: 'm3', start: '2026-07-20T09:30:00.000Z', end: '2026-07-20T09:30:30.000Z', durationMin: 0, process: 'Finder', project: null, narrative: null, intent: null, titles: [], lifeEvents: [], notableCommands: [], kind: 'setup', focusScore: 0 },
      ],
    });
    const text = serializeDailyContext(ctx);
    expect(text).toContain('Claude · wcs');
    expect(text).not.toContain('Finder');
  });

  it('keeps a short moment if it carries a narrative', () => {
    const ctx = emptyCtx({
      timeline: [{ id: 'm4', start: '2026-07-20T09:00:00.000Z', end: '2026-07-20T09:01:00.000Z', durationMin: 1, process: 'Warp', project: null, narrative: 'Ran the migration.', intent: null, titles: [], lifeEvents: [], notableCommands: [], kind: 'setup', focusScore: 0 }],
    });
    // The narrative still decides that a one-minute moment is worth a row; it is
    // just no longer PRINTED on that row — see the test below.
    expect(serializeDailyContext(ctx)).toContain('Warp');
  });

  /**
   * `narrative` is a past-tense restatement of `intent` from the same call —
   * 13,380 characters of pure duplication on one measured day, for nothing the
   * row does not already carry. It still exists on the moment (Memory · Recorded
   * and `gnomon summary` read it); it just no longer inflates this prompt, which
   * was 88% model-written text summarising itself.
   */
  it('does NOT print the narrative — the journal reads evidence, not its own prior prose', () => {
    const ctx = emptyCtx({
      timeline: [
        { id: 'm5',
          start: '2026-07-20T09:00:00.000Z',
          end: '2026-07-20T09:30:00.000Z',
          durationMin: 30,
          process: 'Claude',
          project: 'wcs',
          narrative: 'Worked on the daemon for half an hour.',
          intent: 'Debugging the reducer',
          titles: ['reduce.ts — wcs'],
          lifeEvents: [],
          notableCommands: [],
          kind: 'focus',
          focusScore: 0.9,
        },
      ],
    });
    const text = serializeDailyContext(ctx);

    expect(text).not.toContain('Worked on the daemon for half an hour.');
    // `intent` stays: one clause per row is what makes the timeline navigable
    // enough for the model to know which hour is worth a tool call.
    expect(text).toContain('[Debugging the reducer]');
    // And primary evidence stays, because that is the point of the whole change.
    expect(text).toContain('reduce.ts — wcs');
  });
});

describe('buildJournalMessages', () => {
  it('produces a system + user message pair', () => {
    const messages = buildJournalMessages(emptyCtx());
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('STRICT JSON');
    expect(messages[1].role).toBe('user');
  });

  /**
   * The tools return raw UTC ISO timestamps and the model quoted them straight
   * into a journal — "between 10:56 and 19:53 UTC" for someone sitting at the
   * machine at 21:53. Naming the zone is the only thing standing between the
   * owner and a journal written in a timezone they do not live in.
   */
  it('names the owner timezone and forbids quoting UTC', () => {
    const text = serializeDailyContext(emptyCtx());

    expect(text).toContain('Europe/Amsterdam');
    expect(text).toMatch(/never write "UTC"/i);
  });

  /** The loop is useless if the prompt never tells the model the tools exist. */
  it('tells the model to gather evidence with tools before writing', () => {
    const system = buildJournalMessages(emptyCtx())[0].content;

    expect(system).toContain('gnomon_code_activity');
    expect(system).toContain('gnomon_signals');
    // And that the bracketed text is a guess to navigate by, not a fact to repeat.
    expect(system).toMatch(/earlier model.{0,20}guess/i);
  });
});

describe('parseJournalResult', () => {
  it('parses a valid strict-JSON reply', () => {
    const r = parseJournalResult('{"tldr":"A deep day.","narrative":"Para one.\\n\\nPara two.","noticed":["Focus dropped after Slack."],"followups":["KIT-403 open"]}');
    expect(r).toEqual({ tldr: 'A deep day.', narrative: 'Para one.\n\nPara two.', noticed: ['Focus dropped after Slack.'], followups: ['KIT-403 open'] });
  });

  it('strips ``` fences', () => {
    const r = parseJournalResult('```json\n{"tldr":"x","narrative":"y","noticed":[],"followups":[]}\n```');
    expect(r?.tldr).toBe('x');
  });

  it('returns null when required prose fields are missing or blank', () => {
    expect(parseJournalResult('{"tldr":"","narrative":"y"}')).toBeNull();
    expect(parseJournalResult('{"narrative":"y"}')).toBeNull();
    expect(parseJournalResult('not json')).toBeNull();
  });

  it('coerces missing arrays to empty', () => {
    const r = parseJournalResult('{"tldr":"x","narrative":"y"}');
    expect(r).toEqual({ tldr: 'x', narrative: 'y', noticed: [], followups: [] });
  });

  it('clamps an over-length tldr to the budget, at a sentence boundary', () => {
    const sentence = 'This day ran long and kept running past the point a card can hold it.';
    const tldr = `${sentence} ${sentence} ${sentence}`;
    const r = parseJournalResult(`{"tldr":${JSON.stringify(tldr)},"narrative":"y"}`);
    expect(r!.tldr.length).toBeLessThanOrEqual(JOURNAL_TLDR_MAX_CHARS);
    expect(r!.tldr.endsWith('.')).toBe(true);
  });

  it('clamps an over-length narrative to the budget without cutting mid-word', () => {
    const paragraph = 'A short sentence about the day. Another short sentence right after it. '.repeat(30);
    const r = parseJournalResult(`{"tldr":"x","narrative":${JSON.stringify(paragraph)}}`);
    expect(r!.narrative.length).toBeLessThanOrEqual(JOURNAL_NARRATIVE_MAX_CHARS);
    expect(paragraph.startsWith(r!.narrative.replace(/…$/, '').trimEnd())).toBe(true);
  });

  it('caps noticed/followups to the item limit and clamps each item', () => {
    const long = 'x'.repeat(JOURNAL_LIST_ITEM_MAX_CHARS + 50);
    const items = Array.from({ length: JOURNAL_LIST_MAX_ITEMS + 3 }, () => long);
    const r = parseJournalResult(`{"tldr":"x","narrative":"y","noticed":${JSON.stringify(items)},"followups":${JSON.stringify(items)}}`);
    expect(r!.noticed).toHaveLength(JOURNAL_LIST_MAX_ITEMS);
    expect(r!.followups).toHaveLength(JOURNAL_LIST_MAX_ITEMS);
    for (const item of r!.noticed) expect(item.length).toBeLessThanOrEqual(JOURNAL_LIST_ITEM_MAX_CHARS);
  });

  it('leaves within-budget prose untouched', () => {
    const r = parseJournalResult('{"tldr":"A quiet day.","narrative":"Para one.\\n\\nPara two."}');
    expect(r).toEqual({ tldr: 'A quiet day.', narrative: 'Para one.\n\nPara two.', noticed: [], followups: [] });
  });
});

describe('assembleJournalMarkdown', () => {
  it('renders narrative + noticed + followups sections', () => {
    const md = assembleJournalMarkdown({ tldr: 't', narrative: 'The narrative.', noticed: ['Obs one.'], followups: ['Do X'] });
    expect(md).toContain('The narrative.');
    expect(md).toContain('- Obs one.');
    expect(md).toContain('- [ ] Do X');
  });

  it('omits empty sections', () => {
    const md = assembleJournalMarkdown({ tldr: 't', narrative: 'Just prose.', noticed: [], followups: [] });
    expect(md).toBe('Just prose.');
  });
});
