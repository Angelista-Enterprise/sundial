import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { routeIdOfKey } from '@sundial/helpers/screen-routes.js';
import type { Effect, KernelState, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { approvalTrack } from './approval-track.js';
import { byGnomon } from './by-gnomon.js';
import { contradictionCheck } from './contradiction-check.js';
import { loopTrack } from './loop-track.js';
import { rigSessions } from './rig-sessions.js';
import { CLUSTER_MIN, DROP_SKILL_AFTER, SKILL_DAYS, SKILL_MIN, selfReview } from './self-review.js';
import { MAX_JOBS_PER_DAY, MAX_REVIEWS_PER_DAY, REVIEW_GAP_MS, workbench } from './workbench.js';

let seq = 0;
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (type: string, s: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `e${++seq}`, type, ts: at(s), payload, sanitized: true });
const failed = (s: number, extra: Record<string, unknown> = {}) => ev('screen:step', s, { id: `act-${++seq}`, processName: 'Spotify', verb: 'press', role: 'button', screenText: ['Play'], goal: 'play the album', session: 's1', ok: false, reason: 'not-found', ...extra });
const fails = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => failed(i, extra));
const route = (s: number, session: string, object = 'press button "Play"') => ev('entity:fact-candidate', s, { entityId: 'app:spotify', entityKind: 'app', canonicalName: 'Spotify', predicate: 'routeWorks', object, confidence: 70, sourceEventId: `x${s}`, projectId: null, provenance: 'act', session });

const RULES: Rule[] = [byGnomon, rigSessions, loopTrack, approvalTrack, workbench, selfReview];

/** The rules in manifest order; every event a rule emits re-enters the fold, as the executor does. */
function fold(events: SanitizedEvent[], state: KernelState = createInitialState('d')) {
  const emitted: SanitizedEvent[] = [];
  const effects: Effect[] = [];
  const queue = [...events];
  while (queue.length > 0) {
    const event = queue.shift()!;
    for (const rule of RULES) {
      const out = rule(state, event);
      state = out.state;
      for (const effect of out.effects) {
        effects.push(effect);
        if (effect.type === 'EmitEvent') {
          emitted.push(effect.event as SanitizedEvent);
          queue.push(effect.event as SanitizedEvent);
        }
      }
    }
  }
  return { state, emitted, effects, of: (type: string) => emitted.filter((e) => e.type === type) };
}

describe('selfReview: clusters of Gnomon\'s own failed steps', () => {
  it('stays bounded: 8 clusters, 32 counted ids, 5 steps in words', () => {
    const many = Array.from({ length: 40 }, (_, i) => failed(i, { processName: `App${i % 20}` }));
    const { state } = fold([...many, ...fails(9, { processName: 'Notes' })]);
    expect(Object.keys(state.selfReview!.pending).length).toBeLessThanOrEqual(8);
    expect(state.selfReview!.seen.length).toBeLessThanOrEqual(32);
    expect(state.selfReview!.pending['Notes\ns1\nnot-found']).toMatchObject({ n: 9 });
    expect(state.selfReview!.pending['Notes\ns1\nnot-found']!.steps).toHaveLength(5);
    expect(state.selfReview!.pending['Notes\ns1\nnot-found']!.steps[0]).toBe('press button "Play" (not-found)');
  });

  it('counts an act the app refused and the step it wrote once, under the same id', () => {
    const acted = ev('screen:acted', 0, { id: 'act-x', outcome: 'refused', reason: 'not-found', target: { processName: 'Spotify' } });
    const { state } = fold([acted, failed(1, { id: 'act-x' })]);
    const clusters = Object.values(state.selfReview!.pending);
    expect(clusters.reduce((n, c) => n + c.n, 0)).toBe(1);
  });

  it('a clean step, or a step that worked, counts nothing', () => {
    expect(fold([failed(0, { ok: true, changed: true })]).state.selfReview).toBeUndefined();
  });
});

