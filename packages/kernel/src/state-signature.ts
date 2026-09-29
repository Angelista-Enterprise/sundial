/**
 * Identity of a STATE observation, so an event that says nothing new is never
 * written to the log.
 *
 * ## The leak this closes
 *
 * Every sensor that reports a state already deduplicates — `FocusModeSensor.lastKey`,
 * `LocationNetworkSensor.lastFingerprint`, `GitSensor.lastStatusKeyPerCwd`,
 * `AudioContextSensor`'s tracked-usage map. All of them hold that memory in an
 * INSTANCE field, which a new process does not have, so every daemon restart
 * re-emits the current value of every state signal exactly once.
 *
 * Measured live rather than inferred: three `location:network` emits of one
 * identical payload during a single session, at 14:56, 16:58 and 17:26, matching
 * three daemon restarts one-for-one (each visible as an 82-93 second hole in the
 * `clock:tick` stream). The same mechanism costs the microphone far more, because
 * there the lost memory is a lifecycle map rather than a scalar: a restart while
 * audio is live drops the tracked entry, so the `end` for that span is never
 * emitted at all — 161 starts against 131 ends over three weeks.
 *
 * Holding the value in `KernelState` instead is what CLAUDE.md's rule about
 * module-level state is for, and it works because state is snapshotted: the
 * comparison survives exactly the event it needs to survive.
 *
 * ## Why the whole payload, and not chosen fields
 *
 * The signature is every field except `timestamp`. Picking fields would turn a
 * durability layer into a policy decision, and the wrong one: `system:power`
 * carries `batteryPercent` and `timeRemainingMinutes`, which change constantly and
 * legitimately, so a signature of `(source, charging)` would silently stop
 * recording battery drain. Comparing whole payloads suppresses only what is
 * genuinely identical — which is precisely the restart re-emit and nothing else.
 *
 * ## Why an allow-list
 *
 * Only types that report a *state* are eligible. An occurrence must never be
 * deduplicated: two identical `shell:command` payloads are two commands, two
 * identical `git:commit` payloads would be two commits, and dropping the second
 * would lose a real event. There is no way to tell the difference from the payload
 * alone, so it is declared.
 */

/** Payload field that scopes a state signal, when one value per subject is expected. */
const STATE_SCOPES: Record<string, string | null> = {
  // One status per repository — two repos differing only in dirty-file count are
  // two separate states, not a change of one.
  'git:status': 'cwd',
  'location:network': null,
  'focus-mode:changed': null,
  'system:power': null,
  'audio:device-changed': null,
  // The sampled microphone/speaker/camera state. Its whole reason for being a
  // sample rather than a start/end pair is that the dedupe lives HERE, in durable
  // state, instead of in a sensor instance that a restart discards — see MediaState.
  'media:state': null,
  // Where the active coding agent is working. Sampled every poll like
  // `media:state`, for the same reason: the sensor holds no instance memory, so
  // the dedupe has to live here to survive a restart.
  'agent:session': null,
  // Every coding-agent session and its state — sampled the same way, deduped here.
  'agent:fleet': null,
  // Arc's tabs in the focused space: a state, re-read on every restart.
  'browser:arc-space': null,
  // lane H (H2): Sundial's own health, read once a minute; logged only on a change.
  'sensor:health': null,
};

/**
 * Bound on `state.observed`. Keys are one per state type, times one per scope for
 * scoped types — a dozen repositories and five signal types, not thousands. The cap
 * exists so a pathological number of scopes cannot grow the snapshot without limit;
 * eviction is oldest-first, which for this data means a repository not touched in a
 * long time loses its dedupe entry and re-emits once. Harmless.
 */
export const MAX_OBSERVED_ENTRIES = 64;

export interface StateSignature {
  key: string;
  value: string;
}

/**
 * The signature of a state observation, or `null` when this event type reports an
 * occurrence and must always be recorded.
 */
export function stateSignature(type: string, payload: Record<string, unknown>): StateSignature | null {
  if (!(type in STATE_SCOPES)) return null;

  const scopeField = STATE_SCOPES[type];
  const scope = scopeField ? String(payload[scopeField] ?? '') : '';
  // The one exception to "the whole payload": a working agent's cost, line counts
  // and last prompt move on nearly every 15 s sample, and would write a fleet row
  // each time. The row still carries them; they ride on the next state change.
  const signed = type === 'agent:fleet' && Array.isArray(payload.sessions) ? { ...payload, sessions: payload.sessions.map((s) => (typeof s === 'object' && s !== null ? { ...s, costUsd: undefined, lines: undefined, lastPrompt: undefined } : s)) } : payload;
  const value = JSON.stringify(
    Object.keys(signed)
      .filter((k) => k !== 'timestamp')
      .sort()
      .map((k) => [k, (signed as Record<string, unknown>)[k]]),
  );

  return { key: scope ? `${type}|${scope}` : type, value };
}

/** True when this observation is byte-identical to the last one recorded for its subject. */
export function isUnchangedObservation(observed: Record<string, string>, signature: StateSignature): boolean {
  return observed[signature.key] === signature.value;
}

/** `observed` with `signature` recorded, oldest entry evicted if the cap is reached. */
export function recordObservation(observed: Record<string, string>, signature: StateSignature): Record<string, string> {
  const next: Record<string, string> = { ...observed, [signature.key]: signature.value };
  const keys = Object.keys(next);
  if (keys.length <= MAX_OBSERVED_ENTRIES) return next;
  // Insertion order is preserved for non-numeric string keys, so the first keys
  // are the least recently added.
  for (const stale of keys.slice(0, keys.length - MAX_OBSERVED_ENTRIES)) delete next[stale];
  return next;
}
