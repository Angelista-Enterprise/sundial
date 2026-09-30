import { deriveId } from '@sundial/helpers/derive-id.js';
import { ENTITY_KINDS } from '@sundial/helpers/vocab.js';
import { closeLoop } from '@sundial/helpers/loops.js';
import type { Effect, KernelState, OpenLoop, Rule, SanitizedEvent } from '@sundial/kernel/types.js';

/**
 * Longest a proposal stays answerable by a response that names none. A response that names one
 * still finds it later (the record has one, two days late); `expiresAt` says the same week.
 */
const PROPOSAL_TTL_MS = 7 * 86_400_000;

/** Open proposals kept, as the old ring kept forty. */
const MAX_OPEN_PROPOSALS = 40;

interface ProposalPayload {
  /** W6 D3: minted by the tool and carried by the response. Absent before; the id is then derived, as it always was. */
  proposalId?: unknown;
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

const VALID_ENTITY_KINDS = new Set<string>(ENTITY_KINDS);

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
 * - `assistant:proposal` opens a proposal (a `proposal` loop, W2 M2). Nothing is
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
/**
 * W2 M2: a proposal is a `proposal` loop in `state.loops` (was `state.assistant.recent`), folded by
 * `loopTrack` through this. `subject` is the proposal id (W6 D3: minted by the tool, carried by the
 * response), `about` its summary; a response names it, or closes the newest open one within the
 * TTL. The counts stay in `state.assistant`, counted by the rule below
 * off what this closed on the same event.
 */
export function foldProposal(state: KernelState, event: SanitizedEvent): { state: KernelState; effects: Effect[] } | null {
  if (event.type === 'assistant:proposal') {
    const payload = event.payload as ProposalPayload;
    const summary = text(payload.summary);
    if (!summary) return { state, effects: [] };
    const id = text(payload.proposalId) || deriveId(event.ts, event.id, 'assistant-proposal');
    const loop: OpenLoop = {
      id,
      origin: 'tool',
      kind: 'proposal',
      subject: id,
      about: summary,
      resolve: { when: { type: 'assistant:response', where: [{ field: 'proposalId', op: 'eq', value: id }] } },
      seen: {},
      target: { sessionId: null },
      openedAt: event.ts,
      expiresAt: new Date(Date.parse(event.ts) + PROPOSAL_TTL_MS).toISOString(),
      status: 'open',
      detail: { kind: text(payload.kind) || 'unknown' },
    };
    // At most `MAX_OPEN_PROPOSALS` wait; the oldest goes quietly, as it left the old ring.
    const open = [...state.loops.open, loop];
    const extra = open.filter((l) => l.kind === 'proposal').length - MAX_OPEN_PROPOSALS;
    const drop = new Set(open.filter((l) => l.kind === 'proposal').slice(0, Math.max(0, extra)));
    return { state: { ...state, loops: { ...state.loops, open: open.filter((l) => !drop.has(l)) } }, effects: [] };
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
    const open = state.loops.open.filter((l) => l.kind === 'proposal');
    const target = proposalId ? open.find((l) => l.subject === proposalId) : open.filter((l) => nowMs - Date.parse(l.openedAt) <= PROPOSAL_TTL_MS).pop();
    if (!target) return { state, effects: [] };
    const closed: OpenLoop = { ...target, status: 'resolved', detail: { ...target.detail, outcome: verdict, resolvedAt: event.ts, byEventId: event.id } };
    return { state: { ...state, loops: closeLoop(state.loops, closed) }, effects: [] };
  }

  return null;
}

export const assistantTrack: Rule = (state, event) => {
  // The counts, off what `loopTrack` (earlier in the manifest) folded on this same event.
  if (event.type === 'assistant:proposal') {
    if (!text((event.payload as ProposalPayload).summary)) return { state, effects: [] };
    return { state: { ...state, assistant: { ...state.assistant, proposedCount: state.assistant.proposedCount + 1, lastAt: event.ts } }, effects: [] };
  }

  if (event.type === 'assistant:response') {
    const closed = state.loops.recent.find((l) => l.kind === 'proposal' && l.detail?.byEventId === event.id);
    if (!closed) return { state, effects: [] };
    const verdict = closed.detail?.outcome;
    return {
      state: {
        ...state,
        assistant: {
          ...state.assistant,
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
