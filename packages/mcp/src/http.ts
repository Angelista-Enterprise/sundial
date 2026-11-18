import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
// fallow-ignore-next-line unresolved-import
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getSundialRuntimeDir } from '@sundial/helpers/sundial-paths.js';
import { createMcpServer } from './index.js';

/**
 * Track B1: the same server over Streamable HTTP, for hosts that take a local
 * HTTP server (VS Code, Cursor, Codex, Goose) rather than spawning one.
 *
 * Three fences, in this order, before a byte reaches the transport:
 *  1. Host and Origin must be the loopback. A page on any other origin (DNS
 *     rebinding, a tab on the LAN) is refused with 403; a client that sends no
 *     Origin (every editor does) passes, as the spec allows.
 *  2. A bearer token, kept in `$SUNDIAL_HOME/.daemon/mcp-token` (0600) and made
 *     on first use. Without it, 401. Same-user code can read the file; that is
 *     the local-first posture, not a hole: the file is the grant.
 *     With `--owner <name>` a second one, `mcp-owner-token`, opens a session
 *     with scope owner-host: a localhost app the owner clicks in (the
 *     observatory) counts as the owner's own hand, so the rule writes
 *     (`gnomon_adopt_rule` and its kin, mcp-writes.ts) go through for it and
 *     for nobody else. The same file posture: whoever can read it is the
 *     owner at this machine. A session keeps the scope it was opened with; a
 *     request bearing the other token on it is refused.
 *  3. Only `/mcp`. Anything else is 404.
 *
 * Sessions (B4; B1 was stateless): one McpServer and one transport per
 * `initialize`, kept by the `Mcp-Session-Id` the SDK mints, until the host
 * sends DELETE or the connection closes. A session is what lets the server
 * know the host's capabilities when a tool runs (`gnomon_open_ask` asks the
 * owner through elicitation only when the host declared it) and, later, what
 * B6's live updates ride on. Nothing is read from a session the token did not
 * open: the token check comes first on every request.
 *
 * Protocol revisions: the SDK negotiates. A client that asks for a revision
 * the SDK does not know (2026-07-28 is in no published SDK on 2026-10-05) is
 * answered with 2025-11-25, which is how the spec says a server offers its
 * latest; a client that asks for 2025-11-25 or older gets that one.
 */

export const DEFAULT_MCP_PORT = 3090;
export const MCP_PATH = '/mcp';

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** The token file, made on first use. Exported for `sundial` to print where it is. */
export function mcpTokenPath(): string {
  return path.join(getSundialRuntimeDir(), 'mcp-token');
}

/** The owner host's token file (`--owner`), made on first use like the other. */
export function mcpOwnerTokenPath(): string {
  return path.join(getSundialRuntimeDir(), 'mcp-owner-token');
}

export function mcpToken(file = mcpTokenPath()): string {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token.length >= 32) return token;
  } catch {
    /* not yet made */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOOPBACK.test(u.host);
  } catch {
    return false;
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = header?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The fences, as one function, so the test can name each refusal. Null when the request may pass. */
export function refuse(req: http.IncomingMessage, token: string, ownerToken?: string): { status: number; reason: string } | null {
  if (!LOOPBACK.test(req.headers.host ?? '')) return { status: 403, reason: 'Host is not the loopback' };
  if (!originAllowed(req.headers.origin)) return { status: 403, reason: 'Origin is not the loopback' };
  if (!tokenMatches(req.headers.authorization, token) && !(ownerToken !== undefined && tokenMatches(req.headers.authorization, ownerToken))) return { status: 401, reason: 'Bearer token missing or wrong' };
  if ((req.url ?? '').split('?')[0] !== MCP_PATH) return { status: 404, reason: `Only ${MCP_PATH} is served` };
  return null;
}

/** `owner`: the owner host's token and its name (`--owner <name>`); without it only the host token opens a session. */
export function createHttpServer(token: string, owner?: { token: string; name: string }): http.Server {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const ownerSessions = new Set<string>();
  return http.createServer(async (req, res) => {
    const no = refuse(req, token, owner?.token);
    if (no !== null) {
      if (no.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="sundial"');
      res.writeHead(no.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: no.reason }));
      return;
    }
    try {
      const id = req.headers['mcp-session-id'];
      const asOwner = owner !== undefined && tokenMatches(req.headers.authorization, owner.token);
      const known = typeof id === 'string' ? sessions.get(id) : undefined;
      if (known && ownerSessions.has(id as string) !== asOwner) {
        res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'This session was opened with the other token' }));
        return;
      }
      if (known) return await known.handleRequest(req, res);
      if (typeof id === 'string' || req.method !== 'POST') {
        // An unknown session (Sundial restarted, or the host closed it): the SDK's own answer, so the host reinitializes.
        res.writeHead(id === undefined ? 400 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: id === undefined ? 'No session: send initialize first' : 'Session not found' }, id: null }));
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport);
          if (asOwner) ownerSessions.add(sid);
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
          ownerSessions.delete(sid);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        if (transport.sessionId) ownerSessions.delete(transport.sessionId);
      };
      await createMcpServer(asOwner ? { ownerHost: owner!.name } : {}).connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(`[sundial mcp] http: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
}

export function startHttpServer(port = Number(process.env.SUNDIAL_MCP_PORT) || DEFAULT_MCP_PORT, ownerName?: string): Promise<http.Server> {
  const server = createHttpServer(mcpToken(), ownerName === undefined ? undefined : { token: mcpToken(mcpOwnerTokenPath()), name: ownerName });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
