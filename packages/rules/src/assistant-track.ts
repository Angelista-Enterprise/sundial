import { deriveId } from '@sundial/helpers/derive-id.js';
import type { AssistantProposal, KernelState, Rule } from '@sundial/kernel/types.js';

/** Bounded ring of proposals. Enough to answer "what did it suggest this week", not a second log. */
const MAX_RECENT_PROPOSALS = 40;

/** Longest a proposal stays answerable. Past this the owner's silence is the answer. */
const PROPOSAL_TTL_MS = 7 * 86_400_000;

interface ProposalPayload {
  summary?: unknown;
  kind?: unknown;
}

interface ResponsePayload {
  proposalId?: unknown;
  verdict?: unknown;
}

interface ClaimPayload {
  entityKind?: unknown;
  canonicalName?: unknown;
  predicate?: unknown;
  object?: unknown;
  confidence?: unknown;
}

const VALID_ENTITY_KINDS = new Set(['person', 'project', 'tool', 'topic', 'task', 'owner', 'goal']);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Folds what an external assistant did into ordinary state.
 *
 * The write half of [the assistant-as-an-event-source decision](../../../almanac/decisions/assistant-as-an-event-source.md).
 * Until this rule, the boundary was one-way: eleven MCP tools, all queries, and
 * nothing the assistant did could ever enter the log — so a system that could not
 * receive an event about its own output could not learn from it.
 *
 * Three event types, one rule, no new subsystem:
 *
 * - `assistant:proposal` opens a proposal in `state.assistant.recent`. Nothing is
 *   asserted; a proposal is a thing said, not a thing believed.
 * - `assistant:response` closes one with the owner's verdict. The accepted/rejected
 *   tally is the assistant's own outcome record, and it is deliberately kept
 *   separate from `state.feedback` — that slice is the owner's verdict on what
 *   GNOMON produced, and merging the two would make an assistant's bad week read as
 *   Gnomon's.
 * - `assistant:claim` proposes a fact. It emits an ordinary `entity:fact-candidate`
 *   with `provenance: 'assistant'` and stops there.
 *
 * The last one is the load-bearing restriction, and the decision record states it
 * outright: an assistant's claim is a fact CANDIDATE, not a fact. It gets no
 * privileged write to core memory — `contradictionCheck` applies the same promotion
 * policy it applies to a sensor, so a confident assistant still needs corroboration,
 * and only the OWNER's assertion supersedes on one observation. Emitting the
 * candidate rather than an `UpsertEntityFact` is what keeps that true; a rule here
 * that wrote a fact directly would quietly hand an LLM the authority the whole
 * decision withholds.
 *
 * No ordering constraint in `RULE_MANIFEST`: it writes one slice nothing else
 * writes, and the candidate it emits is folded on the next event like any other.
 */
export const assistantTrack: Rule = (state, event) => {
  if (event.type === 'assistant:proposal') {
    const payload = event.payload as ProposalPayload;
    const summary = text(payload.summary);
    if (!summary) return { state, effects: [] };

    const proposal: AssistantProposal = {
      id: deriveId(event.ts, event.id, 'assistant-proposal'),
      summary,
      kind: text(payload.kind) || 'unknown',
      outcome: 'open',
      at: event.ts,
      resolvedAt: null,
    };

    return {
      state: {
        ...state,
        assistant: {
          ...state.assistant,
          recent: [...state.assistant.recent, proposal].slice(-MAX_RECENT_PROPOSALS),
          proposedCount: state.assistant.proposedCount + 1,
          lastAt: event.ts,
        },
      },
      effects: [],
    };
  }

  if (event.type === 'assistant:response') {
    const payload = event.payload as ResponsePayload;
    const proposalId = text(payload.proposalId);
    const verdict = text(payload.verdict);
    if (verdict !== 'accepted' && verdict !== 'rejected') return { state, effects: [] };

    // Resolve the named proposal, or the most recent still-open one within its TTL.
    // The fallback exists because an assistant answering conversationally rarely has
    // the id to hand, and a response that cannot find its proposal would otherwise
    // silently vanish — the failure mode this whole decision exists to remove.
    const nowMs = Date.parse(event.ts);
    const index = proposalId
      ? state.assistant.recent.findIndex((p) => p.id === proposalId)
      : state.assistant.recent.reduce((best, p, i) => (p.outcome === 'open' && nowMs - Date.parse(p.at) <= PROPOSAL_TTL_MS ? i : best), -1);
    if (index < 0) return { state, effects: [] };

    const target = state.assistant.recent[index]!;
    if (target.outcome !== 'open') return { state, effects: [] };

    const recent = [...state.assistant.recent];
    recent[index] = { ...target, outcome: verdict, resolvedAt: event.ts };

    return {
      state: {
        ...state,
        assistant: {
          ...state.assistant,
          recent,
          acceptedCount: state.assistant.acceptedCount + (verdict === 'accepted' ? 1 : 0),
          rejectedCount: state.assistant.rejectedCount + (verdict === 'rejected' ? 1 : 0),
          lastAt: event.ts,
        },
      },
      effects: [],
    };
  }

  if (event.type === 'assistant:claim') {
    const payload = event.payload as ClaimPayload;
    const entityKind = text(payload.entityKind);
    const canonicalName = text(payload.canonicalName);
    const predicate = text(payload.predicate);
    const object = text(payload.object);
    if (!VALID_ENTITY_KINDS.has(entityKind) || !canonicalName || !predicate || !object) return { state, effects: [] };

    // Below an owner assertion's 100 and below a structured sensor reading, and
    // deliberately so: an assistant's claim is a reading of evidence, which is the
    // weakest of the three provenances. `rejectEntityName` still applies downstream,
    // so an assistant naming the owner or a known project as a person is refused on
    // the same terms as a sensor doing it.
    const confidence = typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? Math.max(1, Math.min(99, Math.round(payload.confidence))) : 60;

    return {
      state: { ...state, assistant: { ...state.assistant, claimedCount: state.assistant.claimedCount + 1, lastAt: event.ts } },
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: deriveId(event.ts, event.id, 'assistant-claim'),
            type: 'entity:fact-candidate',
            ts: event.ts,
            payload: {
              entityId: `${entityKind}:${canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
              entityKind,
              canonicalName,
              predicate,
              object,
              confidence,
              sourceEventId: event.id,
              projectId: null,
              // The whole point. An assistant writes through the same door a sensor
              // uses, and `contradictionCheck` treats it as an inference that must
              // corroborate — not as an assertion that supersedes on sight.
              provenance: 'assistant',
            },
          },
        },
      ],
    };
  }

  return { state, effects: [] };
};

/**
 * Share of resolved proposals the owner accepted, or null when too few have
 * resolved to mean anything.
 *
 * Exported for the status surface and for D12's calibration gate, which is the
 * measurement that decides whether the daemon has earned the right to speak with
 * confidence. Returns null rather than 0 below the floor for the reason the claims
 * registry already insists on: a rate computed from two samples looks like evidence
 * and is not.
 */
export function assistantAcceptanceRate(state: KernelState, minResolved = 10): number | null {
  const resolved = state.assistant.acceptedCount + state.assistant.rejectedCount;
  if (resolved < minResolved) return null;
  return state.assistant.acceptedCount / resolved;
}
