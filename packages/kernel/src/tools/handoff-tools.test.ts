// lane D — #20 project handoff: the deterministic skeleton.
import { describe, expect, it } from 'vitest';
import type { StoredCommitment } from '@sundial/db/index.js';
import { buildHandoff, type HandoffInput } from './handoff-tools.js';

const ROOT = '~/Projects/studio/puzzlebox-studio';
const thread = (over: Partial<StoredCommitment>): StoredCommitment => ({
  id: 't1', name: 'box-484-login', source: 'branch', branch: 'box-484-login', projectId: ROOT, projectName: 'puzzlebox-studio',
  openedAt: '2026-09-20T09:00:00.000Z', lastTouchedAt: '2026-09-27T15:00:00.000Z', touches: 9, activeDays: 4, closedAt: null, closedBecause: null, promise: null, ...over,
});

function input(over: Partial<HandoffInput> = {}): HandoffInput {
  return {
    project: { name: 'puzzlebox-studio', root: ROOT },
    since: '2026-08-29T00:00:00.000Z',
    now: '2026-09-28T12:00:00.000Z',
    timeZone: 'UTC',
    moments: [
      { startTime: '2026-09-26T09:00:00.000Z', durationMs: 2 * 3_600_000, meetingAttendees: [] },
      { startTime: '2026-09-27T09:00:00.000Z', durationMs: 3_600_000, meetingAttendees: ['person-0123456789', 'person-abcdefabcd', 'Rae Owner', 'Library (12)'] },
    ],
    intents: [{ at: '2026-09-27T10:00:00.000Z', what: 'Fixing the login retry' }],
    threads: [thread({})],
    promises: [
      thread({ id: 'p1', name: 'the draft', promise: { direction: 'owner', counterparty: 'person-0123456789', deliverable: 'the draft', due: '2026-09-30T09:00:00.000Z' } }),
      thread({ id: 'p2', name: 'the invoice', promise: { direction: 'owner', counterparty: 'Mira Bakker', deliverable: 'the invoice' }, closedAt: '2026-09-25T00:00:00.000Z', closedBecause: 'kept' }),
    ],
    facts: [
      { subject: 'puzzlebox-studio', subjectKind: 'project', predicate: 'usesTool', object: 'Vitest', since: '2026-09-01T00:00:00.000Z', provenance: 'inference' },
      { subject: 'box-484-login', subjectKind: 'task', predicate: 'relatesToProject', object: 'puzzlebox-studio', since: '2026-09-20T00:00:00.000Z', provenance: 'inference' },
      { subject: 'owner', subjectKind: 'owner', predicate: 'decided', object: 'ship puzzlebox-studio login behind a flag', since: '2026-09-10T00:00:00.000Z', provenance: 'owner' },
      { subject: 'Mira Bakker', subjectKind: 'person', predicate: 'worksOn', object: 'puzzlebox-studio', since: '2026-09-02T00:00:00.000Z', provenance: 'inference' },
    ],
    commits: [
      { at: '2026-09-27T11:00:00.000Z', line: 'a1b2c3d4e5 BOX-484 retry the login once', branch: 'box-484-login' },
      { at: '2026-09-27T11:30:00.000Z', line: 'f6e5d4c3b2 Merge origin/develop into box-484-login', branch: 'box-484-login' },
    ],
    prs: [{ at: '2026-09-27T12:00:00.000Z', number: 42, title: 'BOX-484 login retry', state: 'open', reviewState: 'review_required', checkState: 'passing' }],
    status: { branch: 'box-484-login', dirtyFiles: 2, ahead: 1 },
    fileChanges: [
      { at: '2026-09-27T11:00:30.000Z', files: ['src/login.ts', 'src/api.ts'] },
      { at: '2026-09-26T09:00:00.000Z', files: ['src/login.ts'] },
    ],
    fleet: [{ at: '2026-09-27T11:00:00.000Z', sessions: [{ id: 's1', cwd: ROOT, branch: 'box-484-login', state: 'working', since: '2026-09-27T10:50:00.000Z', title: 'Fix the login retry' }] }],
    collisions: { 'agent-owner-collision': 1 },
    tickets: [{ id: 'BOX-484', firstSeen: '2026-09-20T09:00:00.000Z', lastSeen: '2026-09-27T12:00:00.000Z', days: ['2026-09-20', '2026-09-26', '2026-09-27'], sources: { branch: 3 }, stage: 'pr', commits: 1, pr: { number: 42, state: 'open', reviewState: null } }],
    names: { 'person-0123456789': 'Tess Veld' },
    ownerAliases: ['Rae Owner'],
    ...over,
  };
}

