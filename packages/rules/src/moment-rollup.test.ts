import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { momentRollup } from './moment-rollup.js';

function withMoment(state: KernelState): KernelState {
  return {
    ...state,
    moment: {
      id: 'm1',
      sessionId: 's1',
      startTime: '2026-01-01T00:00:00.000Z',
      processName: 'Code',
      projectId: null,
      rollup: { processName: 'Code', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null },
      intent: { status: 'none' },
    },
  };
}

function event(type: string, payload: Record<string, unknown> = {}): SanitizedEvent {
  return { id: 'e1', type, ts: '2026-01-01T00:00:05.000Z', payload, sanitized: true };
}

describe('momentRollup', () => {
  it('is a no-op when nothing is open', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = momentRollup(state, event('shell:command', { command: 'ls' }));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('counts every shell command', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('shell:command', { command: 'ls' })).state;
    state = momentRollup(state, event('shell:command', { command: 'cd foo' })).state;
    expect(state.moment?.rollup.shellCommandCount).toBe(2);
  });

  it('keeps the commands that say what was attempted, and drops the ones that say nothing', () => {
    // The filter this replaced was a deploy detector: it knew `git commit` and
    // `npm test` and nothing else, so a real session of `pnpm`, `vitest`,
    // `sqlite3` and `git status` reported 32 commands and named none of them.
    let state = withMoment(createInitialState('d1'));
    for (const command of ['ls -la', 'cd ~/Projects/sundial', 'pwd', 'echo hello', 'npx vitest run packages/rules', 'git status --short', 'sqlite3 ~/.sundial/sundial.db "select count(*) from moments;"']) {
      state = momentRollup(state, event('shell:command', { command })).state;
    }
    expect(state.moment?.rollup.notableCommands).toEqual([
      'npx vitest run packages/rules',
      'git status --short',
      'sqlite3 ~/.sundial/sundial.db "select count(*) from moments;"',
    ]);
    // Every command is still counted; notability decides what is NAMED.
    expect(state.moment?.rollup.shellCommandCount).toBe(7);
  });

  it('drops the cd bookkeeping, shortens a long pipeline, and says a repeated command once', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('shell:command', { command: 'cd "$HOME/Projects/sundial" && npx tsc -b tsconfig.json --force' })).state;
    state = momentRollup(state, event('shell:command', { command: 'npx tsc -b tsconfig.json --force' })).state;
    state = momentRollup(state, event('shell:command', { command: `sqlite3 db "select ${'x'.repeat(120)};"` })).state;
    const [first, second, ...rest] = state.moment!.rollup.notableCommands;
    expect(first).toBe('npx tsc -b tsconfig.json --force'); // the cd was bookkeeping, and the repeat is the same thing
    expect(rest).toEqual([]);
    expect(second).toHaveLength(72);
    expect(second.endsWith('…')).toBe(true);
    expect(state.moment?.rollup.shellCommandCount).toBe(3);
  });

  it('caps notableCommands at 12', () => {
    let state = withMoment(createInitialState('d1'));
    for (let i = 0; i < 15; i++) {
      state = momentRollup(state, event('shell:command', { command: `git commit -m "c${i}"` })).state;
    }
    expect(state.moment?.rollup.notableCommands).toHaveLength(12);
    expect(state.moment?.rollup.notableCommands).toContain('git commit -m "c14"');
  });

  it('counts git commits and tracks the branch', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('git:commit', { branch: 'main' })).state;
    state = momentRollup(state, event('git:commit', { branch: 'main' })).state;
    expect(state.moment?.rollup.gitCommitCount).toBe(2);
    expect(state.moment?.rollup.gitBranch).toBe('main');
  });

  it('flips calendarActive to true and keeps it there', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('calendar:active')).state;
    expect(state.moment?.rollup.calendarActive).toBe(true);
  });

  it('counts input:activity windows', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('input:activity')).state;
    state = momentRollup(state, event('input:activity')).state;
    state = momentRollup(state, event('input:activity')).state;
    expect(state.moment?.rollup.typingEventCount).toBe(3);
  });

  it('records derived life-event types, capped at 20', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('event:big-commit')).state;
    state = momentRollup(state, event('event:thrashing')).state;
    expect(state.moment?.rollup.lifeEvents).toEqual(['event:big-commit', 'event:thrashing']);
  });

  it('ignores unrelated event types', () => {
    const state = withMoment(createInitialState('d1'));
    const { state: next, effects } = momentRollup(state, event('window:changed', { processName: 'Code' }));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  describe('C1: sensor disposition', () => {
    it('git:status updates gitBranch without touching gitCommitCount', () => {
      let state = withMoment(createInitialState('d1'));
      state = momentRollup(state, event('git:status', { branch: 'feature/x' })).state;
      expect(state.moment?.rollup.gitBranch).toBe('feature/x');
      expect(state.moment?.rollup.gitCommitCount).toBe(0);
    });

    it('git:status keeps the existing branch when the payload omits it', () => {
      let state = withMoment(createInitialState('d1'));
      state = momentRollup(state, event('git:commit', { branch: 'main' })).state;
      state = momentRollup(state, event('git:status', {})).state;
      expect(state.moment?.rollup.gitBranch).toBe('main');
    });

    /**
     * C19 — `ahead` was produced on all 15,120 `git:status` emissions and read by
     * nothing. These pin the reader, because a field with a producer and no
     * consumer is exactly the kind of thing that goes quietly missing again.
     */
    it('git:status records unpushed commits from `ahead`', () => {
      let state = withMoment(createInitialState('d1'));
      state = momentRollup(state, event('git:status', { branch: 'main', ahead: 3 })).state;
      expect(state.moment?.rollup.unpushedCommits).toBe(3);
    });

    it('keeps the high water mark, so a push midway does not erase the moment’s work', () => {
      let state = withMoment(createInitialState('d1'));
      state = momentRollup(state, event('git:status', { branch: 'main', ahead: 4 })).state;
      state = momentRollup(state, event('git:status', { branch: 'main', ahead: 0 })).state;
      expect(state.moment?.rollup.unpushedCommits).toBe(4);
    });

    it('leaves unpushed commits alone when the payload has no `ahead` (no upstream)', () => {
      let state = withMoment(createInitialState('d1'));
      state = momentRollup(state, event('git:status', { branch: 'main', ahead: 2 })).state;
      state = momentRollup(state, event('git:status', { branch: 'main', ahead: null })).state;
      expect(state.moment?.rollup.unpushedCommits).toBe(2);
    });

    it('media:usage records a start/end transition but skips heartbeats', () => {
      let state = withMoment(createInitialState('d1'));
      state = momentRollup(state, event('media:usage', { kind: 'audio-output', phase: 'start' })).state;
      state = momentRollup(state, event('media:usage', { kind: 'audio-output', phase: 'heartbeat' })).state;
      state = momentRollup(state, event('media:usage', { kind: 'audio-output', phase: 'end' })).state;
      expect(state.moment?.rollup.lifeEvents).toEqual(['media:audio-output:start', 'media:audio-output:end']);
    });

    it('symbol:edited appends one summary line per batch, not one per symbol', () => {
      let state = withMoment(createInitialState('d1'));
      state = momentRollup(
        state,
        event('symbol:edited', { edits: [{ file: 'a.ts', symbols: ['foo', 'bar'] }, { file: 'b.ts', symbols: ['baz'] }], totalSymbolCount: 3 }),
      ).state;
      expect(state.moment?.rollup.lifeEvents).toEqual(['symbol:edited (3 symbols across 2 files)']);
    });

    it('symbol:edited is a no-op when the batch has no edits', () => {
      const state = withMoment(createInitialState('d1'));
      const { state: next, effects } = momentRollup(state, event('symbol:edited', { edits: [] }));
      expect(next).toBe(state);
      expect(effects).toEqual([]);
    });

    it.each(['git:push', 'git:pr-status', 'calendar:context-event', 'audio:device-changed', 'clipboard:activity'])(
      'folds %s into lifeEvents via the generic branch',
      (type) => {
        let state = withMoment(createInitialState('d1'));
        state = momentRollup(state, event(type)).state;
        expect(state.moment?.rollup.lifeEvents).toEqual([type]);
      },
    );
  });
});

