// S4: the rig's sandbox. A rig chat's daily tools run, and the owner's record cannot tell. Every value is made up.
import { describe, expect, it } from 'vitest';
import { createInitialState, hydrateSnapshot } from '@sundial/kernel/initial-state.js';
import { reduce } from '@sundial/kernel/reduce.js';
import { readOpenAsk } from '@sundial/kernel/read/open-ask.js';
import { SANDBOX_CHANNEL, sandboxOf, sandboxView } from '@sundial/kernel/read/rig-session.js';
import type { AttributedEffect, SanitizedEvent } from '@sundial/kernel/types.js';
import { RULE_MANIFEST } from './manifest.js';
import { SANDBOXES_KEPT } from './sandbox.js';

const T0 = Date.parse('2026-11-16T09:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const RIG = 'session-rig';
const OWN = 'session-own';
const SPEC = (title: string) => ({ id: 'crate-watch', title, when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Chess' }] }, say: 'Chess is open' });

type Row = { id: string; type: string; min: number; payload: Record<string, unknown>; rig: boolean };
const row = (id: string, type: string, min: number, payload: Record<string, unknown>, rig = false): Row => ({ id, type, min, payload, rig });

/** The owner's own day: a wake-up, a question, a draft, a promise, a job, a rule, a tick a minute. */
function ownerRows(): Row[] {
  return [
    row('o-model', 'thread:model', 0, { sessionId: RIG, provider: 'openai', model: 'test-2', rig: true }),
    row('o-wake', 'wakeup:scheduled', 1, { at: at(20), reason: 'check the deploy', key: 'deploy' }),
    row('o-ask', 'ask:owner-opened', 2, { askId: 'owner-ask:own1', question: 'Is box-484 part of puzzlebox-studio?' }),
    row('o-draft', 'assistant:draft', 3, { kind: 'email', to: 'Mira Bakker', subject: 'The draft', body: 'Here it is.', evidence: ['a promise heard on Tuesday'] }),
    row('o-promise', 'commitment:heard', 4, { source: 'chat', id: 'commitment:promise:chat-own', direction: 'owner', deliverable: 'the draft', counterparty: 'Mira Bakker', dueText: 'Tuesday', quote: 'I owe Mira the draft by Tuesday' }),
    row('o-job', 'work:requested', 5, { subject: 'Zed vs Cursor', brief: 'Which one suits a TS monorepo, in two lines.' }),
    row('o-rule', 'rule:adopted', 6, { rule: SPEC('Chess watch') }),
    row('o-chat', 'chat:owner', 7, { sessionId: OWN, turnId: 't1', text: 'What is on today?' }),
    row('o-answer', 'ask:owner-answered', 30, { askId: 'owner-ask:own1', answer: 'yes' }),
    row('o-dismiss', 'draft:closed', 31, { id: 'draft:o-draft', outcome: 'dismissed', by: 'owner' }),
    row('o-pause', 'rule:paused', 32, { id: 'crate-watch', by: 'owner' }),
    ...Array.from({ length: 61 }, (_, m) => row(`tick-${m}`, 'clock:tick', m, {})),
  ];
}

/**
 * The rig chat's rows, in their own order at `mins` (ascending): every sandboxed tool, the same wake-up key and rule id as
 * the owner's, a question while the owner's is open, and the taps that carry no session (the draft card's Dismiss, the
 * answer through the route).
 */
function rigRows(mins: number[]): Row[] {
  const s = { sessionId: RIG };
  const steps: [string, string, Record<string, unknown>][] = [
    ['r-wake', 'wakeup:scheduled', { key: 'deploy', reason: 'check the release 7 deploy', ...s }],
    ['r-wake2', 'wakeup:scheduled', { key: 'crate', reason: 'look at crate 7', ...s }],
    ['r-cancel', 'wakeup:cancelled', { key: 'crate', ...s }],
    ['r-promise', 'commitment:heard', { source: 'chat', id: 'commitment:promise:chat-rig', direction: 'owner', deliverable: 'the crate report', counterparty: 'Ines Willow', dueText: 'Tuesday', quote: 'I owe Ines Willow the crate report by Tuesday', ...s }],
    ['r-draft', 'assistant:draft', { kind: 'email', to: 'Pavel Onyx', subject: 'Crates', body: 'The amber crates arrive on Thursday.', evidence: ['the task'], ...s }],
    ['r-dismiss', 'draft:closed', { id: 'draft:r-draft', outcome: 'dismissed', by: 'owner' }],
    ['r-ask', 'ask:owner-opened', { askId: 'owner-ask:rig1', question: 'Which crate colour, amber, green or grey?', choices: ['amber', 'green', 'grey'], ...s }],
    ['r-answer', 'ask:owner-answered', { askId: 'owner-ask:rig1', answer: 'green' }],
    ['r-job', 'work:requested', { subject: 'crate sum 7', brief: 'Work out 12 plus 30 and keep the result.', ...s }],
    ['r-repeat', 'work:requested', { subject: 'crate list', brief: 'Check the crate list.', repeat: 'weekdays at 17:30', ...s }],
    ['r-unrepeat', 'work:repeat-stopped', { subject: 'crate list', ...s }],
    ['r-rule', 'rule:adopted', { rule: SPEC('Rig chess watch'), ...s }],
    ['r-rpause', 'rule:paused', { id: 'crate-watch', ...s }],
    ['r-rresume', 'rule:resumed', { id: 'crate-watch', ...s }],
    ['r-rdrop', 'rule:dropped', { id: 'crate-watch', ...s }],
  ];
  return steps.map(([id, type, payload], i) => row(id, type, mins[i]!, type === 'wakeup:scheduled' ? { at: at(mins[i]! + 3), ...payload } : payload, true));
}

/** A seeded order: the rig's steps at ascending random minutes in 1..55, so they land between the owner's rows. */
function seeded(seed: number): number[] {
  let x = seed * 2654435761 % 4294967296;
  const next = () => (x = (1103515245 * x + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: 15 }, () => 1 + Math.floor(next() * 55)).sort((a, b) => a - b);
}

const toEvent = (r: Row): SanitizedEvent => ({ id: r.id, type: r.type, ts: at(r.min), payload: r.payload, sanitized: true });

/**
 * The executor's order: fold a row, then each row it emits, depth first. A job it starts reports `work:started` at once and
 * `work:shelved` two minutes later; a sandbox line is delivered as the delivery plugin records it (marked). Both are rows the
 * log would hold, so a removed rig row takes its own reports with it.
 */
/** One start for every fold: the initial state stamps the wall clock (`focusMode.since`). */
const START = createInitialState('d');
function play(rows: Row[], { snapAt = -1 }: { snapAt?: number } = {}) {
  let state = START;
  const effects: AttributedEffect[] = [];
  const later: SanitizedEvent[] = [];
  const apply = (event: SanitizedEvent): void => {
    const out = reduce(state, event, RULE_MANIFEST);
    state = out.state;
    for (const a of out.effects) {
      effects.push(a);
      const e = a.effect;
      if (e.type === 'EmitEvent') apply({ ...e.event, sanitized: true } as SanitizedEvent);
      else if (e.type === 'StartSubagent') {
        // As the runtime and the work loop write them: a sandbox job's every report carries its mark.
        const mark = e.job.sandbox ? { sandbox: e.job.sandbox } : {};
        apply({ id: `x-start-${e.job.id}`, type: 'work:started', ts: event.ts, payload: { jobId: e.job.id, childId: `child-${e.job.id}`, ...mark }, sanitized: true });
        later.push({ id: `x-shelf-${e.job.id}`, type: 'work:shelved', ts: new Date(Date.parse(event.ts) + 2 * 60_000).toISOString(), payload: { jobId: e.job.id, title: `${e.job.subject} done`, body: 'Forty-two.', ...mark }, sanitized: true });
      } else if (e.type === 'Notify' && e.channel === SANDBOX_CHANNEL)
        apply({ id: `x-line-${String(e.payload.noticeKey)}`, type: 'notice:delivered', ts: event.ts, payload: { noticeKey: e.payload.noticeKey, sessionId: e.payload.sessionId, acts: ['line'], sandbox: e.payload.sandbox }, sanitized: true });
    }
  };
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.min - b.r.min || a.i - b.i).map(({ r }) => toEvent(r));
  sorted.forEach((event, i) => {
    for (const due of later.filter((l) => l.ts <= event.ts)) {
      later.splice(later.indexOf(due), 1);
      apply(due);
    }
    // A restart: the snapshot written, read back and hydrated, then the log goes on.
    if (i === snapAt) state = hydrateSnapshot('d', JSON.parse(JSON.stringify(state)));
    apply(event);
  });
  for (const due of later.splice(0)) apply(due);
  return { state, effects };
}

/** Everything the owner sees or learns from: the state without the sandboxes, and every effect an owner rule asked for. */
const ownerSide = ({ state, effects }: ReturnType<typeof play>) => {
  const { sandbox: _sandbox, ...owner } = state;
  return { owner, effects: effects.filter((a) => a.ruleName !== 'sandbox'), openAsk: readOpenAsk(state) };
};

describe('the sandbox: a log with the rig chat\'s rows folds, for the owner, exactly as the log without them', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
    it(`seed ${seed}: every owner slice, view, learner and effect is identical; the sandbox did the work`, () => {
      const rig = rigRows(seeded(seed));
      const mixed = play([...ownerRows(), ...rig]);
      const alone = play(ownerRows());
      expect(ownerSide(mixed)).toEqual(ownerSide(alone));

      // Not vacuous: the rig chat's features worked, in its sandbox.
      const sb = mixed.state.sandbox![RIG]!;
      const lines = mixed.effects.filter((a) => a.ruleName === 'sandbox' && a.effect.type === 'Notify').map((a) => a.effect as Extract<typeof a.effect, { type: 'Notify' }>);
      expect(lines.every((n) => n.channel === SANDBOX_CHANNEL && n.payload.sessionId === RIG)).toBe(true);
      expect(lines.map((n) => n.payload.noticeKey)).toEqual(expect.arrayContaining([expect.stringMatching(/^wakeup:deploy:/), expect.stringMatching(/^work-shelved:/)]));
      expect(sb.loops.open.filter((l) => l.kind === 'wakeup')).toEqual([]);
      expect(sb.drafts.recent).toMatchObject([{ id: 'draft:r-draft', status: 'dismissed' }]);
      expect(sb.commitments.promises.map((p) => p.id)).toEqual(['commitment:promise:chat-rig']);
      expect(sb.ownerAsk.recent).toMatchObject([{ askId: 'owner-ask:rig1', answer: 'green' }]);
      expect(sb.workbench.recent).toMatchObject([{ subject: 'crate sum 7', outcome: 'shelved' }]);
      expect(sb.workbench.repeats ?? {}).toEqual({});
      expect(sb.watch?.rules).toEqual([]);
      // ...and the owner's own went on: their wake-up fired through the gate, their rule is theirs, paused.
      expect(mixed.state.watch?.rules.map((r) => r.title)).toEqual(['Chess watch']);
      expect(mixed.state.watch?.paused).toEqual(['crate-watch']);
      expect(mixed.state.drafts.recent.map((d) => d.id)).toEqual(['draft:o-draft']);
    });
  }
});

