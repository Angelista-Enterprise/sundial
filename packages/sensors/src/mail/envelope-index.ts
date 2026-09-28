import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Mail.app's own index of every message it holds: `~/Library/Mail/V<n>/MailData/Envelope Index`,
 * a SQLite file. Read-only, and only three things are selected: when a message
 * arrived, the sender's address, and the subject. Never a body — the index does
 * not hold one.
 *
 * This replaced a Spotlight query (`mdfind` for `.emlx` files) that found
 * nothing on the owner's Mac: Spotlight did not index Mail there, so the sensor
 * reported access and never a single message (0 `mail:received` rows ever,
 * 2026-09-28). Full Disk Access is what opens the file; without it the read
 * fails with EPERM and the sensor says so.
 */

export interface EnvelopeMail {
  rowid: number;
  timestamp: string;
  from: string;
  subject: string;
}

/** The newest `V<n>` folder's index, or null when Mail has none (or it cannot be listed). */
export function findEnvelopeIndex(mailDir = path.join(os.homedir(), 'Library', 'Mail')): string | null {
  let versions: string[];
  try {
    versions = fs.readdirSync(mailDir).filter((d) => /^V\d+$/.test(d));
  } catch {
    return null;
  }
  versions.sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const v of versions) {
    const file = path.join(mailDir, v, 'MailData', 'Envelope Index');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const SELECT = 'select m.ROWID as rowid, m.date_received as date, a.address as address, s.subject as subject from messages m left join addresses a on a.ROWID = m.sender left join subjects s on s.ROWID = m.subject';

/** `date_received` is Unix seconds; the other two epochs are handled in case a Mail version changes it. */
function toIso(date: unknown): string | null {
  if (typeof date !== 'number' || !Number.isFinite(date) || date <= 0) return null;
  const ms = date > 1e12 ? date : date < 1e9 ? Date.UTC(2001, 0, 1) + date * 1000 : date * 1000;
  return new Date(ms).toISOString();
}

export function rowsToMail(rows: { rowid?: unknown; date?: unknown; address?: unknown; subject?: unknown }[]): EnvelopeMail[] {
  const out: EnvelopeMail[] = [];
  for (const r of rows) {
    const timestamp = toIso(r.date);
    if (typeof r.rowid !== 'number' || timestamp === null) continue;
    out.push({ rowid: r.rowid, timestamp, from: typeof r.address === 'string' && r.address !== '' ? r.address : 'unknown', subject: typeof r.subject === 'string' ? r.subject.slice(0, 300) : '' });
  }
  return out;
}

export type SqliteRunner = (file: string, sql: string) => Promise<string>;

export const runSqlite: SqliteRunner = (file, sql) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', '-json', file, sql], { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });

const parse = (out: string) => (out.trim() === '' ? [] : (JSON.parse(out) as Record<string, unknown>[]));

/** The highest message row id — where a live sensor starts, so it reports only what arrives after it. */
export async function newestMailRowId(file: string, run: SqliteRunner = runSqlite): Promise<number> {
  const [row] = parse(await run(file, 'select max(ROWID) as rowid from messages;'));
  return typeof row?.rowid === 'number' ? row.rowid : 0;
}

/** Messages after a row id, oldest first. */
export async function mailAfter(file: string, rowid: number, limit: number, run: SqliteRunner = runSqlite): Promise<EnvelopeMail[]> {
  return rowsToMail(parse(await run(file, `${SELECT} where m.ROWID > ${Math.floor(rowid)} order by m.ROWID asc limit ${Math.floor(limit)};`)));
}

/** Messages received since a moment, oldest first — for the back-fill. */
export async function mailSince(file: string, sinceMs: number, limit: number, run: SqliteRunner = runSqlite): Promise<EnvelopeMail[]> {
  return rowsToMail(parse(await run(file, `${SELECT} where m.date_received >= ${Math.floor(sinceMs / 1000)} order by m.date_received asc limit ${Math.floor(limit)};`)));
}
