import type { JudgedArtifact, JudgementQuestionRecord, JudgementRecent, JudgementResultPayload, KernelState, RejudgeOptions, Rule } from '@sundial/kernel/types.js';
import { AUDIT_FACT_QUESTIONS } from './questions/audit-fact.js';
import { questionId, wordingHash } from './questions/index.js';
import { QUESTION_SETS } from './questions/registry.js';

/**
 * How many results a verdict can still find the answers behind, per question set (W5 step 4:
 * one shared ring let the nightly fact audit, ~270 answers a night, flush the notices' answers
 * before a morning tap could reach them).
 */
const MAX_RECENT_JUDGEMENTS = 200;
/** Verdicts an answer arriving later can still be graded by. The record held 216 in 62 days. */
const MAX_VERDICTS = 300;

/**
 * W5 step 4: a positive answer to these says the belief is bad (false, a parsing artifact), so it
 * was right when the owner said `wrong`. Graded as `useful` = hit, the retraction threshold would
 * learn from the owner's confirmations to retract more.
 */
export const INVERTED_QUESTIONS = new Set([questionId(AUDIT_FACT_QUESTIONS.is_false), questionId(AUDIT_FACT_QUESTIONS.is_artifact)]);

/** Every answer in `rows` graded with one verdict. */
export function gradeRows(questions: KernelState['judgement']['questions'], rows: JudgementRecent[], useful: boolean, ts: string): KernelState['judgement']['questions'] {
  const out = { ...questions };
  for (const r of rows) for (const [id, p] of Object.entries(r.p)) if (out[id]) out[id] = gradeAnswer(out[id], p, INVERTED_QUESTIONS.has(id) ? !useful : useful, ts);
  return out;
}

/** The verdict memory with one more verdict: the newest wins, and the sets it already graded stay graded. */
export function rememberVerdict(verdicts: JudgedArtifact[] | undefined, artifactId: string, useful: boolean, ts: string, graded: string[]): JudgedArtifact[] {
  const previous = (verdicts ?? []).find((v) => v.artifactId === artifactId);
  const entry = { artifactId, useful, ts, graded: [...new Set([...(previous?.graded ?? []), ...graded])] };
  return [...(verdicts ?? []).filter((v) => v.artifactId !== artifactId), entry].slice(-MAX_VERDICTS);
}

/** An answer that arrived after the owner's verdict on its artifact (or moment) is graded once per set. */
function gradeLate(judgement: KernelState['judgement'], questions: KernelState['judgement']['questions'], entry: JudgementRecent, ts: string): Pick<KernelState['judgement'], 'questions' | 'verdicts'> {
  const key = entry.artifactId ?? entry.momentId;
  const verdict = key === null ? undefined : judgement.verdicts?.find((v) => v.artifactId === key);
  if (!verdict || verdict.graded.includes(entry.questionSetId)) return { questions, verdicts: judgement.verdicts };
  return { questions: gradeRows(questions, [entry], verdict.useful, ts), verdicts: rememberVerdict(judgement.verdicts, verdict.artifactId, verdict.useful, verdict.ts, [entry.questionSetId]) };
}
/** Law 4's learning gate: below this many graded answers the lab's operating points stand. */
export const THRESHOLD_MIN_N = 20;
export const DECILES = 10;

/** The lab's operating points (docs/jarvis/02): top probability ≥ 0.7 for a choice, ≥ 0.5 for a noul or a score level. */
export const defaultThreshold = (type: string): number => (type === 'choice' ? 0.7 : 0.5);

/**
 * Law 5: decide on the probability vector, never on `confidence`. The one
 * number an answer is decided on: a noul's probability, a choice's top
 * probability, a score's probability of the level it picked.
 */
export function answerProbability(answer: JudgementResultPayload['answers'][string]): number | null {
  if (typeof answer.noul === 'number') return answer.noul;
  const probabilities = answer.probabilities ? Object.values(answer.probabilities).filter((v) => typeof v === 'number') : [];
  if (probabilities.length > 0) return Math.max(...probabilities);
  return typeof answer.confidence === 'number' ? answer.confidence : null;
}

export const decileOf = (p: number): number => Math.min(DECILES - 1, Math.max(0, Math.floor(p * DECILES)));

/**
 * The decile edge that maximises accuracy on the reliability bins: an answer
 * at or above the edge is called positive, and it was right when the owner
 * graded it useful; below the edge it is called negative, and it was right
 * when the owner did not. Ties keep the lower edge (say more, not less, until
 * the data says otherwise).
 */
export function bestThreshold(bins: JudgementQuestionRecord['bins']): number {
  let best = { edge: 0, correct: -1 };
  for (let edge = 1; edge < DECILES; edge += 1) {
    let correct = 0;
    for (let d = 0; d < DECILES; d += 1) correct += d >= edge ? bins.hits[d] : bins.n[d] - bins.hits[d];
    if (correct > best.correct) best = { edge, correct };
  }
  return best.edge / DECILES;
}

