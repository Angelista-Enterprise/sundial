import fs from 'node:fs';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { getDbUrl } from '@sundial/helpers/config.js';
import * as schema from './schemas/db-schema.js';

let dbInstance: LibSQLDatabase<typeof schema> | null = null;
let cachedUrl: string | null = null;

/** Tighten permissions on the SQLite file backing a `file:` URL to 0600. No-op for in-memory or remote. */
export function tightenDbFileMode(url: string): void {
  if (!url.startsWith('file:')) return;
  const filePath = url.slice('file:'.length);
  if (!filePath || filePath === ':memory:') return;
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o600);
    }
  } catch {
    // Foreign ownership or read-only mount — best effort.
  }
}

// A§7.2 — three processes (daemon, CLI, MCP server) hit the same SQLite file
// concurrently with no journal mode or busy handler configured; WAL +
// busy_timeout let concurrent readers/writers coexist instead of throwing
// SQLITE_BUSY. `execute()` runs its native call synchronously before any
// `await` internally, so firing these without awaiting still applies them
// before the client is used for real queries; `.catch` mirrors
// `tightenDbFileMode`'s best-effort style below.
function applyPragmas(client: ReturnType<typeof createClient>): void {
  for (const pragma of ['PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 5000', 'PRAGMA synchronous = NORMAL']) {
    client.execute(pragma).catch(() => {});
  }
}

export function createDb(url?: string): LibSQLDatabase<typeof schema> {
  const dbUrl = url ?? getDbUrl();
  const client = createClient({ url: dbUrl });
  tightenDbFileMode(dbUrl);
  applyPragmas(client);
  return drizzle(client, { schema });
}

/**
 * L4 (docs/audit/remediation-todo.md's standalone bug list) — first-call-wins
 * caching: once `dbInstance` exists, a later call with a *different*
 * explicit `url` used to be silently ignored, returning the first
 * instance regardless — the same bug class as a past `DATABASE_URL`
 * contamination incident (a caller believes it's talking to one database
 * while every query actually still hits whichever one got cached first).
 * Now warns instead of silently swallowing the mismatch, so a caller
 * relying on its explicit URL taking effect finds out immediately rather
 * than discovering it later via data that ended up in the wrong place.
 * Deliberately still returns the cached instance rather than switching
 * mid-flight — call `resetDb()`/`closeDb()` first to actually reconnect.
 */
export function getDb(url?: string): LibSQLDatabase<typeof schema> {
  if (!dbInstance) {
    cachedUrl = url ?? getDbUrl();
    dbInstance = createDb(url);
    return dbInstance;
  }
  if (url !== undefined && url !== cachedUrl) {
    console.warn(`[db] getDb() called with '${url}' but already connected to '${cachedUrl}' — the new URL is ignored. Call resetDb()/closeDb() first to actually reconnect.`);
  }
  return dbInstance;
}

export function closeDb(): void {
  dbInstance = null;
  cachedUrl = null;
}

export function resetDb(): void {
  dbInstance = null;
  cachedUrl = null;
}
