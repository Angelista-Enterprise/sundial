import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// fallow-ignore-next-line unresolved-import
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// fallow-ignore-next-line unresolved-import
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeDatabase } from '@sundial/db/db-migrate.js';
import type { Figure } from '@sundial/kernel/types.js';
import { createMcpServer } from './index.js';
import { figureText, openAskText, todayText } from './mcp-apps.js';
// fallow-ignore-next-line unresolved-import
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { askLoop } from '@sundial/helpers/loops.js';

const { APPS, buildApps, rulesOf, shellCss } = // A URL, not a path: the bundler is plain JavaScript outside src/, and tsc must not try to emit it.
(await import(new URL('../apps/build.mjs', import.meta.url).href)) as { APPS: string[]; buildApps: () => Promise<string[]>; rulesOf: (css: string) => [string, string][]; shellCss: () => string };

/**
 * B2 on the server side: the three app tools say where their page is, the
 * pages are served as MCP App resources, every tool answers with text a host
 * without apps can read, and the whole thing runs over an empty record.
 */
let home: string;
let pages: string[];

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-mcp-apps-'));
  process.env.SUNDIAL_HOME = home;
  process.env.DATABASE_URL = 'file::memory:';
  await initializeDatabase();
  // The pages, built the way `pnpm build` builds them.
  pages = await buildApps();
}, 60_000);
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

async function client(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(a);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(b);
  return c;
}

