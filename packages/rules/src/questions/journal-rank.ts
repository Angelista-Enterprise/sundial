/**
 * `journal-rank` — which of a day's sessions deserve the page (J2.5). The
 * lab's `journal` flow as a RANKER: a yes/no per moment said "include" on
 * 38/40 and cannot hold a page budget; `prominence` as a graded score can, and
 * its top-6 held 50 % of the moments the real journal mentioned against 15 %
 * at random. The executor ranks every moment of the day by the level it
 * picked and the probability behind it, and hands the text model the top ten.
 *
 * The state is the moment's own evidence (`momentFanoutState`) plus one fixed
 * sentence saying what the answer is for; no other moment is in it, so the
 * scores are comparable across calls (pointwise, PROBES: 83 % > listwise).
 */
import { noul, score, type QuestionSet } from './index.js';
import { momentFanout, momentFanoutState, type MomentFanoutInput } from './moment-fanout.js';

export const JOURNAL_TOP_K = 10;

export const JOURNAL_RANK_QUESTIONS = {
  prominence: score("If included, how much space does this session deserve in the day's journal?", ['A word in passing, at most.', 'One clause in a sentence about the period.', 'Its own sentence.', 'A headline of the day.']),
  is_the_headline: noul('Could this session be THE thing the day is remembered for?'),
};

export const journalRank: QuestionSet<[MomentFanoutInput]> = {
  id: 'journal-rank',
  build: (input) => ({
    state: { ...momentFanoutState({ ...input, openGoals: [], openPromises: [] }), day_so_far_note: "One session out of a whole day. The journal for the day will be one page." },
    questions: JOURNAL_RANK_QUESTIONS,
  }),
  samples: () => momentFanout.samples().map(([moment]) => [moment]),
};

export interface JournalRankAnswer {
  id: string;
  /** The prominence level picked (0–3) and the probability behind it; law 5, law 7 — the decimal is noise. */
  level: number;
  p: number;
  headline: number;
}

/** The top K by level, then by the probability behind the level, then by headline. Stable for ties. */
export function selectJournalMoments(ranked: JournalRankAnswer[], k = JOURNAL_TOP_K): string[] {
  return [...ranked].sort((a, b) => b.level - a.level || b.p - a.p || b.headline - a.headline).slice(0, k).map((r) => r.id);
}
