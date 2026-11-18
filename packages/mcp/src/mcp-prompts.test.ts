import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// fallow-ignore-next-line unresolved-import
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// fallow-ignore-next-line unresolved-import
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeDatabase } from '@sundial/db/db-migrate.js';
import { createMcpServer } from './index.js';
import { briefText } from './mcp-prompts.js';

/** B5: three prompts a host shows as slash commands, each the record as text plus one instruction. */
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-mcp-prompts-'));
  process.env.SUNDIAL_HOME = home;
  process.env.DATABASE_URL = 'file::memory:';
  await initializeDatabase();
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

async function client(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(a);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(b);
  return c;
}
const textOf = (p: { messages: { content: { type: string; text?: string } }[] }) => (p.messages[0].content as { text?: string }).text ?? '';

describe('the prompts (B5)', () => {
  it('lists brief, today and handoff with their arguments', async () => {
    const c = await client();
    const prompts = (await c.listPrompts()).prompts;
    expect(prompts.map((p) => p.name).sort()).toEqual(['brief', 'handoff', 'today']);
    expect(prompts.find((p) => p.name === 'handoff')?.arguments?.find((a) => a.name === 'project')?.required).toBe(true);
    expect(prompts.find((p) => p.name === 'brief')?.arguments?.map((a) => a.name)).toEqual(['kind', 'title']);
    await c.close();
  });

  it('renders each one over an empty record as one user message, the record then the instruction', async () => {
    const c = await client();
    const brief = await c.getPrompt({ name: 'brief', arguments: {} });
    expect(brief.messages).toHaveLength(1);
    expect(brief.messages[0].role).toBe('user');
    expect(textOf(brief)).toBe("No kernel state has been written yet.\n\nThis is Sundial's record, read without a model. Say it to the owner as it is; add nothing the record does not say, and say plainly what is empty.");
    const today = await c.getPrompt({ name: 'today', arguments: { date: '2026-09-14' } });
    expect(textOf(today)).toMatch(/^Today · 2026-09-14 \(/);
    expect(textOf(today)).toContain('Nothing was observed on 2026-09-14');
    const handoff = await c.getPrompt({ name: 'handoff', arguments: { project: 'puzzlebox-studio', days: '14' } });
    expect(textOf(handoff)).toContain('No project matches "puzzlebox-studio".');
    await expect(c.getPrompt({ name: 'handoff', arguments: {} })).rejects.toThrow();
    await c.close();
  });
});

describe('the brief as text', () => {
  it('names the kind, keeps the lines, and says what is empty', () => {
    expect(briefText('standup', { lines: ['Yesterday: 3 commits on puzzlebox-studio.', 'Today: standup 09:30.'], lastWorkDay: '2026-10-04' })).toBe('Standup\nYesterday: 3 commits on puzzlebox-studio.\nToday: standup 09:30.');
    expect(briefText('meeting', { meeting: { title: 'Design sync', start: '2026-10-05T13:00:00.000Z' }, lines: ['Mira Bakker: owes you the brief.'] })).toBe('Meeting prep\nPrep for "Design sync" at 2026-10-05T13:00:00.000Z:\nMira Bakker: owes you the brief.');
    expect(briefText('meeting', { none: 'No meeting with others is on the calendar ahead.' })).toBe('No meeting with others is on the calendar ahead.');
    expect(briefText('week', { from: '2026-09-28', commits: 12, note: 'This is the review of the week of 2026-09-28.' })).toContain('The week in review');
  });
});
