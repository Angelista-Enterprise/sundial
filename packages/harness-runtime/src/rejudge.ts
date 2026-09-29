import type { StoredMoment } from '@sundial/db/index.js';
import type { JudgeQuestion, JudgementResultPayload, MomentRollup } from '@sundial/kernel/types.js';
import { momentFanout } from '@sundial/rules/questions/moment-fanout.js';

/**
 * J2.6 — the rejudge job (docs/jarvis/02 "Backfill"). Re-derives every
 * stored moment through `moment-fanout`, five moments to a call: the state is
 * `{ sessions: [s0 … s4] }` and each question is asked once per session with
 * its instruction prefixed "In `sessions[j]` only" — the lab's `packed` probe
 * (10/10 same answers at five, ~60 ms a moment). The answers are UNPACKED back
 * to the registry's own keys before they enter the log, so `judgementTrack`
 * files them under the registry's question ids and `applyMomentJudgement`
 * reads them exactly as it reads a live close.
 *
 * Pure helpers here (pack, unpack, the fan-out input off a stored row, the
 * pool); the runtime supplies the judge and the ingest.
 */
export const PACK_SIZE = 5;
export const POOL_SIZE = 16;

export interface PackedItem {
  momentId: string;
  state: Record<string, unknown>;
  questions: Record<string, JudgeQuestion>;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

const packedKey = (key: string, j: number): string => `${key}__s${j}`;

/** Five moments' states under one `sessions` array; each question repeated per session, pointed at its own entry. */
export function packItems(items: PackedItem[]): { state: { sessions: Record<string, unknown>[] }; questions: Record<string, JudgeQuestion> } {
  const questions: Record<string, JudgeQuestion> = {};
  items.forEach((item, j) => {
    for (const [key, q] of Object.entries(item.questions)) {
      questions[packedKey(key, j)] = { ...q, instructions: `In \`sessions[${j}]\` only: ${q.instructions}` };
    }
  });
  return { state: { sessions: items.map((i) => i.state) }, questions };
}

/** The per-moment answer sets, keyed as the registry keys them. A session whose answers all went missing gets an empty set. */
export function unpackAnswers(answers: JudgementResultPayload['answers'], items: PackedItem[]): JudgementResultPayload['answers'][] {
  return items.map((item, j) => {
    const own: JudgementResultPayload['answers'] = {};
    for (const key of Object.keys(item.questions)) {
      const a = answers[packedKey(key, j)];
      if (a) own[key] = a;
    }
    return own;
  });
}

/** J2.7: the open goals a backfilled moment is judged against — today's, not the day's (noted; a goal opened later cannot have been advanced earlier, but the slot answers say so themselves). */
export interface RejudgeGoals {
  labels: string[];
  ids: string[];
  /** J4.4: the open speech promises, as heard, and their thread ids. */
  promiseLabels?: string[];
  promiseIds?: string[];
}

/** A stored moment row's `data` IS the rollup `momentClose` wrote (plus `kind`, `intent`…); the fan-out reads the rollup fields it knows. */
export function fanoutItemFromRow(row: StoredMoment, goals?: RejudgeGoals): PackedItem {
  const rollup = { ...(row.data as unknown as MomentRollup), processName: (row.data.processName as string | undefined) ?? row.processName };
  const built = momentFanout.build({ rollup, projectId: row.projectId, durationMs: row.durationMs, openGoals: goals?.labels ?? [], openPromises: goals?.promiseLabels ?? [] });
  const spoken = typeof rollup.spokenExcerpt === 'string' && rollup.spokenExcerpt !== '' ? rollup.spokenExcerpt.slice(0, 160) : undefined;
  return {
    momentId: row.id,
    state: built.state,
    questions: built.questions,
    durationMs: row.durationMs,
    // The same second-key and quote a live close carries (J4.4), read off the stored row.
    metadata: { projectId: row.projectId, nonText: (rollup.gitCommitCount ?? 0) > 0 || (rollup.shellCommandCount ?? 0) > 0 || Boolean(rollup.calendarActive) || Boolean(rollup.micActive), ...(spoken ? { spoken } : {}) },
  };
}

export const chunk = <T>(xs: T[], size: number): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** Run `tasks` with at most `limit` in flight; every task settles (a throw is caught into the result). */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export interface RejudgeDeps {
  judge: (o: { purpose: 'classify'; momentId: string | null; state: unknown; questions: Record<string, JudgeQuestion>; backend: 'jev' | 'text-model' }) => Promise<{ answers: JudgementResultPayload['answers']; model: string; latencyMs: number }>;
  ingest: (payload: JudgementResultPayload) => Promise<void>;
  backend: 'jev' | 'text-model';
}

export interface RejudgeProgress {
  total: number;
  done: number;
  calls: number;
  failedCalls: number;
}

/**
 * The job. One call per pack, `POOL_SIZE` in flight; each answered moment is
 * one `judgement:result` (metadata `backfill: true`, so `judgementTrack` keeps
 * it out of the live `recent` ring) through the caller's ingest — the fold
 * does the rest. A failed pack is counted and skipped; the moments it held
 * stay without `data.judgement` and a re-run picks them up.
 */
export async function rejudgeMoments(rows: StoredMoment[], deps: RejudgeDeps, opts: { packSize?: number; concurrency?: number; goals?: RejudgeGoals; onProgress?: (p: RejudgeProgress) => void } = {}): Promise<RejudgeProgress> {
  const packSize = opts.packSize ?? PACK_SIZE;
  const progress: RejudgeProgress = { total: rows.length, done: 0, calls: 0, failedCalls: 0 };
  const packs = chunk(rows.map((row) => fanoutItemFromRow(row, opts.goals)), packSize);
  await pool(
    packs.map((items) => async () => {
      const packed = packItems(items);
      progress.calls += 1;
      let result: Awaited<ReturnType<RejudgeDeps['judge']>>;
      try {
        result = await deps.judge({ purpose: 'classify', momentId: null, state: packed.state, questions: packed.questions, backend: deps.backend });
      } catch (error) {
        progress.failedCalls += 1;
        console.warn(`[sundial-kernel] rejudge pack failed (${items.length} moments):`, error instanceof Error ? error.message : error);
        opts.onProgress?.(progress);
        return;
      }
      const perMoment = unpackAnswers(result.answers, items);
      for (const [j, item] of items.entries()) {
        if (Object.keys(perMoment[j]).length === 0) continue;
        await deps.ingest({
          purpose: 'classify',
          questionSetId: momentFanout.id,
          momentId: item.momentId,
          answers: perMoment[j],
          model: result.model,
          latencyMs: Math.round(result.latencyMs / items.length),
          // The same metadata a live close carries, so `applyMomentJudgement` credits goals the same way.
          metadata: { backfill: true, durationMs: item.durationMs ?? 0, ...item.metadata, ...(opts.goals ? { goals: opts.goals.ids, promises: opts.goals.promiseIds ?? [] } : {}) },
        });
        progress.done += 1;
      }
      opts.onProgress?.(progress);
    }),
    opts.concurrency ?? POOL_SIZE,
  );
  return progress;
}

export interface PackBench {
  n: number;
  packSize: number;
  /** Per choice/score question: how often the packed answer picked the same level or option as the single call. */
  samePick: Record<string, string>;
  /** Per noul question: mean |p_packed − p_single|. */
  meanAbsDelta: Record<string, number>;
  singleMsPerMoment: number;
  packedMsPerMoment: number;
}

const decided = (a: JudgementResultPayload['answers'][string] | undefined): string | null => (typeof a?.choice === 'string' ? a.choice : typeof a?.score === 'number' ? String(Math.round(a.score)) : null);

/**
 * Bench before you wire: the same moments once each on the registry wording
 * and once packed, and the agreement per question. The lab's `packed` probe
 * did this for `kind`; this does it for the fan-out the job actually sends.
 */
export async function benchPacking(rows: StoredMoment[], deps: RejudgeDeps, packSize = PACK_SIZE): Promise<PackBench> {
  const items = rows.map((row) => fanoutItemFromRow(row));
  const singles = await pool(
    items.map((item) => () => deps.judge({ purpose: 'classify', momentId: item.momentId, state: item.state, questions: item.questions, backend: deps.backend })),
    POOL_SIZE,
  );
  const packs = chunk(items, packSize);
  const packedResults = await pool(
    packs.map((group) => () => {
      const packed = packItems(group);
      return deps.judge({ purpose: 'classify', momentId: null, state: packed.state, questions: packed.questions, backend: deps.backend });
    }),
    POOL_SIZE,
  );
  const same: Record<string, [number, number]> = {};
  const delta: Record<string, number[]> = {};
  let singleMs = 0;
  let packedMs = 0;
  let n = 0;
  packs.forEach((group, g) => {
    const packedResult = packedResults[g];
    if (packedResult.status !== 'fulfilled') return;
    packedMs += packedResult.value.latencyMs;
    const per = unpackAnswers(packedResult.value.answers, group);
    group.forEach((item, j) => {
      const single = singles[items.indexOf(item)];
      if (single.status !== 'fulfilled') return;
      n += 1;
      singleMs += single.value.latencyMs;
      for (const key of Object.keys(item.questions)) {
        const a = single.value.answers[key];
        const b = per[j][key];
        if (!a || !b) continue;
        if (typeof a.noul === 'number' && typeof b.noul === 'number') (delta[key] ??= []).push(Math.abs(a.noul - b.noul));
        else {
          const s = (same[key] ??= [0, 0]);
          s[1] += 1;
          if (decided(a) === decided(b)) s[0] += 1;
        }
      }
    });
  });
  return {
    n,
    packSize,
    samePick: Object.fromEntries(Object.entries(same).map(([k, [hit, total]]) => [k, `${hit}/${total}`])),
    meanAbsDelta: Object.fromEntries(Object.entries(delta).map(([k, ds]) => [k, Number((ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(3))])),
    singleMsPerMoment: n ? Math.round(singleMs / n) : 0,
    packedMsPerMoment: n ? Math.round(packedMs / n) : 0,
  };
}
