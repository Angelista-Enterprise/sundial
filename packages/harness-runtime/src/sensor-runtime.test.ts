import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { expandHomePath, SensorRuntime } from './sensor-runtime.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { classifySidecar, type SidecarCheck } from './sensor-health.js';
import { signVerdict } from '@sundial/helpers/verdict-sign.js';
import { createVerdictHandler, startVerdictServer } from './verdict-listener.js';

describe('expandHomePath', () => {
  it('expands ~ and ~/ prefixes, passes real paths through', () => {
    expect(expandHomePath('~')).toBe(os.homedir());
    expect(expandHomePath('~/Projects/x')).toBe(path.join(os.homedir(), 'Projects/x'));
    expect(expandHomePath('/opt/thing')).toBe('/opt/thing');
  });
});

describe('pollTick isolates each sensor', () => {
  it('a sensor that throws does not skip the sensors after it', async () => {
    const appended: string[] = [];
    const runtime = new SensorRuntime({ appendSignal: async (type) => void appended.push(type), getState: () => null, config: loadSundialConfig() });
    const fields = runtime as unknown as Record<string, unknown>;
    for (const key of Object.keys(fields)) if (key.endsWith('Sensor')) fields[key] = { poll: () => [] };
    fields.calendarSensor = { poll: async () => { throw new TypeError("Cannot read properties of undefined (reading 'slice')"); } };
    fields.sleepWakeSensor = { poll: () => ({ type: 'test:after-calendar', payload: {} }) };
    await runtime.pollTickGuarded();
    expect(appended).toContain('test:after-calendar');
  });
});

describe('classifySidecar (ported from doctor.ts — semantics must not drift)', () => {
  const timed: SidecarCheck = { label: 'window', path: '/x', staleMs: 10_000 };
  const eventDriven: SidecarCheck = { label: 'sleep-wake', path: '/x', staleMs: null };

  it('classifies timer-driven files by age', () => {
    expect(classifySidecar(timed, 500)).toBe('ok');
    expect(classifySidecar(timed, 60_000)).toBe('stale');
    expect(classifySidecar(timed, null)).toBe('missing');
  });

  it('event-driven files are idle when absent, never stale', () => {
    expect(classifySidecar(eventDriven, null)).toBe('idle');
    expect(classifySidecar(eventDriven, 999_999_999)).toBe('ok');
  });

  it('opt-in: absent-and-disabled is off, absent-and-enabled is blocked (a fault)', () => {
    const optIn: SidecarCheck = { label: 'screen-ocr', path: '/x', staleMs: 30_000, optIn: true, enabled: false };
    expect(classifySidecar(optIn, null)).toBe('off');
    expect(classifySidecar({ ...optIn, enabled: true }, null)).toBe('blocked');
    expect(classifySidecar({ ...optIn, enabled: true }, 1_000)).toBe('ok');
  });
});

describe('verdict listener', () => {
  const TOKEN = 'test-token';
  async function withServer(run: (base: string, appended: unknown[]) => Promise<void>) {
    const appended: unknown[] = [];
    const server = await startVerdictServer({ appendSignal: async (type, payload, ts) => void appended.push({ type, payload, ts }), token: TOKEN, port: 0 });
    const address = server.address() as { address: string; port: number };
    try {
      await run(`http://${address.address}:${address.port}`, appended);
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  }
  it('binds loopback only and records a signed ntfy verdict on /verdict; refuses a bad signature and other routes', async () => {
    await withServer(async (base, appended) => {
      expect(base.startsWith('http://127.0.0.1:')).toBe(true);
      const send = (body: unknown) => fetch(`${base}/verdict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const good = { artifactKind: 'notice', artifactId: 'key-1', verdict: 'not-now', sig: signVerdict(TOKEN, 'notice', 'key-1', 'not-now') };
      expect((await send(good)).status).toBe(200);
      expect(appended).toEqual([{ type: 'feedback:verdict', payload: { artifactKind: 'notice', artifactId: 'key-1', verdict: 'not-now', via: 'ntfy' }, ts: undefined }]);
      expect((await send({ ...good, verdict: 'wrong' })).status).toBe(401);
      expect((await send({ artifactKind: 'notice', artifactId: 'key-1', verdict: 'maybe', sig: 'x' })).status).toBe(400);
      expect((await fetch(`${base}/ingest/phone`, { method: 'POST', body: '{}' })).status).toBe(404);
    });
  });
  it('handler is constructible without touching the token file when a token is given', () => {
    expect(typeof createVerdictHandler({ appendSignal: async () => {}, token: 't' })).toBe('function');
  });
});
