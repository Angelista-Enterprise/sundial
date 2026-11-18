import { afterEach, describe, expect, it } from 'vitest';
import { flatten } from './claude-code.js';
import { claudeArgs } from './runtime/index.js';
import { getLlmConfig, setLlmConfigSource } from './config.js';
import { systemOneBackend } from './systemone-text-model.js';
import { aliasLlmKeys } from '@sundial/helpers/sundial-config.js';

const withRoles = (roles: Record<string, string[]>) => ({ providers: [], use: {}, sources: {}, roles });
afterEach(() => setLlmConfigSource(null));

describe('the claude runtime source in llm.roles', () => {
  it('runs a background purpose and a judgement on the claude source, each on its listed model', () => {
    setLlmConfigSource(() => withRoles({ background: ['claude:sonnet'], judge: ['claude:opus'] }));
    expect(getLlmConfig('intent')).toEqual({ route: 'claude', source: 'claude', access: 'runtime', baseUrl: '', apiKey: null, model: 'sonnet', protocol: 'claude-cli' });
    expect(getLlmConfig('classify')?.model).toBe('opus');
    expect(systemOneBackend()).toBe('text-model');
  });

  it('keeps Jev first for its questions when the list says so, and a bare source gets the default model', () => {
    setLlmConfigSource(() => withRoles({ background: ['claude'], judge: ['jev', 'claude:sonnet'] }));
    expect(getLlmConfig('journal')?.model).toBe('sonnet');
    // Jev heads the list: its backend when its key is there; the text-model path (on claude) otherwise.
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    expect(systemOneBackend()).toBe('text-model');
    expect(getLlmConfig('judge')?.route).toBe('claude');
    process.env.TYPESAFE_API_KEY = 'k';
    expect(systemOneBackend()).toBe('jev');
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved;
  });

  it('reads the 2026-10-05 keys as aliases: llm.mode claude and hands.claude resolve as they did', () => {
    const was = aliasLlmKeys({ mode: 'claude', claude: { model: 'opus', judges: 'jev' } }, { claude: true, claudePath: '/opt/homebrew/bin/claude' });
    expect(was).toEqual({ roles: { background: ['claude:opus'], judge: ['jev', 'claude:sonnet'], jobs: ['claude'] }, sources: { claude: { access: 'runtime', runtime: 'claude-cli', path: '/opt/homebrew/bin/claude' } } });
    expect(aliasLlmKeys({ mode: 'claude', claude: { model: 'rm -rf /' } }, undefined).roles).toEqual({ background: ['claude:sonnet'], judge: ['claude:sonnet'] });
    // The new keys win over the alias, and off is off.
    expect(aliasLlmKeys({ mode: 'claude', roles: { background: 'tensorx:qwen/qwen3.8-flash-next' } }, { claude: false }).roles).toEqual({ background: ['tensorx:qwen/qwen3.8-flash-next'], judge: ['claude:sonnet'] });
    expect(aliasLlmKeys({ mode: 'normal' }, {}).roles).toEqual({});
    setLlmConfigSource(() => withRoles({}));
    expect(getLlmConfig('intent')?.route).not.toBe('claude');
  });

  it('flattens a conversation into one prompt and keeps the system apart', () => {
    expect(flatten([{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }])).toEqual({ system: 'S', prompt: 'Q' });
    const multi = flatten([{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'Q2' }]);
    expect(multi.prompt).toContain('User:\nQ\n\nAssistant:\nA\n\nUser:\nQ2');
  });

  it('runs isolated: no user settings, no session file, tools only as Sundial MCP when asked, never --bare', () => {
    const base = { cwd: '/c', prompt: 'Q', home: '/h' };
    const plain = claudeArgs({ ...base, model: 'sonnet', system: 'S', tools: 'none' });
    expect(plain).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--no-session-persistence', '--tools', '', '--output-format', 'stream-json', '--append-system-prompt', 'S', '--permission-mode', 'dontAsk']));
    expect(plain).not.toContain('--allowedTools');
    expect(plain).not.toContain('--bare');
    expect(JSON.parse(plain[plain.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: {} });
    const tools = claudeArgs({ ...base, model: 'sonnet', tools: 'read', schema: { type: 'object' }, maxUsd: 0.5 });
    expect(tools).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__sundial__*,WebSearch,WebFetch', '--tools', 'WebSearch,WebFetch', '--json-schema', '{"type":"object"}', '--max-budget-usd', '0.5']));
    expect(JSON.parse(tools[tools.indexOf('--mcp-config') + 1]).mcpServers.sundial.env).toEqual({ SUNDIAL_HOME: '/h' });
  });
});