it('control: the same rig rows without their sessionId are the owner\'s, and the owner side moves (the comparison can fail)', () => {
  const bare = rigRows(seeded(1)).map((r) => ({ ...r, payload: Object.fromEntries(Object.entries(r.payload).filter(([k]) => k !== 'sessionId')) }));
  expect(ownerSide(play([...ownerRows(), ...bare]))).not.toEqual(ownerSide(play(ownerRows())));
});

describe('the sandbox, past the edges (Fable review)', () => {
  const marked = (min: number, id: string) => row(`m-${id}`, 'thread:model', min, { sessionId: id, provider: 'openai', model: 'test-2', rig: true });

  it('a rig chat evicted while its job is open (five more marked): the job\'s marked reports fold nowhere, never on the owner\'s shelf', () => {
    const extra = Array.from({ length: SANDBOXES_KEPT }, (_, i) => marked(6, `session-rig-${i}`));
    const rig = [row('r-job', 'work:requested', 5, { subject: 'crate sum 7', brief: 'Work out 12 plus 30.', sessionId: RIG }, true)];
    const mixed = play([...ownerRows(), ...extra, ...rig]);
    expect(mixed.state.sandbox?.[RIG]).toBeUndefined();
    expect(ownerSide(mixed)).toEqual(ownerSide(play([...ownerRows(), ...extra])));
    expect(JSON.stringify(mixed.state.workbench)).not.toContain('crate sum 7');
  });

  it('a snapshot and its replay in the middle of the log: the owner side is still identical, and the sandbox comes back whole', () => {
    const rig = rigRows(seeded(3));
    for (const snapAt of [20, 45, 70]) {
      const mixed = play([...ownerRows(), ...rig], { snapAt });
      expect(ownerSide(mixed)).toEqual(ownerSide(play(ownerRows(), { snapAt })));
      expect(mixed.state.sandbox).toEqual(play([...ownerRows(), ...rig]).state.sandbox);
    }
  });

  it('an owner row with no sessionId naming an id a sandbox also holds is the owner\'s: an id both hold folds where the owner\'s does', () => {
    const same = 'commitment:promise:chat-same';
    const promise = (id: string, who: string, extra: Record<string, unknown> = {}) => ({ source: 'chat', id, direction: 'owner', deliverable: 'the report', counterparty: who, dueText: 'Tuesday', quote: `I owe ${who} the report`, ...extra });
    const owner = [...ownerRows(), row('o-same', 'commitment:heard', 8, promise(same, 'Mira Bakker')), row('o-close', 'commitment:closed', 20, { id: same, by: 'owner' })];
    const rig = [row('r-same', 'commitment:heard', 9, promise(same, 'Ines Willow', { sessionId: RIG }), true)];
    const mixed = play([...owner, ...rig]);
    expect(ownerSide(mixed)).toEqual(ownerSide(play(owner)));
    expect(mixed.state.sandbox![RIG]!.commitments.promises.map((p) => p.id)).toEqual([same]);
  });

  it('one job at a time per rig chat; a stop carries the mark; the result\'s line says it is in this test chat', () => {
    const job = (id: string, min: number, subject: string) => row(id, 'work:requested', min, { subject, brief: 'Add two numbers.', sessionId: RIG }, true);
    const { state, effects } = play([...ownerRows().filter((r) => r.type === 'thread:model' || r.type === 'clock:tick'), job('r-1', 2, 'first'), job('r-2', 3, 'second'), row('r-stop', 'work:stop-requested', 3, { jobId: 'x', sessionId: RIG }, true)]);
    const started = effects.filter((a) => a.effect.type === 'StartSubagent');
    expect(started).toHaveLength(1);
    expect(state.sandbox![RIG]!.workbench.recent.map((j) => j.subject)).toEqual(['first']);
    expect(effects.find((a) => a.effect.type === 'StopSubagent')?.effect).toEqual({ type: 'StopSubagent', jobId: 'x', sandbox: RIG });
    const line = effects.find((a) => a.effect.type === 'Notify' && String(a.effect.payload.noticeKey).startsWith('work-shelved:'))!.effect as Extract<AttributedEffect['effect'], { type: 'Notify' }>;
    expect(line.payload.observation).toMatch(/in this test chat \(not on your shelf\)/);
  });
});

