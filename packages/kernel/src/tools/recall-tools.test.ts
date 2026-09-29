import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECALL_TOOLS } from './recall-tools.js';

const mocks = vi.hoisted(() => ({
  countSignalsInRange: vi.fn(),
  getAllEntities: vi.fn(),
  getGateDecisionsBetween: vi.fn(),
  getMomentsBetween: vi.fn(),
  getPromises: vi.fn(),
  getSignalsInRange: vi.fn(),
  loadAliasNames: vi.fn(),
  loadLatestSnapshot: vi.fn(),
}));

vi.mock('@sundial/db/index.js', () => mocks);
vi.mock('../snapshot.js', () => ({ loadLatestSnapshot: mocks.loadLatestSnapshot }));
vi.mock('@sundial/helpers/sundial-config.js', () => ({ loadSundialConfig: () => ({ timezone: 'UTC' }) }));

const tool = (name: string) => RECALL_TOOLS.find((t) => t.name === name)!;
const signal = (id: string, type: string, capturedAt: string, data: Record<string, unknown>) => ({ id, signalType: type.split(':')[0], eventType: type.split(':')[1], capturedAt, data });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAllEntities.mockResolvedValue([{ kind: 'person', canonicalName: 'Mira Bakker' }]);
  mocks.loadAliasNames.mockResolvedValue({ 'person-0a1b2c3d4e': 'Mira Bakker' });
  mocks.getPromises.mockResolvedValue([]);
  mocks.getMomentsBetween.mockResolvedValue([]);
  mocks.countSignalsInRange.mockResolvedValue(0);
});

describe('gnomon_did_i', () => {
  it('reads one needle at a time, merges, and never shows a hash', async () => {
    const mail = signal('r1', 'mail:received', new Date(Date.now() - 3_600_000).toISOString(), { from: 'person-0a1b2c3d4e', subject: 'Invoice?' });
    mocks.getSignalsInRange.mockResolvedValue([mail]);
    const out = (await tool('gnomon_did_i').handler({ what: 'did I reply to Mira' })) as Record<string, any>;
    expect(out.answer).toBe('related only');
    expect(out.read).toMatchObject({ action: 'mail', person: { asked: 'mira' } });
    expect(JSON.stringify(out)).not.toMatch(/person-[0-9a-f]{6,}/);
    expect(out.evidence[0].text).toContain('Mira Bakker');
    expect(out.reply).toMatchObject({ mailToThemAfter: false });
    expect(out.blind[0]).toContain('0 rows');
    // One read per needle: mira, Mira Bakker, the hash.
    expect(mocks.getSignalsInRange.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('gnomon_timeline', () => {
  it('pages the lines and adds a postmortem when asked', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => signal(`s${i}`, 'shell:command', `2026-09-28T14:${String(i).padStart(2, '0')}:00.000Z`, { command: `step ${i}`, exitCode: i === 0 ? 1 : 0, cwd: '~/Projects/puzzlebox-studio' }));
    mocks.getSignalsInRange.mockResolvedValueOnce(rows).mockResolvedValue([]);
    const out = (await tool('gnomon_timeline').handler({ date: '2026-09-28', from: '14:00', to: '16:00', project: 'puzzlebox', postmortem: true, limit: 10 })) as Record<string, any>;
    expect(out.window).toBe('2026-09-28 14:00–16:00');
    expect(out.rows).toHaveLength(10);
    expect(out.total).toBe(30);
    expect(out.nextOffset).toBe(10);
    expect(out.postmortem).toContain('`step 0` failed 1×');
    const [from, to] = mocks.getSignalsInRange.mock.calls[0]!;
    expect([from, to]).toEqual(['2026-09-28T14:00:00.000Z', '2026-09-28T16:00:00.000Z']);
  });
});

describe('gnomon_what_if', () => {
  it('joins each candidate to its decision row and turns the priced cost back into a 0..1 cost', async () => {
    const ts = new Date(Date.now() - 86_400_000).toISOString();
    mocks.loadLatestSnapshot.mockResolvedValue({ state: { config: { timezone: 'UTC' }, settings: { noticeBias: 0, autonomy: 'act' }, watch: { rules: [] }, memory: { aliasNames: {} } } });
    mocks.getSignalsInRange.mockResolvedValue([signal('n1', 'notice:candidate', ts, { kind: 'agent-waiting', key: 'k1', surprise: 2, precision: 1, valueHalfLifeMs: 60_000, observation: 'agent waits', evidence: [], concerns: [] })]);
    mocks.getGateDecisionsBetween.mockResolvedValue([{ decidedAt: ts, noticeKey: 'k1', channel: 'deferred', interruptionCost: 0.8 }]);
    const out = (await tool('gnomon_what_if').handler({ cap: 0 })) as Record<string, any>;
    expect(out.now).toMatchObject({ deferred: 1 });
    expect(out.agreement).toContain('1 of 1');
    expect(out.current).toEqual({ cap: 6, budget: 4, dial: 0 });
    expect(out.change.cap).toBe(0);
  });

  it('says so when the rule is neither adopted nor a spec', async () => {
    mocks.loadLatestSnapshot.mockResolvedValue({ state: { config: { timezone: 'UTC' }, settings: { noticeBias: 0 }, watch: { rules: [] }, memory: { aliasNames: {} } } });
    mocks.getSignalsInRange.mockResolvedValue([]);
    mocks.getGateDecisionsBetween.mockResolvedValue([]);
    const out = (await tool('gnomon_what_if').handler({ rule: 'no-such-rule' })) as Record<string, any>;
    expect(out.error).toContain('No adopted rule');
  });
});
