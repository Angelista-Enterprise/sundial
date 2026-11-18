// fallow-ignore-next-line unresolved-import
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// fallow-ignore-next-line unresolved-import
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initializeDatabase } from '@sundial/db/db-migrate.js';
import type { ToolEnv } from '@sundial/kernel/tools/registry.js';
import { APP_TOOL_NAMES, registerApps } from './mcp-apps.js';
import { registerLive, type LiveOptions } from './mcp-live.js';
import { registerPrompts } from './mcp-prompts.js';
import { registerTools } from './mcp-tools.js';

/**
 * Phase 7's read surface (docs/design/04-data-model-and-read-surface.md) —
 * an MCP server another agent (Claude Code, or anything MCP-compatible) can
 * attach to. Same shape as the prior project's `@wcs/mcp` (server per-tool
 * over stdio), new tool set — see `mcp-tools.ts`'s doc comment for exactly
 * which tools this covers and which v1 tools were deliberately not ported
 * (no backing exists for them in this rewrite).
 *
 * Two transports, one registry: stdio (the default, what `claude mcp add`
 * spawns) and Streamable HTTP on the loopback (`--http`, see `http.ts`).
 * Six of the tools carry a page (MCP Apps, `mcp-apps.ts`); three prompts are
 * slash commands in the host (`mcp-prompts.ts`); two resources are live
 * (`mcp-live.ts`).
 */
/**
 * `env`: how a tool call reads the record; tests pass one with a made-up state. `live`: how the
 * live resources see the record move. `ownerHost`: the owner host's name, for a session opened
 * with the owner token (`http.ts`): its rule writes go through.
 */
export function createMcpServer({ env, live, ownerHost }: { env?: () => ToolEnv; live?: LiveOptions; ownerHost?: string } = {}): McpServer {
  const server = new McpServer(
    { name: 'sundial', version: '0.1.0' },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true }, prompts: {} } },
  );

  registerTools(server, { skip: APP_TOOL_NAMES, ownerHost, env });
  registerApps(server, env);
  registerPrompts(server, env);
  registerLive(server, env, live);

  return server;
}

export async function startMcpServer({ http = false, owner }: { http?: boolean; owner?: string } = {}): Promise<void> {
  if (owner !== undefined && (!http || !/^[A-Za-z0-9_-]{1,32}$/.test(owner))) throw new Error('--owner <name> needs --http, and a name of letters, digits, - or _ (at most 32)');
  await initializeDatabase();

  if (http) {
    const { startHttpServer, mcpTokenPath, mcpOwnerTokenPath, MCP_PATH } = await import('./http.js');
    const server = await startHttpServer(undefined, owner);
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : '?';
    console.error(`[sundial mcp] http://127.0.0.1:${port}${MCP_PATH}  (bearer token: ${mcpTokenPath()})`);
    if (owner !== undefined) console.error(`[sundial mcp] owner host "${owner}": its token is ${mcpOwnerTokenPath()}; a session opened with it may adopt, drop, pause and resume rules`);
    return;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
