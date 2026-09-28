import { describe, expect, it } from 'vitest';
import { choice, noul, questionId, score } from './index.js';
import { GOAL_ADVANCE_QUESTIONS, MOMENT_FANOUT_QUESTIONS, momentFanout, PROMISE_RESOLVE_QUESTIONS } from './moment-fanout.js';
import { INGEST_ANOMALY_QUESTIONS } from './ingest-anomaly.js';
import { JOURNAL_RANK_QUESTIONS, journalRank, selectJournalMoments } from './journal-rank.js';
import { actionLevelOf, carriedOutOf, CLASSIFY_ACTION_QUESTIONS, classifyAction, VERIFY_ACTION_QUESTIONS } from './classify-action.js';
import { PERCEIVE_QUESTIONS } from './perceive.js';
import { JUDGE_DRAFT_QUESTIONS } from './judge-draft.js';
import { GRADE_STEP_QUESTIONS } from './grade-step.js';
import { JUDGE_LINE_QUESTIONS } from './judge-line.js';
import { RANK_EVIDENCE_QUESTIONS, rankEvidence, relevance } from './rank-evidence.js';
import { GOAL_SLOT_QUESTIONS, LISTEN_REPLY_QUESTIONS, listenReply } from './listen-reply.js';
import { GATE_FEATURES_QUESTIONS } from './gate-features.js';
import { ROUTE_ASK_QUESTIONS } from './route-ask.js';
import { FORECAST_SETS } from './forecast-targets.js';
import { AUDIT_FACT_QUESTIONS, auditFact } from './audit-fact.js';
import { ALIGN_ALIAS_QUESTIONS, alignAlias } from './align-alias.js';

describe('questionId (law 4)', () => {
  it('two questions differing by one word have different ids', () => {
    const a = noul('Was the owner doing work during this session?');
    const b = noul('Was the owner doing work during that session?');
    expect(questionId(a)).not.toBe(questionId(b));
    expect(questionId(a)).toBe(questionId(noul(a.instructions)));
    expect(questionId(a)).toHaveLength(12);
  });

  it('criteria are part of the id, in their order', () => {
    const a = choice('Which?', { x: 'one', y: 'two' });
    const b = choice('Which?', { x: 'one', y: 'two.' });
    const c = score('How much?', ['low', 'high']);
    expect(new Set([questionId(a), questionId(b), questionId(c)]).size).toBe(3);
  });
});

