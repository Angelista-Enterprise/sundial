import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MailSensor } from './index.js';
import { findEnvelopeIndex, isSentMailbox, mailAfter, mailboxCounts, mailEvent, mailSince, newestMailRowId, rowsToMail, withRecipients } from './envelope-index.js';

describe('the Envelope Index reader', () => {
  it('turns rows into mail: Unix seconds, a missing sender, and nothing but the three fields', () => {
    expect(rowsToMail([{ rowid: 7, date: 1790496000, address: 'alex@example.com', name: ' Mira Bakker ', subject: 'Re: hint borders', body: 'secret' } as never, { rowid: 8, date: null }, { rowid: 9, date: 1790496060, address: null, subject: null }])).toEqual([
      { rowid: 7, timestamp: '2026-09-27T08:00:00.000Z', from: 'alex@example.com', fromName: 'Mira Bakker', subject: 'Re: hint borders' },
      { rowid: 9, timestamp: '2026-09-27T08:01:00.000Z', from: 'unknown', fromName: null, subject: '' },
    ]);
  });

  it('finds the newest V folder that holds an index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'));
    fs.mkdirSync(path.join(root, 'V9', 'MailData'), { recursive: true });
    fs.writeFileSync(path.join(root, 'V9', 'MailData', 'Envelope Index'), '');
    fs.mkdirSync(path.join(root, 'V11', 'MailData'), { recursive: true });
    fs.writeFileSync(path.join(root, 'V11', 'MailData', 'Envelope Index'), '');
    fs.mkdirSync(path.join(root, 'V12'));
    expect(findEnvelopeIndex(root)).toBe(path.join(root, 'V11', 'MailData', 'Envelope Index'));
    expect(findEnvelopeIndex(path.join(root, 'none'))).toBeNull();
  });

  it('asks SQLite for the right rows', async () => {
    const asked: string[] = [];
    const run = async (_file: string, sql: string) => (asked.push(sql), sql.startsWith('select max') ? '[{"rowid":41}]' : '');
    expect(await newestMailRowId('f', run)).toBe(41);
    await mailAfter('f', 41, 20, run);
    await mailSince('f', Date.UTC(2026, 8, 21), 5000, run);
    expect(asked[1]).toContain('where m.ROWID > 41 order by m.ROWID asc limit 20');
    expect(asked[2]).toContain(`where m.date_received >= ${Date.UTC(2026, 8, 21) / 1000}`);
  });

  it('reads a Sent mailbox as sent, by its date_sent, with To and Cc and never Bcc (UC1)', async () => {
    expect(['imap://a/Sent%20Messages', 'ews://a/Sent%20Items', 'imap://a/%5BGmail%5D/Sent%20Mail', 'imap://a/Verzonden%20items', 'imap://a/Sent/'].map(isSentMailbox)).toEqual([true, true, true, true, true]);
    expect(['imap://a/INBOX', 'imap://a/Sent%20to%20review/x', null].map(isSentMailbox)).toEqual([false, false, false]);
    const [mail] = rowsToMail([{ rowid: 7, date: 1790496999, sentDate: 1790496000, address: 'me@example.com', subject: 'The draft', mailbox: 'imap://a/Sent%20Messages' }]);
    expect(mail).toMatchObject({ rowid: 7, timestamp: '2026-09-27T08:00:00.000Z', sent: true });
    const run = async (_file: string, sql: string) => (sql.includes('from recipients') ? JSON.stringify([{ message: 7, type: 0, address: 'x7@example.com', name: 'Mira Bakker' }, { message: 7, type: 1, address: 'y8@example.com', name: null }, { message: 7, type: 2, address: 'z9@example.com', name: 'Hidden' }]) : '');
    const [withTo] = await withRecipients('f', [mail!], run);
    expect(mailEvent(withTo!)).toEqual({ type: 'mail:sent', payload: { timestamp: '2026-09-27T08:00:00.000Z', subject: 'The draft', recipients: [{ to: 'x7@example.com', toName: 'Mira Bakker' }, { to: 'y8@example.com' }] } });
    expect(mailEvent(rowsToMail([{ rowid: 8, date: 1790496000, address: 'a@example.com', subject: 'hi' }])[0]!).type).toBe('mail:received');
  });

  it('falls back to the four old columns when this Mail lacks the new ones', async () => {
    const asked: string[] = [];
    const run = async (_file: string, sql: string) => {
      asked.push(sql);
      if (sql.includes('mb.url')) throw new Error('Error: no such column: m.date_sent');
      return JSON.stringify([{ rowid: 9, date: 1790496000, address: 'a@example.com', subject: 'hi' }]);
    };
    expect(await mailAfter('f', 1, 20, run)).toHaveLength(1);
    expect(asked).toHaveLength(2);
  });
});

describe('MailSensor switches', () => {
  // Messages has its own switch: turning Mail on must not open chat.db.
  const chatDbAsked = async (config: { enabled: boolean; messages?: boolean }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-switch-'));
    const chatDb = path.join(root, 'chat.db');
    fs.writeFileSync(chatDb, '');
    const files: string[] = [];
    const exec = ((_cmd: string, args: string[], _opts: unknown, done: (e: Error | null, out: string) => void) => {
      files.push(args[2]!);
      done(null, '');
    }) as never;
    const sensor = new MailSensor({ ...config, mailDir: path.join(root, 'none'), chatDb, exec });
    sensor.poll(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 20));
    return files.includes(chatDb);
  };

  it.skipIf(process.platform !== 'darwin')('reads Messages only when privacy.messages is on', async () => {
    expect(await chatDbAsked({ enabled: true })).toBe(false);
    expect(await chatDbAsked({ enabled: true, messages: false })).toBe(false);
    expect(await chatDbAsked({ enabled: false, messages: true })).toBe(true);
  });
});

describe('how many Sent mailboxes Mail holds (Q3)', () => {
  it('counts mailboxes and the Sent ones among them, names never; null when the query fails', async () => {
    const run = async () => JSON.stringify([{ url: 'imap://a/INBOX' }, { url: 'imap://a/Sent%20Messages' }, { url: 'ews://b/Verzonden%20items' }, { url: 'imap://a/Archive' }]);
    expect(await mailboxCounts('f', run)).toEqual({ mailboxes: 4, sentMailboxes: 2 });
    expect(await mailboxCounts('f', async () => { throw new Error('no such table: mailboxes'); })).toBeNull();
  });

  it.skipIf(process.platform !== 'darwin')('says the counts on the first read of a boot, in mail:status', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-counts-'));
    fs.mkdirSync(path.join(root, 'V10', 'MailData'), { recursive: true });
    const file = path.join(root, 'V10', 'MailData', 'Envelope Index');
    const { execFileSync } = await import('node:child_process');
    execFileSync('/usr/bin/sqlite3', [file, "create table messages (ROWID integer primary key); create table mailboxes (ROWID integer primary key, url text); insert into mailboxes (url) values ('imap://a/INBOX'), ('imap://a/Drafts'); insert into messages default values;"]);
    const sensor = new MailSensor({ enabled: true, mailDir: root });
    sensor.poll(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sensor.poll(Date.now())).toEqual([{ type: 'mail:status', payload: { timestamp: expect.any(String), accessible: true, reason: null, mailboxes: 2, sentMailboxes: 0 } }]);
  });
});