describe('selfReview: the trigger is idle, a chat\'s end or a freed slot, a count, and a spare slot; never a clock', () => {
  it('asks for one review job on idle once a cluster reached its count, and the workbench opens it', () => {
    const { of, state } = fold([...fails(CLUSTER_MIN), ev('idle:start', 10)]);
    expect(of('work:requested')).toHaveLength(1);
    expect(of('work:requested')[0]!.payload).toMatchObject({ subject: 'Spotify', by: 'review', review: { app: 'Spotify', session: 's1', kind: 'not-found', n: CLUSTER_MIN } });
    expect(state.workbench.open).toMatchObject({ kind: 'self-review', subject: 'Spotify', detail: { app: 'Spotify', cluster: 'not-found', failures: String(CLUSTER_MIN) } });
    // Its own budget: the day's spare-time jobs are untouched.
    expect(state.workbench.countToday).toBe(0);
  });

  it('a clock tick, a day boundary or the owner coming back asks for nothing', () => {
    for (const type of ['clock:tick', 'day:boundary', 'idle:end']) expect(fold([...fails(CLUSTER_MIN), ev(type, 10)]).of('work:requested'), type).toEqual([]);
  });

  it('below the count, idle asks for nothing', () => {
    expect(fold([...fails(CLUSTER_MIN - 1), ev('idle:start', 10)]).of('work:requested')).toEqual([]);
  });

  it('a chat ending its turn reviews only its own clusters', () => {
    expect(fold([...fails(CLUSTER_MIN), ev('chat:said', 10, { sessionId: 's2', text: 'done' })]).of('work:requested')).toEqual([]);
    expect(fold([...fails(CLUSTER_MIN), ev('chat:said', 10, { sessionId: 's1', text: 'done' })]).of('work:requested')).toHaveLength(1);
  });

  it('never takes the slot from foreground work: an open job, a queue, the day\'s reviews spent, the gap after the last review, an open breaker', () => {
    const base = createInitialState('d');
    const job = { id: 'j', kind: 'owner-request' as const, key: 'k', subject: 's', reason: 'r', detail: {}, openedAt: at(-60) };
    const busy: KernelState[] = [
      { ...base, workbench: { ...base.workbench, open: job } },
      { ...base, workbench: { ...base.workbench, queue: [job] } },
      { ...base, workbench: { ...base.workbench, reviews: { day: '2026-11-12', n: MAX_REVIEWS_PER_DAY, last: at(-3000) } } },
      { ...base, workbench: { ...base.workbench, reviews: { day: '2026-11-12', n: 1, last: at(-120) } } },
      { ...base, reliability: { ...base.reliability, llm: { openai: { streak: 3, openedAt: at(0), openUntil: at(3600), days: {} } } } } as unknown as KernelState,
    ];
    for (const state of busy) {
      const out = fold([...fails(CLUSTER_MIN), ev('idle:start', 10)], state);
      expect(out.of('work:requested')).toEqual([]);
      // The cluster waits for the next trigger.
      expect(out.state.selfReview!.pending['Spotify\ns1\nnot-found']).toMatchObject({ n: CLUSTER_MIN });
    }
  });

  // Set 3 R4: on a copy of the record the review asked 6 times in two weeks while 1637 triggers with a ripe cluster
  // found the day's 3 jobs already spent by Gnomon's own spare-time picks. A review spends a budget of its own.
  // Owner, 2026-11-15: the gap rules; the day's ceiling only stops a runaway.
  it('the gap rules: a fourth review in a day still asks once the gap after the last one has passed', () => {
    const base = createInitialState('d');
    const three = { ...base, workbench: { ...base.workbench, reviews: { day: '2026-11-12', n: 3, last: at(-2 * (REVIEW_GAP_MS / 1000)) } } };
    const out = fold([...fails(CLUSTER_MIN), ev('idle:start', 10)], three);
    expect(out.of('work:requested')).toHaveLength(1);
    expect(out.state.workbench.reviews).toEqual({ day: '2026-11-12', n: 4, last: at(10) });
    expect(MAX_REVIEWS_PER_DAY).toBe(12);
  });

  // Fable LOW: the ceiling was counted from `recent`, 20 closed jobs of any kind; a busy day pushed the reviews out.
  it('the day\'s ceiling holds when other jobs pushed every review out of the closed-job ring, and a new day starts at 0', () => {
    const base = createInitialState('d');
    const other = (i: number) => ({ id: `o${i}`, kind: 'owner-request' as const, key: `k${i}`, subject: 's', reason: 'r', detail: {}, openedAt: at(-7200 + i), closedAt: at(-7000 + i), outcome: 'shelved' as const, title: 't' });
    const busy = { ...base, workbench: { ...base.workbench, recent: Array.from({ length: 20 }, (_, i) => other(i)), reviews: { day: '2026-11-12', n: MAX_REVIEWS_PER_DAY, last: at(-7200) } } };
    expect(fold([...fails(CLUSTER_MIN), ev('idle:start', 10)], busy).of('work:requested')).toEqual([]);
    const yesterday = { ...busy, workbench: { ...busy.workbench, reviews: { day: '2026-11-11', n: MAX_REVIEWS_PER_DAY, last: at(-90_000) } } };
    expect(fold([...fails(CLUSTER_MIN), ev('idle:start', 10)], yesterday).of('work:requested')).toHaveLength(1);
  });

  it('the day\'s jobs spent by Gnomon\'s own picks, or a job that closed a minute ago, do not starve the review; it spends none of them', () => {
    const base = createInitialState('d');
    const job = { id: 'j', kind: 'owner-request' as const, key: 'k', subject: 's', reason: 'r', detail: {}, openedAt: at(-600) };
    const spent = { ...base, workbench: { ...base.workbench, day: '2026-11-12', countToday: MAX_JOBS_PER_DAY, recent: [{ ...job, closedAt: at(-60), outcome: 'shelved' as const, title: 't' }] } };
    const out = fold([...fails(CLUSTER_MIN), ev('idle:start', 10)], spent);
    expect(out.of('work:requested')).toHaveLength(1);
    expect(out.state.workbench.open).toMatchObject({ kind: 'self-review' });
    expect(out.state.workbench.countToday).toBe(MAX_JOBS_PER_DAY);
  });

  it('a ripe cluster that waited on a busy slot is reviewed when the slot comes free (work:closed), not at the next idle only', () => {
    const base = createInitialState('d');
    const job = { id: 'j', kind: 'owner-request' as const, key: 'k', subject: 's', reason: 'r', detail: {}, openedAt: at(-60) };
    const busy = fold([...fails(CLUSTER_MIN), ev('idle:start', 10)], { ...base, workbench: { ...base.workbench, open: job } });
    expect(busy.of('work:requested')).toEqual([]);
    const freed = fold([ev('work:closed', 20, { jobId: 'j', outcome: 'nothing' })], busy.state);
    expect(freed.of('work:requested')).toHaveLength(1);
  });

  it('one request per cluster: the next idle asks again only for a new cluster', () => {
    const first = fold([...fails(CLUSTER_MIN), ev('idle:start', 10)]);
    const again = fold([ev('idle:end', 20), ev('idle:start', 4000)], { ...first.state, workbench: { ...first.state.workbench, open: null, countToday: 0, recent: [] } });
    expect(again.of('work:requested')).toEqual([]);
  });
});

