import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent, TournamentPrediction } from '@sundial/kernel/types.js';
import { baseRateFor, forecastTournament, retirements } from './forecast-tournament.js';

const TS = '2026-09-22T12:00:00.000Z';
const ev = (type: string, payload: Record<string, unknown> = {}, ts = TS, id = 'e1'): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });
const twins = (s: KernelState) => s.predictions.open.filter((p): p is TournamentPrediction => String(p.kind).startsWith('tournament:'));
const judges = (effects: Effect[]) => effects.filter((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }>[];
const records = (effects: Effect[]) => effects.filter((e) => e.type === 'RecordPrediction') as Extract<Effect, { type: 'RecordPrediction' }>[];

describe('forecastTournament — return-today', () => {
  it('leaving a project opens one bet with base-rate set and Jev asked; coming back resolves both as a hit', () => {
    const base = createInitialState('d1');
    const { state, effects } = forecastTournament(base, ev('event:context-switch', { fromProject: '~/p/a', toProject: '~/p/b', fromProcess: 'Code', toProcess: 'Arc' }));
    const [bet] = twins(state);
    expect(bet).toMatchObject({ kind: 'tournament:return-today', target: 'return-today', forecasters: { 'base-rate': baseRateFor(base, 'return-today'), jev: null } });
    expect(bet.features).toMatchObject({ minutes_on_project_today: 0, sessions_on_project_today: 0, days_project_touched_last_14: 0 });
    const [judge] = judges(effects);
    expect(judge).toMatchObject({ purpose: 'forecast', questionSetId: 'forecast-return-today', metadata: { predictionId: bet.id } });
    expect((judge.state as { historically_true_this_often: number }).historically_true_this_often).toBeCloseTo(0.853, 2);

    const answered = forecastTournament(state, ev('judgement:result', { purpose: 'forecast', questionSetId: 'forecast-return-today', momentId: null, answers: { yes: { type: 'noul', noul: 0.91 } }, model: 'typesafe/jev-latest', latencyMs: 250, metadata: { predictionId: bet.id } })).state;
    expect(twins(answered)[0].forecasters.jev).toBe(0.91);

    const back = forecastTournament(answered, ev('event:context-switch', { fromProject: '~/p/b', toProject: '~/p/a' }, '2026-09-22T13:00:00.000Z', 'e2'));
    expect(twins(back.state).filter((b) => b.target === 'return-today' && b.key.endsWith('~/p/a'))).toHaveLength(0);
    const rows = records(back.effects);
    expect(rows.map((r) => [r.kind, r.forecaster, r.outcome])).toEqual([
      ['return-today', 'base-rate', 1],
      ['return-today', 'jev', 1],
    ]);
    expect(rows[1].priorProb).toBe(0.91);
    expect(back.state.predictions.calibration['return-today/jev']).toMatchObject({ n: 1, hits: 1 });
    expect(back.state.predictions.calibration['return-today/base-rate'].n).toBe(1);
    // Leaving b on the same switch opened b's own bet.
    expect(twins(back.state).some((b) => b.key.endsWith('~/p/b'))).toBe(true);
  });

  it('a close on this event is tallied into the next leave-bet features (the rule folds after momentClose)', () => {
    const base = createInitialState('d1');
    const closed: KernelState = { ...base, project: { ...base.project, lastClosedMoment: { projectId: '~/p/a', confidence: 'certain', endedAt: TS, durationMs: 12 * 60_000 } } };
    const tallied = forecastTournament(closed, ev('clock:tick')).state;
    expect(tallied.predictions.tournament.projectToday['~/p/a']).toEqual({ minutes: 12, sessions: 1 });
    expect(tallied.predictions.tournament.touchedDays['~/p/a']).toEqual(['2026-09-22']);
    // A stale record (closed on an earlier event) is not tallied twice.
    expect(forecastTournament(tallied, ev('clock:tick', {}, '2026-09-22T12:00:01.000Z', 'e2')).state.predictions.tournament.projectToday['~/p/a']).toEqual({ minutes: 12, sessions: 1 });
    const [bet] = twins(forecastTournament(tallied, ev('event:context-switch', { fromProject: '~/p/a', toProject: '~/p/b' }, '2026-09-22T12:00:02.000Z', 'e3')).state);
    expect(bet.features).toMatchObject({ minutes_on_project_today: 12, sessions_on_project_today: 1, days_project_touched_last_14: 1 });
  });

  it('the day boundary resolves an open return bet as a miss, and never opens the same case twice', () => {
    const left = forecastTournament(createInitialState('d1'), ev('event:context-switch', { fromProject: '~/p/a', toProject: null })).state;
    expect(forecastTournament(left, ev('event:context-switch', { fromProject: '~/p/a', toProject: null }, TS, 'e9')).effects).toEqual([]);
    const { state, effects } = forecastTournament(left, ev('day:boundary', {}, '2026-09-23T00:00:00.000Z', 'e3'));
    expect(twins(state)).toHaveLength(0);
    expect(records(effects).map((r) => [r.forecaster, r.outcome])).toEqual([['base-rate', 0]]);
  });
});

describe('forecastTournament — meeting-overrun', () => {
  const meeting = { title: 'Standup', start: '2026-09-22T11:00:00.000Z', end: '2026-09-22T11:30:00.000Z', attendees: ['a', 'b'], askedAt: null };
  const heard = (s: KernelState, at: string[]) => ({ ...s, meetings: { seen: { k: meeting } }, predictions: { ...s.predictions, tournament: { ...s.predictions.tournament, utterances: at } } });

  it('opens at the scheduled end when hearing was on, resolves five minutes later on whether anyone still spoke', () => {
    const s0 = heard(createInitialState('d1'), ['2026-09-22T11:10:00.000Z', '2026-09-22T11:25:00.000Z']);
    const opened = forecastTournament(s0, ev('clock:tick', {}, '2026-09-22T11:30:30.000Z'));
    const [bet] = twins(opened.state);
    expect(bet).toMatchObject({ target: 'meeting-overrun', resolveBy: '2026-09-22T11:35:00.000Z', about: 'Standup' });
    expect(bet.features).toMatchObject({ scheduled_minutes: 30, attendee_count: 2, utterances_last_10_min: 1 });
    expect(judges(opened.effects)[0]).toMatchObject({ questionSetId: 'forecast-meeting-overrun' });

    const spoke = forecastTournament(opened.state, ev('audio:transcript', { spokenText: 'one more thing' }, '2026-09-22T11:33:00.000Z', 'u1')).state;
    const resolved = forecastTournament(spoke, ev('clock:tick', {}, '2026-09-22T11:35:30.000Z', 'e4'));
    expect(records(resolved.effects).map((r) => [r.kind, r.forecaster, r.outcome])).toEqual([['meeting-overrun', 'base-rate', 1]]);
    expect(twins(resolved.state)).toHaveLength(0);
  });

  it('a meeting nobody was heard in gets no bet — there would be no truth', () => {
    const s0 = heard(createInitialState('d1'), []);
    expect(twins(forecastTournament(s0, ev('clock:tick', {}, '2026-09-22T11:30:30.000Z')).state)).toHaveLength(0);
  });
});

describe('forecastTournament — hour-fragmented twin', () => {
  it('twins the existing bet when it opens and resolves with it, on the same event', () => {
    const base = createInitialState('d1');
    const original = { id: 'hf-1', createdAt: TS, kind: 'hour-fragmented' as const, day: '2026-09-22', hour: 14, priorProb: 0.2, prevState: 'prev-calm' as const };
    const withOriginal: KernelState = { ...base, predictions: { ...base.predictions, open: [original] } };
    const twinned = forecastTournament(withOriginal, ev('input:activity', {}));
    const [twin] = twins(twinned.state);
    expect(twin).toMatchObject({ target: 'hour-fragmented', key: 'hf|2026-09-22|14', features: { local_hour: 14, previous_hour_fragmented: false } });
    expect(judges(twinned.effects)[0]).toMatchObject({ questionSetId: 'forecast-hour-fragmented' });

    // The existing rule closes the hour: original gone, its resolution freshly on the ring.
    const closedByOriginal: KernelState = {
      ...twinned.state,
      predictions: { ...twinned.state.predictions, open: twinned.state.predictions.open.filter((p) => p.kind !== 'hour-fragmented'), recentResolved: [{ kind: 'hour-fragmented', priorProb: 0.2, hit: true, surprise: 1.6, resolvedAt: '2026-09-22T15:00:00.000Z' }] },
    };
    const resolved = forecastTournament(closedByOriginal, ev('input:activity', {}, '2026-09-22T15:00:00.000Z', 'e5'));
    expect(records(resolved.effects).map((r) => [r.kind, r.forecaster, r.outcome])).toEqual([['hour-fragmented', 'base-rate', 1]]);
    expect(twins(resolved.state)).toHaveLength(0);
  });
});

describe('retirements', () => {
  it('retires jev on a target once it is worse than base-rate at thirty, and never before', () => {
    const s = createInitialState('d1');
    const at = (n: number, brierJev: number, brierBase: number): KernelState => ({
      ...s,
      predictions: { ...s.predictions, calibration: { 'return-today/jev': { n, hits: 0, brierSum: brierJev * n }, 'return-today/base-rate': { n, hits: 0, brierSum: brierBase * n } } },
    });
    expect(retirements(at(29, 0.2, 0.1))).toEqual({});
    expect(retirements(at(30, 0.2, 0.1))).toEqual({ 'return-today': ['jev'] });
    expect(retirements(at(30, 0.1, 0.2))).toEqual({});
    // A retired forecaster is not asked again.
    const retired: KernelState = { ...s, predictions: { ...s.predictions, tournament: { ...s.predictions.tournament, retired: { 'return-today': ['jev'] } } } };
    const { effects, state } = forecastTournament(retired, ev('event:context-switch', { fromProject: '~/p/a', toProject: '~/p/b' }));
    expect(judges(effects)).toHaveLength(0);
    expect(twins(state)[0].forecasters).toEqual({ 'base-rate': baseRateFor(retired, 'return-today'), jev: null });
  });
});
