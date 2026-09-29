/**
 * Phone ingest — a loopback-only HTTP listener replacing the daemon's
 * `POST /ingest/phone` route (apps/daemon/src/daemon/api/routes/ingest.ts)
 * for the harness era. Decision (PLAN.md Phase 3): a dedicated node:http
 * server on port 8767 (the old daemon owned 8765, and sundial-db probed it as
 * the legacy daemon's signature until 9a6988c; keep it dark), bound
 * STRICTLY to 127.0.0.1 — the phone reaches it via Tailscale Serve →
 * loopback, never a LAN bind.
 *
 * Same two guards as the daemon route:
 *   - bearer token, read from the SAME file the old daemon used
 *     (~/.sundial/.daemon/api-token) so the iOS app only changes the port;
 *   - every event's `type` MUST be in the `phone:*` family — a phone can add
 *     its own sensor readings and nothing else. Per-event payload validation
 *     stays in the `phoneTrack` rule, exactly as before.
 *
 * Body is a batch: `{ events: [{ type, ts?, payload }] }`. Responds 200 with
 * `{ ok, accepted, rejected }`; a batch in which NOTHING was accepted (and at
 * least one event was refused) is a category error and returns 400.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { getApiTokenPath } from '@sundial/helpers/sundial-paths.js';
import { VERDICTS, signVerdict } from '@sundial/helpers/verdict-sign.js';

export const PHONE_INGEST_PORT = Number(process.env.SUNDIAL_PHONE_PORT) || 8767;
export const PHONE_INGEST_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;

/** Constant-time compare, so the token cannot be learned a byte at a time from response timing. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Same generate-once token the daemon used (32 random bytes hex, file mode 0600). */
export function loadOrGenerateIngestToken(tokenPath: string = getApiTokenPath()): string {
  if (fs.existsSync(tokenPath)) {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (token) return token;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
  return token;
}

export interface PhoneIngestOptions {
  /** `ctx.gnomonKernel.appendSignal` — sanitize-at-ingest + fold, serialized. */
  appendSignal: (type: string, payload: Record<string, unknown>, ts?: string) => Promise<void>;
  token?: string;
  port?: number;
  /** Loopback only; overridable solely for tests (still must be a loopback address). */
  host?: string;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Read a bounded JSON object body, or answer 400/413 and call nothing. */
function readJson(req: http.IncomingMessage, res: http.ServerResponse, then: (body: Record<string, unknown>) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      json(res, 413, { error: 'body too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      json(res, 400, { error: 'body must be JSON' });
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      json(res, 400, { error: 'body must be a JSON object' });
      return;
    }
    then(body as Record<string, unknown>);
  });
}

/** Builds the request handler (exported for tests). */
export function createPhoneIngestHandler(options: PhoneIngestOptions): http.RequestListener {
  const token = options.token ?? loadOrGenerateIngestToken();
  return (req, res) => {
    // The owner's tap on an ntfy action (J0.8). No bearer: the action body
    // rides a public topic, so it carries an HMAC over its own three fields
    // instead (`verdict-sign.ts`). Rejected with the same 401 a bad token gets.
    if (req.method === 'POST' && req.url === '/verdict') {
      readJson(req, res, (body) => {
        const b = body as { artifactKind?: unknown; artifactId?: unknown; verdict?: unknown; sig?: unknown };
        const artifactKind = typeof b.artifactKind === 'string' ? b.artifactKind : '';
        const artifactId = typeof b.artifactId === 'string' ? b.artifactId.trim() : '';
        const verdict = typeof b.verdict === 'string' ? b.verdict : '';
        if (artifactKind === '' || artifactId === '' || !(VERDICTS as readonly string[]).includes(verdict)) {
          json(res, 400, { error: 'a verdict needs artifactKind, artifactId and one of useful / not-now / wrong' });
          return;
        }
        if (!sameSecret(String(b.sig ?? ''), signVerdict(token, artifactKind, artifactId, verdict))) {
          json(res, 401, { error: 'unauthorized' });
          return;
        }
        void options
          .appendSignal('feedback:verdict', { artifactKind, artifactId, verdict, via: 'ntfy' })
          .then(() => json(res, 200, { recorded: true, verdict }))
          .catch((error) => {
            console.error('[sundial-sensors] verdict failed:', error);
            if (!res.headersSent) json(res, 500, { error: 'internal error' });
          });
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/ingest/phone') {
      json(res, 404, { error: 'not found' });
      return;
    }
    const auth = req.headers.authorization ?? '';
    if (!sameSecret(auth, `Bearer ${token}`)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        json(res, 413, { error: 'body too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          json(res, 400, { error: 'body must be JSON' });
          return;
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          json(res, 400, { error: 'body must be a JSON object' });
          return;
        }
        const events = (body as { events?: unknown }).events;
        if (!Array.isArray(events)) {
          json(res, 400, { error: 'body.events must be an array' });
          return;
        }

        let accepted = 0;
        let rejected = 0;
        for (const raw of events) {
          if (typeof raw !== 'object' || raw === null) {
            rejected += 1;
            continue;
          }
          const e = raw as { type?: unknown; ts?: unknown; payload?: unknown };
          // Only the phone's own sensor family. Everything else is refused here,
          // not dropped quietly in a rule — a category error, not a malformed reading.
          // `health:*` (J3.1) rides the same door: the phone's own readings, nothing else.
          if (typeof e.type !== 'string' || !(e.type.startsWith('phone:') || e.type.startsWith('health:'))) {
            rejected += 1;
            continue;
          }
          const payload =
            typeof e.payload === 'object' && e.payload !== null && !Array.isArray(e.payload) ? (e.payload as Record<string, unknown>) : {};
          const ts = typeof e.ts === 'string' ? e.ts : undefined;
          await options.appendSignal(e.type, payload, ts);
          accepted += 1;
        }

        if (accepted === 0 && rejected > 0) {
          json(res, 400, { ok: false, accepted, rejected, error: "every event was refused (type must start with 'phone:' or 'health:')" });
          return;
        }
        json(res, 200, { ok: true, accepted, rejected });
      })().catch((error) => {
        console.error('[sundial-sensors] phone ingest failed:', error);
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
      });
    });
  };
}

/** Starts the listener bound to loopback. Returns the server; caller closes it in its disposer. */
export function startPhoneIngestServer(options: PhoneIngestOptions): Promise<http.Server> {
  const host = options.host ?? PHONE_INGEST_HOST;
  const port = options.port ?? PHONE_INGEST_PORT;
  const server = http.createServer(createPhoneIngestHandler(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
