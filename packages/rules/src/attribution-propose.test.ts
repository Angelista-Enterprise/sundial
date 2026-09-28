import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { attributionPropose, candidateFor, isOpaqueSegment, MAX_CANDIDATES, MAX_DWELL_MS, pathOf } from './attribution-propose.js';
import { hostOf } from '@sundial/helpers/window-classification.js';
import { windowTrack } from './window-track.js';

const T0 = '2026-09-07T09:00:00.000Z';
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

function win(ts: string, payload: Record<string, unknown>): SanitizedEvent {
  return { id: `w-${ts}`, type: 'window:changed', ts, payload, sanitized: true };
}
function decided(ts: string, payload: Record<string, unknown>): SanitizedEvent {
  return { id: `d-${ts}`, type: 'attribution:rule-decided', ts, payload, sanitized: true };
}

/** windowTrack then attributionPropose, the manifest order that matters here. */
function fold(state: KernelState, event: SanitizedEvent): KernelState {
  return attributionPropose(windowTrack(state, event).state, event).state;
}

const JIRA = { processName: 'Google Chrome', windowTitle: 'Puzzlebox - Backlog - Jira - Google Chrome - Pat (Acme)', documentPath: 'https://acme.atlassian.net/jira/software/c/projects/BOX' };
const CLAUDE = { processName: 'Claude', windowTitle: 'Claude', documentPath: null };

describe('hostOf', () => {
  it('names the host, keeps a dev port, drops www and browser-internal pages', () => {
    expect(hostOf('https://www.acme.atlassian.net/jira')).toBe('acme.atlassian.net');
    expect(hostOf('http://localhost:8080/hub')).toBe('localhost:8080');
    expect(hostOf('chrome://newtab/')).toBeNull();
    expect(hostOf('file:///Users/x/a.pdf')).toBeNull();
  });
});

