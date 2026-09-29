import { deriveCheckState, deriveReviewState, deriveState, fetchPr, isDefaultBranch } from './github-pr-capture.js';

export interface GitHubPrEvent {
  type: 'git:pr-status';
  payload: Record<string, unknown>;
}

interface KnownRepo {
  cwd: string;
  branch: string;
  /** False once a lookup fails — avoids retrying a known-bad cwd every cycle until the branch changes. */
  active: boolean;
  lastEmittedKey: string | null;
  lastEmittedAt: number;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;
/**
 * An unchanged PR is re-reported this often while its branch is checked out.
 * The same `gh pr view` it already runs every five minutes, no new call: only
 * the emit. Without it the log cannot tell "still waiting for review" from
 * "nobody has looked since the branch was left" (UC4 finding 7), and a rule
 * could only guess a PR's wait from its first sighting.
 */
export const PR_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

/** Ported from WCS's `GitHubPrSensor`; reacts to `git:status` (Wave 3a), polls each tracked repo every 5min. */
export class GitHubPrSensor {
  private repos = new Map<string, KnownRepo>();
  private ghAvailable: boolean | null = null;
  private lastPollAt = 0;

  constructor(private readonly fetch: typeof fetchPr = fetchPr) {}

  /** Called from `git:status` — starts/refreshes tracking for a non-default-branch repo. */
  notifyGitStatus(cwd: string, branch: string): void {
    if (isDefaultBranch(branch)) {
      this.repos.delete(cwd);
      return;
    }
    const existing = this.repos.get(cwd);
    if (!existing || existing.branch !== branch) {
      this.repos.set(cwd, { cwd, branch, active: true, lastEmittedKey: null, lastEmittedAt: 0 });
    }
  }

  /** Self-gated to its own 5min interval — safe to call every poll tick. */
  async poll(now = Date.now()): Promise<GitHubPrEvent[]> {
    if (this.repos.size === 0) return [];
    if (now - this.lastPollAt < POLL_INTERVAL_MS) return [];
    this.lastPollAt = now;
    if (this.ghAvailable === false) return [];

    const events: GitHubPrEvent[] = [];
    await Promise.all(
      [...this.repos.entries()].map(async ([cwd, repo]) => {
        if (!repo.active) return;
        const { pr, ghMissing } = await this.fetch(cwd);
        if (ghMissing) this.ghAvailable = false;
        if (!pr) {
          repo.active = false;
          return;
        }
        this.ghAvailable = true;

        const state = deriveState(pr);
        const reviewState = deriveReviewState(pr);
        const checkState = deriveCheckState(pr);
        const key = `${pr.number}|${state}|${reviewState}|${checkState}`;
        if (key === repo.lastEmittedKey && now - repo.lastEmittedAt < PR_HEARTBEAT_MS) return;
        repo.lastEmittedKey = key;
        repo.lastEmittedAt = now;

        events.push({
          type: 'git:pr-status',
          payload: { timestamp: new Date(now).toISOString(), cwd, branch: repo.branch, number: pr.number, title: pr.title, state, reviewState, checkState, url: pr.url },
        });
      }),
    );
    return events;
  }
}
