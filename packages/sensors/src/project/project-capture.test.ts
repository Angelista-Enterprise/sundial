import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectRoot, localFilePathFromDocument, resolveWorktreeRoot } from './project-capture.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-project-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A main repo with a real `.git` directory. Returns its path. */
function mainRepo(name = 'repo'): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.git', 'worktrees'), { recursive: true });
  return root;
}

/** A linked worktree of `main`: `.git` is a FILE holding a gitdir pointer. */
function linkedWorktree(main: string, name: string): string {
  const wt = path.join(tmp, name);
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(main, '.git', 'worktrees', name), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', name)}\n`);
  return wt;
}

describe('resolveWorktreeRoot', () => {
  it('resolves a linked worktree to its main repository', () => {
    const main = mainRepo();
    const wt = linkedWorktree(main, 'repo-hotfix');
    expect(resolveWorktreeRoot(wt)).toBe(main);
  });

  it('returns null for a normal repository', () => {
    expect(resolveWorktreeRoot(mainRepo())).toBeNull();
  });

  it('leaves a submodule gitlink alone — a submodule is its own project', () => {
    const main = mainRepo();
    const sub = path.join(tmp, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    // A submodule's `.git` is also a file, but points at `modules/`, not `worktrees/`.
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(main, '.git', 'modules', 'sub')}\n`);
    expect(resolveWorktreeRoot(sub)).toBeNull();
  });

  it('returns null when the pointed-at main repo no longer exists', () => {
    const wt = path.join(tmp, 'orphan');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nope/gone/.git/worktrees/orphan\n');
    expect(resolveWorktreeRoot(wt)).toBeNull();
  });
});

describe('detectProjectRoot', () => {
  // The `projects` table keys on the root path, so without this a worktree
  // became a second project and split one codebase's activity in two.
  it('attributes a file inside a worktree to the main repository', () => {
    const main = mainRepo();
    const wt = linkedWorktree(main, 'repo-hotfix');
    const nested = path.join(wt, 'src');
    fs.mkdirSync(nested, { recursive: true });

    const detected = detectProjectRoot(nested);
    expect(detected?.projectRoot).toBe(fs.realpathSync.native(main));
    expect(detected?.projectName).toBe('repo');
  });

  it('still detects a plain repository as itself', () => {
    const main = mainRepo();
    expect(detectProjectRoot(main)?.projectRoot).toBe(fs.realpathSync.native(main));
  });

  it('returns null when no indicator exists above the path', () => {
    const bare = path.join(tmp, 'nothing', 'here');
    fs.mkdirSync(bare, { recursive: true });
    // `tmp` itself has no indicator, but an ancestor of the real tmpdir might;
    // assert only that no root inside the fixture is claimed.
    const detected = detectProjectRoot(bare);
    expect(detected?.projectRoot).not.toBe(bare);
  });

  // A relative path makes every `fs.existsSync` resolve against the DAEMON's
  // cwd, so an unrelated window got reported as whichever repo Gnomon was
  // started from — and the walk cannot terminate, since `dirname('.')` is '.'.
  it('rejects a relative path instead of resolving it against the process cwd', () => {
    expect(detectProjectRoot('http:/localhost:8080/puzzlez')).toBeNull();
    expect(detectProjectRoot('.')).toBeNull();
    expect(detectProjectRoot('src/lib')).toBeNull();
  });

  // Stopping at the first indicator of any kind resolved a monorepo to whichever
  // workspace the open file lived in, so the repo the owner actually names never
  // entered the registry.
  it('prefers the git repository root over a nearer package manifest', () => {
    const repo = mainRepo('monorepo');
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    const workspace = path.join(repo, 'apps', 'playerone');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package.json'), '{}');

    const detected = detectProjectRoot(path.join(workspace, 'src'));
    expect(detected?.projectRoot).toBe(fs.realpathSync.native(repo));
    expect(detected?.projectName).toBe('monorepo');
  });

  it('falls back to the nearest manifest when no .git exists above it', () => {
    const pkg = path.join(tmp, 'standalone');
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');

    expect(detectProjectRoot(path.join(pkg, 'src'))?.projectRoot).toBe(fs.realpathSync.native(pkg));
  });

  it('resolves a submodule to itself, not to its superproject', () => {
    const main = mainRepo('super');
    const sub = path.join(main, 'vendor', 'lib');
    fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(main, '.git', 'modules', 'lib')}\n`);

    expect(detectProjectRoot(path.join(sub, 'src'))?.projectName).toBe('lib');
  });
});

describe('localFilePathFromDocument', () => {
  it('turns an editor file URI into a real path', () => {
    expect(localFilePathFromDocument('file:///Users/x/Projects/app/src/App.tsx')).toBe('/Users/x/Projects/app/src/App.tsx');
  });

  it('percent-decodes an escaped path', () => {
    expect(localFilePathFromDocument('file:///Users/x/My%20Project/a.ts')).toBe('/Users/x/My Project/a.ts');
  });

  it('accepts a bare absolute path unchanged', () => {
    expect(localFilePathFromDocument('/Users/x/Projects/app/src/App.tsx')).toBe('/Users/x/Projects/app/src/App.tsx');
  });

  // These are what a BROWSER reports as documentPath. Walking them is what
  // made every tab resolve to the daemon's own cwd.
  it('rejects a page URL', () => {
    expect(localFilePathFromDocument('http://localhost:8080/puzzlez/brilliant')).toBeNull();
    expect(localFilePathFromDocument('https://github.com/Acme/app/pull/1')).toBeNull();
    expect(localFilePathFromDocument('chrome://newtab/')).toBeNull();
    expect(localFilePathFromDocument('about:blank')).toBeNull();
  });

  it('rejects a file URI naming a remote host', () => {
    expect(localFilePathFromDocument('file://otherhost/share/a.ts')).toBeNull();
    expect(localFilePathFromDocument('file://localhost/Users/x/a.ts')).toBe('/Users/x/a.ts');
  });

  it('returns null for an absent or empty value', () => {
    expect(localFilePathFromDocument(null)).toBeNull();
    expect(localFilePathFromDocument(undefined)).toBeNull();
    expect(localFilePathFromDocument('')).toBeNull();
  });
});
