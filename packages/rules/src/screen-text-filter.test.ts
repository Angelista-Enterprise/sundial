import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { filterScreenLines, isKeepRegardless, screenProfileFor, MAX_KEPT_LINES } from './screen-text-filter.js';
import { screenTrack } from './screen-track.js';

describe('screenProfileFor', () => {
  it('names the profile from a bundle id or a process name', () => {
    expect(screenProfileFor('com.googlecode.iterm2')).toBe('terminal');
    expect(screenProfileFor('dev.warp.Warp-Stable')).toBe('terminal');
    expect(screenProfileFor('com.microsoft.VSCode')).toBe('editor');
    expect(screenProfileFor('Cursor')).toBe('editor');
    expect(screenProfileFor('com.google.Chrome')).toBe('browser');
    expect(screenProfileFor('Slack')).toBe('chat');
    expect(screenProfileFor('Finder')).toBe('generic');
    expect(screenProfileFor(null)).toBe('generic');
  });
});

describe('filterScreenLines', () => {
  it('drops frames, console timestamps and low-density lines, keeps prose', () => {
    const { kept, noise } = filterScreenLines(['┌────────┐', '12:03:11 starting worker', 'Reviewing PR #4357', 'Clue 5 must see 5 filled cells', '~~~~~ ////', 'ok'].join('\n'), 'Finder');
    expect(kept).toEqual(['Reviewing PR #4357', 'Clue 5 must see 5 filled cells']);
    expect(noise).toBe(3);
  });

  it('keeps ticket ids, PR numbers, URLs, paths, errors and stack frames whatever their density', () => {
    for (const line of ['PBX-689', 'see #4357', 'https://github.com/x/y', 'src/rules/moment-rollup.ts:271', '    at fold (/ws/a.js:12:3)', 'TypeError: x is not a function', '/Users/me/Projects/x/y']) {
      expect(isKeepRegardless(line), line).toBe(true);
    }
    const { kept } = filterScreenLines('    at fold (/ws/a.js:12:3)\n((((((((((((( PBX-689', 'com.google.Chrome');
    expect(kept).toEqual(['at fold (/ws/a.js:12:3)', '((((((((((((( PBX-689']);
  });

  it('a chat keeps its timestamps; an editor loses its line-number gutter; a terminal tolerates punctuation', () => {
    expect(filterScreenLines('10:42 Pat: lunch at one?', 'Slack').kept).toEqual(['10:42 Pat: lunch at one?']);
    expect(filterScreenLines('10:42 Pat: lunch at one?', 'Warp').kept).toEqual([]);
    expect(filterScreenLines('  42  const x = { a: 1 };', 'com.microsoft.VSCode').kept).toEqual(['const x = { a: 1 };']);
    // 4 letters in 13 non-space characters: 31% — code to a terminal, noise to Finder.
    const code = 'x = (a || b) && !c;';
    expect(filterScreenLines(code, 'Warp').kept).toEqual([code]);
    expect(filterScreenLines(code, 'Finder').kept).toEqual([]);
  });

  it('treats a line seen in the previous capture of the same app as furniture, except a keep-regardless one', () => {
    const previous = new Set(['File Edit View Window Help', 'PBX-689 fix the popup']);
    const { kept, furniture } = filterScreenLines('File Edit View Window Help\nPBX-689 fix the popup\nnew sentence typed here', 'Cursor', previous);
    expect(kept).toEqual(['PBX-689 fix the popup', 'new sentence typed here']);
    expect(furniture).toBe(1);
  });

  it('truncates a long line rather than dropping it, dedupes, and caps the count', () => {
    const long = `Reviewing ${'x'.repeat(400)}`;
    expect(filterScreenLines(long, 'Finder').kept[0]).toHaveLength(200);
    const many = Array.from({ length: 60 }, (_, i) => `sentence number ${i} about something`).join('\n');
    expect(filterScreenLines(many, 'Finder').kept).toHaveLength(MAX_KEPT_LINES);
    expect(filterScreenLines('same line here\nsame line here', 'Finder').kept).toEqual(['same line here']);
  });
});

describe('screenTrack', () => {
  const ev = (id: string, payload: Record<string, unknown>): SanitizedEvent => ({ id, type: 'screen:ocr', ts: '2026-09-04T10:00:00.000Z', payload, sanitized: true });

  it('learns furniture from the previous capture of the same app and forgets it on an app change', () => {
    let state = createInitialState('d');
    state = screenTrack(state, ev('e1', { bundleId: 'com.microsoft.VSCode', screenText: 'EXPLORER  OPEN EDITORS\nfunction reduce(state, event)' })).state;
    expect(state.screen.kept).toEqual(['EXPLORER  OPEN EDITORS', 'function reduce(state, event)']);
    state = screenTrack(state, ev('e2', { bundleId: 'com.microsoft.VSCode', screenText: 'EXPLORER  OPEN EDITORS\nreturn { state, effects }' })).state;
    expect(state.screen.kept).toEqual(['return { state, effects }']);
    expect(state.screen.audit).toEqual({ captures: 2, lines: 4, kept: 3, furniture: 1, noise: 0 });
    state = screenTrack(state, ev('e3', { bundleId: 'com.google.Chrome', screenText: 'EXPLORER  OPEN EDITORS' })).state;
    expect(state.screen.kept).toEqual(['EXPLORER  OPEN EDITORS']);
    expect(state.screen.eventId).toBe('e3');
  });

  it('ignores a private capture without touching the furniture memory', () => {
    let state = createInitialState('d');
    state = screenTrack(state, ev('e1', { bundleId: 'Cursor', screenText: 'some furniture line' })).state;
    const after = screenTrack(state, ev('e2', { bundleId: 'com.1password', screenText: '[private]' })).state;
    expect(after).toBe(state);
  });
});

describe('screenRefs', () => {
  it('pulls ticket keys and PR numbers out of kept lines, first seen first, without repeats', async () => {
    const { screenRefs } = await import('./screen-text-filter.js');
    const lines = ['BOX-484 hint-arrow theme · Jira', 'Pull Request #4592 · BOX-484', 'fix(tile1): win check #4591', 'plain prose with nothing in it'];
    expect(screenRefs(lines)).toEqual(['BOX-484', '#4592', '#4591']);
    expect(screenRefs([])).toEqual([]);
  });
});
