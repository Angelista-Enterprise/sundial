import fs from 'node:fs';
import { jobEnv, sundialMcp } from './claude-cli.js';
import type { AgentRuntime, RuntimeEvent } from './port.js';

/**
 * The Copilot SDK runtime (docs/provider-architecture.md §8, decision 2): the
 * owner's own GitHub Copilot login, through `@github/copilot-sdk`, which drives
 * the bundled Copilot CLI runtime over JSON-RPC. GitHub bills the owner's own
 * plan and allows it ("Copilot usage is billed to each user's subscription").
 * The SDK is an optional dependency, loaded when a job first names the
 * `copilot` source, so an install without it still boots.
 *
 * Tools: Sundial's MCP server, read-only. A permission request for one of its
 * tools is approved; anything else is denied (approvals that ask the owner come
 * with step 5). Structured output is the SDK's preview; a schema answer is
 * parsed from the final message's text.
 */
export interface CopilotSdk {
  CopilotClient: new (options?: Record<string, unknown>) => CopilotClientLike;
}
export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; activeLogin?: string; statusMessage?: string }>;
  listModels(): Promise<{ id: string }[]>;
  createSession(config: Record<string, unknown>): Promise<CopilotSessionLike>;
}
export interface CopilotSessionLike {
  on(handler: (event: { type: string; data?: Record<string, unknown> }) => void): () => void;
  send(options: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const loadSdk = async (): Promise<CopilotSdk> => (await import('@github/copilot-sdk')) as unknown as CopilotSdk;

/** The SDK's `tool.execution_complete` result → the text a tool said; the shapes vary by tool, so this reads what it finds. */
/** A thrown SDK or RPC error → the port's error: a 403 "not authorized to use this Copilot feature" is a sign-in without a Copilot plan, auth; a quota is a limit. */
export function copilotFailure(error: unknown): Extract<RuntimeEvent, { type: 'error' }> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
  const limit = /rate.?limit|quota|exhausted|too many|429/i.test(message);
  const auth = /403|401|unauthori|not authorized|forbidden|not signed in|login/i.test(message);
  return { type: 'error', kind: limit ? 'limit' : auth ? 'auth' : 'other', message: `copilot: ${message}`.slice(0, 300), ...(limit ? { status: 429 } : auth ? { status: 403 } : {}) };
}

const resultText = (r: unknown): string => {
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  const o = r as Record<string, unknown>;
  return String(o.content ?? o.detailedContent ?? o.text ?? JSON.stringify(o)).slice(0, 4000);
};

/** One SDK session event → the port's events. Exported for the fixture tests. */
export function copilotEvents(event: { type: string; data?: Record<string, unknown> }): RuntimeEvent[] {
  const d = event.data ?? {};
  switch (event.type) {
    case 'assistant.message_delta':
      return typeof d.deltaContent === 'string' && d.deltaContent ? [{ type: 'text.delta', text: d.deltaContent }] : [];
    case 'tool.execution_start':
      return [{ type: 'tool.call', id: String(d.toolCallId ?? ''), name: String(d.toolName ?? ''), arguments: JSON.stringify(d.arguments ?? {}) }];
    case 'tool.execution_complete':
      return [{ type: 'tool.result', id: String(d.toolCallId ?? ''), text: resultText(d.result), isError: d.success === false }];
    case 'assistant.usage':
      return [{ type: 'usage', promptTokens: typeof d.inputTokens === 'number' ? d.inputTokens : null, completionTokens: typeof d.outputTokens === 'number' ? d.outputTokens : null, cacheReadTokens: typeof d.cacheReadTokens === 'number' ? d.cacheReadTokens : null, costUsd: typeof d.cost === 'number' ? d.cost : null }];
    case 'session.error': {
      const code = String(d.errorCode ?? d.errorType ?? '');
      const message = `copilot: ${String(d.message ?? code).slice(0, 300)}`;
      const limit = /rate.?limit|quota|exhausted|too many|budget/i.test(`${code} ${d.message ?? ''}`);
      const auth = /auth|unauthori|forbidden|login|sign.?in|token/i.test(`${code} ${d.message ?? ''}`);
      return [{ type: 'error', kind: limit ? 'limit' : auth ? 'auth' : 'other', message }];
    }
    default:
      return [];
  }
}

/**
 * @param options.load the SDK module; `import('@github/copilot-sdk')` otherwise (a fixture in tests).
 */
export function copilotRuntime(options: { load?: () => Promise<CopilotSdk> } = {}): AgentRuntime {
  const load = options.load ?? loadSdk;
  const client = async (cwd: string): Promise<CopilotClientLike> => {
    const { CopilotClient } = await load();
    const c = new CopilotClient({ workingDirectory: cwd, env: jobEnv(), logLevel: 'error' });
    await c.start();
    return c;
  };
  return {
    id: 'copilot',
    async *run(job) {
      let c: CopilotClientLike;
      try {
        fs.mkdirSync(job.cwd, { recursive: true, mode: 0o700 });
        c = await client(job.cwd);
      } catch (error) {
        yield { type: 'error', kind: 'other', message: `copilot: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
        return;
      }
      const queue: RuntimeEvent[] = [];
      let wake: (() => void) | null = null;
      let idle = false;
      let text = '';
      const push = (...events: RuntimeEvent[]) => {
        queue.push(...events);
        wake?.();
      };
      let session: CopilotSessionLike | undefined;
      const timer = setTimeout(() => push({ type: 'error', kind: 'other', message: 'copilot: timed out' }), job.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const auth = await c.getAuthStatus();
        if (!auth.isAuthenticated) {
          yield { type: 'error', kind: 'auth', message: `copilot: not signed in${auth.statusMessage ? ` (${auth.statusMessage})` : ''}` };
          return;
        }
        const read = job.tools === 'read';
        try {
        session = await c.createSession({
          ...(job.model ? { model: job.model } : {}),
          streaming: true,
          workingDirectory: job.cwd,
          ...(job.system ? { systemMessage: { mode: 'append', content: job.system } } : {}),
          ...(read ? { mcpServers: { sundial: { type: 'stdio', ...sundialMcp(job.home), tools: ['*'] } } } : { availableTools: [] }),
          // Sundial's read tools are allowed; a shell, a file edit or anything else is refused (step 5 asks the owner).
          onPermissionRequest: (request: { toolName?: string }) => (read && /^sundial[-_]/.test(String(request?.toolName ?? '')) ? { kind: 'approved' } : { kind: 'denied-by-rules' }),
        });
        session.on((event) => {
          if (event.type === 'assistant.message' && typeof event.data?.content === 'string') text = event.data.content;
          if (event.type === 'session.idle') {
            idle = true;
            wake?.();
            return;
          }
          push(...copilotEvents(event));
        });
        await session.send({ prompt: job.prompt, ...(job.schema ? { responseSchema: job.schema } : {}) });
        } catch (error) {
          yield copilotFailure(error);
          return;
        }
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (idle || queue.some((e) => e.type === 'error')) break;
          if (job.signal?.aborted) {
            yield { type: 'error', kind: 'other', message: 'copilot: stopped' };
            return;
          }
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
        while (queue.length > 0) yield queue.shift()!;
        if (idle) {
          let structured: unknown;
          if (job.schema) {
            try {
              structured = JSON.parse(text);
            } catch {
              structured = undefined;
            }
          }
          yield { type: 'done', output: text, structured };
        }
      } finally {
        clearTimeout(timer);
        await session?.disconnect().catch(() => undefined);
        await c.stop().catch(() => undefined);
      }
    },
    async authStatus() {
      try {
        const c = await client(process.cwd());
        try {
          const a = await c.getAuthStatus();
          if (!a.isAuthenticated) return { ok: false, detail: a.statusMessage ?? 'not signed in' };
          // Signed in to GitHub is not the same as entitled: a login without a Copilot plan lists no models (403).
          try {
            await c.listModels();
          } catch (error) {
            const f = copilotFailure(error);
            return { ok: false, detail: f.kind === 'auth' ? 'signed in, but this GitHub account is not authorized to use Copilot' : f.message };
          }
          return { ok: true, detail: `signed in${a.activeLogin ? ` as ${a.activeLogin}` : ''}` };
        } finally {
          await c.stop().catch(() => undefined);
        }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : String(error) };
      }
    },
    async listModels() {
      const c = await client(process.cwd());
      try {
        return (await c.listModels()).map((m) => m.id);
      } finally {
        await c.stop().catch(() => undefined);
      }
    },
  };
}
