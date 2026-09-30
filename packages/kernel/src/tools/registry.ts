import { z } from 'zod';
import type { ToolDefinition } from '@sundial/llm/types.js';
import type { KernelState } from '../types.js';
import { toolEnv } from '../tool-env.js';

/** What a call answers in: the instant, and the kernel state (live in the harness, the snapshot over MCP). */
export interface ToolEnv {
  now: Date;
  state: () => Promise<KernelState | null>;
}

/**
 * One tool, defined once, consumed by both the MCP server and `/ask`'s tool loop.
 *
 * Before this, `packages/mcp` owned eight `server.tool(...)` registrations and
 * `/ask` owned none — so Claude Code could ask this machine what files were
 * edited today and Gnomon's own Ask page could not. The two surfaces answering
 * from different capabilities was not a deliberate split; it was an artifact of
 * the MCP server being the only thing that had ever needed a tool. This module
 * is the single definition both now read, so a tool added for one arrives in the
 * other automatically and a description tuned in one cannot drift out of the
 * other.
 *
 * `parameters` for the LLM wire format is derived from the same zod shape MCP
 * registers, via `z.toJSONSchema` — zod 4 has it built in, so there is no
 * second hand-written JSON Schema to keep in sync and no new dependency.
 */
export interface GnomonTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /**
   * Written for the model, not for a docs page. Several of these carry an
   * explicit warning about how the value can mislead (`gnomon_current_context`
   * on `ambientProjectPointer`, `gnomon_signals` on telemetry volume) — that
   * text is load-bearing and should not be trimmed for brevity.
   */
  description: string;
  schema: S;
  /**
   * Whether this tool is a pure read.
   *
   * Declared rather than assumed so the loop, the audit trail and any future
   * confirmation gate can tell an action from a query mechanically, rather
   * than by reading a name prefix and failing the first time someone names a
   * tool badly. Every kernel tool is `true` today; the one `false`
   * (`gnomon_show_view`, which moved the app window) was deleted 2026-09-28.
   *
   * A `false` here is not a licence to reach outside the window.
   * `almanac/decisions/assistant-as-an-event-source` still holds: this
   * assistant may speak, propose and claim.
   */
  readOnly: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, env: ToolEnv) => Promise<unknown>;
}

/** Thrown when the model names a tool that does not exist. The loop turns it into a tool result listing what does. */
export class UnknownToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`no such tool: ${toolName}`);
    this.name = 'UnknownToolError';
  }
}

/** Thrown when arguments fail their zod shape. The message is zod's own, so the model is told which field was wrong rather than that something was. */
export class ToolArgumentError extends Error {
  constructor(toolName: string, detail: string) {
    super(`invalid arguments for ${toolName}: ${detail}`);
    this.name = 'ToolArgumentError';
  }
}

/**
 * Populated by `./index.ts` rather than declared here, so a tool module can
 * import the `GnomonTool` type without importing the array that contains it.
 */
export function toolDefinitions(tools: GnomonTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // `io: 'input'` keeps optional fields out of `required` — the OpenAI tool
    // schema is describing what the model may SEND, and the output-shaped
    // default marks every field required, which makes a model dutifully invent
    // values for optional filters rather than omitting them.
    parameters: z.toJSONSchema(z.object(tool.schema), { io: 'input' }) as Record<string, unknown>,
  }));
}

/**
 * Validate and run. Throws `UnknownToolError`/`ToolArgumentError`/whatever the
 * handler throws; the caller decides how to report it.
 *
 * Deliberately does NOT catch: the tool loop in `@sundial/llm` turns every
 * failure into a tool result the model reads and retries against, and that
 * formatting belongs in one place. A registry that swallowed errors into a
 * result object would give the loop two failure channels to reconcile.
 */
export async function executeTool(tools: GnomonTool[], name: string, args: unknown, env: ToolEnv = toolEnv()): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new UnknownToolError(name);

  const parsed = z.object(tool.schema).safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ToolArgumentError(name, detail);
  }

  return tool.handler(parsed.data as z.infer<z.ZodObject<typeof tool.schema>>, env);
}
