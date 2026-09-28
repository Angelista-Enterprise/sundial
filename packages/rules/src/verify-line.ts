import { withPersona } from '@sundial/kernel/persona.js';
import type { Effect, JudgementResultPayload, Rule } from '@sundial/kernel/types.js';
import { parseMomentAnalysis } from './apply-llm-result.js';
import { questionId } from './questions/index.js';
import { JUDGE_LINE_QUESTIONS, judgeLine } from './questions/judge-line.js';
import { renderSubject, resolveSubject } from './questions/render-subject.js';

/**
 * J1.1 — every `intent` line is judged before the owner sees it.
 *
 * The text model's sentence goes to Jev with the evidence it was written
 * from (`judge-line`). Hedged or ungrounded → ONE retry render with the
 * verdict as feedback; still failing → the template line, built from the
 * evidence alone, so a guessed project name is impossible by construction.
 * Bench: hedge AUC 1.00, 20/20 caught, 0 false alarms (RESULTS.md, J1.1a).
 *
 * The evidence rides `ScheduleLLMEffect.metadata` → `llm:result.metadata`
 * → `Judge.metadata` → `judgement:result.metadata`: a moment is closed by
 * the time its line comes back, and `state.moment` is already the next one,
 * so the line's own evidence has to travel with it. It is the short named
 * fields of `momentFanoutState`, about 600 bytes.
 *
 * Pre-Jev path: `applyLlmResult` still applies a line directly when
 * `state.judgement.degraded` is `off`, and this rule applies the unjudged
 * line when the executor reports `judgement:failed` — Jev down AND the local
 * fallback down loses nothing but the check.
 */
const HEDGES = questionId(JUDGE_LINE_QUESTIONS.hedges);
const GROUNDED = questionId(JUDGE_LINE_QUESTIONS.grounded);
/** The same delay the first render had; the retry is one more render, not an interrupt. */
const RETRY_DELAY_MS = 0;

