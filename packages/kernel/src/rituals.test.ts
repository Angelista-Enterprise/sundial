import { describe, it, expect } from 'vitest';
import { rituals, sittings, mergeMirrors, slotOf, projectLabel, type RitualMoment } from './rituals.js';

const TZ = 'Europe/Amsterdam';

/** One moment, given a local wall clock in CEST (UTC+2 for every date used here). */
function moment(day: string, from: string, to: string, processName: string, projectId: string | null, intent: string | null = null): RitualMoment {
  const utc = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 2, m!)).toISOString();
  };
  return { startTime: utc(from), endTime: utc(to), processName, projectId, intent };
}

describe('slotOf', () => {
  it('names the six times of day by the hour a sitting starts', () => {
    expect([3, 9, 13, 15, 19, 23].map(slotOf)).toEqual(['Early', 'Morning', 'Midday', 'Afternoon', 'Evening', 'Late']);
  });
});

describe('projectLabel', () => {
  it('shortens a path and unwraps a named project', () => {
    expect(projectLabel('~/Projects/acme/puzzlebox-studio')).toBe('puzzlebox-studio');
    expect(projectLabel('named:hub')).toBe('hub');
  });
});

describe('sittings', () => {
  it('runs consecutive moments on one project together', () => {
    const [sitting] = sittings(
      [moment('2026-09-01', '09:00', '09:20', 'Code', '~/p/sundial'), moment('2026-09-01', '09:22', '09:50', 'Claude', '~/p/sundial')],
      TZ,
    );
    expect(sitting).toMatchObject({ project: 'sundial', startMin: 9 * 60, endMin: 9 * 60 + 50, lengthMin: 50 });
  });

  it('lets an unattributed moment extend a sitting rather than break it', () => {
    // Two thousand of the record's seven thousand moments carry no project, and
    // most are the browser between two attributed ones. Breaking there turned a
    // thirty-seven minute sitting into three nine-minute ones.
    const [sitting, ...rest] = sittings(
      [
        moment('2026-09-01', '09:00', '09:15', 'Code', '~/p/sundial'),
        moment('2026-09-01', '09:15', '09:25', 'Google Chrome', null),
        moment('2026-09-01', '09:25', '09:40', 'Code', '~/p/sundial'),
      ],
      TZ,
    );
    expect(rest).toHaveLength(0);
    expect(sitting).toMatchObject({ lengthMin: 40 });
  });

  it('breaks on a long gap, on a new day, and on a different project', () => {
    const many = sittings(
      [
        moment('2026-09-01', '09:00', '09:15', 'Code', '~/p/sundial'),
        moment('2026-09-01', '10:30', '10:45', 'Code', '~/p/sundial'),
        moment('2026-09-01', '10:47', '11:05', 'Code', '~/p/other'),
        moment('2026-09-02', '11:05', '11:20', 'Code', '~/p/other'),
      ],
      TZ,
    );
    expect(many.map((s) => `${s.project}/${s.day}`)).toEqual(['sundial/2026-09-01', 'sundial/2026-09-01', 'other/2026-09-01', 'other/2026-09-02']);
  });

  it('drops a sitting under ten minutes — that is an errand, not a stretch of work', () => {
    expect(sittings([moment('2026-09-01', '09:00', '09:05', 'Code', '~/p/sundial')], TZ)).toEqual([]);
  });
});

describe('rituals', () => {
  /** The same morning stretch on four separate days, plus one stray afternoon. */
  const week: RitualMoment[] = [
    ...['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].flatMap((day) => [
      moment(day, '09:10', '09:40', 'Claude', '~/p/sundial', `worked on sundial on ${day}`),
      moment(day, '09:45', '10:05', 'Code', '~/p/sundial'),
    ]),
    moment('2026-09-05', '15:00', '15:40', 'Code', '~/p/other'),
  ];

  it('names a cluster by its time of day and its project', () => {
    const [top] = rituals(week, TZ);
    expect(top!.name).toBe('Morning · sundial');
    expect(top).toMatchObject({ days: 4, occurrences: 4, project: 'sundial', when: 'weekdays' });
  });

  it('carries the usual window, the typical length and the apps', () => {
    const [top] = rituals(week, TZ);
    expect(top!.startMin).toBe(9 * 60 + 10);
    expect(top!.endMin).toBe(10 * 60 + 5);
    expect(top!.medianMin).toBe(55);
    expect(top!.apps).toEqual(['Claude', 'Code']);
  });

  it('hides a cluster seen on too few days — the "so what?" filter', () => {
    expect(rituals(week, TZ).map((r) => r.project)).toEqual(['sundial']);
  });

  it('refuses a cluster it cannot name, however often it happens', () => {
    const unattributed = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'].map((day) => moment(day, '09:00', '09:40', 'Google Chrome', null));
    expect(rituals(unattributed, TZ)).toEqual([]);
  });

  it('separates a weekend habit from a weekday one', () => {
    // 5 and 6 September 2026 are a Saturday and a Sunday.
    const weekend = ['2026-09-05', '2026-09-06', '2026-09-12', '2026-09-13'].map((day) => moment(day, '20:00', '20:40', 'Code', '~/p/sundial'));
    expect(rituals(weekend, TZ)[0]).toMatchObject({ name: 'Evening · sundial', when: 'weekends' });
  });

  it('keeps the model sentences from the LONGEST moments, not the newest', () => {
    // The newest moments in a stretch are the short ones at its edges, so
    // newest-first made the busiest ritual in the live record answer "what is
    // this for?" with "Switching from VS Code to WhatsApp".
    const mixed = [
      ...week,
      moment('2026-09-04', '09:06', '09:08', 'Claude', '~/p/sundial', 'Switching from VS Code to WhatsApp'),
      moment('2026-09-04', '10:06', '10:55', 'Code', '~/p/sundial', 'Rewriting the fold so a row answers for itself'),
    ];
    expect(rituals(mixed, TZ)[0]!.intents[0]).toBe('Rewriting the fold so a row answers for itself');
    expect(rituals(mixed, TZ)[0]!.intents).not.toContain('Switching from VS Code to WhatsApp');
  });
});

describe('mergeMirrors', () => {
  it('counts a sequence and its reverse once, keeping the stronger direction', () => {
    const merged = mergeMirrors([
      { steps: ['Claude', 'Warp', 'Chrome'], support: 123 },
      { steps: ['Chrome', 'Warp', 'Claude'], support: 110 },
      { steps: ['Code', 'Claude', 'Warp'], support: 40 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ steps: ['Claude', 'Warp', 'Chrome'], support: 123, mirrored: 110 });
    expect(merged[1]).toMatchObject({ steps: ['Code', 'Claude', 'Warp'], mirrored: null });
  });

  it('ranks on the pair total, not on one direction', () => {
    const merged = mergeMirrors([
      { steps: ['A', 'B', 'C'], support: 60 },
      { steps: ['C', 'B', 'A'], support: 55 },
      { steps: ['D', 'E', 'F'], support: 80 },
    ]);
    expect(merged.map((m) => m.steps[0])).toEqual(['A', 'D']);
  });
});
