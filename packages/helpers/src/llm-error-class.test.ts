import { describe, expect, it } from 'vitest';
import { classifyLlmError, classifyStoredLlmError, redactUrlCredentials, LLM_ERROR_CLASSES } from './llm-error-class.js';

/** The shape `@sundial/llm`'s transport throws on a non-2xx. */
function httpError(status: number): Error {
  const error = new Error(`LLM endpoint returned ${status}: {}`);
  error.name = 'LlmHttpError';
  (error as Error & { status: number }).status = status;
  return error;
}

describe('classifyLlmError — at the call site', () => {
  it('reads the status off an HTTP failure', () => {
    expect(classifyLlmError(httpError(429))).toBe('rate-limit');
    expect(classifyLlmError(httpError(401))).toBe('http-4xx');
    expect(classifyLlmError(httpError(503))).toBe('http-5xx');
  });

  it('calls our own AbortController deadline a timeout, not a cancellation', () => {
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    expect(classifyLlmError(aborted)).toBe('timeout');
  });

  it('reads the connection code out of a fetch failure cause', () => {
    const failed = new TypeError('fetch failed');
    (failed as TypeError & { cause: unknown }).cause = { code: 'ENOTFOUND' };
    expect(classifyLlmError(failed)).toBe('network');
  });

  it('never invents a class outside the nine', () => {
    for (const error of [null, undefined, 'a string', new Error('who knows')]) {
      expect(LLM_ERROR_CLASSES).toContain(classifyLlmError(error));
    }
  });
});

describe('redactUrlCredentials', () => {
  it('drops the query string, which is where a key travels', () => {
    expect(redactUrlCredentials('request to https://api.tensorx.ai/v1/chat/completions?api_key=sk-live-123 failed')).toBe(
      'request to https://api.tensorx.ai/v1/chat/completions failed',
    );
  });

  it('drops userinfo credentials', () => {
    expect(redactUrlCredentials('POST https://gnomon:hunter2@api.example.com/v1 refused')).toBe('POST https://api.example.com/v1 refused');
  });

  it('keeps the endpoint itself — which endpoint IS the diagnostic', () => {
    expect(redactUrlCredentials('TensorX API request to https://api.tensorx.ai/v1 failed')).toBe('TensorX API request to https://api.tensorx.ai/v1 failed');
  });

  it('leaves a message with no URL alone, question marks included', () => {
    expect(redactUrlCredentials('is the model awake? apparently not')).toBe('is the model awake? apparently not');
  });
});

describe('classifyStoredLlmError — legacy rows only', () => {
  it('turns a bare endpoint URL into a class instead of reporting the URL', () => {
    expect(classifyStoredLlmError('https://api.tensorx.ai/v1/chat/completions?key=secret')).toBe('network');
  });

  it('classifies the messages that used to report a URL as their reason', () => {
    expect(classifyStoredLlmError('TensorX API request to https://api.tensorx.ai/v1 failed')).toBe('network');
    expect(classifyStoredLlmError('TensorX API stream from https://api.tensorx.ai/v1 failed')).toBe('network');
    expect(classifyStoredLlmError('Connection error.')).toBe('network');
    expect(classifyStoredLlmError('content is not iterable')).toBe('parse');
  });

  it('matches the old reason table on the messages it was written for', () => {
    expect(classifyStoredLlmError('LLM endpoint returned 401: {"message":"No api key passed in."}')).toBe('http-4xx');
    expect(classifyStoredLlmError('LLM endpoint returned 503: upstream')).toBe('http-5xx');
    expect(classifyStoredLlmError('This operation was aborted')).toBe('cancelled');
    expect(classifyStoredLlmError('fetch failed')).toBe('network');
  });
});