interface LineMetadata {
  momentId: string;
  line: string;
  narrative: string | null;
  /** 1 for the first render, 2 for the retry. */
  attempt: number;
  evidence: Record<string, unknown>;
  /** The first render's audit row, so the retry can point its own row at it (J1.1c). */
  auditId?: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The line's travelling context, or null when a payload was not built by this path. */
function lineMetadata(meta: unknown): LineMetadata | null {
  if (!isRecord(meta)) return null;
  const { momentId, line, narrative, attempt, evidence, auditId } = meta as Partial<LineMetadata>;
  if (typeof momentId !== 'string' || momentId === '' || typeof line !== 'string' || !isRecord(evidence)) return null;
  return { momentId, line, narrative: typeof narrative === 'string' ? narrative : null, attempt: attempt === 2 ? 2 : 1, evidence, auditId: typeof auditId === 'string' ? auditId : null };
}

/**
 * The fallback line, when the model's line failed the judge twice: the most
 * specific subject the evidence has, rendered by the same template J1.2
 * benched (`render-subject.ts`). Names things that are in the state and
 * nothing else.
 */
export function templateLine(evidence: Record<string, unknown>): string {
  return renderSubject(resolveSubject(null, evidence), evidence) ?? `In ${typeof evidence.app === 'string' ? evidence.app : 'an app'}`;
}

const applied = (meta: LineMetadata, ts: string, line: string, narrative: string | null, judged: string): Effect => ({
  type: 'UpdateMomentData',
  momentId: meta.momentId,
  patch: { intent: { status: 'done', text: line, analyzedAt: ts, judged }, ...(narrative ? { narrative } : {}) },
});

export const verifyLine: Rule = (state, event) => {
  // 1. The line comes back from the text model: send it to the judge.
  if (event.type === 'llm:result') {
    if (state.judgement.degraded === 'off') return { state, effects: [] };
    const payload = event.payload as { purpose?: string; momentId?: string | null; text?: string; auditId?: string; metadata?: unknown };
    if (payload.purpose !== 'intent' || typeof payload.momentId !== 'string' || payload.momentId === '') return { state, effects: [] };
    const evidence = isRecord(payload.metadata) && isRecord(payload.metadata.evidence) ? payload.metadata.evidence : null;
    // A render from before evidence travelled with it: nothing to judge against, so it is applied as it was.
    if (evidence === null) return { state, effects: [] };
    const analysis = parseMomentAnalysis(typeof payload.text === 'string' ? payload.text : '');
    if (!analysis) return { state, effects: [] };
    const attempt = isRecord(payload.metadata) && payload.metadata.attempt === 2 ? 2 : 1;
    const built = judgeLine.build({ moment: { rollup: evidence as never, projectId: null, durationMs: 0 }, intent: analysis.intent, narrative: analysis.narrative });
    const meta: LineMetadata = { momentId: payload.momentId, line: analysis.intent, narrative: analysis.narrative, attempt, evidence, auditId: payload.auditId ?? null };
    return {
      state,
      effects: [
        {
          type: 'Judge',
          purpose: 'judge',
          questionSetId: judgeLine.id,
          momentId: payload.momentId,
          delayMs: 0,
          // The judge reads the evidence the writer read, not a rebuilt one.
          state: { evidence, assistant_wrote: built.state.assistant_wrote },
          questions: built.questions,
          metadata: meta as unknown as Record<string, unknown>,
        },
      ],
    };
  }

  // 2. The judge could not be reached at all: the unjudged line is better than no line.
  if (event.type === 'judgement:failed') {
    const payload = event.payload as { questionSetId?: string; metadata?: unknown };
    if (payload.questionSetId !== judgeLine.id) return { state, effects: [] };
    const meta = lineMetadata(payload.metadata);
    return meta ? { state, effects: [applied(meta, event.ts, meta.line, meta.narrative, 'unjudged')] } : { state, effects: [] };
  }

  if (event.type !== 'judgement:result') return { state, effects: [] };
  const payload = event.payload as unknown as JudgementResultPayload;
  if (payload.questionSetId !== judgeLine.id) return { state, effects: [] };
  const meta = lineMetadata(payload.metadata);
  if (!meta) return { state, effects: [] };

  // 3. The verdict, on the probability vector (law 5) against each question's own threshold (law 4).
  const threshold = (id: string) => state.judgement.questions[id]?.threshold ?? 0.5;
  const hedges = payload.answers?.hedges?.noul ?? 0;
  const grounded = payload.answers?.grounded?.noul ?? 1;
  const failing: string[] = [];
  if (hedges > threshold(HEDGES)) failing.push('it hedges');
  if (grounded < threshold(GROUNDED)) failing.push('it names something the evidence does not contain');

  if (failing.length === 0) return { state, effects: [applied(meta, event.ts, meta.line, meta.narrative, meta.attempt === 2 ? 'retried' : 'passed')] };

  // 4a. Second failure: the template line. Nothing invented, nothing hedged.
  if (meta.attempt >= 2) return { state, effects: [applied(meta, event.ts, templateLine(meta.evidence), null, 'template')] };

  // 4b. First failure: one more render, told what was wrong with the last one.
  return {
    state,
    effects: [
      {
        type: 'ScheduleLLM',
        purpose: 'intent',
        momentId: meta.momentId,
        delayMs: RETRY_DELAY_MS,
        // J1.1c: a row with attempt 2 pointing at the first render, so the
        // Ledger counts it as the retry it is.
        attempt: 2,
        parentCallId: meta.auditId ?? null,
        messages: [
          {
            role: 'system',
            content: withPersona(
              'You are rewriting a one-line reading of a short window of activity, after a check found a fault in the first attempt.',
              'Respond with STRICT JSON only, no markdown fencing, matching exactly: {"intent": "...", "narrative": "..."}. "intent": a bare verb phrase under 70 characters naming the concrete work. Never begin with "The user" and never hedge with "likely", "probably", "appears to" or "seems". "narrative": one past-tense sentence on the same work, no preamble.',
              'Name only what the evidence contains: a project, branch, meeting, command or window title that is IN the evidence. If nothing names the work, describe what was on screen and stop.',
            ),
          },
          {
            role: 'user',
            content: `Evidence, as named fields:\n${JSON.stringify(meta.evidence)}\n\nYour previous line was: "${meta.line}"\nThe check found: ${failing.join('; ')}.\nRewrite it.`,
          },
        ],
        metadata: { evidence: meta.evidence, attempt: 2 },
      },
    ],
  };
};
