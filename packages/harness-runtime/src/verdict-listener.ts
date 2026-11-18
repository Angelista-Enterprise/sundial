/**
 * The way back from the phone (J0.8): an ntfy action button POSTs the owner's
 * verdict here. It used to be one route of the phone ingest listener; when that
 * listener was dropped on 2026-10-14 this route went with it, and the buttons
 * pointed at nothing for twenty minutes. Loopback only, :8767 as before, so the
 * Tailscale Serve route the owner set up (`notifications.verdictUrl`) still
 * reaches it. No bearer: the body rides a public topic, so it carries an HMAC
 * over its own three fields instead (`verdict-sign.ts`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { getApiTokenPath } from '@sundial/helpers/sundial-paths.js';
import { VERDICTS, signVerdict } from '@sundial/helpers/verdict-sign.js';

export const VERDICT_PORT = Number(process.env.SUNDIAL_PHONE_PORT) || 8767;
export const VERDICT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The signing secret, created once at `$SUNDIAL_HOME/.daemon/api-token` (mode 0600). */
export function loadOrGenerateApiToken(tokenPath: string = getApiTokenPath()): string {
  if (fs.existsSync(tokenPath)) {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (token) return token;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
  return token;
}

export interface VerdictListenerOptions {
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

export function createVerdictHandler(options: VerdictListenerOptions): http.RequestListener {
  const token = options.token ?? loadOrGenerateApiToken();
  return (req, res) => {
    if (req.method !== 'POST' || req.url !== '/verdict') {
      json(res, 404, { error: 'not found' });
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
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        json(res, 400, { error: 'body must be JSON' });
        return;
      }
      const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as { artifactKind?: unknown; artifactId?: unknown; verdict?: unknown; sig?: unknown };
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
  };
}

export function startVerdictServer(options: VerdictListenerOptions): Promise<http.Server> {
  const server = http.createServer(createVerdictHandler(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? VERDICT_PORT, options.host ?? VERDICT_HOST, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
