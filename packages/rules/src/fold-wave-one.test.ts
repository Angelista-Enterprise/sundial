// Fold wave one: five streams the log carried and nothing read. One test file,
// because the five rules share a shape (one event type → one slice) and the
// thing worth pinning is the same for each: what the slice says after a
// realistic sequence of the payloads the live log actually holds.
import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { fileTrack, hottestFile } from './file-track.js';
import { shellFailureTrack, normalizeCommand, FAILING_STREAK_NOTICE_AT } from './shell-failure-track.js';
import { pressureTrack, standingPressure } from './pressure-track.js';
import { gitAheadTrack, totalUnpushed } from './git-ahead-track.js';
import { callSpanTrack, classifyCallApp } from './call-span-track.js';

let seq = 0;
const at = (minutes: number) => new Date(Date.parse('2026-09-04T10:00:00.000Z') + minutes * 60_000).toISOString();
const ev = (type: string, payload: Record<string, unknown>, ts = at(0)): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });

function fold(state: KernelState, rule: typeof fileTrack, events: SanitizedEvent[]) {
  const effects: unknown[] = [];
  for (const event of events) {
    const out = rule(state, event);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

describe('fileTrack', () => {
  it('counts touches per file per day, notes which landed while focused, and skips deletes and build noise', () => {
    const { state } = fold(createInitialState('d'), fileTrack, [
      ev('file:changed', { projectRoot: '~/p', changes: [{ relPath: 'src/a.ts', kind: 'modify' }], focused: true }, at(0)),
      ev('file:changed', { projectRoot: '~/p', changes: [{ relPath: 'src/a.ts', kind: 'modify' }, { relPath: 'src/b.ts', kind: 'create' }], focused: false }, at(5)),
      ev('file:changed', { projectRoot: '~/p', changes: [{ relPath: 'src/a.ts', kind: 'modify' }], focused: true }, at(9)),
      ev('file:changed', { projectRoot: '~/p', changes: [{ relPath: 'dist/a.js', kind: 'modify' }, { relPath: 'old.ts', kind: 'delete' }, { relPath: 'vitest.config.ts.timestamp-1788532981318-7be2846b26c988.mjs', kind: 'create' }] }, at(10)),
    ]);
    expect(state.files.day).toBe('2026-09-04');
    expect(state.files.hot['~/p|src/a.ts']).toMatchObject({ changes: 3, focusedChanges: 2, firstAt: at(0), lastAt: at(9) });
    expect(state.files.hot['~/p|src/b.ts']).toMatchObject({ changes: 1, focusedChanges: 0 });
    expect(Object.keys(state.files.hot)).toHaveLength(2);
    expect(hottestFile(state.files.hot)?.relPath).toBe('src/a.ts');
    expect(hottestFile(state.files.hot, 4)).toBeNull();
  });

  it('starts over on the day boundary and on an event from a new local day', () => {
    const first = fold(createInitialState('d'), fileTrack, [ev('file:changed', { projectRoot: '~/p', changes: [{ relPath: 'x.ts' }] }, at(0))]).state;
    expect(fileTrack(first, ev('day:boundary', {}, at(60))).state.files).toEqual({ day: null, hot: {} });
    const nextDay = fileTrack(first, ev('file:changed', { projectRoot: '~/p', changes: [{ relPath: 'y.ts' }] }, '2026-09-05T09:00:00.000Z')).state;
    expect(Object.keys(nextDay.files.hot)).toEqual(['~/p|y.ts']);
  });
});

describe('fileTrack tool caches (U2-F21)', () => {
  it('drops changes under any dot-folder but .github', () => {
    const { state } = fold(createInitialState('d'), fileTrack, [
      ev('file:changed', { projectRoot: '~/p', changes: [{ relPath: '.claude/worktrees/x/src/a.ts', kind: 'modify' }, { relPath: 'pkg/.cache/b.json', kind: 'modify' }, { relPath: '.github/workflows/ci.yml', kind: 'modify' }, { relPath: 'src/.env.example', kind: 'modify' }] }),
    ]);
    expect(Object.keys(state.files.hot).sort()).toEqual(['~/p|.github/workflows/ci.yml', '~/p|src/.env.example']);
  });
});

describe('shellFailureTrack', () => {
  const run = (command: string, exitCode: number | null, minutes: number) => ev('shell:command', { command, cwd: '~/p', exitCode, durationMs: 0 }, at(minutes));

  it('normalises whitespace only — a retry with a new flag is a different attempt', () => {
    expect(normalizeCommand('  npm   test ')).toBe('npm test');
    expect(normalizeCommand('npm test -- --watch')).not.toBe(normalizeCommand('npm test'));
  });

  it('raises one phasic notice at the third failure in a row — whatever the commands — and a success ends the streak', () => {
    // A person at a terminal changes the command between failures; the streak is the
    // run of failures, not the repetition of one command.
    const { state, effects } = fold(createInitialState('d'), shellFailureTrack, [run('npm test', 1, 0), run('npm test -- --grep x', 1, 1), run('npx vitest run', 1, 2), run('npm test', 1, 3)]);
    expect(state.shell.streak).toMatchObject({ command: 'npm test', count: 4, exitCode: 1, noticedAtCount: FAILING_STREAK_NOTICE_AT });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      type: 'EmitEvent',
      event: { type: 'notice:candidate', payload: { kind: 'shell-failing-streak', key: `shell-failing:~/p:${at(0).slice(0, 13)}`, valueHalfLifeMs: 15 * 60 * 1000 } },
    });
    expect(String((effects[0] as { event: { payload: { observation: string } } }).event.payload.observation)).toContain('3 commands in a row have failed');
    const after = shellFailureTrack(state, run('npm test', 0, 4)).state;
    expect(after.shell.streak).toBeNull();
    expect(after.shell.lastCommandAt).toBe(at(4));
  });

  it('keeps the last failure per folder until the same command passes there (U2-F17)', () => {
    const other = ev('shell:command', { command: 'ls', cwd: '~/q', exitCode: 0 }, at(2));
    const { state } = fold(createInitialState('d'), shellFailureTrack, [run('pnpm test', 1, 0), run('git push', 0, 1), other]);
    // A success of another command, or anywhere else, is not the fix.
    expect(state.shell.streak).toBeNull();
    expect(state.shell.lastFailure?.['~/p']).toEqual({ command: 'pnpm test', exitCode: 1, at: at(0) });
    expect(shellFailureTrack(state, run('pnpm test', 0, 3)).state.shell.lastFailure).toEqual({});
  });

  it('a null exit code neither extends nor breaks; a gap over 30 min starts a fresh streak; a different command continues it', () => {
    const { state } = fold(createInitialState('d'), shellFailureTrack, [run('make', 2, 0), run('ls', null, 1), run('make', 2, 2)]);
    expect(state.shell.streak?.count).toBe(2);
    expect(shellFailureTrack(state, run('make', 2, 40)).state.shell.streak?.count).toBe(1);
    expect(shellFailureTrack(state, run('cargo build', 101, 3)).state.shell.streak).toMatchObject({ command: 'cargo build', count: 3, exitCode: 101 });
  });
});

