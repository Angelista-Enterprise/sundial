import { describe, expect, it } from 'vitest';
import type { StoredMoment } from '@sundial/db/index.js';
import { MOMENT_FANOUT_QUESTIONS } from '@sundial/rules/questions/moment-fanout.js';
import { benchPacking, fanoutItemFromRow, packItems, pool, rejudgeMoments, unpackAnswers } from './rejudge.js';

const row = (id: string, over: Record<string, unknown> = {}): StoredMoment => ({
  id,
  startTime: '2026-09-01T10:00:00.000Z',
  endTime: '2026-09-01T10:31:00.000Z',
  durationMs: 31 * 60_000,
  processName: 'Code',
  data: { processName: 'Code', windowTitles: ['runtime.ts — sundial'], gitCommitCount: 1, gitBranch: 'main', activeMs: 25 * 60_000, kind: 'focus', ...over },
  importanceScore: 1,
  lastAccessedAt: null,
  projectId: '~/Projects/sundial',
});

const answer = (j: number) => ({
  [`subject__s${j}`]: { type: 'choice', choice: j % 2 ? 'app' : 'project', probabilities: { project: 0.7, app: 0.3 } },
  [`is_work__s${j}`]: { type: 'noul', noul: 0.5 + j / 10 },
  [`depth__s${j}`]: { type: 'score', score: 2 },
});

describe('J2.6 rejudge — pack five, unpack to the registry keys', () => {
  it('packs the states under `sessions` and points every question at its own entry', () => {
    const items = [row('m1'), row('m2', { kind: 'browse' })].map((r) => fanoutItemFromRow(r));
    const packed = packItems(items);
    expect(packed.state.sessions).toHaveLength(2);
    expect(packed.state.sessions[0]).toMatchObject({ app: 'Code', project: '~/Projects/sundial', minutes: 31, git_commits: 1 });
    // The derived `kind` never reaches the judge (law 2): the fan-out builder leaves it out.
    expect(packed.state.sessions[1]).not.toHaveProperty('kind');
    expect(Object.keys(packed.questions)).toHaveLength(Object.keys(MOMENT_FANOUT_QUESTIONS).length * 2);
    expect(packed.questions['subject__s1'].instructions).toBe(`In \`sessions[1]\` only: ${MOMENT_FANOUT_QUESTIONS.subject.instructions}`);
    expect(packed.questions['subject__s1'].criteria).toEqual(MOMENT_FANOUT_QUESTIONS.subject.criteria);
  });

  it('unpacks per moment under the registry keys and leaves an empty set where the answers are missing', () => {
    const items = [row('m1'), row('m2'), row('m3')].map((r) => fanoutItemFromRow(r));
    const per = unpackAnswers({ ...answer(0), ...answer(2) }, items);
    expect(per[0].subject).toMatchObject({ choice: 'project' });
    expect(per[0].is_work).toMatchObject({ noul: 0.5 });
    expect(per[1]).toEqual({});
    expect(per[2].is_work).toMatchObject({ noul: 0.7 });
  });

  it('one call per pack, one judgement:result per answered moment, marked backfill; a failed pack is counted and skipped', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`m${i}`));
    const calls: unknown[] = [];
    const ingested: { momentId: string | null; metadata?: Record<string, unknown>; answers: Record<string, unknown> }[] = [];
    const progress = await rejudgeMoments(
      rows,
      {
        backend: 'jev',
        judge: async (o) => {
          calls.push(o);
          const n = (o.state as { sessions: unknown[] }).sessions.length;
          if (n === 2) throw new Error('boom');
          return { answers: Object.assign({}, ...Array.from({ length: n }, (_, j) => answer(j))), model: 'typesafe/jev-latest', latencyMs: 400 };
        },
        ingest: async (p) => void ingested.push(p),
      },
      { packSize: 5, concurrency: 2 },
    );
    expect(calls).toHaveLength(2);
    expect(progress).toEqual({ total: 7, done: 5, calls: 2, failedCalls: 1 });
    expect(ingested).toHaveLength(5);
    expect(ingested[0]).toMatchObject({ momentId: 'm0', questionSetId: 'moment-fanout', purpose: 'classify', latencyMs: 80, metadata: { backfill: true } });
    expect(ingested[0].answers.subject).toMatchObject({ choice: 'project' });
    expect(ingested[1].answers.subject).toMatchObject({ choice: 'app' });
  });

  it('pool runs at most `limit` at once and settles every task', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await pool(
      Array.from({ length: 9 }, (_, i) => async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (i === 4) throw new Error('x');
        return i;
      }),
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
    expect(results[4].status).toBe('rejected');
  });

  it('benchPacking reports same-pick per choice/score and mean |Δ| per noul', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`m${i}`));
    const bench = await benchPacking(
      rows,
      {
        backend: 'jev',
        judge: async (o) => {
          const sessions = (o.state as { sessions?: unknown[] }).sessions;
          if (!sessions) return { answers: { subject: { type: 'choice', choice: 'project' }, is_work: { type: 'noul', noul: 0.6 }, depth: { type: 'score', score: 2 } }, model: 'm', latencyMs: 300 };
          return { answers: Object.assign({}, ...sessions.map((_, j) => answer(j))), model: 'm', latencyMs: 500 };
        },
        ingest: async () => undefined,
      },
      5,
    );
    expect(bench).toMatchObject({ n: 5, packSize: 5, samePick: { subject: '3/5', depth: '5/5' }, singleMsPerMoment: 300, packedMsPerMoment: 100 });
    expect(bench.meanAbsDelta.is_work).toBeCloseTo((0.1 + 0 + 0.1 + 0.2 + 0.3) / 5, 3);
  });
});
