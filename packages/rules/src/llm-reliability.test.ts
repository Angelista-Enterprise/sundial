// W5 step 2: the breaker per model route.
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { BREAKER_FAILURES, BREAKER_PROBE_MS, RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS, llmReliability } from './llm-reliability.js';
import { reduce } from '@sundial/kernel/reduce.js';
import { RULE_MANIFEST } from './manifest.js';

const T0 = Date.parse('2026-09-01T09:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const SEC = 1000;
const ROUTE = 'puzzlebox-llm';

function base(): KernelState {
  const s = createInitialState('d1');
  return { ...s, config: { ...s.config, timezone: 'UTC' } };
}
let n = 0;
const ev = (type: string, ms: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${ms}-${(n += 1)}`, type, ts: at(ms), payload: { route: ROUTE, ...payload }, sanitized: true });
const failed = (ms: number, errorClass = 'network') => ev('llm:failed', ms, { callId: `c${ms}`, purpose: 'intent', errorClass, attempt: 1 });

function run(events: SanitizedEvent[], state = base()) {
  const said: string[] = [];
  for (const e of events) {
    const out = llmReliability(state, e);
    state = out.state;
    for (const fx of out.effects) if (fx.type === 'EmitEvent' && fx.event.type === 'notice:candidate') said.push((fx.event.payload as { key: string }).key);
  }
  return { state, said, r: state.reliability.llm[ROUTE] };
}

/** What `reserveLlmCall` asks of the fold: may a call on this route go at `ms`, and is it the probe? */
function gate(state: KernelState, ms: number): { go: boolean; probe: boolean } {
  const r = state.reliability.llm[ROUTE];
  if (r?.openUntil && T0 + ms < Date.parse(r.openUntil)) return { go: false, probe: false };
  return { go: true, probe: Boolean(r?.openedAt) };
}

describe('llmReliability (W5 step 2)', () => {
  it('10 failures in a row open the breaker and say so once', () => {
    const nine = run(Array.from({ length: BREAKER_FAILURES - 1 }, (_, i) => failed(i * SEC)));
    expect(nine.r).toMatchObject({ streak: 9, openedAt: null, openUntil: null });
    expect(nine.said).toEqual([]);
    const { r, said } = run([failed(9 * SEC), failed(10 * SEC), failed(11 * SEC)], nine.state);
    expect(r).toMatchObject({ streak: 12, longestClosed: BREAKER_FAILURES, openedAt: at(9 * SEC), openUntil: at(11 * SEC + BREAKER_PROBE_MS) });
    expect(said).toEqual([`sensor-health:llm-breaker:${ROUTE}`]);
  });

  it('a probe holds the route while in flight; a failed probe holds it 2 minutes more; a success closes it', () => {
    let { state } = run(Array.from({ length: 10 }, (_, i) => failed(i * SEC)));
    const due = 9 * SEC + BREAKER_PROBE_MS;
    expect(gate(state, due - 1)).toEqual({ go: false, probe: false });
    expect(gate(state, due)).toEqual({ go: true, probe: true });
    ({ state } = run([ev('llm:dispatched', due, { purpose: 'intent', callId: 'p1', caller: 'ScheduleLLM', probe: true })], state));
    expect(gate(state, due + SEC).go).toBe(false);
    ({ state } = run([failed(due + 5 * SEC)], state));
    expect(state.reliability.llm[ROUTE]!.openUntil).toBe(at(due + 5 * SEC + BREAKER_PROBE_MS));
    const closed = run([ev('llm:recovered', due + 3 * BREAKER_PROBE_MS, { callId: 'p2' })], state);
    expect(closed.r).toMatchObject({ streak: 0, openedAt: null, openUntil: null });
    expect(closed.said).toEqual([]);
    expect(gate(closed.state, due + 3 * BREAKER_PROBE_MS)).toEqual({ go: true, probe: false });
  });

  it('a cancelled call is not the route failing; calls and failures are counted per day', () => {
    const { r } = run([ev('llm:dispatched', 0, { purpose: 'ask' }), failed(SEC, 'cancelled'), ev('llm:dispatched', 2 * SEC, { purpose: 'ask' }), failed(3 * SEC)]);
    expect(r).toMatchObject({ streak: 1, days: [{ day: '2026-09-01', calls: 2, failed: 1 }] });
  });

  it('a dispatch without a route (every one before W5) changes nothing', () => {
    const s = base();
    expect(llmReliability(s, { id: 'e', type: 'llm:dispatched', ts: at(0), payload: { purpose: 'intent', callId: 'c' }, sanitized: true }).state).toBe(s);
  });

  it('through the manifest, the opening reaches the gate as a sensor-health candidate', () => {
    let state = base();
    const kinds: string[] = [];
    for (let i = 0; i < BREAKER_FAILURES; i++) {
      const out = reduce(state, failed(i * SEC), RULE_MANIFEST);
      state = out.state;
      for (const { effect } of out.effects) if (effect.type === 'EmitEvent' && effect.event.type === 'notice:candidate') kinds.push((effect.event.payload as { kind: string }).kind);
    }
    expect(kinds).toEqual(['sensor-health']);
    expect(state.reliability.llm[ROUTE]!.openedAt).toBe(at(9 * SEC));
  });

  it("the record's longest streak (158 failures, ~90 minutes): after opening, only probes are sent", () => {
    // Made-up arrivals shaped like the outage: a call wanted every 34 s for 90 minutes, every one failing.
    let state = base();
    let sent = 0;
    let sentAfterOpen = 0;
    let probes = 0;
    const WANTED = 158;
    for (let i = 0; i < WANTED; i++) {
      const ms = i * 34 * SEC;
      const { go, probe } = gate(state, ms);
      if (!go) continue;
      sent += 1;
      if (state.reliability.llm[ROUTE]?.openedAt) sentAfterOpen += 1;
      if (probe) probes += 1;
      state = run([ev('llm:dispatched', ms, { purpose: 'intent', callId: `c${i}`, ...(probe ? { probe: true } : {}) }), failed(ms + SEC)], state).state;
    }
    expect(sentAfterOpen).toBe(probes);
    expect(state.reliability.llm[ROUTE]!).toMatchObject({ streak: BREAKER_FAILURES + probes, longestClosed: BREAKER_FAILURES });
    expect(sentAfterOpen).toBeLessThanOrEqual(Math.ceil((WANTED * 34 * SEC) / BREAKER_PROBE_MS));
    expect(sent).toBe(BREAKER_FAILURES + probes);
    expect(sent).toBeLessThan(WANTED / 2);
  });

  it('a 429 is backpressure: 20 in a row open nothing, say nothing, and cool the route 5 s doubling to 2 min', () => {
    const { r, said } = run(Array.from({ length: 20 }, (_, i) => failed(i * SEC, 'rate-limit')));
    expect(r).toMatchObject({ streak: 0, openedAt: null, openUntil: null, rateLimited: 20, days: [{ day: '2026-09-01', calls: 0, failed: 20 }] });
    expect(said).toEqual([]);
    expect(r!.cooldownUntil).toBe(at(19 * SEC + RATE_LIMIT_MAX_MS));
    const waits = [1, 2, 3].map((k) => Date.parse(run(Array.from({ length: k }, () => failed(0, 'rate-limit'))).r!.cooldownUntil!) - T0);
    expect(waits).toEqual([RATE_LIMIT_BASE_MS, 2 * RATE_LIMIT_BASE_MS, 4 * RATE_LIMIT_BASE_MS]);
  });

  it("a 429's Retry-After sets the cooldown; a success resets the backoff; a 429 between failures keeps the streak", () => {
    let { state, r } = run([ev('llm:failed', 0, { callId: 'c', purpose: 'intent', errorClass: 'rate-limit', attempt: 1, retryAfterMs: 30 * SEC })]);
    expect(r!.cooldownUntil).toBe(at(30 * SEC));
    ({ state, r } = run([ev('llm:recovered', SEC, { callId: 'd' })], state));
    expect(r!.rateLimited).toBe(0);
    ({ r } = run([failed(2 * SEC), failed(3 * SEC, 'rate-limit'), failed(4 * SEC)], state));
    expect(r!.streak).toBe(2);
  });
});