describe('selfReview: one proposal on the shelf, applied only on the owner\'s Keep', () => {
  const asked = () => fold([...fails(CLUSTER_MIN), ev('idle:start', 10)]);
  const shelved = (review: Record<string, unknown>) => {
    const first = asked();
    const jobId = first.state.workbench.open!.id;
    const shelf = ev('work:shelved', 60, { jobId, title: 'Spotify: drop a route', body: 'It kept failing.', review });
    const out = fold([shelf], first.state);
    const shelfId = out.of('review:proposed')[0]?.payload.shelfId as string;
    return { ...out, shelfId };
  };

  it('holds the proposal and logs review:proposed, with nothing applied', () => {
    const { state, of, shelfId } = shelved({ kind: 'drop-route', routeKey: 'play the album' });
    expect(of('review:proposed')[0]!.payload).toMatchObject({ app: 'Spotify', kind: 'drop-route', cluster: 'not-found', n: CLUSTER_MIN });
    expect(state.selfReview!.proposed[shelfId]).toMatchObject({ kind: 'drop-route', app: 'Spotify', routeKey: 'play the album' });
    expect(of('screen:route-dropped')).toEqual([]);
  });

  it('a proposal is about the job\'s own app whatever it names, and one of an unknown kind is not held', () => {
    const other = shelved({ kind: 'drop-route', routeKey: 'x', app: 'Mail' });
    expect(other.state.selfReview!.proposed[other.shelfId]!.app).toBe('Spotify');
    expect(shelved({ kind: 'delete-everything' }).of('review:proposed')).toEqual([]);
    expect(shelved({ kind: 'fact', predicate: 'Bad Predicate!', object: 'x' }).of('review:proposed')).toEqual([]);
  });

  it('Not now or Wrong dismisses it and applies nothing', () => {
    for (const verdict of ['not-now', 'wrong']) {
      const { state, shelfId } = shelved({ kind: 'drop-route', routeKey: 'play the album' });
      const out = fold([ev('feedback:verdict', 90, { artifactKind: 'knowledge_entry', artifactId: shelfId, verdict })], state);
      expect(out.of('review:dismissed')[0]!.payload).toMatchObject({ shelfId, verdict });
      expect(out.of('screen:route-dropped')).toEqual([]);
      expect(out.state.selfReview!.proposed[shelfId]).toBeUndefined();
    }
  });

  it('the shelf row says in words what Keep will do, for each kind', () => {
    const body = (review: Record<string, unknown>) => {
      const row = shelved(review).effects.find((e) => e.type === 'WriteDB') as Extract<Effect, { type: 'WriteDB' }> | undefined;
      return (row?.row as { body?: string } | undefined)?.body ?? '';
    };
    expect(body({ kind: 'drop-route', routeKey: 'play the album' })).toContain('Keep drops the route "play the album" in Spotify.');
    expect(body({ kind: 'app-note', line: 'Play sits under the Playback menu.' })).toContain('Keep adds this note for Spotify: Play sits under the Playback menu.');
    expect(body({ kind: 'fact', predicate: 'menuHolds', object: 'Playback > Play' })).toContain('Keep records: Spotify menuHolds Playback > Play.');
    expect(body({ kind: 'delete-everything' })).not.toContain('Keep ');
  });

  it('Keep applies it: a route dropped by the review, an app note for the brief, a fact as Gnomon\'s act, never as the owner\'s word', () => {
    const keep = (review: Record<string, unknown>) => {
      const { state, shelfId } = shelved(review);
      return fold([ev('feedback:verdict', 90, { artifactKind: 'knowledge_entry', artifactId: shelfId, verdict: 'useful' })], state);
    };
    const dropped = keep({ kind: 'drop-route', routeKey: 'play the album' });
    expect(dropped.of('screen:route-dropped')[0]!.payload).toEqual({ app: 'Spotify', routeKey: 'play the album', by: 'review' });
    expect(dropped.of('review:accepted')[0]!.payload).toMatchObject({ app: 'Spotify', kind: 'drop-route' });
    expect(keep({ kind: 'app-note', line: 'Play sits under the Playback menu.' }).state.selfReview!.notes).toMatchObject([{ app: 'Spotify', line: 'Play sits under the Playback menu.' }]);
    expect(keep({ kind: 'fact', predicate: 'menuHolds', object: 'Playback > Play' }).of('entity:fact-candidate')[0]!.payload).toMatchObject({ entityKind: 'app', canonicalName: 'Spotify', predicate: 'menuHolds', object: 'Playback > Play', provenance: 'act' });
    // The owner pressed Keep on words a model wrote: one sighting of an act-derived fact, not an assertion that promotes at once.
    let memory = createInitialState('d');
    const upserts = keep({ kind: 'fact', predicate: 'menuHolds', object: 'Playback > Play' }).of('entity:fact-candidate').flatMap((c) => {
      const out = contradictionCheck(memory, c);
      memory = out.state;
      return out.effects.filter((e) => e.type === 'UpsertEntityFact');
    });
    expect(upserts).toEqual([]);
  });

  it('a verdict on any other shelf row is not the review\'s', () => {
    const { state } = shelved({ kind: 'drop-route', routeKey: 'play the album' });
    expect(fold([ev('feedback:verdict', 90, { artifactKind: 'knowledge_entry', artifactId: 'other', verdict: 'useful' })], state).of('review:accepted')).toEqual([]);
  });
});

