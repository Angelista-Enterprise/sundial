import { afterEach, describe, expect, it } from 'vitest';
import { firstOpenConfig, getLlmConfig, resolveRole, roleOf, setLlmConfigSource, setRouteHealthSource } from './config.js';

const far = { id: 'far', label: 'Far', baseUrl: 'https://llm.example.com/v1', model: 'big-model', protocol: 'openai-chat' as const };
const near = { id: 'near', label: 'Near', baseUrl: 'http://127.0.0.1:11434/v1', model: 'small', protocol: 'anthropic-messages' as const };
const llm = (roles: Record<string, string[]>, use: Record<string, string> = {}) => ({ providers: [far, near], use, sources: {}, roles });
const saved = { ...process.env };
afterEach(() => {
  setLlmConfigSource(null);
  setRouteHealthSource(null);
  process.env = { ...saved };
});

describe('the router', () => {
  it('maps a purpose to its role', () => {
    expect([roleOf('intent'), roleOf('classify'), roleOf('hand'), roleOf('companion'), roleOf(undefined)]).toEqual(['background', 'judge', 'jobs', 'lookout', 'background']);
  });

  it('a role list is the whole ordered list; a listed model replaces the provider default; jev and an unknown source are skipped', () => {
    setLlmConfigSource(() => llm({ background: ['near:tiny', 'far', 'jev', 'gone', 'claude:opus'] }));
    const out = resolveRole('journal');
    expect(out.map((c) => [c.route, c.model, c.access, c.protocol])).toEqual([['near', 'tiny', 'api', 'anthropic-messages'], ['far', 'big-model', 'api', 'openai-chat'], ['claude', 'opus', 'runtime', 'claude-cli']]);
    expect(getLlmConfig('journal')).toEqual(out[0]);
  });

  it('without a list, the one route llm.use or .env names, as before; lookout borrows the background list', () => {
    delete process.env.SUNDIAL_LLM_BASE_URL;
    setLlmConfigSource(() => llm({}, { intent: 'far' }));
    expect(resolveRole('intent').map((c) => c.route)).toEqual(['far']);
    expect(resolveRole('journal')).toEqual([]);
    process.env.SUNDIAL_LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
    process.env.SUNDIAL_LLM_MODEL = 'local-model';
    expect(resolveRole('journal').map((c) => [c.route, c.model, c.source])).toEqual([['openai', 'local-model', 'openai']]);
    setLlmConfigSource(() => llm({ background: ['far', 'openai:other'] }));
    expect(resolveRole('companion').map((c) => [c.route, c.model])).toEqual([['far', 'big-model'], ['openai', 'other']]);
  });

  it('the first open source answers a reservation; a held one is skipped; all held means the first', () => {
    setLlmConfigSource(() => llm({ background: ['far', 'near'] }));
    const held = new Set<string>(['far']);
    setRouteHealthSource((route) => held.has(route));
    expect(firstOpenConfig('intent')?.route).toBe('near');
    held.add('near');
    expect(firstOpenConfig('intent')?.route).toBe('far');
    setRouteHealthSource(null);
    expect(firstOpenConfig('intent')?.route).toBe('far');
  });
});
