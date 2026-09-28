import type { FeedbackSolicitation, KernelState, Rule } from '@sundial/kernel/types.js';

/**
 * The ASKING half of the feedback loop (enhancements/outcome-feedback-signal).
 *
 * The return path — `feedback:verdict`, `state.feedback`, `POST /feedback`,
 * `gnomon feedback`, macOS verdict buttons, and (842d46b) a consumer that
 * retracts a fact on a `wrong` verdict — all shipped, but nothing ever ASKED the
 * owner to rate anything. So every verdict was volunteered, `solicited` was
 * always false, and A07 ("never say something wrong", needs enough ratings to
 * trust a rate) and A15 ("glad it spoke up", a rate over SOLICITED items) were
 * unmeasurable by construction, not for want of a metric.
 *
 * This rule opens exactly one rating request at a time, for the newest companion
 * insight the owner has neither rated nor been asked about, and clears it when it
 * expires unanswered. `feedbackTrack` clears it when answered and — because the
 * open request names the artifact — marks the answering verdict `solicited:true`
 * from the reducer, so a solicited rating is recorded whichever surface submits
 * it. No new client flag, transport, or table: the ask is a field on
 * `state.feedback` that `GET /state` already serves.
 *
 * Deliberately scoped to `knowledge_entry` insights. A15 is about VOLUNTEERED
 * items — the proactive things Gnomon says — which are exactly the companion
 * insights; a moment or a fact is an observation, not something Gnomon chose to
 * surface, so asking "was this welcome?" about one is a category error.
 */

/** One open request at a time; an ignored ask expires after this so the next insight can be asked about. Silence is never recorded as a verdict. */
const SOLICITATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Don't pester about a stale insight — only ask about ones produced within this window. */
const INSIGHT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Bound on `solicitedRecently`, matching the `recentInsights` cap it shadows. */
const MAX_SOLICITED_RECENTLY = 30;

export const solicitFeedback: Rule = (state, event) => {
  if (event.type !== 'clock:tick') return { state, effects: [] };

  const now = Date.parse(event.ts);
  const open = state.feedback.solicitation;

  // An open ask blocks a new one. Expire it if the owner has left it unanswered
  // past the TTL — dropping it is not a verdict (an ignored question is not a
  // `no`), it just unblocks the next insight.
  if (open) {
    if (now - Date.parse(open.ts) < SOLICITATION_TTL_MS) return { state, effects: [] };
    return {
      state: { ...state, feedback: { ...state.feedback, solicitation: null } },
      effects: [],
    };
  }

  const alreadyHandled = new Set<string>([
    ...state.feedback.recent.map((f) => f.artifactId),
    ...state.feedback.solicitedRecently,
  ]);

  // Newest first: ask about the most recent unrated, unasked, still-fresh
  // insight that carries a real id (snapshots predating the id field don't).
  const candidate = [...state.memory.recentInsights].reverse().find((i) => {
    if (!i.id || alreadyHandled.has(i.id)) return false;
    return now - Date.parse(i.createdAt) <= INSIGHT_FRESH_MS;
  });
  if (!candidate?.id) return { state, effects: [] };

  const solicitation: FeedbackSolicitation = {
    artifactKind: 'knowledge_entry',
    artifactId: candidate.id,
    question: `Was this useful? “${candidate.title}”`,
    ts: event.ts,
  };
  const feedback: KernelState['feedback'] = {
    ...state.feedback,
    solicitation,
    solicitedRecently: [...state.feedback.solicitedRecently, candidate.id].slice(-MAX_SOLICITED_RECENTLY),
  };

  return {
    state: { ...state, feedback },
    // Observability only (the executor logs it); the ask reaches surfaces via
    // `state.feedback.solicitation` over `GET /state`, not this channel.
    effects: [{ type: 'Notify', channel: 'feedback-solicitation', payload: { artifactId: candidate.id, question: solicitation.question } }],
  };
};
