/**
 * W2's push case, end to end through the whole manifest and the real gate
 * (docs/release/12-autonomy/W2, "A end to end"). Made-up values: puzzlebox-studio,
 * 263 commits, session-7f.
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { reduce } from '@sundial/kernel/reduce.js';
import { shownPayload, turnBrief } from '@sundial/kernel/turn-brief.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { RULE_MANIFEST } from './index.js';
import { MAX_OPEN_LOOPS } from './loop-track.js';

const CWD = '~/Projects/acme/puzzlebox-studio';
const S = 'session-7f';
let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown>): SanitizedEvent => ({ id: `loop-${String(++seq).padStart(6, '0')}`, type, ts, payload, sanitized: true });
const at = (hms: string) => `2026-09-29T${hms}.000Z`;

/** The executor's order: fold an event, then each event it emits, depth first. */
function play(start: KernelState, events: SanitizedEvent[]) {
  let state = start;
  const emitted: SanitizedEvent[] = [];
  const notifies: Extract<Effect, { type: 'Notify' }>[] = [];
  const llm: Effect[] = [];
  const apply = (event: SanitizedEvent): void => {
    const out = reduce(state, event, RULE_MANIFEST);
    state = out.state;
    for (const { effect } of out.effects) {
      if (effect.type === 'EmitEvent') {
        emitted.push({ ...effect.event, sanitized: true } as SanitizedEvent);
        apply({ ...effect.event, sanitized: true } as SanitizedEvent);
      } else if (effect.type === 'Notify') notifies.push(effect);
      else if (effect.type === 'ScheduleLLM') llm.push(effect);
    }
  };
  for (const event of events) apply(event);
  return { state, emitted, notifies, llm, of: (type: string) => emitted.filter((e) => e.type === type) };
}

const status = (ahead: number, ts: string, cwd = CWD) => ev('git:status', ts, { timestamp: ts, cwd, branch: 'main', ahead, behind: 0, dirtyFiles: 0 });

/** A chat turn in `session` where Gnomon says `reply`, briefed from `state` as the real /turn does. */
function turn(state: KernelState, session: string, ts: string, reply: string, turnId = `t-${ts}`): SanitizedEvent[] {
  const brief = turnBrief(state, null, { sessionId: session, cause: { kind: 'owner' }, text: 'anything I forgot?' }, Date.parse(ts));
  return [
    ev('chat:shown', ts, shownPayload(brief, `brief-${ts}`)),
    ev('chat:owner', ts, { sessionId: session, turnId, text: 'anything I forgot?', chars: 18, images: 0 }),
    ev('chat:said', ts, { sessionId: session, turnId, text: reply, chars: reply.length, tools: [] }),
  ];
}

function withUnpushed(ahead = 263, ts = at('13:51:00'), cwd = CWD) {
  return play(createInitialState('loops'), [status(ahead, ts, cwd)]).state;
}

