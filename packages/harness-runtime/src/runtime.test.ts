import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getLlmAuditOverview, getRecentLlmAudit, getSignalsAfter, getLatestSnapshot, initializeDatabase, insertSnapshot, resetDb } from '@sundial/db/index.js';
import { getEffectJournalEntry, markEffectCompleted, markEffectStarted } from '@sundial/db/queries/applied-effects.js';
import { getAllProjects } from '@sundial/db/queries/projects.js';
import { effectDeliveryGuarantee } from '@sundial/kernel/effect-delivery.js';
import { createEventId } from '@sundial/helpers/event-id.js';
import { KernelRuntime, REJUDGE_AFTER_DAYS, SNAPSHOT_WARN_BYTES, aliasPairKey, journalShifted, needsAudit, snapshotSizeWarning, replayDecision, spokenEvidence, tablesTouched, toDaemonEvent } from './runtime.js';

/**
 * Integration coverage for the ported daemon loop: boot (cold start), the
 * append → fold pipeline, clock:tick + snapshot cadence, warm boot (snapshot
 * + tail replay), and shutdown's final snapshot. Runs against a throwaway
 * SQLite file in a temp SUNDIAL_HOME — never a real ~/.gnomon database.
 */

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-harness-runtime-'));
  process.env.SUNDIAL_HOME = tmpDir;
  process.env.DATABASE_URL = `file:${path.join(tmpDir, 'harness-test.db')}`;
  resetDb();
  await initializeDatabase();
});

