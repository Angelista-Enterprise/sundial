import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentRuntime, RuntimeEvent, RuntimeJob } from './port.js';

/**
 * The `claude -p` runtime: the owner's own unmodified Claude Code binary on the
 * owner's own login (docs/provider-architecture.md §8, decision 3). Never
 * `--bare` (it ignores the plan login), never a token, never the Agent SDK.
 * Isolated like a hand job: `--setting-sources project` (no user settings or
 * hooks), no session file, the install's variables stripped from the child, a
 * working folder of its own; Sundial's read tools reach it as MCP with its
 * home passed in `--mcp-config`, never in the environment. `--permission-mode
 * dontAsk` refuses anything else instead of prompting nobody.
 */
const MCP_BIN = fileURLToPath(new URL('../../../mcp/bin/sundial-mcp.js', import.meta.url));
const DEFAULT_TIMEOUT_MS = 180_000;
/** Claude Code's model aliases; `listModels` offers these. */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];

let found: string | null | undefined;
/** The binary: `configured` (config.json `llm.sources.claude.path`), `SUNDIAL_CLAUDE_BIN`, else `claude` on the login-shell PATH (the app's own PATH rarely has /opt/homebrew/bin). Null when absent. */
export function claudeBinary(configured: string | null = null): string | null {
  if (configured) return fs.existsSync(configured) ? configured : null;
  if (process.env.SUNDIAL_CLAUDE_BIN) return process.env.SUNDIAL_CLAUDE_BIN;
  if (found !== undefined) return found;
  try {
    const out = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 }).trim();
    found = out.startsWith('/') ? out : null;
  } catch {
    found = null;
  }
  return found;
}

/** Whether a variable names this install: a job's child must never inherit it, or a `sundial` call inside the job reaches the live record. `SUNDIAL_JOB_ID` is the one the night shift passes on purpose. */
export const isInstallKey = (key: string): boolean => (/^(SUNDIAL|DSH)_/.test(key) && key !== 'SUNDIAL_JOB_ID') || key === 'DATABASE_URL';
/** The named ones, for a place that must list them (tmux's `env -u`). */
export const INSTALL_ENV = ['SUNDIAL_HOME', 'DSH_HOME', 'SUNDIAL_WEB_PORT', 'SUNDIAL_PHONE_PORT', 'SUNDIAL_CHROME_PORT', 'SUNDIAL_LABEL', 'DATABASE_URL'];
/** `env` without the install's variables. */
export function jobEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && !isInstallKey(e[0])));
}

/** Sundial's MCP server as the one tool server a runtime gets; `home` travels inside, never in the child's environment. */
export const sundialMcp = (home: string) => ({ command: process.execPath, args: [MCP_BIN], env: { SUNDIAL_HOME: home } });

/** The argv, kept apart so a test can read it. */
export function claudeArgs(job: RuntimeJob): string[] {
  const read = job.tools === 'read';
  const mcp = read ? { mcpServers: { sundial: sundialMcp(job.home) } } : { mcpServers: {} };
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...(job.model ? ['--model', job.model] : []),
    ...(job.system ? ['--append-system-prompt', job.system] : []),
    ...(job.schema ? ['--json-schema', JSON.stringify(job.schema)] : []),
    ...(job.resume ? ['--resume', job.resume] : []),
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--tools', read ? 'WebSearch,WebFetch' : '',
    ...(read ? ['--allowedTools', 'mcp__sundial__*,WebSearch,WebFetch'] : []),
    '--permission-mode', 'dontAsk',
    ...(job.maxUsd !== undefined ? ['--max-budget-usd', String(job.maxUsd)] : []),
    ...(job.resume ? [] : ['--no-session-persistence']),
  ];
}

type Spawn = typeof nodeSpawn;
const text = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('') : '';

/** One `stream-json` line → the port's events. Exported for the fixture tests; unknown lines are nothing. */
export function claudeEvents(line: Record<string, unknown>): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const type = line.type;
  if (type === 'stream_event') {
    const ev = (line.event ?? {}) as { type?: string; delta?: { type?: string; text?: string } };
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) out.push({ type: 'text.delta', text: ev.delta.text });
  } else if (type === 'assistant') {
    for (const block of ((line.message as { content?: unknown[] } | undefined)?.content ?? []) as { type?: string; id?: string; name?: string; input?: unknown }[]) {
      if (block.type === 'tool_use') out.push({ type: 'tool.call', id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) });
    }
  } else if (type === 'user') {
    for (const block of ((line.message as { content?: unknown[] } | undefined)?.content ?? []) as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
      if (block.type === 'tool_result') out.push({ type: 'tool.result', id: String(block.tool_use_id ?? ''), text: text(block.content).slice(0, 4000), isError: block.is_error === true });
    }
  } else if (type === 'system' && line.subtype === 'api_retry') {
    // Not an error yet: Claude retries by itself. A limit shows in the final result when it gives up.
  } else if (type === 'result') {
    const u = (line.usage ?? {}) as Record<string, number | undefined>;
    const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    out.push({ type: 'usage', promptTokens: prompt || null, completionTokens: u.output_tokens ?? null, cacheReadTokens: u.cache_read_input_tokens ?? null, costUsd: typeof line.total_cost_usd === 'number' ? line.total_cost_usd : null });
    const result = typeof line.result === 'string' ? line.result : '';
    if (line.is_error === true) {
      const subtype = String(line.subtype ?? '');
      const message = `claude -p: ${(result || subtype).slice(0, 300)}`;
      const status = typeof line.api_error_status === 'number' ? line.api_error_status : undefined;
      const limit = status === 429 || status === 402 || /rate.?limit|usage limit|quota|max_budget|billing/i.test(`${result} ${subtype}`);
      const auth = status === 401 || status === 403 || /not logged in|authentication|invalid api key|sign in/i.test(result);
      out.push({ type: 'error', kind: limit ? 'limit' : auth ? 'auth' : 'other', message, ...(status !== undefined ? { status } : {}) });
    } else {
      out.push({ type: 'done', output: result, structured: line.structured_output, ...(typeof line.session_id === 'string' ? { sessionId: line.session_id } : {}) });
    }
  }
  return out;
}

