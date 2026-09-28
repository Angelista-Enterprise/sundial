import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, OpenOwnerAsk, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { applyLlmResult } from './apply-llm-result.js';
import { ASK_BACKFILL_INTERVAL_MS, ASK_HARVEST_DRAINED, ASK_HARVEST_DUE, MAX_ASK_PROPOSALS, askHarvest, askHarvestBackfill, askHarvestInstructions, askHarvestPrompt, parseAskProposals } from './ask-harvest.js';

const NOW = '2026-09-22T09:00:00.000Z';

const scheduled = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'ScheduleLLM' }> => e.type === 'ScheduleLLM');

function stateWith(open: OpenOwnerAsk | null): KernelState {
  const base = createInitialState('d1');
  return { ...base, config: { ...base.config, ownerAliases: ['Pat'] }, ownerAsk: { ...base.ownerAsk, open } };
}

function ask(question: string): OpenOwnerAsk {
  return { askId: 'owner-ask:1', question, reason: '', choices: [], ts: NOW };
}

function answered(payload: Record<string, unknown>, ts = NOW): SanitizedEvent {
  return { id: `answer-${ts}`, type: 'ask:owner-answered', ts, payload, sanitized: true };
}

function due(payload: Record<string, unknown>): SanitizedEvent {
  return { id: 'due-1', type: ASK_HARVEST_DUE, ts: NOW, payload, sanitized: true };
}

describe('askHarvest', () => {
  it('schedules exactly one extract call for an answered ask, and nothing on any other event', () => {
    const state = stateWith(ask('Does the sundial branch belong to gnomon, or is it its own project?'));
    const { effects } = askHarvest(state, answered({ askId: 'owner-ask:1', answer: 'gnomon' }));

    expect(effects).toHaveLength(1);
    expect(scheduled(effects)[0]).toMatchObject({ purpose: 'extract', momentId: null, metadata: { askId: 'owner-ask:1' } });

    for (const event of [
      { id: 'a', type: 'clock:tick', ts: NOW, payload: {}, sanitized: true },
      { id: 'b', type: 'ask:owner-opened', ts: NOW, payload: { question: 'q' }, sanitized: true },
      { id: 'c', type: 'llm:result', ts: NOW, payload: { purpose: 'extract', text: '[]' }, sanitized: true },
    ] satisfies SanitizedEvent[]) {
      expect(askHarvest(state, event).effects).toEqual([]);
    }
  });

  // The whole of H2's ordering requirement, stated as a test: `ownerAsk` sets
  // `open` to null on this very event, so a harvest placed after it in
  // RULE_MANIFEST would read no question at all.
  it('reads the question off the OPEN ask, and refuses when there is none', () => {
    const state = stateWith(ask('How did "Standup" go?'));
    const call = scheduled(askHarvest(state, answered({ answer: 'Fine, nothing to keep' })).effects)[0];
    expect(call?.messages[1]?.content).toContain('How did "Standup" go?');

    expect(askHarvest(stateWith(null), answered({ answer: 'Fine, nothing to keep' })).effects).toEqual([]);
  });

  it('refuses an answer naming a different ask — a stale reply to an expired question', () => {
    const state = stateWith(ask('Who is person-d1feb17d9f?'));
    expect(askHarvest(state, answered({ askId: 'owner-ask:other', answer: 'Jordan De Wit' })).effects).toEqual([]);
  });

  // "gnomon" is six letters and is the whole answer; "Fine, nothing to keep" is
  // nineteen and holds nothing. A length gate would get both wrong.
  it('does not gate on answer length', () => {
    const state = stateWith(ask('Does the sundial branch belong to gnomon?'));
    expect(scheduled(askHarvest(state, answered({ answer: 'gnomon' })).effects)).toHaveLength(1);
  });

  it('refuses when the owner has no name to file anything under', () => {
    const base = stateWith(ask('q'));
    const nameless: KernelState = { ...base, config: { ...base.config, ownerAliases: [] } };
    expect(askHarvest(nameless, answered({ answer: 'an answer' })).effects).toEqual([]);
  });

  it("the backfill's own door carries its question and answer, needing no open ask", () => {
    const effects = askHarvest(stateWith(null), due({ askId: 'owner-ask:old', question: 'How did the call go?', answer: 'It was with Thomas.' })).effects;
    expect(scheduled(effects)[0]).toMatchObject({ metadata: { askId: 'owner-ask:old' } });
    expect(askHarvest(stateWith(null), due({ askId: 'owner-ask:old', question: '', answer: 'x' })).effects).toEqual([]);
  });
});

describe('askHarvestInstructions', () => {
  it('says plainly that refusing is the normal answer, and caps the list at three', () => {
    const text = askHarvestInstructions('Pat');
    expect(text).toMatch(/Most answers hold nothing/);
    expect(text).toContain(`up to ${MAX_ASK_PROPOSALS} objects`);
    expect(text).toContain('Respond with [] when nothing qualifies.');
  });

  // H3's first difference: the question is half the meaning of the answer.
  it('puts the question beside the answer', () => {
    expect(askHarvestPrompt('Who is person-d1feb17d9f?', 'Jordan De Wit')).toBe('Gnomon asked: Who is person-d1feb17d9f?\n\nThe owner answered: Jordan De Wit');
  });
});