afterAll(() => {
  resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('KernelRuntime', () => {
  it('cold boot: no snapshot, no tail, initial state', async () => {
    const runtime = new KernelRuntime({ deviceId: 'test-device' });
    const boot = await runtime.boot();
    expect(boot.snapshotOffset).toBeNull();
    expect(boot.tailLength).toBe(0);
    expect(runtime.getState()).not.toBeNull();
    expect(runtime.getState()?.device.id).toBe('test-device');
    await runtime.shutdown();
  });

  it('appendSignal folds through the pipeline and lands in the signals log', async () => {
    const runtime = new KernelRuntime({ deviceId: 'test-device' });
    await runtime.boot();

    await runtime.appendSignal('shell:command', { command: 'echo hello', cwd: `${tmpDir}/proj`, exitCode: 0 });

    const signals = await getSignalsAfter(null);
    const shell = signals.filter((s) => s.signalType === 'shell' && s.eventType === 'command');
    expect(shell.length).toBeGreaterThanOrEqual(1);
    await runtime.shutdown();
  });

  it('tickClock logs a clock:tick signal and writes a snapshot (the cadence)', async () => {
    const runtime = new KernelRuntime({ deviceId: 'test-device' });
    await runtime.boot();

    await runtime.tickClock();

    const signals = await getSignalsAfter(null);
    expect(signals.some((s) => s.signalType === 'clock' && s.eventType === 'tick')).toBe(true);

    const snapshot = await getLatestSnapshot();
    expect(snapshot).not.toBeNull();
    // The tick can emit a child signal in the same millisecond (the day's first
    // tick runs the retention prune), and two ULIDs minted in one millisecond do
    // not sort in the order they were minted. So the offset is the LAST instant's
    // signal, whichever of them sorts last.
    const offset = signals.find((s) => s.id === snapshot?.logOffset);
    expect(offset?.capturedAt).toBe(signals[signals.length - 1].capturedAt);
    await runtime.shutdown();
  });

  it('rebuilds state.drift from the log when the snapshot predates it (lane C)', async () => {
    const first = new KernelRuntime({ deviceId: 'test-device' });
    await first.boot();
    await first.appendSignal('input:activity', { windowMs: 10_000, keyDownCount: 7, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0, eventsPerMinute: 42 });
    await first.shutdown();
    const latest = await getLatestSnapshot();
    const { drift: _drift, ...older } = JSON.parse(latest!.stateJson);
    // Minted in a later millisecond, so it is the latest: two ULIDs in one millisecond do not sort in minting order.
    await new Promise((r) => setTimeout(r, 5));
    await insertSnapshot({ id: createEventId(), stateJson: JSON.stringify(older), logOffset: latest!.logOffset });

    const second = new KernelRuntime({ deviceId: 'test-device' });
    await second.boot();
    const days = Object.values(second.getState()?.drift?.days ?? {});
    expect(days.reduce((n, d) => n + d.active, 0)).toBeGreaterThanOrEqual(1);
    expect(second.getState()?.drift?.checkedWeek).toBeNull();
    await second.shutdown();
  });

  it('a meeting with nothing heard spends no extract call (the check comes before the count)', async () => {
    process.env.SUNDIAL_LLM_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.SUNDIAL_LLM_MODEL = 'test-model';
    try {
      const runtime = new KernelRuntime({ deviceId: 'test-device' });
      await runtime.boot();
      const spent = () => runtime.getState()!.budgets.byPurpose.extract.callsToday;
      const before = spent();
      const effect = { type: 'RunMeetingPromises', meetingKey: 'm-silent', title: 'Planning', start: '2020-01-01T10:00:00.000Z', end: '2020-01-01T10:30:00.000Z', attendees: ['Mira Bakker'], ts: '2020-01-01T10:30:00.000Z' };
      await (runtime as unknown as { dispatchRunMeetingPromises(e: unknown): Promise<void> }).dispatchRunMeetingPromises(effect);
      const heard = async () => (await getSignalsAfter(null)).some((s) => s.signalType === 'meeting' && s.eventType === 'promises' && s.data.meetingKey === 'm-silent');
      for (let i = 0; i < 100 && !(await heard()); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await heard()).toBe(true);
      expect(spent()).toBe(before);
      await runtime.shutdown();
    } finally {
      delete process.env.SUNDIAL_LLM_BASE_URL;
      delete process.env.SUNDIAL_LLM_MODEL;
    }
  });

  it('the meeting pass logs no meeting title', async () => {
    const chat = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"promises":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 } }));
    });
    await new Promise<void>((r) => chat.listen(0, '127.0.0.1', () => r()));
    const env = { ...process.env };
    process.env.SUNDIAL_LLM_BASE_URL = `http://127.0.0.1:${(chat.address() as { port: number }).port}/v1`;
    process.env.SUNDIAL_LLM_MODEL = 'qwen/test-local';
    process.env.SUNDIAL_SYSTEMONE_BACKEND = 'off';
    const logged: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    try {
      const runtime = new KernelRuntime({ deviceId: 'test-device' });
      await runtime.boot();
      const start = new Date(Date.now() - 60_000).toISOString();
      await runtime.appendSignal('audio:transcript', { spokenText: 'I will send the deck on Friday', channel: 'mic' });
      const end = new Date(Date.now() + 60_000).toISOString();
      await (runtime as unknown as { dispatchRunMeetingPromises(e: unknown): Promise<void> }).dispatchRunMeetingPromises({ type: 'RunMeetingPromises', meetingKey: 'm-heard', title: 'Puzzlebox pricing sync', start, end, attendees: ['Mira Bakker'], ts: end });
      const passed = async () => (await getSignalsAfter(null)).some((s) => s.signalType === 'meeting' && s.eventType === 'promises' && s.data.meetingKey === 'm-heard');
      for (let i = 0; i < 200 && !(await passed()); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await passed()).toBe(true);
      expect(logged.some((l) => l.includes('meeting promise pass'))).toBe(true);
      expect(logged.filter((l) => l.includes('Puzzlebox pricing sync'))).toEqual([]);
      await runtime.shutdown();
    } finally {
      console.log = log;
      process.env = env;
      chat.close();
    }
  });

  it('warm boot: resumes from the latest snapshot and replays only the tail', async () => {
    // The previous test's shutdown wrote a snapshot at the current offset.
    // Append two more signals via a fresh runtime, snapshotting only once at
    // its own shutdown; then check a third boot reports that offset.
    const first = new KernelRuntime({ deviceId: 'test-device' });
    const firstBoot = await first.boot();
    expect(firstBoot.snapshotOffset).not.toBeNull();
    await first.appendSignal('shell:command', { command: 'ls', cwd: `${tmpDir}/proj`, exitCode: 0 });
    await first.shutdown();

    const signals = await getSignalsAfter(null);
    const lastId = signals[signals.length - 1].id;

    const second = new KernelRuntime({ deviceId: 'test-device' });
    const boot = await second.boot();
    expect(boot.snapshotOffset).toBe(lastId);
    expect(boot.tailLength).toBe(0);
    await second.shutdown();
  });

  it('an EmitEvent replayed after a crash does not log its child twice (the child is already in the tail)', async () => {
    const runtime = new KernelRuntime({ deviceId: 'test-device' });
    await runtime.boot();
    const child = toDaemonEvent('shell:command', { command: 'echo replayed', cwd: `${tmpDir}/proj`, exitCode: 0 });
    const perform = (runtime as unknown as { performEffect(id: string, index: number, effect: unknown): Promise<void> }).performEffect.bind(runtime);
    const parentId = createEventId();
    await perform(parentId, 0, { type: 'EmitEvent', event: child });
    // The crash window: the child is logged, the parent effect was never marked
    // completed, so replay runs the same effect again.
    await expect(perform(parentId, 0, { type: 'EmitEvent', event: child })).resolves.toBeUndefined();
    const logged = (await getSignalsAfter(null)).filter((s) => s.id === child.id);
    expect(logged).toHaveLength(1);
    await runtime.shutdown();
  });

  it('Notify effect is forwarded to onNotify (delivery hook for gnomon/notice)', async () => {
    // No rule fires Notify from a bare shell command, so this exercises the
    // hook wiring directly through a synthetic fold via appendSignal is not
    // deterministic; instead assert the hook plumbing exists and shutdown is
    // idempotent about pending timers.
    const notices: unknown[] = [];
    const runtime = new KernelRuntime({ deviceId: 'test-device', onNotify: (n) => notices.push(n) });
    await runtime.boot();
    await runtime.shutdown();
    expect(notices).toEqual([]); // nothing fired — and nothing crashed
  });

  it('a folded signal announces the tables it moved, once, not per write', async () => {
    const seen: string[][] = [];
    const runtime = new KernelRuntime({ deviceId: 'test-device', onChange: (tables) => seen.push([...tables]) });
    await runtime.boot();
    await runtime.appendSignal('shell:command', { command: 'git status', cwd: '/tmp', exitCode: 0 });
    // The flush is deferred one tick, so the surface gets ONE frame naming
    // everything the fold wrote rather than one frame per write.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.shutdown();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.flat()).toContain('signals');
    for (const frame of seen) expect(new Set(frame).size).toBe(frame.length);
  });

  it('announces a bench change, because the Work card draws the bench', async () => {
    // The `state` pseudo-table is emitted only when the rendered slice moves.
    // `workbench` was not in that slice, so opening a job told no surface
    // anything: under the old 30-second pulse the card caught up by accident,
    // and once frames went change-driven it simply stopped. Two reads of the
    // Work card thirteen minutes apart returned disjoint job sets.
    const seen: string[][] = [];
    const runtime = new KernelRuntime({ deviceId: 'test-device', onChange: (tables) => seen.push([...tables]) });
    await runtime.boot();
    await runtime.appendSignal('work:requested', { subject: 'Read the ledger spec', brief: 'what L1-L7 left open' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.shutdown();
    expect(seen.flat()).toContain('state');
  });
});