describe('attributionPropose', () => {
  it('times an unattributed browser page by host across many short visits', () => {
    let s = createInitialState('d1');
    // 156 twelve-second visits to Jira, each too short to be its own moment.
    for (let i = 0; i < 156; i += 1) {
      s = fold(s, win(at(i * 24), JIRA));
      s = fold(s, win(at(i * 24 + 12), CLAUDE));
    }
    const c = s.attributionProposals.candidates['host:acme.atlassian.net'];
    expect(c).toBeDefined();
    expect(Math.round(c!.seconds)).toBe(156 * 12);
    expect(c!.visits).toBe(156);
    expect(c!.kind).toBe('host');
    // The title without the browser's own furniture: every title on this
    // machine ends " - Google Chrome - Pat (Acme)", which is the same on
    // every row and buries the part that differs.
    expect(c!.titles).toEqual(['Puzzlebox - Backlog - Jira']);
    expect(c!.days).toEqual(['2026-09-07']);
    // The path, query stripped, two segments deep: the part of the host that
    // can belong to its own project.
    expect(Object.values(c!.parts ?? {})).toEqual([{ kind: 'path', label: '/jira/software', seconds: 156 * 12, visits: 156 }]);
  });

  it('names a path without its query, two segments deep', () => {
    expect(pathOf('https://figma.com/file/abc123/Northwind-Design?node-id=1-2&t=xyz')).toBe('/file/abc123');
    expect(pathOf('http://localhost:8080/puzzlez/scrypto/2026/07/25')).toBe('/puzzlez/scrypto');
    expect(pathOf('https://meet.google.com/?authuser=0')).toBeNull();
    expect(pathOf('https://google.com')).toBeNull();
  });

  it('splits a multi-project host by path, and assigning ONE path leaves the rest of the host in play', () => {
    const figma = (file: string, title: string) => ({ processName: 'Google Chrome', windowTitle: `${title} – Figma - Google Chrome - Pat (Acme)`, documentPath: `https://figma.com/file/${file}/x?node-id=9` });
    let s = createInitialState('d1');
    for (let i = 0; i < 10; i += 1) {
      s = fold(s, win(at(i * 200), figma('eteck1', 'Northwind app')));
      s = fold(s, win(at(i * 200 + 90), figma('puz1', 'Puzzles board')));
      s = fold(s, win(at(i * 200 + 180), CLAUDE));
    }
    const before = s.attributionProposals.candidates['host:figma.com']!;
    expect(Object.keys(before.parts ?? {}).sort()).toEqual(['path:/file/eteck1', 'path:/file/puz1']);

    // One file becomes Northwind. The host is NOT settled — the other file is still
    // unplaced, and a host-wide rule would have claimed it for Northwind too.
    const { state: after } = attributionPropose(
      s,
      decided(at(3000), { key: 'host:figma.com', decision: 'assigned', project: 'northwind', partKey: 'path:/file/eteck1', rule: { urlContains: 'figma.com/file/eteck1', project: 'northwind' } }),
    );
    expect(after.attributionProposals.decided['host:figma.com']).toBeUndefined();
    const rest = after.attributionProposals.candidates['host:figma.com']!;
    expect(Object.keys(rest.parts ?? {})).toEqual(['path:/file/puz1']);
    expect(rest.seconds).toBeCloseTo(before.seconds - (before.parts!['path:/file/eteck1']!.seconds), 5);
    expect(after.config.projectRules).toEqual([{ urlContains: 'figma.com/file/eteck1', project: 'northwind' }]);
  });

  it('a shared place is remembered in config and never timed again', () => {
    const meet = { processName: 'Google Chrome', windowTitle: 'Meet - uth-mkip-zwx - Google Chrome - Pat (Acme)', documentPath: 'https://meet.google.com/uth-mkip-zwx' };
    let s = createInitialState('d1');
    s = fold(s, win(at(0), meet));
    s = fold(s, win(at(300), CLAUDE));
    expect(s.attributionProposals.candidates['host:meet.google.com']).toBeDefined();

    const { state: shared } = attributionPropose(s, decided(at(400), { key: 'host:meet.google.com', decision: 'shared' }));
    expect(shared.config.sharedPlaces).toEqual(['meet.google.com']);
    expect(shared.attributionProposals.candidates['host:meet.google.com']).toBeUndefined();
    expect(shared.attributionProposals.decided['host:meet.google.com']).toMatchObject({ decision: 'shared', project: null });

    // And from here on it is not even watched: a place that carries a different
    // project every hour is not one project, and asking again is the annoyance.
    const later = fold(shared, win(at(500), meet));
    expect(later.attributionProposals.watching).toBeNull();
    const settled = fold(later, win(at(800), CLAUDE));
    expect(settled.attributionProposals.candidates['host:meet.google.com']).toBeUndefined();
  });

  it('a personal place is settled without a project and without a rule', () => {
    const spotify = { processName: 'Spotify', windowTitle: 'Boufi - Prada', documentPath: null };
    let s = createInitialState('d1');
    s = fold(s, win(at(0), spotify));
    s = fold(s, win(at(300), CLAUDE));
    const { state: personal } = attributionPropose(s, decided(at(400), { key: 'app:Spotify', decision: 'personal' }));
    expect(personal.attributionProposals.decided['app:Spotify']).toMatchObject({ decision: 'personal', project: null });
    expect(personal.config.projectRules).toEqual([]);
    expect(personal.config.sharedPlaces).toEqual([]);
  });

  it('caps one period at MAX_DWELL_MS: a window left open is not evidence', () => {
    let s = createInitialState('d1');
    s = fold(s, win(at(0), JIRA));
    s = fold(s, win(at(3 * 60 * 60), CLAUDE));
    expect(s.attributionProposals.candidates['host:acme.atlassian.net']!.seconds).toBe(MAX_DWELL_MS / 1000);
  });

  it('does not time a window a rule already attributes', () => {
    let s = createInitialState('d1');
    s = { ...s, config: { ...s.config, projectRules: [{ urlContains: 'acme.atlassian.net', project: 'puzzlebox-studio' }] } };
    s = fold(s, win(at(0), JIRA));
    expect(s.attributionProposals.watching).toBeNull();
    s = fold(s, win(at(30), CLAUDE));
    expect(s.attributionProposals.candidates).toEqual({});
  });

  it('times an app with no locator by name, never stores a private title, ignores system processes', () => {
    let s = createInitialState('d1');
    s = fold(s, win(at(0), { processName: 'Notion', windowTitle: '[private]', documentPath: null }));
    expect(s.attributionProposals.watching?.key).toBe('app:Notion');
    expect(s.attributionProposals.watching?.title).toBeNull();
    s = fold(s, win(at(40), { processName: 'loginwindow', windowTitle: '', documentPath: null }));
    expect(s.attributionProposals.watching).toBeNull();
    expect(s.attributionProposals.candidates['app:Notion']!.titles).toEqual([]);
    expect(s.attributionProposals.candidates['app:Notion']!.seconds).toBe(40);
  });

  it('a browser between pages is nowhere: not timed', () => {
    const s = createInitialState('d1');
    expect(candidateFor(s, { processName: 'Google Chrome', windowTitle: 'New Tab - Google Chrome', documentPath: 'chrome://newtab/' })).toBeNull();
  });

  it('a decision closes the candidate, remembers the key, and grows the live config rules', () => {
    let s = createInitialState('d1');
    s = fold(s, win(at(0), JIRA));
    s = fold(s, win(at(60), CLAUDE));
    const rule = { urlContains: 'acme.atlassian.net', project: 'puzzlebox-studio' };
    s = attributionPropose(s, decided(at(61), { key: 'host:acme.atlassian.net', decision: 'assigned', project: 'puzzlebox-studio', rule })).state;
    expect(s.attributionProposals.candidates['host:acme.atlassian.net']).toBeUndefined();
    expect(s.attributionProposals.decided['host:acme.atlassian.net']).toEqual({ decision: 'assigned', project: 'puzzlebox-studio', at: at(61) });
    expect(s.config.projectRules).toEqual([rule]);
    // From now on the same page attributes, so it is never timed again.
    s = fold(s, win(at(62), JIRA));
    expect(s.window.attribution.projectId).not.toBeNull();
    expect(s.attributionProposals.watching).toBeNull();
    // And the same decision twice does not duplicate the rule.
    s = attributionPropose(s, decided(at(63), { key: 'host:acme.atlassian.net', decision: 'assigned', project: 'puzzlebox-studio', rule })).state;
    expect(s.config.projectRules).toHaveLength(1);
  });

  it('an ignored key is never timed again, and a malformed decision changes nothing', () => {
    let s = createInitialState('d1');
    s = attributionPropose(s, decided(at(0), { key: 'app:Notion', decision: 'ignored' })).state;
    s = fold(s, win(at(1), { processName: 'Notion', windowTitle: 'x', documentPath: null }));
    expect(s.attributionProposals.watching).toBeNull();
    const before = s;
    s = attributionPropose(s, decided(at(2), { key: '', decision: 'assigned' })).state;
    expect(s).toBe(before);
  });
});