describe('moment-fanout', () => {
  it('pins every id — a change here is a new question with an empty calibration record', () => {
    const ids = Object.fromEntries(Object.entries(MOMENT_FANOUT_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "contains_blocker": "ee331b018268",
        "contains_commitment": "47730fe77063",
        "depth": "bd7018676e1a",
        "interrupt_ok": "c040e2a2e6a3",
        "is_work": "def513e2110e",
        "subject": "a7084da3f9da",
        "worth_remembering": "8c9613b56e14",
      }
    `);
  });

  it('J2.7: pins the six goal-slot ids — fixed wording pointing at `open_goals.gN`, never the goal text', () => {
    const ids = Object.fromEntries(Object.entries(GOAL_ADVANCE_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "advances_goal_g0": "309b8dd46b80",
        "advances_goal_g1": "31a8b657d4e2",
        "advances_goal_g2": "f96b0f0be8fd",
        "advances_goal_g3": "a3e1703f3356",
        "advances_goal_g4": "443906766e63",
        "advances_goal_g5": "9448196081a6",
      }
    `);
  });

  it('J4.4: pins the four promise-slot ids', () => {
    const ids = Object.fromEntries(Object.entries(PROMISE_RESOLVE_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "resolves_promise_p0": "32008a826593",
        "resolves_promise_p1": "ce2c4e1ed78b",
        "resolves_promise_p2": "37c2d3d17ca5",
        "resolves_promise_p3": "7a4a2b89152f",
      }
    `);
  });

  it('builds the fixed seven for every moment, plus one slot per open goal and per open promise (the first sample carries the full width)', () => {
    const built = momentFanout.samples().map((input) => momentFanout.build(...input));
    expect(Object.keys(built[0].questions)).toEqual([...Object.keys(MOMENT_FANOUT_QUESTIONS), ...Object.keys(GOAL_ADVANCE_QUESTIONS), ...Object.keys(PROMISE_RESOLVE_QUESTIONS)]);
    expect(built[0].state).toMatchObject({ open_goals: { g0: 'a', g5: 'f' }, open_promises: { p0: 'ik stuur het vanavond door' } });
    for (const b of built.slice(1)) expect(b.questions).toBe(MOMENT_FANOUT_QUESTIONS);
    expect(built[1].state).not.toHaveProperty('open_goals');
    expect(built[0].state).toMatchObject({ app: 'Code', project: 'sundial', minutes: 31, git_commits: 1, distinct_window_titles: 2 });
    expect(built[0].state).not.toHaveProperty('life_events');
    expect(built[0].state).not.toHaveProperty('kind');
    // Speech is clipped, and stays in its own language.
    expect((built[1].state.heard_aloud as string).length).toBeLessThanOrEqual(600);
  });
});

describe('ingest-anomaly (J3.7)', () => {
  it('pins the id — the door question the anomaly bench measured', () => {
    expect(questionId(INGEST_ANOMALY_QUESTIONS.claims_about_session)).toMatchInlineSnapshot(`"73810167752f"`);
  });
});

describe('journal-rank (J2.5)', () => {
  it('pins the two ids — the lab wording that ranked top-6 at 50 % vs 15 %', () => {
    const ids = Object.fromEntries(Object.entries(JOURNAL_RANK_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "is_the_headline": "313d692b2ce4",
        "prominence": "abc94fa18961",
      }
    `);
  });
  it('carries the moment alone — no goals, no promises — plus the one fixed note; selects by level, then probability', () => {
    const built = journalRank.build(...journalRank.samples()[0]);
    expect(built.state).not.toHaveProperty('open_goals');
    expect(built.state).toMatchObject({ app: 'Code', day_so_far_note: expect.stringContaining('one page') });
    expect(selectJournalMoments([{ id: 'a', level: 1, p: 0.9, headline: 0 }, { id: 'b', level: 3, p: 0.4, headline: 0.1 }, { id: 'c', level: 3, p: 0.6, headline: 0 }, { id: 'd', level: 0, p: 0.99, headline: 0 }], 2)).toEqual(['c', 'b']);
  });
});

describe('classify-action / verify-action (J4.1, J4.2)', () => {
  it('pins the three ids', () => {
    const ids = Object.fromEntries(Object.entries({ ...CLASSIFY_ACTION_QUESTIONS, ...VERIFY_ACTION_QUESTIONS }).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "carried_out": "8970033735e9",
        "level": "f7f6c46bfe43",
        "stakes": "3ea30b9af459",
      }
    `);
  });
  it('carries the tool and its arguments as a clipped string, and reads the level off the vector', () => {
    const built = classifyAction.build({ tool: 'gnomon_run_shell', args: { command: 'git push' } });
    expect(built.state).toEqual({ tool: 'gnomon_run_shell', arguments: '{"command":"git push"}' });
    expect(actionLevelOf({ level: { type: 'choice', choice: 'outward', probabilities: { outward: 0.8, read: 0.2 } }, stakes: { type: 'score', score: 2.4 } })).toEqual({ level: 'outward', p: 0.8, stakes: 2 });
    expect(actionLevelOf({ level: { type: 'choice', choice: 'nonsense' } })).toBeNull();
    expect(carriedOutOf({ carried_out: { type: 'noul', noul: 0.3 } })).toBe(0.3);
  });
});

describe('perceive (J2.1)', () => {
  it('pins the four ids — raw rates only, benched by the rewritten live flow', () => {
    const ids = Object.fromEntries(Object.entries(PERCEIVE_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "in_flow": "0f10b6a84deb",
        "interruptible": "a98a06b41e53",
        "state": "386d8119724d",
        "stuck": "d83e1f4868f1",
      }
    `);
  });
});

