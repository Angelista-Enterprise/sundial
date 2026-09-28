// fallow-ignore-next-line unresolved-import
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
    server.tool(tool.name, tool.description, tool.schema, async (args: unknown) => textResult(await tool.handler(args as never)));
  }
}
