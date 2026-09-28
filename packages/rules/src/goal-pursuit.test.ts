import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { activeGoals, goalPursuit, STEP_ACCOMPLISHED_DEFAULT_THRESHOLD } from './goal-pursuit.js';
import { workbench } from './workbench.js';

const TS = '2026-09-27T22:00:00.000Z'; // Monday 00:00 Amsterdam
const ev = (type: string, payload: Record<string, unknown> = {}, id = 'e1', ts = TS): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });
const withActive = (state: KernelState): KernelState => ({ ...state, config: { ...state.config, timezone: 'Europe/Amsterdam' }, memory: { ...state.memory, factCursor: { 'goal:jarvis:status': { object: 'active — work like Jarvis' }, 'goal:sleep:status': { object: 'open' } } as never } });
const emitted = (effects: Effect[]) => effects.filter((e) => e.type === 'EmitEvent').map((e) => (e as Extract<Effect, { type: 'EmitEvent' }>).event);

describe('goalPursuit (J5.3)', () => {
  it('plans only ACTIVE goals, on the Monday boundary or when the owner asks', () => {
    const state = withActive(createInitialState('d1'));
    expect(activeGoals(state).map((g) => g.entityId)).toEqual(['goal:jarvis']);
    const monday = goalPursuit(state, ev('day:boundary'));
    expect(monday.effects).toEqual([{ type: 'RunGoalPlan', goalId: 'goal:jarvis', goalName: 'jarvis — work like Jarvis', progress: [], ts: TS }]);
    expect(goalPursuit(state, ev('day:boundary', {}, 'e2', '2026-09-28T22:00:00.000Z')).effects).toEqual([]);
    expect(goalPursuit(state, ev('goal:pursue', { goalId: 'goal:sleep' })).effects).toEqual([]);
    expect(goalPursuit(state, ev('goal:pursue', { goalId: 'goal:jarvis' })).effects).toHaveLength(1);
  });

  it('a plan queues the first internal step as a job, proposes the outward ones, grades each result, and reports at the end', () => {
    let state = withActive(createInitialState('d1'));
    const planned = goalPursuit(state, ev('goal:planned', { goalId: 'goal:jarvis', goalName: 'Jarvis', steps: [{ text: 'List last week\'s useful notices', outward: false }, { text: 'Email Alex about the demo', outward: true }, { text: 'Summarise the tournament', outward: false }] }));
    state = planned.state;
    const plan = state.goals.pursuit!['goal:jarvis'];
    expect(plan.steps.map((s) => s.status)).toEqual(['running', 'asked', 'todo']);
    const events = emitted(planned.effects);
    expect(events.map((e) => e.type)).toEqual(['assistant:proposal', 'work:requested']);
    expect(events[1].payload).toMatchObject({ subject: "List last week's useful notices", goalId: 'goal:jarvis', stepId: 's0' });

    // The workbench opens the job with the goal in its detail.
    state = workbench(state, { ...events[1], sanitized: true } as SanitizedEvent).state;
    expect(state.workbench.open).toMatchObject({ kind: 'owner-request', detail: { goalId: 'goal:jarvis', stepId: 's0' } });

    // The result lands: goalPursuit (folding before workbench) asks the judge.
    const shelved = goalPursuit(state, ev('work:shelved', { jobId: state.workbench.open!.id, title: 'Useful notices', body: 'Three notices…' }, 'e3'));
    const judge = shelved.effects.find((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }>;
    expect(judge).toMatchObject({ questionSetId: 'grade-step', metadata: { goalId: 'goal:jarvis', stepId: 's0' } });
    state = shelved.state;

    // Graded above θ: done, and the next internal step is requested.
    const graded = goalPursuit(state, ev('judgement:result', { purpose: 'judge', questionSetId: 'grade-step', momentId: null, answers: { accomplished: { type: 'noul', noul: STEP_ACCOMPLISHED_DEFAULT_THRESHOLD + 0.1 } }, model: 'm', latencyMs: 1, metadata: { goalId: 'goal:jarvis', stepId: 's0' } }, 'e4'));
    state = graded.state;
    expect(state.goals.pursuit!['goal:jarvis'].steps.map((s) => s.status)).toEqual(['done', 'asked', 'running']);
    expect(emitted(graded.effects)[0].payload).toMatchObject({ stepId: 's2' });

    // The last step fails outright: the report is written.
    state = { ...state, workbench: { ...state.workbench, open: { id: 'job2', kind: 'owner-request', key: 'k', subject: 's', reason: 'r', detail: { goalId: 'goal:jarvis', stepId: 's2' }, openedAt: TS } } };
    const closed = goalPursuit(state, ev('work:closed', { jobId: 'job2', outcome: 'failed' }, 'e5'));
    const reportRow = closed.effects.find((e) => e.type === 'WriteDB') as Extract<Effect, { type: 'WriteDB'; table: 'knowledge_entries' }>;
    expect(reportRow.row).toMatchObject({ kind: 'goal-report', title: 'Goal week: Jarvis — 1 of 3 steps done' });
    expect(reportRow.row.body).toContain('[outward → proposed to you] Email Alex');
    expect(closed.state.goals.pursuit!['goal:jarvis'].reportedAt).toBe(TS);
  });
});
