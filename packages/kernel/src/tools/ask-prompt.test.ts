import { describe, expect, it } from 'vitest';
import { askContextBlock } from './ask-prompt.js';

/**
 * The model has no clock, and every tool's `date` defaults to today — so the gap
 * only shows up on a question that says "yesterday". It did: asked on
 * 2026-08-02, the model guessed 2026-07-29, passed the guess to a tool, got an
 * empty result, and correctly reported that nothing was tracked. Every step
 * behaved and the answer was wrong.
 */
describe('askContextBlock', () => {
  const now = new Date('2026-08-02T06:43:00.000Z');

  it('states today and yesterday as explicit dates, so the model never does calendar maths', () => {
    const block = askContextBlock([], { now, timeZone: 'Europe/Amsterdam' });
    expect(block).toContain('Today is 2026-08-02');
    expect(block).toContain('yesterday was 2026-08-01');
  });

  it('names the weekday and the timezone', () => {
    const block = askContextBlock([], { now, timeZone: 'Europe/Amsterdam' });
    expect(block).toContain('Sunday');
    expect(block).toContain('Europe/Amsterdam');
  });

  /**
   * 06:43 UTC is 08:43 in Amsterdam — the same instant, a different day-of-week
   * boundary in the general case. Reading the clock off the host rather than the
   * owner's configured zone is the bug `almanac/decisions/day-boundaries-use-owner-timezone`
   * already caught once elsewhere.
   */
  it('renders the owner timezone rather than UTC', () => {
    expect(askContextBlock([], { now, timeZone: 'Europe/Amsterdam' })).toContain('08:43');
    expect(askContextBlock([], { now, timeZone: 'UTC' })).toContain('06:43');
  });

  it('crosses the day boundary in the owner zone, not UTC', () => {
    // 22:30 UTC on the 1st is already 00:30 on the 2nd in Amsterdam.
    const lateNight = new Date('2026-08-01T22:30:00.000Z');
    expect(askContextBlock([], { now: lateNight, timeZone: 'Europe/Amsterdam' })).toContain('Today is 2026-08-02');
    expect(askContextBlock([], { now: lateNight, timeZone: 'UTC' })).toContain('Today is 2026-08-01');
  });

  it('carries the search hits when there are some', () => {
    const block = askContextBlock(['a moment about AdGuard'], { now, timeZone: 'UTC' });
    expect(block).toContain('a moment about AdGuard');
    expect(block).toContain('Possibly relevant');
  });

  it('frames an empty search as a hint about which tool to use, not as a dead end', () => {
    const block = askContextBlock([], { now, timeZone: 'UTC' });
    // This used to end the request with "no memory to answer from yet".
    expect(block).toContain('use the tools');
    expect(block).not.toContain('Possibly relevant');
  });
});
