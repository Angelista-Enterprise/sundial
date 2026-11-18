import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { FULL_DAY_INPUT_WINDOWS, streamSilence } from './stream-silence.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-07T00:00:00.000Z'); // a Monday
const ev = (type: string, ms: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${ms}`, type, ts: new Date(T0 + ms).toISOString(), payload, sanitized: true });
/** The n-th weekday from T0 (a day is judged against full days of its own weekday class): 0..4 = 09-07..09-11, 5 = 09-14, 6 = 09-15 … */
const weekday = (n: number) => Math.floor(n / 5) * 7 + (n % 5);

/** A full weekday `n`: input windows every 10 s from 08:00, a tick an hour, `extra` streams, and `llm` dispatches. */
function fullDay(n: number, extra: string[], llm: number): SanitizedEvent[] {
  const out: SanitizedEvent[] = [];
  n = weekday(n);
  const start = n * DAY + 8 * 3_600_000;
  for (let i = 0; i < FULL_DAY_INPUT_WINDOWS; i++) out.push(ev('input:activity', start + i * 10_000));
  for (let h = 0; h < 24; h++) out.push(ev('clock:tick', n * DAY + h * 3_600_000 + 1));
  for (const type of extra) out.push(ev(type, start + 60_000));
  for (let i = 0; i < llm; i++) out.push(ev('llm:dispatched', start + 120_000 + i));
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

function run(events: SanitizedEvent[]) {
  let state: KernelState = createInitialState('d1');
  state = { ...state, config: { ...state.config, timezone: 'UTC' } };
  const said: { key: string; observation: string }[] = [];
  for (const e of events) {
    const out = streamSilence(state, e);
    state = out.state;
    for (const fx of out.effects) if (fx.type === 'EmitEvent') said.push(fx.event.payload as never);
  }
  return { state, said };
}

describe('streamSilence', () => {
  it('says once, on the next day, which daily streams a full day missed, and a returning stream clears itself', () => {
    const events = [...Array(6).keys()].flatMap((n) => fullDay(n, ['git:status', 'presence:scan'], 100));
    events.push(...fullDay(6, ['git:status'], 100)); // presence dies
    events.push(...fullDay(7, ['git:status'], 100)); // still dead: not said again
    events.push(...fullDay(8, ['git:status', 'presence:scan'], 100)); // back
    const { state, said } = run(events);
    const streams = said.filter((s) => s.key.startsWith('sensor-health:streams:'));
    expect(streams.map((s) => s.key)).toEqual(['sensor-health:streams:2026-09-15']);
    expect(streams[0]!.observation).toContain('presence:scan');
    expect(streams[0]!.observation).not.toContain('git:status');
    expect(state.streamCoverage.silentSince).toEqual({});
  });

  it('says a full day whose pipeline ran under 30% of the usual', () => {
    const events = [...Array(6).keys()].flatMap((n) => fullDay(n, ['git:status'], 100));
    events.push(...fullDay(6, ['git:status'], 20));
    events.push(...fullDay(7, ['git:status'], 100));
    const { state, said } = run(events);
    expect(said.map((s) => s.key)).toEqual(['sensor-health:pipeline:2026-09-15']);
    expect(state.streamCoverage.outageDays).toEqual(['2026-09-15']);
  });

  it('judges a day once even when an input window, not a tick, opened the next day', () => {
    const events = [...Array(6).keys()].flatMap((n) => fullDay(n, ['git:status'], 100));
    const quiet = fullDay(6, [], 100).filter((e) => e.type !== 'clock:tick' || e.ts > '2026-09-15T09');
    events.push(...quiet, ...fullDay(7, ['git:status'], 100));
    const { said } = run(events);
    expect(said.filter((s) => s.key.startsWith('sensor-health:streams:'))).toHaveLength(1);
  });

  it('a day under five hours at the Mac is not judged', () => {
    const events = [...Array(6).keys()].flatMap((n) => fullDay(n, ['git:status'], 100));
    events.push(...fullDay(6, [], 100).filter((e) => e.type !== 'input:activity' || e.ts < '2026-09-15T09'), ...fullDay(7, ['git:status'], 100));
    expect(run(events).said).toEqual([]);
  });
});