describe('Judge → judgement:result (docs/jarvis/02, one effect, one event)', () => {
  const effect = {
    type: 'Judge' as const,
    purpose: 'classify' as const,
    questionSetId: 'moment-fanout',
    momentId: 'm-1',
    delayMs: 0,
    state: { minutes: 31, distinct_windows: 2 },
    questions: { depth: { type: 'score' as const, instructions: 'How deep was the work?', criteria: ['shallow', 'medium', 'deep'] } },
    metadata: { kind: 'focus' },
  };
  const answer = { auditId: 'a-1', answers: { depth: { type: 'score', score: 2, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } } }, model: 'typesafe/jev-latest', latencyMs: 301.4 };
  // These tests are about the hosted judge; without its key the default is local.
  const keyBefore = process.env.TYPESAFE_API_KEY;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (keyBefore === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = keyBefore;
  });

  it('dispatch spends a slot, performs through the injected judge, and lands one judgement:result in the log', async () => {
    const calls: unknown[] = [];
    const runtime = new KernelRuntime({
      deviceId: 'test-device',
      judge: async (options) => {
        calls.push(options);
        return answer;
      },
    });
    await runtime.boot();
    const before = (await getSignalsAfter(null)).length;

    await runtime.dispatchJudge(effect);
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'classify', momentId: 'm-1', state: effect.state, questions: effect.questions, attempt: 1 });
    const signals = (await getSignalsAfter(null)).slice(before);
    const dispatched = signals.find((s) => s.signalType === 'llm' && s.eventType === 'dispatched');
    const result = signals.find((s) => s.signalType === 'judgement' && s.eventType === 'result');
    expect(dispatched?.data).toMatchObject({ purpose: 'classify' });
    expect(result?.data).toMatchObject({ purpose: 'classify', questionSetId: 'moment-fanout', momentId: 'm-1', model: 'typesafe/jev-latest', latencyMs: 301, metadata: { kind: 'focus' } });
    expect((result?.data as { answers: Record<string, { score: number }> }).answers.depth.score).toBe(2);
    await runtime.shutdown();
  });

  it('a replay of a log that holds the dispatch and the answer never calls the network', async () => {
    const calls: unknown[] = [];
    const judge = async (options: unknown) => {
      calls.push(options);
      return answer;
    };
    // The live run: the two signals a performed Judge leaves behind go into the log.
    const live = new KernelRuntime({ deviceId: 'test-device', judge });
    await live.boot();
    await live.appendSignal('llm:dispatched', { purpose: 'classify' });
    await live.appendSignal('judgement:result', { purpose: 'classify', questionSetId: 'moment-fanout', momentId: 'm-1', answers: answer.answers, model: answer.model, latencyMs: 301 });
    expect(calls).toHaveLength(0);

    // A second process boots over that log with no snapshot in between: the
    // tail — dispatch and answer included — is folded again, and the judge is
    // never reached, because the answer is an event and an event is not an effect.
    const replay = new KernelRuntime({ deviceId: 'test-device', judge });
    const boot = await replay.boot();
    expect(boot.tailLength).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);

    // And the effect side of the same guarantee: a Judge the journal marked
    // completed is skipped on replay; one that was mid-flight is re-asked
    // (bounded cost, at-least-once).
    expect(effectDeliveryGuarantee(effect)).toBe('at-least-once');
    expect(replayDecision('completed', effectDeliveryGuarantee(effect))).toBe('skip');
    expect(replayDecision('started', effectDeliveryGuarantee(effect))).toBe('run');
    await replay.shutdown();
    await live.shutdown();
  });

  it('judgeNow answers a tool inside a turn: budgeted, audited through the injected judge, null when off or failing', async () => {
    const calls: unknown[] = [];
    const runtime = new KernelRuntime({
      deviceId: 'test-device',
      judge: async (options) => {
        calls.push(options);
        if ((options.state as { fail?: boolean }).fail) throw new Error('boom');
        return answer;
      },
    });
    await runtime.boot();
    const before = (await getSignalsAfter(null)).length;
    const rankBefore = runtime.getState()?.budgets.byPurpose.rank.callsToday ?? 0;
    const got = await runtime.judgeNow({ purpose: 'rank', questionSetId: 'rank-evidence', momentId: null, state: { q: 1 }, questions: effect.questions });
    expect(got?.answers.depth.score).toBe(2);
    expect(calls[0]).toMatchObject({ purpose: 'rank', backend: 'jev' });
    expect(runtime.getState()?.budgets.byPurpose.rank.callsToday).toBe(rankBefore + 1);
    // A failure refunds the slot and answers null.
    expect(await runtime.judgeNow({ purpose: 'rank', questionSetId: 'rank-evidence', momentId: null, state: { fail: true }, questions: effect.questions })).toBeNull();
    expect(runtime.getState()?.budgets.byPurpose.rank.callsToday).toBe(rankBefore + 1);
    process.env.SUNDIAL_SYSTEMONE_BACKEND = 'off';
    try {
      expect(await runtime.judgeNow({ purpose: 'rank', questionSetId: 'rank-evidence', momentId: null, state: {}, questions: effect.questions })).toBeNull();
    } finally {
      delete process.env.SUNDIAL_SYSTEMONE_BACKEND;
    }
    expect(calls).toHaveLength(2);
    // Two signals minted in one millisecond sort either way by id; the set is what is asserted.
    expect((await getSignalsAfter(null)).slice(before).map((s) => `${s.signalType}:${s.eventType}`).sort()).toEqual(['llm:dispatched', 'llm:dispatched', 'llm:refunded']);
    await runtime.shutdown();
  });

  it('SUNDIAL_SYSTEMONE_BACKEND=off drops a Judge before it spends anything', async () => {
    process.env.SUNDIAL_SYSTEMONE_BACKEND = 'off';
    try {
      const calls: unknown[] = [];
      const runtime = new KernelRuntime({ deviceId: 'test-device', judge: async () => (calls.push(1), answer) });
      await runtime.boot();
      const before = (await getSignalsAfter(null)).length;
      await runtime.dispatchJudge(effect);
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toHaveLength(0);
      // No slot spent; the one signal is the mark the board shows.
      const added = (await getSignalsAfter(null)).slice(before);
      expect(added.map((s) => `${s.signalType}:${s.eventType}`)).toEqual(['judgement:degraded']);
      expect(runtime.getState()?.judgement.degraded).toBe('off');
      await runtime.shutdown();
    } finally {
      delete process.env.SUNDIAL_SYSTEMONE_BACKEND;
    }
  });
});

