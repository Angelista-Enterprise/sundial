/**
 * `audit-fact` — one live belief, put to the judge nightly (J2.3).
 *
 * The lab's `belief` flow wording for `is_false`/`is_artifact`/`usefulness`
 * (artifact detection looked real there; its `superseded` label did not —
 * replaced is not wrong), plus `still_current` for the Beta update. The bench
 * that earns it is synthetic corruption (the skeptic guide's method): a share
 * of real facts flipped to a plausible wrong object borrowed from another fact
 * of the same predicate — detection rate against false-positive rate, where the
 * false positives are the number that matters (a wrong retraction removes
 * something true).
 *
 * State (law 2, 7): the claim as words, and the evidence as numbers — the held
 * confidence, how it was learned, its age, and the two Beta counts. No verdict
 * of ours travels in it.
 */
import { clip, noul, score, type QuestionSet } from './index.js';

export interface AuditFactInput {
  subject: string;
  subjectKind: string;
  predicate: string;
  object: string;
  confidence: number;
  provenance: string;
  firstRecordedDaysAgo: number;
  alpha: number;
  beta: number;
  /**
   * The log's own count behind a `project usesTool X` belief, via the
   * entity→path map (`projectEntityId`): written moments of that project, how
   * many ran this process, and how many moments anywhere did. Numbers only
   * (law 7). Absent for every other predicate. The evidence sweep of
   * 2026-09-22 moved is_false monotonically with a zero count (AUC 0.54 → 0.66
   * against the owner's retractions) — Jev reads numbers, and 78 of 131 live
   * tool facts had none.
   */
  evidence?: { sessionsInProject: number; sessionsWithThisToolInProject: number; sessionsWithThisToolAnywhere: number };
}

export const AUDIT_CONTEXT = "The owner is a software developer. The assistant learned these beliefs from window titles, git activity, calendar entries, speech, and the owner's own statements.";

export const AUDIT_FACT_QUESTIONS = {
  is_false: noul('Is `belief` actually false?', {
    true: 'The claim is wrong, self-contradictory, or a parsing artifact — a file path, UI label or window-title fragment mistaken for a name.',
    false: 'The claim is plausible, or there is not enough here to call it wrong.',
  }),
  is_artifact: noul('Is `belief` a parsing artifact — a file path, a UI label, a placeholder, a fragment — rather than a real fact about a person, project, tool or topic?'),
  still_current: noul('Is `belief` likely still true today, given when it was first recorded and how often it has been supported since?', {
    true: 'It still holds.',
    false: 'It has probably lapsed: a status, a tool or a collaboration that has since changed.',
  }),
  usefulness: score('How useful is `belief` for an assistant that wants to understand the owner?', ['Noise: says nothing real.', 'Trivial: true but nobody would ask.', 'Useful: helps interpret what the owner does.', 'Core: central to who the owner is or what they work on.']),
};

export const auditFact: QuestionSet<[AuditFactInput]> = {
  id: 'audit-fact',
  build: (f) => ({
    state: {
      subject: clip(f.subject, 120),
      subject_kind: f.subjectKind,
      belief: clip(`${f.subject} ${f.predicate} ${f.object}`, 300),
      predicate: f.predicate,
      object: clip(f.object, 200),
      held_at_confidence_0_to_100: Math.round(f.confidence),
      how_it_was_learned: f.provenance,
      first_recorded_days_ago: Math.round(f.firstRecordedDaysAgo),
      supporting_observations: Math.round(f.alpha * 10) / 10,
      contradicting_observations: Math.round(f.beta * 10) / 10,
      ...(f.evidence
        ? { evidence: { sessions_in_project: f.evidence.sessionsInProject, sessions_with_this_tool_in_project: f.evidence.sessionsWithThisToolInProject, sessions_with_this_tool_anywhere: f.evidence.sessionsWithThisToolAnywhere } }
        : {}),
      context: AUDIT_CONTEXT,
    },
    questions: AUDIT_FACT_QUESTIONS,
  }),
  samples: () => [
    [{ subject: 'overture', subjectKind: 'project', predicate: 'usesTool', object: 'Studio by Spotify Labs', confidence: 69, provenance: 'inference', firstRecordedDaysAgo: 41, alpha: 4.5, beta: 2 }],
    [{ subject: 'Pat', subjectKind: 'owner', predicate: 'dislikes', object: 'x'.repeat(900), confidence: 75, provenance: 'conversation', firstRecordedDaysAgo: 3, alpha: 13.9, beta: 4.7 }],
    [{ subject: 'sundial', subjectKind: 'project', predicate: 'usesTool', object: 'Photos', confidence: 62, provenance: 'inference', firstRecordedDaysAgo: 30, alpha: 4.6, beta: 1, evidence: { sessionsInProject: 1353, sessionsWithThisToolInProject: 0, sessionsWithThisToolAnywhere: 1 } }],
  ],
};