describe('buildHandoff', () => {
  it('writes the seven parts from the record, each line counted', () => {
    const { text, counts } = buildHandoff(input());
    expect(text).toContain('# Handoff: puzzlebox-studio');
    expect(text).toContain('- 3.0 h over 2 days (2 moments); last worked 2026-09-27.');
    expect(text).toContain('- Checkout on box-484-login: 2 uncommitted files, 1 commit not pushed.');
    // A merge is counted apart: it carries the other branch's work.
    expect(text).toContain('- 1 commit and 1 merge on 1 branch (box-484-login). Latest: "a1b2c3d4e5 BOX-484 retry the login once".');
    expect(text).toContain('- PR #42 BOX-484 login retry: open, review_required, passing.');
    // Decisions: the owner's own word first; people stay out of this part.
    const decisions = text.split('## Decisions and facts')[1]!.split('##')[0]!;
    expect(decisions.trim().split('\n')).toEqual(['- 1 task on record, newest first: box-484-login.', '- Tools: Vitest.', '- owner decided ship puzzlebox-studio login behind a flag (you said), since 2026-09-10.']);
    expect(decisions).not.toContain('Mira Bakker');
    expect(text).toContain('- box-484-login: 4 days of work, last touched 2026-09-27.');
    expect(text).toContain('- BOX-484: pr (PR #42, open), seen on 3 days, last 2026-09-27.');
    // People: named, with why; the owner is never one of them; a hash is counted, not shown.
    expect(text).toContain('- Mira Bakker: worksOn, promise.');
    expect(text).toContain('- Tess Veld: promise, meeting.');
    expect(text).toContain('- 1 person without a name yet.');
    expect(text).not.toContain('Rae Owner');
    expect(text).not.toContain('Library (12)');
    expect(text).not.toMatch(/person-[0-9a-f]{10}/);
    expect(text).toContain('- You owe Tess Veld: the draft, due 2026-09-30.');
    expect(text).toContain('- 1 promise closed: kept 1.');
    expect(text).toContain('- "Fix the login retry" on box-484-login: working when last seen 2026-09-27.');
    expect(text).toContain('- Collisions noticed: owner-collision 1.');
    // Risky files: src/login.ts changed on two days, once while the agent worked there.
    expect(text).toContain('- src/login.ts: changed 2 times on 2 days, 1 of them while an agent worked in the checkout.');
    expect(counts).toMatchObject({ moments: 2, activeDays: 2, commits: 2, decisions: 1, tasks: 1, openThreads: 1, tickets: 1, people: 3, promisesOpen: 1, promisesClosed: 1, agentSessions: 1, filesChanged: 2 });
  });

  it('says so when a part is empty, rather than leaving it out', () => {
    const empty = input({ moments: [], intents: [], threads: [], promises: [], facts: [], commits: [], prs: [], status: null, fileChanges: [], fleet: [], collisions: {}, tickets: [] });
    const { text } = buildHandoff(empty);
    for (const line of ['- No time on this project in the window.', '- None on record.', '- None open.', '- Nobody named on record.', '- No coding-agent session in this checkout in the window.', '- No file changes on record.']) expect(text).toContain(line);
  });
});
