// The nightly conversation pass, executor half: the window's chat turns, read in
// chunks, one paced and retried `extract` call each, the candidates filed through
// the `entity:fact-candidate` door. The pure half (prompt, chunks, dating) is
// packages/rules/src/conversation-extract.ts.
import { createEventId } from '@sundial/helpers/event-id.js';
import { isRigSession } from '@sundial/kernel/read/rig-session.js';
import type { KernelState, RunConversationExtractionEffect } from '@sundial/kernel/types.js';
import { auditIdOf, LlmHttpError, runAuditedLlmCall } from '@sundial/llm/index.js';
import { canonicalizeConversationCandidate, conversationExtractionInstructions, factInstant, MAX_CONVERSATION_FACTS, MIN_TURN_CHARS, type ConversationTurn, type TranscriptChunk } from '@sundial/rules/conversation-extract.js';
import { slugifyEntityName } from '@sundial/rules/entity-extract.js';
import { parseExtractedFactCandidates, type ExtractedFactCandidate } from '@sundial/rules/nightly-fact-extract.js';

export interface ConversationPassHost {
  state(): KernelState | null;
  stopped(): boolean;
  /** One `extract` reservation off the lane: waits for a route slot and out a 429's cooldown; null when the budget is spent. */
  reserve(): Promise<string | null>;
  ingest(event: { id: string; type: string; ts: string; payload: Record<string, unknown> }): Promise<void>;
  withPersona(text: string): string;
}

/** Tries per chunk (the first and two more), and their backoff, as the executor's other model calls. */
const MAX_ATTEMPTS = 3;
const BASE_MS = 1000;
const MAX_MS = 30_000;

/**
 * The window's turns: the log's own `chat:owner` rows, sanitized at ingest like
 * every signal, so a replay reads the same rows and nothing is redacted twice.
 * With `replies` (`memory.extractReplies`), Gnomon's own `chat:said` rows too, marked.
 */
export function conversationTurns(rows: { eventType: string; capturedAt: string; data: Record<string, unknown> }[], state: KernelState | null): ConversationTurn[] {
  return rows
    .map((row): ConversationTurn => ({ sessionId: String(row.data.sessionId ?? ''), at: row.capturedAt, text: String(row.data.text ?? '').trim(), ...(row.eventType === 'said' ? { by: 'gnomon' as const } : {}) }))
    .filter((turn) => turn.text.length >= MIN_TURN_CHARS && !isRigSession(state, turn.sessionId)); // Round 4: never the rig's test chats
}

/**
 * One `extract` call over one chunk. Reserved off the lane, so it waits its
 * turn instead of passing the route's cap (the first LongMemEval run fired about
 * eleven at once). A 429 or a 5xx is tried again with backoff, each try its own
 * reservation and ledger row chained to the last; before, one 429 lost the
 * day's facts at attempt 1. Null when the budget is spent or every try failed.
 */
export async function extractChunk(host: ConversationPassHost, ownerName: string, chunk: TranscriptChunk): Promise<ExtractedFactCandidate[] | null> {
  let parentCallId: string | null = null;
  for (let attempt = 1; ; attempt++) {
    if (host.stopped()) return null;
    const callId = await host.reserve();
    if (!callId) return null;
    try {
      const result = await runAuditedLlmCall({
        purpose: 'extract',
        momentId: null,
        callId,
        attempt,
        parentCallId,
        messages: [
          { role: 'system', content: host.withPersona(conversationExtractionInstructions(ownerName)) },
          { role: 'user', content: chunk.text },
        ],
      });
      return parseExtractedFactCandidates(result.content, MAX_CONVERSATION_FACTS);
    } catch (error) {
      const permanent = !(error instanceof LlmHttpError) || (error.status < 500 && error.status !== 429);
      if (permanent || attempt >= MAX_ATTEMPTS) {
        console.error(`[sundial-kernel] conversation extraction LLM call failed (attempt ${attempt}${permanent ? ', not retried' : ', giving up'}):`, error);
        return null;
      }
      parentCallId = auditIdOf(error) ?? parentCallId;
      const waitMs = (error as LlmHttpError).retryAfterMs ?? Math.min(MAX_MS, BASE_MS * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs).unref());
    }
  }
}

/** A chunk's candidates through the `entity:fact-candidate` door, each valid from the day the model dated it (else the chunk's last line). */
export async function fileCandidates(host: ConversationPassHost, effect: RunConversationExtractionEffect, chunk: TranscriptChunk, candidates: ExtractedFactCandidate[]): Promise<void> {
  const ownerAliases = host.state()?.config.ownerAliases ?? [];
  for (const raw of candidates) {
    const candidate = canonicalizeConversationCandidate(raw, ownerAliases);
    if (candidate === null) continue;
    const eventId = createEventId();
    await host.ingest({
      id: eventId,
      type: 'entity:fact-candidate',
      ts: effect.ts,
      payload: {
        entityId: `${candidate.entityKind}:${slugifyEntityName(candidate.canonicalName)}`,
        entityKind: candidate.entityKind,
        canonicalName: candidate.canonicalName,
        predicate: candidate.predicate,
        object: candidate.object,
        confidence: candidate.confidence,
        sourceEventId: eventId,
        projectId: null,
        provenance: 'conversation',
        at: factInstant(chunk, candidate.at),
      },
    });
  }
}
