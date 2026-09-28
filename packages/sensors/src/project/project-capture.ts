import fs from 'node:fs';
import path from 'node:path';

const PROJECT_INDICATORS = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'] as const;

export interface CachedProject {
  projectRoot: string;
  projectName: string;
  projectId: string | null;
  indicators: string[];
}

/**
 * The main repository root for a git worktree, or null when `dir` is not one.
 *
 * A linked worktree's `.git` is a FILE, not a directory, holding a single
 * `gitdir: /main/repo/.git/worktrees/<name>` line. Because `.git` exists either
 * way, `detectProjectRoot` stops at a worktree and — since the `projects` table
 * keys on the root path — mints a second project for what the owner considers
 * one codebase. Time split across `gnomon` and `gnomon-hotfix` then reads as two
 * projects that each look half-abandoned.
 *
 * Resolving to the main repo means a worktree's activity lands on the project it
 * belongs to. The branch is still read per-worktree by `readGitBranch`, so the
 * distinction that actually matters is not lost.
 */
export function resolveWorktreeRoot(dir: string): string | null {
  try {
    const gitPath = path.join(dir, '.git');
    if (!fs.statSync(gitPath).isFile()) return null;
    const gitdir = fs.readFileSync(gitPath, 'utf-8').trim().match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!gitdir) return null;
    // `…/<main-root>/.git/worktrees/<name>` — everything before `/.git/` is the
    // main root. A `.git` file that is not a worktree pointer (a plain gitlink,
    // as submodules use) has no `/worktrees/` segment and is left alone: a
    // submodule genuinely is its own project.
    const idx = gitdir.indexOf('/.git/worktrees/');
    if (idx === -1) return null;
    const mainRoot = gitdir.slice(0, idx);
    return mainRoot.length > 0 && fs.existsSync(mainRoot) ? mainRoot : null;
  } catch {
    return null;
  }
}

/**
 * The one canonical spelling of a repository directory: worktree resolved to its
 * main repo, symlinks followed, trailing slash dropped, true on-disk casing.
 *
 * Shared with the git sensor deliberately. Both packages name the same
 * directories — the project sensor as a `projects.id`, the git sensor as the
 * `cwd` on every `git:status`/`git:commit` — and they were canonicalising
 * differently, so the same repository appeared under both spellings. Measured on
 * the live log: 15 distinct `cwd` spellings for 10 repositories, differing only
 * by case (`~/projects/acme/gnomon` vs `~/Projects/acme/gnomon`), a trailing slash,
 * or being a `.claude/worktrees/` checkout of a repo already counted. Any
 * per-project total computed across the two was silently divided.
 *
 * Falls back to the input when the path cannot be resolved (a delete racing the
 * walk), which is preferable to dropping the observation.
 */
