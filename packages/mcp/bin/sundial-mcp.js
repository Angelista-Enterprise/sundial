#!/usr/bin/env node
// Sundial's MCP server for another agent — Claude Code, or anything that speaks
// MCP over stdio — so the coding agent you work with can ask what Sundial
// knows: what you did last on this branch, which files were hot, what the open
// commitment says, who a person is. Read-only by construction: every tool here
// is a read tool, and it reads the database the running Sundial writes.
//
// Register once, user-wide:
//   claude mcp add --scope user sundial -- node <repo>/packages/mcp/bin/sundial-mcp.js
// or run `sundial mcp`.
import { getDbUrl } from '@sundial/helpers/config.js';
import { startMcpServer } from '../dist/index.js';

process.env.DATABASE_URL ||= getDbUrl();

startMcpServer().catch((error) => {
  console.error('[sundial-mcp] failed to start:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