describe('selfReview: a route that ran clean on more than one day is offered as a skill, the moment it qualifies', () => {
  // Twelve hours apart: three runs land on two owner-local days in any zone.
  const clean = (n: number, gap = 43_200) => Array.from({ length: n }, (_, i) => route(i * gap, `s${i}`));
  it(`offers it at ${SKILL_MIN} clean runs on ${SKILL_DAYS} days, not before, once`, () => {
    expect([SKILL_MIN, SKILL_DAYS]).toEqual([3, 2]);
    expect(fold(clean(SKILL_MIN - 1)).of('review:proposed')).toEqual([]);
    const out = fold(clean(SKILL_MIN + 2));
    expect(out.of('review:proposed')).toHaveLength(1);
    expect(out.of('review:proposed')[0]!.payload).toMatchObject({ app: 'Spotify', kind: 'skill' });
    // On the run that crossed the line, not at the next idle or clock.
    expect(out.of('review:proposed')[0]!.ts).toBe(at((SKILL_MIN - 1) * 43_200));
  });

  it('runs all on one day (same-minute repeats, a burst of tests) are not a habit yet', () => {
    const out = fold(clean(SKILL_MIN + 3, 60));
    expect(out.of('review:proposed')).toEqual([]);
    expect(out.state.selfReview!.routes['Spotify\npress button "Play"']).toMatchObject({ clean: SKILL_MIN + 3, days: [expect.any(String)] });
  });

  it('Set 5 R3: a route on its way to an offer is never pushed out by one-off routes (a growing task writes a key per call)', () => {
    const oneOffs = Array.from({ length: 40 }, (_, i) => route(43_200 + 60 + i, `o${i}`, `press button "Track ${i}"`));
    const out = fold([...clean(2), ...oneOffs, route(2 * 43_200, 's2')]);
    expect(Object.keys(out.state.selfReview!.routes)).toHaveLength(32);
    expect(out.of('review:proposed').map((e) => e.payload.kind)).toEqual(['skill']);
  });

  it('is one quiet question: Gnomon\'s proposal and a notice whose one button keeps it, no shelf row', () => {
    const out = fold(clean(SKILL_MIN));
    const id = out.of('review:proposed')[0]!.payload.shelfId as string;
    expect(out.of('assistant:proposal').map((e) => e.payload)).toEqual([{ proposalId: id, summary: expect.stringMatching(/^Keep this as a skill\? .* worked 3 of 3 times, on 2 days\.$/), kind: 'skill' }]);
    const notice = out.of('notice:candidate').map((e) => e.payload);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ kind: 'skill-offer', shape: 'self-report', plain: true, offer: { tool: 'gnomon_record_outcome', args: { verdict: 'accepted', proposalId: id }, label: 'Keep as a skill' } });
    // Past the gate's urgent line (2 h): a list row, never an interruption.
    expect(notice[0]!.valueHalfLifeMs).toBeGreaterThan(2 * 60 * 60 * 1000);
    expect(out.effects.filter((e) => e.type === 'WriteDB')).toEqual([]);
    expect(out.state.loops.open.filter((l) => l.kind === 'proposal').map((l) => l.subject)).toEqual([id]);
  });

  it('accepted (the slip\'s button, Today\'s Accept, the chat) keeps the skill; rejected dismisses it; either settles both surfaces', () => {
    const offered = fold(clean(SKILL_MIN));
    const id = offered.of('review:proposed')[0]!.payload.shelfId as string;
    const yes = fold([ev('assistant:response', 200_000, { verdict: 'accepted', proposalId: id })], offered.state);
    expect(yes.of('skill:adopted')[0]!.payload).toMatchObject({ app: 'Spotify', routeKey: 'press button "Play"' });
    expect(yes.of('review:accepted')).toHaveLength(1);
    expect(yes.state.loops.open.filter((l) => l.kind === 'proposal')).toEqual([]);
    const no = fold([ev('assistant:response', 200_000, { verdict: 'rejected', proposalId: id })], offered.state);
    expect(no.of('skill:adopted')).toEqual([]);
    expect(no.of('review:dismissed')[0]!.payload).toMatchObject({ shelfId: id, kind: 'skill', verdict: 'rejected' });
    expect(no.state.selfReview!.proposed[id]).toBeUndefined();
    // A response to another proposal is not the review's.
    const other = fold([ev('assistant:proposal', 100_000, { proposalId: 'p-other', summary: 'Close the branch?' }), ev('assistant:response', 200_000, { verdict: 'accepted', proposalId: 'p-other' })], offered.state);
    expect(other.of('skill:adopted')).toEqual([]);
  });

  it('Set 5 R3: a no is remembered, so the same route is never offered again (even once pushed out and counted afresh); not-now may come back', () => {
    const offered = fold(clean(SKILL_MIN));
    const id = offered.of('review:proposed')[0]!.payload.shelfId as string;
    const no = fold([ev('assistant:response', 200_000, { verdict: 'rejected', proposalId: id })], offered.state);
    expect(no.state.selfReview!.dismissed).toEqual(['skill\nSpotify\npress button "Play"']);
    const forgotten = { ...no.state, selfReview: { ...no.state.selfReview!, routes: {} } };
    const again = fold(Array.from({ length: SKILL_MIN }, (_, i) => ({ ...route(300_000 + i * 43_200, `t${i}`), id: `again${i}` })), forgotten);
    expect(again.of('review:proposed')).toEqual([]);
    const later = fold([ev('feedback:verdict', 200_000, { artifactKind: 'knowledge_entry', artifactId: id, verdict: 'not-now' })], offered.state);
    expect(later.state.selfReview!.dismissed ?? []).toEqual([]);
  });

  it('Set 5 R3: a kept skill is not offered again when its route is counted afresh', () => {
    const offered = fold(clean(SKILL_MIN));
    const id = offered.of('review:proposed')[0]!.payload.shelfId as string;
    const kept = fold([ev('assistant:response', 200_000, { verdict: 'accepted', proposalId: id })], offered.state);
    const forgotten = { ...kept.state, selfReview: { ...kept.state.selfReview!, routes: {} } };
    expect(fold(Array.from({ length: SKILL_MIN }, (_, i) => ({ ...route(300_000 + i * 43_200, `t${i}`), id: `k${i}` })), forgotten).of('review:proposed')).toEqual([]);
  });

  it('a failed step of that route stops the offer', () => {
    const out = fold([...clean(2), failed(3, { session: 's9' }), ...clean(SKILL_MIN).map((e, i) => ({ ...e, id: `c${i}` }))]);
    expect(out.of('review:proposed')).toEqual([]);
    expect(out.state.selfReview!.routes['Spotify\npress button "Play"']).toMatchObject({ failed: 1 });
  });

  it('Keep adopts it by name; a kept skill that fails three times is offered for dropping', () => {
    const offered = fold(clean(SKILL_MIN));
    const shelfId = offered.of('review:proposed')[0]!.payload.shelfId as string;
    const kept = fold([ev('feedback:verdict', 90, { artifactKind: 'knowledge_entry', artifactId: shelfId, verdict: 'useful' })], offered.state);
    expect(kept.of('skill:adopted')).toHaveLength(1);
    const name = kept.of('skill:adopted')[0]!.payload.name as string;
    expect(kept.state.selfReview!.skills[name]).toMatchObject({ app: 'Spotify', routeKey: 'press button "Play"' });
    const failing = fold(fails(DROP_SKILL_AFTER, { session: 's9' }), kept.state);
    const drop = failing.of('review:proposed').find((e) => e.payload.kind === 'drop-skill');
    expect(drop).toBeDefined();
    const gone = fold([ev('feedback:verdict', 200, { artifactKind: 'knowledge_entry', artifactId: drop!.payload.shelfId, verdict: 'useful' })], failing.state);
    expect(gone.state.selfReview!.skills[name]).toBeUndefined();
  });

  it('Set 5 R1: the drop offer names a kept skill by its route id and the words before any value, never the old run\'s values', () => {
    const offered = fold(clean(SKILL_MIN));
    const shelfId = offered.of('review:proposed')[0]!.payload.shelfId as string;
    const kept = fold([ev('feedback:verdict', 90, { artifactKind: 'knowledge_entry', artifactId: shelfId, verdict: 'useful' })], offered.state);
    const skill = Object.values(kept.state.selfReview!.skills)[0]!;
    const old = 'play the album called kestrel 214';
    const state = { ...kept.state, selfReview: { ...kept.state.selfReview!, skills: { [old]: skill } } };
    const failing = fold(fails(DROP_SKILL_AFTER, { session: 's9' }), state);
    const text = JSON.stringify([...failing.effects, ...failing.of('review:proposed'), ...failing.of('notice:candidate'), ...failing.of('assistant:proposal')]);
    expect(text).toMatch(new RegExp(`Drop the skill ${routeIdOfKey('Spotify', 'press button "Play"')} \\\\"play the album\\\\"\\?`));
    expect(text).not.toMatch(/kestrel|214/);
  });

  it('a skill kept in the rig\'s chat, or by a row that says rig, is marked so it is never offered to the owner', () => {
    const adopt = (s: number, extra: Record<string, unknown>) => ev('skill:adopted', s, { name: `open notes ${s}`, app: 'Notes', routeKey: 'press button "New Note"', ...extra });
    const out = fold([ev('thread:model', 0, { sessionId: 'session-rig', rig: true }), adopt(1, { session: 'session-rig' }), adopt(2, { rig: true }), adopt(3, { session: 's1' })]);
    const skills = out.state.selfReview!.skills;
    expect([skills['open notes 1']?.rig, skills['open notes 2']?.rig, skills['open notes 3']?.rig]).toEqual([true, true, undefined]);
  });

  it('a Keep given in the rig\'s chat adopts the skill with that chat and rig: true; the owner\'s Keep carries its chat only', () => {
    const offered = fold([ev('thread:model', 0, { sessionId: 'session-rig', rig: true }), ...clean(SKILL_MIN)]);
    const shelfId = offered.of('review:proposed')[0]!.payload.shelfId as string;
    const keep = (sessionId: string) => fold([ev('feedback:verdict', 90, { artifactKind: 'knowledge_entry', artifactId: shelfId, verdict: 'useful', sessionId })], offered.state);
    const rig = keep('session-rig');
    expect(rig.of('skill:adopted')[0]!.payload).toMatchObject({ session: 'session-rig', rig: true });
    expect(Object.values(rig.state.selfReview!.skills)[0]).toMatchObject({ rig: true });
    const own = keep('s1');
    expect(own.of('skill:adopted')[0]!.payload).toMatchObject({ session: 's1' });
    expect(own.of('skill:adopted')[0]!.payload.rig).toBeUndefined();
    expect(Object.values(own.state.selfReview!.skills)[0]!.rig).toBeUndefined();
  });
});

