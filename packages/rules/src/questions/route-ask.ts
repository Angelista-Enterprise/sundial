/**
 * `route-ask` — which data sources a question needs, before the text model
 * runs (J1.4). The lab's `route` flow: top-1 tool used 62.5 %, mean per-tool
 * AUC 0.80, set overlap 0.33 — the loop over-calls. One noul per tool (a set,
 * not a choice: sources are not exclusive), plus needs-live, about-the-
 * assistant, and difficulty for tier routing (J1.10).
 *
 * The vocabulary is this file's own short descriptions, not the registry's
 * long ones: a description edit would otherwise re-key every threshold
 * (law 4), and the registry's text is written for the model that CALLS the
 * tool, not for the judge that predicts the call. Add a tool here when it is
 * added there; the lint keeps the state short.
 */
import type { JudgeQuestion } from '@sundial/kernel/types.js';
import { clip, noul, score, type QuestionSet } from './index.js';

export const ROUTE_TOOLS: Record<string, string> = {
  gnomon_current_context: 'What the owner is doing right now: open moment, app, project.',
  gnomon_recent_activity: 'The last hours of sessions, in order.',
  gnomon_today_summary: 'A summary of today so far.',
  gnomon_code_activity: 'Commits, branches, and coding sessions per project.',
  gnomon_project_status: 'Where a named project stands: recent work, open branches.',
  gnomon_open_commitments: 'Branches and tasks started but not finished.',
  gnomon_entity_history: 'Everything recorded about a named person, project, tool or topic over time.',
  gnomon_people: 'Who the owner has met or worked with, and when.',
  gnomon_semantic_search: 'Free-text search over all recorded memory.',
  gnomon_signals: 'Raw sensor events in a time window.',
  gnomon_moment_detail: 'Full detail of one session by id.',
  gnomon_anomalies: "Unusual patterns compared with the owner's normal days.",
  gnomon_routines: 'Recurring patterns: when the owner usually does what.',
  gnomon_goals: "The owner's stated goals and progress against them.",
  gnomon_llm_ledger: 'What the assistant itself has spent on model calls.',
  gnomon_board_traffic: "Activity on the owner's task board.",
  gnomon_compose_figure: 'Draw a chart or figure from data already retrieved.',
};

export const ROUTE_TOOL_QUESTIONS: Record<string, JudgeQuestion> = Object.fromEntries(
  Object.entries(ROUTE_TOOLS).map(([name, what]) => [name, noul(`To answer the owner's question in \`question\`, would the assistant need this data source: ${what}`)]),
);

export const ROUTE_ASK_QUESTIONS: Record<string, JudgeQuestion> = {
  ...ROUTE_TOOL_QUESTIONS,
  needs_live_data: noul('Does answering `question` require knowing what the owner is doing right now, as opposed to history?'),
  about_the_assistant: noul("Is `question` about the assistant itself — its tools, its abilities, its cost — rather than about the owner's life and work?"),
  difficulty: score('How hard is `question` to answer well?', ['Trivial: one lookup, one sentence.', 'Simple: one data source, a short summary.', 'Involved: several sources combined and compared.', 'Hard: judgement over the whole history, or an ambiguous question.']),
};

export interface RouteAskInput {
  question: string;
}

export const routeAsk: QuestionSet<[RouteAskInput]> = {
  id: 'route-ask',
  build: (input) => ({ state: { question: clip(input.question), available_data_sources: ROUTE_TOOLS }, questions: ROUTE_ASK_QUESTIONS }),
  samples: () => [[{ question: 'What was I working on yesterday afternoon, and did I finish it?' }], [{ question: 'x'.repeat(900) }]],
};
