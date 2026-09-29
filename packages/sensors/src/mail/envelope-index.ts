import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Mail.app's own index of every message it holds: `~/Library/Mail/V<n>/MailData/Envelope Index`,
 * a SQLite file. Read-only, and only four things are selected: when a message
 * arrived, the sender's address and display name, and the subject. Never a
 * body — the index does not hold one. The display name (`addresses.comment`)
 * is what `sanitizeAtIngest` keeps as the sender when it reads as a name; the
 * address alone hashed 165 of 246 live senders (audit M4).
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
  /** The sender's display name as Mail holds it, or null. */
  fromName: string | null;
  subject: string;
  /** UC1: the message sits in a Sent mailbox — the owner wrote it. */
  sent?: boolean;
  /** UC1: To and Cc of a sent message, filled by `withRecipients`. Never Bcc, never a body. */
  recipients?: { address: string; name: string | null }[];
}

/**
 * A Sent mailbox, by the URL Mail keeps for it: `…/Sent%20Messages` (iCloud,
 * IMAP), `…/Sent%20Items` (Exchange), `…/%5BGmail%5D/Sent%20Mail`, and the
 * Dutch `Verzonden` a Dutch account is given.
 */
export function isSentMailbox(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // A malformed escape: read it raw.
  }
  return /\/(sent( messages| items| mail)?|verzonden( items| berichten)?)$/i.test(decoded.replace(/\/+$/, ''));
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

const LEGACY_SELECT = 'select m.ROWID as rowid, m.date_received as date, a.address as address, a.comment as name, s.subject as subject from messages m left join addresses a on a.ROWID = m.sender left join subjects s on s.ROWID = m.subject';
/**
 * UC1: the same four things plus the mailbox's URL and `date_sent`, so a
 * message in a Sent mailbox reads as `mail:sent`. The public schema is not a
 * contract — a Mail version without these columns makes the query fail, and
 * the reader falls back to the four it always had.
 */
const SELECT = 'select m.ROWID as rowid, m.date_received as date, m.date_sent as sentDate, a.address as address, a.comment as name, s.subject as subject, mb.url as mailbox from messages m left join addresses a on a.ROWID = m.sender left join subjects s on s.ROWID = m.subject left join mailboxes mb on mb.ROWID = m.mailbox';

/** `date_received` is Unix seconds; the other two epochs are handled in case a Mail version changes it. */
function toIso(date: unknown): string | null {
  if (typeof date !== 'number' || !Number.isFinite(date) || date <= 0) return null;
  const ms = date > 1e12 ? date : date < 1e9 ? Date.UTC(2001, 0, 1) + date * 1000 : date * 1000;
  return new Date(ms).toISOString();
}

export function rowsToMail(rows: { rowid?: unknown; date?: unknown; sentDate?: unknown; address?: unknown; name?: unknown; subject?: unknown; mailbox?: unknown }[]): EnvelopeMail[] {
  const out: EnvelopeMail[] = [];
  for (const r of rows) {
    const sent = isSentMailbox(r.mailbox);
    const timestamp = (sent ? toIso(r.sentDate) : null) ?? toIso(r.date);
    if (typeof r.rowid !== 'number' || timestamp === null) continue;
    out.push({ rowid: r.rowid, timestamp, from: typeof r.address === 'string' && r.address !== '' ? r.address : 'unknown', fromName: nameOf(r.name), subject: typeof r.subject === 'string' ? r.subject.slice(0, 300) : '', ...(sent ? { sent: true, recipients: [] } : {}) });
  }
  return out;
}

const nameOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : null);

/** Recipient types Mail stores: 0 To, 1 Cc, 2 Bcc. Bcc is left out — it was never on the mail. */
const SHOWN_RECIPIENT = new Set([0, 1]);
const MAX_RECIPIENTS = 12;

/** UC1: To and Cc of the sent messages among `mails`. A failed read leaves them empty; the subject still counts. */
export async function withRecipients(file: string, mails: EnvelopeMail[], run: SqliteRunner = runSqlite): Promise<EnvelopeMail[]> {
  const ids = mails.filter((m) => m.sent).map((m) => Math.floor(m.rowid));
  if (ids.length === 0) return mails;
  let rows: Record<string, unknown>[];
  try {
    rows = parse(await run(file, `select r.message as message, r.type as type, a.address as address, a.comment as name from recipients r join addresses a on a.ROWID = r.address where r.message in (${ids.join(',')}) order by r.message, r.position;`));
  } catch {
    return mails;
  }
  const byMessage = new Map<number, { address: string; name: string | null }[]>();
  for (const row of rows) {
    if (typeof row.message !== 'number' || typeof row.address !== 'string' || row.address === '') continue;
    if (typeof row.type === 'number' && !SHOWN_RECIPIENT.has(row.type)) continue;
    const list = byMessage.get(row.message) ?? [];
    if (list.length < MAX_RECIPIENTS) list.push({ address: row.address, name: nameOf(row.name) });
    byMessage.set(row.message, list);
  }
  return mails.map((m) => (m.sent ? { ...m, recipients: byMessage.get(m.rowid) ?? [] } : m));
}

/** Run the widened query, and the old one when this Mail's schema lacks a column. */
async function selectMail(file: string, where: string, run: SqliteRunner): Promise<EnvelopeMail[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = parse(await run(file, `${SELECT} ${where}`));
  } catch (error) {
    if (!/no such (column|table)/i.test(error instanceof Error ? error.message : String(error))) throw error;
    rows = parse(await run(file, `${LEGACY_SELECT} ${where}`));
  }
  return withRecipients(file, rowsToMail(rows), run);
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

/**
 * How many mailboxes Mail holds, and how many of them `isSentMailbox` reads as
 * Sent: counts only, never a name. Zero Sent means no `mail:sent` will ever
 * come, which is worth knowing before a promise waits on one. Null when the
 * query fails.
 */
export async function mailboxCounts(file: string, run: SqliteRunner = runSqlite): Promise<{ mailboxes: number; sentMailboxes: number } | null> {
  try {
    const rows = parse(await run(file, 'select url from mailboxes;'));
    return { mailboxes: rows.length, sentMailboxes: rows.filter((r) => isSentMailbox(r.url)).length };
  } catch {
    return null;
  }
}

/** Messages after a row id, oldest first. */
export async function mailAfter(file: string, rowid: number, limit: number, run: SqliteRunner = runSqlite): Promise<EnvelopeMail[]> {
  return selectMail(file, `where m.ROWID > ${Math.floor(rowid)} order by m.ROWID asc limit ${Math.floor(limit)};`, run);
}

/** Messages received since a moment, oldest first — for the back-fill. */
export async function mailSince(file: string, sinceMs: number, limit: number, run: SqliteRunner = runSqlite): Promise<EnvelopeMail[]> {
  return selectMail(file, `where m.date_received >= ${Math.floor(sinceMs / 1000)} order by m.date_received asc limit ${Math.floor(limit)};`, run);
}

/** The event a mail becomes: `mail:sent` with its recipients, or `mail:received` with its sender. Sanitized at ingest either way. */
export function mailEvent(m: EnvelopeMail): { type: 'mail:sent' | 'mail:received'; payload: Record<string, unknown> } {
  if (m.sent) return { type: 'mail:sent', payload: { timestamp: m.timestamp, subject: m.subject, recipients: (m.recipients ?? []).map((r) => ({ to: r.address, ...(r.name ? { toName: r.name } : {}) })) } };
  return { type: 'mail:received', payload: { timestamp: m.timestamp, from: m.from, ...(m.fromName ? { fromName: m.fromName } : {}), subject: m.subject } };
}