describe('a place a rule can be written for', () => {
  it('reads a path as a place, and refuses one made of ids', () => {
    // Readable: the segments name something.
    expect(pathOf('http://localhost:8080/puzzlez/scrypto/2026/07/25')).toBe('/puzzlez/scrypto');
    expect(pathOf('https://acme.atlassian.net/jira/software/c/projects/BOX')).toBe('/jira/software');
    // Opaque: a Figma file id and a Meet code say nothing to the owner, so the
    // title has to carry the project instead.
    expect(pathOf('https://figma.com/file/PjKq2xR9mVb3nT/Northwind?node-id=1')).toBeNull();
    expect(pathOf('https://meet.google.com/uth-mkip-zwx')).toBeNull();
    expect(isOpaqueSegment('PjKq2xR9mVb3nT')).toBe(true);
    expect(isOpaqueSegment('uth-mkip-zwx')).toBe(true);
    expect(isOpaqueSegment('puzzlez')).toBe(false);
    expect(isOpaqueSegment('jira')).toBe(false);
  });

  it('times a call by the meeting the calendar says is running in it', () => {
    const base = createInitialState('d1');
    // The meeting lives on the SCHEDULE slice, not on the open moment: momentClose
    // folds before windowTrack, so a moment's meetingTitle is blank on the very
    // window change that enters the call.
    const inMeeting: KernelState = { ...base, schedule: { ...base.schedule, active: { title: 'RRA: Kruiswoorden testen', start: T0, end: at(3600) } } };
    const meet = { processName: 'Google Chrome', windowTitle: 'Meet - uth-mkip-zwx - Google Chrome - Pat (Acme)', documentPath: 'https://meet.google.com/uth-mkip-zwx' };
    const candidate = candidateFor(inMeeting, meet);
    expect(candidate).toMatchObject({ key: 'host:meet.google.com', kind: 'host', part: { kind: 'meeting', label: 'RRA: Kruiswoorden testen' } });
    // No meeting running: the code in the title is all there is, and it is not a place.
    expect(candidateFor(base, meet)?.part).toBeNull();
  });

  it('splits Figma by the file in the title, since the path is an id', () => {
    const base = createInitialState('d1');
    const figma = (title: string) => ({ processName: 'Google Chrome', windowTitle: `${title} – Figma - Google Chrome - Pat (Acme)`, documentPath: 'https://figma.com/file/PjKq2xR9mVb3nT/x?node-id=9' });
    expect(candidateFor(base, figma('Dr. Denker - DVHN app updates'))?.part).toEqual({ kind: 'title', label: 'Dr. Denker - DVHN app updates – Figma' });
    expect(candidateFor(base, figma('Puzzel app'))?.part).toEqual({ kind: 'title', label: 'Puzzel app – Figma' });
  });
});

