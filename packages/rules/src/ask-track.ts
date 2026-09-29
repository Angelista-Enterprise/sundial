import { deriveId } from '@sundial/helpers/derive-id.js';
import type { AskThreadEntry, AskThreadRow, Effect, KernelState, Rule } from '@sundial/kernel/types.js';

const MAX_RECENT_THREADS = 30;
/** A remembered answer is the owner's own keep, so it outranks the schema's baseline (5) the way `companionInsight`'s anomaly rows do. */
const REMEMBERED_IMPORTANCE = 7;

interface AskAnsweredPayload {
  threadId?: string;
  question?: string;
  answer?: string | null;
  reason?: string | null;
  sourceCount?: number;
  /** Already-stringified `AskSource[]`, produced by the route — a rule does not serialize. */
  sources?: string | null;
  /** LLM round trips the tool loop took to produce this answer. */
  rounds?: number;
  /** The distinct tools that produced a result, in first-use order. Arrives as an array and is serialized here for storage; see `sources` for why the route does that for `AskSource[]` and this does not — an array of plain strings has no shape to get wrong. */
  toolsUsed?: unknown;
  /** Already-stringified `Figure[]`, produced by the route — a rule does not serialize. */
  figures?: string | null;
}

interface AskRememberedPayload {
  threadId?: string;
  question?: string;
  answer?: string | null;
  sourceCount?: number;
}

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Ask's memory: folds `ask:answered` and `ask:remembered` into `state.ask`, and
 * writes the durable thread.
 *
 * Ask was the one surface with no record at all. A thread lived in the macOS
 * app's `@State` and died with the window, which meant the product could not
 * answer "what have I asked about this before" — and a question is the single
 * most direct signal the owner ever emits about what they want to know, more
 * direct than any window title or commit. Making it an ordinary event folded by
 * an ordinary rule is what puts it in the log beside everything else, rather
 * than in a table with its own writer (the shape the event-sourced kernel exists
 * to prevent).
 *
 * Two events, and the split is the product decision:
 *
 * - `ask:answered` records that a question was asked and what came back. Every
 *   answer is kept as **history**. Nothing about it is retrievable memory yet.
 * - `ask:remembered` is the owner promoting one answer into the knowledgebase:
 *   it writes a `knowledge_entries` row and embeds it, so a later Ask can
 *   actually retrieve it, and it shows up in Memory · Noticed like any other
 *   entry.
 *
 * Promotion is manual today and deliberately so. An LLM answer is model prose
 * about the record, not an observation of it, and auto-indexing every answer
 * would let the system retrieve its own earlier guesses as though they were
 * evidence — the failure already recorded for journals in
 * issues/journal-summarises-model-output-not-evidence (since retired from the
 * almanac), where a summary of
 * generated narrative left no way to correct an upstream misreading. `remembered`
 * plus `sourceCount` are carried in state so a later rule can make that call
 * automatically once there is a measured basis for it; the button is the first
 * version of that policy, not a workaround for its absence.
 *
 * A remember on an already-remembered thread is dropped rather than writing a
 * second entry — `knowledge_entries.dedupeKey` would no-op the insert anyway,
 * but the `Embed` effect beside it would not, and re-embedding the same text is
 * a real (if small) cost paid for nothing.
 */
