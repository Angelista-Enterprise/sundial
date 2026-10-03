import dns from 'node:dns';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installLastGoodLookup } from './dns-last-good.js';

type Answer = [Error | null, ...unknown[]];
const answers: Answer[] = [];
const failed = (code: string) => Object.assign(new Error(`getaddrinfo ${code} api.example.test`), { code });
const resolve = (host: string, options: object = {}) =>
  new Promise<{ error: NodeJS.ErrnoException | null; answer: unknown[] }>((done) => dns.lookup(host, options, (error, ...answer) => done({ error, answer })));

beforeAll(() => {
  // The real resolver, replaced by a queue of answers before the wrapper goes on top of it.
  (dns as unknown as { lookup: unknown }).lookup = (_host: string, _options: unknown, callback: (...a: unknown[]) => void) => callback(...answers.shift()!);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  installLastGoodLookup();
  installLastGoodLookup(); // twice is once
});

describe('installLastGoodLookup', () => {
  it('answers a name that stopped resolving with its last good address', async () => {
    answers.push([null, '203.0.113.7', 4], [failed('ENOTFOUND')], [failed('EAI_AGAIN')]);
    expect(await resolve('api.example.test')).toEqual({ error: null, answer: ['203.0.113.7', 4] });
    expect(await resolve('api.example.test')).toEqual({ error: null, answer: ['203.0.113.7', 4] });
    expect(await resolve('api.example.test')).toEqual({ error: null, answer: ['203.0.113.7', 4] });
  });

  it('keeps the `all: true` shape that fetch asks for apart from the single one', async () => {
    const all = [{ address: '203.0.113.8', family: 4 }];
    answers.push([null, all], [failed('ENOTFOUND')]);
    await resolve('api.example.test', { all: true });
    expect(await resolve('api.example.test', { all: true })).toEqual({ error: null, answer: [all] });
  });

  it('fails a host it never resolved, and any error that is not DNS', async () => {
    answers.push([failed('ENOTFOUND')], [failed('ECONNREFUSED')]);
    expect((await resolve('never.example.test')).error?.code).toBe('ENOTFOUND');
    expect((await resolve('api.example.test')).error?.code).toBe('ECONNREFUSED');
  });

  it('takes a new address as soon as the name resolves again', async () => {
    answers.push([null, '203.0.113.9', 4], [failed('ENOTFOUND')]);
    await resolve('api.example.test');
    expect((await resolve('api.example.test')).answer).toEqual(['203.0.113.9', 4]);
  });
});
