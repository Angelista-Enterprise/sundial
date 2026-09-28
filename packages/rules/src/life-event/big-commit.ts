import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Rule } from '@sundial/kernel/types.js';

const BIG_COMMIT_FILE_THRESHOLD = 20;

interface GitCommitPayload {
  commitLine?: string;
  branch?: string;
  cwd?: string;
  filesChanged?: number;
}

/**
 * Deliberate simplification vs WCS's `LifeEventSensor.onGitCommit`: WCS
 * deferred a `commitCheckDelayMs` timeout then ran a *separate* `git diff
 * --stat HEAD~1 HEAD` subprocess to count files. Gnomon's `git:commit`
 * event (packages/sensors/src/git/index.ts) already carries `filesChanged`
 * from the same commit-stats read the sensor does at commit-detection time
 * — no delayed re-check or extra subprocess needed, and no violation of
 * "rules perform no I/O" (a real constraint WCS's timer-based version would
 * have run into here if ported literally). This rule is a pure, immediate
 * comparison.
 */
export const bigCommit: Rule = (state, event) => {
  if (event.type !== 'git:commit') return { state, effects: [] };

  const payload = event.payload as GitCommitPayload;
  const filesChanged = typeof payload.filesChanged === 'number' ? payload.filesChanged : 0;
  if (filesChanged < BIG_COMMIT_FILE_THRESHOLD) return { state, effects: [] };

  return {
    state,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'big-commit'),
          type: 'event:big-commit',
          ts: event.ts,
          payload: { timestamp: event.ts, commitLine: payload.commitLine ?? null, branch: payload.branch ?? null, filesChanged, cwd: payload.cwd ?? null },
        },
      },
    ],
  };
};