describe('a rig wake-up', () => {
  const rows = [
    row('o-model', 'thread:model', 0, { sessionId: RIG, provider: 'openai', model: 'test-2', rig: true }),
    row('r-wake', 'wakeup:scheduled', 1, { at: at(3), reason: 'check the release 7 deploy', key: 'deploy', sessionId: RIG }),
    ...Array.from({ length: 6 }, (_, m) => row(`tick-${m}`, 'clock:tick', m, {})),
  ];
  it('fires once, as one line in its own rig thread: never a candidate, never the gate, the companion, ntfy, a banner or a knock', () => {
    const { effects } = play(rows);
    const kinds = effects.map((a) => `${a.ruleName}:${a.effect.type}${a.effect.type === 'Notify' ? `:${a.effect.channel}` : a.effect.type === 'EmitEvent' ? `:${a.effect.event.type}` : ''}`);
    expect(kinds.filter((k) => k.startsWith('sandbox:'))).toEqual(['sandbox:Notify:sandbox-notice']);
    const line = effects.find((a) => a.ruleName === 'sandbox')!.effect as Extract<AttributedEffect['effect'], { type: 'Notify' }>;
    expect(line.payload).toMatchObject({ sessionId: RIG, sandbox: RIG, noticeKey: `wakeup:deploy:${at(3)}`, observation: 'check the release 7 deploy' });
    // Nothing of it anywhere else: no candidate reached the gate, no decision, no push, no speech.
    expect(effects.filter((a) => a.ruleName !== 'sandbox')).toEqual(play(rows.filter((r) => r.id !== 'r-wake')).effects);
    expect(JSON.stringify(effects.filter((a) => a.ruleName !== 'sandbox'))).not.toContain('release 7');
  });
});