describe('parseAskProposals', () => {
  it('reads a filled-in form, strongest first', () => {
    const text = JSON.stringify([
      { entityKind: 'person', canonicalName: 'person-d1feb17d9f', predicate: 'knownAs', object: 'Jordan De Wit', confidence: 60 },
      { entityKind: 'project', canonicalName: 'tango', predicate: 'decided', object: 'outline only the anchor cell on a single error', confidence: 85 },
    ]);
    expect(parseAskProposals(text).map((p) => p.confidence)).toEqual([85, 60]);
  });

  // "Fine, nothing to keep" and "didnt attend this" are 29 of the live 49.
  it('an empty reading stays an empty reading', () => {
    expect(parseAskProposals('[]')).toEqual([]);
    expect(parseAskProposals('```json\n[]\n```')).toEqual([]);
  });

  it('drops a weak reading, a malformed one, and a fact about itself', () => {
    const text = JSON.stringify([
      { entityKind: 'topic', canonicalName: 'standup', predicate: 'relatesToProject', object: 'puzzles', confidence: 20 },
      { entityKind: 'nonsense', canonicalName: 'x', predicate: 'p', object: 'o', confidence: 90 },
      { entityKind: 'project', canonicalName: 'sundial', predicate: 'worksOn', object: 'sundial', confidence: 90 },
      { entityKind: 'project', canonicalName: 'daily', predicate: 'worked_on', object: 'this week is an Daily client sprint', confidence: 75 },
    ]);
    // The survivor also proves the shared vocabulary: `worked_on` is folded onto
    // `worksOn` by the same `normalizePredicate` the nightly pass uses.
    expect(parseAskProposals(text)).toEqual([{ entityKind: 'project', canonicalName: 'daily', predicate: 'worksOn', object: 'this week is an Daily client sprint', confidence: 75 }]);
  });

  it('never offers more than three', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ entityKind: 'topic', canonicalName: `t${i}`, predicate: 'relatesToProject', object: 'gnomon', confidence: 60 + i }));
    expect(parseAskProposals(JSON.stringify(many))).toHaveLength(MAX_ASK_PROPOSALS);
  });

  it('degrades to nothing read on anything unparseable', () => {
    expect(parseAskProposals('I could not find anything.')).toEqual([]);
    expect(parseAskProposals('{"entityKind":"topic"}')).toEqual([]);
  });
});

describe('applyLlmResult, ask branch', () => {
  const result = (payload: Record<string, unknown>): SanitizedEvent => ({ id: 'r1', type: 'llm:result', ts: NOW, payload, sanitized: true });

  it('files the reading beside the ask and writes no fact', () => {
    const text = JSON.stringify([{ entityKind: 'person', canonicalName: 'person-d1feb17d9f', predicate: 'knownAs', object: 'Jordan De Wit', confidence: 80 }]);
    const { effects } = applyLlmResult(stateWith(null), result({ purpose: 'extract', text, metadata: { askId: 'owner-ask:1' } }));

    expect(effects).toEqual([
      { type: 'UpdateOwnerAsk', askId: 'owner-ask:1', patch: { proposals: [{ entityKind: 'person', canonicalName: 'person-d1feb17d9f', predicate: 'knownAs', object: 'Jordan De Wit', confidence: 80 }] } },
    ]);
    // D2, as a test: the `entity:fact-candidate` door stays shut. The one
    // auto-router that ever opened it wrote a counter-question down as a name.
    expect(effects.some((e) => e.type === 'EmitEvent' || e.type === 'UpsertEntityFact')).toBe(false);
  });

  it('stores an empty reading, so the backfill does not offer the same answer again', () => {
    const { effects } = applyLlmResult(stateWith(null), result({ purpose: 'extract', text: '[]', metadata: { askId: 'owner-ask:1' } }));
    expect(effects).toEqual([{ type: 'UpdateOwnerAsk', askId: 'owner-ask:1', patch: { proposals: [] } }]);
  });

  it('leaves every other purpose alone', () => {
    expect(applyLlmResult(stateWith(null), result({ purpose: 'transcript', text: 'cleaned', momentId: 'm1' })).effects[0]).toMatchObject({ type: 'UpdateMomentData' });
  });
});

describe('askHarvestBackfill', () => {
  const tick = (ts: string): SanitizedEvent => ({ id: `tick-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true });

  // One per `clock:tick`, which is as fast as this sweep can go. The interval
  // is still an interval and not a loop: it is what stops a restart re-firing
  // the sweep the instant it boots.
  it('sweeps at most one an interval, and remembers when it last did', () => {
    const state = stateWith(null);
    const first = askHarvestBackfill(state, tick(NOW));
    expect(first.effects).toEqual([{ type: 'RunAskHarvestBackfill', ts: NOW }]);
    expect(first.state.ownerAsk.lastBackfillAt).toBe(NOW);

    const soon = new Date(Date.parse(NOW) + ASK_BACKFILL_INTERVAL_MS - 1).toISOString();
    expect(askHarvestBackfill(first.state, tick(soon)).effects).toEqual([]);

    const later = new Date(Date.parse(NOW) + ASK_BACKFILL_INTERVAL_MS).toISOString();
    expect(askHarvestBackfill(first.state, tick(later)).effects).toHaveLength(1);
  });

  // H4's "done when": it drains to zero and STAYS there. A sweep that kept
  // ticking after the record was read would be a switch to remember to turn off.
  it('stops for good when the executor reports nothing left', () => {
    const swept = askHarvestBackfill(stateWith(null), tick(NOW)).state;
    const drained = askHarvestBackfill(swept, { id: 'd', type: ASK_HARVEST_DRAINED, ts: NOW, payload: {}, sanitized: true });
    expect(drained.state.ownerAsk.backfillDone).toBe(true);

    const muchLater = new Date(Date.parse(NOW) + 500 * ASK_BACKFILL_INTERVAL_MS).toISOString();
    expect(askHarvestBackfill(drained.state, tick(muchLater)).effects).toEqual([]);
  });
});