describe('momentRollup — P7 screen:ocr', () => {
  it('accumulates deduped topics and keeps the latest excerpt', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('screen:ocr', { topics: ['code', 'github'], screenText: 'Clue 5 must see 5 filled cells' })).state;
    state = momentRollup(state, event('screen:ocr', { topics: ['github', 'chat'], screenText: 'Reviewing PR #4357' })).state;
    expect(state.moment?.rollup.screenTopics).toEqual(['code', 'github', 'chat']);
    expect(state.moment?.rollup.screenExcerpt).toBe('Reviewing PR #4357');
  });

  it('never lets a redacted [private] capture become the excerpt', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('screen:ocr', { topics: ['code'], screenText: 'visible code line' })).state;
    state = momentRollup(state, event('screen:ocr', { topics: ['chat'], screenText: '[private]' })).state;
    expect(state.moment?.rollup.screenExcerpt).toBe('visible code line');
    expect(state.moment?.rollup.screenTopics).toEqual(['code', 'chat']);
  });

  it('caps the excerpt length', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('screen:ocr', { screenText: 'x'.repeat(1000) })).state;
    expect((state.moment?.rollup.screenExcerpt ?? '').length).toBe(240);
  });
});

describe('momentRollup — ambient hearing (audio:transcript)', () => {
  it('keeps the TAIL of a conversation and every language heard', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('audio:transcript', { spokenText: 'Ik denk dat het wel zou moeten werken.', language: 'dutch' })).state;
    state = momentRollup(state, event('audio:transcript', { spokenText: 'Both of these work.', language: 'english' })).state;
    expect(state.moment?.rollup.spokenExcerpt).toBe('Ik denk dat het wel zou moeten werken. Both of these work.');
    expect(state.moment?.rollup.spokenLanguages).toEqual(['dutch', 'english']);
  });

  it('drops the oldest words rather than refusing the newest', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('audio:transcript', { spokenText: 'a'.repeat(590), language: 'dutch' })).state;
    state = momentRollup(state, event('audio:transcript', { spokenText: 'het laatste woord', language: 'dutch' })).state;
    const excerpt = state.moment?.rollup.spokenExcerpt ?? '';
    expect(excerpt.length).toBe(600);
    // What was said most recently is what survives the cap.
    expect(excerpt.endsWith('het laatste woord')).toBe(true);
  });

  it('ignores an empty or fully redacted utterance', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('audio:transcript', { spokenText: 'echte woorden', language: 'dutch' })).state;
    state = momentRollup(state, event('audio:transcript', { spokenText: '[private]', language: 'dutch' })).state;
    state = momentRollup(state, event('audio:transcript', { spokenText: '   ', language: 'dutch' })).state;
    expect(state.moment?.rollup.spokenExcerpt).toBe('echte woorden');
  });

  it('does not record "unknown" as a language it heard', () => {
    let state = withMoment(createInitialState('d1'));
    state = momentRollup(state, event('audio:transcript', { spokenText: 'iets', language: 'unknown' })).state;
    expect(state.moment?.rollup.spokenLanguages).toEqual([]);
  });
});

