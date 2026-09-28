import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Rule } from '@sundial/kernel/types.js';
import { parseAskProposals } from './ask-harvest.js';

interface LlmResultPayload {
  purpose?: string;
  momentId?: string;
  text?: string;
  /** D5 — `companionInsight`'s `ScheduleLLMEffect.metadata` passthrough, carrying the triggering anomaly's `kind`; `momentAnalysisSchedule`'s carries the line's `evidence` (J1.1); `askHarvest`'s carries the ask its reading belongs beside (H2). */
  metadata?: { kind?: string; noticeKey?: string; evidence?: unknown; askId?: string };
}

const MAX_RECENT_INSIGHTS = 30;

interface ParsedInsight {
  title: string;
  body: string;
  severity: string | null;
}

interface ParsedMomentAnalysis {
  intent: string;
  narrative: string;
}

/**
 * Parses `momentAnalysisSchedule`'s (B2) requested strict-JSON shape
 * (`{"intent": "...", "narrative": "..."}`) — one call now produces both
 * fields instead of the former two separate intent/narrate calls, so this
 * is the one place that can drift the two apart if it silently accepted a
 * partial object; both fields are required or the whole result is dropped
 * (same as an empty `text` already does below).
 */
export function parseMomentAnalysis(text: string): ParsedMomentAnalysis | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
    const narrative = typeof parsed.narrative === 'string' ? parsed.narrative.trim() : '';
    if (!intent || !narrative) return null;
    return { intent, narrative };
  } catch {
    return null;
  }
}

/**
 * Parses `companionInsight`'s requested strict-JSON shape
 * (`{"title": "...", "body": "...", "severity": "info"|"warning"}`).
 * Tolerant of a model wrapping the JSON in a markdown code fence despite
 * being asked not to — strips one if present before parsing. Returns
 * `null` on anything unparseable rather than throwing; a malformed
 * response just doesn't produce a knowledge entry (silently, same as an
 * empty `text` already does for intent/narrate below).
 */
export function parseCompanionInsight(text: string): ParsedInsight | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
    if (!title || !body) return null;
    return { title, body, severity: typeof parsed.severity === 'string' ? parsed.severity : null };
  } catch {
    return null;
  }
}

/**
 * Reacts to the executor's synthetic `llm:result` event (emitted after a
 * `ScheduleLLM` effect's call resolves — see `apps/daemon/src/daemon/index.ts`).
 * One rule handles every purpose's result generically rather than a
 * separate per-purpose "apply" rule per, since the only difference between
 * them is which field/table the text ends up in.
 *
 * `intent` (B2: now the merged intent+narrate call, see
 * `momentAnalysisSchedule`/`parseMomentAnalysis`) produces an
 * `UpdateMomentData` effect patching both `intent` and `narrative` in one
 * go (read-modify-write in the executor, never `state.moment` directly) —
 * by the time this fires, the analyzed moment has always already closed
 * (see `momentAnalysisSchedule`'s doc comment for why that's guaranteed,
 * not just likely), so its only durable home is the DB row. This is what
 * avoids WCS's `pendingAnalysisSessionId` class of bug entirely: there is
 * no in-memory "which moment is this analysis for" pointer to go stale,
 * because the target is named explicitly in the event payload
 * (`momentId`), not inferred from whatever `state.moment` happens to be
 * when the result arrives.
 *
 * `companion` produces a `WriteDB`/`knowledge_entries` effect instead — an
 * insight isn't attached to any one moment (it's about a pattern across
 * historical samples), so there's no moment row to merge into. `dedupeKey`
 * is derived from the title (matching WCS's title-based dedupe loosely) —
 * the executor's insert is `onConflictDoNothing` on a real unique index, so
 * a repeat insight is a harmless no-op, not something this rule checks for.
 */
