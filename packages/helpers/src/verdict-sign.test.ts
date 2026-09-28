import { describe, expect, it } from 'vitest';
import { signVerdict, verdictActions } from './verdict-sign.js';

describe('signVerdict', () => {
  it('is stable, and changes with any field or the token', () => {
    const a = signVerdict('t', 'notice', 'k1', 'useful');
    expect(a).toBe(signVerdict('t', 'notice', 'k1', 'useful'));
    expect(a).toHaveLength(32);
    expect(a).not.toBe(signVerdict('t', 'notice', 'k1', 'wrong'));
    expect(a).not.toBe(signVerdict('t', 'notice', 'k2', 'useful'));
    expect(a).not.toBe(signVerdict('u', 'notice', 'k1', 'useful'));
  });
});

describe('verdictActions', () => {
  it('builds three ntfy http actions carrying a signed body and never the token', () => {
    const actions = verdictActions('https://mac.example.ts.net:8767/', 'secret', 'notice', 'k1');
    expect(actions.map((a) => a.label)).toEqual(['Useful', 'Not now', 'Wrong']);
    for (const a of actions) {
      expect(a.url).toBe('https://mac.example.ts.net:8767/verdict');
      expect(a.method).toBe('POST');
      expect(JSON.stringify(a)).not.toContain('secret');
      const body = JSON.parse(a.body as string);
      expect(body.sig).toBe(signVerdict('secret', 'notice', 'k1', body.verdict));
    }
  });

  it('is empty without a phone-reachable base', () => {
    expect(verdictActions('', 'secret', 'notice', 'k1')).toEqual([]);
  });
});