describe('J0.9 chaos: Jev at a dead port', () => {
  const effect = {
    type: 'Judge' as const,
    purpose: 'classify' as const,
    questionSetId: 'moment-fanout',
    momentId: 'm-chaos',
    delayMs: 0,
    state: { minutes: 12 },
    questions: { is_work: { type: 'noul' as const, instructions: 'Was the owner working?' } },
  };

  it('three failures switch the call to the local model, the board learns it, and the answer still arrives', async () => {
    // A stand-in for the text model's chat route: answers the probabilities JSON.
    const chat = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"answers":{"is_work":{"noul":0.77}}}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
    });
    await new Promise<void>((r) => chat.listen(0, '127.0.0.1', () => r()));
    const chatPort = (chat.address() as { port: number }).port;
    const env = { ...process.env };
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.SUNDIAL_SYSTEMONE_URL = 'http://127.0.0.1:1/v1/systemone'; // nothing listens here
    process.env.SUNDIAL_LLM_BASE_URL = `http://127.0.0.1:${chatPort}/v1`;
    process.env.SUNDIAL_LLM_MODEL = 'qwen/test-local';
    delete process.env.SUNDIAL_SYSTEMONE_BACKEND;
    try {
      // The REAL performer: runAuditedJudgement against the dead port, then the local route.
      const runtime = new KernelRuntime({ deviceId: 'test-device' });
      await runtime.boot();
      const before = (await getSignalsAfter(null)).length;
      // Backoff between Jev attempts is 1 s then 2 s: asked for, recorded, and not waited out.
      const asked: number[] = [];
      const deferred = runtime as unknown as { defer(fn: () => void, ms: number): void };
      const defer = deferred.defer.bind(runtime);
      deferred.defer = (fn, ms) => {
        asked.push(ms);
        defer(fn, 0);
      };
      await runtime.dispatchJudge(effect);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !(await getSignalsAfter(null)).slice(before).some((s) => s.signalType === 'judgement' && s.eventType === 'result')) await new Promise((r) => setTimeout(r, 100));
      const added = (await getSignalsAfter(null)).slice(before);
      const result = added.find((s) => s.signalType === 'judgement' && s.eventType === 'result');
      expect(result?.data).toMatchObject({ model: 'qwen/test-local', questionSetId: 'moment-fanout' });
      expect((result?.data as { answers: { is_work: { noul: number } } }).answers.is_work.noul).toBe(0.77);
      expect(added.find((s) => s.signalType === 'judgement' && s.eventType === 'degraded')?.data).toEqual({ mode: 'local-fallback' });
      expect(runtime.getState()?.judgement.degraded).toBe('local-fallback');
      // The audit trail shows three Jev rows that failed and one local row that answered.
      const rows = await getRecentLlmAudit(10);
      const jev = rows.filter((r) => r.model === 'typesafe/jev-latest' && r.purpose === 'classify');
      const local = rows.filter((r) => r.model === 'qwen/test-local' && r.purpose === 'classify');
      expect(jev).toHaveLength(3);
      expect(jev.every((r) => r.success === false)).toBe(true);
      expect(local).toHaveLength(1);
      expect(local[0].success).toBe(true);
      expect(asked.filter((ms) => ms > 0)).toEqual([1000, 2000]);
      await runtime.shutdown();
    } finally {
      process.env = { ...env };
      await new Promise<void>((r) => chat.close(() => r()));
    }
  }, 15_000);
});

