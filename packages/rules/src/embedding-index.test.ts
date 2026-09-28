import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { embeddingIndex } from './embedding-index.js';

function withMoment(state: KernelState): KernelState {
  return {
    ...state,
    moment: {
      id: 'm1',
      sessionId: 's1',
      startTime: '2026-01-01T10:00:00.000Z',
      processName: 'Code',
      projectId: null,
      rollup: { processName: 'Code', windowTitles: ['index.ts', 'reduce.ts'], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null },
      intent: { status: 'none' },
    },
  };
}

describe('embeddingIndex', () => {
  it('emits an Embed effect for the about-to-close moment', () => {
    const state = withMoment(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };

    const { effects } = embeddingIndex(state, event);

    expect(effects).toEqual([{ type: 'Embed', id: expect.any(String), refType: 'moment', refId: 'm1', text: 'Code index.ts reduce.ts' }]);
  });

  it('skips embedding a moment under MIN_MOMENT_DURATION_MS — momentClose is about to drop it, no row to point at', () => {
    const state = withMoment(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:00:05.000Z', payload: {}, sanitized: true };
    expect(embeddingIndex(state, event).effects).toEqual([]);
  });

  it('does nothing when there is no open moment', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
    expect(embeddingIndex(state, event).effects).toEqual([]);
  });

  it('ignores an event that closes no moment', () => {
    const state = withMoment(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'input:activity', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
    expect(embeddingIndex(state, event).effects).toEqual([]);
  });

  // The defect these two cover: this rule used to guard on `window:changed`
  // alone, so every moment ended by idle, sleep, the thirty-minute split or a
  // gap reconcile went unembedded. On a 41-day live record that was 0 of 10
  // moments over thirty minutes against 95% of the sub-minute ones — the
  // retrieval index held the flicks and none of the deep sessions.
  it('embeds a moment closed by idle:start, not only one closed by a window boundary', () => {
    const state = withMoment(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'idle:start', ts: '2026-01-01T10:40:00.000Z', payload: {}, sanitized: true };

    expect(embeddingIndex(state, event).effects).toEqual([{ type: 'Embed', id: expect.any(String), refType: 'moment', refId: 'm1', text: 'Code index.ts reduce.ts' }]);
  });

  it('embeds a moment closed by the MAX_MOMENT_DURATION_MS clock:tick split', () => {
    const state = withMoment(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'clock:tick', ts: '2026-01-01T10:31:00.000Z', payload: {}, sanitized: true };

    expect(embeddingIndex(state, event).effects).toEqual([{ type: 'Embed', id: expect.any(String), refType: 'moment', refId: 'm1', text: 'Code index.ts reduce.ts' }]);
  });

  it('does not embed on a clock:tick that leaves the moment open (under the split threshold)', () => {
    const state = withMoment(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'clock:tick', ts: '2026-01-01T10:20:00.000Z', payload: {}, sanitized: true };
    expect(embeddingIndex(state, event).effects).toEqual([]);
  });

  describe('E3: skip fully-redacted content', () => {
    it('skips embedding a hidden-process moment (processName and every title are [hidden])', () => {
      const base = withMoment(createInitialState('d1'));
      const state: KernelState = {
        ...base,
        moment: { ...base.moment!, processName: '[hidden]', rollup: { ...base.moment!.rollup, windowTitles: ['[hidden]', '[hidden]'] } },
      };
      const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
      expect(embeddingIndex(state, event).effects).toEqual([]);
    });

    it('skips embedding a sensitive (not hidden) app moment too, once every title is blanked to [private] — same uniform condition as momentAnalysisSchedule', () => {
      const base = withMoment(createInitialState('d1'));
      const state: KernelState = {
        ...base,
        moment: { ...base.moment!, processName: 'WhatsApp', rollup: { ...base.moment!.rollup, windowTitles: ['[private]', '[private]'] } },
      };
      const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
      expect(embeddingIndex(state, event).effects).toEqual([]);
    });

    it('still embeds when only SOME content is redacted (processName real, titles mixed)', () => {
      const base = withMoment(createInitialState('d1'));
      const state: KernelState = {
        ...base,
        moment: { ...base.moment!, processName: 'WhatsApp', rollup: { ...base.moment!.rollup, windowTitles: ['[private]', 'a real title'] } },
      };
      const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
      expect(embeddingIndex(state, event).effects).toHaveLength(1);
    });
  });

  describe('ambient hearing reaches the retrieval index', () => {
    // The gap this closes: hearing wrote `spokenExcerpt` onto the moment row and
    // nothing ever read it, so a subject discussed out loud but never typed was
    // unfindable by `gnomon_semantic_search`.
    it('embeds what was said alongside the titles', () => {
      const base = withMoment(createInitialState('d1'));
      const state: KernelState = { ...base, moment: { ...base.moment!, rollup: { ...base.moment!.rollup, spokenExcerpt: 'we ship the reducer on Friday' } } };
      const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };

      expect(embeddingIndex(state, event).effects).toEqual([
        { type: 'Embed', id: expect.any(String), refType: 'moment', refId: 'm1', text: 'Code index.ts reduce.ts we ship the reducer on Friday' },
      ]);
    });

    it('leaves the text unchanged when the moment heard nothing — no trailing space to shift the vector', () => {
      const state = withMoment(createInitialState('d1'));
      const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
      expect(embeddingIndex(state, event).effects[0]).toMatchObject({ text: 'Code index.ts reduce.ts' });
    });
  });

  it('D2-adjacent fix: does NOT re-embed on a same-process, same-project title change (B1 append, not a real close)', () => {
    const state = withMoment(createInitialState('d1'));
    // Same process ('Code') as the open moment — B1's momentClose would
    // append this title, not close. Before the fix, this rule had no way
    // to tell the difference and would re-embed the growing rollup anyway.
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: { processName: 'Code' }, sanitized: true };
    expect(embeddingIndex(state, event).effects).toEqual([]);
  });
});
