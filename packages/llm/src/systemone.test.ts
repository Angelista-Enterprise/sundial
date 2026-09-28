import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmHttpError } from './transport.js';
import { callSystemOne } from './systemone.js';

/** A stand-in for api.typesafe.ai: answers whatever `respond` says, records what it saw. */
function mockJev(respond: (body: unknown) => { status: number; headers?: Record<string, string>; body: unknown }) {
  const seen: { auth: string | undefined; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      seen.push({ auth: req.headers.authorization, body });
      const out = respond(body);
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.body));
    });
  });
  return {
    seen,
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const a = server.address();
          resolve(typeof a === 'object' && a !== null ? `http://127.0.0.1:${a.port}/v1/systemone` : '');
        });
      }),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const QUESTIONS = { same: { type: 'noul' as const, instructions: 'Are these the same project?' } };

describe('callSystemOne', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('posts state, model and questions with the bearer, and maps answers, usage and status', async () => {
    const jev = mockJev(() => ({ status: 200, body: { answers: { same: { type: 'noul', noul: 0.82, confidence: 0.82 } }, usage: { input_tokens: 351, output_tokens: 20 } } }));
    process.env.SUNDIAL_SYSTEMONE_URL = await jev.start();
    try {
      const result = await callSystemOne({ a: 'x', b: 'y' }, QUESTIONS);
      expect(result.answers.same.noul).toBe(0.82);
      expect(result.inputTokens).toBe(351);
      expect(result.outputTokens).toBe(20);
      expect(result.statusCode).toBe(200);
      expect(result.model).toBe('jev-latest');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(jev.seen[0].auth).toBe('Bearer test-key');
      expect(jev.seen[0].body).toEqual({ state: { a: 'x', b: 'y' }, model: 'jev-latest', questions: QUESTIONS });
    } finally {
      await jev.stop();
    }
  });

  it('a non-2xx is an LlmHttpError carrying the status and Retry-After', async () => {
    const jev = mockJev(() => ({ status: 429, headers: { 'retry-after': '2' }, body: { error: 'slow down' } }));
    process.env.SUNDIAL_SYSTEMONE_URL = await jev.start();
    try {
      const error = await callSystemOne({}, QUESTIONS).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LlmHttpError);
      expect((error as LlmHttpError).status).toBe(429);
      expect((error as LlmHttpError).retryAfterMs).toBe(2000);
    } finally {
      await jev.stop();
    }
  });

  it('names ~/.sundial/.env when the key is missing, before any network', async () => {
    delete process.env.TYPESAFE_API_KEY;
    process.env.SUNDIAL_SYSTEMONE_URL = 'http://127.0.0.1:1/never';
    await expect(callSystemOne({}, QUESTIONS)).rejects.toThrow(/TYPESAFE_API_KEY.*\.env/);
  });
});