describe('A end to end: a push after Gnomon said commits were waiting', () => {
  it('opens a loop on the said fact, resolves it on the push, and delivers one plain line to that chat', () => {
    const before = withUnpushed();
    const said = play(before, turn(before, S, at('14:02:10'), 'Nothing forgotten, but 263 commits not pushed yet on puzzlebox-studio.'));
    expect(said.state.conversation.said).toContainEqual(expect.objectContaining({ key: 'git.unpushed', value: 263, sessionId: S }));
    expect(said.of('loop:opened')).toHaveLength(1);
    expect(said.state.loops.open).toEqual([expect.objectContaining({ kind: 'unpushed', origin: 'said', target: { sessionId: S }, seen: { [CWD]: 263 }, resolve: expect.objectContaining({ by: 'cwd', left: [CWD] }) })]);

    const pushed = play(said.state, [status(0, at('14:02:39'))]);
    expect(pushed.state.git.unpushed[CWD]).toBeUndefined();
    expect(pushed.of('loop:resolved')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ said: true }) })]);
    const [candidate] = pushed.of('notice:candidate');
    expect(candidate.payload).toMatchObject({
      kind: 'followup:unpushed',
      shape: 'transition',
      surprise: 2,
      precision: 1,
      valueHalfLifeMs: 4 * 3_600_000,
      plain: true,
      sessionId: S,
      observation: 'Pushed: puzzlebox-studio is up to date (263 commits were waiting).',
    });
    expect(String(candidate.payload.key)).toMatch(/^followup:unpushed:[0-9a-f]{10}$/);
    // The gate: tonic (4 h is past the urgent line), budget-exempt at 2.0, no model call, no push, no banner.
    expect(pushed.notifies).toEqual([{ type: 'Notify', channel: 'tonic-notice', payload: expect.objectContaining({ noticeKey: candidate.payload.key, sessionId: S, acts: ['line'], plain: true }) }]);
    expect(pushed.llm).toEqual([]);

    // The plugin reports it delivered: the loop is said, and the chat has used one of its two lines today.
    const delivered = play(pushed.state, [ev('notice:delivered', at('14:02:40'), { noticeKey: candidate.payload.key, sessionId: S, acts: ['line'] })]);
    expect(delivered.state.loops.recent.at(-1)).toMatchObject({ status: 'said', target: { sessionId: S } });
    expect(delivered.state.loops.saidToday).toEqual({ [S]: 1 });
  });

  it('resolves at once when the push beat the turn\'s end', () => {
    const before = withUnpushed();
    const brief = turnBrief(before, null, { sessionId: S }, Date.parse(at('14:02:10')));
    const pushedFirst = play(before, [status(0, at('14:02:20'))]).state;
    const out = play(pushedFirst, [
      ev('chat:shown', at('14:02:10'), shownPayload(brief, 'brief-1')),
      ev('chat:said', at('14:02:30'), { sessionId: S, turnId: 't1', text: '263 commits are waiting to be pushed.', tools: [] }),
    ]);
    expect(out.state.loops.open).toEqual([]);
    expect(out.of('notice:candidate').map((c) => c.payload.sessionId)).toEqual([S]);
  });

  it('three mentions are one loop, moved to the newest chat', () => {
    let state = withUnpushed();
    for (const [session, ts] of [[S, '14:00:00'], [S, '14:05:00'], ['session-9a', '14:10:00']] as const) state = play(state, turn(state, session, at(ts), 'Still 263 commits not pushed.')).state;
    expect(state.loops.open).toHaveLength(1);
    expect(state.loops.open[0]!.target).toEqual({ sessionId: 'session-9a' });
  });

  // Seen live (E2E, 2026-09-29): a reply naming "puzzlebox-studio ... ahead 3" opened nothing, because 3 is one
  // digit and the fact had no name; and a loop over every repo shown never resolved while another repo stayed ahead.
  it('a repo named in the reply is followed, however few its commits, and only the repos named', () => {
    const OTHER = '~/Projects/acme/lantern';
    let before = withUnpushed(3);
    before = play(before, [status(2, at('13:52:00'), OTHER)]).state;
    const said = play(before, turn(before, S, at('14:02:10'), 'Yes: puzzlebox-studio is ahead 3, push it before you go.'));
    expect(said.state.loops.open).toEqual([expect.objectContaining({ subject: CWD, seen: { [CWD]: 3 } })]);
    const pushed = play(said.state, [status(0, at('14:02:39'))]);
    expect(pushed.of('notice:candidate').map((c) => c.payload.observation)).toEqual(['Pushed: puzzlebox-studio is up to date (3 commits were waiting).']);
  });

  it('two repos named are two loops, each push its own line', () => {
    const OTHER = '~/Projects/acme/lantern';
    let before = withUnpushed(3);
    before = play(before, [status(2, at('13:52:00'), OTHER)]).state;
    const said = play(before, turn(before, S, at('14:02:10'), 'puzzlebox-studio is ahead 3 and lantern ahead 2.'));
    expect(said.state.loops.open.map((l) => l.subject).sort()).toEqual([OTHER, CWD]);
    const first = play(said.state, [status(0, at('14:02:39'))]);
    expect(first.of('notice:candidate')).toHaveLength(1);
    expect(first.state.loops.open.map((l) => l.subject)).toEqual([OTHER]);
    // Said again in the same thread: the open loop is retargeted, not doubled.
    const again = play(first.state, turn(first.state, S, at('14:05:00'), 'lantern is still ahead 2.'));
    expect(again.state.loops.open).toHaveLength(1);
  });

  // A repo is often named after the thing it builds: a reply about the product is not a reply about its commits.
  it('a repo name in a reply that is not about pushing opens nothing', () => {
    const before = withUnpushed(3);
    expect(play(before, turn(before, S, at('14:02:10'), 'puzzlebox-studio has a new release out.')).state.loops.open).toEqual([]);
  });

  it('opens nothing when the brief showed the commits and the reply did not say them', () => {
    const before = withUnpushed();
    expect(play(before, turn(before, S, at('14:02:10'), 'Nothing forgotten.')).state.loops.open).toEqual([]);
  });

  it('says at most two follow-ups per chat per day; the third resolves unsaid', () => {
    let state = createInitialState('loops');
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const cwd = `~/Projects/acme/repo-${i}`;
      state = play(state, [status(40 + i, at(`1${i}:00:00`), cwd)]).state;
      state = play(state, turn(state, S, at(`1${i}:01:00`), `${40 + i} commits not pushed.`)).state;
      const out = play(state, [status(0, at(`1${i}:02:00`), cwd)]);
      state = out.state;
      const candidate = out.of('notice:candidate')[0];
      if (candidate) {
        keys.push(String(candidate.payload.key));
        state = play(state, [ev('notice:delivered', at(`1${i}:02:01`), { noticeKey: candidate.payload.key, sessionId: S, acts: ['line'] })]).state;
      }
    }
    expect(keys).toHaveLength(2);
    expect(state.loops.saidToday[S]).toBe(2);
    expect(state.loops.recent.at(-1)).toMatchObject({ status: 'unsaid' });
  });

  it('expires in silence after twelve hours', () => {
    const before = withUnpushed();
    const open = play(before, turn(before, S, at('08:00:00'), '263 commits not pushed.')).state;
    const later = play(open, [ev('clock:tick', at('20:00:01'), {})]);
    expect(later.state.loops.open).toEqual([]);
    expect(later.of('loop:expired')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: 'ttl' }) })]);
    expect(later.of('notice:candidate').filter((c) => String(c.payload.kind).startsWith('followup:'))).toEqual([]);
  });

  it('keeps at most twenty open, the oldest displaced with a record', () => {
    const events = Array.from({ length: MAX_OPEN_LOOPS + 1 }, (_, i) =>
      ev('loop:opened', at(`09:00:${String(i).padStart(2, '0')}`), { kind: 'test', subject: `thing-${i}`, about: 'a thing', resolve: { when: { type: 'thing:done' } }, seen: {}, target: { sessionId: S }, origin: 'tool' }),
    );
    const out = play(createInitialState('loops'), events);
    expect(out.state.loops.open).toHaveLength(MAX_OPEN_LOOPS);
    expect(out.state.loops.open[0]!.subject).toBe('thing-1');
    expect(out.of('loop:expired').map((e) => e.payload.reason)).toEqual(['displaced']);
  });

  it('a line for a thread that is gone goes to the conversation, once', () => {
    const before = withUnpushed();
    const said = play(before, turn(before, S, at('14:02:10'), '263 commits not pushed.')).state;
    const pushed = play(said, [status(0, at('14:02:39'))]);
    const key = pushed.of('notice:candidate')[0]!.payload.key;
    const gone = play(pushed.state, [ev('notice:dropped', at('14:02:40'), { noticeKey: key, sessionId: S, reason: 'session-gone', kind: 'followup:unpushed' })]);
    expect(gone.of('notice:candidate').map((c) => c.payload.sessionId)).toEqual([null]);
    expect(gone.notifies.at(-1)?.payload).toMatchObject({ sessionId: null });
    const again = play(gone.state, [ev('notice:dropped', at('14:02:41'), { noticeKey: key, sessionId: null, reason: 'companion-disposed', kind: 'followup:unpushed' })]);
    expect(again.of('notice:candidate')).toEqual([]);
    expect(again.state.loops.recent.at(-1)).toMatchObject({ status: 'unsaid' });
  });
});