describe('pressureTrack', () => {
  it('keeps since-when a badge sat at its value, and drops apps that cleared', () => {
    const payload = (counts: { app: string; count: number }[]) => ev('event:notification', { counts: counts.map((c) => ({ ...c, source: 'dock-badge' })), totalCount: counts.reduce((s, c) => s + c.count, 0) });
    const { state } = fold(createInitialState('d'), pressureTrack, [
      { ...payload([{ app: 'Slack', count: 14 }, { app: 'WhatsApp', count: 2 }]), ts: at(0) },
      { ...payload([{ app: 'Slack', count: 14 }, { app: 'WhatsApp', count: 3 }]), ts: at(60) },
      { ...payload([{ app: 'Slack', count: 14 }]), ts: at(150) },
    ]);
    expect(state.pressure.byApp.Slack).toEqual({ count: 14, since: at(0), updatedAt: at(150) });
    expect(state.pressure.byApp.WhatsApp).toBeUndefined();
    expect(state.pressure.total).toBe(14);
    expect(standingPressure(state.pressure.byApp, Date.parse(at(150)))).toEqual([{ app: 'Slack', count: 14, hours: 3 }]);
    expect(standingPressure(state.pressure.byApp, Date.parse(at(30)))).toEqual([]);
  });
});

describe('gitAheadTrack', () => {
  const status = (cwd: string, branch: string, ahead: number | null, minutes: number) => ev('git:status', { branch, cwd, ahead, behind: 0, dirtyFiles: 0 }, at(minutes));

  it('tracks unpushed commits per working copy from the first non-zero read, clears on zero, ignores null', () => {
    const { state } = fold(createInitialState('d'), gitAheadTrack, [status('~/a', 'main', 0, 0), status('~/a', 'main', 2, 10), status('~/a', 'main', 5, 20), status('~/b', 'feat', null, 21), status('~/b', 'feat', 1, 22)]);
    expect(state.git.unpushed['~/a']).toEqual({ branch: 'main', ahead: 5, since: at(10), updatedAt: at(20) });
    expect(state.git.unpushed['~/b']).toMatchObject({ ahead: 1 });
    expect(totalUnpushed(state.git.unpushed)).toBe(6);
    const pushed = gitAheadTrack(state, status('~/a', 'main', 0, 30)).state;
    expect(pushed.git.unpushed['~/a']).toBeUndefined();
    expect(gitAheadTrack(pushed, status('~/a', 'main', null, 31)).state).toBe(pushed);
  });

  it('a branch switch restarts since', () => {
    const { state } = fold(createInitialState('d'), gitAheadTrack, [status('~/a', 'main', 2, 0), status('~/a', 'feat', 1, 10)]);
    expect(state.git.unpushed['~/a']).toMatchObject({ branch: 'feat', ahead: 1, since: at(10) });
  });

  it('W6 D2: an ahead n → 0 on the same branch is a push, derived once; a hook push first, or a branch switch, derives none', () => {
    const pushes = (events: ReturnType<typeof status>[]) => {
      let state = createInitialState('d');
      const out: Record<string, unknown>[] = [];
      for (const e of events) {
        const r = gitAheadTrack(state, e);
        state = r.state;
        for (const fx of r.effects) if (fx.type === 'EmitEvent' && fx.event.type === 'git:push') out.push(fx.event.payload);
      }
      return out;
    };
    expect(pushes([status('~/puzzlebox-studio', 'main', 3, 0), status('~/puzzlebox-studio', 'main', 0, 5)])).toEqual([{ timestamp: at(5), cwd: '~/puzzlebox-studio', branch: 'main', remote: null, derived: true, commits: 3 }]);
    const hook = ev('git:push', { cwd: '~/puzzlebox-studio', branch: 'main', remote: 'origin', command: 'git push' }, at(4));
    expect(pushes([status('~/puzzlebox-studio', 'main', 3, 0), hook, status('~/puzzlebox-studio', 'main', 0, 5)])).toEqual([]);
    expect(pushes([status('~/puzzlebox-studio', 'feat', 3, 0), status('~/puzzlebox-studio', 'main', 0, 5)])).toEqual([]);
  });
});

