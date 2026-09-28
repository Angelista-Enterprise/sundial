import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Rule } from '@sundial/kernel/types.js';

const TEST_CMD_RE = /\b(npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|npx\s+vitest|npx\s+jest|cargo\s+test|go\s+test|pytest|vitest|jest)\b/;
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;

interface ShellCommandPayload {
  command?: string;
  cwd?: string | null;
  exitCode?: number | null;
}

/** Ported verbatim from WCS's `LifeEventSensor.testKey` — normalizes to a stable pairing key. */
export function testKey(command: string): string | null {
  const match = command.match(TEST_CMD_RE);
  if (!match) return null;
  return match[0].replace(/\s+/g, ' ').replace(/\bnpm\s+run\s+test\b/, 'npm test').toLowerCase();
}

/**
 * Reacts to `shell:command` (needs `exitCode`, only present via the
 * hook-file path — see Wave 3a's `ShellSensor`). Tracks the most recent
 * failing run per `${cwd}|${testKey}` in `state.lifeEvent.failedTests`;
 * pairs it with the next passing run of the same key within the recovery
 * window.
 */
export const testRecovery: Rule = (state, event) => {
  if (event.type !== 'shell:command') return { state, effects: [] };

  const payload = event.payload as ShellCommandPayload;
  const command = typeof payload.command === 'string' ? payload.command : '';
  const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : null;
  if (exitCode === null) return { state, effects: [] };

  const key = testKey(command);
  if (!key) return { state, effects: [] };

  const dedupeKey = `${payload.cwd ?? ''}|${key}`;
  const failedTests = { ...state.lifeEvent.failedTests };
  const nowMs = Date.parse(event.ts);

  if (exitCode !== 0) {
    failedTests[dedupeKey] = { command, failedAt: event.ts };
    for (const [k, entry] of Object.entries(failedTests)) {
      if (nowMs - Date.parse(entry.failedAt) > RECOVERY_WINDOW_MS) delete failedTests[k];
    }
    return { state: { ...state, lifeEvent: { ...state.lifeEvent, failedTests } }, effects: [] };
  }

  const prior = failedTests[dedupeKey];
  if (!prior) return { state, effects: [] };
  delete failedTests[dedupeKey];

  const recoveryMs = nowMs - Date.parse(prior.failedAt);
  const newState = { ...state, lifeEvent: { ...state.lifeEvent, failedTests } };
  if (recoveryMs > RECOVERY_WINDOW_MS) return { state: newState, effects: [] };

  return {
    state: newState,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'test-recovery'),
          type: 'event:test-recovery',
          ts: event.ts,
          payload: { timestamp: event.ts, failedCommand: prior.command, recoveredCommand: command, recoveryMs, cwd: payload.cwd ?? null },
        },
      },
    ],
  };
};
