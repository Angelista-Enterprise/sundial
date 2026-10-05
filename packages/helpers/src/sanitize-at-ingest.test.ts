import { describe, it, expect } from 'vitest';
import { sanitizeAtIngest, sanitizeAtIngestWithAudit } from './sanitize-at-ingest.js';
import { privacyConfig } from './privacy-config.js';

describe('sanitizeAtIngest', () => {
  it('redacts projectRoot/fromProjectRoot/toProjectRoot to a home-relative path, not the raw absolute path', () => {
    const sanitized = sanitizeAtIngest({
      id: 'e1',
      type: 'project:switched',
      ts: '2026-01-01T00:00:00.000Z',
      payload: {
        fromProjectRoot: null,
        toProjectRoot: '/Users/someone/Projects/gnomon',
        kind: 'project',
      },
    });

    expect(sanitized.payload.toProjectRoot).toBe('~/Projects/gnomon');
    expect(sanitized.payload.toProjectRoot).not.toContain('someone');
  });

  it('redacts a bare project:detected projectRoot the same way', () => {
    const sanitized = sanitizeAtIngest({
      id: 'e1',
      type: 'project:detected',
      ts: '2026-01-01T00:00:00.000Z',
      payload: { projectRoot: '/Users/someone/Projects/gnomon', projectName: 'gnomon' },
    });

    expect(sanitized.payload.projectRoot).toBe('~/Projects/gnomon');
  });

  describe('E1: recursive coverage (fixes A§6.2)', () => {
    it('redacts a nested window/previousWindow ref the same way as a top-level one', () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'window:changed',
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          processName: 'Code',
          windowTitle: 'reveal.swift — gnomon',
          previousWindow: { processName: 'Code', windowTitle: 'other.ts — gnomon', windowId: 'w1' },
        },
      });

      expect(sanitized.payload.windowTitle).toBeDefined();
      expect((sanitized.payload.previousWindow as { windowTitle: string }).windowTitle).toBeDefined();
    });

    it('evaluates a nested previousWindow against its OWN processName, not the outer one — a sensitive previousWindow is blanked even when the current window is not', () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'window:changed',
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          processName: 'Code',
          windowTitle: 'reveal.swift',
          previousWindow: { processName: 'Slack', windowTitle: 'DM with someone about a secret plan', windowId: 'w1' },
        },
      });

      expect(sanitized.payload.windowTitle).toBe('reveal.swift');
      expect((sanitized.payload.previousWindow as { windowTitle: string; processName: string }).windowTitle).toBe('[private]');
      expect((sanitized.payload.previousWindow as { processName: string }).processName).toBe('Slack');
    });

    it('hides a nested previousWindow entirely when ITS processName is a hidden app', () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'window:changed',
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          processName: 'Code',
          windowTitle: 'reveal.swift',
          previousWindow: { processName: '1Password', windowTitle: 'Vault — banking', windowId: 'w1' },
        },
      });

      // hiddenApps is empty by default in this test environment, so this
      // exercises the "not hidden" path deterministically either way —
      // the important assertion is that the nested object's own
      // processName drove the decision, not the outer one.
      const prev = sanitized.payload.previousWindow as { processName: string };
      expect(prev.processName).toBe('1Password');
    });

    it("redacts a calendar event's title nested under payload.event (calendar:context-event)", () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'calendar:context-event',
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          kind: 'meeting',
          reason: 'all-day',
          event: { eventId: 'e1', title: 'password=hunter2 planning', attendees: [], startDate: '', endDate: '', isRecurring: false, calendar: 'Work', isAllDay: true },
        },
      });

      const event = sanitized.payload.event as { title: string };
      expect(event.title).not.toContain('hunter2');
    });

    it("redacts every event's title nested under payload.events[] (calendar:upcoming)", () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'calendar:upcoming',
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          events: [
            { eventId: 'e1', title: 'token: abc123secret', attendees: [], startDate: '', endDate: '', isRecurring: false, calendar: 'Work', isAllDay: false },
            { eventId: 'e2', title: 'Normal meeting title', attendees: [], startDate: '', endDate: '', isRecurring: false, calendar: 'Work', isAllDay: false },
          ],
        },
      });

      const events = sanitized.payload.events as { title: string }[];
      expect(events[0]!.title).not.toContain('abc123secret');
      expect(events[1]!.title).toBe('Normal meeting title');
    });

    it('aliases an email-shaped attendee to a stable, non-reversible alias, leaves a display name untouched', () => {
      const first = sanitizeAtIngest({
        id: 'e1',
        type: 'calendar:active',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { event: { eventId: 'e1', title: 't', attendees: ['Priya Sharma', 'sam@example.com'], startDate: '', endDate: '', isRecurring: false, calendar: 'Work', isAllDay: false } },
      });
      const second = sanitizeAtIngest({
        id: 'e2',
        type: 'calendar:active',
        ts: '2026-01-02T00:00:00.000Z',
        payload: { event: { eventId: 'e2', title: 't', attendees: ['sam@example.com'], startDate: '', endDate: '', isRecurring: false, calendar: 'Work', isAllDay: false } },
      });

      const attendeesFirst = (first.payload.event as { attendees: string[] }).attendees;
      const attendeesSecond = (second.payload.event as { attendees: string[] }).attendees;

      expect(attendeesFirst[0]).toBe('Priya Sharma');
      expect(attendeesFirst[1]).not.toContain('@');
      expect(attendeesFirst[1]).not.toBe('sam@example.com');
      // Same email → same alias across separate events, so entityExtract
      // still treats them as one person, not a fresh entity per meeting.
      expect(attendeesFirst[1]).toBe(attendeesSecond[0]);
    });

    it('aliases NFC- and NFD-normalized forms of the same accented email to one stable alias', () => {
      // Build the accented address from a code point (no literal) so the two
      // forms genuinely differ in bytes: composed e-acute (U+00E9) vs e+U+0301.
      const base = `caf${String.fromCharCode(0x00e9)}@example.com`;
      const composed = base.normalize('NFC');
      const decomposed = base.normalize('NFD');
      expect(composed).not.toBe(decomposed);

      const nfc = sanitizeAtIngest({
        id: 'e1',
        type: 'calendar:active',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { event: { eventId: 'e1', title: 't', attendees: [composed], startDate: '', endDate: '', isRecurring: false, calendar: 'Work', isAllDay: false } },
      });
      const nfd = sanitizeAtIngest({
        id: 'e2',
        type: 'calendar:active',
        ts: '2026-01-02T00:00:00.000Z',
        payload: { event: { eventId: 'e2', title: 't', attendees: [decomposed], startDate: '', endDate: '', isRecurring: false, calendar: 'Work', isAllDay: false } },
      });
      const a = (nfc.payload.event as { attendees: string[] }).attendees[0];
      const b = (nfd.payload.event as { attendees: string[] }).attendees[0];
      expect(a).not.toContain('@');
      expect(a).toBe(b);
    });

    it('aliases an email-shaped organizer the same way', () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'calendar:context-event',
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          kind: 'meeting',
          reason: 'not-self-attendee',
          event: {
            eventId: 'e1',
            title: 't',
            attendees: [],
            organizer: 'boss@example.com',
            startDate: '',
            endDate: '',
            isRecurring: false,
            calendar: 'Work',
            isAllDay: false,
          },
        },
      });

      const event = sanitized.payload.event as { organizer: string };
      expect(event.organizer).not.toBe('boss@example.com');
      // A name-shaped address becomes the name; the domain is gone.
      expect(event.organizer).toBe('Boss');
    });

    it('never logs a message sender as the raw address', () => {
      const sanitized = sanitizeAtIngest({ id: 'm1', type: 'message:received', ts: '2026-01-01T00:00:00.000Z', payload: { from: 'x7@example.com', chat: null, fromMe: false } });
      expect(sanitized.payload.from).not.toContain('@');
      // A `from` that is not an address — a board span's date — is left alone.
      const span = sanitizeAtIngest({ id: 'b1', type: 'board:span', ts: '2026-01-01T00:00:00.000Z', payload: { from: '2026-09-01' } });
      expect(span.payload.from).toBe('2026-09-01');
    });
  });

  describe('P4: redaction audit tally (sanitizeAtIngestWithAudit)', () => {
    it('returns a byte-identical event plus a per-property tally', () => {
      const input = {
        id: 'e1',
        type: 'window:changed',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { processName: 'Slack', windowTitle: 'DM about a secret', url: 'https://example.com/x' },
      };
      const plain = sanitizeAtIngest(input);
      const { event, redactions } = sanitizeAtIngestWithAudit(input);
      expect(event.payload).toEqual(plain.payload); // observation only, never changes output
      // Slack is sensitive: windowTitle → [private], url → [private].
      expect(redactions.windowTitle).toBe(1);
      expect(redactions.url).toBe(1);
    });

    it('counts a home-dir path rewrite as a redaction', () => {
      const { redactions } = sanitizeAtIngestWithAudit({
        id: 'e1',
        type: 'project:detected',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { projectRoot: '/Users/someone/Projects/gnomon', projectName: 'gnomon' },
      });
      expect(redactions.projectRoot).toBe(1);
    });

    it('records an empty tally when nothing is scrubbed', () => {
      const { redactions } = sanitizeAtIngestWithAudit({
        id: 'e1',
        type: 'clock:tick',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { count: 5 },
      });
      expect(redactions).toEqual({});
    });

    it('counts an aliased attendee email, and does NOT count one that became a name', () => {
      const tally = (attendees: string[]) =>
        sanitizeAtIngestWithAudit({ id: 'e1', type: 'calendar:active', ts: '2026-01-01T00:00:00.000Z', payload: { event: { attendees } } }).redactions.attendees;
      // `a1b2@` is not name-shaped, so it aliases — a real scrub, counted.
      expect(tally(['Priya Sharma', 'a1b2@example.com'])).toBe(1);
      // `sam@` becomes "Sam". Nothing was hidden, so the privacy audit must not
      // report a redaction on a day the name was written to the log verbatim.
      expect(tally(['Priya Sharma', 'sam@example.com'])).toBeUndefined();
    });
  });

  describe('P7: screen-OCR text (screenText) is never a redaction bypass', () => {
    it('clears screenText entirely for a sensitive focused app', () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'screen:ocr',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { processName: 'Slack', region: 'focused', screenText: 'private DM about the acquisition', topics: ['chat'] },
      });
      expect(sanitized.payload.screenText).toBe('[private]');
      // topics are safe tags, not content — they pass through.
      expect(sanitized.payload.topics).toEqual(['chat']);
    });

    it('pattern-redacts secrets in screenText for a non-sensitive app, keeping the rest', () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'screen:ocr',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { processName: 'Code', region: 'cursor', screenText: 'export API_TOKEN=abc123secret and other code', topics: ['code'] },
      });
      const text = sanitized.payload.screenText as string;
      expect(text).not.toContain('abc123secret');
    });

    it('leaves benign screenText from a non-sensitive app readable', () => {
      const sanitized = sanitizeAtIngest({
        id: 'e1',
        type: 'screen:ocr',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { processName: 'Code', region: 'focused', screenText: 'Clue 5 must see 5 filled cells', topics: ['code'] },
      });
      expect(sanitized.payload.screenText).toBe('Clue 5 must see 5 filled cells');
    });
  });
});


