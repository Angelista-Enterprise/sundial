import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, ResearchGoal, SanitizedEvent, UncertaintyGap } from '@sundial/kernel/types.js';
import { researchGoals } from './research-goals.js';

const tick = (ts = '2026-08-02T10:00:00.000Z'): SanitizedEvent => ({ id: 't1', type: 'clock:tick', ts, payload: {}, sanitized: true });

function gap(over: Partial<UncertaintyGap> = {}): UncertaintyGap {
  return { kind: 'day-ending', forecaster: 'day-shape', cell: '17', label: '17:00', n: 20, hits: 10, expectedLoss: 0.69, excessLoss: 0.4, ...over };
}

function withGaps(gaps: UncertaintyGap[], goals: ResearchGoal[] = []): KernelState {
  const base = createInitialState('d1');
  return { ...base, mind: { ...base.mind, gaps, goals } };
}

function openGoal(over: Partial<ResearchGoal> = {}): ResearchGoal {
  return {
    id: 'day-shape:17',
    forecaster: 'day-shape',
    cell: '17',
    label: '17:00',
    question: 'What actually happens around 17:00?',
    openedAt: '2026-07-01T10:00:00.000Z',
    openedWith: { n: 20, expectedLoss: 0.69, excessLoss: 0.4 },
    closedAt: null,
    outcome: null,
    closedWith: null,
    ...over,
  };
}

