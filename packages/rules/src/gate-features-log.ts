import type { Effect, GateFeatures, JudgementResultPayload, Rule } from '@sundial/kernel/types.js';
import { gateDecisionId } from './notice-gate.js';
import { gateFeatures } from './questions/gate-features.js';

/**
 * J1.6 — gate features, logged not used.
 *
 * `gateFeaturesJudge` puts every `notice:candidate` to Jev (`gate-features`)
 * as the owner would see it: the observation and its evidence, no gate
 * arithmetic (the first lab run got the numbers and judged numbers). The
 * gate decides exactly as before, on the same event; this only asks.
 *
 * `applyGateFeatures` files the answers beside the decision row, by the id
 * both rules derive from the candidate event. Nothing reads them yet: J5.1
 * fits the learned gate on a month of these and the owner's verdicts
 * (J0.8), and its output replaces the fixed threshold only when it beats
 * it on held-out verdicts.
 */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export const gateFeaturesJudge: Rule = (state, event) => {
  if (event.type !== 'notice:candidate') return { state, effects: [] };
  const c = event.payload as Record<string, unknown>;
  const key = str(c.key);
  const title = str(c.observation);
  if (key === null || title === null) return { state, effects: [] };
  const evidence = Array.isArray(c.evidence) ? c.evidence.filter((e): e is string => typeof e === 'string' && e.trim() !== '').slice(0, 8) : [];
  const built = gateFeatures.build({ title, body: evidence.length > 0 ? evidence.join('; ') : null, severity: str(c.severity) });
  return {
    state,
    effects: [
      {
        type: 'Judge',
        purpose: 'classify',
        questionSetId: gateFeatures.id,
        momentId: null,
        delayMs: 0,
        state: built.state,
        questions: built.questions,
        // `artifactId` is the notice KEY: a `notice` verdict carries the key as
        // its artifact id (`feedbackTrack`), so the tap finds these answers.
        metadata: { decisionId: gateDecisionId(event.ts, event.id, key), noticeKey: key, artifactId: key },
      },
    ],
  };
};

const noul = (a: JudgementResultPayload['answers'][string] | undefined): number | null => (typeof a?.noul === 'number' ? a.noul : null);
const top = (a: JudgementResultPayload['answers'][string] | undefined): number | null => {
  const values = Object.values(a?.probabilities ?? {}).filter((v): v is number => typeof v === 'number');
  return values.length > 0 ? Math.max(...values) : typeof a?.confidence === 'number' ? a.confidence : null;
};

export function gateFeaturesOf(payload: JudgementResultPayload, ts: string): GateFeatures {
  const a = payload.answers ?? {};
  return {
    speak_now: noul(a.speak_now),
    value: typeof a.value?.score === 'number' ? Math.round(a.value.score) : null,
    value_p: top(a.value),
    channel: typeof a.channel?.choice === 'string' ? a.channel.choice : null,
    channel_p: top(a.channel),
    stale_soon: noul(a.stale_soon),
    actionable: noul(a.actionable),
    model: payload.model,
    at: ts,
  };
}

export const applyGateFeatures: Rule = (state, event) => {
  if (event.type !== 'judgement:result') return { state, effects: [] };
  const payload = event.payload as unknown as JudgementResultPayload;
  if (payload.questionSetId !== gateFeatures.id || !isRecord(payload.metadata)) return { state, effects: [] };
  const decisionId = str(payload.metadata.decisionId);
  const noticeKey = str(payload.metadata.noticeKey);
  if (decisionId === null || noticeKey === null) return { state, effects: [] };
  const effect: Effect = { type: 'RecordGateFeatures', decisionId, noticeKey, features: gateFeaturesOf(payload, event.ts) };
  return { state, effects: [effect] };
};