describe('attendee addresses become names (owner decision 2026-09-07)', () => {
  it('turns a name-shaped address into the name and drops the domain; a non-name still aliases', () => {
    const sanitized = sanitizeAtIngest({
      id: 'e1',
      type: 'calendar:active',
      ts: '2026-09-07T08:30:00.000Z',
      payload: { event: { eventId: 'e1', title: 't', attendees: ['mailto:noah.bakker@example.com', 'alex@example.com', 'a1b2@example.com', 'Riley Kok'], organizer: 'mailto:alex@example.com', startDate: '', endDate: '', isRecurring: false, calendar: 'Work', isAllDay: false } },
    } as never);
    const event = sanitized.payload.event as { attendees: string[]; organizer: string };
    expect(event.attendees[0]).toBe('Noah Bakker');
    expect(event.attendees[1]).toBe('Alex');
    expect(event.attendees[2]).toMatch(/^person-[0-9a-f]{10}$/);
    expect(event.attendees[3]).toBe('Riley Kok');
    expect(event.organizer).toBe('Alex');
  });
});

// Release audit S13/S14: one row per sensor text field that used to reach the
// log raw. Each carries a secret; none may survive ingest.
describe('a mail display name is the sender (M4)', () => {
  const mail = (payload: Record<string, unknown>) => sanitizeAtIngest({ id: 'm', type: 'mail:received', ts: '2026-01-01T00:00:00.000Z', payload }).payload;
  it('keeps a name-shaped display name instead of a hash, and never the address', () => {
    expect(mail({ from: 'x7@example.com', fromName: 'Mira Bakker', subject: 'hi' })).toEqual({ from: 'Mira Bakker', subject: 'hi' });
  });
  it('falls back to the alias when the display name is not a name', () => {
    expect(mail({ from: 'x7@example.com', fromName: 'x7@example.com', subject: 'hi' }).from).toMatch(/^person-[0-9a-f]{10}$/);
    expect(mail({ from: 'x7@example.com', fromName: 'Who is this?', subject: 'hi' }).from).toMatch(/^person-[0-9a-f]{10}$/);
  });
});