/**
 * @param options.binary the owner's `claude`; `claudeBinary()` otherwise.
 * @param options.spawn Node's `spawn`, overridable in tests.
 */
export function claudeRuntime(options: { binary?: string | null; spawn?: Spawn } = {}): AgentRuntime {
  const spawn = options.spawn ?? nodeSpawn;
  // An explicit `binary` (null included) is final: a test or an install that found none must not search the PATH.
  const binary = () => ('binary' in options ? options.binary ?? null : claudeBinary());
  return {
    id: 'claude',
    async *run(job) {
      const bin = binary();
      if (!bin) {
        yield { type: 'error', kind: 'auth', message: 'No `claude` on the login PATH. Install Claude Code, or set SUNDIAL_CLAUDE_BIN or llm.sources.claude.path.' };
        return;
      }
      fs.mkdirSync(job.cwd, { recursive: true, mode: 0o700 });
      const queue: RuntimeEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      let stderr = '';
      let sawResult = false;
      let exitCode: number | null = null;
      // A failed result is held to the close, so it can carry why: our own timeout, an abort, the stderr tail.
      // The record (2026-10 to 2026-11): every "claude -p: error_during_execution" was our SIGINT at 180 s, said as nothing more.
      let failed: Extract<RuntimeEvent, { type: 'error' }> | null = null;
      let timedOut = false;
      const push = (...events: RuntimeEvent[]) => {
        queue.push(...events);
        wake?.();
      };
      const limitMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const child = spawn(bin, claudeArgs(job), { cwd: job.cwd, env: jobEnv(), stdio: ['pipe', 'pipe', 'pipe'], signal: job.signal });
      const timer = setTimeout(() => ((timedOut = true), child.kill('SIGINT')), limitMs);
      let buffer = '';
      const onLine = (raw: string) => {
        if (!raw.trim()) return;
        try {
          const line = JSON.parse(raw) as Record<string, unknown>;
          if (line.type === 'result') sawResult = true;
          for (const e of claudeEvents(line)) {
            if (e.type === 'error') failed = e;
            else push(e);
          }
        } catch {
          // A non-JSON line (a banner, a warning) is not an event.
        }
      };
      child.stdout?.on('data', (d: Buffer) => {
        buffer += d.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const l of lines) onLine(l);
      });
      child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      child.on('error', (e: Error) => push({ type: 'error', kind: 'other', message: `claude -p: ${e.message}` }));
      child.on('close', (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        onLine(buffer);
        buffer = '';
        exitCode = code;
        const why = timedOut ? `timed out after ${Math.round(limitMs / 1000)} s` : job.signal?.aborted ? `stopped: ${String(job.signal.reason ?? 'aborted').slice(0, 120)}` : null;
        const tail = stderr.trim().slice(-300);
        if (failed) {
          push({ ...failed, message: `${failed.message}${why ? ` (${why})` : ''}${tail ? `; stderr: ${tail}` : ''}` });
        } else if (!sawResult && !queue.some((e) => e.type === 'error')) {
          const auth = /not logged in|please run \/login|authentication|invalid api key/i.test(stderr);
          push({ type: 'error', kind: auth ? 'auth' : 'other', message: why ? `claude -p ${why}${tail ? `; stderr: ${tail}` : ''}` : signal ? `claude -p stopped (${signal})` : `claude -p exited ${code}: ${tail || 'no result'}` });
        }
        closed = true;
        wake?.();
      });
      child.stdin?.end(job.prompt);
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) break;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
      void exitCode;
    },
    async authStatus() {
      const bin = binary();
      if (!bin) return { ok: false, detail: 'no claude binary' };
      try {
        const out = execFileSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 10_000, env: jobEnv() });
        const parsed = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
        return { ok: parsed.loggedIn === true, detail: parsed.loggedIn ? `signed in (${parsed.authMethod ?? 'unknown'})` : 'not signed in' };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : String(error) };
      }
    },
    async listModels() {
      return CLAUDE_MODELS;
    },
  };
}
