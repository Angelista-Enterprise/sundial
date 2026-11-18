import { describe, it, expect } from 'vitest';
import { GitHubPrSensor, PR_HEARTBEAT_MS } from './index.js';
import { deriveCheckState, deriveReviewState, deriveState, isDefaultBranch, type FoundPr, type GhPr } from './github-pr-capture.js';

function pr(overrides: Partial<GhPr> = {}): GhPr {
  return { number: 1, title: 'Test PR', state: 'OPEN', isDraft: false, url: 'https://github.com/x/y/pull/1', ...overrides };
}

describe('isDefaultBranch', () => {
  it('recognizes common default branch names', () => {
    expect(isDefaultBranch('main')).toBe(true);
    expect(isDefaultBranch('master')).toBe(true);
    expect(isDefaultBranch('develop')).toBe(true);
    expect(isDefaultBranch('trunk')).toBe(true);
  });

  it('does not match a feature branch', () => {
    expect(isDefaultBranch('feature/foo')).toBe(false);
  });
});

describe('deriveState', () => {
  it('prioritizes merged/closed over draft', () => {
    expect(deriveState(pr({ state: 'MERGED', isDraft: true }))).toBe('MERGED');
    expect(deriveState(pr({ state: 'CLOSED' }))).toBe('CLOSED');
  });

  it('reports draft when open and marked draft', () => {
    expect(deriveState(pr({ isDraft: true }))).toBe('DRAFT');
  });

  it('reports open otherwise', () => {
    expect(deriveState(pr())).toBe('OPEN');
  });
});

describe('deriveReviewState', () => {
  it('returns pending with no reviews', () => {
    expect(deriveReviewState(pr())).toBe('pending');
  });

  it('prioritizes changes_requested over approved', () => {
    expect(deriveReviewState(pr({ reviews: [{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }] }))).toBe('changes_requested');
  });

  it('reports approved when only approvals exist', () => {
    expect(deriveReviewState(pr({ reviews: [{ state: 'APPROVED' }] }))).toBe('approved');
  });

  it('reports commented when only comments exist', () => {
    expect(deriveReviewState(pr({ reviews: [{ state: 'COMMENTED' }] }))).toBe('commented');
  });
});

describe('deriveCheckState', () => {
  it('returns none with no checks', () => {
    expect(deriveCheckState(pr())).toBe('none');
  });

  it('prioritizes failure over pending/cancelled', () => {
    expect(
      deriveCheckState(
        pr({ statusCheckRollup: [{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }, { conclusion: 'CANCELLED' }] }),
      ),
    ).toBe('failure');
  });

  it('reports pending when a check is still running', () => {
    expect(deriveCheckState(pr({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] }))).toBe('pending');
  });

  it('reports success when all checks passed', () => {
    expect(deriveCheckState(pr({ statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }))).toBe('success');
  });
});

describe('GitHubPrSensor heartbeat (UC4 F12)', () => {
  it('re-reports an unchanged PR every six hours while its branch is out, and a change at once', async () => {
    let current = pr({ number: 7 });
    const sensor = new GitHubPrSensor(async () => ({ pr: current, ghMissing: false }), null);
    sensor.notifyGitStatus('/r/puzzlebox-studio', 'fix-login');
    const t0 = Date.parse('2026-10-05T09:00:00Z');
    const at = (min: number) => t0 + min * 60_000;
    const seen: number[] = [];
    for (let min = 0; min <= 13 * 60; min += 5) if ((await sensor.poll(at(min))).length) seen.push(min);
    expect(seen).toEqual([0, 360, 720]);
    current = pr({ number: 7, reviews: [{ state: 'APPROVED' }] });
    const changed = await sensor.poll(at(13 * 60 + 5));
    expect(changed[0]?.payload).toMatchObject({ number: 7, reviewState: 'approved', timestamp: new Date(at(13 * 60 + 5)).toISOString() });
    expect(PR_HEARTBEAT_MS).toBe(6 * 3_600_000);
  });
});

describe('GitHubPrSensor search: every open PR the owner authored', () => {
  const found = (n: number, extra: Partial<FoundPr> = {}): FoundPr => ({ ...pr({ number: n, url: `https://github.com/acme/puzzlebox-studio/pull/${n}` }), headRefName: `fix/BOX-${n}`, baseRefName: 'develop', additions: 8, deletions: 3, changedFiles: 2, createdAt: '2026-10-05T08:00:00Z', reviewState: 'pending', checkState: 'none', ...extra });
  const t0 = Date.parse('2026-10-05T09:00:00Z');

  it('reports PRs no checkout is on, once, with branch, base and size', async () => {
    const sensor = new GitHubPrSensor(async () => ({ pr: null, ghMissing: false }), async () => ({ prs: [found(484), found(485)], ghMissing: false }));
    const events = await sensor.poll(t0);
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ repo: 'acme/puzzlebox-studio', number: 484, branch: 'fix/BOX-484', base: 'develop', state: 'OPEN', additions: 8, deletions: 3, changedFiles: 2, createdAt: '2026-10-05T08:00:00Z' }),
      expect.objectContaining({ number: 485 }),
    ]);
    expect(await sensor.poll(t0 + 5 * 60_000)).toEqual([]);
  });

  it('a PR the branch poll already reported is not reported again by the search, and keeps its cwd', async () => {
    const mine = found(484);
    const sensor = new GitHubPrSensor(async () => ({ pr: mine, ghMissing: false }), async () => ({ prs: [mine, found(485)], ghMissing: false }));
    sensor.notifyGitStatus('/r/puzzlebox-studio', 'fix/BOX-484');
    const events = await sensor.poll(t0);
    expect(events.map((e) => e.payload.number)).toEqual([484, 485]);
    expect(events[1]?.payload.cwd).toBe('/r/puzzlebox-studio');
  });

  it('sensors.githubPrs off: no gh call at all, for a checkout or the search', async () => {
    const calls: string[] = [];
    const sensor = new GitHubPrSensor(async () => (calls.push('view'), { pr: found(484), ghMissing: false }), async () => (calls.push('search'), { prs: [found(485)], ghMissing: false }), async () => (calls.push('state'), null), false);
    sensor.notifyGitStatus('/r/puzzlebox-studio', 'fix/BOX-484');
    expect(await sensor.poll(t0)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a PR that leaves the open search is looked up once and reported merged', async () => {
    let open = [found(484)];
    const sensor = new GitHubPrSensor(async () => ({ pr: null, ghMissing: false }), async () => ({ prs: open, ghMissing: false }), async (url) => ({ ...found(484), url, state: 'MERGED' }));
    await sensor.poll(t0);
    open = [];
    const merged = await sensor.poll(t0 + 5 * 60_000);
    expect(merged.map((e) => e.payload)).toEqual([expect.objectContaining({ number: 484, state: 'MERGED', branch: 'fix/BOX-484' })]);
    expect(await sensor.poll(t0 + 10 * 60_000)).toEqual([]);
  });
});
