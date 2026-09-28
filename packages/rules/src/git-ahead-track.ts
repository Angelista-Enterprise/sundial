import type { Rule } from '@sundial/kernel/types.js';

interface GitStatusPayload {
  timestamp?: string;
  branch?: string | null;
  cwd?: string;
  ahead?: number | null;
  behind?: number | null;
  dirtyFiles?: number;
}

/**
 * `git:status` has carried `ahead` on every one of its emissions and only the
 * commitment ledger's `lastTouchUnpushed` ever read it, per thread. This is the
 * live view: which working copies have commits nobody else can see yet, and
 * since when. "Six commits unpushed since 15:00" is the line the end-of-day
 * state of Today wants, and the sub-second push-to-main interception
 * (`enhancements/sub-second-signal-path-interception`) needs the same slice.
 *
 * `ahead: null` means the branch has no upstream (or the read failed) — it
 * says nothing, so it neither adds nor clears an entry. `ahead: 0` clears.
 */
export const gitAheadTrack: Rule = (state, event) => {
  if (event.type !== 'git:status') return { state, effects: [] };
  const payload = event.payload as GitStatusPayload;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  if (cwd === '') return { state, effects: [] };
  const ahead = typeof payload.ahead === 'number' && Number.isFinite(payload.ahead) ? payload.ahead : null;
  if (ahead === null) return { state, effects: [] };

  const prior = state.git.unpushed[cwd];
  if (ahead <= 0) {
    if (!prior) return { state, effects: [] };
    const unpushed = { ...state.git.unpushed };
    delete unpushed[cwd];
    return { state: { ...state, git: { ...state.git, unpushed } }, effects: [] };
  }

  const branch = typeof payload.branch === 'string' ? payload.branch : null;
  if (prior && prior.ahead === ahead && prior.branch === branch) return { state, effects: [] };
  return {
    state: {
      ...state,
      git: {
        ...state.git,
        unpushed: {
          ...state.git.unpushed,
          // `since` is when the count first became non-zero on this branch; a
          // growing count keeps it, a branch switch restarts it.
          [cwd]: { branch, ahead, since: prior && prior.branch === branch ? prior.since : event.ts, updatedAt: event.ts },
        },
      },
    },
    effects: [],
  };
};

/** Sum of unpushed commits across working copies. */
export function totalUnpushed(unpushed: Record<string, { ahead: number }>): number {
  return Object.values(unpushed).reduce((sum, entry) => sum + entry.ahead, 0);
}
