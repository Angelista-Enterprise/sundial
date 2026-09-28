import type { Effect, JudgementResultPayload, KernelState, Rule } from '@sundial/kernel/types.js';
import { questionId } from './questions/index.js';
import { THRESHOLD_MIN_N } from './judgement-track.js';
import { AUDIT_FACT_QUESTIONS, auditFact } from './questions/audit-fact.js';

/**
 * J2.3 — the nightly belief audit, re-scoped to what the bench earned.
 *
 * Every live inferred fact goes to the judge (`audit-fact`) once a night. The
 * bench (RESULTS: audit, 2026-09-22) said what Jev can and cannot see on a
 * fact's text: it CANNOT tell a plausible misattribution ("sundial usesTool
 * Photos") from a true belief — AUC 0.54 against same-predicate corruption,
 * and 0/8 of the owner's own retractions caught — so `is_false` is NOT a truth
 * judge and the uncertain-band owner ask the roadmap sketched is dropped (a
 * question driven by a coin flip is noise). It CAN see a malformed belief: at
 * 0.7 it flagged 9 of 358 live facts and all 9 were wrong — seven with subject
 * and object swapped ("Figma usesTool overture"), one meeting room recorded
 * as a person, one fragment of prose as a tool — with zero false alarms.
 *
 * So the audit retracts at `is_false ≥ θ` (0.7 until verdicts move it) and
 * only that. `still_current`, `is_artifact` (unearned: macOS daemon names read
 * as tools) and `usefulness` ride in the `judgement:result` for the Trust
 * surface and a later calibration; nothing acts on them. An `assertion` is
 * never retracted here — the owner said it — and is not sent at all.
 *
 * The evidence-side check the misattributions actually need — how often the
 * tool appears in that project's own sessions — is arithmetic, not judgement,
 * and needs the entity→path map first (roadmap, J2.3 follow-up).
 */
export const IS_FALSE = questionId(AUDIT_FACT_QUESTIONS.is_false);
export const RETRACT_FALLBACK_THRESHOLD = 0.7;

export interface FactAuditMetadata {
  factId: string;
  provenance: string;
  belief: string;
}

const isMeta = (m: unknown): m is FactAuditMetadata => typeof m === 'object' && m !== null && typeof (m as FactAuditMetadata).factId === 'string' && typeof (m as FactAuditMetadata).provenance === 'string';

/** Once on the first tick after it ships (`lastBeliefAuditAt` null), then on every day boundary. The executor does the DB read a pure rule cannot. */
export const nightlyBeliefAudit: Rule = (state, event) => {
  // `?? null`: a snapshot from before this field rehydrates it as undefined, and the first pass must still run.
  const first = (state.memory.lastBeliefAuditAt ?? null) === null && event.type === 'clock:tick';
  if (!first && event.type !== 'day:boundary') return { state, effects: [] };
  return {
    state: { ...state, memory: { ...state.memory, lastBeliefAuditAt: event.ts } },
    effects: [{ type: 'RunBeliefAudit', ts: event.ts }],
  };
};

const fix = (n: number | undefined): string => (typeof n === 'number' ? n.toFixed(2) : '—');

export const applyFactAudit: Rule = (state, event) => {
  if (event.type !== 'judgement:result') return { state, effects: [] };
  const payload = event.payload as unknown as JudgementResultPayload;
  if (payload.questionSetId !== auditFact.id) return { state, effects: [] };
  const meta = payload.metadata;
  if (!isMeta(meta) || meta.provenance === 'assertion') return { state, effects: [] };
  const a = payload.answers ?? {};
  const isFalse = a.is_false?.noul;
  // The record's threshold is the registry DEFAULT (0.5 for a noul) until
  // THRESHOLD_MIN_N verdicts have moved it; the audit's earned operating point
  // is 0.7, and the first live pass at 0.5 retracted 17 true beliefs
  // (2026-09-22, restored by hand). Only a LEARNED threshold overrides it.
  const record = state.judgement.questions[IS_FALSE];
  const threshold = record && record.n >= THRESHOLD_MIN_N ? record.threshold : RETRACT_FALLBACK_THRESHOLD;
  if (typeof isFalse !== 'number' || isFalse < threshold) return { state, effects: [] };
  const effects: Effect[] = [
    {
      type: 'RetractFact',
      factId: meta.factId,
      reason: `belief audit: is_false ${fix(isFalse)} · artifact ${fix(a.is_artifact?.noul)} · still_current ${fix(a.still_current?.noul)} · ${meta.belief}`,
      ts: event.ts,
    },
  ];
  return { state: state as KernelState, effects };
};