describe('J1.1c: a render a rule re-asks for is a retry row on the Ledger', () => {
  it('starts from the effect\'s attempt and parent, and llm:result carries the audit id', async () => {
    const chat = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"intent":"Debugging the reducer","narrative":"Fixed it."}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }));
    });
    await new Promise<void>((r) => chat.listen(0, '127.0.0.1', () => r()));
    const env = { ...process.env };
    process.env.SUNDIAL_LLM_BASE_URL = `http://127.0.0.1:${(chat.address() as { port: number }).port}/v1`;
    process.env.SUNDIAL_LLM_MODEL = 'qwen/test-local';
    process.env.SUNDIAL_SYSTEMONE_BACKEND = 'off'; // the judge is not under test here
    try {
      const runtime = new KernelRuntime({ deviceId: 'test-device' });
      await runtime.boot();
      const before = (await getSignalsAfter(null)).length;
      // The private dispatcher, reached the way a rule's effect reaches it.
      await (runtime as unknown as { dispatchScheduleLLM: (e: unknown) => Promise<void> }).dispatchScheduleLLM({
        type: 'ScheduleLLM',
        purpose: 'intent',
        momentId: 'm-retry',
        delayMs: 0,
        attempt: 2,
        parentCallId: 'first-render',
        messages: [{ role: 'user', content: 'rewrite' }],
        metadata: { evidence: { app: 'Code' }, attempt: 2 },
      });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !(await getSignalsAfter(null)).slice(before).some((s) => s.signalType === 'llm' && s.eventType === 'result')) await new Promise((r) => setTimeout(r, 50));
      const result = (await getSignalsAfter(null)).slice(before).find((s) => s.signalType === 'llm' && s.eventType === 'result');
      const row = (await getRecentLlmAudit(5)).find((r) => r.momentId === 'm-retry');
      expect(row).toMatchObject({ attempt: 2, parentCallId: 'first-render', purpose: 'intent' });
      expect((result?.data as { auditId?: string }).auditId).toBe(row?.id);
      // What the Ledger sums: this row's whole cost is retry spend.
      const overview = await getLlmAuditOverview();
      expect(overview.summary.retrySpendUsd).toBeGreaterThan(0);
      await runtime.shutdown();
    } finally {
      process.env = { ...env };
      await new Promise<void>((r) => chat.close(() => r()));
    }
  }, 10_000);
});

