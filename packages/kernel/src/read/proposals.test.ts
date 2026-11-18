// Set 5 R3: the proposals card's one reader. Every value is made up.
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../initial-state.js';
import type { KernelState } from '../types.js';
import { TRUST_N, readProposals } from './proposals.js';

const NOW = '2026-11-17T10:00:00.000Z';

function state(): KernelState {
  const s = createInitialState('d');
  s.config.timezone = 'UTC';
  s.selfReview = {
    pending: {},
    seen: [],
    proposed: {
      s1: { kind: 'skill', app: 'Spotify', name: 'play the album', routeKey: 'press button "Play"' },
      r1: { kind: 'drop-route', app: 'Notes', routeKey: 'press button "Kind"', cluster: 'not-found', n: 4 },
    },
    routes: { 'Spotify\npress button "Play"': { app: 'Spotify', key: 'press button "Play"', name: 'play the album', clean: 3, days: ['2026-11-16', '2026-11-17'], failed: 0, offeredAt: '2026-11-17T09:00:00.000Z' } },
    skills: {},
    notes: [],
  };
  s.notices.offers = {
    'chore:prs': { tool: 'gnomon_pull_requests', args: {}, label: 'Show the pull requests', n: 6, kind: 'chore', at: '2026-11-17T08:30:00.000Z', line: 'You go to github.com most workday mornings (6 in the last four weeks).' },
    'chore:tickets': { tool: 'gnomon_tickets', args: { ids: ['BOX-1'] }, label: 'Show the ticket', n: 3, kind: 'chore', at: '2026-11-16T08:30:00.000Z' },
    'prep:planning': { tool: 'gnomon_brief', args: {}, label: 'Open the prep', kind: 'meeting-prep', at: '2026-11-17T08:40:00.000Z' },
  };
  s.appNotes = { open: {}, owner: { tally: {}, notes: [{ app: 'Notes', note: 'raise is refused here (no-such-window); open worked after it', n: 4, lastAt: '2026-11-17T07:00:00.000Z' }] }, rig: { tally: {}, notes: [{ app: 'Notes', note: 'a rig note', n: 9, lastAt: NOW }] } };
  return s;
}

describe('readProposals: every learner, one list, each with its n', () => {
  it("shows a skill offer, a review's fix, today's chore offer and the owner's app notes; never another day's offer, another kind's, or the rig's notes", () => {
    const { items, trustN } = readProposals(state(), NOW);
    expect(trustN).toBe(TRUST_N);
    expect(items.map((p) => [p.kind, p.via, p.n])).toEqual([
      ['skill', 'skill', 3],
      ['chore', 'chore', 6],
      ['learned', 'app-note', 4],
      ['drop-route', 'review', 4],
    ]);
    expect(items[0]).toMatchObject({ id: 's1', title: 'Keep "play the album" in Spotify as a skill?', evidence: 'It ran clean 3 times on 2 days, with no failed step.' });
    expect(items[1]).toMatchObject({ id: 'chore:prs', key: 'chore:prs', title: 'Show the pull requests?' });
    expect(items[2]).toMatchObject({ key: 'Notes\nraise is refused here (no-such-window); open worked after it' });
    expect(JSON.stringify(items)).not.toContain('a rig note');
  });

  it('an app note the owner answered is off the card', () => {
    const s = state();
    s.appNotes!.answered = { 'Notes\nraise is refused here (no-such-window); open worked after it': 'kept' };
    expect(readProposals(s, NOW).items.map((p) => p.via)).not.toContain('app-note');
  });

  it('an empty record proposes nothing', () => {
    expect(readProposals(createInitialState('d'), NOW).items).toEqual([]);
  });
});
