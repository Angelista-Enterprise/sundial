import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitSensor } from './index.js';
import * as gitCapture from './git-capture.js';

vi.mock('./git-capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-capture.js')>();
  return { ...actual, isGitRepo: vi.fn(), readGitStatus: vi.fn(), readCommitStats: vi.fn() };
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
});
