import { describe, it, expect } from 'vitest';
import { createInitialState, hydrateSnapshot } from '@sundial/kernel/initial-state.js';
import { askLoop, openAsk } from '@sundial/helpers/loops.js';
import type { Effect, KernelState, OpenLoop, OpenOwnerAsk, SanitizedEvent } from '@sundial/kernel/types.js';
import { reduce } from '@sundial/kernel/reduce.js';
import { RULE_MANIFEST } from './index.js';
import { loopTrack } from './loop-track.js';
import { askClass, askPrecision, ownerAsk as countAsk, quietClass, rebuildAskClassGain, unanswerable } from './owner-ask.js';

// W2 M3: the open question is an `owner-ask` loop `loopTrack` folds; `ownerAsk` counts and records it after, on the same event.
function ownerAsk(state: KernelState, event: SanitizedEvent): { state: KernelState; effects: Effect[] } {
  const a = loopTrack(state, event);
  const b = countAsk(a.state, event);
  return { state: b.state, effects: [...a.effects, ...b.effects] };
}

const NOW = '2026-01-01T09:00:00.000Z';

const emitted = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'EmitEvent' }> => e.type === 'EmitEvent');
const written = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'WriteDB'; table: 'owner_asks' }> => e.type === 'WriteDB' && e.table === 'owner_asks');

