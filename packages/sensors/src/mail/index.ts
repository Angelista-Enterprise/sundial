import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEnvelopeIndex, mailAfter, mailboxCounts, mailEvent, newestMailRowId } from './envelope-index.js';

/**
 * J3.6 — Mail.app and Messages, SUBJECTS AND SENDERS ONLY, behind Full Disk
 * Access. Mail: rows added to Mail.app's own `Envelope Index` since the last
 * poll (arrival time, sender address, subject — see envelope-index.ts).
 * Messages: `sqlite3 -readonly` over `chat.db` for sender, chat and time of
 * rows since the last poll — the `text` column is never selected. Without FDA
 * both fail with EPERM and the sensor says so once (`mail:status
 * { accessible: false }`). `privacy.mail` switches the Mail reader and
 * `privacy.messages` the Messages one; they are separate because the owner
 * declined Messages (2026-09-28) while keeping Mail. A sender that is an address becomes `person-<hash>` at ingest; a
 * phone number is reported as `phone`, never as digits.
 */
export type MailEvent =
  | { type: 'mail:received'; payload: { timestamp: string; from: string; fromName?: string; subject: string } }
  /** UC1: a message in a Sent mailbox. To and Cc become names or `person-<hash>` at ingest, like a sender. */
  | { type: 'mail:sent'; payload: { timestamp: string; subject: string; recipients: { to: string; toName?: string }[] } }
  | { type: 'message:received'; payload: { timestamp: string; from: string; chat: string | null; fromMe: boolean } }
  /** `mailboxes`/`sentMailboxes`: counts, on the first read of a boot only. */
  | { type: 'mail:status'; payload: { timestamp: string; accessible: boolean; reason: string | null; mailboxes?: number; sentMailboxes?: number } };

export interface MailSensorConfig {
  /** The Mail.app reader (`privacy.mail`). */
  enabled: boolean;
  /** The Messages reader (`privacy.messages`), off unless asked for. */
  messages?: boolean;
  intervalMs?: number;
  mailDir?: string;
  chatDb?: string;
  exec?: typeof execFile;
}

const MAX_PER_POLL = 20;
/** Apple epoch (2001-01-01); `message.date` is nanoseconds since it on modern macOS, seconds on old ones. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export class MailSensor {
  private lastAt = 0;
  private lastMessageRowId: number | null = null;
  private lastMailRowId: number | null = null;
  private inFlight = false;
  private buffered: MailEvent[] = [];
  private reportedAccess: boolean | null = null;
  private readonly intervalMs: number;
  private readonly mailDir: string;
  private readonly chatDb: string;
  private readonly exec: typeof execFile;

  constructor(private readonly config: MailSensorConfig) {
    this.intervalMs = config.intervalMs ?? 60_000;
    this.mailDir = config.mailDir ?? path.join(os.homedir(), 'Library', 'Mail');
    this.chatDb = config.chatDb ?? path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
    this.exec = config.exec ?? execFile;
  }

  poll(now = Date.now()): MailEvent[] {
    const out = this.buffered;
    this.buffered = [];
    const { enabled: mail, messages = false } = this.config;
    if (!(mail || messages) || process.platform !== 'darwin' || this.inFlight || now - this.lastAt < this.intervalMs) return out;
    this.lastAt = now;
    this.inFlight = true;
    void Promise.all([mail ? this.pollMail() : null, messages ? this.pollMessages() : null])
      .catch((error) => console.warn('[mail-sensor] poll failed:', error instanceof Error ? error.message : error))
      .finally(() => {
        this.inFlight = false;
      });
    return out;
  }

  private run(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      this.exec(cmd, args, { maxBuffer: 4 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    });
  }

  private access(accessible: boolean, reason: string | null): void {
    if (this.reportedAccess === accessible) return;
    this.reportedAccess = accessible;
    this.buffered.push({ type: 'mail:status', payload: { timestamp: new Date().toISOString(), accessible, reason } });
  }

  private async pollMail(): Promise<void> {
    const file = findEnvelopeIndex(this.mailDir);
    if (file === null) {
      this.access(false, 'no Mail.app index (add an account to Mail, or grant Full Disk Access)');
      return;
    }
    try {
      // The first poll only finds where to start: mail already there is the back-fill's to read.
      // Once a boot it also says how many Sent mailboxes it found, whatever was reported before.
      if (this.lastMailRowId === null) {
        this.lastMailRowId = await newestMailRowId(file);
        const counts = await mailboxCounts(file);
        this.reportedAccess = true;
        this.buffered.push({ type: 'mail:status', payload: { timestamp: new Date().toISOString(), accessible: true, reason: null, ...(counts ?? {}) } });
        return;
      }
      const mails = await mailAfter(file, this.lastMailRowId, MAX_PER_POLL);
      this.access(true, null);
      for (const m of mails) {
        this.lastMailRowId = Math.max(this.lastMailRowId, m.rowid);
        this.buffered.push(mailEvent(m) as MailEvent);
      }
    } catch (error) {
      this.access(false, `Envelope Index: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
  }

  private async pollMessages(): Promise<void> {
    if (!fs.existsSync(this.chatDb)) return;
    const since = this.lastMessageRowId;
    const sql =
      since === null
        ? 'select ROWID as rowid from message order by ROWID desc limit 1;'
        : `select m.ROWID as rowid, m.date as date, m.is_from_me as from_me, h.id as handle, c.display_name as chat from message m left join handle h on h.ROWID = m.handle_id left join chat_message_join cmj on cmj.message_id = m.ROWID left join chat c on c.ROWID = cmj.chat_id where m.ROWID > ${since} order by m.ROWID asc limit ${MAX_PER_POLL};`;
    let rows: { rowid: number; date?: number; from_me?: number; handle?: string | null; chat?: string | null }[];
    try {
      const out = await this.run('/usr/bin/sqlite3', ['-readonly', '-json', this.chatDb, sql]);
      rows = out.trim() === '' ? [] : (JSON.parse(out) as typeof rows);
    } catch (error) {
      this.access(false, `chat.db: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.access(true, null);
    if (since === null) {
      this.lastMessageRowId = rows[0]?.rowid ?? 0;
      return;
    }
    for (const row of rows) {
      this.lastMessageRowId = Math.max(this.lastMessageRowId ?? 0, row.rowid);
      const handle = typeof row.handle === 'string' ? row.handle : '';
      const from = handle === '' ? 'unknown' : handle.includes('@') ? handle : 'phone';
      const at = typeof row.date === 'number' && row.date > 0 ? new Date(APPLE_EPOCH_MS + (row.date > 1e12 ? row.date / 1e6 : row.date * 1000)).toISOString() : new Date().toISOString();
      this.buffered.push({ type: 'message:received', payload: { timestamp: at, from, chat: typeof row.chat === 'string' && row.chat.trim() !== '' ? row.chat.trim().slice(0, 120) : null, fromMe: row.from_me === 1 } });
    }
  }
}
