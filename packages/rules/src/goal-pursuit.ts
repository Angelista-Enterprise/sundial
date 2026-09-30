import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, GoalPlanStep, GoalPursuit, JudgementResultPayload, KernelState, Rule } from '@sundial/kernel/types.js';
import { goalLabel, openGoals } from './goal-checkin.js';
import { THRESHOLD_MIN_N } from './judgement-track.js';
import { questionId } from './questions/index.js';
import { GRADE_STEP_QUESTIONS, accomplishedOf, gradeStep } from './questions/grade-step.js';

/** A step is accomplished at this noul until the question earns its own (n ≥ 20). */
export const STEP_ACCOMPLISHED_DEFAULT_THRESHOLD = 0.6;
const WEEK_MS = 7 * 86_400_000;
const MAX_STEPS = 5;

/** Goals the owner marked ACTIVE (status starts with "active"): the only ones pursued (docs/jarvis/05, L6). */
export function activeGoals(state: KernelState): { entityId: string; name: string; status: string }[] {
  return openGoals(state.memory.factCursor).filter((g) => /^active\b/i.test(g.status.trim()));
}

function localWeekday(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date(iso));
  }
}

/** The next internal step not yet run, or null. */
const nextStep = (p: GoalPursuit): GoalPlanStep | null => p.steps.find((s) => !s.outward && s.status === 'todo') ?? null;

function requestStep(goalId: string, goalName: string, step: GoalPlanStep, ts: string, eventId: string): Effect {
  return {
    type: 'EmitEvent',
    event: {
      id: deriveId(ts, eventId, 'goal-step', `${goalId}:${step.id}`),
      type: 'work:requested',
      ts,
      payload: {
        subject: step.text.slice(0, 140),
        brief: `A step toward the owner's goal "${goalName}": ${step.text} Read the record, do the step, and shelve the result as the step asks — a list, a brief, a note. Do nothing outward: no sending, no posting, no writes outside Gnomon's own shelf.`,
        goalId,
        stepId: step.id,
      },
    },
  };
}

function report(goalId: string, p: GoalPursuit, ts: string, eventId: string): Effect {
  const line = (s: GoalPlanStep) => `- ${s.outward ? '[outward → proposed to you] ' : ''}${s.text} — ${s.status}${typeof s.grade === 'number' ? ` (graded ${s.grade.toFixed(2)})` : ''}${s.resultTitle ? ` · "${s.resultTitle}"` : ''}`;
  const done = p.steps.filter((s) => s.status === 'done').length;
  return {
    type: 'WriteDB',
    table: 'knowledge_entries',
    row: {
      id: deriveId(ts, eventId, 'goal-report', goalId),
      kind: 'goal-report',
      title: `Goal week: ${p.goalName} — ${done} of ${p.steps.length} steps done`,
      body: `Planned ${p.plannedAt.slice(0, 10)}. Internal steps ran as background jobs and were graded by the judge; outward steps were put to you as proposals and never run.\n\n${p.steps.map(line).join('\n')}`,
      severity: null,
      dedupeKey: `goal-report:${goalId}:${p.plannedAt.slice(0, 10)}`,
      sourceEventId: eventId,
      createdAt: ts,
      importanceScore: 6,
    },
  };
}

/**
 * J5.3 — goal pursuit, L6. For a goal the owner marked ACTIVE: once a week (the Monday boundary) a
 * plan (`RunGoalPlan`, the tier-3 text model, on demand), whose internal steps
 * run one at a time as dsh agent jobs through the workbench (`work:requested`
 * with `goalId`/`stepId`), each result graded by the judge (`grade-step`),
 * and a report on the shelf when the last step is terminal. Outward steps
 * never run: they become proposals for the owner (L4). Must fold BEFORE
 * `workbench`: it reads `state.workbench.open` on `work:shelved` / `work:closed`
 * for the job's `goalId`, which `workbench` clears on the same event.
 */
