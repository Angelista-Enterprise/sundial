import { describe, it, expect } from 'vitest';
import { threadRows } from './threads.js';

/**
 * The reader has to agree with `drawRail` in the shell, or Gnomon describes
 * rows the owner cannot see. These are that agreement, written down: the three
 * kinds of row the rail hides, the two fallback names, and the archive as a
 * count rather than a list.
 */
const body = (sessions) => ({ sessions });

describe('threadRows', () => {
  it('lists the live thread first, then last touched — the order the rail draws', () => {
    // The route answers in creation order, which put the session the owner was
    // speaking in FOURTH. A reader in a different order describes a card the
    // owner is not looking at, which is the one thing this file exists to stop.
    const got = threadRows({
      sessions: [
        { id: 'session-older-live', title: 'the audit', createdAt: 1, lastPromptAt: 10, live: true },
        { id: 'session-newest', title: 'a quick one', createdAt: 9, lastPromptAt: 90 },
        { id: 'session-stale', title: 'last week', createdAt: 2, lastPromptAt: 20 },
      ],
    });
    expect(got.threads.map((t) => t.id)).toEqual(['session-older-live', 'session-newest', 'session-stale']);
  });

  it('falls back to creation time when the list could not read a last prompt', () => {
    const got = threadRows({
      sessions: [
        { id: 'session-a', title: 'a', createdAt: 100 },
        { id: 'session-b', title: 'b', createdAt: 300, lastPromptAt: null },
      ],
    });
    expect(got.threads.map((t) => t.id)).toEqual(['session-b', 'session-a']);
  });

  it('hides the companion, Gnomon\'s own job and helper sessions, and blank ones', () => {
    const got = threadRows(
      body([
        { id: 'gnomon-companion', title: 'The conversation', createdAt: 5 },
        { id: 'session-a', title: 'Gnomon opened a job for itself — topic brief', createdAt: 4 },
        { id: 'session-b', title: '', blank: true, createdAt: 3 },
        { id: 'session-c', title: 'Sundial rework', createdAt: 2 },
        // A helper's sub-task session: not minted `session-…`, never on the rail.
        { id: '25f5cb7e-30b8-47a2-a86f-9858a1b22656', title: 'Task: across the current week', createdAt: 1 },
      ]),
    );
    expect(got.threads.map((row) => row.id)).toEqual(['session-c']);
    expect(got.hidden).toBe(4);
  });

  it('names a session dsh never titled the way the rail does', () => {
    // `blank` is a cached hint and null when the list could not read the
    // checkpoint, so only an explicit true earns the "Empty session" wording.
    const got = threadRows(body([{ id: 'session-a', title: '', blank: null, createdAt: 1 }]));
    expect(got.threads[0].title).toBe('Untitled session');
  });

  it('counts the archive instead of listing it, as the card does', () => {
    const got = threadRows(
      body([
        { id: 'session-a', title: 'Live one', createdAt: 2 },
        { id: 'session-b', title: 'Old one', archived: true, createdAt: 1 },
      ]),
    );
    expect(got.threads.map((row) => row.id)).toEqual(['session-a']);
    expect(got.archived).toBe(1);
  });

  it('prefers the last prompt over the creation time, and keeps the route\'s order', () => {
    const got = threadRows(
      body([
        { id: 'session-a', title: 'Newer', createdAt: 1789672274291, lastPromptAt: 1789673260044, live: true },
        { id: 'session-b', title: 'Older', createdAt: 1789672274291 },
      ]),
    );
    expect(got.threads).toEqual([
      { id: 'session-a', title: 'Newer', live: true, at: '2026-09-17T19:27:40.044Z' },
      { id: 'session-b', title: 'Older', live: false, at: '2026-09-17T19:11:14.291Z' },
    ]);
  });

  it('turns dsh\'s epoch milliseconds into an instant a model can read', () => {
    // The route hands both times over as numbers. Left raw, a model reading the
    // card cannot say what hour a thread was last spoken in.
    const got = threadRows(body([{ id: 'session-a', title: 'One', createdAt: 0 }, { id: 'session-b', title: 'Two', createdAt: null }]));
    expect(got.threads[0].at).toBe('1970-01-01T00:00:00.000Z');
    expect(got.threads[1].at).toBeNull();
  });

  it('survives a route that answered with nothing', () => {
    expect(threadRows(undefined)).toEqual({ threads: [], archived: 0, hidden: 0 });
  });
});
