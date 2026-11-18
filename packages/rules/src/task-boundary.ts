import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import { isRigSession } from '@sundial/helpers/sandbox.js';
import { TASK_OUTCOMES, type TaskOutcome, allTasks, recoverable, taskOf } from '@sundial/helpers/task-of.js';
import type { ChatTask, KernelState, Rule } from '@sundial/kernel/types.js';

/**
 * Where one task ends and the next begins (`task:started`, appended when the owner's words arrive).
 *
 * Sundial had no such mark. The screen tools therefore guessed: their own comment said "a minute stands
 * in for a new task, which the tools cannot see". Run 14 showed the cost of guessing — the routes for an
 * app went untold inside a task, and the route learner could not tell the owner's work from Gnomon's own
 * tidying up, so it taught back "restore the search field" as that app's best route.
 *
 * One id and one time is the whole fact. Everything that wants to say "this task" keys on it: routes
 * told once per task, a step learned as work or as tidying, and anything later that needs to know how
 * far along the task is.
 *
 * Set 4 R1: the task object. The same rule folds the task's own steps, from its chat only, into four short lists
 * (`known`, `did`, `failed`, `open`), the newest `TASK_KEEP` each. Set 2 R3's bench (lab/screen-rig/review/task-bench.mjs)
 * replayed 81 known-good steps of runs 207 to 210: the chat with these lists in place of the earlier steps was 0.57x the
 * prompt tokens. The brief and the chat adapter print it (turn-brief.ts `taskLines`); a failed step is the line a reply
 * names when it says what was done instead.
 *
 * Set 5 R1: one task per chat. `state.task` was one object for the whole system, so a second chat's request replaced the main
 * task. Each chat's task is now `state.tasks[session]` (`task:started`, and a side thread's `task:aside`); `state.task` stays the
 * newest request, the same object as its chat's. The rule also folds how a turn ended (`task:ended`) and the finish nudge
 * (`task:nudged`), both written on dsh's turn hooks by the chat adapter (plugins/sundial-llm-openai/task-end.js).
 */
export const TASK_KEEP = 12;
/**
 * The chats whose task is kept: the newest by start, the owner's and the rig's each (Review S5R1 L1: a bench of eight rig chats
 * pushed the owner's task out). A ninth of either drops that side's oldest.
 */
export const TASKS_KEEP = 8;
const LINE = 140;

type Task = ChatTask;
type List = 'known' | 'did' | 'failed' | 'open';

const str = (v: unknown, n = 80) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, n) : '');
/**
 * Cut first, then compared: a line kept cut is the same line when it comes again (Fable L1). A failed line the model may not be
 * pushed past marks the task `guarded`, for good (Review S5R1: the newest `TASK_KEEP` lines alone let it scroll out).
 */
const add = (task: Task, list: List, line: string, same?: (l: string) => boolean): Task => {
  const cut = line.slice(0, LINE);
  const newest = list === 'did' || list === 'failed' ? { newest: list } : {};
  const guarded = list === 'failed' && !recoverable(cut) ? { guarded: true as const } : {};
  return { ...task, ...newest, ...guarded, [list]: [...(task[list] ?? []).filter((l) => l !== cut && !(same?.(l) ?? false)), cut].slice(-TASK_KEEP) };
};
const drop = (task: Task, list: List, has: string): Task => ({ ...task, [list]: (task[list] ?? []).filter((l) => !l.includes(has)) });

/** One step of this task's chat as its line, or the task unchanged. */
function folded(state: KernelState, task: Task, type: string, p: Record<string, unknown>): Task {
  const mine = (session: unknown) => task.session !== '' && session === task.session;
  switch (type) {
    case 'screen:step': {
      if (!mine(p.session)) return task;
      const [app, name] = [str(p.processName, 40), str(Array.isArray(p.screenText) ? p.screenText[0] : '', 50)];
      if (!app || isRedactedPlaceholder(app)) return task;
      const step = `${str(p.verb, 20) || 'step'}${name && !isRedactedPlaceholder(name) ? ` "${name}"` : ''} in ${app}`;
      if (p.ok === false) return add(task, 'failed', `${step}: refused, ${str(p.reason, 40) || 'unknown'}`);
      const then = str((p.then as { windowTitle?: unknown } | undefined)?.windowTitle, 50);
      return add(task, 'did', `${step}${then && !isRedactedPlaceholder(then) ? `, then window "${then}"` : ''}`);
    }
    case 'screen:looked': {
      // A look carries no chat; `screen:asked` (privateReads) said which chat asked for it.
      const asked = state.privateReads?.asked ?? {};
      if (!mine(asked[str(p.id)] ?? asked[str(p.after)])) return task;
      const app = str(p.processName, 40);
      const window = str(p.windowTitle, 50);
      if (!app) return task;
      if ([app, window].some((x) => x !== '' && isRedactedPlaceholder(x))) return add(task, 'failed', 'look at a private app: refused');
      if (typeof p.refused === 'string') return add(task, 'failed', `look at ${app}: refused, ${str(p.refused, 40)}`);
      // One line per app: the newest look at it.
      const n = typeof p.n === 'number' ? p.n : Array.isArray(p.elements) ? p.elements.length : 0;
      return add(task, 'known', `${app}${window ? ` window "${window}"` : ''}: ${n} things on screen`, (l) => l.startsWith(`${app} window `) || l.startsWith(`${app}: `));
    }
    case 'shell:started': {
      if (!mine(p.session)) return task;
      // run-shell.js gives a refusal its reason (a fixed line of its own); a run that could not start has none.
      if (p.failed === true) return add(task, 'failed', `a shell command: ${str(p.reason, 90) ? `refused, ${str(p.reason, 90)}` : 'refused or could not start'}`);
      const job = str(p.jobId, 40);
      return job ? add(task, 'open', `${job} running: gnomon_await it`) : task;
    }
    case 'shell:command': {
      // A command gnomon_run_shell waited for: the hook entry carries its chat (shell-hook.ts `s`). A zero exit is not news.
      if (!mine(p.session) || typeof p.exitCode !== 'number' || p.exitCode === 0) return task;
      return add(task, 'failed', `shell "${str(p.command, 60)}" exited ${p.exitCode}`);
    }
    case 'shell:exited': {
      const job = str(p.jobId, 40);
      if (!job || !(task.open ?? []).some((l) => l.startsWith(`${job} `))) return task;
      const [code, last] = [typeof p.exitCode === 'number' ? p.exitCode : -1, str(p.lastLine, 70)];
      const ended = drop(task, 'open', `${job} `);
      return code === 0 ? add(ended, 'did', `${job} finished${last ? `: ${last}` : ''}`) : add(ended, 'failed', `${job} exited ${code}${last ? `: ${last}` : ''}`);
    }
    default:
      return task;
  }
}