const emptyRecord = (type: string): JudgementQuestionRecord => ({
  type,
  threshold: defaultThreshold(type),
  n: 0,
  hits: 0,
  bins: { n: Array(DECILES).fill(0), hits: Array(DECILES).fill(0) },
  lastVerdictAt: null,
});

/**
 * Grade one answer with the owner's verdict: the decile its probability fell
 * in gets a count and, when the owner found the line useful, a hit. At
 * `THRESHOLD_MIN_N` graded answers the threshold moves to `bestThreshold`.
 * Pure; used by `feedbackTrack`, never by the executor.
 */
export function gradeAnswer(record: JudgementQuestionRecord, p: number, useful: boolean, ts: string): JudgementQuestionRecord {
  const d = decileOf(p);
  const bins = { n: [...record.bins.n], hits: [...record.bins.hits] };
  bins.n[d] += 1;
  if (useful) bins.hits[d] += 1;
  const n = record.n + 1;
  return {
    ...record,
    n,
    hits: record.hits + (useful ? 1 : 0),
    bins,
    lastVerdictAt: ts,
    threshold: n >= THRESHOLD_MIN_N ? bestThreshold(bins) : record.threshold,
  };
}

/**
 * Folds every `judgement:result` into `state.judgement` (docs/jarvis/02):
 * a question record exists from the first answer, at the lab's default
 * threshold, and the answer's probabilities join `recent` keyed by moment and
 * artifact so the owner's later verdict (`feedbackTrack`) can grade them.
 * The question set's ids come from the registry — pure data, no I/O.
 */
/**
 * W3: a rejudge that never reported back (the process died under it) stops
 * holding the job after this long; the job itself fits in minutes.
 */
export const REJUDGE_STALE_MS = 60 * 60 * 1000;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const judgementTrack: Rule = (state, event) => {
  // W3: an answer a tool consulted inside a turn, counted per question set; the answers themselves stay in the log.
  if (event.type === 'judgement:consulted') {
    const setId = String((event.payload as { questionSetId?: unknown }).questionSetId ?? 'unknown');
    const consulted = { ...(state.judgement.consulted ?? {}), [setId]: (state.judgement.consulted?.[setId] ?? 0) + 1 };
    return { state: { ...state, judgement: { ...state.judgement, consulted } }, effects: [] };
  }
  // W3: the rejudge job, requested by the route and run by the executor. One at a time.
  if (event.type === 'rejudge:requested') {
    const running = state.judgement.rejudge;
    if (running?.running && running.startedAt && Date.parse(event.ts) - Date.parse(running.startedAt) < REJUDGE_STALE_MS) return { state, effects: [] };
    const p = event.payload as Record<string, unknown>;
    const options: RejudgeOptions = {
      ...(p.all === true ? { all: true } : {}),
      ...Object.fromEntries((['limit', 'bench', 'pack', 'sinceDays'] as const).filter((k) => num(p[k]) > 0).map((k) => [k, num(p[k])])),
    };
    const rejudge = { running: true, startedAt: event.ts, finishedAt: null, total: 0, done: 0, calls: 0, failedCalls: 0, error: null, bench: null, options };
    return { state: { ...state, judgement: { ...state.judgement, rejudge } }, effects: [{ type: 'RunRejudge', options }] };
  }
  if (event.type === 'rejudge:finished') {
    if (!state.judgement.rejudge?.running) return { state, effects: [] };
    const p = event.payload as Record<string, unknown>;
    const rejudge = {
      ...state.judgement.rejudge,
      running: false,
      finishedAt: event.ts,
      total: num(p.total),
      done: num(p.done),
      calls: num(p.calls),
      failedCalls: num(p.failedCalls),
      error: typeof p.error === 'string' ? p.error : null,
      bench: typeof p.bench === 'object' && p.bench !== null ? (p.bench as Record<string, unknown>) : null,
    };
    return { state: { ...state, judgement: { ...state.judgement, rejudge } }, effects: [] };
  }
  if (event.type === 'judgement:degraded') {
    const mode = (event.payload as { mode?: unknown }).mode;
    if (mode !== 'none' && mode !== 'local-fallback' && mode !== 'off') return { state, effects: [] };
    if (state.judgement.degraded === mode) return { state, effects: [] };
    // The clock on degraded time: starts when the mark leaves `none`, banks the spell when it returns.
    const since = state.judgement.degradedSince ?? null;
    const degradedMs = (state.judgement.degradedMs ?? 0) + (mode === 'none' && since ? Math.max(0, Date.parse(event.ts) - Date.parse(since)) : 0);
    const degradedSince = mode === 'none' ? null : (since ?? event.ts);
    return { state: { ...state, judgement: { ...state.judgement, degraded: mode, degradedSince, degradedMs } }, effects: [] };
  }
  if (event.type !== 'judgement:result') return { state, effects: [] };

  const payload = event.payload as unknown as JudgementResultPayload;
  const set = QUESTION_SETS.find((s) => s.id === payload.questionSetId);
  if (!set || typeof payload.answers !== 'object' || payload.answers === null) return { state, effects: [] };

  // The set's questions by key → id. A set builds the same questions for every
  // input (the snapshot test pins that), so any sample's questions will do.
  const sample = set.samples()[0];
  const questions = sample ? set.build(...sample).questions : {};

  const records: KernelState['judgement']['questions'] = { ...state.judgement.questions };
  const p: Record<string, number> = {};
  for (const [key, answer] of Object.entries(payload.answers)) {
    const question = questions[key];
    if (!question) continue;
    const id = questionId(question);
    const probability = answerProbability(answer);
    if (probability === null) continue;
    p[id] = probability;
    records[id] ??= emptyRecord(question.type);
  }

  const metadataArtifact = payload.metadata?.artifactId;
  const entry: JudgementRecent = {
    ts: event.ts,
    questionSetId: payload.questionSetId,
    momentId: payload.momentId ?? null,
    artifactId: typeof metadataArtifact === 'string' ? metadataArtifact : null,
    p,
  };

  // A backfilled answer (J2.6's rejudge job) opens records like any other but
  // stays out of the rings: seven thousand of them in a minute would flush what
  // the owner's next verdict needs to find the live answers behind a line.
  const late = gradeLate(state.judgement, records, entry, event.ts);
  if (payload.metadata?.backfill === true) return { state: { ...state, judgement: { ...state.judgement, ...late } }, effects: [] };
  // Tagged with an artifact (a notice key, a fact id): its own ring. Otherwise
  // by moment — and two results for one moment (the fan-out and the line's
  // judge) MERGE into one entry, so the ring holds moments, not calls.
  if (entry.artifactId !== null) {
    const ring = [...(state.judgement.recentByArtifact ?? []).filter((r) => r.artifactId !== entry.artifactId), entry];
    const oldestOfSet = ring.filter((r) => r.questionSetId === entry.questionSetId).length > MAX_RECENT_JUDGEMENTS ? ring.find((r) => r.questionSetId === entry.questionSetId) : undefined;
    const recentByArtifact = oldestOfSet ? ring.filter((r) => r !== oldestOfSet) : ring;
    return { state: { ...state, judgement: { ...state.judgement, ...late, recentByArtifact } }, effects: [] };
  }
  const existing = entry.momentId === null ? -1 : state.judgement.recent.findIndex((r) => r.momentId === entry.momentId);
  const recent =
    existing === -1
      ? [...state.judgement.recent, entry].slice(-MAX_RECENT_JUDGEMENTS)
      : state.judgement.recent.map((r, i) => (i === existing ? { ...r, ts: entry.ts, p: { ...r.p, ...entry.p } } : r));
  return {
    state: {
      ...state,
      judgement: { ...state.judgement, ...late, recent },
    },
    effects: [],
  };
};

