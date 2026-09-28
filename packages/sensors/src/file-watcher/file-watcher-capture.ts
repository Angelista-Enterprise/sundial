import path from 'node:path';

/**
 * Path segments and suffixes to ignore, ported verbatim from WCS's
 * `file-watcher/sensor.ts` — reading a project's `node_modules`/`dist`/`.git`
 * is pure noise; we want signals on what the user is editing.
 */
export const IGNORED_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn',
  'node_modules', '.pnpm', '.pnpm-store', '.yarn', 'jspm_packages', 'bower_components', '.pnp', '.nx', '.rush',
  'dist', 'build', 'out', '.output',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.docusaurus', '.angular', '.remix', '.vercel', '.netlify', '.serverless', '.wrangler', '.expo', '.expo-shared', 'storybook-static',
  '.turbo', '.cache', '.parcel-cache', '.vite', '.webpack', '.rollup.cache', '.swc', '.eslintcache', '.sass-cache',
  'coverage', '.nyc_output', 'playwright-report', 'test-results',
  '.idea', '.vscode', '.vs',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'site-packages', '.eggs',
  '.bundle',
  'target',
  'vendor',
  '.gradle',
  '.terraform',
  'DerivedData', 'Pods', '.build', 'xcuserdata', 'Carthage',
  'tmp', '.tmp',
]);

export const IGNORED_SUFFIXES: readonly string[] = ['.DS_Store', '.log', '.lock', '.tsbuildinfo', '.egg-info', '.map'];

/**
 * Pure predicate, directly unit-testable — chokidar's `ignored` option and
 * the native watcher path both use this.
 *
 * Live-tested finding (2026-07-17): checking segments of the full absolute
 * path (as WCS's original version did, and this did too until now) means
 * any ANCESTOR directory named e.g. `tmp` silently excludes an entire
 * watched project — not just a project's own `tmp/` build-output
 * subdirectory, which is what the list is actually meant to catch. Confirmed
 * live: a disposable test repo under `/tmp/...` had every file-watcher
 * event silently dropped, because `/tmp` itself contains the segment `tmp`.
 * Fixed by checking segments of the path *relative to the watched root*
 * only — ancestors above the project boundary (which the project can't
 * control or care about) never factor in.
 */
export function makeIgnoreFn(root: string, extraSubstrings: readonly string[] = []): (p: string) => boolean {
  return (p: string) => {
    for (const s of IGNORED_SUFFIXES) {
      if (p.endsWith(s)) return true;
    }
    const rel = path.relative(root, p);
    for (const seg of rel.split(path.sep)) {
      if (IGNORED_DIR_SEGMENTS.has(seg)) return true;
    }
    for (const sub of extraSubstrings) {
      if (sub && p.includes(sub)) return true;
    }
    return false;
  };
}

export type FileChangeKind = 'add' | 'modify' | 'delete';

export interface PendingChange {
  kind: FileChangeKind;
  size?: number;
  mtimeMs?: number;
}

/**
 * Pure debounce-merge logic: a file added then modified within the same
 * debounce window is still reported as `add` (the net effect, from the log's
 * perspective, is "a new file appeared" — the intermediate `modify` is
 * incidental to how editors/build tools write files).
 */
export function mergeChangeKind(existingKind: FileChangeKind | undefined, incomingKind: FileChangeKind): FileChangeKind {
  if (existingKind === 'add' && incomingKind === 'modify') return 'add';
  return incomingKind;
}