describe('judge-draft (J4.3)', () => {
  it('pins the two ids', () => {
    const ids = Object.fromEntries(Object.entries(JUDGE_DRAFT_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "grounded": "fa15383ca141",
        "tone": "3a12170174af",
      }
    `);
  });
});

describe('grade-step (J5.3)', () => {
  it('pins the id', () => {
    expect(questionId(GRADE_STEP_QUESTIONS.accomplished)).toMatchInlineSnapshot(`"e9c4f8916438"`);
  });
});

describe('judge-line', () => {
  it('pins every id — this is the wording the bench measured', () => {
    const ids = Object.fromEntries(Object.entries(JUDGE_LINE_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "app_only": "1a42ebea1d31",
        "grounded": "7f8f81f4cf41",
        "hedges": "dc7ef9d723fc",
        "names_the_work": "804f360b09c1",
        "quality": "969c954eb54b",
      }
    `);
  });
});

describe('rank-evidence', () => {
  it('pins the twelve slot ids — the wording the bench measured', () => {
    const ids = Object.fromEntries(Object.entries(RANK_EVIDENCE_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "c0": "6849d01d6175",
        "c1": "cb30a9d2f072",
        "c10": "40c6c20ff19d",
        "c11": "cdf075c29373",
        "c2": "5c7b157f55ad",
        "c3": "a9fe7410f331",
        "c4": "04d12c84c18e",
        "c5": "1a0b8a560ed1",
        "c6": "4086f2891610",
        "c7": "45b4f62686ec",
        "c8": "a5dc65734055",
        "c9": "89ac527fe5c3",
      }
    `);
  });

  it('builds one slot question per candidate, clips each, and reads relevance as P(level ≥ 2)', () => {
    const built = rankEvidence.build({ question: 'q', candidates: ['a', 'b'.repeat(500)] });
    expect(Object.keys(built.questions)).toEqual(['c0', 'c1']);
    expect((built.state.candidates as Record<string, string>).c1.length).toBe(300);
    expect(relevance({ probabilities: { '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.4 } })).toBeCloseTo(0.7);
    expect(relevance({ score: 1 })).toBe(0);
    expect(relevance(undefined)).toBeNull();
  });
});

describe('listen-reply', () => {
  it('pins every id, the six goal slots included', () => {
    const ids = Object.fromEntries(Object.entries({ ...LISTEN_REPLY_QUESTIONS, ...GOAL_SLOT_QUESTIONS }).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "answered": "85a579779a5c",
        "asks_assistant_to_do_something": "c7cbeeaa7a5b",
        "contains_decision": "b80d45baf8ea",
        "contains_followup": "f1eeee92efcb",
        "goal_g0": "82d2ecee1188",
        "goal_g1": "8d5904846802",
        "goal_g2": "ff824933818c",
        "goal_g3": "40f32007b635",
        "goal_g4": "d7a74f35688e",
        "goal_g5": "606161b61692",
        "mentions_people": "6a9fb6d9bc7c",
        "sentiment": "6d137c039d66",
        "wants_transcript_attached": "585c08941ae2",
        "worth_remembering": "65427c8e209a",
      }
    `);
  });

  it('adds one goal question per open goal and none when the ask was not about goals', () => {
    const goals = listenReply.build({ question: 'q', reason: null, answer: 'drop b', openGoals: ['a', 'b'] });
    expect(Object.keys(goals.questions)).toContain('goal_g1');
    expect(goals.state.open_goals).toEqual({ g0: 'a', g1: 'b' });
    const meeting = listenReply.build({ question: 'q', reason: null, answer: 'fine', openGoals: [] });
    expect(Object.keys(meeting.questions)).not.toContain('goal_g0');
    expect(meeting.state).not.toHaveProperty('open_goals');
  });
});

