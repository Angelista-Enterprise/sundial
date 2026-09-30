// W2 migrations: what used to be three slices (`wakeups.open`, `ownerAsk.open`, `assistant.recent`)
// is one kind each in `state.loops`, read through these. Loosely typed on purpose: the plugins that
// read them (sundial-actions, the theme) do not all depend on `@sundial/kernel`.

export interface LoopLike {
  id: string;
  kind: string;
  subject: string;
  about: string;
  openedAt: string;
  expiresAt: string;
  status: string;
  detail?: Record<string, unknown>;
}

interface WithLoops {
  loops?: { open?: LoopLike[]; recent?: LoopLike[] };
}

/** The open loops of one kind, in the order they opened. */
export const loopsOf = (state: WithLoops | null | undefined, kind: string): LoopLike[] => (state?.loops?.open ?? []).filter((l) => l.kind === kind);

/** M1: the armed wake-ups, in the shape `wakeups.open` had. A wake-up's `expiresAt` is its due time: it fires, it never expires. */
export const wakeupsOf = (state: WithLoops | null | undefined): { key: string; at: string; reason: string; scheduledAt: string }[] =>
  loopsOf(state, 'wakeup').map((l) => ({ key: l.subject, at: l.expiresAt, reason: l.about, scheduledAt: l.openedAt }));

/** Closed loops kept, per kind: enough to show this week's proposals, not a second log. */
export const MAX_RECENT_LOOPS = 20;

/** A loop leaves `open` for `recent`, which keeps the newest `MAX_RECENT_LOOPS` of each kind. */
export function closeLoop<L extends { id: string; kind: string }, S extends { open: L[]; recent: L[] }>(loops: S, loop: L): S {
  const recent = [...loops.recent.filter((l) => l.id !== loop.id), loop];
  const extra = recent.filter((l) => l.kind === loop.kind).length - MAX_RECENT_LOOPS;
  const drop = new Set(recent.filter((l) => l.kind === loop.kind).slice(0, Math.max(0, extra)));
  return { ...loops, open: loops.open.filter((l) => l.id !== loop.id), recent: recent.filter((l) => !drop.has(l)) };
}

/** M2: every proposal, open and closed, in the shape `assistant.recent` had. */
export const proposalsOf = (state: WithLoops | null | undefined): { id: string; summary: string; kind: string; outcome: string; at: string; resolvedAt: string | null }[] =>
  [...(state?.loops?.recent ?? []), ...(state?.loops?.open ?? [])]
    .filter((l) => l.kind === 'proposal')
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
    .map((l) => ({ id: l.subject, summary: l.about, kind: String(l.detail?.kind ?? 'unknown'), outcome: l.status === 'open' || l.status === 'unsaid' ? 'open' : String(l.detail?.outcome ?? 'open'), at: l.openedAt, resolvedAt: typeof l.detail?.resolvedAt === 'string' ? l.detail.resolvedAt : null }));

/** M3: the question Gnomon is waiting on, in the shape `ownerAsk.open` had. */
export interface AskLike {
  askId: string;
  question: string;
  reason: string;
  choices: string[];
  ts: string;
  waiting?: boolean;
}

const ASK_TTL_MS = 24 * 60 * 60 * 1000;

/** An ask as an `owner-ask` loop: `subject` is its id, `about` its question; what a loop has no field for rides in `detail`. */
export const askLoop = (ask: AskLike, openedBy?: string) => ({
  id: ask.askId,
  origin: 'tool' as const,
  kind: 'owner-ask',
  subject: ask.askId,
  about: ask.question,
  resolve: { when: { type: 'ask:owner-answered', where: [{ field: 'askId', op: 'eq' as const, value: ask.askId }] } },
  seen: {},
  target: { sessionId: null },
  openedAt: ask.ts,
  expiresAt: new Date(Date.parse(ask.ts) + ASK_TTL_MS).toISOString(),
  status: 'open' as const,
  detail: { reason: ask.reason, choices: ask.choices, ...(ask.waiting ? { waiting: true } : {}), ...(openedBy === undefined ? {} : { openedBy }) },
});

export const askOf = (l: LoopLike): AskLike => ({
  askId: l.subject,
  question: l.about,
  reason: typeof l.detail?.reason === 'string' ? l.detail.reason : '',
  choices: Array.isArray(l.detail?.choices) ? (l.detail.choices as string[]) : [],
  ts: l.openedAt,
  ...(l.detail?.waiting === true ? { waiting: true } : {}),
});

/** The one open question (one at a time, as ever), or null. */
export const openAsk = (state: WithLoops | null | undefined): AskLike | null => {
  const loop = loopsOf(state, 'owner-ask')[0];
  return loop === undefined ? null : askOf(loop);
};
