import type { KernelState, Rule, ShellFailureStreak } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { formatClock } from '@sundial/helpers/local-day.js';

interface ShellCommandPayload {
  timestamp?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number;
}

/** Failures in a row before Gnomon says something. */
export const FAILING_STREAK_NOTICE_AT = 3;
/** A streak older than this is a new streak: the owner walked away and came back. */
export const STREAK_GAP_MS = 30 * 60 * 1000;
/** How fast the value of saying "that keeps failing" decays: it is worth little once the owner has moved on. */
export const FAILING_STREAK_HALF_LIFE_MS = 15 * 60 * 1000;

/** Working directories whose last failure is kept, newest first. */
export const MAX_LAST_FAILURES = 20;

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/**
 * Two commands are "the same" when they match after collapsing whitespace.
 * Deliberately not fuzzier: `npm test` and `npm test -- --watch` are two
 * different attempts, and a person retrying with a flag is not stuck.
 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/**
 * `shell:command` carries an exit code on every row and nothing read it: the
 * "will the next command fail" forecast was measured and killed (failures do
 * not autocorrelate here), but DETECTING that one command keeps failing is a
 * different, easier thing — it needs no model, just a run of non-zero exits of
 * anything, with no success between. That is `state.shell.streak`, and at three in a row a
 * phasic notice is raised once per streak length threshold.
 *
 * A null exit code (the shell hook did not record one) neither extends nor
 * breaks a streak; a zero exit ends it.
 */
export const shellFailureTrack: Rule = (state, event) => {
  if (event.type !== 'shell:command') return { state, effects: [] };
  const payload = event.payload as ShellCommandPayload;
  const command = typeof payload.command === 'string' ? normalizeCommand(payload.command) : '';
  if (command === '') return { state, effects: [] };
  const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;

  const shell: KernelState['shell'] = { ...state.shell, lastCommandAt: event.ts };

  if (exitCode === null) return { state: { ...state, shell }, effects: [] };
  if (exitCode === 0) {
    const failed = cwd !== null ? state.shell.lastFailure?.[cwd] : undefined;
    const cleared = failed && failed.command === command && cwd !== null ? withoutKey(state.shell.lastFailure ?? {}, cwd) : state.shell.lastFailure;
    return { state: { ...state, shell: { ...shell, streak: null, ...(cleared ? { lastFailure: cleared } : {}) } }, effects: [] };
  }
  if (cwd !== null) {
    const kept = Object.entries({ ...state.shell.lastFailure, [cwd]: { command, exitCode, at: event.ts } })
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, MAX_LAST_FAILURES);
    shell.lastFailure = Object.fromEntries(kept);
  }

  const prior = state.shell.streak;
  // Consecutive FAILURES, whatever the command. The first version needed the
  // same command to fail three times with no success between, which a person
  // at a terminal almost never does — they change the command. In a week with
  // 69 failures out of 347 commands it fired zero times, while six runs of
  // three or more failures in a row went by. A success still ends the run.
  const continues = prior !== null && Date.parse(event.ts) - Date.parse(prior.lastAt) <= STREAK_GAP_MS;
  const streak: ShellFailureStreak = continues
    ? { ...prior, command, count: prior.count + 1, exitCode, lastAt: event.ts, cwd: cwd ?? prior.cwd }
    : { command, cwd, count: 1, exitCode, firstAt: event.ts, lastAt: event.ts, noticedAtCount: 0 };

  const effects: ReturnType<Rule>['effects'] = [];
  if (streak.count >= FAILING_STREAK_NOTICE_AT && streak.noticedAtCount < FAILING_STREAK_NOTICE_AT) {
    streak.noticedAtCount = streak.count;
    effects.push({
      type: 'EmitEvent',
      event: {
        id: deriveId(event.ts, event.id, 'shell-failure-track', `${command}:${streak.firstAt}`),
        type: 'notice:candidate',
        ts: event.ts,
        payload: {
          timestamp: event.ts,
          shape: 'transition',
          kind: 'shell-failing-streak',
          // Per working directory and run: a rough patch in one repo is one
          // stimulus, and the next patch tomorrow has had time to recover.
          key: `shell-failing:${streak.cwd ?? 'unknown'}:${streak.firstAt.slice(0, 13)}`,
          // ln(count): the third identical failure is a modest surprise, the sixth more so.
          surprise: Math.log(streak.count),
          // An exit code is not a guess.
          precision: 0.9,
          valueHalfLifeMs: FAILING_STREAK_HALF_LIFE_MS,
          observation: `${streak.count} commands in a row have failed${streak.cwd ? ` in ${streak.cwd}` : ''} — the last was \`${command.slice(0, 120)}\` (exit ${exitCode}).`,
          evidence: [streak.cwd ? `in ${streak.cwd}` : 'cwd unknown', `first failure ${formatClock(streak.firstAt, state.config.timezone)}`, `last exit ${exitCode}`],
          concerns: [],
        },
      },
    });
  }

  return { state: { ...state, shell: { ...shell, streak } }, effects };
};