describe('researchGoals', () => {
  it('ignores everything that is not a tick — it chooses on its own schedule, not on events', () => {
    const state = withGaps([gap()]);
    const result = researchGoals(state, { id: 'w1', type: 'window:changed', ts: '2026-08-02T10:00:00.000Z', payload: {}, sanitized: true });
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });

  it('opens one goal on the worst gap, and states what it is measured against', () => {
    const result = researchGoals(withGaps([gap({ label: '17:00', expectedLoss: 0.69 })]), tick());
    const [goal] = result.state.mind.goals;

    expect(result.state.mind.goals).toHaveLength(1);
    expect(goal.id).toBe('day-shape:17');
    expect(goal.label).toBe('17:00');
    expect(goal.closedAt).toBeNull();
    // The baseline is the whole point: without it a later drop cannot be attributed.
    expect(goal.openedWith).toEqual({ n: 20, expectedLoss: 0.69, excessLoss: 0.4 });
    // Opening is not worth SAYING — but it is worth ASKING about: the same
    // tick requests a hypothesis proposal, marked on the goal so a slow model
    // cannot be asked twice.
    expect(result.effects).toHaveLength(1);
    const proposal = result.effects[0];
    expect(proposal.type).toBe('ScheduleLLM');
    if (proposal.type === 'ScheduleLLM') {
      expect(proposal.purpose).toBe('goal');
      expect(proposal.metadata).toEqual({ goalId: 'day-shape:17' });
    }
    expect(goal.proposalRequestedAt).toBe('2026-08-02T10:00:00.000Z');
  });

  it('takes the first gap in the map rather than re-ranking, so the two rules cannot disagree', () => {
    // `uncertaintyMap` already sorts worst-first. Re-sorting here would duplicate
    // that judgment in a second place.
    const state = withGaps([gap({ cell: '9', label: '09:00', expectedLoss: 0.5 }), gap({ cell: '17', label: '17:00', expectedLoss: 0.9 })]);
    expect(researchGoals(state, tick()).state.mind.goals[0].label).toBe('09:00');
  });

  it('refuses a gap with too little evidence — that is a claim about the prior, not the owner', () => {
    const result = researchGoals(withGaps([gap({ n: 2 })]), tick());
    expect(result.state.mind.goals).toEqual([]);
  });

  it('refuses a gap the forecaster is already close enough on', () => {
    const result = researchGoals(withGaps([gap({ expectedLoss: 0.2 })]), tick());
    expect(result.state.mind.goals).toEqual([]);
  });

  it('holds one question at a time', () => {
    const state = withGaps([gap({ cell: '9', label: '09:00' }), gap({ cell: '17', label: '17:00' })], [openGoal({ id: 'day-shape:9' })]);
    // Cooldown aside, the cap alone must stop a second opening.
    const result = researchGoals(state, tick('2026-09-01T10:00:00.000Z'));
    expect(result.state.mind.goals.filter((goal) => goal.closedAt === null)).toHaveLength(1);
  });

  it('will not open a second goal within the cooldown, so a full map cannot open one per tick', () => {
    const justOpened = openGoal({ openedAt: '2026-08-02T09:00:00.000Z', closedAt: '2026-08-02T09:30:00.000Z', outcome: 'stale', closedWith: { n: 20, expectedLoss: 0.69 } });
    const state = withGaps([gap({ cell: '9', label: '09:00' })], [justOpened]);
    const result = researchGoals(state, tick('2026-08-02T10:00:00.000Z'));
    expect(result.state.mind.goals.filter((goal) => goal.closedAt === null)).toHaveLength(0);
  });

  // A cell studied once used to be barred for good: `alreadyGoaled` held every
  // id in `mind.goals` with no expiry, and the top-five gap map holds the same
  // cells week after week, so the pool emptied and stayed empty. Nothing chose
  // that — it is what a Set does.
  describe('studying a cell again', () => {
    const settled = (over = {}) =>
      openGoal({ openedAt: '2026-06-01T10:00:00.000Z', closedAt: '2026-06-02T10:00:00.000Z', outcome: 'learned', closedWith: { n: 40, expectedLoss: 0.69 }, ...over });

    it('leaves a recently studied cell alone', () => {
      const state = withGaps([gap()], [settled({ closedAt: '2026-08-20T10:00:00.000Z' })]);
      const result = researchGoals(state, tick('2026-09-10T10:00:00.000Z'));
      expect(result.state.mind.goals.filter((goal) => goal.closedAt === null)).toHaveLength(0);
    });

    it('opens it again once the cell has been left alone for a month', () => {
      const state = withGaps([gap()], [settled({ closedAt: '2026-08-01T10:00:00.000Z' })]);
      const result = researchGoals(state, tick('2026-09-10T10:00:00.000Z'));
      const open = result.state.mind.goals.filter((goal) => goal.closedAt === null);
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe('day-shape:17');
    });

    // The doc on this rule warns that an agent optimising importance "re-opens
    // the same unlearnable question forever". A `stale` close IS that finding.
    it('waits far longer on a cell that closed having learned nothing', () => {
      const state = withGaps([gap()], [settled({ closedAt: '2026-08-01T10:00:00.000Z', outcome: 'stale' })]);
      const result = researchGoals(state, tick('2026-09-10T10:00:00.000Z'));
      expect(result.state.mind.goals.filter((goal) => goal.closedAt === null)).toHaveLength(0);

      const later = researchGoals(state, tick('2026-11-10T10:00:00.000Z'));
      expect(later.state.mind.goals.filter((goal) => goal.closedAt === null)).toHaveLength(1);
    });

    // Opened recently on purpose: a goal left open past STALE_AFTER_MS closes
    // itself on the tick, which would make this pass for the wrong reason.
    it('never re-opens a cell whose goal is still running', () => {
      const state = withGaps([gap()], [openGoal({ openedAt: '2026-09-05T10:00:00.000Z' })]);
      const result = researchGoals(state, tick('2026-09-10T10:00:00.000Z'));
      expect(result.state.mind.goals.filter((goal) => goal.closedAt === null)).toHaveLength(1);
    });
  });

  it('closes a goal as learned when the CORRECTABLE loss falls, and offers it as a self-report', () => {
    // excessLoss 0.40 → 0.01 is a 97% drop, past the 30% bar. Note the total
    // expectedLoss stays at 0.69: the cell is still a coin flip and always will
    // be. What changed is that the forecaster now bets what the cell believes,
    // which is the only thing "I learned this" can honestly mean here.
    const state = withGaps([gap({ expectedLoss: 0.69, excessLoss: 0.01, n: 40 })], [openGoal()]);
    const result = researchGoals(state, tick());
    const [goal] = result.state.mind.goals;

    // K0.4: this ending is `faded`, not `learned`. Nothing was tested — no
    // hypothesis was ever formed — so it reports that the gap closed on its
    // own. `learned` belongs to the trial path, which has a variable, two arms
    // and a measured gain.
    expect(goal.outcome).toBe('faded');
    // And `excessLoss` is stored, which it was not: the close is DECIDED on it
    // and recorded the expected loss instead, so a closed goal's arithmetic
    // could not be checked from the record afterwards.
    expect(goal.closedWith).toEqual({ n: 40, expectedLoss: 0.69, excessLoss: 0.01 });
    // The conclusion the notice was already building and throwing away.
    expect(goal.finding).toEqual({ variable: null, gain: 0.39, arms: null, excessFrom: 0.4, excessTo: 0.01, newObservations: 20 });

    expect(result.effects).toHaveLength(1);
    const emitted = result.effects[0];
    expect(emitted.type).toBe('EmitEvent');
    const candidate = emitted.type === 'EmitEvent' ? (emitted.event.payload as Record<string, unknown>) : {};
    // The shape the taxonomy declared and no producer had ever filled.
    expect(candidate.shape).toBe('self-report');
    expect(candidate.key).toBe('goal:day-shape:17');
    // Surprise is the loss actually burnt off, in the nats every other producer uses.
    expect(candidate.surprise).toBeCloseTo(0.39, 5);
    // The report must quote the CORRECTABLE numbers. Quoting the totals would
    // claim credit for entropy the daemon never removed.
    expect(String(candidate.observation)).toContain('0.40 to 0.01');
    expect(String(candidate.observation)).toContain('correctable error');
    // It keeps until morning; learning something must never interrupt.
    expect(candidate.valueHalfLifeMs).toBeNull();
    expect(String(candidate.observation)).toContain('17:00');
  });

  it('re-baselines a goal persisted before excessLoss existed, instead of letting NaN zombie it', () => {
    // The live 06:00 goal was opened by the first version of this rule, whose
    // `openedWith` had no `excessLoss`. Under the new criterion that read as
    // `undefined - x = NaN`, every comparison went false, and the goal could
    // only ever close by the three-week timeout — a zombie, silently. The rule
    // must instead adopt the current gap's excessLoss as the baseline and judge
    // from the next tick.
    const legacy = { ...openGoal(), openedWith: { n: 20, expectedLoss: 0.69 } } as unknown as ResearchGoal;
    const result = researchGoals(withGaps([gap({ excessLoss: 0.33 })], [legacy]), tick());
    const [migrated] = result.state.mind.goals;

    expect(migrated.closedAt).toBeNull();
    expect(migrated.openedWith).toEqual({ n: 20, expectedLoss: 0.69, excessLoss: 0.33 });
    // A pre-propose-and-verify goal also lacks a hypothesis, so the same tick
    // asks for one — the two migrations compose.
    expect(result.effects.map((effect) => effect.type)).toEqual(['ScheduleLLM']);
  });

  it('retires a DISPLACED goal as superseded and says nothing — absence from a top-5 list is not a discovery', () => {
    // The rule first read a missing cell as zero loss, so any cell pushed off
    // the five-slot map closed as `learned` and announced a total improvement
    // ("0.69 → 0.00 nats") that had never happened. Displacement says only
    // that four other cells now rank higher.
    const result = researchGoals(withGaps([], [openGoal()]), tick());

    expect(result.state.mind.goals[0].outcome).toBe('superseded');
    expect(result.state.mind.goals[0].closedWith).toEqual({ n: 20, expectedLoss: 0.69 });
    expect(result.effects).toEqual([]);
  });

  it('cannot close as learned on entropy alone — the floor a whole run of observations cannot cross', () => {
    // A coin-flip cell watched forever: n climbs, the total loss sits at its
    // entropy, and the correctable part never moves. The old criterion targeted
    // 70% of the TOTAL, which is beneath that floor, so this could never close.
    // It must now sit open rather than report a win it did not earn.
    const state = withGaps([gap({ n: 400, hits: 200, expectedLoss: 0.69, excessLoss: 0.4 })], [openGoal()]);
    const result = researchGoals(state, tick('2026-07-10T10:00:00.000Z'));

    expect(result.state.mind.goals[0].outcome).toBeNull();
    // No CLOSE and no notice — a proposal request is the only permitted effect.
    expect(result.effects.every((effect) => effect.type === 'ScheduleLLM')).toBe(true);
  });

  it('retires an unmoved goal as stale WITHOUT saying anything, after three weeks', () => {
    // Loss unchanged 22 days on. A real finding — but about Gnomon, not the
    // owner, and spending the day's one notice on it would be an apology.
    const state = withGaps([gap()], [openGoal({ openedAt: '2026-07-11T10:00:00.000Z' })]);
    const result = researchGoals(state, tick('2026-08-02T10:00:00.000Z'));

    expect(result.state.mind.goals[0].outcome).toBe('stale');
    expect(result.effects).toEqual([]);
  });

  it('does NOT retire at eight days — a cell gains about one observation a day, so a week is not a trial', () => {
    const state = withGaps([gap()], [openGoal({ openedAt: '2026-07-25T10:00:00.000Z' })]);
    const result = researchGoals(state, tick('2026-08-02T10:00:00.000Z'));

    expect(result.state.mind.goals[0].outcome).toBeNull();
    expect(result.state.mind.goals[0].closedAt).toBeNull();
  });

  it('leaves state untouched when nothing opens and nothing closes', () => {
    // Same identity back, so a tick that changes nothing cannot invalidate a
    // snapshot or wake a downstream memo.
    const state = withGaps([gap({ n: 1 })]);
    expect(researchGoals(state, tick()).state).toBe(state);
  });

  it('bounds the settled tail so the working set cannot grow without limit', () => {
    const closed = Array.from({ length: 9 }, (_unused, i) =>
      openGoal({ id: `day-shape:${i}`, cell: String(i), closedAt: '2026-07-02T10:00:00.000Z', outcome: 'stale', closedWith: { n: 20, expectedLoss: 0.69 } }),
    );
    const state = withGaps([gap({ cell: '23', label: '23:00' })], closed);
    const result = researchGoals(state, tick('2026-09-01T10:00:00.000Z'));

    expect(result.state.mind.goals.filter((goal) => goal.closedAt !== null)).toHaveLength(5);
    expect(result.state.mind.goals.filter((goal) => goal.closedAt === null)).toHaveLength(1);
  });
});

