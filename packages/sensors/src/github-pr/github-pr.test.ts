import { describe, it, expect } from 'vitest';
import { GitHubPrSensor, PR_HEARTBEAT_MS } from './index.js';
import { deriveCheckState, deriveReviewState, deriveState, isDefaultBranch, type GhPr } from './github-pr-capture.js';

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
    const sensor = new GitHubPrSensor(async () => ({ pr: current, ghMissing: false }));
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
