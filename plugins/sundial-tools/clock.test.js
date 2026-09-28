// The clock context exists because a model has no clock and the dsh persona is
// a static YAML string that cannot carry a date. These pin the two properties
// that make it a fix rather than a decoration: the date is actually stated, and
// it is re-read on every assembly rather than frozen at registration.
import { describe, it, expect } from 'vitest';
import { clockContext, CLOCK_CONTEXT_NAME, CLOCK_CONTEXT_ORDER } from './clock.js';

describe('clockContext', () => {
  it('states today, yesterday and the timezone, the way /ask always has', () => {
    const text = clockContext({ now: new Date('2026-08-02T12:00:00Z') }).text();
    expect(text).toContain('2026-08-02');
    // The measured failure was a model doing this subtraction itself and
    // landing four days out, so yesterday is spelled rather than implied.
    expect(text).toContain('2026-08-01');
    expect(text).toMatch(/YYYY-MM-DD/);
  });

  it('re-resolves per call — the companion session outlives midnight', () => {
    const context = clockContext();
    expect(typeof context.text).toBe('function');
    expect(context.text()).toBe(context.text());
    // A different fixed clock must produce a different line, which a value
    // captured at registration could not.
    const earlier = clockContext({ now: new Date('2026-08-02T12:00:00Z') }).text();
    const later = clockContext({ now: new Date('2026-08-03T12:00:00Z') }).text();
    expect(earlier).not.toBe(later);
  });

  it('sorts before dsh’s own runtime context', () => {
    expect(CLOCK_CONTEXT_ORDER).toBeLessThan(0);
    expect(clockContext()).toMatchObject({ name: CLOCK_CONTEXT_NAME, order: CLOCK_CONTEXT_ORDER });
  });
});
