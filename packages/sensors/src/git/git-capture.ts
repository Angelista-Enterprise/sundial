import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_COMMAND_TIMEOUT_MS = 3000;

/** Shell commands that can change git state — triggers an out-of-band status check. */
export const GIT_MUTATING_RE =
  /\b(git\s+(commit|checkout|switch|merge|rebase|pull|push|fetch|stash|reset|cherry-pick|revert|am|apply|restore|clean|branch\s+-[dD])|npm\s+version|cargo\s+publish)\b/;

export interface GitStatus {
  branch: string;
  lastCommit: string;
  dirtyFiles: number;
  ahead: number | null;
  behind: number | null;
  stashCount: number;
}

export interface CommitStats {
  /** The commit's author time (ISO 8601), so a commit found late by the 60-s sweep, or after a restart, is filed on its own day; null when git could not say. */
  authoredAt?: string | null;
  insertions: number;
  deletions: number;
  filesChanged: number;
}

function runGitCommand(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_COMMAND_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** `git rev-list --left-right --count HEAD...@{u}` prints "<ahead>\t<behind>"; no upstream = empty/malformed. */
function parseAhead(stdout: string): number | null {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const n = parseInt(parts[0], 10);
  return Number.isFinite(n) ? n : null;
}

function parseBehind(stdout: string): number | null {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const n = parseInt(parts[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function isGitRepo(cwd: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, '.git'));
  } catch {
    return false;
  }
}

export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    const [branch, lastCommit, dirtyFiles, aheadBehind, stashList] = await Promise.all([
      runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      runGitCommand(['log', '--oneline', '-1'], cwd),
      runGitCommand(['diff', '--stat'], cwd),
      runGitCommand(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], cwd).catch(() => ''),
      runGitCommand(['stash', 'list'], cwd).catch(() => ''),
    ]);

    const dirtyTrimmed = dirtyFiles.trim();
    const stashTrimmed = stashList.trim();

    return {
      branch: branch.trim(),
      lastCommit: lastCommit.trim(),
      dirtyFiles: Math.max(0, dirtyTrimmed ? dirtyTrimmed.split('\n').length - 1 : 0),
      ahead: parseAhead(aheadBehind),
      behind: parseBehind(aheadBehind),
      stashCount: stashTrimmed === '' ? 0 : stashTrimmed.split('\n').length,
    };
  } catch {
    return null;
  }
}

export async function readCommitStats(cwd: string): Promise<CommitStats> {
  try {
    const numstat = await runGitCommand(['show', '--numstat', '--format=', 'HEAD'], cwd);
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const line of numstat.trim().split('\n')) {
      const m = line.match(/^(\d+)\s+(\d+)\s+/);
      if (m) {
        insertions += parseInt(m[1], 10);
        deletions += parseInt(m[2], 10);
        filesChanged++;
      }
    }
    const authored = (await runGitCommand(['log', '-1', '--format=%aI'], cwd)).trim();
    return { insertions, deletions, filesChanged, authoredAt: Number.isFinite(Date.parse(authored)) ? new Date(authored).toISOString() : null };
  } catch {
    return { insertions: 0, deletions: 0, filesChanged: 0, authoredAt: null };
  }
}

/** One line of a remote branch's reflog, when it is a push (a fetch or a pull is not): from which commit to which, and when. */
export function parsePushReflogLine(line: string): { from: string; to: string; at: string } | null {
  const m = line.match(/^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .* (\d{9,11}) [+-]\d{4}\tupdate by push$/);
  return m ? { from: m[1], to: m[2], at: new Date(Number(m[3]) * 1000).toISOString() } : null;
}

/** How many commits a push carried, or null when git cannot say. `pushedRef` is `<remote>/<branch>`. */
export async function countPushedCommits(cwd: string, from: string, to: string, pushedRef: string): Promise<number | null> {
  // A new branch has no "from": its commits are the ones no other remote branch holds.
  const range = /^0+$/.test(from) ? [to, '--not', `--exclude=${pushedRef}`, '--remotes'] : [`${from}..${to}`];
  const n = parseInt(await runGitCommand(['rev-list', '--count', ...range], cwd).catch(() => ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a `git push [-flags] [remote [refspec]]` command into structured
 * fields. Returns null when the command isn't a push or parsing yields
 * nothing useful. Conservative — drops any token starting with `-` so flags
 * like `--force-with-lease` aren't mistaken for the remote.
 */
export function parseGitPush(command: string): { remote: string | null; branch: string | null } | null {
  const m = command.match(/^\s*git\s+(?:-[^\s]+\s+)*push\b(.*)$/);
  if (!m) return null;
  const rest = m[1].trim();
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith('-'));
  const remote = tokens[0] ?? null;
  const refspecRaw = tokens[1] ?? null;
  let branch: string | null = null;
  if (refspecRaw) {
    const local = refspecRaw.startsWith('+') ? refspecRaw.slice(1) : refspecRaw;
    branch = local.includes(':') ? local.split(':')[0] : local;
    if (branch === 'HEAD') branch = null;
  }
  return { remote, branch };
}
