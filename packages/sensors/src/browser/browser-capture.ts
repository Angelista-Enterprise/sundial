import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { getBrowserHelperPath, getBrowserInfoJsonPath } from '@sundial/helpers/sundial-paths.js';

/** What the Swift helper writes. `url` is origin + path only; the helper never writes a query. */
export interface BrowserSnapshot {
  timestamp: string;
  app: string | null;
  bundleId: string | null;
  url: string | null;
  title: string | null;
  authorized: boolean;
  error: string | null;
  /** J3.4: the page's visible text, whitespace-collapsed and clipped, when the helper was started with `--page-text` and the browser allowed it. */
  text?: string | null;
  textError?: string | null;
}

/** A heartbeat lands every 30 s; twice that with nothing means the helper is gone. */
export const BROWSER_STALE_MS = 65_000;

export function readBrowserSidecar(now = Date.now()): BrowserSnapshot | null {
  const sidecarPath = getBrowserInfoJsonPath();
  try {
    const stat = fs.statSync(sidecarPath);
    if (now - stat.mtimeMs > BROWSER_STALE_MS) return null;
    return parseBrowserSnapshot(fs.readFileSync(sidecarPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function parseBrowserSnapshot(text: string): BrowserSnapshot | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.timestamp !== 'string') return null;
    return {
      timestamp: parsed.timestamp,
      app: typeof parsed.app === 'string' ? parsed.app : null,
      bundleId: typeof parsed.bundleId === 'string' ? parsed.bundleId : null,
      url: typeof parsed.url === 'string' && parsed.url !== '' ? parsed.url : null,
      title: typeof parsed.title === 'string' ? parsed.title : null,
      authorized: parsed.authorized !== false,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      // J3.4: the page's own words, only when the helper was asked for them and got them.
      text: typeof parsed.text === 'string' && parsed.text.trim() !== '' ? parsed.text : null,
      textError: typeof parsed.textError === 'string' ? parsed.textError : null,
    };
  } catch {
    return null;
  }
}

/** Backoff after a helper exit, so a missing binary does not respawn a thousand times an hour. */
const RESPAWN_MIN_MS = 5_000;
const RESPAWN_MAX_MS = 5 * 60_000;

/**
 * Keeps ONE helper process alive. The helper is spawned directly (never via
 * `open -a`, CLAUDE.md macOS note 1) and re-execs itself disclaimed, so TCC
 * judges its own identity, not node's. Nothing is read from its stdout — the
 * snapshot file is the contract, the same as every other sidecar.
 */
export class BrowserHelperSupervisor {
  private child: ChildProcess | null = null;
  private nextSpawnAt = 0;
  private backoffMs = RESPAWN_MIN_MS;
  private missing = false;

  constructor(
    private readonly helperPath: string = getBrowserHelperPath(),
    private readonly args: string[] = [],
  ) {}

  /** Spawn if not running and the backoff has elapsed. Idempotent per poll. */
  ensure(now = Date.now()): void {
    // SUNDIAL_NATIVE_HELPERS=0: no TCC-gated helper is started (CI, test installs).
    if (process.env.SUNDIAL_NATIVE_HELPERS === '0') return;
    if (this.child !== null || now < this.nextSpawnAt) return;
    if (!fs.existsSync(this.helperPath)) {
      // Report once; a machine without the staged bundle is not an error to shout about every second.
      if (!this.missing) console.warn(`[browser-sensor] helper not found at ${this.helperPath}; run npm run sidecars:build`);
      this.missing = true;
      this.nextSpawnAt = now + RESPAWN_MAX_MS;
      return;
    }
    this.missing = false;
    try {
      const child = spawn(this.helperPath, this.args, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) console.warn(`[browser-helper] ${line}`);
      });
      child.on('exit', (code, signal) => {
        this.child = null;
        this.nextSpawnAt = Date.now() + this.backoffMs;
        this.backoffMs = Math.min(RESPAWN_MAX_MS, this.backoffMs * 2);
        console.warn(`[browser-sensor] helper exited (${signal ?? code}); respawn in ${Math.round((this.nextSpawnAt - Date.now()) / 1000)}s`);
      });
      child.on('error', () => {
        this.child = null;
        this.nextSpawnAt = Date.now() + this.backoffMs;
      });
      this.child = child;
      // A clean hour resets the backoff.
      setTimeout(() => {
        if (this.child === child) this.backoffMs = RESPAWN_MIN_MS;
      }, 60 * 60_000).unref();
    } catch {
      this.child = null;
      this.nextSpawnAt = now + this.backoffMs;
    }
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  stop(): void {
    if (this.child !== null) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // already gone
      }
      this.child = null;
    }
  }
}
