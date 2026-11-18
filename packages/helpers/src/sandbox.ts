/**
 * S4: the rig's sandbox. A rig chat (a session the record marks rig: `thread:model {rig: true}`, `state.rigSessions`)
 * may run the daily tools that write the record (a wake-up, a promise, a draft, a job, a rule, a question), so the rig can
 * test that they WORK. Their rows carry the chat's `sessionId`, and the fold keeps them out of everything the owner sees or
 * learns from: `reduce` hands a sandboxed row to the `sandbox` lane only (packages/rules sandbox.ts), which folds it with the
 * same rules into that chat's own copy of their slices (`state.sandbox[sessionId]`), and never into the owner's.
 *
 * Plain structural types, so the plugins (which do not depend on @sundial/kernel) read the same predicate the fold does.
 */

/** The slices a sandbox keeps of its own, in the owner's place: what its tools write, folded by the owner's own rules. */
export const SANDBOX_SLICES = ['loops', 'ownerAsk', 'drafts', 'commitments', 'workbench', 'watch'] as const;

/** The rows a sandboxed tool writes (with the rig chat's `sessionId`), and the taps and job reports that name what it made. */
export const SANDBOX_TYPES: ReadonlySet<string> = new Set([
  'wakeup:scheduled',
  'wakeup:cancelled',
  'commitment:heard',
  'commitment:closed',
  'assistant:draft',
  'draft:closed',
  'work:requested',
  'work:repeat-stopped',
  'work:started',
  'work:shelved',
  'work:closed',
  'work:stop-requested',
  'rule:adopted',
  'rule:paused',
  'rule:resumed',
  'rule:dropped',
  'ask:owner-opened',
  'ask:owner-answered',
]);

/** The Notify channel a sandbox speaks on: one line in its own rig thread, never the gate, the companion, a push or a banner. */
export const SANDBOX_CHANNEL = 'sandbox-notice';

type Item = { id?: unknown; subject?: unknown; kind?: unknown };
/** One sandbox, as far as the predicate reads it. */
export interface SandboxLike {
  loops?: { open?: readonly Item[]; recent?: readonly Item[] };
  drafts?: { recent?: readonly Item[] };
  commitments?: { promises?: readonly Item[]; recentClosed?: readonly Item[] };
  workbench?: { open?: Item | null; queue?: readonly Item[]; recent?: readonly Item[] };
}
export interface SandboxHost extends SandboxLike {
  rigSessions?: Record<string, string>;
  sandbox?: Record<string, SandboxLike>;
}
interface EventLike {
  type: string;
  payload: Record<string, unknown>;
}

/** Whether a chat session is the screen rig's: its run thread set the model with `by: 'rig'` (`rigSessions` folds that). */
export const isRigSession = (state: Pick<SandboxHost, 'rigSessions'> | null | undefined, sessionId: unknown): boolean =>
  typeof sessionId === 'string' && sessionId !== '' && state?.rigSessions?.[sessionId] !== undefined;

const has = (items: readonly Item[] | undefined, id: string, field: 'id' | 'subject' = 'id') => (items ?? []).some((i) => i?.[field] === id);

/** Whether a sandbox made the item a tap or a job report names (by its id; ids are minted per row, so the owner's never match). */
function holds(sb: SandboxLike, event: EventLike): boolean {
  const p = event.payload;
  const id = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  switch (event.type) {
    case 'draft:closed':
      return id('id') !== '' && has(sb.drafts?.recent, id('id'));
    case 'commitment:closed':
      return id('id') !== '' && (has(sb.commitments?.promises, id('id')) || has(sb.commitments?.recentClosed, id('id')));
    case 'ask:owner-answered':
      return id('askId') !== '' && [...(sb.loops?.open ?? []), ...(sb.loops?.recent ?? [])].some((l) => l?.kind === 'owner-ask' && l.subject === id('askId'));
    case 'work:started':
    case 'work:shelved':
    case 'work:closed':
    case 'work:stop-requested': {
      const job = id('jobId');
      const wb = sb.workbench;
      return job !== '' && (wb?.open?.id === job || has(wb?.queue, job) || has(wb?.recent, job));
    }
    default:
      return false;
  }
}

/**
 * THE predicate: the rig chat whose sandbox `event` belongs to, or null when it is the owner's. A row is sandboxed when
 * it carries the sandbox mark of a rig chat (what the lane itself emits, the work loop's reports on a sandbox job, and the
 * delivery of its lines), or is one of the sandboxed tools' rows with a rig chat's `sessionId`, or is a tap naming an item
 * one sandbox made and the owner's own record does not hold (the draft card's Dismiss, an answer to the sandbox's question):
 * an id both hold is the owner's. A rule id is chosen, not minted, so a `rule:*` row without a rig `sessionId` is always
 * the owner's.
 */
export function sandboxOf(state: SandboxHost | null | undefined, event: EventLike): string | null {
  const p = event.payload ?? {};
  if (typeof p.sandbox === 'string' && isRigSession(state, p.sandbox)) return p.sandbox;
  if (!SANDBOX_TYPES.has(event.type)) return null;
  if (isRigSession(state, p.sessionId)) return p.sessionId as string;
  if (!state || holds(state, event)) return null;
  for (const [sessionId, sb] of Object.entries(state?.sandbox ?? {})) if (holds(sb, event)) return sessionId;
  return null;
}

export const sandboxed = (state: SandboxHost | null | undefined, event: EventLike): boolean => sandboxOf(state, event) !== null;

/**
 * What a tool in `sessionId` reads: in a rig chat with a live sandbox, the owner's state with that sandbox's slices in
 * their place (its own open question, jobs, rules); null anywhere else (the owner's chat reads the state as it is).
 */
export function sandboxView<S extends SandboxHost>(state: S | null | undefined, sessionId: unknown): S | null {
  if (!isRigSession(state, sessionId)) return null;
  const sb = state?.sandbox?.[sessionId as string];
  return sb ? ({ ...state, ...sb } as S) : null;
}

/**
 * Whether a stored row is a rig chat's: its `sessionId`, `session` or sandbox mark names one. The owner's recall tools
 * (gnomon_signals, gnomon_timeline, gnomon_did_i, a rule's backtest) drop such rows: they are the rig's tests, not the owner's day.
 */
export const rigRow = (state: Pick<SandboxHost, 'rigSessions'> | null | undefined, data: Record<string, unknown> | null | undefined): boolean =>
  [data?.sessionId, data?.session, data?.sandbox].some((v) => isRigSession(state, v));
