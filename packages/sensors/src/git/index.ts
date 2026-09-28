import { GIT_MUTATING_RE, isGitRepo, parseGitPush, readCommitStats, readGitStatus } from './git-capture.js';
import { canonicalizeRepoDir } from '../project/project-capture.js';

export interface GitEvent {
  type: 'git:status' | 'git:commit' | 'git:push';
  payload: Record<string, unknown>;
}

const DEBOUNCE_MS = 1000;
const PERIODIC_POLL_MS = 60_000;

/**
 * Ported from WCS's `GitSensor` (plugins/git/sensor.ts) with two deliberate
 * simplifications, since Gnomon has no equivalent trigger signal for them:
 * - No `window:change`-triggered check or focus gate (`cwdMatchesFocusedWorkspace`)
 *   — WCS derived a "focused workspace" cwd from `file:extracted` (LSP
 *   integration), which Gnomon doesn't have. Triggers here are
 *   `project:detected` (immediate check + registers the root for the
 *   periodic sweep) and `shell:command` (debounced check on a mutating
 *   command, plus synchronous git:push detection) — both fire with their
 *   own cwd already in hand, so there's nothing to gate against.
 * - The periodic multi-root sweep (catches headless/GUI-tool commits) is
 *   preserved exactly — this is the behavior explicitly worth keeping,
 *   per docs/design's git-sensor note.
 */
export class GitSensor {
  private readonly onEvent: (event: GitEvent) => void;
  private knownRoots = new Set<string>();
  private lastCommitPerCwd = new Map<string, string>();
  private lastStatusKeyPerCwd = new Map<string, string>();
  private lastCheckAtPerCwd = new Map<string, number>();
  // A§3.6 — this used to be one shared timer: `git commit` in repo A, then
  // within 2s a `cd`+`git status` in repo B, cancelled A's pending check
  // entirely (only rediscovered by the 60s periodic sweep, if A was even in
  // `knownRoots`). Per-root map means each repo's debounce is independent.
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private periodicTimer: NodeJS.Timeout | null = null;

  constructor(onEvent: (event: GitEvent) => void) {
    this.onEvent = onEvent;
  }

  start(): void {
    this.periodicTimer = setInterval(() => {
      for (const root of this.knownRoots) {
        void this.checkGit(root);
      }
    }, PERIODIC_POLL_MS);
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = null;
    this.knownRoots.clear();
    this.lastCheckAtPerCwd.clear();
  }

  /**
   * Both public entry points canonicalize the directory on the way in, so every
   * downstream use — the `knownRoots` sweep set, the three per-cwd dedupe maps,
   * and the `cwd` on every emitted payload — speaks one spelling.
   *
   * This is not cosmetic. A shell reports whatever the user `cd`'d to, so the live
   * log carried 15 spellings of 10 repositories, and the per-cwd maps were keyed
   * by that raw string: `~/projects/acme/gnomon` and `~/Projects/acme/gnomon` kept
   * SEPARATE `lastStatusKeyPerCwd` entries, so each spelling re-emitted the same
   * status independently and every per-project total was divided between them.
   * Canonicalizing here fixes the split identity and tightens the dedupe in one
   * move, and it uses the project sensor's own helper so the `cwd` on a git event
   * matches the `projects.id` the project sensor assigns.
   */
  registerKnownRoot(root: string): void {
    const canonical = canonicalizeRepoDir(root);
    const isNew = !this.knownRoots.has(canonical);
    this.knownRoots.add(canonical);
    if (isNew) this.scheduleCheck(canonical);
  }

  notifyShellCommand(command: string, rawCwd: string | null, exitCode: number | null): void {
    const cwd = rawCwd === null ? null : canonicalizeRepoDir(rawCwd);
    if (GIT_MUTATING_RE.test(command) && cwd) {
      this.scheduleCheck(cwd, 2000);
    }

    const push = parseGitPush(command);
    if (push && cwd && exitCode !== 1 && exitCode !== 128) {
      this.onEvent({
        type: 'git:push',
        payload: { timestamp: new Date().toISOString(), cwd, branch: push.branch, remote: push.remote, command },
      });
    }
  }

  private scheduleCheck(cwd: string, delayMs = DEBOUNCE_MS): void {
    const existing = this.debounceTimers.get(cwd);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      cwd,
      setTimeout(() => {
        this.debounceTimers.delete(cwd);
        void this.checkGit(cwd);
      }, delayMs),
    );
  }

  private async checkGit(cwd: string): Promise<void> {
    // Per-cwd throttle (not a single shared `lastCheckAt`, same A§3.6 fix as
    // the debounce timers above) — guards against a duplicate check already
    // in flight for this specific root, whether triggered by a debounced
    // call or the periodic sweep landing close together.
    const now = Date.now();
    const lastForCwd = this.lastCheckAtPerCwd.get(cwd) ?? 0;
    if (now - lastForCwd < DEBOUNCE_MS) return;
    this.lastCheckAtPerCwd.set(cwd, now);

    if (!isGitRepo(cwd)) return;

    const status = await readGitStatus(cwd);
    if (!status) return;

    const prevCommit = this.lastCommitPerCwd.get(cwd);
    if (prevCommit && status.lastCommit && prevCommit !== status.lastCommit) {
      const stats = await readCommitStats(cwd);
      this.onEvent({
        type: 'git:commit',
        payload: { timestamp: new Date().toISOString(), commitLine: status.lastCommit, branch: status.branch, cwd, ...stats },
      });
    }
    if (status.lastCommit) {
      this.lastCommitPerCwd.set(cwd, status.lastCommit);
    }

    const statusKey = `${status.branch}\0${status.lastCommit}\0${status.dirtyFiles}\0${status.ahead}\0${status.behind}\0${status.stashCount}`;
    if (this.lastStatusKeyPerCwd.get(cwd) === statusKey) return;
    this.lastStatusKeyPerCwd.set(cwd, statusKey);

    this.onEvent({
      type: 'git:status',
      payload: {
        timestamp: new Date().toISOString(),
        branch: status.branch,
        lastCommit: status.lastCommit,
        dirtyFiles: status.dirtyFiles,
        cwd,
        ahead: status.ahead,
        behind: status.behind,
        stashCount: status.stashCount,
      },
    });
  }
}