/**
 * W6 D4's one-time mapping: a state written before question ids were keyed by
 * template holds its records and its rings under wording hashes. Each hash a
 * set still asks is renamed to that question's template id; records that land
 * on one template are pooled. A hash no set asks any more is left as it was.
 * Idempotent (a template id is never a hash), so the boot runs it every time.
 */
export function migrateQuestionIds(judgement: KernelState['judgement']): KernelState['judgement'] {
  const byHash = new Map<string, string>();
  for (const set of QUESTION_SETS) for (const sample of set.samples()) for (const q of Object.values(set.build(...sample).questions)) byHash.set(wordingHash(q), questionId(q));
  const rename = (id: string) => byHash.get(id) ?? id;
  if (!Object.keys(judgement.questions).some((id) => byHash.has(id)) && ![...judgement.recent, ...(judgement.recentByArtifact ?? [])].some((r) => Object.keys(r.p).some((id) => byHash.has(id)))) return judgement;
  const questions: KernelState['judgement']['questions'] = {};
  for (const [id, record] of Object.entries(judgement.questions)) {
    const into = questions[rename(id)];
    if (!into) {
      questions[rename(id)] = record;
      continue;
    }
    const bins = { n: into.bins.n.map((v, d) => v + record.bins.n[d]!), hits: into.bins.hits.map((v, d) => v + record.bins.hits[d]!) };
    const n = into.n + record.n;
    const lastVerdictAt = [into.lastVerdictAt, record.lastVerdictAt].filter((v): v is string => v !== null).sort().at(-1) ?? null;
    questions[rename(id)] = { ...into, n, hits: into.hits + record.hits, bins, lastVerdictAt, threshold: n >= THRESHOLD_MIN_N ? bestThreshold(bins) : defaultThreshold(into.type) };
  }
  const ring = (rows: JudgementRecent[]) => rows.map((r) => ({ ...r, p: Object.fromEntries(Object.entries(r.p).map(([id, v]) => [rename(id), v])) }));
  return { ...judgement, questions, recent: ring(judgement.recent), recentByArtifact: ring(judgement.recentByArtifact ?? []) };
}

