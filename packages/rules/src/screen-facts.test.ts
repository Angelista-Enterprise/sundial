import { describe, expect, it } from 'vitest';
import { createInitialState, defaultMomentRollupExtras } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describeScreenFacts, isCallScreen, screenFactsOf } from './screen-facts.js';
import { screenTrack } from './screen-track.js';
import { momentRollup } from './moment-rollup.js';

const TERMINAL = 'dev.warp.Warp-Stable';

describe('screenFactsOf', () => {
  it('takes the LAST error line in a terminal, with the files around it', () => {
    const lines = ['$ pnpm test', 'Error: first failure, scrolled up', 'src/card.ts:41 render', 'TypeError: cannot read properties of undefined', '$'];
    expect(screenFactsOf(lines, TERMINAL)).toEqual([
      { kind: 'error', value: 'TypeError: cannot read properties of undefined' },
      { kind: 'file', value: 'card.ts' },
    ]);
  });

  it('does not call an error in a chat or a browser the owner\'s own', () => {
    expect(screenFactsOf(['Mira: the build failed again', 'TypeError on staging'], 'Slack')).toEqual([]);
    expect(screenFactsOf(['How to fix TypeError in React'], 'com.google.Chrome')).toEqual([]);
  });

  it('names tickets and PRs, at most four, and files only where code is', () => {
    const facts = screenFactsOf(['BOX-484 Checkout times out', 'Pull Request #4592', 'BOX-485 BOX-486 BOX-487 BOX-488', 'notes.md'], 'com.google.Chrome');
    expect(facts.map((f) => `${f.kind}:${f.value}`)).toEqual(['ticket:BOX-484', 'pr:#4592', 'ticket:BOX-485', 'ticket:BOX-486']);
  });

  it('knows a call by its app or by two of its controls, and reads the name tiles', () => {
    expect(isCallScreen(['Mute', 'Share screen', 'Mira Bakker'], 'com.google.Chrome')).toBe(true);
    expect(isCallScreen(['Mute'], 'com.google.Chrome')).toBe(false);
    expect(isCallScreen([], 'us.zoom.xos')).toBe(true);
    const facts = screenFactsOf(['Mute', 'Leave', 'Mira Bakker', 'Pim van der Mol', 'Share Screen', 'a sentence that is not a name at all'], 'com.google.Chrome', 'Arc');
    expect(facts).toEqual([
      { kind: 'call', value: 'Arc' },
      { kind: 'person', value: 'Mira Bakker' },
      { kind: 'person', value: 'Pim van der Mol' },
    ]);
  });

  it('is bounded and clipped', () => {
    const long = `TypeError: ${'x'.repeat(400)}`;
    const facts = screenFactsOf([long, 'a.ts b.ts c.ts d.ts', 'BOX-1 BOX-2 BOX-3 BOX-4 BOX-5'], TERMINAL);
    expect(facts.length).toBeLessThanOrEqual(8);
    expect(facts[0]!.value.length).toBe(160);
    expect(facts.filter((f) => f.kind === 'file')).toHaveLength(3);
  });

  it('describes facts one line per kind', () => {
    expect(describeScreenFacts([{ kind: 'file', value: 'a.ts' }, { kind: 'error', value: 'boom' }, { kind: 'file', value: 'b.ts' }])).toEqual(['file: a.ts, b.ts', 'error: boom']);
  });
});

describe('screenTrack, per region', () => {
  const ev = (id: string, region: string, screenText: string): SanitizedEvent => ({ id, type: 'screen:ocr', ts: '2026-09-04T10:00:00.000Z', payload: { bundleId: TERMINAL, processName: 'Warp', region, screenText }, sanitized: true });

  it('learns furniture from the previous capture of the same REGION, so alternating captures still match', () => {
    let state = createInitialState('d');
    state = screenTrack(state, ev('f1', 'focused', 'tab strip one\nnpm run build')).state;
    state = screenTrack(state, ev('c1', 'cursor', 'a cursor-sized crop')).state;
    state = screenTrack(state, ev('f2', 'focused', 'tab strip one\nError: build failed')).state;
    // `tab strip one` was in the last FOCUSED capture, two captures back: furniture.
    expect(state.screen.kept).toEqual(['Error: build failed']);
    expect(state.screen.prevLines).toEqual([]);
    expect(state.screen.facts).toEqual([{ kind: 'error', value: 'Error: build failed' }]);
  });

  it('reads an older snapshot\'s single reference until it has its own', () => {
    let state = createInitialState('d');
    state = { ...state, screen: { ...state.screen, app: TERMINAL, prevLines: ['tab strip one'] } };
    state = screenTrack(state, ev('f1', 'focused', 'tab strip one\nnew line here')).state;
    expect(state.screen.kept).toEqual(['new line here']);
  });

  it('keeps Jev\'s readings across captures', () => {
    let state = createInitialState('d');
    const frame = { at: '2026-09-04T09:59:00.000Z', app: TERMINAL, shows: 'terminal', showsP: 0.9, meeting: 0.1, error: 0.2, focus: null };
    state = { ...state, screen: { ...state.screen, frame } };
    state = screenTrack(state, ev('f1', 'focused', 'some line of text')).state;
    expect(state.screen.frame).toEqual(frame);
  });

  it('gathers the facts of every capture into the moment, not only the last', () => {
    const base = createInitialState('d');
    const opened: KernelState = { ...base, moment: { id: 'm1', sessionId: 's1', startTime: '2026-09-04T09:00:00.000Z', processName: 'Warp', projectId: null, rollup: { processName: 'Warp', windowTitles: [], ...defaultMomentRollupExtras }, intent: { status: 'none' } } };
    const fold = (s: KernelState, e: SanitizedEvent): KernelState => momentRollup(screenTrack(s, e).state, e).state;
    let s = fold(opened, ev('f1', 'focused', 'BOX-484 in review'));
    s = fold(s, ev('f2', 'focused', 'Error: build failed'));
    s = fold(s, ev('f3', 'focused', 'Error: build failed'));
    expect(s.moment?.rollup.screenSeen).toEqual([
      { kind: 'ticket', value: 'BOX-484' },
      { kind: 'error', value: 'Error: build failed' },
    ]);
  });
});
