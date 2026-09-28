import path from 'node:path';
import { type CachedProject, detectProjectRoot, orgFromRemote, readGitBranch, readGitRemote } from './project-capture.js';

/** Re-exported for the daemon's `window:changed` cross-wire, which must turn an AX `documentPath` URI into a real path before `notifyPath` walks it. */
export { localFilePathFromDocument } from './project-capture.js';

export interface ProjectEvent {
  type: 'project:detected' | 'project:switched';
  payload: Record<string, unknown>;
}

/**
 * Ported from WCS's `ProjectSensor` (plugins/project/sensor.ts). Trigger
 * call sites in Gnomon: `shell:command` (cwd), `git:status` (cwd),
 * `file:changed`/`symbol:edited` (projectRoot, Wave 3d). `file:extracted`
 * (LSP) has no Gnomon equivalent and is skipped — the other four triggers
 * cover project detection without it.
 */
export class ProjectSensor {
  private cache = new Map<string, CachedProject>();
  private lastBranchByRoot = new Map<string, string | null>();
  private lastSwitchedRoot: string | null = null;
  private lastSwitchedName: string | null = null;
  private lastSwitchedBranch: string | null = null;

  /** Call with any path that might indicate the active project (a cwd, a file's project root). */
  notifyPath(startPath: string | null | undefined): ProjectEvent[] {
    if (!startPath) return [];
    const resolved = startPath.startsWith('~') ? path.join(process.env.HOME ?? '', startPath.slice(1)) : startPath;

    // Per-path cache lookup (like lastBranchByRoot, keyed per root) rather than
    // comparing against a single last-call slot — a single slot thrashes when
    // callers round-robin between multiple known roots (A§3.6).
    const cached = this.cache.get(resolved);
    return cached ? this.checkBranchChange(cached) : this.detectProject(resolved);
  }

  private checkBranchChange(project: CachedProject): ProjectEvent[] {
    const branch = readGitBranch(project.projectRoot);
    const prev = this.lastBranchByRoot.get(project.projectRoot);
    if (prev === branch) return [];
    this.lastBranchByRoot.set(project.projectRoot, branch);
    // Only re-emit when the branch actually changed, not on first observation.
    return prev !== undefined ? this.emitDetected(project, branch) : [];
  }

  private detectProject(startPath: string): ProjectEvent[] {
    const found = detectProjectRoot(startPath);
    if (!found) return [];

    this.cache.set(startPath, found);
    const branch = readGitBranch(found.projectRoot);
    this.lastBranchByRoot.set(found.projectRoot, branch);
    return this.emitDetected(found, branch);
  }

  private emitDetected(project: CachedProject, branch: string | null): ProjectEvent[] {
    const now = new Date().toISOString();
    const remote = readGitRemote(project.projectRoot);
    const org = orgFromRemote(remote);
    const events: ProjectEvent[] = [
      {
        type: 'project:detected',
        payload: {
          timestamp: now,
          projectRoot: project.projectRoot,
          projectName: project.projectName,
          projectId: project.projectId,
          indicators: project.indicators,
          branch,
          remote,
          org,
        },
      },
    ];

    const sameRoot = this.lastSwitchedRoot === project.projectRoot;
    const sameBranch = this.lastSwitchedBranch === branch;
    if (sameRoot && sameBranch) return events;

    events.push({
      type: 'project:switched',
      payload: {
        timestamp: now,
        fromProjectRoot: this.lastSwitchedRoot,
        fromProjectName: this.lastSwitchedName,
        fromBranch: this.lastSwitchedBranch,
        toProjectRoot: project.projectRoot,
        toProjectName: project.projectName,
        toBranch: branch,
        kind: sameRoot ? 'branch' : 'project',
      },
    });

    this.lastSwitchedRoot = project.projectRoot;
    this.lastSwitchedName = project.projectName;
    this.lastSwitchedBranch = branch;
    return events;
  }
}