describe('selfReview: the rig never trains the owner\'s Gnomon, and Gnomon\'s own rows are what it reviews', () => {
  const count = (state: KernelState) => Object.values(state.selfReview?.pending ?? {}).reduce((n, c) => n + c.n, 0);

  it('leaves out a step in the rig\'s window or chat, a deny in an unattended run, and the rig\'s answer', () => {
    expect(count(fold(fails(3, { windowTitle: 'Inbox - Testbox' })).state)).toBe(0);
    expect(count(fold([ev('thread:model', 0, { sessionId: 'session-rig', rig: true }), ...fails(3, { session: 'session-rig' })]).state)).toBe(0);
    expect(count(fold([ev('action:decided', 0, { tool: 'screen_act', callId: 'c1', verdict: 'deny', inputs: { testMode: true, facts: { app: 'Spotify' } } })]).state)).toBe(0);
    const ask = [ev('approval:asked', 0, { approvalId: 'a1', sessionId: 's1', tool: 'screen_act' }), ev('approval:answered', 1, { approvalId: 'a1', answer: 'rejected', by: 'rig' })];
    expect(count(fold(ask).state)).toBe(0);
  });

  it('leaves out a gate deny in a rig chat: by its own session, or the rig chat that last acted in the app', () => {
    const rig = ev('thread:model', 0, { sessionId: 'session-rig', rig: true });
    const deny = (extra: Record<string, unknown> = {}) => ev('action:decided', 1, { tool: 'screen_act', callId: `c${++seq}`, verdict: 'deny', inputs: { facts: { app: 'Spotify' } }, ...extra });
    expect(count(fold([rig, deny({ sessionId: 'session-rig' })]).state)).toBe(0);
    const base = createInitialState('d');
    const acting = { ...base, marks: { now: [], guide: null, guideTally: {}, chats: { 'session-rig': { app: { app: 'Spotify', at: at(0) } } } } } as KernelState;
    expect(count(fold([rig, deny()], acting).state)).toBe(0);
  });

  it('the owner\'s no enters the cluster as the tool and the app, never the ask\'s line with a typed preview', () => {
    const ask = [ev('approval:asked', 0, { approvalId: 'a9', sessionId: 's1', tool: 'screen_act', text: 'type into Notes: dear Mira, the secret plan' }), ev('approval:answered', 1, { approvalId: 'a9', answer: 'rejected', by: 'owner' })];
    const out = fold([...ask, ...ask.map((e) => ({ ...e, id: `${e.id}b`, payload: { ...e.payload, approvalId: 'a10' } })), ...ask.map((e) => ({ ...e, id: `${e.id}c`, payload: { ...e.payload, approvalId: 'a11' } })), ev('idle:start', 10)]);
    const cluster = out.state.selfReview?.pending['screen_act\ns1\nrefused'] ?? (out.of('work:requested')[0]?.payload.review as { steps: string[] } | undefined);
    expect(JSON.stringify(out.emitted)).not.toContain('secret');
    expect(cluster?.steps[0]).toBe('screen_act: the owner said no');
  });

  it('counts a gate deny and the owner\'s no to an ask', () => {
    expect(fold([ev('action:decided', 0, { tool: 'screen_act', callId: 'c1', verdict: 'deny', inputs: { facts: { app: 'Spotify' } } })]).state.selfReview!.pending['Spotify\n\ndenied']).toMatchObject({ n: 1 });
    const ask = [ev('approval:asked', 0, { approvalId: 'a1', sessionId: 's1', tool: 'screen_act' }), ev('approval:answered', 1, { approvalId: 'a1', answer: 'rejected', by: 'owner' })];
    expect(fold(ask).state.selfReview!.pending['screen_act\ns1\nrefused']).toMatchObject({ n: 1 });
    const yes = [ev('approval:asked', 0, { approvalId: 'a2', sessionId: 's1', tool: 'screen_act' }), ev('approval:answered', 1, { approvalId: 'a2', answer: 'allowed', by: 'owner' })];
    expect(count(fold(yes).state)).toBe(0);
  });

  // Set 3 R4: `route-log.js` writes `review:unbacked-claim` "for self-review", and no rule read it.
  it('a reply Gnomon marked as claiming an act it never ran is its own failure, filed under Gnomon, reviewed at the chat\'s end', () => {
    const claim = (s: number, session = 's1') => ev('review:unbacked-claim', s, { sessionId: session, turnId: `t${s}`, claim: 'sent', tools: [] });
    const out = fold([claim(0), claim(1), claim(2), ev('chat:said', 10, { sessionId: 's1', text: 'done' })]);
    expect(out.of('work:requested')[0]!.payload).toMatchObject({ subject: 'Gnomon', by: 'review', review: { app: 'Gnomon', kind: 'unbacked-claim', n: 3, steps: ['said "sent" with no act in the turn', 'said "sent" with no act in the turn', 'said "sent" with no act in the turn'] } });
    // The same turn marked twice counts once; the rig's chat counts nothing.
    expect(count(fold([claim(0), { ...claim(0), id: 'again' }]).state)).toBe(1);
    expect(count(fold([ev('thread:model', 0, { sessionId: 'session-rig', rig: true }), claim(1, 'session-rig'), claim(2, 'session-rig'), claim(3, 'session-rig')]).state)).toBe(0);
  });

  it('a loop breaker stop is a ripe cluster on its own, and asks for a review when the chat ends its turn', () => {
    const stop = ev('action:decided', 0, { tool: 'screen_act', callId: 'c1', verdict: 'deny', breaker: 'loop', sessionId: 's1', reason: 'Gnomon stopped this turn: acting on "notes.txt" failed or changed nothing 4 times in this turn.', inputs: { facts: { app: 'Finder' } } });
    const out = fold([stop, ev('chat:said', 5, { sessionId: 's1' })]);
    expect(out.of('work:requested')[0]?.payload).toMatchObject({ subject: 'Finder', review: { kind: 'loop', n: CLUSTER_MIN, steps: [stop.payload.reason] } });
    expect(fold([{ ...stop, payload: { ...stop.payload, breaker: 'hunt' } }]).state.selfReview!.pending['Finder\ns1\nshell-hunt']).toMatchObject({ n: CLUSTER_MIN });
  });

  it('a step while Gnomon\'s own act window is open (by-Gnomon) still counts: it is not fenced like an owner learner', () => {
    const allow = ev('action:decided', 0, { tool: 'screen_act', callId: 'c1', verdict: 'allow' });
    expect(count(fold([allow, ...fails(2)]).state)).toBe(2);
  });
});