describe('the predicate and the sandbox\'s bounds', () => {
  const marked = (ids: string[]) => play(ids.map((id, i) => row(`m-${id}`, 'thread:model', i, { sessionId: id, provider: 'openai', model: 'test-2', rig: true }))).state;

  it('a row is sandboxed by a rig sessionId, by the mark, or by naming a sandbox\'s own item; the owner\'s same row is not', () => {
    const { state } = play([...ownerRows(), ...rigRows(seeded(1))]);
    const e = (type: string, payload: Record<string, unknown>) => ({ type, payload });
    expect(sandboxOf(state, e('wakeup:scheduled', { key: 'deploy', sessionId: RIG }))).toBe(RIG);
    expect(sandboxOf(state, e('wakeup:scheduled', { key: 'deploy', sessionId: OWN }))).toBeNull();
    expect(sandboxOf(state, e('wakeup:scheduled', { key: 'deploy' }))).toBeNull();
    expect(sandboxOf(state, e('notice:delivered', { noticeKey: 'x', sandbox: RIG }))).toBe(RIG);
    expect(sandboxOf(state, e('notice:delivered', { noticeKey: 'x', sessionId: RIG }))).toBeNull();
    expect(sandboxOf(state, e('draft:closed', { id: 'draft:r-draft', outcome: 'sent' }))).toBe(RIG);
    expect(sandboxOf(state, e('draft:closed', { id: 'draft:o-draft', outcome: 'sent' }))).toBeNull();
    expect(sandboxOf(state, e('ask:owner-answered', { askId: 'owner-ask:rig1', answer: 'grey' }))).toBe(RIG);
    expect(sandboxOf(state, e('rule:dropped', { id: 'crate-watch', by: 'owner' }))).toBeNull();
    expect(sandboxOf(state, e('chat:owner', { sessionId: RIG }))).toBeNull();
  });

  it('a tool in the rig chat reads its sandbox; in the owner\'s chat, and in a rig chat whose sandbox is gone, nothing', () => {
    const { state } = play([...ownerRows(), ...rigRows(seeded(2))]);
    expect(sandboxView(state, RIG)?.drafts.recent.map((d) => d.id)).toEqual(['draft:r-draft']);
    expect(sandboxView(state, OWN)).toBeNull();
    const full = marked(Array.from({ length: SANDBOXES_KEPT + 2 }, (_, i) => `session-rig-${i}`));
    expect(Object.keys(full.sandbox!)).toHaveLength(SANDBOXES_KEPT);
    expect(sandboxView(full, 'session-rig-0')).toBeNull();
    expect(sandboxView(full, `session-rig-${SANDBOXES_KEPT + 1}`)).not.toBeNull();
  });

  it('a row of a rig chat whose sandbox is gone folds nowhere: not the owner\'s either', () => {
    const ids = Array.from({ length: SANDBOXES_KEPT + 1 }, (_, i) => `session-rig-${i}`);
    const base = marked(ids);
    const out = reduce(base, toEvent(row('late', 'assistant:draft', 9, { kind: 'note', subject: 'x', body: 'y', sessionId: 'session-rig-0' })), RULE_MANIFEST);
    expect(out.state).toBe(base);
    expect(out.effects).toEqual([]);
  });
});
