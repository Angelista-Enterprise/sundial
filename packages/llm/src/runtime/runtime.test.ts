import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeEvents, claudeRuntime } from './claude-cli.js';
import { copilotEvents, copilotRuntime, type CopilotSdk } from './copilot-sdk.js';
import { collectRun, runOnRuntimes, setRuntime, toChatCompletion, type AgentRuntime, type RuntimeEvent } from './index.js';

/** A `claude -p` that prints these stream-json lines (made-up data) and exits `code`. */
function fakeClaude(lines: unknown[], { code = 0, stderr = '' } = {}) {
  const calls: { args: string[]; cwd: string; env: Record<string, string>; prompt: string }[] = [];
  const spawn = ((_cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; signal?: AbortSignal }) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end: (s: string) => (record.prompt = s) }, kill: () => undefined });
    const record = { args, cwd: opts.cwd, env: opts.env, prompt: '' };
    calls.push(record);
    setImmediate(() => {
      if (opts.signal?.aborted) {
        child.emit('close', null, 'SIGINT');
        return;
      }
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      for (const l of lines) child.stdout.emit('data', Buffer.from(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`));
      child.emit('close', code, null);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawn, calls };
}
const result = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.012, session_id: 'sess-1', ...extra });
const job = { cwd: `${process.env.SUNDIAL_HOME ?? '/tmp'}/hands-test`, prompt: 'Which ticket?', tools: 'read' as const, home: '/h' };

describe('the claude -p runtime', () => {
  it('streams text, a tool round trip, usage and the result; the prompt goes in on stdin; the child gets no install variable', async () => {
    const { spawn, calls } = fakeClaude([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'BOX-' } } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__sundial__gnomon_tickets', input: { key: 'BOX-484' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '[{"key":"BOX-484"}]' }] }] } },
      result({ result: 'BOX-484 is open.' }),
    ]);
    const saved = process.env.SUNDIAL_HOME;
    process.env.SUNDIAL_HOME = '/live';
    try {
      const run = await collectRun(claudeRuntime({ binary: '/bin/claude', spawn }).run({ ...job, model: 'sonnet' }));
      expect(run).toMatchObject({ output: 'BOX-484 is open.', promptTokens: 15, completionTokens: 7, cacheReadTokens: 5, costUsd: 0.012, sessionId: 'sess-1', error: null, toolCalls: [{ id: 'tu1', name: 'mcp__sundial__gnomon_tickets', arguments: '{"key":"BOX-484"}' }] });
      expect(calls[0]!.prompt).toBe('Which ticket?');
      expect(calls[0]!.env.SUNDIAL_HOME).toBeUndefined();
      expect(calls[0]!.cwd).toBe(job.cwd);
      expect(toChatCompletion(run)).toMatchObject({ content: 'BOX-484 is open.', promptTokens: 15, completionTokens: 7, totalTokens: 22, finishReason: 'stop' });
    } finally {
      process.env.SUNDIAL_HOME = saved;
    }
  });

  it('a schema answer, a usage limit, an auth failure and a crash each come back as the event they are', async () => {
    const schema = await collectRun(claudeRuntime({ binary: '/bin/claude', spawn: fakeClaude([result({ result: '{"outcome":"nothing"}', structured_output: { outcome: 'nothing' } })]).spawn }).run({ ...job, schema: { type: 'object' } }));
    expect(schema.structured).toEqual({ outcome: 'nothing' });
    const limit = await collectRun(claudeRuntime({ binary: '/bin/claude', spawn: fakeClaude([result({ is_error: true, subtype: 'error_during_execution', result: "You've hit your usage limit. Try again at 3pm.", api_error_status: 429 })]).spawn }).run(job));
    expect(limit.error).toMatchObject({ kind: 'limit', status: 429 });
    expect(() => toChatCompletion(limit)).toThrow(expect.objectContaining({ status: 429 }));
    const budget = await collectRun(claudeRuntime({ binary: '/bin/claude', spawn: fakeClaude([result({ is_error: true, subtype: 'error_max_budget_usd' })]).spawn }).run(job));
    expect(budget.error?.kind).toBe('limit');
    const auth = await collectRun(claudeRuntime({ binary: '/bin/claude', spawn: fakeClaude([], { code: 1, stderr: 'Not logged in. Please run /login' }).spawn }).run(job));
    expect(auth.error).toMatchObject({ kind: 'auth' });
    const none = await collectRun(claudeRuntime({ binary: null }).run(job));
    expect(none.error).toMatchObject({ kind: 'auth', message: expect.stringContaining('No `claude`') });
    const crash = await collectRun(claudeRuntime({ binary: '/bin/claude', spawn: fakeClaude(['not json' as never], { code: 2, stderr: 'boom' }).spawn }).run(job));
    expect(crash.error).toMatchObject({ kind: 'other', message: expect.stringContaining('exited 2') });
  });

  it('a run cut by the timeout says so, with the stderr tail: a real fake binary that answers SIGINT the way claude -p did on the record', async () => {
    // The record's shape: nothing while it works; on SIGINT a result line with is_error, subtype
    // error_during_execution and no text, at $0 when nothing was spent. Made-up stderr.
    const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    const bin = join(dir, 'claude');
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, usage: {} });
    writeFileSync(bin, `#!/usr/bin/env node
process.stdin.resume();
process.on('SIGINT', () => {
  process.stderr.write('Request was aborted.\\n');
  process.stdout.write(${JSON.stringify(line + '\n')}, () => process.exit(0));
});
setInterval(() => {}, 1000);
`);
    chmodSync(bin, 0o755);
    const run = await collectRun(claudeRuntime({ binary: bin }).run({ ...job, cwd: join(dir, 'hands'), timeoutMs: 400 }));
    expect(run.error?.message).toContain('error_during_execution');
    expect(run.error?.message).toContain('timed out after 0 s');
    expect(run.error?.message).toContain('stderr: Request was aborted.');
  });

  it('claudeEvents: api_retry is not an error, an unknown line is nothing', () => {
    expect(claudeEvents({ type: 'system', subtype: 'api_retry', error: 'rate_limit' })).toEqual([]);
    expect(claudeEvents({ type: 'whatever' })).toEqual([]);
  });
});

/** A Copilot SDK whose one session plays `events` after `send`, or refuses sign-in. */
function fakeSdk(events: { type: string; data?: Record<string, unknown> }[], { authenticated = true } = {}) {
  const seen: { session: Record<string, unknown> | null; sent: Record<string, unknown> | null; stopped: boolean } = { session: null, sent: null, stopped: false };
  const sdk: CopilotSdk = {
    CopilotClient: class {
      async start() {}
      async stop() {
        seen.stopped = true;
      }
      async getAuthStatus() {
        return { isAuthenticated: authenticated, activeLogin: authenticated ? 'mira-bakker' : undefined, statusMessage: authenticated ? undefined : 'Run copilot login' };
      }
      async listModels() {
        return [{ id: 'claude-sonnet-4.5' }, { id: 'gpt-5' }];
      }
      async createSession(config: Record<string, unknown>) {
        seen.session = config;
        let handler: ((e: { type: string; data?: Record<string, unknown> }) => void) | null = null;
        return {
          on(h: (e: { type: string; data?: Record<string, unknown> }) => void) {
            handler = h;
            return () => undefined;
          },
          async send(options: Record<string, unknown>) {
            seen.sent = options;
            setImmediate(() => {
              for (const e of events) handler?.(e);
              handler?.({ type: 'session.idle' });
            });
          },
          async disconnect() {},
        };
      }
    },
  };
  return { sdk, seen };
}

describe('the Copilot SDK runtime', () => {
  it('runs a job on the owner\'s login: Sundial as its one MCP server, read tools approved, the rest denied, a schema answer parsed', async () => {
    const { sdk, seen } = fakeSdk([
      { type: 'assistant.message_delta', data: { deltaContent: '{"outcome":' } },
      { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'sundial-gnomon_tickets', arguments: { key: 'BOX-484' } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: '[]' } } },
      { type: 'assistant.usage', data: { inputTokens: 30, outputTokens: 9, cost: 0 } },
      { type: 'assistant.message', data: { content: '{"outcome":"nothing"}' } },
    ]);
    const run = await collectRun(copilotRuntime({ load: async () => sdk }).run({ ...job, model: 'gpt-5', system: 'Be brief.', schema: { type: 'object' } }));
    expect(run).toMatchObject({ output: '{"outcome":"nothing"}', structured: { outcome: 'nothing' }, promptTokens: 30, completionTokens: 9, error: null, toolCalls: [{ id: 'c1', name: 'sundial-gnomon_tickets', arguments: '{"key":"BOX-484"}' }] });
    expect(seen.session).toMatchObject({ model: 'gpt-5', streaming: true, systemMessage: { mode: 'append', content: 'Be brief.' } });
    const mcp = (seen.session!.mcpServers as Record<string, Record<string, unknown>>).sundial;
    expect(mcp).toMatchObject({ type: 'stdio', env: { SUNDIAL_HOME: '/h' } });
    const permit = seen.session!.onPermissionRequest as (r: { toolName: string }) => { kind: string };
    expect(permit({ toolName: 'sundial-gnomon_people' }).kind).toBe('approved');
    expect(permit({ toolName: 'bash' }).kind).toBe('denied-by-rules');
    expect(seen.sent).toMatchObject({ prompt: 'Which ticket?', responseSchema: { type: 'object' } });
    expect(seen.stopped).toBe(true);
  });

  it('a quota error is a limit, a sign-in that is missing is auth, and a plain error stops', async () => {
    const limited = await collectRun(copilotRuntime({ load: async () => fakeSdk([{ type: 'session.error', data: { errorCode: 'quota_exceeded', message: 'Monthly quota exhausted' } }]).sdk }).run(job));
    expect(limited.error).toMatchObject({ kind: 'limit' });
    const auth = await collectRun(copilotRuntime({ load: async () => fakeSdk([], { authenticated: false }).sdk }).run(job));
    expect(auth.error).toMatchObject({ kind: 'auth', message: expect.stringContaining('not signed in') });
    const broke = await collectRun(copilotRuntime({ load: async () => fakeSdk([{ type: 'session.error', data: { errorType: 'internal', message: 'boom' } }]).sdk }).run(job));
    expect(broke.error).toMatchObject({ kind: 'other' });
    const missing = await collectRun(copilotRuntime({ load: async () => { throw new Error("Cannot find package '@github/copilot-sdk'"); } }).run(job));
    expect(missing.error).toMatchObject({ kind: 'other', message: expect.stringContaining('copilot-sdk') });
    expect(copilotEvents({ type: 'commands.changed' })).toEqual([]);
    const rt = copilotRuntime({ load: async () => fakeSdk([]).sdk });
    expect(await rt.authStatus()).toEqual({ ok: true, detail: 'signed in as mira-bakker' });
    // A GitHub login without a Copilot plan: signed in, models refused with a 403.
    const noPlan = fakeSdk([]);
    noPlan.sdk.CopilotClient.prototype.listModels = async () => { throw new Error('Request models.list failed with message: GenericFailure, {"kind":"http","status":403,"body":"unauthorized: not authorized to use this Copilot feature"}'); };
    expect(await copilotRuntime({ load: async () => noPlan.sdk }).authStatus()).toEqual({ ok: false, detail: 'signed in, but this GitHub account is not authorized to use Copilot' });
    noPlan.sdk.CopilotClient.prototype.createSession = async () => { throw new Error('403 Forbidden: not authorized to use this Copilot feature'); };
    expect((await collectRun(copilotRuntime({ load: async () => noPlan.sdk }).run(job))).error).toMatchObject({ kind: 'auth', status: 403 });
    expect(await rt.listModels()).toEqual(['claude-sonnet-4.5', 'gpt-5']);
  });
});

/** A runtime that answers from a script, for the fallback. */
const scripted = (id: string, events: RuntimeEvent[]): AgentRuntime => ({ id, run: async function* () { yield* events; }, authStatus: async () => ({ ok: true, detail: '' }), listModels: async () => [] });
afterEach(() => {
  setRuntime('claude', null);
  setRuntime('copilot', null);
});

describe('runOnRuntimes', () => {
  it('a limit on the first runtime moves the job to the next; an attempt is announced and settled each time', async () => {
    setRuntime('copilot', scripted('copilot', [{ type: 'error', kind: 'limit', message: 'copilot: quota' }]));
    setRuntime('claude', scripted('claude', [{ type: 'done', output: 'ok', structured: { outcome: 'nothing' } }]));
    const seen: string[] = [];
    const out = await runOnRuntimes([{ source: 'copilot', model: 'gpt-5' }, { source: 'claude' }], job, (a) => void seen.push(`start ${a.index} ${a.source}`), (a, run) => void seen.push(`end ${a.index} ${run.error?.kind ?? 'ok'}`));
    expect(out).toMatchObject({ source: 'claude', attempts: 2, run: { structured: { outcome: 'nothing' } } });
    expect(seen).toEqual(['start 0 copilot', 'end 0 limit', 'start 1 claude', 'end 1 ok']);
  });

  it('an auth or other failure stops at that runtime; the last runtime has nowhere to go', async () => {
    setRuntime('copilot', scripted('copilot', [{ type: 'error', kind: 'auth', message: 'copilot: not signed in' }]));
    setRuntime('claude', scripted('claude', [{ type: 'done', output: 'ok' }]));
    expect((await runOnRuntimes([{ source: 'copilot' }, { source: 'claude' }], job)).source).toBe('copilot');
    setRuntime('copilot', scripted('copilot', [{ type: 'error', kind: 'limit', message: 'quota' }]));
    setRuntime('claude', scripted('claude', [{ type: 'error', kind: 'limit', message: 'limit' }]));
    const out = await runOnRuntimes([{ source: 'copilot' }, { source: 'claude' }], job);
    expect(out).toMatchObject({ source: 'claude', attempts: 2, run: { error: { kind: 'limit' } } });
  });
});
