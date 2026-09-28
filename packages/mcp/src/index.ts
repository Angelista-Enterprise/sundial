// fallow-ignore-next-line unresolved-import
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// fallow-ignore-next-line unresolved-import
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initializeDatabase } from '@sundial/db/db-migrate.js';
import { registerTools } from './mcp-tools.js';

/**
 * Phase 7's read surface (docs/design/04-data-model-and-read-surface.md) —
 * an MCP stdio server another agent (Claude Code, or anything MCP-
 * compatible) can attach to, alongside the existing `gnomon` CLI. Same
 * shape as the prior project's `@wcs/mcp` (server per-tool over stdio), new
 * tool set — see `mcp-tools.ts`'s doc comment for exactly which tools this
 * covers and which v1 tools were deliberately not ported (no backing exists
 * for them in this rewrite).
 */
function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'sundial', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  registerTools(server);

  return server;
}

export async function startMcpServer(): Promise<void> {
  await initializeDatabase();

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
