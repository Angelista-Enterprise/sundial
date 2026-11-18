import { deriveCheckState, deriveReviewState, deriveState, fetchPr, fetchPrState, isDefaultBranch, repoOf, searchOpenPrs, type FoundPr, type GhPr } from './github-pr-capture.js';

export interface GitHubPrEvent {
  type: 'git:pr-status';
  payload: Record<string, unknown>;
}

interface KnownRepo {
  cwd: string;
  branch: string;
  /** False once a lookup fails — avoids retrying a known-bad cwd every cycle until the branch changes. */
  active: boolean;
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

/**
 * Ported from WCS's `GitHubPrSensor`; reacts to `git:status` (Wave 3a), polls each tracked repo every 5min.
 * The same poll also searches every open PR the owner authored, in any repo: a PR opened from a
 * worktree or another checkout was never on the record, so "which PRs do I have open" undercounted.
 * A PR that drops out of that search is looked up once, so its merge or close is on the record too.
 */
export class GitHubPrSensor {
  private repos = new Map<string, KnownRepo>();
  private ghAvailable: boolean | null = null;
  private lastPollAt = 0;
  /** By PR URL: the last state reported, so the branch poll and the search never report one PR twice. */
  private emitted = new Map<string, { key: string; at: number }>();
  /** `owner/name` → the checkout it was last seen in, so a searched PR still names its cwd. */
  private cwdOf = new Map<string, string>();
  /** The last search's open PRs, by URL. */
  private open = new Map<string, FoundPr>();

  constructor(
    private readonly fetch: typeof fetchPr = fetchPr,
    private readonly search: typeof searchOpenPrs | null = searchOpenPrs,
    private readonly view: typeof fetchPrState = fetchPrState,
    /** `sensors.githubPrs` in config.json: off, no `gh` call is ever made. */
    private readonly enabled = true,
  ) {}

  /** Called from `git:status` — starts/refreshes tracking for a non-default-branch repo. */
  notifyGitStatus(cwd: string, branch: string): void {
    if (isDefaultBranch(branch)) {
      this.repos.delete(cwd);
      return;
    }
    const existing = this.repos.get(cwd);
    if (!existing || existing.branch !== branch) {
      this.repos.set(cwd, { cwd, branch, active: true });
    }
  }

  /** Self-gated to its own 5min interval — safe to call every poll tick. */
  async poll(now = Date.now()): Promise<GitHubPrEvent[]> {
    if (!this.enabled) return [];
    if (this.repos.size === 0 && !this.search) return [];
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
        const slug = repoOf(pr.url);
        if (slug) this.cwdOf.set(slug, cwd);
        this.report(events, pr, deriveReviewState(pr), deriveCheckState(pr), now, { cwd, branch: repo.branch });
      }),
    );
    if (this.search) {
      const { prs, ghMissing } = await this.search();
      if (ghMissing) this.ghAvailable = false;
      if (prs) {
        const live = new Map(prs.map((p) => [p.url, p]));
        for (const p of prs) this.report(events, p, p.reviewState, p.checkState, now);
        for (const [url, was] of this.open) {
          if (live.has(url)) continue;
          const gone = await this.view(url);
          if (gone) this.report(events, { ...was, ...gone }, was.reviewState, was.checkState, now);
        }
        this.open = live;
      }
    }
    return events;
  }

  private report(events: GitHubPrEvent[], pr: GhPr, reviewState: string, checkState: string, now: number, at: { cwd?: string; branch?: string } = {}): void {
    const state = deriveState(pr);
    const key = `${pr.number}|${state}|${reviewState}|${checkState}`;
    const last = this.emitted.get(pr.url);
    if (last?.key === key && now - last.at < PR_HEARTBEAT_MS) return;
    // A merged or closed PR is reported once; only an open one is worth a heartbeat.
    if (last?.key === key && (state === 'MERGED' || state === 'CLOSED')) return;
    this.emitted.set(pr.url, { key, at: now });
    const repo = repoOf(pr.url);
    const cwd = at.cwd ?? (repo ? this.cwdOf.get(repo) : undefined);
    events.push({
      type: 'git:pr-status',
      payload: {
        timestamp: new Date(now).toISOString(),
        ...(cwd ? { cwd } : {}),
        ...(repo ? { repo } : {}),
        branch: at.branch ?? pr.headRefName,
        ...(pr.baseRefName ? { base: pr.baseRefName } : {}),
        number: pr.number,
        title: pr.title,
        state,
        reviewState,
        checkState,
        url: pr.url,
        ...(typeof pr.additions === 'number' ? { additions: pr.additions, deletions: pr.deletions ?? 0, changedFiles: pr.changedFiles ?? 0 } : {}),
        ...(pr.createdAt ? { createdAt: pr.createdAt } : {}),
        ...(pr.updatedAt ? { updatedAt: pr.updatedAt } : {}),
      },
    });
  }
}
