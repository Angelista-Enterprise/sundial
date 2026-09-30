// lane H
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { noticeGroupOf } from '@sundial/kernel/notice-groups.js';
import { describe, expect, it } from 'vitest';
import { sensorHealth } from './sensor-health.js';

const T0 = Date.parse('2026-09-01T09:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

function base(): KernelState {
  const s = createInitialState('d1');
  return { ...s, config: { ...s.config, timezone: 'UTC' } };
}

const ev = (type: string, ms: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${ms}`, type, ts: at(ms), payload, sanitized: true });
const input = (ms: number, p: Record<string, unknown>) => ev('input:activity', ms, { keyDownCount: 0, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0, ...p });

/** Fold a sequence and collect every `sensor-health` candidate. */
function run(events: SanitizedEvent[], state = base()) {
  const said: { key: string; observation: string; ts: string }[] = [];
  for (const e of events) {
    const out = sensorHealth(state, e);
    state = out.state;
    for (const fx of out.effects) {
      if (fx.type === 'EmitEvent' && fx.event.type === 'notice:candidate') {
        const p = fx.event.payload as { key: string; observation: string; kind: string };
        expect(p.kind).toBe('sensor-health');
        said.push({ key: p.key, observation: p.observation, ts: fx.event.ts });
      }
    }
  }
  return { state, said };
}

/** A tick every minute from `from` to `to`, plus whatever else is given, in time order. */
function ticks(from: number, to: number): SanitizedEvent[] {
  const out: SanitizedEvent[] = [];
  for (let ms = from; ms <= to; ms += MIN) out.push(ev('clock:tick', ms));
  return out;
}
const byTime = (events: SanitizedEvent[]) => events.sort((a, b) => a.ts.localeCompare(b.ts));

describe('sensorHealth', () => {
  it('is its own switchable notice group', () => {
    expect(noticeGroupOf('sensor-health')).toBe('health');
  });

  it('says a dropped Input Monitoring grant once, after five minutes, and re-arms when it comes back', () => {
    const denied = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => input(m * MIN + 5_000, { listenAccessGranted: false, tapActive: false }));
    const { state, said } = run(byTime([...ticks(0, 8 * MIN), ...denied]));
    expect(said.map((s) => s.key)).toEqual(['sensor-health:input-grant']);
    expect(said[0]!.ts).toBe(at(6 * MIN)); // first tick past 5 min from the first denial at 0:05

    // Back, then gone again: a new incident is said again.
    const again = run(byTime([input(9 * MIN, { listenAccessGranted: true, tapActive: true }), ...ticks(9 * MIN, 20 * MIN), ...[10, 11, 12, 13, 14, 15, 16].map((m) => input(m * MIN + 5_000, { listenAccessGranted: false, tapActive: true }))]), state);
    expect(again.said.map((s) => s.key)).toEqual(['sensor-health:input-grant']);
  });

  it('says nothing for a grant that is back within five minutes', () => {
    const events = byTime([...ticks(0, 10 * MIN), input(10_000, { listenAccessGranted: false, tapActive: false }), input(3 * MIN, { listenAccessGranted: true, tapActive: true })]);
    expect(run(events).said).toEqual([]);
  });

  it('says clicks with no key press for 30 minutes, and not reading with a few clicks', () => {
    const clicking: SanitizedEvent[] = [];
    for (let ms = 0; ms <= 31 * MIN; ms += 10_000) clicking.push(input(ms, { mouseClickCount: 1 }));
    const { said } = run(byTime([...ticks(0, 32 * MIN), ...clicking]));
    expect(said.map((s) => s.key)).toEqual(['sensor-health:input-keys']);
    expect(said[0]!.observation).toMatch(/No key press has been counted for 30 minutes/);

    const reading: SanitizedEvent[] = [];
    for (let ms = 0; ms <= 31 * MIN; ms += 2 * 60_000) reading.push(input(ms, { mouseClickCount: 1 }));
    expect(run(byTime([...ticks(0, 32 * MIN), ...reading])).said).toEqual([]);

    // A few busy minutes of clicking through a browser, then away: 30+ clicks, but the mouse idle most of the half hour.
    const browsing: SanitizedEvent[] = [];
    for (let ms = 0; ms <= 31 * MIN; ms += 10_000) browsing.push(input(ms, ms <= 3 * MIN ? { mouseClickCount: 2 } : {}));
    expect(run(byTime([...ticks(0, 32 * MIN), ...browsing])).said).toEqual([]);
  });

  it('starts the key-less run again after a gap in the windows (a sleep)', () => {
    const events: SanitizedEvent[] = [];
    for (let ms = 0; ms <= 20 * MIN; ms += 10_000) events.push(input(ms, { mouseClickCount: 1 }));
    for (let ms = 5 * 60 * MIN; ms <= 5 * 60 * MIN + 15 * MIN; ms += 10_000) events.push(input(ms, { mouseClickCount: 1 }));
    expect(run(events).said).toEqual([]);
  });

  it('ignores stale windows: the counts are not a reading', () => {
    const events: SanitizedEvent[] = [];
    for (let ms = 0; ms <= 40 * MIN; ms += 10_000) events.push(input(ms, { mouseClickCount: 5, stale: true }));
    expect(run(events).said).toEqual([]);
  });

  it('says a stale heartbeat sidecar after five minutes, once', () => {
    const events = byTime([...ticks(0, 12 * MIN), ev('sensor:health', 30_000, { sidecars: { window: 'stale', notifications: 'ok' }, microphone: null, screenRecording: null, configUnreadable: false })]);
    const { said, state } = run(events);
    expect(said.map((s) => s.key)).toEqual(['sensor-health:sidecar:window']);
    expect(said[0]!.observation).toMatch(/window reader has stopped writing/);
    const healed = run([ev('sensor:health', 13 * MIN, { sidecars: { window: 'ok' } })], state);
    expect(healed.state.sensorHealth.troubles).toEqual({});
  });

  it('restarts a trouble clock on a wake, so a helper stale at lid-close is not said before it could write again', () => {
    const events = [ev('clock:tick', 0), ev('sensor:health', 30_000, { sidecars: { window: 'stale' } }), ev('clock:tick', MIN), ev('input:activity', 8 * 60 * MIN, {}), ev('clock:tick', 8 * 60 * MIN + 1000), ev('sensor:health', 8 * 60 * MIN + 30_000, { sidecars: { window: 'ok' } })];
    expect(run(events).said).toEqual([]);
  });

  it('says broken hearing and a refused Screen Recording grant', () => {
    const events = byTime([...ticks(0, 6 * MIN), ev('sensor:health', 0, { sidecars: {}, microphone: 'transcribe-failed', screenRecording: false, configUnreadable: false })]);
    expect(run(events).said.map((s) => s.key).sort()).toEqual(['sensor-health:microphone', 'sensor-health:screen-recording']);
    const fine = byTime([...ticks(0, 6 * MIN), ev('sensor:health', 0, { sidecars: {}, microphone: 'listening', screenRecording: true })]);
    expect(run(fine).said).toEqual([]);
  });

  it('says an unreadable config.json at once, and only once', () => {
    const events = [ev('sensor:health', 0, { sidecars: {}, configUnreadable: true }), ev('clock:tick', MIN), ev('clock:tick', 2 * MIN)];
    const { said } = run(events);
    expect(said.map((s) => s.key)).toEqual(['sensor-health:config']);
    expect(said[0]!.observation).toMatch(/config\.json could not be read/);
  });

  it('says a model provider after three auth refusals in a row, and a success resets the count', () => {
    const fail = (ms: number) => ev('llm:auth-failed', ms, { provider: 'jev', label: 'Jev', statusCode: 401 });
    const two = run([fail(0), fail(1000), ev('llm:auth-ok', 2000, { provider: 'jev' }), fail(3000), fail(4000)]);
    expect(two.said).toEqual([]);
    const three = run([fail(0), fail(1000), fail(2000), fail(3000)]);
    expect(three.said.map((s) => s.key)).toEqual(['sensor-health:llm-auth:jev']);
    expect(three.said[0]!.observation).toMatch(/Jev refused Sundial's key 3 times in a row \(HTTP 401\)/);
  });

  it('keeps budget and push outcomes for Settings without saying them', () => {
    const { state, said } = run([ev('llm:budget-exhausted', 0, { purpose: 'companion' }), ev('push:sent', MIN), ev('push:failed', 2 * MIN, { reason: 'timeout' })]);
    expect(said).toEqual([]);
    expect(state.sensorHealth.budgetExhausted).toEqual({ companion: '2026-09-01' });
    expect(state.sensorHealth.push).toEqual({ lastOkAt: at(MIN), lastFailedAt: at(2 * MIN), lastError: 'timeout' });
  });
});

describe('W6 D9: uptime and downtime', () => {
  it('counts minutes up per local day from the heartbeat, the last seven days', () => {
    const { state } = run([...ticks(0, 5 * MIN), ev('clock:tick', 24 * 60 * MIN)]);
    expect(state.sensorHealth.uptime).toEqual([
      { day: '2026-09-01', minutes: 6 },
      { day: '2026-09-02', minutes: 1 },
    ]);
  });

  it('says once, at the next start, that Sundial was down over an hour while the Mac was on; not when the Mac was off', () => {
    const up = (ms: number, lastSeenMs: number, bootMs: number) => ev('sundial:up', ms, { lastSeenAt: at(lastSeenMs), macBootAt: at(bootMs) });
    const down = run([ev('clock:tick', 0), up(3 * 60 * MIN, 0, -60 * MIN)]);
    expect(down.said).toHaveLength(1);
    expect(down.said[0]).toMatchObject({ key: 'sensor-health:downtime', observation: expect.stringContaining('not running for 3 hours') });
    // The Mac booted 20 minutes ago: it was off, not Sundial down.
    expect(run([ev('clock:tick', 0), up(3 * 60 * MIN, 0, 3 * 60 * MIN - 20 * MIN)]).said).toEqual([]);
    // A restart a minute later says nothing; the first tick after a said downtime re-arms it.
    expect(run([ev('clock:tick', 0), up(MIN, 0, -60 * MIN)]).said).toEqual([]);
    const after = run([ev('clock:tick', 3 * 60 * MIN + MIN)], down.state);
    expect(after.state.sensorHealth.troubles.downtime).toBeUndefined();
  });
});

describe('W6 D9: the downtime notice reaches the phone through the gate', () => {
  it('folds through the manifest to one phasic Notify that pushes', async () => {
    const { reduce } = await import('@sundial/kernel/reduce.js');
    const { RULE_MANIFEST } = await import('./manifest.js');
    let state = base();
    const notifies: { channel: string; acts?: string[] }[] = [];
    const feed = (e: SanitizedEvent) => {
      const out = reduce(state, e, RULE_MANIFEST);
      state = out.state;
      for (const { effect } of out.effects) if (effect.type === 'Notify') notifies.push({ channel: effect.channel, acts: (effect.payload as { acts?: string[] }).acts });
      // A candidate re-enters as its own event, as the executor does.
      for (const { effect } of out.effects) if (effect.type === 'EmitEvent') feed({ ...effect.event, sanitized: true } as SanitizedEvent);
    };
    feed(ev('clock:tick', 0));
    feed(ev('sundial:up', 3 * 60 * MIN, { lastSeenAt: at(0), macBootAt: at(-60 * MIN) }));
    expect(notifies.filter((n) => n.channel === 'phasic-notice')).toHaveLength(1);
    expect(notifies.find((n) => n.channel === 'phasic-notice')?.acts).toContain('push');
  });
});
