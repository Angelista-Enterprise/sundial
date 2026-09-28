import { migrate } from 'drizzle-orm/libsql/migrator';
import { sql } from 'drizzle-orm';
import { getDb } from './db-client.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSundialHome } from '@sundial/helpers/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `packages/db/drizzle/` — SQL migration files, sibling to `dist/` (this file compiles to `dist/db-migrate.js`). */
function getMigrationsFolder(): string {
  const folder = path.join(__dirname, '../drizzle');
  if (!fs.existsSync(path.join(folder, 'meta', '_journal.json'))) {
    throw new Error(`Can't find drizzle migrations at ${folder}. Run \`npm run db:generate -w @sundial/db\` first.`);
  }
  return folder;
}

/**
 * Defense-in-depth: tighten `~/.sundial/` to `0700` and every `*.db` inside it
 * to `0600`. New DB files already get `0600` from `tightenDbFileMode` on
 * `createDb`; this catches files from before that ran.
 */
export function tightenSundialHomeAndDbFiles(gnomonDir: string): void {
  try {
    fs.chmodSync(gnomonDir, 0o700);
  } catch {
    // Best effort — foreign ownership or read-only mount.
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(gnomonDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    try {
      fs.chmodSync(path.join(gnomonDir, name), 0o600);
    } catch {
      // Best effort.
    }
  }
}

/**
 * No `ensureMigrationTracking`-style backfill here — that logic in WCS exists
 * only to reconcile pre-drizzle legacy history, which Gnomon has none of.
 * Straight `migrate()` against a fresh (or already-drizzle-tracked) DB.
 */
export async function initializeDatabase(): Promise<void> {
  const gnomonDir = getSundialHome();
  if (!fs.existsSync(gnomonDir)) {
    fs.mkdirSync(gnomonDir, { recursive: true, mode: 0o700 });
  }
  tightenSundialHomeAndDbFiles(gnomonDir);

  const db = getDb();
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
}

/**
 * `gnomon dev db-reset` (docs/audit/history's S2 pattern, ported from WCS's
 * `wcs dev reset`): empties every table but keeps the schema — no
 * migrations need to re-run afterward, unlike deleting the `.db` file
 * outright. Skips drizzle's own bookkeeping tables (`__drizzle_migrations`,
 * `sqlite_%`) so the migration history itself survives a reset.
 */
export async function resetAllData(): Promise<string[]> {
  const db = getDb();
  const result = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`,
  );
  const cleared: string[] = [];
  // One transaction around the whole loop: an interrupt (Ctrl-C on a manual
  // `dev db-reset`) or crash mid-loop otherwise leaves some tables emptied and
  // others intact — a partial reset with no record of how far it got.
  // Explicit BEGIN IMMEDIATE/COMMIT on the shared connection (drizzle's
  // `.transaction()` opens a second connection an in-memory DB can't share);
  // all-or-nothing means an interruption leaves the fully-original state.
  await db.run(sql`BEGIN IMMEDIATE`);
  try {
    for (const { name } of result) {
      await db.run(sql.raw(`DELETE FROM "${name}"`));
      cleared.push(name);
    }
    await db.run(sql`COMMIT`);
  } catch (error) {
    await db.run(sql`ROLLBACK`);
    throw error;
  }
  return cleared;
}