describe('propose-and-verify', () => {
  const llmResult = (text: string, goalId = 'day-shape:17'): SanitizedEvent => ({
    id: 'lr1',
    type: 'llm:result',
    ts: '2026-07-01T10:05:00.000Z',
    payload: { purpose: 'goal', text, metadata: { goalId } },
    sanitized: true,
  });

  const trialResult = (over: Record<string, unknown> = {}): SanitizedEvent => ({
    id: 'tr1',
    type: 'goal:trial-result',
    ts: '2026-07-01T10:06:00.000Z',
    payload: {
      goalId: 'day-shape:17',
      cell: '17',
      variable: 'weekend',
      accepted: true,
      gain: 0.31,
      arms: { when: { n: 5, hits: 4 }, otherwise: { n: 8, hits: 0 } },
      unknown: 2,
      ...over,
    },
    sanitized: true,
  });

  const proposed = (over: Partial<ResearchGoal> = {}) => openGoal({ proposalRequestedAt: '2026-07-01T10:00:00.000Z', hypothesis: null, tried: [], ...over });

  it('turns a valid proposal into a pre-registered trial of THAT variable', () => {
    const state = withGaps([gap()], [proposed()]);
    const result = researchGoals(state, llmResult('Sure! {"variable": "weekend", "because": "17:00 looks like a workday pattern"}'));

    expect(result.state.mind.goals[0].hypothesis).toEqual({ variable: 'weekend', because: '17:00 looks like a workday pattern', proposedAt: '2026-07-01T10:05:00.000Z' });
    expect(result.effects).toEqual([
      { type: 'RunGoalTrial', goalId: 'day-shape:17', predictionKind: 'day-ending', forecaster: 'day-shape', cell: '17', variable: 'weekend' },
    ]);
  });

  it('drops an unusable reply without retrying — one bad answer costs one call, not the cap', () => {
    const state = withGaps([gap()], [proposed()]);
    for (const text of ['no json here', '{"variable": "vibes", "because": "?"}', '{"because": "missing"}']) {
      const result = researchGoals(state, llmResult(text));
      expect(result.state).toBe(state);
      expect(result.effects).toEqual([]);
    }
  });

  it('closes LEARNED on an accepted trial, quoting per-arm rates — never totals', () => {
    const withHypothesis = proposed({ hypothesis: { variable: 'weekend', because: 'workday pattern', proposedAt: '2026-07-01T10:05:00.000Z' } });
    const result = researchGoals(withGaps([gap()], [withHypothesis]), trialResult());
    const [goal] = result.state.mind.goals;

    expect(goal.outcome).toBe('learned');
    // `newObservations` travels with the verdict — DESIGN.md's rule that a
    // verdict word carries the evidence it rests on, made structural.
    expect(goal.finding).toEqual({ variable: 'weekend', gain: 0.31, arms: { when: { n: 5, hits: 4 }, otherwise: { n: 8, hits: 0 } }, newObservations: 13 });

    const emitted = result.effects[0];
    expect(emitted.type).toBe('EmitEvent');
    const candidate = emitted.type === 'EmitEvent' ? (emitted.event.payload as Record<string, unknown>) : {};
    expect(candidate.shape).toBe('self-report');
    // Total description-length saved: gain × n — the unit the MDL bar is
    // expressed in, so an accepted finding always clears the tonic threshold.
    expect(candidate.surprise).toBeCloseTo(0.31 * 13, 5);
    expect(String(candidate.observation)).toContain('4 of 5');
    expect(String(candidate.observation)).toContain('0 of 8');
  });

  it('spends the variable on a rejected trial and lets the next tick ask for one more', () => {
    const withHypothesis = proposed({ hypothesis: { variable: 'weekend', because: 'workday pattern', proposedAt: '2026-07-01T10:05:00.000Z' } });
    const rejected = researchGoals(withGaps([gap()], [withHypothesis]), trialResult({ accepted: false }));
    const [goal] = rejected.state.mind.goals;

    expect(goal.closedAt).toBeNull();
    expect(goal.hypothesis).toBeNull();
    expect(goal.tried).toEqual(['weekend']);
    expect(rejected.effects).toEqual([]);

    // The next tick re-proposes, and the menu excludes the spent variable.
    const reproposed = researchGoals(rejected.state, tick('2026-07-01T10:07:00.000Z'));
    const proposal = reproposed.effects.find((effect) => effect.type === 'ScheduleLLM');
    expect(proposal).toBeDefined();
    if (proposal?.type === 'ScheduleLLM') {
      const menuText = proposal.messages.map((message) => message.content).join('\n');
      expect(menuText).not.toContain('- weekend:');
      expect(menuText).toContain('- prev-day-ran-late:');
    }
  });

  it('stops proposing after MAX_PROPOSALS variables are spent — no fishing past the menu', () => {
    const exhausted = proposed({ tried: ['weekend', 'prev-day-ran-late'] });
    const result = researchGoals(withGaps([gap()], [{ ...exhausted, proposalRequestedAt: null }]), tick('2026-07-02T10:00:00.000Z'));
    expect(result.effects.filter((effect) => effect.type === 'ScheduleLLM')).toEqual([]);
  });

  it('drops a verdict whose hypothesis was already replaced — what makes the trial safe at-least-once', () => {
    const withOther = proposed({ hypothesis: { variable: 'prev-day-ran-late', because: '', proposedAt: '2026-07-01T10:05:00.000Z' } });
    const state = withGaps([gap()], [withOther]);
    const result = researchGoals(state, trialResult({ variable: 'weekend' }));
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });

  it('does not open a goal on a coin-flip cell the forecaster already bets correctly on', () => {
    // High expected loss (the cell's own entropy), ~zero excess: nothing to learn.
    const state = createInitialState('test-device');
    const seeded = {
      ...state,
      mind: {
        ...state.mind,
        gaps: [{ kind: 'hour-fragmented', forecaster: 'prev-hour-lag', cell: 'prev-frag', label: 'an hour after a fragmented one', n: 70, hits: 35, expectedLoss: 0.69, excessLoss: 0.0003 }],
      },
    };
    const { state: next } = researchGoals(seeded, { id: 't', type: 'clock:tick', ts: '2026-08-03T10:00:00.000Z', payload: {} } as never);
    expect(next.mind.goals.filter((goal) => goal.closedAt === null)).toEqual([]);
  });
});
