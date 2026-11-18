import type { ChatCompletionResult } from '../types.js';

/**
 * The agent-runtime port (docs/provider-architecture.md §5, port 2): a vendor's
 * own agent loop on the owner's own login, driven as one job that streams
 * events. Sundial never sees a credential: the runtime signs in by itself
 * (`claude -p` on the owner's Claude Code, the Copilot SDK on their GitHub
 * login). Tools reach every runtime as Sundial's one MCP server, read-only;
 * writes queue for the owner. Approvals come later (step 5): a runtime that
 * cannot ask gets read tools only.
 */
export type RuntimeEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.call'; id: string; name: string; arguments: string }
  | { type: 'tool.result'; id: string; text: string; isError: boolean }
  | { type: 'usage'; promptTokens: number | null; completionTokens: number | null; cacheReadTokens?: number | null; costUsd?: number | null }
  | { type: 'done'; output: string; structured?: unknown; sessionId?: string }
  | { type: 'error'; kind: 'limit' | 'auth' | 'other'; message: string; status?: number };

export interface RuntimeJob {
  /** The runtime's own model name; its default when absent. */
  model?: string;
  /** The folder the runtime works in. Under `$SUNDIAL_HOME/.daemon/hands` the agent fleet skips it as Sundial's own work. */
  cwd: string;
  /** Appended to the runtime's system prompt (Gnomon's persona, a job preamble). */
  system?: string;
  prompt: string;
  /** `read`: Sundial's read tools over MCP (and the web tools where the runtime has them); `none`: text only. */
  tools: 'read' | 'none';
  /** A JSON schema the answer must match; `done.structured` carries the parsed object. */
  schema?: Record<string, unknown>;
  /** A cap on one job, in dollars at list price, where the runtime enforces one. */
  maxUsd?: number;
  /** `$SUNDIAL_HOME`: the MCP server's home, never the child's environment. */
  home: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** A previous session of this runtime to continue. */
  resume?: string;
}

export interface AgentRuntime {
  readonly id: string;
  run(job: RuntimeJob): AsyncIterable<RuntimeEvent>;
  authStatus(): Promise<{ ok: boolean; detail: string }>;
  listModels(): Promise<string[]>;
}

/** Everything one run said, flat: what a hand or a one-shot kernel call reads. */
export interface RuntimeRun {
  output: string;
  structured: unknown;
  toolCalls: { id: string; name: string; arguments: string }[];
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  sessionId: string | null;
  error: Extract<RuntimeEvent, { type: 'error' }> | null;
}

export async function collectRun(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeRun> {
  const run: RuntimeRun = { output: '', structured: undefined, toolCalls: [], promptTokens: null, completionTokens: null, cacheReadTokens: null, costUsd: null, sessionId: null, error: null };
  let streamed = '';
  for await (const e of events) {
    if (e.type === 'text.delta') streamed += e.text;
    else if (e.type === 'tool.call') run.toolCalls.push({ id: e.id, name: e.name, arguments: e.arguments });
    else if (e.type === 'usage') Object.assign(run, { promptTokens: e.promptTokens, completionTokens: e.completionTokens, cacheReadTokens: e.cacheReadTokens ?? null, costUsd: e.costUsd ?? null });
    else if (e.type === 'done') Object.assign(run, { output: e.output || streamed, structured: e.structured, sessionId: e.sessionId ?? null });
    else if (e.type === 'error') run.error = e;
  }
  if (!run.output && !run.error) run.output = streamed;
  return run;
}

/** A finished run as the kernel's flat result, or the error it must throw. */
export function toChatCompletion(run: RuntimeRun): ChatCompletionResult {
  if (run.error) throw runtimeError(run.error);
  const prompt = run.promptTokens ?? null;
  return {
    content: run.output,
    statusCode: 200,
    promptTokens: prompt,
    completionTokens: run.completionTokens,
    totalTokens: prompt !== null || run.completionTokens !== null ? (prompt ?? 0) + (run.completionTokens ?? 0) : null,
    toolCalls: [],
    finishReason: 'stop',
  };
}

/** A runtime's error as the kernel's status-aware error: a limit is a 429 (the retry layer waits, the router moves on), auth a 401. */
export function runtimeError(e: Extract<RuntimeEvent, { type: 'error' }>): Error & { status?: number; retryAfterMs?: number | null } {
  const error = new Error(e.message) as Error & { status?: number; retryAfterMs?: number | null };
  error.name = 'LlmHttpError';
  error.status = e.status ?? (e.kind === 'limit' ? 429 : e.kind === 'auth' ? 401 : 500);
  error.retryAfterMs = null;
  return error;
}