describe('gate-features', () => {
  it('pins every id — the wording J5.1 will learn a gate from', () => {
    const ids = Object.fromEntries(Object.entries(GATE_FEATURES_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "actionable": "24e4780a22e1",
        "channel": "7de19e98ffc8",
        "speak_now": "297928d33ed2",
        "stale_soon": "9e024b8c3054",
        "value": "857cde532ca1",
      }
    `);
  });
});

describe('route-ask', () => {
  it('pins every id — seventeen tools, three more', () => {
    const ids = Object.fromEntries(Object.entries(ROUTE_ASK_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(Object.keys(ids)).toHaveLength(20);
    expect(ids).toMatchInlineSnapshot(`
      {
        "about_the_assistant": "4aaf2239cb03",
        "difficulty": "2b1a2df864d7",
        "gnomon_anomalies": "51e1fffc09ac",
        "gnomon_board_traffic": "b43c67b6fd07",
        "gnomon_code_activity": "dcd4510819c6",
        "gnomon_compose_figure": "60c385a1148d",
        "gnomon_current_context": "bb7a7f24e8fd",
        "gnomon_entity_history": "efdf91bb24b4",
        "gnomon_goals": "e210c4409678",
        "gnomon_llm_ledger": "997272b1749e",
        "gnomon_moment_detail": "55200e8dec21",
        "gnomon_open_commitments": "5a42f322efb3",
        "gnomon_people": "1209b9bc0ed3",
        "gnomon_project_status": "b79b314f6967",
        "gnomon_recent_activity": "33ebb9de7cb6",
        "gnomon_routines": "f209c4346d3c",
        "gnomon_semantic_search": "53613ac244da",
        "gnomon_signals": "80c6c1c9a641",
        "gnomon_today_summary": "8a61b484571b",
        "needs_live_data": "d1746003cba3",
      }
    `);
  });
});

describe('forecast-*', () => {
  it('pins the three target ids, and a state of numbers with the prior named as one', () => {
    const ids = Object.fromEntries(FORECAST_SETS.map((set) => [set.id, questionId(set.question)]));
    expect(ids).toMatchInlineSnapshot(`
      {
        "forecast-meeting-overrun": "3cf6620c1a8e",
        "forecast-project-switch-30": "26dbf67a7011",
        "forecast-return-today": "ba39262a7504",
      }
    `);
    const built = FORECAST_SETS[0].build({ features: { local_hour: 9, switches_last_60_min: 2 }, historicallyTrueThisOften: 0.6123 });
    expect(built.state).toMatchObject({ historically_true_this_often: 0.612, features: { local_hour: 9 } });
    expect(Object.keys(built.questions)).toEqual(['yes']);
  });
});

describe('audit-fact', () => {
  it('pins every id — four questions over one belief', () => {
    const ids = Object.fromEntries(Object.entries(AUDIT_FACT_QUESTIONS).map(([key, q]) => [key, questionId(q)]));
    expect(Object.keys(ids)).toHaveLength(4);
    expect(ids).toMatchInlineSnapshot(`
      {
        "is_artifact": "96abb50d111f",
        "is_false": "412dcdc2591e",
        "still_current": "a342ae968d09",
        "usefulness": "1618c72d726e",
      }
    `);
  });

  it('carries the claim as words and the evidence as numbers, clipped', () => {
    const [long] = auditFact.samples()[1];
    const built = auditFact.build(long);
    expect(built.state).toMatchObject({ subject: 'Pat', subject_kind: 'owner', predicate: 'dislikes', held_at_confidence_0_to_100: 75, how_it_was_learned: 'conversation', first_recorded_days_ago: 3, supporting_observations: 13.9, contradicting_observations: 4.7 });
    expect((built.state.object as string).length).toBeLessThanOrEqual(200);
    expect((built.state.belief as string).length).toBeLessThanOrEqual(300);
  });
});

describe('audit-fact evidence', () => {
  it('carries the session counts as numbers when given, and nothing when not', () => {
    const [withEvidence] = auditFact.samples()[2];
    expect(auditFact.build(withEvidence).state.evidence).toEqual({ sessions_in_project: 1353, sessions_with_this_tool_in_project: 0, sessions_with_this_tool_anywhere: 1 });
    expect(auditFact.build(auditFact.samples()[0][0]).state.evidence).toBeUndefined();
  });
});

describe('align-alias', () => {
  it('pins its one id, and carries a known-as name only when there is one', () => {
    expect(questionId(ALIGN_ALIAS_QUESTIONS.same)).toMatchInlineSnapshot(`"fc092bcc1574"`);
    const [person] = alignAlias.samples()[1];
    expect(alignAlias.build(person).state).toMatchObject({ entity_kind: 'person', name_a: 'person-c205ca11f2', name_b: 'Alex Morgan', name_a_also_known_as: 'Alex Morgan' });
    expect(alignAlias.build(alignAlias.samples()[0][0]).state).not.toHaveProperty('name_a_also_known_as');
  });
});
