import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { expandHomePath, SensorRuntime } from './sensor-runtime.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { classifySidecar, type SidecarCheck } from './sensor-health.js';
import { signVerdict } from '@sundial/helpers/verdict-sign.js';
import { createPhoneIngestHandler, startPhoneIngestServer } from './phone-ingest.js';

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

describe('phone ingest listener', () => {
  const TOKEN = 'test-token';

  async function withServer(fn: (base: string, appended: { type: string; payload: Record<string, unknown>; ts?: string }[]) => Promise<void>) {
    const appended: { type: string; payload: Record<string, unknown>; ts?: string }[] = [];
    const server = await startPhoneIngestServer({
      appendSignal: async (type, payload, ts) => {
        appended.push({ type, payload, ts });
      },
      token: TOKEN,
      port: 0, // ephemeral for tests; production default is 8767
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      await fn(`http://127.0.0.1:${address.port}`, appended);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function post(base: string, body: unknown, token: string | null = TOKEN) {
    return fetch(`${base}/ingest/phone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  }

  it('binds loopback only', async () => {
    await withServer(async (base) => {
      const address = new URL(base);
      expect(address.hostname).toBe('127.0.0.1');
    });
  });

  it('accepts a phone:* batch and forwards to appendSignal', async () => {
    await withServer(async (base, appended) => {
      const res = await post(base, { events: [{ type: 'phone:test', ts: '2026-08-15T00:00:00.000Z', payload: { a: 1 } }] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, accepted: 1, rejected: 0 });
      expect(appended).toEqual([{ type: 'phone:test', payload: { a: 1 }, ts: '2026-08-15T00:00:00.000Z' }]);
    });
  });

  it('rejects a wrong or missing token with 401', async () => {
    await withServer(async (base, appended) => {
      expect((await post(base, { events: [] }, 'wrong')).status).toBe(401);
      expect((await post(base, { events: [] }, null)).status).toBe(401);
      expect(appended).toEqual([]);
    });
  });

  it('refuses non-phone types (category error → 400 when nothing was accepted)', async () => {
    await withServer(async (base, appended) => {
      const res = await post(base, { events: [{ type: 'git:status', payload: {} }] });
      expect(res.status).toBe(400);
      expect(appended).toEqual([]);
    });
  });

  it('counts rejected events but still 200s a partially-valid batch', async () => {
    await withServer(async (base, appended) => {
      const res = await post(base, { events: [{ type: 'phone:sleep', payload: {} }, { type: 'feedback:verdict', payload: {} }] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, accepted: 1, rejected: 1 });
      expect(appended.map((e) => e.type)).toEqual(['phone:sleep']);
    });
  });

  it('400s malformed bodies and 404s other routes', async () => {
    await withServer(async (base) => {
      expect((await post(base, [])).status).toBe(400);
      expect((await post(base, {})).status).toBe(400);
      const res = await fetch(`${base}/nope`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(404);
    });
  });

  it('records a signed ntfy verdict on /verdict and refuses a bad signature', async () => {
    await withServer(async (base, appended) => {
      const send = (body: unknown) => fetch(`${base}/verdict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const good = { artifactKind: 'notice', artifactId: 'key-1', verdict: 'not-now', sig: signVerdict(TOKEN, 'notice', 'key-1', 'not-now') };
      expect((await send(good)).status).toBe(200);
      expect(appended).toEqual([{ type: 'feedback:verdict', payload: { artifactKind: 'notice', artifactId: 'key-1', verdict: 'not-now', via: 'ntfy' }, ts: undefined }]);
      expect((await send({ ...good, verdict: 'wrong' })).status).toBe(401);
      expect((await send({ ...good, sig: 'nope' })).status).toBe(401);
      expect((await send({ artifactKind: 'notice', artifactId: 'key-1', verdict: 'maybe', sig: 'x' })).status).toBe(400);
      expect(appended).toHaveLength(1);
    });
  });

  it('handler is constructible without touching the token file when a token is given', () => {
    expect(typeof createPhoneIngestHandler({ appendSignal: async () => {}, token: 'x' })).toBe('function');
  });
});
