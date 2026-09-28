import { getLlmConfig } from './config.js';
import { callChatCompletion } from './transport.js';
import type { SystemOneAnswer, SystemOneQuestion, SystemOneResult } from './systemone.js';

/**
 * The fallback backend (docs/jarvis/02, "Fallback backend"): the same
 * `{ state, questions }` put to the text model with a prompt that asks for
 * Jev's answer shape and per-option probabilities as JSON — the pattern
 * TypeSafe's own `system-one-adapter-python` uses. Slower and less
 * calibrated; it exists so a Jev outage degrades Gnomon instead of stopping
 * it. Its thresholds are Jev's, learned on Jev's probabilities, so a
 * consuming rule should read `state.judgement.degraded` before acting above
 * L2 on an answer from here.
 */
export type SystemOneBackend = 'jev' | 'local' | 'off';

export function systemOneBackend(): SystemOneBackend {
  const value = process.env.SUNDIAL_SYSTEMONE_BACKEND;
  if (value === 'local' || value === 'off' || value === 'jev') return value;
  // Jev is a hosted judge (api.typesafe.ai). Without its key every call would
  // fail, retry, then fall back — and a new install has no key — so the
  // default without one is the local model, and nothing is sent to TypeSafe.
  return process.env.TYPESAFE_API_KEY ? 'jev' : 'local';
}

const SYSTEM = [
  'You grade a structured STATE against QUESTIONS. Answer with STRICT JSON only, no markdown, no prose: {"answers": {<question id>: <answer>}}.',
  'For a "noul" question the answer is {"noul": p} — p in [0,1], the probability the statement is true.',
  'For a "choice" question the answer is {"probabilities": {<criterion key>: p, ...}} over EVERY criterion key, summing to 1.',
  'For a "score" question the answer is {"probabilities": {"0": p, "1": p, ...}} over every level index in order, summing to 1.',
  'Use only the evidence in STATE. A field that is null or empty is not evidence. Give honest probabilities, not certainties.',
].join(' ');

function normalise(type: SystemOneQuestion['type'], raw: unknown): SystemOneAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { noul?: unknown; probabilities?: unknown };
  if (type === 'noul') {
    const p = typeof r.noul === 'number' ? r.noul : typeof (raw as { p?: unknown }).p === 'number' ? (raw as { p: number }).p : null;
    return p === null ? null : { type, noul: Math.min(1, Math.max(0, p)) };
  }
  if (typeof r.probabilities !== 'object' || r.probabilities === null) return null;
  const entries = Object.entries(r.probabilities as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] >= 0);
  const total = entries.reduce((sum, [, p]) => sum + p, 0);
  if (entries.length === 0 || total <= 0) return null;
  const probabilities = Object.fromEntries(entries.map(([k, p]) => [k, p / total]));
  const [top, confidence] = entries.map(([k, p]) => [k, p / total] as const).reduce((a, b) => (b[1] > a[1] ? b : a));
  return type === 'choice' ? { type, choice: top, probabilities, confidence } : { type, score: Number(top), probabilities, confidence };
}

export async function callSystemOneLocal(
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
  opts: { timeoutMs?: number } = {},
): Promise<SystemOneResult> {
  const model = getLlmConfig()?.model ?? 'unconfigured';
  const startedAt = performance.now();
  const result = await callChatCompletion(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `STATE:\n${JSON.stringify(state)}\n\nQUESTIONS:\n${JSON.stringify(questions)}` },
    ],
    { temperature: 0, maxTokens: 1024, timeoutMs: opts.timeoutMs },
  );
  const stripped = result.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed: { answers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(stripped) as { answers?: Record<string, unknown> };
  } catch {
    throw new Error(`local judgement returned no JSON: ${result.content.slice(0, 200)}`);
  }
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const answer = normalise(q.type, parsed.answers?.[id]);
    if (answer) answers[id] = answer;
  }
  return {
    answers,
    model,
    inputTokens: result.promptTokens,
    outputTokens: result.completionTokens,
    latencyMs: performance.now() - startedAt,
    statusCode: result.statusCode,
  };
}