export const goalPursuit: Rule = (state, event) => {
  const pursuit = state.goals.pursuit ?? {};
  const withPursuit = (next: Record<string, GoalPursuit>): KernelState => ({ ...state, goals: { ...state.goals, pursuit: next } });

  // W6 P17: `goal:pursue` (the owner asking for a plan now) had no producer, so its branch went;
  // a goal is planned on the Monday boundary, once a week.
  if (event.type === 'day:boundary') {
    if (localWeekday(event.ts, state.config.timezone) !== 'Monday') return { state, effects: [] };
    const effects: Effect[] = [];
    for (const goal of activeGoals(state)) {
      const current = pursuit[goal.entityId];
      if (current && Date.parse(event.ts) - Date.parse(current.plannedAt) < WEEK_MS) continue;
      effects.push({ type: 'RunGoalPlan', goalId: goal.entityId, goalName: goalLabel(goal), progress: (state.goals.progress[goal.entityId] ?? []).slice(-10).map((e) => e.momentId), ts: event.ts });
    }
    return { state, effects };
  }

  if (event.type === 'goal:planned') {
    const p = event.payload as { goalId?: unknown; goalName?: unknown; steps?: unknown };
    if (typeof p.goalId !== 'string' || !Array.isArray(p.steps)) return { state, effects: [] };
    const steps: GoalPlanStep[] = p.steps
      .filter((s): s is { text: string; outward?: unknown } => typeof s === 'object' && s !== null && typeof (s as { text?: unknown }).text === 'string' && (s as { text: string }).text.trim() !== '')
      .slice(0, MAX_STEPS)
      .map((s, i) => ({ id: `s${i}`, text: s.text.trim().slice(0, 300), outward: s.outward === true, status: s.outward === true ? 'asked' : 'todo' }));
    if (steps.length === 0) return { state, effects: [] };
    const plan: GoalPursuit = { goalName: typeof p.goalName === 'string' ? p.goalName : p.goalId, plannedAt: event.ts, steps, reportedAt: null };
    const effects: Effect[] = [];
    // Outward steps are the owner's: one proposal each, never a job.
    for (const step of steps.filter((s) => s.outward)) effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'goal-step-ask', step.id), type: 'assistant:proposal', ts: event.ts, payload: { summary: `For "${plan.goalName}": ${step.text}`, kind: 'goal-step' } } });
    const first = nextStep(plan);
    if (first) {
      first.status = 'running';
      effects.push(requestStep(p.goalId, plan.goalName, first, event.ts, event.id));
    }
    const next = { ...pursuit, [p.goalId]: plan };
    if (!first) effects.push(report(p.goalId, plan, event.ts, event.id));
    return { state: withPursuit(!first ? { ...next, [p.goalId]: { ...plan, reportedAt: event.ts } } : next), effects };
  }

  if (event.type === 'work:shelved' || event.type === 'work:closed') {
    const open = state.workbench.open;
    const payload = event.payload as { jobId?: unknown; title?: unknown; body?: unknown };
    if (!open || open.id !== payload.jobId) return { state, effects: [] };
    const goalId = typeof open.detail.goalId === 'string' ? open.detail.goalId : null;
    const stepId = typeof open.detail.stepId === 'string' ? open.detail.stepId : null;
    if (!goalId || !stepId || !pursuit[goalId]) return { state, effects: [] };
    const plan = pursuit[goalId];
    if (event.type === 'work:closed') return advance(state, pursuit, goalId, { ...plan, steps: plan.steps.map((s) => (s.id === stepId ? { ...s, status: 'failed' } : s)) }, event.ts, event.id);
    const title = typeof payload.title === 'string' ? payload.title : '';
    const body = typeof payload.body === 'string' ? payload.body : '';
    const built = gradeStep.build({ goal: plan.goalName, step: plan.steps.find((s) => s.id === stepId)?.text ?? '', resultTitle: title, resultBody: body });
    return {
      state: withPursuit({ ...pursuit, [goalId]: { ...plan, steps: plan.steps.map((s) => (s.id === stepId ? { ...s, resultTitle: title.slice(0, 140) } : s)) } }),
      effects: [{ type: 'Judge', purpose: 'judge', questionSetId: gradeStep.id, momentId: null, delayMs: 0, state: built.state, questions: built.questions, metadata: { goalId, stepId, artifactId: `${goalId}:${stepId}` } }],
    };
  }

  if (event.type === 'judgement:result') {
    const payload = event.payload as unknown as JudgementResultPayload;
    if (payload.questionSetId !== gradeStep.id) return { state, effects: [] };
    const goalId = payload.metadata?.goalId;
    const stepId = payload.metadata?.stepId;
    if (typeof goalId !== 'string' || typeof stepId !== 'string' || !pursuit[goalId]) return { state, effects: [] };
    const grade = accomplishedOf(payload.answers ?? {});
    if (grade === null) return { state, effects: [] };
    const record = state.judgement.questions[questionId(GRADE_STEP_QUESTIONS.accomplished)];
    const threshold = record && record.n >= THRESHOLD_MIN_N ? record.threshold : STEP_ACCOMPLISHED_DEFAULT_THRESHOLD;
    const plan = pursuit[goalId];
    return advance(state, pursuit, goalId, { ...plan, steps: plan.steps.map((s) => (s.id === stepId ? { ...s, grade, status: grade >= threshold ? 'done' : 'failed' } : s)) }, event.ts, event.id);
  }

  return { state, effects: [] };
};

/** Queue the next internal step, or write the report when none is left. */
function advance(state: KernelState, pursuit: Record<string, GoalPursuit>, goalId: string, plan: GoalPursuit, ts: string, eventId: string): ReturnType<Rule> {
  const following = nextStep(plan);
  if (following) {
    const steps = plan.steps.map((s) => (s.id === following.id ? { ...s, status: 'running' as const } : s));
    return { state: { ...state, goals: { ...state.goals, pursuit: { ...pursuit, [goalId]: { ...plan, steps } } } }, effects: [requestStep(goalId, plan.goalName, following, ts, eventId)] };
  }
  const reported = { ...plan, reportedAt: ts };
  return { state: { ...state, goals: { ...state.goals, pursuit: { ...pursuit, [goalId]: reported } } }, effects: [report(goalId, reported, ts, eventId)] };
}
