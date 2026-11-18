import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A home of its own: the theme's tests mount the consumer on the run's shared test home.
process.env.SUNDIAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-writes-home-'));

const mocks = vi.hoisted(() => ({ getAllSignalsInRange: vi.fn(), getSignalsInRange: vi.fn(async () => []) }));
vi.mock('@sundial/db/index.js', () => mocks);

const { OWNER_HOST_ONLY, WRITE_TOOLS } = await import('./mcp-writes.js');
const { registerTools } = await import('./mcp-tools.js');
const { getSundialRuntimeDir } = await import('@sundial/helpers/sundial-paths.js');

const dir = () => path.join(getSundialRuntimeDir(), 'mcp-writes');
const requests = () => (fs.existsSync(dir()) ? fs.readdirSync(dir()).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8'))) : []);
const env = { now: new Date('2026-10-01T10:00:00.000Z'), state: async () => null };
const tool = (name: string) => WRITE_TOOLS.find((t) => t.name === name)!;

beforeEach(() => {
  fs.rmSync(dir(), { recursive: true, force: true });
  mocks.getAllSignalsInRange.mockReset();
});

describe('the MCP writes', () => {
  it('mark a delivered notice seen by its key, through the feedback handler', async () => {
    mocks.getAllSignalsInRange.mockResolvedValue([{ id: '01NOTICEAA', signalType: 'notice', eventType: 'delivered', capturedAt: '2026-10-01T09:00:00.000Z', data: { noticeKey: 'k-push', acts: ['inject'] } }]);
    expect(await tool('gnomon_notice_seen').handler({ id: '01NOTICEAA' }, env)).toMatchObject({ queued: true });
    expect(requests()).toEqual([{ write: 'feedback', at: '2026-10-01T10:00:00.000Z', body: { seen: true, artifactKind: 'notice', artifactId: 'k-push', surface: 'agent' } }]);
    expect(await tool('gnomon_notice_seen').handler({ id: '01NOTHERE0' }, env)).toHaveProperty('error');
    expect(requests()).toHaveLength(1);
    // From the notices page in a host (B3): the same write, and the record keeps where it was seen.
    await tool('gnomon_notice_seen').handler({ id: '01NOTICEAA', surface: 'mcp-app' }, { ...env, now: new Date('2026-10-01T10:00:01.000Z') });
    expect(requests()[1].body).toEqual({ seen: true, artifactKind: 'notice', artifactId: 'k-push', surface: 'mcp-app' });
  });

  it('queue a verdict and an assertion as the routes take them, one whole file each', async () => {
    await tool('gnomon_feedback').handler({ artifactKind: 'entity_fact', artifactId: 'f1', verdict: 'wrong', note: 'Mira left in June' }, env);
    await tool('gnomon_assert').handler({ entityKind: 'person', canonicalName: 'Mira Bakker', predicate: 'worksOn', object: 'puzzlebox-studio' }, { ...env, now: new Date('2026-10-01T10:00:01.000Z') });
    expect(requests().map((r) => [r.write, r.body])).toEqual([
      ['feedback', { artifactKind: 'entity_fact', artifactId: 'f1', verdict: 'wrong', note: 'Mira left in June' }],
      ['assert', { entityKind: 'person', canonicalName: 'Mira Bakker', predicate: 'worksOn', object: 'puzzlebox-studio' }],
    ]);
    expect(fs.readdirSync(dir()).every((n) => n.endsWith('.json') && !n.startsWith('.'))).toBe(true);
  });

  it("queue the owner's answer to the open question as the seat's own write (B4)", async () => {
    expect(await tool('gnomon_owner_answer').handler({ askId: ' ask-7 ', answer: ' Mira Bakker ' }, env)).toMatchObject({ queued: true, askId: ' ask-7 ' });
    expect(requests()).toEqual([{ write: 'answer', at: '2026-10-01T10:00:00.000Z', body: { askId: 'ask-7', answer: 'Mira Bakker' } }]);
  });

  it('are said to be writes, and audited like the reads, never with their arguments', async () => {
    const seen = new Map<string, { annotations: { readOnlyHint: boolean }; handler: (a: unknown) => Promise<unknown> }>();
    registerTools({ tool: (name: string, _d: string, _s: unknown, annotations: { readOnlyHint: boolean }, handler: (a: unknown) => Promise<unknown>) => seen.set(name, { annotations, handler }) } as never);
    expect(['gnomon_notice_seen', 'gnomon_feedback', 'gnomon_assert', 'gnomon_owner_answer'].map((n) => seen.get(n)?.annotations.readOnlyHint)).toEqual([false, false, false, false]);
    expect(seen.get('gnomon_notices')?.annotations.readOnlyHint).toBe(true);
    await seen.get('gnomon_feedback')!.handler({ artifactKind: 'notice', artifactId: 'made-up-secret-key', verdict: 'useful' });
    const audit = fs.readFileSync(path.join(getSundialRuntimeDir(), 'mcp-calls.jsonl'), 'utf8').trim().split('\n').at(-1)!;
    expect(JSON.parse(audit)).toMatchObject({ tool: 'gnomon_feedback', outcome: 'ok' });
    expect(audit).not.toContain('made-up-secret-key');
  });
});

describe("the owner host's rule writes (observatory §5)", () => {
  const owner = { ...env, ownerHost: 'observatory' };
  const spec = { title: 'Slack burst', when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Slack' }] }, say: 'Slack again' };

  it('refuse a host that is not the owner host, and queue nothing', async () => {
    expect(await tool('gnomon_adopt_rule').handler({ rule: spec }, env)).toEqual(OWNER_HOST_ONLY);
    expect(await tool('gnomon_drop_rule').handler({ id: 'slack-burst' }, env)).toEqual(OWNER_HOST_ONLY);
    expect(requests()).toEqual([]);
  });

  it('adopt backtests over 30 days and queues the checked spec, its predicted rate and its flow', async () => {
    const out = await tool('gnomon_adopt_rule').handler({ rule: spec, flow: { id: 'chat-flow', title: 'Chat, then', step: 1 } }, owner);
    expect(out).toMatchObject({ queued: true, id: 'slack-burst', predicted: { fired: 0, days: 30, heard: 0 } });
    expect(mocks.getSignalsInRange).toHaveBeenCalled();
    expect(requests()).toEqual([{ write: 'adopt', at: '2026-10-01T10:00:00.000Z', body: { rule: expect.objectContaining({ id: 'slack-burst', say: 'Slack again' }), predicted: { fired: 0, days: 30, heard: 0 }, flow: { id: 'chat-flow', title: 'Chat, then', step: 1 }, host: 'observatory' } }]);
    expect(await tool('gnomon_adopt_rule').handler({ rule: { title: 'x' } }, owner)).toHaveProperty('error');
    expect(await tool('gnomon_adopt_rule').handler({ rule: spec, flow: { id: 'f', title: 't', step: 0 } }, owner)).toHaveProperty('error');
    expect(requests()).toHaveLength(1);
  });

  it('pause and resume are owner-host writes too, by rule or by flow', async () => {
    expect(await tool('gnomon_pause_rule').handler({ flow: 'chat-flow' }, env)).toEqual(OWNER_HOST_ONLY);
    expect(await tool('gnomon_pause_rule').handler({ flow: 'chat-flow' }, owner)).toMatchObject({ queued: true });
    expect(await tool('gnomon_resume_rule').handler({ id: 'slack-burst' }, { ...owner, now: new Date('2026-10-01T10:00:01.000Z') })).toMatchObject({ queued: true });
    expect(requests().map((r) => [r.write, r.body])).toEqual([['pause', { flow: 'chat-flow', host: 'observatory' }], ['resume', { id: 'slack-burst', host: 'observatory' }]]);
  });

  it('revoking a reach run alone is an owner-host write', async () => {
    expect(await tool('gnomon_reach_revoke').handler({ id: 'publish', tool: 'gnomon_calendar_create' }, env)).toEqual(OWNER_HOST_ONLY);
    expect(await tool('gnomon_reach_revoke').handler({ id: 'publish', tool: 'gnomon_calendar_create' }, owner)).toMatchObject({ queued: true });
    expect(requests().map((r) => [r.write, r.body])).toEqual([['revoke', { id: 'publish', tool: 'gnomon_calendar_create', host: 'observatory' }]]);
  });

  it('drop names one rule or one flow, not both and not neither', async () => {
    expect(await tool('gnomon_drop_rule').handler({ flow: 'chat-flow' }, owner)).toMatchObject({ queued: true, flow: 'chat-flow' });
    expect(await tool('gnomon_drop_rule').handler({}, owner)).toHaveProperty('error');
    expect(await tool('gnomon_drop_rule').handler({ id: 'a', flow: 'b' }, owner)).toHaveProperty('error');
    expect(requests().map((r) => [r.write, r.body])).toEqual([['drop', { flow: 'chat-flow', host: 'observatory' }]]);
  });
});

describe('gnomon_test_rule with a flow, through the registry (observatory §2)', () => {
  it('replays the steps together and never reads the flow\'s own emitted types from the log', async () => {
    const { executeGnomonTool } = await import('@sundial/kernel/tools/index.js');
    mocks.getSignalsInRange.mockClear();
    const flow = [
      { title: 'Failed', when: { type: 'shell:command' }, emit: 'custom:failed' },
      { title: 'Pushed', when: { type: 'custom:failed' }, say: 'x' },
    ];
    const out = (await executeGnomonTool('gnomon_test_rule', { rule: flow, days: 7 }, env)) as Record<string, unknown>;
    expect(out).toMatchObject({ valid: true, days: 7, steps: [{ id: 'failed', fired: 0 }, { id: 'pushed', fired: 0 }], chain: { fired: 0, heard: 0 } });
    const types = (mocks.getSignalsInRange.mock.calls[0] as unknown[])[3] as string[];
    expect(types).toContain('shell:command');
    expect(types).not.toContain('custom:failed');
    expect(await executeGnomonTool('gnomon_test_rule', { rule: [flow[1], flow[0]] }, env)).toMatchObject({ valid: false, error: expect.stringContaining('step 1 hears') });
    expect(await executeGnomonTool('gnomon_test_rule', { rule: flow, sweep: { field: 'count.atLeast', from: 1, to: 2, step: 1 } }, env)).toMatchObject({ valid: false });
  });
});

describe('gnomon_ingest (observatory §4)', () => {
  it('queues a declared inlet event with its declared fields only, for any host; refuses an undeclared one', async () => {
    const home = process.env.SUNDIAL_HOME!;
    fs.writeFileSync(path.join(home, 'inlets.json'), JSON.stringify({ 'ext:deploy': { fields: { service: 'string', ok: 'boolean' } } }));
    expect(await tool('gnomon_ingest').handler({ type: 'ext:deploy', payload: { service: 'api', ok: true, token: 'secret' } }, env)).toMatchObject({ queued: true, type: 'ext:deploy', dropped: ['token'] });
    expect(await tool('gnomon_ingest').handler({ type: 'ext:nope', payload: {} }, env)).toHaveProperty('error');
    expect(requests().map((r) => [r.write, r.body])).toEqual([['ingest', { type: 'ext:deploy', payload: { service: 'api', ok: true } }]]);
    fs.rmSync(path.join(home, 'inlets.json'));
  });
});

describe('gnomon_rule_verdict (observatory §6)', () => {
  it('queues the owner\'s verdict on one fire', async () => {
    expect(await tool('gnomon_rule_verdict').handler({ id: 'slack-burst', fireId: 'ev1', useful: false }, env)).toMatchObject({ queued: true });
    expect(requests().map((r) => [r.write, r.body])).toEqual([['verdict', { id: 'slack-burst', fireId: 'ev1', useful: false }]]);
  });
});
