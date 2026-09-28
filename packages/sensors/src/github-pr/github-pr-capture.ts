import { execFile } from 'node:child_process';

export type PrState = 'OPEN' | 'DRAFT' | 'CLOSED' | 'MERGED';
export type PrReviewState = 'pending' | 'commented' | 'changes_requested' | 'approved';
export type PrCheckState = 'none' | 'pending' | 'success' | 'failure' | 'cancelled';

export interface GhPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  reviews?: Array<{ state: string }>;
  statusCheckRollup?: Array<{ conclusion?: string; status?: string }>;
}

const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

/** Ported verbatim from WCS's `github-pr/sensor.ts` — pure derivation logic, directly testable. */
export function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCHES.has(branch);
}

export function deriveState(pr: GhPr): PrState {
  if (pr.state === 'MERGED') return 'MERGED';
  if (pr.state === 'CLOSED') return 'CLOSED';
  if (pr.isDraft) return 'DRAFT';
  return 'OPEN';
}

export function deriveReviewState(pr: GhPr): PrReviewState {
  if (!pr.reviews || pr.reviews.length === 0) return 'pending';
  const states = pr.reviews.map((r) => r.state);
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  if (states.includes('COMMENTED')) return 'commented';
  return 'pending';
}

export function deriveCheckState(pr: GhPr): PrCheckState {
  if (!pr.statusCheckRollup || pr.statusCheckRollup.length === 0) return 'none';
  let pending = false;
  let failure = false;
  let cancelled = false;
  for (const check of pr.statusCheckRollup) {
    const c = (check.conclusion ?? '').toUpperCase();
    const s = (check.status ?? '').toUpperCase();
    if (c === 'FAILURE' || c === 'TIMED_OUT') failure = true;
    else if (c === 'CANCELLED') cancelled = true;
    if (s === 'IN_PROGRESS' || s === 'QUEUED' || s === 'PENDING') pending = true;
  }
  if (failure) return 'failure';
  if (cancelled) return 'cancelled';
  if (pending) return 'pending';
  return 'success';
}

export function fetchPr(cwd: string, timeoutMs = 8000): Promise<{ pr: GhPr | null; ghMissing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', '--json', 'number,title,state,isDraft,url,reviews,statusCheckRollup'],
      { cwd, timeout: timeoutMs },
      (err, stdout) => {
        if (err) {
          const ghMissing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          return resolve({ pr: null, ghMissing });
        }
        try {
          resolve({ pr: JSON.parse(stdout) as GhPr, ghMissing: false });
        } catch {
          resolve({ pr: null, ghMissing: false });
        }
      },
    );
  });
}
