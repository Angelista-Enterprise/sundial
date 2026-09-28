import type { Rule } from '@sundial/kernel/types.js';
import { assessNovelty } from './llm-novelty-gate.js';

export interface ExtractedFactCandidate {
  entityKind: 'person' | 'project' | 'tool' | 'topic' | 'owner' | 'goal';
  canonicalName: string;
  predicate: string;
  object: string;
  confidence: number;
}

const VALID_ENTITY_KINDS = new Set(['person', 'project', 'tool', 'topic', 'owner', 'goal']);
export const MAX_EXTRACTED_FACTS_PER_PASS = 10;

/**
 * The LLM emits free-form predicate strings — `used_for`, `usedFor`, `used`,
 * `worked_on`, `workingOn` — for the same relation, so the same real fact
 * arrives spelled differently each night and never recurs as the *same* triple,
 * so it never clears `contradictionCheck`'s 2-observation promotion bar (Phase 5
 * #3, diagnosed from the live DB: tool/topic facts were starved by exactly this
 * fragmentation). Fold known synonyms onto a small controlled vocabulary keyed
 * by an alphanumeric-lowercase form; unknown predicates pass through unchanged
 * (preserving their original casing) rather than being forced into a bucket.
 */
const PREDICATE_SYNONYMS: Record<string, string> = {
  usestool: 'usesTool',
  usedfor: 'usesTool',
  used: 'usesTool',
  uses: 'usesTool',
  usingtool: 'usesTool',
  tool: 'usesTool',
  primarytool: 'usesTool',
  workson: 'worksOn',
  workedon: 'worksOn',
  worked: 'worksOn',
  workingon: 'worksOn',
  worked_on: 'worksOn',
  relatestoproject: 'relatesToProject',
  relatesto: 'relatesToProject',
  relatedto: 'relatesToProject',
  partof: 'relatesToProject',
  collaborateson: 'collaboratesOn',
  collaborates: 'collaboratesOn',
  collaboratedwith: 'collaboratesOn',
  contributedto: 'collaboratesOn',
  deployedvia: 'deployedVia',
  deployvia: 'deployedVia',
};

export function normalizePredicate(predicate: string): string {
  const key = predicate.toLowerCase().replace(/[^a-z0-9]/g, '');
  return PREDICATE_SYNONYMS[key] ?? predicate;
}

/**
 * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5) —
 * parses the `extract` LLM call's response (see `performFactExtractionCall`
 * in `apps/daemon/src/daemon/index.ts`) into typed candidates, same
 * defensive style as `apply-llm-result.ts`'s `parseCompanionInsight`: strip
 * markdown fencing, `JSON.parse`, validate every field, drop anything
 * malformed rather than throwing — a bad LLM response degrades to "no facts
 * extracted this pass," not a crashed daemon.
 */
export function parseExtractedFactCandidates(text: string): ExtractedFactCandidate[] {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (!Array.isArray(parsed)) return [];

    const candidates: ExtractedFactCandidate[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const entityKind = typeof row.entityKind === 'string' ? row.entityKind : '';
      const canonicalName = typeof row.canonicalName === 'string' ? row.canonicalName.trim() : '';
      const predicate = typeof row.predicate === 'string' ? normalizePredicate(row.predicate.trim()) : '';
      const object = typeof row.object === 'string' ? row.object.trim() : '';
      const confidence = typeof row.confidence === 'number' ? row.confidence : NaN;
      if (!VALID_ENTITY_KINDS.has(entityKind) || !canonicalName || !predicate || !object || !Number.isFinite(confidence)) continue;
      // Nothing is a fact about itself. The live record held
      // `project:sundial worksOn sundial`, which the entity card rendered
      // straight-faced above the owner's own asserted facts. The prompt makes
      // it likely by construction — every topic and tool owes a
      // `relatesToProject` fact naming its project verbatim, and a topic named
      // after its project then answers with its own name. The heuristic
      // extractor already refuses this (`entityExtract` will not make a task of
      // a known project's name); the model path had no equivalent.
      if (canonicalName.toLowerCase() === object.toLowerCase()) continue;
      candidates.push({ entityKind: entityKind as ExtractedFactCandidate['entityKind'], canonicalName, predicate, object, confidence: Math.max(1, Math.min(100, Math.round(confidence))) });
    }
    return candidates.slice(0, MAX_EXTRACTED_FACTS_PER_PASS);
  } catch {
    return [];
  }
}

/**
 * Reacts to `day:boundary` — same daily cadence as `memoryReflection`,
 * tracked independently in `state.memory.lastFactExtractAt` (its own cursor,
 * not shared with `lastReflectionAt`, since the two passes read different
 * DB windows and could legitimately drift if one is ever skipped).
 *
 * D3's own scope note: `entityExtract` already covers what heuristics can
 * do cheaply (regex/structural fields on specific event types). What it
 * structurally can't do is synthesize a candidate from a whole day's worth
 * of unstructured signal at once — "topics worked on, tools adopted,
 * collaborators" as an emergent read of the day's rollups, not a single
 * event. That's what the `extract` LLM purpose (defined since Phase 4,
 * unused until now) is for. Only says "extraction is due, starting from
 * `since`" — the actual DB read + LLM call + candidate emission all happen
 * in the executor (`performFactExtractionCall`), a pure rule can't do a DB
 * read to gather "the day's rollups."
 */
export const nightlyFactExtract: Rule = (state, event) => {
  if (event.type !== 'day:boundary') return { state, effects: [] };

  const since = state.memory.lastFactExtractAt ?? new Date(Date.parse(event.ts) - 24 * 60 * 60 * 1000).toISOString();

  // Skip a pass over a window the daemon barely watched — see `assessNovelty`.
  // The cursor is deliberately NOT advanced on a skip: the unextracted window rolls
  // into tomorrow's pass rather than being lost, so a quiet day defers extraction
  // instead of silently deleting it. `MAX_DEFERRED_WINDOW_MS` bounds that rolling.
  const novelty = assessNovelty(state, since, event.ts);
  if (!novelty.worthCalling) {
    return {
      state,
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: `${event.id}-extract-skipped`,
            type: 'llm:skipped',
            ts: event.ts,
            // Countable in the log, so "the daemon went quiet because nothing
            // happened" stays distinguishable from "the daemon broke".
            payload: { purpose: 'extract', reason: novelty.reason, observedHours: Math.round(novelty.observedHours * 100) / 100, since },
          },
        },
      ],
    };
  }

  return {
    state: { ...state, memory: { ...state.memory, lastFactExtractAt: event.ts } },
    effects: [{ type: 'RunFactExtraction', since, ts: event.ts }],
  };
};
