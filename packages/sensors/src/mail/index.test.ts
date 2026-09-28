import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEnvelopeIndex, mailAfter, mailSince, newestMailRowId, rowsToMail } from './envelope-index.js';

describe('the Envelope Index reader', () => {
  it('turns rows into mail: Unix seconds, a missing sender, and nothing but the three fields', () => {
    expect(rowsToMail([{ rowid: 7, date: 1790496000, address: 'alex@example.com', subject: 'Re: hint borders', body: 'secret' } as never, { rowid: 8, date: null }, { rowid: 9, date: 1790496060, address: null, subject: null }])).toEqual([
      { rowid: 7, timestamp: '2026-09-27T08:00:00.000Z', from: 'alex@example.com', subject: 'Re: hint borders' },
      { rowid: 9, timestamp: '2026-09-27T08:01:00.000Z', from: 'unknown', subject: '' },
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
});
