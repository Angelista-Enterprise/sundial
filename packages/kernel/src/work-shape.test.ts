import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActivityHourRow } from '@sundial/db/index.js';
import { EMITS_PER_FULL_HOUR, buildWorkShape, type WorkShapeInput } from './work-shape.js';

/** Stockholm: UTC+2 in August, so a 22:30Z instant is the NEXT local day. */
const TZ = 'Europe/Stockholm';

function input(overrides: Partial<WorkShapeInput> = {}): WorkShapeInput {
  return {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-03T00:00:00.000Z',
    timeZone: TZ,
    activityHours: [],
    switches: [],
    thrashing: [],
    interruptions: [],
    shellRuns: [],
    commits: [],
    ...overrides,
  };
}

/**
 * Hours as the reader hands them over.
 *
 * `emits` defaults to a FULL hour, so a helper asking for three hours gets
 * three hours rather than three eighths of a minute — the tests below are
 * about switches and churn, not about coverage, and every one of them would
 * otherwise have to carry a cadence it does not care about.
 */
function hoursOf(date: string, hours: number[], active: boolean, emits = EMITS_PER_FULL_HOUR): ActivityHourRow[] {
  return hours.map((hour) => ({ ts: `${date}T${String(hour - 2).padStart(2, '0')}:00:00.000Z`, active, emits }));
}

/** Active hours (deliberate input present) at the given LOCAL hours of one local day. */
function active(date: string, hours: number[], emits?: number): ActivityHourRow[] {
  return hoursOf(date, hours, true, emits);
}

/** Hours the daemon watched with NO deliberate input — the Input-Monitoring-lost shape. */
function watchedOnly(date: string, hours: number[], emits?: number): ActivityHourRow[] {
  return hoursOf(date, hours, false, emits);
}

