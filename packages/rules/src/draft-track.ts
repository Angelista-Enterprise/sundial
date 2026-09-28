import type { Draft, Effect, JudgementResultPayload, Rule } from '@sundial/kernel/types.js';
import { judgeDraft, draftJudgementOf } from './questions/judge-draft.js';

const MAX_DRAFTS = 20;
const DRAFT_TTL_MS = 7 * 86_400_000;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * J4.3 — drafts. `assistant:draft` (the `gnomon_draft` tool: the text model
 * wrote an email or a note FROM EVIDENCE it names) opens a card on Today and
 * one `judge-draft` judgement; the answers land on the draft as numbers. The
 * owner's tap — send (opens their mail client; nothing leaves this machine on
 * Gnomon's word) or dismiss — is `draft:closed`. Bounded ring, a week's TTL.
 */
export const draftTrack: Rule = (state, event) => {
  const drafts = state.drafts ?? { recent: [] };
  if (event.type === 'assistant:draft') {
    const p = event.payload as { kind?: unknown; to?: unknown; subject?: unknown; body?: unknown; evidence?: unknown };
    const kind = p.kind === 'email' || p.kind === 'note' ? p.kind : null;
    const subject = text(p.subject, 160);
    const body = text(p.body, 4000);
    if (!kind || subject === '' || body === '') return { state, effects: [] };
    const evidence = Array.isArray(p.evidence) ? p.evidence.filter((e): e is string => typeof e === 'string' && e.trim() !== '').slice(0, 12).map((e) => e.trim().slice(0, 300)) : [];
    const draft: Draft = { id: `draft:${event.id}`, kind, to: text(p.to, 120) || null, subject, body, evidence, at: event.ts, status: 'open', judged: null };
    const built = judgeDraft.build({ kind, to: draft.to, subject, body, evidence });
    const effects: Effect[] = [{ type: 'Judge', purpose: 'judge', questionSetId: judgeDraft.id, momentId: null, delayMs: 0, state: built.state, questions: built.questions, metadata: { artifactId: draft.id, draftId: draft.id } }];
    const recent = [...drafts.recent.filter((d) => Date.parse(event.ts) - Date.parse(d.at) < DRAFT_TTL_MS), draft].slice(-MAX_DRAFTS);
    return { state: { ...state, drafts: { recent } }, effects };
  }
  if (event.type === 'judgement:result') {
    const payload = event.payload as unknown as JudgementResultPayload;
    if (payload.questionSetId !== judgeDraft.id || typeof payload.metadata?.draftId !== 'string') return { state, effects: [] };
    const judged = draftJudgementOf(payload.answers ?? {});
    if (!drafts.recent.some((d) => d.id === payload.metadata?.draftId)) return { state, effects: [] };
    return { state: { ...state, drafts: { recent: drafts.recent.map((d) => (d.id === payload.metadata?.draftId ? { ...d, judged } : d)) } }, effects: [] };
  }
  if (event.type === 'draft:closed') {
    const p = event.payload as { id?: unknown; outcome?: unknown };
    const outcome = p.outcome === 'sent' ? 'sent' : p.outcome === 'dismissed' ? 'dismissed' : null;
    if (typeof p.id !== 'string' || !outcome || !drafts.recent.some((d) => d.id === p.id && d.status === 'open')) return { state, effects: [] };
    return { state: { ...state, drafts: { recent: drafts.recent.map((d) => (d.id === p.id ? { ...d, status: outcome, closedAt: event.ts } : d)) } }, effects: [] };
  }
  return { state, effects: [] };
};
