import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Previously there was no config at all, so `vitest run` used the defaults — which
 * sweep in `.claude/worktrees/`, where background agents keep checkouts of other
 * branches.
 *
 * Those copies fail for a reason that looks alarming and means nothing: a worktree
 * holds an OLD copy of a test file, but `@sundial/*` resolves through the root
 * `node_modules` links to the MAIN tree's build output. So a worktree test runs
 * yesterday's assertions against today's code and reports a failure in a file the
 * working tree does not contain. Adding `state.coverage.observedHours` produced
 * exactly that: two failures whose paths were `.claude/worktrees/...`.
 *
 * `defaultExclude` is spread rather than replaced, so `node_modules` and `dist` stay
 * excluded — dropping them would run every test twice, once from source and once from
 * the compiled output.
 */
/**
 * The data folders a test run uses. Never the caller's SUNDIAL_HOME / DSH_HOME:
 * Sundial.app sets them to the owner's live folders for every child, so a test
 * run from a job, a hand or a terminal the app opened would write the live
 * install. A fresh temp folder each run, unless SUNDIAL_TEST_HOME /
 * SUNDIAL_TEST_DSH_HOME name one on purpose; and never the owner's own folders.
 */
export function testHomes(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const live = ['.sundial', '.dsh', '.gnomon'].map((name) => real(join(home, name)));
  const pick = (named: string | undefined, prefix: string) => {
    const dir = real(named || mkdtempSync(join(tmpdir(), prefix)));
    const hit = live.find((root) => dir === root || dir.startsWith(root + sep) || root.startsWith(dir + sep));
    if (hit) throw new Error(`vitest: refusing to run with a test data folder at ${dir}: it is the owner's live install (${hit})`);
    return dir;
  };
  return { SUNDIAL_HOME: pick(env.SUNDIAL_TEST_HOME, 'sundial-test-'), DSH_HOME: pick(env.SUNDIAL_TEST_DSH_HOME, 'sundial-test-dsh-') };
}

// The install's other variables go too: a test that reads a port or a label
// must get the default, not the live app's.
for (const key of ['SUNDIAL_WEB_PORT', 'SUNDIAL_PHONE_PORT', 'SUNDIAL_CHROME_PORT', 'SUNDIAL_LABEL', 'SUNDIAL_INTERNAL_TOKEN', 'DATABASE_URL']) delete process.env[key];

export default defineConfig({
  test: {
    exclude: [...defaultExclude, '**/.claude/worktrees/**'],
    // Every test run gets its own empty data folder, so no test can ever read
    // or write a real install (~/.sundial) — whatever a test forgets to stub.
    env: testHomes(),
  },
});