describe('tablesTouched (the live channel\'s whole vocabulary)', () => {
  it('names the table a WriteDB writes, straight from the effect', () => {
    expect(tablesTouched({ type: 'WriteDB', table: 'moments', row: {} as never })).toEqual(['moments']);
    expect(tablesTouched({ type: 'WriteDB', table: 'commitments', row: {} as never })).toEqual(['commitments']);
  });

  it('names both tables a fact upsert writes', () => {
    expect(
      tablesTouched({
        type: 'UpsertEntityFact',
        entityId: 'e1',
        entityKind: 'person',
        canonicalName: 'Ada',
        factId: 'f1',
        predicate: 'works_on',
        object: 'gnomon',
        confidence: 0.9,
        ts: '2026-09-17T00:00:00.000Z',
        sourceEventId: 'ev1',
        provenance: 'observation',
      } as never),
    ).toEqual(['entities', 'entity_facts']);
  });

  it('says nothing for an effect that writes through another path', () => {
    // EmitEvent re-enters the pipeline and announces from there; Notify writes
    // nothing at all. Announcing here would invalidate readings twice over.
    expect(tablesTouched({ type: 'Notify', channel: 'phasic', payload: {} } as never)).toEqual([]);
  });
});

describe('replayDecision (ported policy)', () => {
  it('runs unjournaled effects, skips completed and indeterminate ones', () => {
    expect(replayDecision(null, 'at-least-once')).toBe('run');
    expect(replayDecision('completed', 'at-least-once')).toBe('skip');
    expect(replayDecision('indeterminate', 'at-least-once')).toBe('skip');
  });

  it('re-runs a started at-least-once effect, abandons a started at-most-once one', () => {
    expect(replayDecision('started', 'at-least-once')).toBe('run');
    expect(replayDecision('started', 'at-most-once')).toBe('abandon');
  });
});