export const askTrack: Rule = (state, event) => {
  if (event.type === 'ask:answered') {
    const payload = event.payload as AskAnsweredPayload;
    const threadId = trim(payload.threadId);
    const question = trim(payload.question);
    if (!threadId || !question) return { state, effects: [] };

    const answer = trim(payload.answer);
    const sourceCount = Number.isFinite(payload.sourceCount) ? Math.max(0, Math.trunc(payload.sourceCount as number)) : 0;
    // Filtered rather than trusted: this arrives over HTTP, and a rule folding a
    // malformed payload into a row is how a replay starts disagreeing with the
    // daemon that wrote it.
    const toolNames = Array.isArray(payload.toolsUsed) ? payload.toolsUsed.filter((name): name is string => typeof name === 'string' && name.length > 0) : [];

    const entry: AskThreadEntry = {
      id: threadId,
      question,
      askedAt: event.ts,
      answered: answer.length > 0,
      sourceCount,
      remembered: false,
    };

    const row: AskThreadRow = {
      id: threadId,
      question,
      answer: answer.length > 0 ? answer : null,
      reason: trim(payload.reason) || null,
      sourceCount,
      sources: typeof payload.sources === 'string' && payload.sources.length > 0 ? payload.sources : null,
      askedAt: event.ts,
      // Defaults to 1 rather than 0: an answer with no tool calls still took one
      // round trip, and a stored 0 would read as "never dispatched".
      rounds: Number.isFinite(payload.rounds) ? Math.max(1, Math.trunc(payload.rounds as number)) : 1,
      toolsUsed: toolNames.length > 0 ? JSON.stringify(toolNames) : null,
      figures: typeof payload.figures === 'string' && payload.figures.length > 0 ? payload.figures : null,
      remembered: false,
      rememberedAt: null,
      rememberedEntryId: null,
      sourceEventId: event.id,
    };

    const ask: KernelState['ask'] = {
      // Newest last, matching `feedback.recent`/`predictions.recentResolved`.
      // The read side orders for display; a fold does not reverse a list.
      recent: [...state.ask.recent.filter((t) => t.id !== threadId), entry].slice(-MAX_RECENT_THREADS),
      askedCount: state.ask.askedCount + 1,
      rememberedCount: state.ask.rememberedCount,
      lastAskedAt: event.ts,
    };

    return { state: { ...state, ask }, effects: [{ type: 'WriteDB', table: 'ask_threads', row }] };
  }

  if (event.type !== 'ask:remembered') return { state, effects: [] };

  const payload = event.payload as AskRememberedPayload;
  const threadId = trim(payload.threadId);
  const question = trim(payload.question);
  const answer = trim(payload.answer);
  if (!threadId || !question || !answer) return { state, effects: [] };

  const known = state.ask.recent.find((t) => t.id === threadId);
  if (known?.remembered) return { state, effects: [] };

  const entryId = deriveId(event.ts, event.id, 'ask-remembered', threadId);
  const sourceCount = known?.sourceCount ?? (Number.isFinite(payload.sourceCount) ? Math.max(0, Math.trunc(payload.sourceCount as number)) : 0);

  const row: AskThreadRow = {
    id: threadId,
    question,
    answer,
    reason: null,
    sourceCount,
    sources: null,
    // A thread that fell off `recent` before being remembered still has its own
    // row; the upsert only touches the remember columns, so this `askedAt` is
    // never written over the real one. `rounds`/`toolsUsed` are in the same
    // position: carried at their defaults here and preserved by the upsert,
    // since a remember says nothing about how the answer was produced.
    askedAt: known?.askedAt ?? event.ts,
    rounds: 1,
    toolsUsed: null,
    figures: null,
    remembered: true,
    rememberedAt: event.ts,
    rememberedEntryId: entryId,
    sourceEventId: event.id,
  };

  const effects: Effect[] = [
    { type: 'WriteDB', table: 'ask_threads', row },
    {
      type: 'WriteDB',
      table: 'knowledge_entries',
      row: {
        id: entryId,
        kind: 'ask',
        // The question is the title on purpose: it is what the owner wanted to
        // know, and it is what they will recognize the entry by later.
        title: question,
        body: answer,
        severity: null,
        // Keyed on the thread, not the question text — asking the same thing
        // again in three months and keeping that answer too is the point of
        // history, not a duplicate.
        dedupeKey: `ask:${threadId}`,
        sourceEventId: event.id,
        createdAt: event.ts,
        importanceScore: REMEMBERED_IMPORTANCE,
      },
    },
    {
      type: 'Embed',
      id: deriveId(event.ts, event.id, 'ask-remembered-embedding', threadId),
      refType: 'knowledge_entry',
      refId: entryId,
      // Question and answer together: retrieval on the question alone would
      // miss an answer that names something the question did not.
      text: `${question}\n\n${answer}`,
    },
  ];

  const ask: KernelState['ask'] = {
    // `rememberedEntryId` is carried so a later `wrong` verdict on this thread
    // can retract the entry the keep created. Without it the rule would know
    // the answer had been kept but not what to withdraw, and the correction
    // would leave the claim retrievable.
    recent: state.ask.recent.map((t) => (t.id === threadId ? { ...t, remembered: true, rememberedEntryId: entryId } : t)),
    askedCount: state.ask.askedCount,
    rememberedCount: state.ask.rememberedCount + 1,
    lastAskedAt: state.ask.lastAskedAt,
  };

  return { state: { ...state, ask }, effects };
};
