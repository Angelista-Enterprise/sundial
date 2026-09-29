// lane H (H6)
/**
 * A daily copy of the database, so one bad write or a lost disk is not the
 * whole record. `VACUUM INTO` from a separate, read-only `sqlite3` process:
 * a consistent snapshot of a live WAL database that never holds this
 * process's event loop (the libsql binding would run it on the main thread).
 * Benched on a copy of a 707 MB record: 1.4–2.4 s, 650 MB out.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDbUrl } from '@sundial/helpers/config.js';
import { BACKUP_NAME, BACKUPS_KEPT, backupDir } from '@sundial/helpers/backup-dir.js';

export { backupDir, lastBackupDate } from '@sundial/helpers/backup-dir.js';

const run = promisify(execFile);

/** The database file behind `DATABASE_URL`, or null for a non-file URL (nothing to copy). */
export function dbFilePath(url = getDbUrl()): string | null {
  if (!url.startsWith('file:')) return null;
  const file = url.slice('file:'.length).replace(/\?.*$/, '');
  return file === '' || file === ':memory:' ? null : file;
}

export interface BackupResult {
  file: string | null;
  skipped: 'exists' | 'no-db' | null;
  ms: number;
  removed: string[];
}

/** Copy the database to `<dir>/<date>.db` unless today's is there, then keep the newest seven. */
export async function backupDaily(opts: { date: string; dir?: string; db?: string | null; sqlite?: string }): Promise<BackupResult> {
  const dir = opts.dir ?? backupDir();
  const db = opts.db === undefined ? dbFilePath() : opts.db;
  const started = Date.now();
  if (!db || !fs.existsSync(db)) return { file: null, skipped: 'no-db', ms: 0, removed: [] };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${opts.date}.db`);
  if (fs.existsSync(file)) return { file, skipped: 'exists', ms: 0, removed: [] };
  // Into a temp name, then renamed: a copy cut short is never taken for today's.
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  // Oldest out first, down to one fewer than kept, so the disk never has to hold an eighth copy.
  const names = fs.readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort();
  const removed = names.slice(0, Math.max(0, names.length - (BACKUPS_KEPT - 1)));
  for (const name of removed) fs.rmSync(path.join(dir, name), { force: true });
  try {
    await run(opts.sqlite ?? 'sqlite3', ['-readonly', db, `VACUUM INTO '${tmp.replace(/'/g, "''")}'`]);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    // A copy cut short (a full disk) must not sit there taking the space until tomorrow.
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return { file, skipped: null, ms: Date.now() - started, removed };
}
