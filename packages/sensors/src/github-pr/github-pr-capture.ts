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
  headRefName?: string;
  baseRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** `owner/name` from a PR's URL. */
export const repoOf = (url: string): string | null => url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? null;

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

const SIZE_FIELDS = 'headRefName,baseRefName,additions,deletions,changedFiles,createdAt,updatedAt';

export function fetchPr(cwd: string, timeoutMs = 8000): Promise<{ pr: GhPr | null; ghMissing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', '--json', `number,title,state,isDraft,url,reviews,statusCheckRollup,${SIZE_FIELDS}`],
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

/** A PR as GitHub's search returns it, already in `GhPr`'s shape plus its derived review and check state. */
export interface FoundPr extends GhPr {
  reviewState: PrReviewState;
  checkState: PrCheckState;
}

const SEARCH = `query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest{number title url state isDraft createdAt updatedAt headRefName baseRefName additions deletions changedFiles reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
const REVIEW: Record<string, PrReviewState> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested' };
const CHECK: Record<string, PrCheckState> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' };

/** One GraphQL search: every open PR the signed-in owner authored, in any repo, with its branches and size. */
export function searchOpenPrs(timeoutMs = 10_000): Promise<{ prs: FoundPr[] | null; ghMissing: boolean }> {
  return new Promise((resolve) => {
    execFile('gh', ['api', 'graphql', '-f', `query=${SEARCH}`, '-f', 'q=is:pr author:@me is:open archived:false'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve({ prs: null, ghMissing: (err as NodeJS.ErrnoException).code === 'ENOENT' });
      try {
        const nodes = (JSON.parse(stdout)?.data?.search?.nodes ?? []) as Array<GhPr & { reviewDecision?: string | null; commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> } }>;
        const prs = nodes
          .filter((n) => typeof n?.number === 'number' && typeof n.url === 'string')
          .map(({ reviewDecision, commits, ...n }) => ({ ...n, reviewState: REVIEW[reviewDecision ?? ''] ?? 'pending', checkState: CHECK[commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? ''] ?? 'none' }));
        resolve({ prs, ghMissing: false });
      } catch {
        resolve({ prs: null, ghMissing: false });
      }
    });
  });
}

/** The state of one PR by URL, for a PR that left the open search: merged or closed. */
export function fetchPrState(url: string, timeoutMs = 8000): Promise<GhPr | null> {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'view', url, '--json', `number,title,state,isDraft,url,${SIZE_FIELDS}`], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as GhPr);
      } catch {
        resolve(null);
      }
    });
  });
}