describe('callSpanTrack', () => {
  const media = (audioInputProcess: string | null, camera: boolean, minutes: number) => ev('media:state', { audioInput: audioInputProcess !== null, audioOutput: true, camera, audioInputProcess, audioOutputProcess: 'Google Chrome', cameraProcess: camera ? audioInputProcess : null }, at(minutes));

  it('opens on the mic, closes on its release, remembers the last call, and hands over between apps', () => {
    const { state } = fold(createInitialState('d'), callSpanTrack, [media(null, false, 0), media('WhatsApp', false, 1), media('WhatsApp', false, 2)]);
    expect(state.av.call).toEqual({ app: 'WhatsApp', kind: 'personal-call', since: at(1), cameraEver: false });
    const closed = callSpanTrack(state, media(null, false, 30)).state;
    expect(closed.av.call).toBeNull();
    expect(closed.av.lastCall).toEqual({ app: 'WhatsApp', kind: 'personal-call', since: at(1), cameraEver: false, until: at(30) });
    const handed = fold(state, callSpanTrack, [media('zoom.us', true, 3)]).state;
    expect(handed.av.call).toMatchObject({ app: 'zoom.us', kind: 'work-call', cameraEver: true });
    expect(handed.av.lastCall?.until).toBe(at(3));
  });

  it('classifies a browser as a work call and an unknown app as just a call', () => {
    expect(classifyCallApp('Google Chrome')).toBe('work-call');
    expect(classifyCallApp('Microsoft Teams')).toBe('work-call');
    expect(classifyCallApp('‎WhatsApp')).toBe('personal-call');
    expect(classifyCallApp('Some Recorder')).toBe('call');
  });
});