/** The step rows `folded` reads; any other row passes every task by. */
const STEPS: ReadonlySet<string> = new Set(['screen:step', 'screen:looked', 'shell:started', 'shell:command', 'shell:exited']);

/**
 * `tasks` with these tasks put in, the newest `TASKS_KEEP` by start of the owner's chats and of the rig's; `task` follows its own object (same id) and nothing else.
 * Reads the old single-task shape through `allTasks`, so the first event after an old snapshot writes the keyed shape.
 */
function put(state: KernelState, ...changed: Task[]): KernelState {
  const all = { ...allTasks(state), ...Object.fromEntries(changed.map((t) => [t.session, t])) };
  const newest = Object.values(all).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const side = (rig: boolean) => newest.filter((t) => isRigSession(state, t.session) === rig).slice(0, TASKS_KEEP);
  const tasks = Object.fromEntries([...side(false), ...side(true)].map((t) => [t.session, t]));
  const task = state.task === null ? null : (changed.find((t) => t.id === state.task!.id) ?? state.task);
  return { ...state, task, tasks };
}

const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 240) : '');
const sessionOf = (v: unknown) => (typeof v === 'string' ? v : '');
/** The chat's newest dsh turn when the words arrived (api-sessions.js): the task's turns are the ones above it. */
const afterTurnOf = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? { afterTurn: v } : {});

/** One chat's task, keyed by its session; the newest is also `state.task`. Single writer of `state.task` and `state.tasks`. */
export const taskBoundary: Rule = (state, event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'task:started': {
      const task: Task = { id: event.id, at: event.ts, session: sessionOf(p.sessionId), said: text(p.text), ...afterTurnOf(p.afterTurn) };
      return { state: put({ ...state, task }, task), effects: [] };
    }
    // Set 4 R2: a second question while a task runs gets a side thread of its own (api-sessions.js). Set 5 R1: it is that thread's
    // task, beside its parent's, which it never replaces (`state.task` stays the parent's).
    case 'task:aside': {
      const session = sessionOf(p.sessionId);
      if (session === '') return { state, effects: [] };
      const parent = sessionOf(p.parent);
      return { state: put(state, { id: event.id, at: event.ts, session, said: text(p.text), ...afterTurnOf(p.afterTurn), ...(parent ? { parent } : {}) }), effects: [] };
    }
    // Set 2 R4: the owner's words sent into a chat whose turn is still running correct the task, they do not start one. The screen
    // tools stop a chain on it (owner-hand.js); the turn itself is told before its next step (api-sessions.js). A row with no chat
    // (older writers) corrects the newest task, as before.
    case 'task:corrected': {
      const session = sessionOf(p.session);
      const task = session === '' ? state.task : taskOf(state, session);
      if (task === null || typeof p.text !== 'string') return { state, effects: [] };
      return { state: put(state, { ...task, corrected: { at: event.ts, session, text: p.text.slice(0, 240) } }), effects: [] };
    }
    // Set 5 R1: the turn got the finish nudge (task-end.js): it is never given twice in a task.
    case 'task:nudged': {
      const task = taskOf(state, p.sessionId);
      return task === null ? { state, effects: [] } : { state: put(state, { ...task, nudged: event.ts }), effects: [] };
    }
    // Set 5 R1: how the chat's turn ended (task-end.js, on dsh's `turn/end`): the newest turn's outcome. Review S5R1 L2: a row for
    // another task of the chat (a stale turn that ended after the next request began) is not this task's; a row with no id is older.
    case 'task:ended': {
      const task = taskOf(state, p.sessionId);
      if (task === null || (typeof p.taskId === 'string' && p.taskId !== task.id) || typeof p.outcome !== 'string' || !TASK_OUTCOMES.has(p.outcome)) return { state, effects: [] };
      return { state: put(state, { ...task, ended: { at: event.ts, outcome: p.outcome as TaskOutcome } }), effects: [] };
    }
  }
  if (!STEPS.has(event.type)) return { state, effects: [] };
  const changed = Object.values(allTasks(state)).flatMap((task) => {
    const next = folded(state, task, event.type, p);
    return next === task ? [] : [next];
  });
  return changed.length === 0 ? { state, effects: [] } : { state: put(state, ...changed), effects: [] };
};
