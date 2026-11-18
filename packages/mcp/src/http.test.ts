import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
// fallow-ignore-next-line unresolved-import
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// fallow-ignore-next-line unresolved-import
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// fallow-ignore-next-line unresolved-import
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './index.js';
import { createHttpServer, mcpOwnerTokenPath, mcpToken, refuse } from './http.js';

/**
 * B1: the same tools over stdio and over Streamable HTTP on the loopback,
 * and the three refusals at the door. No database: `tools/list` reads the
 * registry only, and the token lives in a temp SUNDIAL_HOME.
 */
const TOKEN = 'a'.repeat(64);
let home: string;
let base: string;
let server: ReturnType<typeof createHttpServer>;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-mcp-http-'));
  process.env.SUNDIAL_HOME = home;
  process.env.DATABASE_URL = 'file::memory:';
  server = createHttpServer(TOKEN);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = {}, url = `${base}/mcp`) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });

const initialize = (protocolVersion: string) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '0' } } });

/** The one JSON-RPC result in a response, whether it came as JSON or as one SSE event. */
async function resultOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? text;
  return (JSON.parse(data) as { result: Record<string, unknown> }).result;
}

/** The tool names a stdio client would see: the real stdio transport over a pair of pipes, no child process. */
async function stdioToolNames(): Promise<string[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  stdout.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
  await createMcpServer().connect(new StdioServerTransport(stdin, stdout));
  stdin.write(`${JSON.stringify(initialize('2025-11-25'))}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const reply = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2) as { result: { tools: { name: string }[] } };
  return reply.result.tools.map((t) => t.name).sort();
}

describe('the MCP server over Streamable HTTP (B1)', () => {
  it('serves the same tool list as stdio, from one registry', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    const over = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    expect(over).toEqual(await stdioToolNames());
    expect(over).toContain('gnomon_current_context');
    expect(over).toContain('gnomon_notice_seen');
  });

  it('refuses a wrong Origin, no token, a wrong token, and any other path', async () => {
    expect((await post(initialize('2025-11-25'), { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(initialize('2025-11-25'), { origin: 'http://192.168.1.20:3090' })).status).toBe(403);
    const none = await post(initialize('2025-11-25'), { authorization: '' });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    expect((await post(initialize('2025-11-25'), { authorization: `Bearer ${'b'.repeat(64)}` })).status).toBe(401);
    expect((await post(initialize('2025-11-25'), {}, `${base}/`)).status).toBe(404);
    // And a loopback Origin passes: the web client's own page, or a browser-side host.
    expect((await post(initialize('2025-11-25'), { origin: 'http://localhost:3080' })).status).toBe(200);
  });

  it('answers both protocol revisions: 2025-11-25 as itself, 2026-07-28 negotiated down to the newest the SDK speaks', async () => {
    expect((await resultOf(await post(initialize('2025-11-25')))).protocolVersion).toBe('2025-11-25');
    expect((await resultOf(await post(initialize('2026-07-28')))).protocolVersion).toBe('2025-11-25');
    expect((await resultOf(await post(initialize('2025-06-18')))).protocolVersion).toBe('2025-06-18');
  });

  it('keeps a session per host (B4), and tells an unknown or missing one to initialize', async () => {
    const init = await post(initialize('2025-11-25'));
    const sid = init.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    await init.text();
    const listed = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-session-id': sid! });
    expect(listed.status).toBe(200);
    expect(((await resultOf(listed)).tools as unknown[]).length).toBeGreaterThan(30);
    expect((await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'mcp-session-id': 'not-a-session' })).status).toBe(404);
    expect((await post({ jsonrpc: '2.0', id: 5, method: 'tools/list' })).status).toBe(400);
    const closed = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid! } });
    expect(closed.status).toBe(200);
    expect((await post({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, { 'mcp-session-id': sid! })).status).toBe(404);
  });

  it('keeps its token private in .daemon/, and makes one once', () => {
    const first = mcpToken();
    expect(first).toHaveLength(64);
    expect(mcpToken()).toBe(first);
    expect(fs.statSync(path.join(home, '.daemon', 'mcp-token')).mode & 0o777).toBe(0o600);
  });

  it('names each refusal', () => {
    const req = (headers: Record<string, string>, url = '/mcp') => ({ headers, url }) as never;
    expect(refuse(req({ host: "127.0.0.1:3090", authorization: `Bearer ${TOKEN}` }), TOKEN)).toBeNull();
    expect(refuse(req({ host: '[::1]:3090', authorization: `Bearer ${TOKEN}` }, '/mcp?x=1'), TOKEN)).toBeNull();
    // fetch cannot forge Host, so the rebinding case is checked here: a name that resolves to this box is still not the loopback.
    expect(refuse(req({ host: 'sundial.example:3090', authorization: `Bearer ${TOKEN}` }), TOKEN)?.status).toBe(403);
    expect(refuse(req({ host: '127.0.0.1:3090', origin: 'null', authorization: `Bearer ${TOKEN}` }), TOKEN)?.status).toBe(403);
    expect(refuse(req({ host: '127.0.0.1:3090', origin: 'https://127.0.0.1:3090', authorization: `Bearer ${TOKEN}` }), TOKEN)?.status).toBe(403);
  });
});

describe('the owner host (observatory §5)', () => {
  const OWNER = 'c'.repeat(64);
  let ownerBase: string;
  let ownerServer: ReturnType<typeof createHttpServer>;
  beforeAll(async () => {
    ownerServer = createHttpServer(TOKEN, { token: OWNER, name: 'observatory' });
    await new Promise<void>((r) => ownerServer.listen(0, '127.0.0.1', r));
    const address = ownerServer.address();
    ownerBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(async () => {
    await new Promise((r) => ownerServer.close(r));
  });
  const callTool = async (token: string, name: string, args: Record<string, unknown>) => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ownerBase}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const out = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    await client.close();
    return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
  };

  it('a session opened with the owner token may drop a rule; one opened with the host token is told how to become one', async () => {
    expect(await callTool(TOKEN, 'gnomon_drop_rule', { id: 'slack-burst' })).toEqual({ error: 'owner host only: run sundial mcp --http --owner <name> and use mcp-owner-token' });
    expect(await callTool(OWNER, 'gnomon_drop_rule', { id: 'slack-burst' })).toMatchObject({ queued: true, id: 'slack-burst' });
    const dir = path.join(home, '.daemon', 'mcp-writes');
    const queued = fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    expect(queued).toEqual([expect.objectContaining({ write: 'drop', body: { id: 'slack-burst', host: 'observatory' } })]);
  });

  it('the owner token opens nothing on a server started without --owner, and a session keeps the token it was opened with', async () => {
    expect((await post(initialize('2025-11-25'), { authorization: `Bearer ${OWNER}` })).status).toBe(401);
    const init = await fetch(`${ownerBase}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${OWNER}` }, body: JSON.stringify(initialize('2025-11-25')) });
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();
    const swapped = await fetch(`${ownerBase}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(swapped.status).toBe(403);
  });

  it('keeps the owner token in its own file, 0600', () => {
    const first = mcpToken(mcpOwnerTokenPath());
    expect(first).not.toBe(mcpToken());
    expect(fs.statSync(path.join(home, '.daemon', 'mcp-owner-token')).mode & 0o777).toBe(0o600);
  });
});