describe('momentRollup dev-activity evidence (devActivityByProject)', () => {
  function withKnownProjects(state: KernelState, aliases: Record<string, string> = {}): KernelState {
    return {
      ...state,
      config: { ...state.config, projectAliases: aliases },
      project: {
        ...state.project,
        known: {
          '~/Projects/acme/gnomon': { name: 'gnomon', org: null, remote: null, branch: null },
          '~/Projects/doe/wcs': { name: 'wcs', org: null, remote: null, branch: null },
        },
      },
    };
  }

  it('tallies a git:status cwd under the known root it resolves to', () => {
    let state = withKnownProjects(withMoment(createInitialState('d1')));
    state = momentRollup(state, event('git:status', { branch: 'main', cwd: '~/Projects/acme/gnomon' })).state;
    state = momentRollup(state, event('git:status', { branch: 'main', cwd: '~/Projects/acme/gnomon/packages' })).state;
    expect(state.moment?.rollup.devActivityByProject).toEqual({ '~/Projects/acme/gnomon': 2 });
  });

  it('tallies shell:command and git:commit cwds too', () => {
    let state = withKnownProjects(withMoment(createInitialState('d1')));
    state = momentRollup(state, event('shell:command', { command: 'ls', cwd: '~/Projects/acme/gnomon/' })).state;
    state = momentRollup(state, event('git:commit', { branch: 'main', cwd: '~/Projects/acme/gnomon' })).state;
    expect(state.moment?.rollup.devActivityByProject).toEqual({ '~/Projects/acme/gnomon': 2 });
  });

  it('a cwd under no known root contributes nothing (no guessing)', () => {
    let state = withKnownProjects(withMoment(createInitialState('d1')));
    state = momentRollup(state, event('git:status', { branch: 'main', cwd: '~/Somewhere/else' })).state;
    expect(state.moment?.rollup.devActivityByProject ?? {}).toEqual({});
    expect(state.moment?.rollup.gitBranch).toBe('main');
  });

  it('honours the owner alias map: activity in an aliased checkout counts toward the declared project', () => {
    let state = withKnownProjects(withMoment(createInitialState('d1')), { wcs: 'gnomon' });
    state = momentRollup(state, event('git:status', { branch: 'main', cwd: '~/Projects/doe/wcs' })).state;
    expect(state.moment?.rollup.devActivityByProject).toEqual({ '~/Projects/acme/gnomon': 1 });
  });

  describe('J3.3 / J3.4 evidence on the rollup', () => {
    it('keeps a bounded, deduplicated set of screen facts and the last page excerpt', () => {
      const base = createInitialState('d1');
      const open = { ...base, moment: { id: 'm', sessionId: 's', startTime: '2026-09-22T10:00:00.000Z', processName: 'Arc', projectId: null, rollup: { ...base.moment?.rollup, processName: 'Arc', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null } as never, intent: { status: 'none' } } as never };
      const withFacts = momentRollup(open, { id: 'f', type: 'screen:fact', ts: '2026-09-22T10:01:00.000Z', payload: { facts: ['A diff is open', 'A diff is open', 7, ' Tests failing '] }, sanitized: true }).state;
      expect(withFacts.moment?.rollup.screenFacts).toEqual(['A diff is open', 'Tests failing']);
      const withPage = momentRollup(withFacts, { id: 'p', type: 'page:text', ts: '2026-09-22T10:02:00.000Z', payload: { text: ` ${'lorem '.repeat(200)}` }, sanitized: true }).state;
      expect(withPage.moment?.rollup.pageExcerpt).toHaveLength(600);
      expect(momentRollup(withPage, { id: 'q', type: 'page:text', ts: '2026-09-22T10:03:00.000Z', payload: { text: '   ' }, sanitized: true }).state).toBe(withPage);
    });
  });
});