describe('the MCP Apps (B2)', () => {
  it('attaches a page to Today, the figure and the goals, and registers each tool once', async () => {
    const c = await client();
    const tools = (await c.listTools()).tools;
    const ui = (name: string) => (tools.find((t) => t.name === name)?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
    expect(ui('gnomon_today')).toBe('ui://sundial/today.html');
    expect(ui('gnomon_compose_figure')).toBe('ui://sundial/figure.html');
    expect(ui('gnomon_goals')).toBe('ui://sundial/goals.html');
    expect(ui('gnomon_notices')).toBe('ui://sundial/notices.html');
    expect(ui('gnomon_llm_ledger')).toBe('ui://sundial/ledger.html');
    expect(ui('gnomon_open_ask')).toBe('ui://sundial/ask.html');
    expect(ui('gnomon_current_context')).toBeUndefined();
    expect(tools.filter((t) => t.name === 'gnomon_goals')).toHaveLength(1);
    expect(tools.find((t) => t.name === 'gnomon_today')?.annotations?.readOnlyHint).toBe(true);
    await c.close();
  });

  it('serves each page as one self-contained MCP App resource', async () => {
    const c = await client();
    const uris = (await c.listResources()).resources.map((r) => r.uri).filter((u) => u.startsWith('ui://')).sort();
    expect(uris).toEqual(['ui://sundial/ask.html', 'ui://sundial/figure.html', 'ui://sundial/goals.html', 'ui://sundial/ledger.html', 'ui://sundial/notices.html', 'ui://sundial/today.html']);
    const read = await c.readResource({ uri: 'ui://sundial/today.html' });
    const page = read.contents[0] as { mimeType: string; text: string };
    expect(page.mimeType).toBe('text/html;profile=mcp-app');
    expect(page.text).toContain('<script type="module">');
    expect(page.text).not.toMatch(/<script[^>]*\ssrc=/);
    await c.close();
  });

  it('answers each app tool with readable text and the data the page draws, over an empty record', async () => {
    const c = await client();
    const today = await c.callTool({ name: 'gnomon_today', arguments: { date: '2026-09-14' } });
    const todayText0 = (today.content as { text: string }[])[0].text;
    expect(todayText0).toMatch(/^Today · 2026-09-14 \(/);
    expect(todayText0).not.toContain('{');
    expect(Object.keys(today.structuredContent as object).sort()).toEqual(['brief', 'date', 'dial', 'rhythm', 'timeZone', 'today']);
    expect((today.structuredContent as { dial: { unavailable?: string } }).dial.unavailable).toContain('2026-09-14');

    const goals = await c.callTool({ name: 'gnomon_goals', arguments: {} });
    expect(JSON.parse((goals.content as { text: string }[])[0].text)).toEqual([]);
    expect(goals.structuredContent).toEqual({ goals: [], quietAfterDays: 14 });

    const figure = await c.callTool({ name: 'gnomon_compose_figure', arguments: { kind: 'census' } });
    const figureText0 = (figure.content as { text: string }[])[0].text;
    expect(figureText0.split('\n')[0]).toMatch(/^census/);
    expect((figure.structuredContent as { kind: string }).kind).toBe('census');

    const notices = await c.callTool({ name: 'gnomon_notices', arguments: {} });
    expect((notices.structuredContent as { notices: unknown[] }).notices).toEqual([]);
    expect(JSON.parse((notices.content as { text: string }[])[0].text)).toMatchObject({ total: 0 });
    const ledger = await c.callTool({ name: 'gnomon_llm_ledger', arguments: { days: 3 } });
    expect(ledger.structuredContent).toMatchObject({ groupBy: 'day', days: 3, rows: [] });

    // Audited like every other call, never with its arguments.
    const audit = fs.readFileSync(path.join(home, '.daemon', 'mcp-calls.jsonl'), 'utf8');
    expect(audit).toContain('"tool":"gnomon_today"');
    expect(audit).not.toContain('2026-09-14');
    await c.close();
  });
});

describe('the text a host without apps reads', () => {
  const dial: Figure = {
    kind: 'dial-slice',
    caption: 'dial-slice · today · 4h 47m observed of 10h 27m',
    openIn: 'today',
    date: '2026-10-05',
    fromHour: 6,
    toHour: 24,
    observedMin: 287,
    wallClockMin: 627,
    curve: [{ hour: 9, score: 80 }, { hour: 10, score: 65 }],
    meetings: [{ startHour: 11, endHour: 12 }],
    deepBlocks: [{ startHour: 9, endHour: 10.5 }],
    nowHour: 12.5,
  };

  it('says a figure as its caption and its numbers, one line each', () => {
    expect(figureText(dial)).toBe(['dial-slice · today · 4h 47m observed of 10h 27m', 'Axis 6:00 to 24:00; observed 4h 47m of 10h 27m; now at 12.5h.', 'Deep work: 9.0–10.5h.', 'Meetings: 11.0–12.0h.', 'Energy by hour: 9h 80, 10h 65.'].join('\n'));
    expect(figureText({ kind: 'trend-slice', caption: 'trend-slice · 3 days', openIn: 'trust', days: [{ date: '2026-10-03', minutes: 125, observed: true }, { date: '2026-10-04', minutes: 0, observed: false }] })).toContain('2026-10-04  not observed');
    expect(figureText({ kind: 'census', caption: 'census', openIn: 'trust', rows: [{ label: 'facts', count: 7, total: 30 }, { label: 'moments', count: 412, total: null }] })).toBe('census\nfacts  7 of 30\nmoments  412');
    expect(figureText({ kind: 'graph-neighborhood', caption: 'graph-neighborhood · Mira Bakker', openIn: 'memory', center: { id: 'x', name: 'Mira Bakker', kind: 'person' }, edges: [{ toName: 'puzzlebox-studio', predicate: 'collaboratesOn', provenance: 'observed' }] })).toContain('collaboratesOn → puzzlebox-studio [observed]');
    expect(figureText({ unavailable: 'Nothing was observed.' })).toBe('Nothing was observed.');
  });

  it('says Today as the brief, the dial\'s claim, the projects and the rhythm', () => {
    const text = todayText({
      date: '2026-10-05',
      timeZone: 'Europe/Amsterdam',
      brief: { lines: ['Yesterday: 3 commits on puzzlebox-studio.'] },
      dial,
      today: { projects: [{ name: 'puzzlebox-studio', minutes: 125, commits: 3 }], meetings: 1 } as never,
      rhythm: { dayStartsAt: 4, days: [{ date: '2026-10-04', firstMin: 300, lastMin: 1250, observedHours: 7.2 }, { date: '2026-10-05', firstMin: 290, lastMin: 390, observedHours: 2.1 }] } as never,
    });
    expect(text).toBe(['Today · 2026-10-05 (Europe/Amsterdam)', 'Yesterday: 3 commits on puzzlebox-studio.', '', 'dial-slice · today · 4h 47m observed of 10h 27m', 'Projects: puzzlebox-studio 2h 05m (3 commits).', 'Meetings: 1.', '', 'Rhythm, 2 days (first touch → last touch, hours seen):', '2026-10-05  08:50 → 10:30  2.1h', '2026-10-04  09:00 → 00:50  7.2h'].join('\n'));
  });
});

describe('the bundle', () => {
  it('is one HTML file per app that loads nothing else', () => {
    expect(pages.map((f) => path.basename(f))).toEqual(APPS.map((a) => `${a}.html`));
    for (const file of pages) {
      const html = fs.readFileSync(file, 'utf8');
      expect(html).toContain('<script type="module">');
      expect(html).not.toMatch(/<script[^>]*\ssrc=|<link[^>]*href=|import\(|@import/);
      expect(html).toContain('--ink: var(--color-text-primary');
      expect(html.length).toBeLessThan(1_000_000);
    }
  });

  it("carries the shell rules its drawings use, never the page's", () => {
    const css = shellCss();
    for (const sel of ['.arc-span', '.arc-now', '.trail-said', '.trail-now', '.surface-head', '.gauge-fill', 'table.grid', '.plate svg']) expect(css).toContain(sel);
    expect(css).not.toMatch(/\.pane-body|\.turn|^body/m);
    expect(rulesOf('@media (x) { .a { b: c } } .arc { d: e } /* .z { } */')).toEqual([['.arc', 'd: e']]);
  });
});

describe('the open question (B4)', () => {
  const ask = { askId: 'ask-7', question: 'Who is the unnamed attendee of the design sync?', reason: 'Three meetings this month.', choices: ['Mira Bakker', 'someone else'], ts: '2026-10-05T08:00:00.000Z' };
  const env = () => ({ now: new Date('2026-10-05T09:00:00.000Z'), state: async () => ({ loops: { open: [askLoop(ask)], recent: [] } }) as never });
  const requests = () => {
    const dir = path.join(home, '.daemon', 'mcp-writes');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))) : [];
  };
  async function hostWith(elicit: ((params: { message: string; requestedSchema: { properties: Record<string, { enum?: string[] }> } }) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string> }) | null): Promise<Client> {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ env }).connect(a);
    const c = new Client({ name: 'test', version: '0' }, elicit ? { capabilities: { elicitation: {} } } : {});
    if (elicit) c.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params as never));
    await c.connect(b);
    return c;
  }
  beforeAll(() => fs.rmSync(path.join(home, '.daemon', 'mcp-writes'), { recursive: true, force: true }));

  it('is text and the askId for a host without elicitation, and nothing is written', async () => {
    const c = await hostWith(null);
    const out = await c.callTool({ name: 'gnomon_open_ask', arguments: { ask: true } });
    const text = (out.content as { text: string }[])[0].text;
    expect(text).toContain('Gnomon asks: Who is the unnamed attendee');
    expect(text).toContain('Choices: Mira Bakker · someone else');
    expect(text).toContain('gnomon_owner_answer (askId ask-7)');
    expect((out.structuredContent as { open: { askId: string } }).open.askId).toBe('ask-7');
    expect(requests()).toEqual([]);
    await c.close();
  });

  it('puts the question to the owner as a form where the host has one, and queues their answer', async () => {
    const seen: unknown[] = [];
    const c = await hostWith((params) => {
      seen.push(params.message, params.requestedSchema.properties.answer.enum);
      return { action: 'accept', content: { answer: 'Mira Bakker' } };
    });
    const out = await c.callTool({ name: 'gnomon_open_ask', arguments: { ask: true } });
    expect(seen).toEqual(['Who is the unnamed attendee of the design sync?\n\nThree meetings this month.', ['Mira Bakker', 'someone else']]);
    expect((out.structuredContent as { answered: unknown }).answered).toEqual({ askId: 'ask-7', answer: 'Mira Bakker' });
    expect((out.content as { text: string }[])[0].text).toContain('The owner answered "Mira Bakker"');
    expect(requests()).toEqual([expect.objectContaining({ write: 'answer', body: { askId: 'ask-7', answer: 'Mira Bakker' } })]);
    // Not asked for: the capable host is only told it can.
    const quiet = await c.callTool({ name: 'gnomon_open_ask', arguments: {} });
    expect((quiet.content as { text: string }[])[0].text).toContain('Call again with ask: true');
    expect(requests()).toHaveLength(1);
    await c.close();
  });

  it('writes nothing when the owner dismisses the form', async () => {
    const c = await hostWith(() => ({ action: 'decline' }));
    const out = await c.callTool({ name: 'gnomon_open_ask', arguments: { ask: true } });
    expect((out.structuredContent as { declined: boolean }).declined).toBe(true);
    expect((out.content as { text: string }[])[0].text).toContain('Do not answer for them');
    expect(requests()).toHaveLength(1);
    await c.close();
  });

  it('says nothing is waiting over an empty record', async () => {
    const c = await client();
    const out = await c.callTool({ name: 'gnomon_open_ask', arguments: { ask: true } });
    expect((out.content as { text: string }[])[0].text).toBe('Gnomon is not waiting on the owner for anything right now.');
    expect(openAskText({ open: null }, true)).toBe('Gnomon is not waiting on the owner for anything right now.');
    await c.close();
  });
});