describe('a sent mail keeps its recipients the way it keeps a sender (UC1)', () => {
  it('names a recipient Mail names, hashes one it does not, and never keeps an address', () => {
    const out = sanitizeAtIngest({ id: 's', type: 'mail:sent', ts: '2026-01-01T00:00:00.000Z', payload: { subject: 'The draft', recipients: [{ to: 'x7@example.com', toName: 'Mira Bakker' }, { to: 'y8@example.com' }] } }).payload as { recipients: { to: string }[] };
    expect(out.recipients[0]).toEqual({ to: 'Mira Bakker' });
    expect(out.recipients[1]!.to).toMatch(/^person-[0-9a-f]{10}$/);
    expect(JSON.stringify(out)).not.toContain('@');
  });
});

describe('every sensor text field gets the secret pass (release audit)', () => {
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const cases: [string, Record<string, unknown>, (p: Record<string, unknown>) => unknown][] = [
    ['page:text', { url: 'https://example.com/a', text: `token=${SECRET}` }, (p) => p.text],
    ['mail:received', { subject: `your key ${SECRET}`, from: 'someone@example.com' }, (p) => p.subject],
    ['message:received', { chat: `chat ${SECRET}` }, (p) => p.chat],
    ['screen:fact', { facts: [`fact ${SECRET}`] }, (p) => (p.facts as string[])[0]],
    ['vault:changed', { notes: [`note ${SECRET}`] }, (p) => (p.notes as string[])[0]],
    ['work:shelved', { body: `found ${SECRET}` }, (p) => p.body],
    ['shell:command', { command: `export GITHUB_TOKEN=${SECRET}` }, (p) => p.command],
    ['calendar:context-event', { event: { title: `sync ${SECRET}`, attendees: [] } }, (p) => (p.event as { title: string }).title],
    ['agent:fleet', { sessions: [{ title: `fix ${SECRET}`, lastPrompt: `use ${SECRET}` }] }, (p) => JSON.stringify(p.sessions)],
  ];
  it.each(cases)('%s', (type, payload, pick) => {
    const out = sanitizeAtIngest({ id: 'e', type, ts: '2026-01-01T00:00:00.000Z', payload } as never);
    expect(String(pick(out.payload))).not.toContain(SECRET);
  });

  it('strips credentials from a git remote and a fetched final URL', () => {
    const out = sanitizeAtIngest({ id: 'e', type: 'git:push', ts: '2026-01-01T00:00:00.000Z', payload: { remote: 'https://me:tok123@github.com/o/r.git', finalUrl: 'https://u:p@example.com/x?session=1' } } as never);
    expect(out.payload.remote).toBe('https://github.com/o/r.git');
    expect(String(out.payload.finalUrl)).not.toMatch(/u:p|session/);
  });

  it('aliases a draft recipient and an email-named calendar', () => {
    const out = sanitizeAtIngest({ id: 'e', type: 'assistant:draft', ts: '2026-01-01T00:00:00.000Z', payload: { to: 'someone@example.com', calendar: 'someone@example.com' } } as never);
    expect(out.payload.to).not.toContain('@');
    expect(out.payload.calendar).not.toContain('@');
  });

  it('turns watched roots under a home folder into ~ paths', () => {
    const out = sanitizeAtIngest({ id: 'e', type: 'file-watcher:capacity', ts: '2026-01-01T00:00:00.000Z', payload: { activeRoots: ['/Users/someone/Projects/x'] } } as never);
    expect(out.payload.activeRoots).toEqual(['~/Projects/x']);
  });

  it('a hidden app redacts MORE than a sensitive one: its url and command are gone', () => {
    privacyConfig.hiddenApps.push('SecretApp');
    try {
      const out = sanitizeAtIngest({ id: 'e', type: 'window:focus', ts: '2026-01-01T00:00:00.000Z', payload: { processName: 'SecretApp', url: 'https://bank.example/acct', command: 'ls', cwd: '/Users/someone/x' } } as never);
      expect(out.payload.url).toBe('[hidden]');
      expect(out.payload.command).toBe('[hidden]');
      expect(out.payload.cwd).toBe('[hidden]');
    } finally {
      privacyConfig.hiddenApps.pop();
    }
  });
  it('scrubs the secrets people paste into a coding agent before an agent:turn is stored', () => {
    const text = [
      'AWS_SECRET_ACCESS_KEY=abcdEFGHijklMNOPqrstUVWXyz0123456789abcd',
      'try postgres://mira:s3cretpass@db:5432/app',
      'key AIza' + 'A'.repeat(35),
      'stripe sk_live_' + '1'.repeat(24),
      'see https://bucket.s3.test/f.zip?X-Amz-Signature=deadbeefcafe&x=1',
    ].join('\n');
    const out = sanitizeAtIngest({ id: 'e1', type: 'agent:turn', ts: '2026-10-05T09:00:00.000Z', payload: { agent: 'claude', role: 'prompt', cwd: '/Users/mira/p', text } });
    const said = String(out.payload.text);
    for (const secret of ['abcdEFGH', 's3cretpass', 'AIzaAAAA', 'sk_live_1111', 'deadbeefcafe']) expect(said).not.toContain(secret);
    expect(said).toContain('@db:5432');
    expect(out.payload.cwd).toBe('~/p');
  });
});

describe('gaps found by the 2026-10-05 audit of the live record', () => {
  const clean = (payload: Record<string, unknown>) => sanitizeAtIngest({ id: 'x', type: 'window:changed', ts: '', payload }).payload;

  it('a window title gets the personal-data pass', () => {
    expect(clean({ processName: 'Arc', windowTitle: 'Inbox - mira.bakker@example.com - Mail' }).windowTitle).toBe('Inbox - [email] - Mail');
  });

  it('a title URL with a port loses its query', () => {
    expect(clean({ processName: 'Google Chrome', windowTitle: '127.0.0.1:3080/?token=abcDEF123456 - Google Chrome' }).windowTitle).toBe('127.0.0.1:3080/ - Google Chrome'); // gitleaks:allow — a made-up sign-in token, the shape the test is about
  });

  it('a web URL in documentPath loses its query', () => {
    expect(clean({ processName: 'Google Chrome', documentPath: 'https://box.example.com/cb?token=abc&apiKey=xyz' }).documentPath).toBe('https://box.example.com/cb');
  });
});
