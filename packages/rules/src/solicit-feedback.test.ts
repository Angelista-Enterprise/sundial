import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { solicitFeedback } from './solicit-feedback.js';

function tick(ts: string): SanitizedEvent {
  return { id: `tick-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true };
}

function withInsights(insights: KernelState['memory']['recentInsights']): KernelState {
  const state = createInitialState('d1');
  return { ...state, memory: { ...state.memory, recentInsights: insights } };
}

const INSIGHT = { title: 'Late night session', dedupeKey: 'companion:late night session', kind: 'late-night', createdAt: '2026-01-01T00:10:00.000Z', id: 'k1' };

describe('solicitFeedback', () => {
  it('ignores non-tick events', () => {
    const state = withInsights([INSIGHT]);
    const event: SanitizedEvent = { id: 'e', type: 'window:changed', ts: '2026-01-01T01:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = solicitFeedback(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('opens a rating request for the newest unrated, unasked, fresh insight', () => {
    const { state: next, effects } = solicitFeedback(withInsights([INSIGHT]), tick('2026-01-01T01:00:00.000Z'));
    expect(next.feedback.solicitation).toEqual({ artifactKind: 'knowledge_entry', artifactId: 'k1', question: 'Was this useful? “Late night session”', ts: '2026-01-01T01:00:00.000Z' });
    expect(next.feedback.solicitedRecently).toEqual(['k1']);
    expect(effects).toEqual([{ type: 'Notify', channel: 'feedback-solicitation', payload: { artifactId: 'k1', question: 'Was this useful? “Late night session”' } }]);
  });

  it('picks the NEWEST insight when several are unrated', () => {
    const older = { ...INSIGHT, id: 'k1', createdAt: '2026-01-01T00:10:00.000Z' };
    const newer = { ...INSIGHT, id: 'k2', title: 'Deep focus', createdAt: '2026-01-01T00:50:00.000Z' };
    const { state: next } = solicitFeedback(withInsights([older, newer]), tick('2026-01-01T01:00:00.000Z'));
    expect(next.feedback.solicitation?.artifactId).toBe('k2');
  });

  it('does not open a second ask while one is already open', () => {
    const opened = solicitFeedback(withInsights([INSIGHT, { ...INSIGHT, id: 'k2' }]), tick('2026-01-01T01:00:00.000Z')).state;
    const firstAsked = opened.feedback.solicitation?.artifactId;
    const { state: next, effects } = solicitFeedback(opened, tick('2026-01-01T01:00:10.000Z'));
    expect(next.feedback.solicitation?.artifactId).toBe(firstAsked);
    expect(effects).toEqual([]);
  });

  it('expires an ignored ask after the TTL rather than recording a verdict', () => {
    const opened = solicitFeedback(withInsights([INSIGHT]), tick('2026-01-01T01:00:00.000Z')).state;
    // > 24h later, still unanswered.
    const { state: next } = solicitFeedback(opened, tick('2026-01-02T02:00:00.000Z'));
    expect(next.feedback.solicitation).toBeNull();
    expect(next.feedback.countsByVerdict).toEqual({});
  });

  it('never re-asks an insight already in solicitedRecently', () => {
    const base = withInsights([INSIGHT]);
    const state = { ...base, feedback: { ...base.feedback, solicitedRecently: ['k1'] } };
    const { state: next, effects } = solicitFeedback(state, tick('2026-01-01T01:00:00.000Z'));
    expect(next.feedback.solicitation).toBeNull();
    expect(effects).toEqual([]);
  });

  it('never asks about an insight the owner already rated', () => {
    const base = withInsights([INSIGHT]);
    const state = {
      ...base,
      feedback: { ...base.feedback, recent: [{ artifactKind: 'knowledge_entry' as const, artifactId: 'k1', verdict: 'useful' as const, solicited: false, note: null, ts: '2026-01-01T00:30:00.000Z' }] },
    };
    const { state: next } = solicitFeedback(state, tick('2026-01-01T01:00:00.000Z'));
    expect(next.feedback.solicitation).toBeNull();
  });

  it('skips a stale insight outside the freshness window', () => {
    const stale = { ...INSIGHT, createdAt: '2026-01-01T00:10:00.000Z' };
    // Tick is ~8 days later.
    const { state: next } = solicitFeedback(withInsights([stale]), tick('2026-01-09T00:10:00.000Z'));
    expect(next.feedback.solicitation).toBeNull();
  });

  it('skips an insight from a pre-id snapshot (no artifactId to ask about)', () => {
    const noId = { title: 'Old', dedupeKey: 'companion:old', kind: 'x', createdAt: '2026-01-01T00:10:00.000Z' };
    const { state: next } = solicitFeedback(withInsights([noId]), tick('2026-01-01T01:00:00.000Z'));
    expect(next.feedback.solicitation).toBeNull();
  });
});
