import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { askTrack } from './ask-track.js';

const TS = '2026-07-28T14:00:00.000Z';

function answered(payload: Record<string, unknown>, ts = TS, id = 'e1'): SanitizedEvent {
  return { id, type: 'ask:answered', ts, payload, sanitized: true };
}

function remembered(payload: Record<string, unknown>, ts = '2026-07-28T14:05:00.000Z', id = 'e2'): SanitizedEvent {
  return { id, type: 'ask:remembered', ts, payload, sanitized: true };
}

const ASKED = {
  threadId: 't1',
  question: 'What did I work on last Tuesday?',
  answer: 'Mostly the kernel package, about four hours.',
  reason: null,
  sourceCount: 6,
  sources: '[{"refType":"moment","refId":"m1","label":"Xcode"}]',
};

function threadRow(effects: Effect[]): Extract<Effect, { table: 'ask_threads' }>['row'] {
  const effect = effects.find((e): e is Extract<Effect, { table: 'ask_threads' }> => e.type === 'WriteDB' && e.table === 'ask_threads');
  if (!effect) throw new Error('expected an ask_threads write');
  return effect.row;
}

describe('askTrack', () => {
  it('ignores unrelated event types', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: TS, payload: {}, sanitized: true };
    const { state: next, effects } = askTrack(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('folds an answered question into the slice and writes the durable thread', () => {
    const { state: next, effects } = askTrack(createInitialState('d1'), answered(ASKED));

    expect(next.ask.recent).toEqual([
      { id: 't1', question: ASKED.question, askedAt: TS, answered: true, sourceCount: 6, remembered: false },
    ]);
    expect(next.ask.askedCount).toBe(1);
    expect(next.ask.rememberedCount).toBe(0);
    expect(next.ask.lastAskedAt).toBe(TS);

    const row = threadRow(effects);
    expect(row).toMatchObject({ id: 't1', answer: ASKED.answer, sourceCount: 6, remembered: false, sourceEventId: 'e1' });
    expect(row.sources).toBe(ASKED.sources);
  });

  it('keeps the answer OUT of kernel state — a snapshot must not carry unbounded model prose', () => {
    const { state: next } = askTrack(createInitialState('d1'), answered(ASKED));
    expect(JSON.stringify(next.ask)).not.toContain('Mostly the kernel package');
  });

  it('keeps a question the record could not answer — a gap is evidence, not nothing', () => {
    const { state: next, effects } = askTrack(
      createInitialState('d1'),
      answered({ threadId: 't2', question: 'Who did I meet in March?', answer: null, reason: 'no memory to answer from yet', sourceCount: 0 }),
    );
    expect(next.ask.recent[0]).toMatchObject({ id: 't2', answered: false, sourceCount: 0 });
    expect(threadRow(effects)).toMatchObject({ answer: null, reason: 'no memory to answer from yet' });
  });

  it('drops a malformed payload rather than folding a thread with no question', () => {
    for (const payload of [{}, { threadId: 't1' }, { question: 'hi' }, { threadId: '  ', question: 'hi' }]) {
      const state = createInitialState('d1');
      const { state: next, effects } = askTrack(state, answered(payload));
      expect(next).toBe(state);
      expect(effects).toEqual([]);
    }
  });

  it('a remember writes the knowledge entry and embeds question + answer together', () => {
    const asked = askTrack(createInitialState('d1'), answered(ASKED)).state;
    const { state: next, effects } = askTrack(asked, remembered({ threadId: 't1', question: ASKED.question, answer: ASKED.answer }));

    expect(next.ask.rememberedCount).toBe(1);
    expect(next.ask.recent[0]?.remembered).toBe(true);
    // The ask itself is not re-counted by a remember.
    expect(next.ask.askedCount).toBe(1);

    const entry = effects.find((e): e is Extract<Effect, { table: 'knowledge_entries' }> => e.type === 'WriteDB' && e.table === 'knowledge_entries');
    expect(entry?.row).toMatchObject({ kind: 'ask', title: ASKED.question, body: ASKED.answer, dedupeKey: 'ask:t1' });

    const embed = effects.find((e) => e.type === 'Embed');
    expect(embed).toMatchObject({ refType: 'knowledge_entry', refId: entry?.row.id });
    expect(embed && 'text' in embed ? embed.text : '').toContain(ASKED.question);
    expect(embed && 'text' in embed ? embed.text : '').toContain(ASKED.answer);

    // The thread upsert may only carry the remember forward; the original
    // `askedAt` must survive it.
    expect(threadRow(effects)).toMatchObject({ remembered: true, askedAt: TS, rememberedEntryId: entry?.row.id });
  });

  it('a second remember on the same thread is dropped — re-embedding the same text costs real work for nothing', () => {
    let state: KernelState = askTrack(createInitialState('d1'), answered(ASKED)).state;
    state = askTrack(state, remembered({ threadId: 't1', question: ASKED.question, answer: ASKED.answer })).state;

    const again = askTrack(state, remembered({ threadId: 't1', question: ASKED.question, answer: ASKED.answer }, '2026-07-28T15:00:00.000Z', 'e3'));
    expect(again.state).toBe(state);
    expect(again.effects).toEqual([]);
    expect(again.state.ask.rememberedCount).toBe(1);
  });

  it('refuses to remember a thread with no answer to promote', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = askTrack(state, remembered({ threadId: 't1', question: 'anything?', answer: null }));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('bounds `recent` while the cumulative counts keep counting', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 40; i += 1) {
      state = askTrack(state, answered({ ...ASKED, threadId: `t${i}` }, TS, `e${i}`)).state;
    }
    expect(state.ask.recent.length).toBe(30);
    expect(state.ask.askedCount).toBe(40);
    // Newest last, and the oldest have rolled off the front.
    expect(state.ask.recent.at(-1)?.id).toBe('t39');
    expect(state.ask.recent.some((t) => t.id === 't0')).toBe(false);
  });

  it('re-asking the same thread id replaces its entry rather than duplicating it', () => {
    let state = askTrack(createInitialState('d1'), answered(ASKED)).state;
    state = askTrack(state, answered({ ...ASKED, answer: 'A better answer.' }, '2026-07-28T16:00:00.000Z', 'e9')).state;
    expect(state.ask.recent.filter((t) => t.id === 't1').length).toBe(1);
    expect(state.ask.recent[0]?.askedAt).toBe('2026-07-28T16:00:00.000Z');
  });
});
