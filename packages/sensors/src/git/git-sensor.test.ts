import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitSensor } from './index.js';
import * as gitCapture from './git-capture.js';

vi.mock('./git-capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-capture.js')>();
  return { ...actual, isGitRepo: vi.fn(), readGitStatus: vi.fn(), readCommitStats: vi.fn(), countPushedCommits: vi.fn() };
});

const REPO_A = '/repos/a';
const REPO_B = '/repos/b';

function statusFor(lastCommit: string): gitCapture.GitStatus {
  return { branch: 'main', lastCommit, dirtyFiles: 0, ahead: 0, behind: 0, stashCount: 0 };
}

describe('GitSensor — A§3.6: per-root debounce (not one shared timer)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(gitCapture.isGitRepo).mockReturnValue(true);
    vi.mocked(gitCapture.readCommitStats).mockResolvedValue({ insertions: 0, deletions: 0, filesChanged: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("scheduling repo B's check does not cancel repo A's already-pending debounced check", async () => {
    vi.mocked(gitCapture.readGitStatus).mockImplementation(async (cwd: string) => (cwd === REPO_A ? statusFor('a1') : statusFor('b1')));

    const events: string[] = [];
    const sensor = new GitSensor((e) => events.push(`${e.type}:${e.payload.cwd}`));

    // repo A's mutating command schedules a check in 2s.
    sensor.notifyShellCommand('git commit -m "x"', REPO_A, 0);
    // 500ms later, repo B's mutating command schedules its own 2s check —
    // under the old shared-timer bug this would cancel A's pending check.
    await vi.advanceTimersByTimeAsync(500);
    sensor.notifyShellCommand('git commit -m "y"', REPO_B, 0);

    // Advance past repo A's original 2s window.
    await vi.advanceTimersByTimeAsync(1600);
    expect(events).toContain(`git:status:${REPO_A}`);

    // And past repo B's own window.
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toContain(`git:status:${REPO_B}`);

    sensor.stop();
  });

  it('debounces repeated checks for the SAME root within the window (collapses to one)', async () => {
    vi.mocked(gitCapture.readGitStatus).mockResolvedValue(statusFor('a1'));
    let callCount = 0;
    vi.mocked(gitCapture.readGitStatus).mockImplementation(async () => {
      callCount += 1;
      return statusFor('a1');
    });

    const sensor = new GitSensor(() => {});
    sensor.notifyShellCommand('git commit -m "x"', REPO_A, 0);
    sensor.notifyShellCommand('git add .', REPO_A, 0); // not mutating, no-op reschedule
    sensor.notifyShellCommand('git commit -m "y"', REPO_A, 0); // re-schedules, resets the 2s window

    await vi.advanceTimersByTimeAsync(2100);
    expect(callCount).toBe(1);

    sensor.stop();
  });

  it('stop() clears all pending per-root timers, not just one', async () => {
    vi.mocked(gitCapture.readGitStatus).mockResolvedValue(statusFor('a1'));
    const events: string[] = [];
    const sensor = new GitSensor((e) => events.push(e.type));

    sensor.notifyShellCommand('git commit -m "x"', REPO_A, 0);
    sensor.notifyShellCommand('git commit -m "y"', REPO_B, 0);
    sensor.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual([]);
  });

  it('W6 D2: a bare `git push` carries the branch the last status read saw', async () => {
    vi.mocked(gitCapture.readGitStatus).mockResolvedValue({ ...statusFor('a1'), branch: 'feat/box-484' });
    const pushes: unknown[] = [];
    const sensor = new GitSensor((e) => e.type === 'git:push' && pushes.push(e.payload.branch));
    sensor.registerKnownRoot(REPO_A);
    await vi.advanceTimersByTimeAsync(1100);
    sensor.notifyShellCommand('git push', REPO_A, 0);
    sensor.notifyShellCommand('git push origin main', REPO_A, 0);
    sensor.notifyShellCommand('git push', REPO_B, 0);
    expect(pushes).toEqual(['feat/box-484', 'main', null]);
    sensor.stop();
  });

  it('W6 D4: a push line in the remote reflog is one git:push with its branch, time and count; a pull, an old line and the typed command are none', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-reflog-')));
    const dir = path.join(root, '.git', 'logs', 'refs', 'remotes', 'origin', 'feat');
    fs.mkdirSync(dir, { recursive: true });
    const AT = 1793448000;
    const line = (to: string, message: string) => `${'a'.repeat(40)} ${to.repeat(40)} Mira Bakker <mira@example.com> ${AT} +0100\t${message}\n`;
    expect(gitCapture.parsePushReflogLine(line('b', 'pull: fast-forward').trimEnd())).toBeNull();
    expect(gitCapture.parsePushReflogLine(line('c', 'update by push').trimEnd())).toEqual({ from: 'a'.repeat(40), to: 'c'.repeat(40), at: new Date(AT * 1000).toISOString() });

    const file = path.join('origin', 'feat', 'box-484');
    fs.writeFileSync(path.join(dir, 'box-484'), line('b', 'pull: fast-forward'));
    vi.mocked(gitCapture.countPushedCommits).mockResolvedValue(3);
    const pushes: unknown[] = [];
    const sensor = new GitSensor((e) => e.type === 'git:push' && pushes.push(e.payload));
    sensor.registerKnownRoot(root);
    await sensor.onReflogChange(root, file, AT * 1000 + 1000);
    expect(pushes).toEqual([]);

    fs.appendFileSync(path.join(dir, 'box-484'), line('c', 'update by push'));
    await sensor.onReflogChange(root, file, AT * 1000 + 10 * 60_000);
    expect(pushes).toEqual([]);
    await sensor.onReflogChange(root, file, AT * 1000 + 1000);
    await sensor.onReflogChange(root, file, AT * 1000 + 2000);
    sensor.notifyShellCommand('git push', root, 0);
    expect(pushes).toEqual([{ timestamp: new Date(AT * 1000).toISOString(), cwd: root, branch: 'feat/box-484', remote: 'origin', commits: 3, source: 'reflog' }]);
    expect(gitCapture.countPushedCommits).toHaveBeenCalledWith(root, 'a'.repeat(40), 'c'.repeat(40), 'origin/feat/box-484');
    sensor.stop();
  });
});