function tick(ts: string): SanitizedEvent {
  return { id: `tick-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true };
}

function opened(payload: Record<string, unknown>, ts = NOW): SanitizedEvent {
  return { id: `open-${ts}`, type: 'ask:owner-opened', ts, payload, sanitized: true };
}

function answered(payload: Record<string, unknown>, ts = NOW): SanitizedEvent {
  return { id: `answer-${ts}`, type: 'ask:owner-answered', ts, payload, sanitized: true };
}

const OPEN: OpenOwnerAsk = {
  askId: 'owner-ask:1',
  question: 'Is the sundial branch part of Gnomon or its own project?',
  reason: 'two projects match the path',
  choices: [],
  ts: NOW,
};

function withOpen(open: OpenOwnerAsk | null, counts: { askedCount?: number; answeredCount?: number } = {}): KernelState {
  const state = createInitialState('d1');
  return { ...state, ownerAsk: { ...state.ownerAsk, askedCount: counts.askedCount ?? 1, answeredCount: counts.answeredCount ?? 0, recent: [] }, loops: { ...state.loops, open: open === null ? [] : [askLoop(open) as OpenLoop] } };
}

describe('W2 M3: the order the manifest folds an answer in', () => {
  it('listenToReply and askHarvest read the open question, then loopTrack closes it and ownerAsk records it — all on the one event', () => {
    const base = withOpen(OPEN);
    const state = { ...base, config: { ...base.config, ownerAliases: ['Mira Bakker'] } };
    const out = reduce(state, answered({ askId: 'owner-ask:1', answer: 'Its own project, puzzlebox-studio.' }, '2026-01-01T09:05:00.000Z'), RULE_MANIFEST);
    const harvest = out.effects.find((e) => e.effect.type === 'ScheduleLLM' && e.ruleName === 'askHarvest');
    expect(JSON.stringify(harvest?.effect)).toContain(OPEN.question);
    expect(openAsk(out.state)).toBeNull();
    expect(out.state.ownerAsk.answeredCount).toBe(1);
    expect(out.effects.filter((e) => e.effect.type === 'WriteDB' && e.ruleName === 'ownerAsk')).toHaveLength(1);
  });

  it('a wake-up due and an ask gone on the same tick: both happen', () => {
    const state = hydrateSnapshot('d1', { ownerAsk: { ...withOpen(OPEN).ownerAsk, open: OPEN }, wakeups: { open: [{ key: 'check-box-484', at: '2026-01-02T09:00:30.000Z', reason: 'check BOX-484', scheduledAt: NOW }] } } as unknown as Partial<KernelState>);
    const out = ownerAsk(state, tick('2026-01-02T09:01:00.000Z'));
    expect(openAsk(out.state)).toBeNull();
    expect(emitted(out.effects).map((e) => e.event.payload.kind)).toEqual(['wakeup']);
    expect(written(out.effects)[0]?.row.outcome).toBe('expired');
  });
});

describe('ownerAsk', () => {
  it('ignores events it does not own', () => {
    const state = withOpen(OPEN);
    const { state: next, effects } = ownerAsk(state, { id: 'e', type: 'window:changed', ts: NOW, payload: {}, sanitized: true });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('opens a question and emits it as an ordinary notice candidate, not a private channel', () => {
    const { state: next, effects } = ownerAsk(createInitialState('d1'), opened({ askId: 'owner-ask:1', question: 'Which project is this?', reason: 'two match' }));

    expect(openAsk(next)).toEqual({ askId: 'owner-ask:1', question: 'Which project is this?', reason: 'two match', choices: [], ts: NOW });
    expect(next.ownerAsk.askedCount).toBe(1);

    const [candidate] = emitted(effects);
    expect(candidate.event.type).toBe('notice:candidate');
    expect(candidate.event.payload.kind).toBe('owner-question');
    expect(candidate.event.payload.observation).toBe('Which project is this?');
    expect(candidate.event.payload.evidence).toEqual(['two match']);
  });

  it('a WAITING ask skips the gate: no candidate, one ask-open Notify, and the open slot says so', () => {
    const { state: next, effects } = ownerAsk(createInitialState('d1'), opened({ askId: 'owner-ask:1', question: 'Which project is this?', mode: 'wait' }));

    expect(openAsk(next)?.waiting).toBe(true);
    expect(emitted(effects)).toEqual([]);
    expect(effects).toEqual([{ type: 'Notify', channel: 'ask-open', payload: { askId: 'owner-ask:1' } }]);
  });

  // One-tap answers are normalized HERE and not trusted from the payload: the
  // signal can arrive from a replay, from the CLI, or from a model that ignored
  // the tool's schema, so a bad list would otherwise reach state and the screen.
  describe('one-tap answers', () => {
    const choicesOf = (choices: unknown) =>
      openAsk(ownerAsk(createInitialState('d1'), opened({ askId: 'a', question: 'Which project?', choices })).state)?.choices;

    it('keeps a short closed set in the order it was offered', () => {
      expect(choicesOf(['sundial', 'overture', 'neither'])).toEqual(['sundial', 'overture', 'neither']);
    });

    it('drops a single choice — one button is not a choice, it is a prompt to agree', () => {
      expect(choicesOf(['yes'])).toEqual([]);
    });

    it('stops at four, because a fifth button is a menu', () => {
      expect(choicesOf(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd']);
    });

    it('drops a sentence pretending to be a button, and blanks', () => {
      expect(choicesOf(['sundial', '  ', 'x'.repeat(60), 'overture'])).toEqual(['sundial', 'overture']);
    });

    it('de-duplicates rather than drawing the same button twice', () => {
      expect(choicesOf(['sundial', 'sundial', 'overture'])).toEqual(['sundial', 'overture']);
    });

    it.each([[undefined], [null], ['sundial, overture'], [42]])('treats %p as no choices at all, not a crash', (value) => {
      expect(choicesOf(value)).toEqual([]);
    });
  });

  it('carries the askId into the notice, so the answer can be matched rather than guessed', () => {
    const { effects } = ownerAsk(createInitialState('d1'), opened({ askId: 'owner-ask:1', question: 'Which project?' }));
    expect(emitted(effects)[0].event.payload.askId).toBe('owner-ask:1');
  });

  it('scores above the phasic threshold — a question deliberately asked is not a guess', () => {
    const { effects } = ownerAsk(createInitialState('d1'), opened({ askId: 'owner-ask:1', question: 'Which project?' }));
    const { payload } = emitted(effects)[0].event;
    expect((payload.surprise as number) * (payload.precision as number)).toBeGreaterThan(1.6);
  });

  it('refuses a second question while one is pending — a queue of open questions is an interrogation', () => {
    const state = withOpen(OPEN);
    const { state: next, effects } = ownerAsk(state, opened({ askId: 'owner-ask:2', question: 'And this one?' }));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('ignores an empty question', () => {
    const { state: next } = ownerAsk(createInitialState('d1'), opened({ question: '   ' }));
    expect(openAsk(next)).toBeNull();
  });

  it('closes on an answer and writes the durable row', () => {
    const { state: next, effects } = ownerAsk(withOpen(OPEN), answered({ askId: 'owner-ask:1', answer: "It's its own project." }, '2026-01-01T09:05:00.000Z'));

    expect(openAsk(next)).toBeNull();
    expect(next.ownerAsk.answeredCount).toBe(1);

    const [row] = written(effects);
    expect(row.row).toEqual({
      id: 'owner-ask:1',
      question: OPEN.question,
      reason: 'two projects match the path',
      askedAt: NOW,
      answer: "It's its own project.",
      answeredAt: '2026-01-01T09:05:00.000Z',
      outcome: 'answered',
    });
  });

  it('ignores an answer naming a different ask — a stale reply must not be attributed to the open question', () => {
    const state = withOpen(OPEN);
    const { state: next, effects } = ownerAsk(state, answered({ askId: 'owner-ask:99', answer: 'yes' }));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('ignores an answer when nothing was asked', () => {
    const state = withOpen(null);
    const { state: next } = ownerAsk(state, answered({ askId: 'owner-ask:1', answer: 'yes' }));
    expect(next).toBe(state);
  });

  it('ignores an empty answer rather than recording silence as a reply', () => {
    const state = withOpen(OPEN);
    const { state: next, effects } = ownerAsk(state, answered({ askId: 'owner-ask:1', answer: '  ' }));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('leaves a fresh question open on a tick', () => {
    const state = withOpen(OPEN);
    const { state: next, effects } = ownerAsk(state, tick('2026-01-01T15:00:00.000Z'));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('expires an ignored question after a day and RECORDS the silence — an answered-only table would look perfectly calibrated', () => {
    const { state: next, effects } = ownerAsk(withOpen(OPEN), tick('2026-01-02T09:01:00.000Z'));

    expect(openAsk(next)).toBeNull();
    // Not counted as answered: being ignored is not a reply.
    expect(next.ownerAsk.answeredCount).toBe(0);

    const [row] = written(effects);
    expect(row.row.outcome).toBe('expired');
    expect(row.row.answer).toBeNull();
    expect(row.row.answeredAt).toBeNull();
  });

  it('does nothing on a tick with no open question', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = ownerAsk(state, tick(NOW));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('remembers an answered question and refuses to open the same one again within six hours', () => {
    const answered = ownerAsk(withOpen(OPEN), { id: 'e-a', type: 'ask:owner-answered', ts: NOW, payload: { askId: 'owner-ask:1', answer: 'Fine, nothing to keep' } } as never);
    expect(openAsk(answered.state)).toBeNull();
    expect(answered.state.ownerAsk.recent).toEqual([{ askId: 'owner-ask:1', question: OPEN.question, answer: 'Fine, nothing to keep', answeredAt: NOW }]);
    // Same words, different id, five minutes later: the companion trying to recover an id. Dropped.
    const later = new Date(Date.parse(NOW) + 5 * 60_000).toISOString();
    const again = ownerAsk(answered.state, { ...opened({ askId: 'owner-ask:2', question: `  ${OPEN.question.toUpperCase()} ` }), ts: later } as never);
    expect(openAsk(again.state)).toBeNull();
    expect(again.effects).toEqual([]);
    // Seven hours later the same words are a new question.
    const nextDay = new Date(Date.parse(NOW) + 7 * 60 * 60_000).toISOString();
    const fresh = ownerAsk(answered.state, { ...opened({ askId: 'owner-ask:3', question: OPEN.question }), ts: nextDay } as never);
    expect(openAsk(fresh.state)?.askId).toBe('owner-ask:3');
  });

  it('does not prefix the gate key twice when the ask id already carries owner-ask:', () => {
    const { effects } = ownerAsk(createInitialState('d1'), opened({ askId: 'owner-ask:meeting-abc', question: 'How did it go?' }));
    expect(emitted(effects)[0].event.payload.key).toBe('owner-ask:meeting-abc');
  });

  it('derives the same ids when the same open event is replayed', () => {
    const first = ownerAsk(createInitialState('d1'), opened({ question: 'Which project?' }));
    const second = ownerAsk(createInitialState('d1'), opened({ question: 'Which project?' }));
    expect(openAsk(first.state)?.askId).toBe(openAsk(second.state)?.askId);
    expect(emitted(first.effects)[0].event.id).toBe(emitted(second.effects)[0].event.id);
  });

  /**
   * The 2026-09-09 class of defect, guarded at the one place every producer's
   * question arrives rather than in the rule that happened to cause it. The
   * exact strings below are the questions the owner was actually shown, and
   * refused, seven times in one day.
   */
  describe('a question the owner cannot answer is never opened', () => {
    it('refuses a question quoting a person-<hash> alias', () => {
      const question = 'Who is person-9f8e7d6c5b? They were in "Android developer meeting" with you and person-a1a2a3a4a5, Acme Office, person-b1b2b3b4b5.';
      const { state, effects } = ownerAsk(createInitialState('d1'), opened({ askId: 'owner-ask:who-person-9f8e7d6c5b', question }));
      expect(openAsk(state)).toBeNull();
      expect(state.ownerAsk.askedCount).toBe(0);
      expect(effects).toEqual([]);
    });

    it('refuses a question quoting a [private] or [hidden] placeholder', () => {
      for (const question of ['What were you doing in [private] this morning?', 'Was [hidden] work or not?']) {
        expect(openAsk(ownerAsk(createInitialState('d1'), opened({ question })).state)).toBeNull();
      }
    });

    it('still opens an ordinary question, and one that merely mentions a person by name', () => {
      for (const question of ['How did the standup go?', 'Was the meeting with Alex about the migration?']) {
        expect(openAsk(ownerAsk(createInitialState('d1'), opened({ question })).state)?.question).toBe(question);
      }
    });

    it('names the opaque token it objected to, so a producer bug is findable', () => {
      expect(unanswerable('Who is person-c205ca11f2?')).toBe('person-c205ca11f2');
      expect(unanswerable('How did the standup go?')).toBeNull();
    });
  });
});

describe('the ask gate', () => {
  // Settled from the record, and it is the whole item: an ask's gate key is its
  // own id, an ask is asked once, so the key never repeats. Over the 63 gate
  // decisions an ask had ever had on 2026-09-22, `habituation` was 1.0 and
  // `weight` was 2.0 on every single one. The stimulus is the TEMPLATE.
  it('reads the class off the id, never off the question text', () => {
    expect(askClass('owner-ask:who-person-4b3c2d1e0f')).toBe('who');
    expect(askClass('owner-ask:meeting-01M33YM3C0M2')).toBe('meeting');
    expect(askClass('owner-ask:goals-2026-09-20')).toBe('goals');
    expect(askClass('owner-ask:mtlewddl')).toBe('other');
    // Ids arrive with and without the prefix; `askKey` already settles that.
    expect(askClass('who-person-4b3c2d1e0f')).toBe('who');
  });

  it('starts at full volume, so an unjudged class asks exactly as it always did', () => {
    const state = withOpen(null);
    expect(askPrecision(state, 'owner-ask:meeting-1', NOW)).toBe(1);
  });

  it('a quieted class drops an ask under the interrupting bar, then under the list bar', () => {
    const base = withOpen(null);
    const quiet = (fires: number, gain: number): KernelState => ({ ...base, ownerAsk: { ...base.ownerAsk, classGain: { who: { gain, at: NOW, fires } } } });

    // `ASK_SURPRISE` is 2.0 and the gate multiplies surprise by precision, so
    // these are the weights the gate will see. One verdict: 0.8, under
    // `phasicThreshold` (1.6) — it stops interrupting and becomes a row.
    expect(2 * askPrecision(quiet(1, 0.4), 'owner-ask:who-person-1', NOW)).toBeCloseTo(0.8, 5);
    // Two: under `tonicThreshold` (0.55) as well, so the class goes silent.
    expect(2 * askPrecision(quiet(2, 0.16), 'owner-ask:who-person-1', NOW)).toBeLessThan(0.55);
    // And it is per class: the meeting questions are untouched by either.
    expect(askPrecision(quiet(2, 0.16), 'owner-ask:meeting-1', NOW)).toBe(1);
  });

  it('recovers, so a class quieted in September is askable again without a switch', () => {
    const base = withOpen(null);
    const quiet: KernelState = { ...base, ownerAsk: { ...base.ownerAsk, classGain: { who: { gain: 0.4, at: NOW, fires: 1 } } } };
    const month = new Date(Date.parse(NOW) + 30 * 86_400_000).toISOString();
    expect(askPrecision(quiet, 'owner-ask:who-1', month)).toBeGreaterThan(askPrecision(quiet, 'owner-ask:who-1', NOW));
  });

  it('carries the class precision onto the candidate it emits', () => {
    const base = withOpen(null);
    const quiet: KernelState = { ...base, ownerAsk: { ...base.ownerAsk, classGain: { who: { gain: 0.4, at: NOW, fires: 1 } } } };
    const { effects } = ownerAsk(quiet, opened({ askId: 'owner-ask:who-person-1', question: 'Who was the other person there?' }));
    const candidate = emitted(effects)[0]?.event.payload as { precision?: number; surprise?: number };
    expect(candidate.precision).toBeCloseTo(0.4, 5);
    // Surprise does not move. A question was still deliberately asked, and that
    // fact is not what the owner's verdict is about.
    expect(candidate.surprise).toBe(2.0);
  });
});

describe('the owner verdict survives a boot', () => {
  // `classGain` is fold-derived, so it is lost as soon as the fold that built it
  // is older than both the snapshot and the replayed tail. The one verdict this
  // record holds is from 2026-09-21 — without the rebuild the consumer would
  // have started at zero on the very machine whose owner had already pressed.
  it('rebuilds the same gain a live fold would have produced', () => {
    const live = feedbackVerdictFold([{ askId: 'owner-ask:who-person-4b3c2d1e0f', verdict: 'wrong', at: NOW }]);
    expect(rebuildAskClassGain([{ askId: 'owner-ask:who-person-4b3c2d1e0f', verdict: 'wrong', at: NOW }])).toEqual(live);
  });

  it('folds oldest first, whatever order the rows arrive in', () => {
    const later = new Date(Date.parse(NOW) + 3_600_000).toISOString();
    const forwards = rebuildAskClassGain([
      { askId: 'owner-ask:who-a', verdict: 'wrong', at: NOW },
      { askId: 'owner-ask:who-b', verdict: 'not-now', at: later },
    ]);
    const backwards = rebuildAskClassGain([
      { askId: 'owner-ask:who-b', verdict: 'not-now', at: later },
      { askId: 'owner-ask:who-a', verdict: 'wrong', at: NOW },
    ]);
    expect(backwards).toEqual(forwards);
    expect(forwards.who?.fires).toBe(2);
    expect(forwards.who?.at).toBe(later);
  });

  it('ignores a `useful` verdict and an ask class it cannot read', () => {
    expect(rebuildAskClassGain([{ askId: 'owner-ask:who-a', verdict: 'useful', at: NOW }])).toEqual({});
    expect(rebuildAskClassGain([])).toEqual({});
  });
});

/** The reducer's own path, so the rebuild is pinned against it rather than against itself. */
function feedbackVerdictFold(rows: { askId: string; verdict: string; at: string }[]): Record<string, { gain: number; at: string; fires: number }> {
  const gain: Record<string, { gain: number; at: string; fires: number }> = {};
  for (const row of rows) gain[askClass(row.askId)] = quietClass(gain[askClass(row.askId)], row.at);
  return gain;
}