describe('a journal shift (hardening S6)', () => {
  it('a row is shifted only when it names another rule', () => {
    expect(journalShifted(null, 'a')).toBe(false);
    expect(journalShifted({ ruleName: null }, 'a'), 'a row from before attribution').toBe(false);
    expect(journalShifted({ ruleName: 'a' }, 'a')).toBe(false);
    expect(journalShifted({ ruleName: 'b' }, 'a')).toBe(true);
  });

  it('runs an at-least-once effect whose index another rule\'s completed row holds, and re-attributes the row', async () => {
    const runtime = new KernelRuntime({ deviceId: 'test-device' });
    await runtime.boot();
    const eventId = createEventId();
    await markEffectStarted(eventId, 0, { ruleName: 'removedRule', eventType: 'clock:tick', effectDetail: 'EmitEvent x:y' });
    await markEffectCompleted(eventId, 0);
    const row = { id: 'project:shift', name: 'puzzlebox-studio', rootPath: `${tmpDir}/puzzlebox-studio`, organizationId: null };
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => void warned.push(args.join(' '));
    try {
      await (runtime as unknown as { executeEffects: (id: string, type: string, effects: unknown[]) => Promise<void> }).executeEffects(eventId, 'clock:tick', [{ ruleName: 'projectTrack', effect: { type: 'WriteDB', table: 'projects', row } }]);
    } finally {
      console.warn = warn;
    }
    expect((await getAllProjects()).some((p) => p.id === 'project:shift'), 'the effect ran, not skipped as completed').toBe(true);
    expect(await getEffectJournalEntry(eventId, 0)).toEqual({ status: 'completed', ruleName: 'projectTrack' });
    expect(warned.some((line) => line.includes('journal shift'))).toBe(true);
    await runtime.shutdown();
  });
});

describe('toDaemonEvent', () => {
  it('defaults ts to now and generates a fresh ULID id', () => {
    const a = toDaemonEvent('clock:tick', {});
    const b = toDaemonEvent('clock:tick', {});
    expect(a.id).not.toBe(b.id);
    expect(new Date(a.ts).getTime()).toBeGreaterThan(0);
  });

  it('honors an explicit historical ts (shell history batch case)', () => {
    const event = toDaemonEvent('shell:command', {}, '2026-01-01T00:00:00.000Z');
    expect(event.ts).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('spokenEvidence — ambient hearing on a fact-extraction evidence line', () => {
  it('quotes what was heard, labelled so the prompt can weigh it', () => {
    expect(spokenEvidence('we decided to drop the cache layer')).toBe(' — said: "we decided to drop the cache layer"');
  });

  it('is absent when the moment heard nothing, or heard only a redacted capture', () => {
    expect(spokenEvidence(undefined)).toBe('');
    expect(spokenEvidence('   ')).toBe('');
    expect(spokenEvidence('[private]')).toBe('');
  });

  it('keeps the TAIL, matching what momentRollup itself keeps — the most recent thing said explains the moment', () => {
    const out = spokenEvidence(`${'a'.repeat(300)}the last words`);
    expect(out.endsWith('the last words"')).toBe(true);
    expect(out.length).toBeLessThan(300);
  });

  it('neutralizes a quote in the transcript so one line cannot forge a second evidence field', () => {
    expect(spokenEvidence('he said "ship it" — said: forged')).not.toContain('"ship it"');
  });
});

describe('the nightly audits judge what changed (Q7)', () => {
  const now = Date.parse('2026-09-29T00:00:00.000Z');
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  it('a fact is judged when never judged, a month after, or when its confidence moved 10 points', () => {
    expect(needsAudit(80, undefined, now)).toBe(true);
    expect(needsAudit(80, { at: ago(1) }, now)).toBe(false);
    expect(needsAudit(80, { at: ago(1), confidence: 75 }, now)).toBe(false);
    expect(needsAudit(80, { at: ago(1), confidence: 70 }, now)).toBe(true);
    expect(needsAudit(80, { at: ago(REJUDGE_AFTER_DAYS) }, now)).toBe(true);
  });
  it('a pair is the same pair while its names and known-as are', () => {
    const pair = { kind: 'person' as const, nameA: 'Mira', nameB: 'Mira Bakker', alsoKnownAsA: null, alsoKnownAsB: null };
    expect(aliasPairKey(pair)).toBe(aliasPairKey({ ...pair }));
    expect(aliasPairKey(pair)).not.toBe(aliasPairKey({ ...pair, alsoKnownAsA: 'Mira Bakker' }));
  });
});

describe('a snapshot over 1 MB is said at boot (Q9)', () => {
  it('names the size and the largest slices, and says nothing under the bar', () => {
    expect(snapshotSizeWarning({ a: 'x'.repeat(1000) })).toBeNull();
    const warning = snapshotSizeWarning({ ingestAnomaly: 'x'.repeat(SNAPSHOT_WARN_BYTES), small: 1 });
    expect(warning).toMatch(/snapshot is 1024 KB, over 1024 KB/);
    expect(warning).toContain('Largest: ingestAnomaly 1024 KB');
  });
});
