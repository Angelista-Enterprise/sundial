// lane H (H6)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupDaily, backupDir, dbFilePath, lastBackupDate } from './backup.js';

const hasSqlite = (() => {
  try {
    execFileSync('sqlite3', ['-version']);
    return true;
  } catch {
    return false;
  }
})();

describe('backupDaily', () => {
  it('never writes to the owner folder from another home', () => {
    expect(backupDir('/tmp/some-test-home')).toBe(path.join('/tmp/some-test-home', 'backups', 'daily'));
    expect(backupDir(path.join(os.homedir(), '.sundial'))).toBe(path.join(os.homedir(), 'sundial-backups', 'daily'));
    expect(dbFilePath('file:/x/sundial.db')).toBe('/x/sundial.db');
    expect(dbFilePath('libsql://remote')).toBeNull();
  });

  it.skipIf(!hasSqlite)('copies once a day and keeps the newest seven', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-backup-'));
    const db = path.join(home, 'sundial.db');
    execFileSync('sqlite3', [db, 'CREATE TABLE t (x); INSERT INTO t VALUES (1);']);
    const dir = path.join(home, 'backups', 'daily');
    for (let d = 1; d <= 8; d++) fs.mkdirSync(dir, { recursive: true }), fs.writeFileSync(path.join(dir, `2026-08-0${d}.db`), '');

    const first = await backupDaily({ date: '2026-09-01', dir, db });
    expect(first.skipped).toBeNull();
    expect(execFileSync('sqlite3', [first.file!, 'SELECT x FROM t']).toString().trim()).toBe('1');
    expect(fs.statSync(first.file!).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-08-03.db', '2026-08-04.db', '2026-08-05.db', '2026-08-06.db', '2026-08-07.db', '2026-08-08.db', '2026-09-01.db']);
    expect((await backupDaily({ date: '2026-09-01', dir, db })).skipped).toBe('exists');
    expect(lastBackupDate(dir)).toBe('2026-09-01');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