export function canonicalizeRepoDir(dir: string): string {
  const resolved = resolveWorktreeRoot(dir) ?? dir;
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The absolute filesystem path an AX `documentPath` names, or null when it
 * names no local file.
 *
 * A window's `documentPath` is a URI, not a path: editors report
 * `file:///Users/…/src/App.tsx` (percent-encoded) via `kAXDocumentAttribute`,
 * and a browser reports the page URL — `http://localhost:8080/…`,
 * `chrome://newtab/`, `about:blank`. Only the `file:` form denotes something
 * `detectProjectRoot` can walk. Feeding it the others is not merely useless:
 * `path.dirname` degrades them into relative paths, which the walk then
 * resolves against the daemon's own cwd (see {@link detectProjectRoot}).
 *
 * The `file://` stripping that already exists lives in the redaction layer
 * (`sanitizeLocalFilePath`/`canonicalProjectRoot`), which the detection path
 * deliberately bypasses — it needs the real, unredacted path to stat. Hence
 * this separate, non-redacting converter.
 */
export function localFilePathFromDocument(documentPath: string | null | undefined): string | null {
  if (typeof documentPath !== 'string' || documentPath.length === 0) return null;
  if (documentPath.startsWith('/')) return documentPath;
  if (!documentPath.startsWith('file://')) return null;
  const raw = documentPath.slice('file://'.length);
  // `file://localhost/path` and `file:///path` both denote a local path; any
  // other authority is a remote host whose path is not ours to walk.
  const withoutAuthority = raw.startsWith('localhost/') ? raw.slice('localhost'.length) : raw;
  if (!withoutAuthority.startsWith('/')) return null;
  try {
    return decodeURIComponent(withoutAuthority);
  } catch {
    // A stray `%` that isn't a valid escape — the path is still usable as-is.
    return withoutAuthority;
  }
}

export function readGitBranch(projectRoot: string): string | null {
  try {
    const headPath = path.join(projectRoot, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) return null;
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (m) return m[1];
    return head.length >= 7 ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** The `origin` remote URL from a repo's `.git/config`, or null. */
export function readGitRemote(projectRoot: string): string | null {
  try {
    const configPath = path.join(projectRoot, '.git', 'config');
    if (!fs.existsSync(configPath)) return null;
    const config = fs.readFileSync(configPath, 'utf-8');
    // Find the [remote "origin"] section's `url = ...` line. Falls back to
    // the first remote url if origin is absent.
    const originMatch = config.match(/\[remote "origin"\][^[]*?\n\s*url\s*=\s*(.+)/);
    const raw = originMatch ? originMatch[1].trim() : config.match(/\[remote "[^"]+"\][^[]*?\n\s*url\s*=\s*(.+)/)?.[1]?.trim();
    if (!raw) return null;
    // Strip any embedded credentials (`https://user:token@host/...`) so a
    // stored remote never carries a secret — the owner/host we care about is
    // after the `@`.
    return raw.replace(/:\/\/[^/@]+@/, '://');
  } catch {
    return null;
  }
}

/**
 * Organization owner slug from a git remote URL — `acme` from either
 * `git@github.com:acme/foo.git` (scp form) or `https://github.com/acme/foo`
 * (https form), across GitHub/GitLab/Bitbucket/self-hosted. Returns null when
 * the URL has no clear owner segment. This is the ONLY org-assignment signal;
 * path prefix is deliberately not used (brittle, breaks on reorg).
 */
export function orgFromRemote(remote: string | null): string | null {
  if (!remote) return null;
  // scp-like: git@host:owner/repo(.git)
  const scp = remote.match(/^[^@]+@[^:]+:([^/]+)\/[^/]+?(?:\.git)?$/);
  if (scp) return scp[1] || null;
  // url form: scheme://host[:port]/[optional-group/]owner/repo(.git)
  const url = remote.match(/^[a-z]+:\/\/[^/]+\/(?:.*\/)?([^/]+)\/[^/]+?(?:\.git)?$/i);
  if (url) return url[1] || null;
  return null;
}

/** The project-indicator files present directly in `dir`, in `PROJECT_INDICATORS` order. */
function indicatorsIn(dir: string): string[] {
  const found: string[] = [];
  for (const indicator of PROJECT_INDICATORS) {
    try {
      if (fs.existsSync(path.join(dir, indicator))) found.push(indicator);
    } catch {
      // Ignore fs errors.
    }
  }
  return found;
}

/** A walked directory that carried at least one indicator, kept as a fallback while the walk continues looking for a `.git`. */
function toProject(dir: string, indicators: string[]): CachedProject {
  // Canonicalize before this path becomes a project identity. `id` in the
  // `projects` table IS the root path, so the same directory reached as
  // `~/Projects/x`, `~/projects/x/` (case / trailing slash), or via a
  // symlink would otherwise land as several distinct rows. `realpathSync.native`
  // resolves symlinks, strips a trailing slash, and returns the true on-disk
  // case, collapsing them to one root (and one row). Falls back to the walked
  // path if realpath fails (e.g. a delete raced the walk).
  // Canonicalized through the same helper the git sensor uses, so a repo has
  // one spelling no matter which sensor names it (see `canonicalizeRepoDir`).
  const root = canonicalizeRepoDir(dir);
  return { projectRoot: root, projectName: path.basename(root), projectId: null, indicators };
}

/**
 * Walk up from `startPath` looking for a project root; null if none is found
 * before the filesystem root.
 *
 * `startPath` MUST be an absolute filesystem path. A relative one — which is
 * what `path.dirname` leaves behind when a URI is passed in by mistake
 * (`path.dirname('http://host/a/b')` eventually walks down to `'.'`) — is
 * rejected outright, because the walk would otherwise resolve every
 * `fs.existsSync` against the DAEMON's cwd and confidently report the repo
 * Gnomon itself was started from as the project for an unrelated window. It
 * also cannot terminate: `path.parse` reports an empty root for a relative
 * path and `path.dirname('.')` is `'.'`, so the loop spins forever when the
 * cwd happens to carry no indicator. Callers holding an AX `documentPath`
 * should convert it with {@link localFilePathFromDocument} first.
 *
 * A `.git` directory wins over a nearer package manifest. Stopping at the
 * first indicator of any kind meant a monorepo checkout resolved to whichever
 * workspace the open file happened to live in — `…/puzzlebox-studio/apps/playerone`
 * and `…/apps/games-hub-daily` instead of one `puzzlebox-studio` — so the repo the
 * owner actually names never entered the registry, and `resolveAttribution`'s
 * name-matched tiers (`title-folder`, a rule's `project`) could never find it.
 * The nearest indicator dir is still returned when the walk reaches the
 * filesystem root without meeting a `.git`, which keeps a plain non-git
 * package directory detectable. Because the FIRST `.git` encountered wins,
 * a submodule still resolves to itself rather than its superproject — the
 * same distinction `resolveWorktreeRoot` preserves.
 */
export function detectProjectRoot(startPath: string): CachedProject | null {
  if (!path.isAbsolute(startPath)) return null;

  let dir = startPath;
  const root = path.parse(dir).root;
  let nearest: CachedProject | null = null;

  while (dir !== root) {
    const indicators = indicatorsIn(dir);
    if (indicators.includes('.git')) return toProject(dir, indicators);
    if (indicators.length > 0 && nearest === null) nearest = toProject(dir, indicators);
    dir = path.dirname(dir);
  }
  return nearest;
}
