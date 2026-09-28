import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { watchRules } from './watch-rules.js';
import { deriveId } from '@sundial/helpers/derive-id.js';

let seq = 0;
const at = (min: number) => new Date(Date.parse('2026-09-28T09:00:00.000Z') + min * 60_000).toISOString();
const ev = (type: string, payload: Record<string, unknown>, min: number): SanitizedEvent => ({ id: `e${++seq}`, type, ts: at(min), payload, sanitized: true });
const spec = { title: 'Slack burst', when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Slack' }] }, count: { atLeast: 2, withinMin: 10 }, say: '{count} Slack checks in a row' };

function run(events: SanitizedEvent[], state: KernelState = createInitialState('d')) {
  const cands: Record<string, unknown>[] = [];
  for (const e of events) {
    const out = watchRules(state, e);
    state = out.state;
    for (const x of out.effects as { type: string; event?: SanitizedEvent }[]) if (x.type === 'EmitEvent') cands.push(x.event!.payload as Record<string, unknown>);
  }
  return { state, cands };
}

describe('watchRules', () => {
  it('adopts a spec from the log and speaks through a notice candidate', () => {
    const { state, cands } = run([ev('rule:adopted', { rule: spec }, 0), ev('window:changed', { processName: 'Slack' }, 1), ev('window:changed', { processName: 'Slack' }, 2)]);
    expect(state.watch?.rules.map((r) => r.id)).toEqual(['slack-burst']);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ kind: 'watch:slack-burst', observation: '2 Slack checks in a row' });
  });
  it('ignores a bad spec in the log and drops by id', () => {
    const { state } = run([ev('rule:adopted', { rule: { title: 'x' } }, 0), ev('rule:adopted', { rule: spec }, 1), ev('rule:dropped', { id: 'slack-burst' }, 2)]);
    expect(state.watch).toEqual({ rules: [], runtime: {} });
  });
  it('does nothing and allocates nothing with no rules', () => {
    const s = createInitialState('d');
    expect(watchRules(s, ev('window:changed', { processName: 'Slack' }, 0)).state).toBe(s);
  });
  it('a rule proposed on the shelf is adopted by the owner\'s Keep, and thrown away by Wrong', () => {
    const shelved = ev('work:shelved', { title: 'Rule idea: Slack burst', body: 'b', jobId: 'j', rule: spec }, 0);
    const entry = deriveId(shelved.ts, shelved.id, 'shelf');
    const kept = run([shelved, ev('feedback:verdict', { artifactKind: 'knowledge_entry', artifactId: entry, verdict: 'useful' }, 1)]);
    expect(kept.state.watch?.proposed).toEqual({});
    const out = watchRules(run([shelved]).state, ev('feedback:verdict', { artifactKind: 'knowledge_entry', artifactId: entry, verdict: 'useful' }, 1));
    expect(out.effects).toEqual([expect.objectContaining({ type: 'EmitEvent', event: expect.objectContaining({ type: 'rule:adopted', payload: { rule: expect.objectContaining({ id: 'slack-burst' }), via: entry } }) })]);
    const wrong = watchRules(run([shelved]).state, ev('feedback:verdict', { artifactKind: 'knowledge_entry', artifactId: entry, verdict: 'wrong' }, 1));
    expect(wrong.effects).toEqual([]);
    expect(wrong.state.watch?.proposed).toEqual({});
  });
});
