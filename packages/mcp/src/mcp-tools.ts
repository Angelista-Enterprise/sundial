// fallow-ignore-next-line unresolved-import
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs';
import path from 'node:path';
import { getSundialRuntimeDir } from '@sundial/helpers/sundial-paths.js';
import { TOOL_REGISTRY } from '@sundial/kernel/tools/index.js';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * The MCP surface is now an adapter, not a definition.
 *
 * Every tool — its name, its description, its zod shape, its handler — lives in
 * `@sundial/kernel`'s `TOOL_REGISTRY`, because the same set has to be advertised
 * to an OpenAI-compatible endpoint for `/ask`'s tool loop. Two hand-maintained
 * lists would have drifted on the first tool added to either, and the drift
 * that already existed was the reason for the move: Claude Code could ask this
 * machine which files were edited today and Gnomon's own Ask page could not.
 *
 * All this file still owns is the shape of an MCP reply. `server.tool` takes
 * the raw zod shape directly, which is what the registry stores, so there is no
 * schema conversion on this side — `z.toJSONSchema` is only needed on the LLM
 * side, where the wire format is JSON Schema rather than zod.
 *
 * Deliberately NOT a mechanical port of all 21 v1 WCS MCP tools — see
 * `almanac/decisions/mcp-tool-scope-cut` for why the analytics tools whose
 * backing infrastructure this rewrite never built were dropped rather than
 * stubbed.
 */
export function registerTools(server: McpServer): void {
  for (const tool of TOOL_REGISTRY) {
    server.tool(tool.name, tool.description, tool.schema, async (args: unknown) => {
      const started = Date.now();
      try {
        const result = textResult(await tool.handler(args as never));
        recordMcpCall(tool.name, 'ok', started);
        return result;
      } catch (error) {
        recordMcpCall(tool.name, 'failed', started);
        throw error;
      }
    });
  }
}

/**
 * One line per call in `$SUNDIAL_HOME/.daemon/mcp-calls.jsonl`: which tool,
 * when, how it ended, how long it took — never its arguments, the same rule
 * the chat's `action:performed` rows keep.
 *
 * A file, not a signal. This server is a separate process, and a row it put
 * in `signals` would not be folded until the daemon's next boot replay, out of
 * order with everything the daemon folded meanwhile: the log has one writer.
 * Never throws — an audit that fails must not fail the read it records.
 */
export function recordMcpCall(tool: string, outcome: 'ok' | 'failed', startedMs: number, now = Date.now()): void {
  try {
    const dir = getSundialRuntimeDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ at: new Date(now).toISOString(), tool, outcome, ms: now - startedMs });
    fs.appendFileSync(path.join(dir, 'mcp-calls.jsonl'), `${line}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[sundial mcp] call audit not written: ${error instanceof Error ? error.message : String(error)}`);
  }
}
