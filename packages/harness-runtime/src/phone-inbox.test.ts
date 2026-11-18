import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventsOf, startPhoneInbox } from './phone-inbox.js';

const msg = (id: string, body: unknown) => JSON.stringify({ id, time: 1_800_000_000, event: 'message', message: JSON.stringify(body) });

describe('eventsOf', () => {
  it('keeps phone and health events, with the hub time when the phone gave none', () => {
    const out = eventsOf(JSON.parse(msg('a', { events: [{ type: 'phone:place', payload: { label: 'home' } }, { type: 'health:sleep', ts: '2026-01-01T07:00:00.000Z', payload: {} }] })));
    expect(out).toEqual([
      { type: 'phone:place', payload: { label: 'home' }, ts: '2027-01-15T08:00:00.000Z' },
      { type: 'health:sleep', payload: {}, ts: '2026-01-01T07:00:00.000Z' },
    ]);
  });

  it('a phone time with an offset comes out in UTC', () => {
    const out = eventsOf(JSON.parse(msg('a', { events: [{ type: 'health:steps', ts: '2026-01-01T08:00:00.123456+01:00', payload: {} }] })));
    expect(out[0].ts).toBe('2026-01-01T07:00:00.123Z');
  });

  it('refuses any other type, and a body that is not the batch shape', () => {
    expect(eventsOf(JSON.parse(msg('a', { events: [{ type: 'feedback:verdict', payload: {} }] })))).toEqual([]);
    expect(eventsOf({ id: 'a', event: 'message', message: 'hello' })).toEqual([]);
    expect(eventsOf({ id: 'a', event: 'keepalive' })).toEqual([]);
  });
});

describe('startPhoneInbox', () => {
  it('folds each message once and resumes from the last id', async () => {
    const cursorPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'cursor');
    const urls: string[] = [];
    const got: string[] = [];
    const lines = `${msg('m1', { events: [{ type: 'phone:place', payload: { label: 'home' } }] })}\n{"event":"keepalive"}\n`;
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return new Response(lines);
    }) as unknown as typeof fetch;
    const stop = startPhoneInbox({ url: 'https://hub.example/t', cursorPath, fetch: fakeFetch, appendSignal: async (type) => void got.push(type) });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(urls[0]).toBe('https://hub.example/t/json?since=all');
    expect(got).toEqual(['phone:place']);
    expect(fs.readFileSync(cursorPath, 'utf-8')).toBe('m1');
  });
});
