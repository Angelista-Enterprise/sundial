import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// fallow-ignore-next-line unresolved-import
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// fallow-ignore-next-line unresolved-import
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// fallow-ignore-next-line unresolved-import
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { initializeDatabase } from '@sundial/db/db-migrate.js';
import { insertSignal, insertSnapshot, markEffectCompleted, markEffectStarted } from '@sundial/db/index.js';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { createMcpServer } from './index.js';
import { fastVersions, liveRulesState, liveVersions, type FastVersions, type LiveVersions } from './mcp-live.js';

/** B6: a listening host hears a notice land, and reads it. */
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-mcp-live-'));
  process.env.SUNDIAL_HOME = home;
  process.env.DATABASE_URL = 'file::memory:';
  await initializeDatabase();
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const quiet: LiveVersions = { 'sundial://context': 's1', 'sundial://notices': '' };

async function client(versions: () => LiveVersions): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ live: { check: async () => versions(), intervalMs: 15 } }).connect(a);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(b);
  return c;
}

/** A delivered notice, as the gate writes it: the candidate with the words, then the delivery naming its key. */
async function deliver(id: string, at: string, text: string): Promise<void> {
  const before = new Date(Date.parse(at) - 1000).toISOString();
  await insertSignal({ id: `${id}-c`, signalType: 'notice', eventType: 'candidate', data: { key: `k-${id}`, kind: 'build', observation: text }, capturedAt: before });
  await insertSignal({ id, signalType: 'notice', eventType: 'delivered', data: { noticeKey: `k-${id}`, acts: ['banner'] }, capturedAt: at });
}

describe('the live resources (B6)', () => {
  it('lists context and notices as resources a host can read as JSON', async () => {
    const c = await client(() => quiet);
    const uris = (await c.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain('sundial://context');
    expect(uris).toContain('sundial://notices');
    const read = await c.readResource({ uri: 'sundial://notices' });
    const page = read.contents[0] as { mimeType: string; text: string };
    expect(page.mimeType).toBe('application/json');
    expect(JSON.parse(page.text)).toMatchObject({ total: 0, notices: [] });
    await expect(c.subscribeResource({ uri: 'ui://sundial/today.html' })).rejects.toThrow(/can be subscribed/);
    await c.close();
  });

  it('tells a subscribed host when a notice lands, and the host reads it; silent until then and after unsubscribe', async () => {
    let versions = { ...quiet };
    const c = await client(() => versions);
    const updates: string[] = [];
    c.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.push(n.params.uri));
    await c.subscribeResource({ uri: 'sundial://notices' });
    await new Promise((r) => setTimeout(r, 60));
    expect(updates).toEqual([]);

    const now = new Date(Date.now() - 60_000).toISOString();
    await deliver('01NOTICELIVE', now, 'The test run on puzzlebox-studio has failed twice.');
    versions = { ...versions, 'sundial://notices': '01NOTICELIVE', 'sundial://context': 's2' };
    for (let i = 0; i < 40 && updates.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    // Only what was subscribed to: the context moved too and nobody listens to it.
    expect(updates).toEqual(['sundial://notices']);
    const read = JSON.parse(((await c.readResource({ uri: 'sundial://notices' })).contents[0] as { text: string }).text) as { notices: { id: string; text: string }[] };
    expect(read.notices.map((n) => [n.id, n.text])).toEqual([['01NOTICELIVE', 'The test run on puzzlebox-studio has failed twice.']]);

    await c.unsubscribeResource({ uri: 'sundial://notices' });
    versions = { ...versions, 'sundial://notices': 'later' };
    await new Promise((r) => setTimeout(r, 60));
    expect(updates).toHaveLength(1);
    await c.close();
  });

  it('reads the versions off the record: the newest delivered notice, the newest snapshot', async () => {
    const v = await liveVersions();
    expect(v['sundial://notices']).toBe('01NOTICELIVE');
    expect(v['sundial://context']).toBe('');
  });
});

describe('sundial://fold and sundial://rules (observatory §5)', () => {
  const readJson = async (c: Client, uri: string) => JSON.parse(((await c.readResource({ uri })).contents[0] as { text: string }).text);

  it('the fold is the journal cut to rule, kind and emitted type, never the rest of the detail', async () => {
    await markEffectStarted('ev1', 0, { ruleName: 'watchRules', eventType: 'shell:command', effectDetail: 'EmitEvent custom:failed' });
    await markEffectStarted('ev1', 1, { ruleName: 'noticeGate', eventType: 'shell:command', effectDetail: 'Notify private words here' });
    await markEffectCompleted('ev1', 0);
    const c = await client(() => quiet);
    const uris = (await c.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(['sundial://fold', 'sundial://rules']));
    const { rows } = await readJson(c, 'sundial://fold');
    expect(rows.map((r: Record<string, unknown>) => [r.event_id, r.effect_index, r.rule_name, r.event_type, r.kind, r.emitted, r.status])).toEqual([
      ['ev1', 0, 'watchRules', 'shell:command', 'EmitEvent', 'custom:failed', 'completed'],
      ['ev1', 1, 'noticeGate', 'shell:command', 'Notify', null, 'started'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('private');
    await c.close();
  });

  it('the rules are the snapshot with the rule:* signals since folded on top, and move on a rule signal', async () => {
    const versions = async () => fastVersions();
    const before: FastVersions = await versions();
    await insertSnapshot({ id: '01SNAP0000', stateJson: JSON.stringify(createInitialState('d')), logOffset: '01NOTICELIVE' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ live: { check: async () => quiet, checkFast: versions, fastIntervalMs: 15 } }).connect(a);
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(b);
    const updates: string[] = [];
    c.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.push(n.params.uri));
    await c.subscribeResource({ uri: 'sundial://rules' });
    expect((await readJson(c, 'sundial://rules')).rules).toEqual([]);
    const rule = { title: 'Slack burst', when: { type: 'window:changed' }, say: 'x' };
    await insertSignal({ id: '01RULEADOPT', signalType: 'rule', eventType: 'adopted', data: { rule, via: 'mcp-owner' }, capturedAt: new Date().toISOString() });
    for (let i = 0; i < 40 && updates.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(updates).toEqual(['sundial://rules']);
    expect((await versions())['sundial://rules']).not.toBe(before['sundial://rules']);
    const { rules } = await readJson(c, 'sundial://rules');
    expect(rules).toEqual([expect.objectContaining({ id: 'slack-burst', paused: false, version: 1, fires: 0 })]);
    await c.close();
  });

  it('S4 (Fable M5): a rig chat marked since the snapshot is marked in the replay too, so its sandbox adoption never reaches the owner\'s rules', async () => {
    const at = new Date().toISOString();
    await insertSignal({ id: '01RULF00001', signalType: 'thread', eventType: 'model', data: { sessionId: 'session-rig', provider: 'openai', model: 'test-2', rig: true }, capturedAt: at });
    await insertSignal({ id: '01RULF00002', signalType: 'rule', eventType: 'adopted', data: { rule: { title: 'Rig watch', when: { type: 'window:changed' }, say: 'y' }, sessionId: 'session-rig' }, capturedAt: at });
    await insertSignal({ id: '01RULF00003', signalType: 'rule', eventType: 'paused', data: { id: 'slack-burst', sessionId: 'session-rig' }, capturedAt: at });
    const state = await liveRulesState();
    expect(state?.watch?.rules.map((r) => r.title)).toEqual(['Slack burst']);
    expect(state?.watch?.paused ?? []).toEqual([]);
  });
});
