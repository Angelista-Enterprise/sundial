import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
export default defineConfig({
  test: {
    exclude: [...defaultExclude, '**/.claude/worktrees/**'],
    // Every test run gets its own empty data folder, so no test can ever read
    // or write a real install (~/.sundial) — whatever a test forgets to stub.
    env: { SUNDIAL_HOME: process.env.SUNDIAL_HOME ?? mkdtempSync(join(tmpdir(), 'sundial-test-')), DSH_HOME: process.env.DSH_HOME ?? mkdtempSync(join(tmpdir(), 'sundial-test-dsh-')) },
  },
});