describe('buildWorkShape', () => {
  it('splits switches by app and by branch, neither of which restates the total', () => {
    const shape = buildWorkShape(
      input({
        activityHours: active('2026-08-01', [9, 10, 11]),
        switches: [
          // Two projects, two apps: the plain case.
          { ts: '2026-08-01T07:30:00.000Z', fromProject: 'a', toProject: 'b', fromProcess: 'Code', toProcess: 'Chrome' },
          // Two projects, same app — new work without leaving the window.
          { ts: '2026-08-01T07:40:00.000Z', fromProject: 'a', toProject: 'b', fromProcess: 'Code', toProcess: 'Code' },
          // One project, two branches: the same subject from a different angle.
          { ts: '2026-08-01T07:50:00.000Z', fromProject: 'a@main', toProject: 'a@feature', fromProcess: 'Code', toProcess: 'Chrome' },
          // The same, in the form written since 2026-09-28: the project's id on both sides.
          { ts: '2026-08-01T07:55:00.000Z', fromProject: 'a', toProject: 'a', fromProcess: 'Code', toProcess: 'Code' },
        ],
      }),
    );
    expect(shape.days[0].switches).toBe(4);
    expect(shape.days[0].sameAppSwitches).toBe(2);
    expect(shape.days[0].branchSwitches).toBe(2);
  });

  it('WEIGHS an hour rather than counting the ones a row appeared in', () => {
    // The bug this replaces, in the shape the live record had it. An hour the
    // daemon watched for eight minutes and one it watched for sixty were each
    // reported as "1 hour", and `input:activity` emits on a fixed ~10s cadence
    // whenever the daemon is up — so `observedHours` came out a flat 24 on
    // every day of the record and the Shape card printed it for weeks. On
    // 2026-09-19 the two figures read 20 and 3 where the log says 1.3 and 1.1.
    const thin = buildWorkShape(input({ activityHours: active('2026-08-01', [9, 10, 11], 30) }));
    expect(thin.days[0].observedHours, 'three hours at a twelfth of the cadence').toBeCloseTo(0.3, 5);
    expect(thin.days[0].activeHours).toBeCloseTo(0.3, 5);

    const full = buildWorkShape(input({ activityHours: active('2026-08-01', [9, 10, 11]) }));
    expect(full.days[0].observedHours, 'the same three hours, fully watched').toBe(3);
  });

  it('never lets a burst buy back an hour nobody was there for', () => {
    // A restart can double-count a minute and a busy hour can overrun the
    // cadence; neither makes an hour longer than an hour.
    const busy = buildWorkShape(input({ activityHours: active('2026-08-01', [9], EMITS_PER_FULL_HOUR * 4) }));
    expect(busy.days[0].observedHours).toBe(1);
  });

  it('can never report more active hours than observed ones', () => {
    // The reason both figures are weighed rather than only the observed one.
    // Weighed alone, a sparse day reports more ACTIVE hours than observed —
    // impossible, since input cannot be recorded in a minute nobody watched.
    const sparse = buildWorkShape(
      input({ activityHours: [...active('2026-08-01', [9, 10, 11], 4), ...watchedOnly('2026-08-01', [12, 13], 4)] }),
    );
    expect(sparse.days[0].activeHours).toBeLessThanOrEqual(sparse.days[0].observedHours);
    expect(sparse.days[0].observedHours, 'five hours at four emits each is about three minutes').toBeCloseTo(0.1, 5);
  });

  it('rounds a total, not only a day', () => {
    // A column of one-decimal hours sums to 194.09999999999997 in binary
    // floating point, and a total is a thing the page prints.
    const shape = buildWorkShape(input({ activityHours: [...active('2026-08-01', [9, 10, 11], 120), ...active('2026-08-02', [9, 10, 11], 120)] }));
    expect(String(shape.totals.observedHours)).not.toMatch(/\d{5,}/);
    expect(shape.totals.observedHours).toBe(2);
  });

  it('keeps one cadence for one sensor', () => {
    // `packages/kernel` cannot import from `packages/rules`, so this constant
    // exists twice. Two cadences would give two answers to "how long was
    // Gnomon watching" — the Trust card's calendar and this file would
    // disagree about the same day.
    const rules = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../rules/src/coverage-track.ts'), 'utf8');
    const theirs = /EMITS_PER_FULL_HOUR\s*=\s*(\d+)/.exec(rules);
    expect(theirs, 'coverage-track must still declare it').toBeTruthy();
    expect(Number(theirs?.[1])).toBe(EMITS_PER_FULL_HOUR);
  });

  it('separates a lost input grant from a quiet day', () => {
    const blind = buildWorkShape(input({ activityHours: watchedOnly('2026-08-01', [9, 10, 11, 12]) }));
    expect(blind.days[0].observedHours).toBe(4);
    expect(blind.days[0].activeHours).toBe(0);
    expect(blind.days[0].inputBlind).toBe(true);
    expect(blind.days[0].switchesPerHour).toBeNull();
    expect(blind.totals.inputBlindDays).toBe(1);

    // A genuinely quiet day has NO observed hours either — nothing was watching.
    const quiet = buildWorkShape(input({ activityHours: [] }));
    expect(quiet.totals.inputBlindDays).toBe(0);
  });

  it('rates divide by active hours, never by hours merely watched', () => {
    const shape = buildWorkShape(
      input({
        // Watched for eight hours; a person was there for two of them.
        activityHours: [...active('2026-08-01', [9, 10]), ...watchedOnly('2026-08-01', [1, 2, 3, 4, 5, 6])],
        switches: [
          { ts: '2026-08-01T07:00:00.000Z', fromProject: 'a', toProject: 'b', fromProcess: null, toProcess: null },
          { ts: '2026-08-01T07:30:00.000Z', fromProject: 'b', toProject: 'a', fromProcess: null, toProcess: null },
          { ts: '2026-08-01T08:00:00.000Z', fromProject: 'a', toProject: 'b', fromProcess: null, toProcess: null },
          { ts: '2026-08-01T08:30:00.000Z', fromProject: 'b', toProject: 'a', fromProcess: null, toProcess: null },
        ],
      }),
    );
    expect(shape.days[0].observedHours).toBe(8);
    expect(shape.days[0].activeHours).toBe(2);
    // 4 switches / 2 active hours, not / 8 watched hours.
    expect(shape.days[0].switchesPerHour).toBe(2);
  });

  it('rates are null until the day has enough active hours to divide by', () => {
    const thin = buildWorkShape(
      input({
        activityHours: active('2026-08-01', [9]),
        switches: [{ ts: '2026-08-01T07:30:00.000Z', fromProject: 'a', toProject: 'b', fromProcess: null, toProcess: null }],
      }),
    );
    expect(thin.days[0].observedHours).toBe(1);
    expect(thin.days[0].lowConfidence).toBe(true);
    expect(thin.days[0].switchesPerHour).toBeNull();

    const thick = buildWorkShape(
      input({
        activityHours: active('2026-08-01', [9, 10, 11, 12]),
        switches: [
          { ts: '2026-08-01T07:30:00.000Z', fromProject: 'a', toProject: 'b', fromProcess: null, toProcess: null },
          { ts: '2026-08-01T08:30:00.000Z', fromProject: 'b', toProject: 'a', fromProcess: null, toProcess: null },
        ],
      }),
    );
    expect(thick.days[0].lowConfidence).toBe(false);
    expect(thick.days[0].switchesPerHour).toBe(0.5);
  });


  it('tracks the worst consecutive failure streak, and an unfinished command breaks it', () => {
    const shape = buildWorkShape(
      input({
        activityHours: active('2026-08-01', [9, 10]),
        shellRuns: [
          { ts: '2026-08-01T07:00:00.000Z', command: 'npm test', cwd: null, exitCode: 1, durationMs: 10 },
          { ts: '2026-08-01T07:01:00.000Z', command: 'npm test', cwd: null, exitCode: 1, durationMs: 10 },
          // Never seen to finish: not a pass, not a fail — it breaks the run.
          { ts: '2026-08-01T07:02:00.000Z', command: 'npm test', cwd: null, exitCode: null, durationMs: null },
          { ts: '2026-08-01T07:03:00.000Z', command: 'npm test', cwd: null, exitCode: 1, durationMs: 10 },
          { ts: '2026-08-01T07:04:00.000Z', command: 'npm test', cwd: null, exitCode: 0, durationMs: 10 },
        ],
      }),
    );
    expect(shape.days[0].shellRuns).toBe(5);
    expect(shape.days[0].shellFailures).toBe(3);
    expect(shape.days[0].worstFailureStreak).toBe(2);
    expect(shape.totals.shellFailureRate).toBe(0.6);
  });

  it('streaks do not carry across a day boundary', () => {
    const shape = buildWorkShape(
      input({
        activityHours: [...active('2026-08-01', [9, 10]), ...active('2026-08-02', [9, 10])],
        shellRuns: [
          { ts: '2026-08-01T20:00:00.000Z', command: 'x', cwd: null, exitCode: 1, durationMs: 1 },
          { ts: '2026-08-02T07:00:00.000Z', command: 'x', cwd: null, exitCode: 1, durationMs: 1 },
        ],
      }),
    );
    expect(shape.days.map((d) => d.worstFailureStreak)).toEqual([1, 1]);
  });

  it('buckets by the owner local day, not the UTC day', () => {
    // 22:30Z on the 1st is 00:30 on the 2nd in Stockholm.
    const shape = buildWorkShape(
      input({
        activityHours: [{ ts: '2026-08-01T22:00:00.000Z', active: true, emits: 360 }, { ts: '2026-08-01T23:00:00.000Z', active: true, emits: 360 }],
        commits: [{ ts: '2026-08-01T22:30:00.000Z', branch: 'main', cwd: null, insertions: 3, deletions: 1, filesChanged: 2 }],
      }),
    );
    expect(shape.days).toHaveLength(1);
    expect(shape.days[0].date).toBe('2026-08-02');
    expect(shape.days[0].commits).toBe(1);
  });

  it('reports median commit churn, so one generated blob cannot define a day', () => {
    const shape = buildWorkShape(
      input({
        activityHours: active('2026-08-01', [9, 10]),
        commits: [
          { ts: '2026-08-01T07:00:00.000Z', branch: 'main', cwd: null, insertions: 10, deletions: 2, filesChanged: 1 },
          { ts: '2026-08-01T07:30:00.000Z', branch: 'main', cwd: null, insertions: 40, deletions: 10, filesChanged: 3 },
          // The real one from the corpus: a generated blob, 99.6% of the day.
          { ts: '2026-08-01T08:00:00.000Z', branch: 'main', cwd: null, insertions: 11_673_416, deletions: 0, filesChanged: 6644 },
        ],
      }),
    );
    expect(shape.days[0].commits).toBe(3);
    // The middle commit, not the average and not the blob.
    expect(shape.days[0].medianCommitChurn).toBe(50);
    expect(shape.days[0].largestCommitChurn).toBe(11_673_416);
  });

  it('ranks interruption suspects without claiming causation, and splits the detail list', () => {
    const shape = buildWorkShape(
      input({
        activityHours: active('2026-08-01', [9, 10]),
        interruptions: [
          { ts: '2026-08-01T07:00:00.000Z', cause: 'notification', detail: 'Calendar, WhatsApp' },
          { ts: '2026-08-01T07:10:00.000Z', cause: 'notification', detail: 'Calendar' },
          { ts: '2026-08-01T07:20:00.000Z', cause: 'notification', detail: null },
        ],
      }),
    );
    expect(shape.days[0].interruptions).toBe(3);
    expect(shape.suspects).toEqual([
      { app: 'Calendar', present: 2 },
      { app: 'WhatsApp', present: 1 },
    ]);
  });

  it('separates how often thrashing happened from how hard', () => {
    const shape = buildWorkShape(
      input({
        activityHours: active('2026-08-01', [9, 10]),
        thrashing: [
          { ts: '2026-08-01T07:00:00.000Z', switchCount: 25, flips: 14, windowMs: 90_000, processes: ['Chrome', 'Code'] },
          { ts: '2026-08-01T07:05:00.000Z', switchCount: 5, flips: 9, windowMs: 90_000, processes: ['Chrome', 'Slack'] },
        ],
      }),
    );
    expect(shape.days[0].thrashingBursts).toBe(2);
    expect(shape.days[0].thrashingSwitches).toBe(30);
    expect(shape.days[0].thrashingFlips).toBe(23);
    expect(shape.days[0].thrashingBurstsMeasured).toBe(2);
  });

  it('never reads a pre-fix burst as a burst with no flips', () => {
    // 4,932 rows were written by a detector that counted window EVENTS and
    // fired at five of them; 935 of those involve exactly one process. They
    // carry no `flips`, and a zero here would read as a calm day rather than
    // as a day the corrected measure cannot describe.
    const shape = buildWorkShape(
      input({
        activityHours: active('2026-08-01', [9, 10]),
        thrashing: [
          { ts: '2026-08-01T07:00:00.000Z', switchCount: 25, flips: null, windowMs: 90_000, processes: ['Chrome'] },
          { ts: '2026-08-01T07:05:00.000Z', switchCount: 12, flips: 11, windowMs: 90_000, processes: ['Chrome', 'Code'] },
        ],
      }),
    );
    expect(shape.days[0].thrashingBursts, 'both happened').toBe(2);
    expect(shape.days[0].thrashingBurstsMeasured, 'only one can be read').toBe(1);
    expect(shape.days[0].thrashingFlips).toBe(11);
  });

  it('returns empty structure rather than throwing on an empty range', () => {
    const shape = buildWorkShape(input());
    expect(shape.days).toEqual([]);
    expect(shape.totals).toMatchObject({ days: 0, switches: 0, shellFailureRate: null, switchesPerHour: null });
    expect(shape.switchesByHour).toHaveLength(24);
  });
});