describe('the fixes the re-audit found', () => {
  const busy = (parts: Record<string, { kind: 'path'; label: string; seconds: number; visits: number }>) => {
    const base = createInitialState('d1');
    return {
      ...base,
      attributionProposals: {
        ...base.attributionProposals,
        candidates: { 'host:figma.com': { key: 'host:figma.com', kind: 'host' as const, label: 'figma.com', processName: 'Google Chrome', seconds: 9999, visits: 99, days: ['2026-09-07'], titles: [], parts, firstSeenAt: T0, lastSeenAt: T0 } },
        watching: { key: 'host:figma.com', kind: 'host' as const, label: 'figma.com', processName: 'Google Chrome', since: T0, title: null, part: { kind: 'path' as const, label: '/file/newproj' } },
      },
    } as unknown as KernelState;
  };

  it('makes room among the ESTABLISHED parts, never by dropping the one just added', () => {
    // Eight big parts plus a newcomer. Evicting the global smallest evicted the
    // newcomer every time, so a new Figma file could never reach a second visit.
    const parts = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`path:/file/old${i}`, { kind: 'path' as const, label: `/file/old${i}`, seconds: 3600, visits: 10 }]),
    );
    const { state: next } = attributionPropose(busy(parts), win(at(120), CLAUDE));
    const kept = next.attributionProposals.candidates['host:figma.com']!.parts!;
    expect(Object.keys(kept)).toHaveLength(8);
    expect(kept['path:/file/newproj']).toMatchObject({ seconds: 120 });
    // One established part made room for it.
    expect(Object.keys(kept).filter((k) => k.startsWith('path:/file/old'))).toHaveLength(7);
  });

  it('keeps the cleaned window title as evidence even when the part is a path', () => {
    let s = createInitialState('d1');
    s = fold(s, win(at(0), JIRA));
    s = fold(s, win(at(30), CLAUDE));
    const c = s.attributionProposals.candidates['host:acme.atlassian.net']!;
    expect(c.parts!['path:/jira/software']).toBeDefined();
    expect(c.titles).toEqual(['Puzzlebox - Backlog - Jira']);
  });

  it('caps the number of places timed, never evicting the one just timed', () => {
    const base = createInitialState('d1');
    const many = Object.fromEntries(
      Array.from({ length: MAX_CANDIDATES }, (_, i) => [
        `host:h${i}.example`,
        { key: `host:h${i}.example`, kind: 'host' as const, label: `h${i}.example`, processName: 'Google Chrome', seconds: 3600, visits: 5, days: ['2026-09-07'], titles: [], firstSeenAt: T0, lastSeenAt: T0 },
      ]),
    );
    const state = {
      ...base,
      attributionProposals: { ...base.attributionProposals, candidates: many, watching: { key: 'host:new.example', kind: 'host' as const, label: 'new.example', processName: 'Google Chrome', since: T0, title: null, part: null } },
    } as unknown as KernelState;
    const { state: next } = attributionPropose(state, win(at(60), CLAUDE));
    const candidates = next.attributionProposals.candidates;
    expect(Object.keys(candidates)).toHaveLength(MAX_CANDIDATES);
    expect(candidates['host:new.example']).toBeDefined();
  });

  it('re-establishes an accepted meeting rule in the live fold — the fold used to strip it', () => {
    const base = createInitialState('d1');
    const { state: next } = attributionPropose(
      base,
      decided(at(10), { key: 'host:meet.google.com', decision: 'assigned', project: 'puzzles', rule: { meetingContains: 'Standup + weekplanning', project: 'puzzles' } }),
    );
    expect(next.config.projectRules).toEqual([{ meetingContains: 'Standup + weekplanning', project: 'puzzles' }]);
  });
});