export const applyLlmResult: Rule = (state, event) => {
  if (event.type !== 'llm:result') return { state, effects: [] };

  const payload = event.payload as LlmResultPayload;
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return { state, effects: [] };

  if (payload.purpose === 'companion') {
    const insight = parseCompanionInsight(text);
    if (!insight) return { state, effects: [] };

    const dedupeKey = `companion:${insight.title.toLowerCase()}`;
    const entryId = deriveId(event.ts, event.id, 'apply-llm-result', 'entry');
    const kind = payload.metadata?.kind ?? 'unknown';
    // D5 — appends the new insight for companionInsight's own future
    // reads (repeat-avoidance hint + same-kind recurrence count), capped so
    // this stays a bounded in-memory list, not an ever-growing log.
    // `id` is the knowledge_entries row id this same rule writes below, carried
    // so `solicitFeedback` can open a rating request naming a real artifactId
    // (recentInsights is the only in-state trace of an insight; the id was
    // previously dropped, leaving no rule able to reference the entry).
    // `noticeKey` is the gate's habituation key for the candidate this insight came
    // from, carried so a later `not-now` verdict can quiet that exact key rather than
    // guessing from the kind. Absent for insights produced before the gate existed.
    const recentInsights = [...state.memory.recentInsights, { title: insight.title, dedupeKey, kind, createdAt: event.ts, id: entryId, noticeKey: payload.metadata?.noticeKey }].slice(-MAX_RECENT_INSIGHTS);

    return {
      state: { ...state, memory: { ...state.memory, recentInsights } },
      effects: [
        {
          type: 'WriteDB',
          table: 'knowledge_entries',
          row: {
            id: entryId,
            kind: 'companion-insight',
            title: insight.title,
            body: insight.body,
            severity: insight.severity,
            dedupeKey,
            sourceEventId: event.id,
            createdAt: event.ts,
            // Anomaly-driven, so already known-significant — above the schema default (5).
            importanceScore: 8,
          },
        },
        // Embedded alongside the write (not by a separate rule reacting to
        // the same knowledge_entries row) since the id is already in hand
        // here — see embedding-index.ts's doc comment.
        {
          type: 'Embed',
          id: deriveId(event.ts, event.id, 'apply-llm-result', 'embed'),
          refType: 'knowledge_entry',
          refId: entryId,
          text: `${insight.title}. ${insight.body}`,
        },
      ],
    };
  }

  // H2 — `askHarvest`'s reading, filed BESIDE the ask it read. Keyed on the
  // `askId` the schedule carried rather than on the purpose alone, because
  // `extract` is shared with two passes that use their own `Run*` effects and
  // never produce an `llm:result` at all. An empty array is a real answer —
  // "looked at, nothing there" — and is stored, which is what stops the
  // backfill offering the same answer again tomorrow.
  const askId = typeof payload.metadata?.askId === 'string' ? payload.metadata.askId : '';
  if (askId !== '') {
    return { state, effects: [{ type: 'UpdateOwnerAsk', askId, patch: { proposals: parseAskProposals(text) } }] };
  }

  const momentId = typeof payload.momentId === 'string' ? payload.momentId : null;
  if (!momentId) return { state, effects: [] };

  if (payload.purpose === 'transcript') {
    // Beside the raw capture, never over it. The clean copy is a reading until
    // the owner accepts it, and `accepted` is the only thing that changes that.
    const cleaned = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    if (cleaned === '') return { state, effects: [] };
    return {
      state,
      effects: [{ type: 'UpdateMomentData', momentId, patch: { spokenClean: { text: cleaned, cleanedAt: event.ts } } }],
    };
  }

  if (payload.purpose !== 'intent') return { state, effects: [] };

  // J1.1: a line is judged before it is shown (`verifyLine`), unless nothing
  // is judging — `degraded: off` is the pre-Jev path, and it is this one. A
  // render from before evidence travelled with it (no `metadata.evidence`)
  // has nothing to be judged against and is applied as it always was.
  const judged = state.judgement.degraded !== 'off' && typeof payload.metadata === 'object' && payload.metadata !== null && 'evidence' in payload.metadata;
  if (judged) return { state, effects: [] };

  const analysis = parseMomentAnalysis(text);
  if (!analysis) return { state, effects: [] };

  return {
    state,
    effects: [
      {
        type: 'UpdateMomentData',
        momentId,
        patch: { intent: { status: 'done', text: analysis.intent, analyzedAt: event.ts }, narrative: analysis.narrative },
      },
    ],
  };
};
