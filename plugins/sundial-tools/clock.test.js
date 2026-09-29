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

describe('frozenPerTurn (Q12)', () => {
  const running = (id, turn) => ({ agent: { id, phase: { kind: 'running', turn, step: 1 } } });
  it('reads once per turn of each agent, and again on the next turn', async () => {
    const { frozenPerTurn } = await import('./clock.js');
    let n = 0;
    const context = frozenPerTurn({ name: 'x', order: 0, text: () => `read ${++n}` });
    expect(context.name).toBe('x');
    expect([context.text(running('a', 1)), context.text(running('a', 1)), context.text(running('b', 1)), context.text(running('a', 1))]).toEqual(['read 1', 'read 1', 'read 2', 'read 1']);
    expect(context.text(running('a', 2))).toBe('read 3');
  });
  it('resolves live without a running agent, and keeps a bounded memory', async () => {
    const { frozenPerTurn, MAX_FROZEN_AGENTS } = await import('./clock.js');
    let n = 0;
    const context = frozenPerTurn({ name: 'x', order: 0, text: () => `read ${++n}` });
    expect([context.text(undefined), context.text({ agent: { id: 'a', phase: { kind: 'idle', lastTurn: 3 } } })]).toEqual(['read 1', 'read 2']);
    for (let i = 0; i <= MAX_FROZEN_AGENTS; i += 1) context.text(running(`agent-${i}`, 1));
    // The first agent was dropped past the bound, so it reads again.
    expect(context.text(running('agent-0', 1))).toBe(`read ${n}`);
    expect(n).toBe(2 + MAX_FROZEN_AGENTS + 2);
  });
});
