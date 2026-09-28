import { readAgentSession } from './agent-session-capture.js';

export * from './agent-session-capture.js';
export * from './agent-fleet.js';

export interface AgentSessionEvent {
  type: 'agent:session';
  payload: Record<string, unknown>;
}

/** How often the session transcripts are actually stat-ed, independent of the daemon's 1s tick. */
const POLL_INTERVAL_MS = 15_000;

/**
 * Samples where the active coding agent is working, every poll.
 *
 * Stateless on purpose, per `decisions/sampled-state-over-transitions`: this
 * sensor holds no `lastKey` instance field, because a restart discards one and
 * every state-reporting sensor that kept its memory there re-emitted on every
 * boot. `agent:session` is on `stateSignature`'s allow-list instead, so an
 * unchanged sample is dropped once, durably, at ingest.
 *
 * `cwd: null` is emitted rather than nothing when no session is active, so the
 * end of a coding session is an observation the fold can act on — otherwise
 * `state.agent.session` would keep pointing at a project the owner walked away
 * from, and Claude windows would go on inheriting it indefinitely.
 */
export class AgentSessionSensor {
  private lastPollAt = 0;
  private last: AgentSessionEvent | null = null;

  poll(now: number = Date.now()): AgentSessionEvent {
    // Self-gated to its own interval, the same pattern calendar/bluetooth use:
    // the daemon ticks every second, and stat-ing every session file that often
    // is pure churn for a value that changes when the owner switches project.
    // This is rate limiting, NOT dedupe — the dedupe that has to survive a
    // restart still lives in `state.observed`, which is the whole point of
    // sampling. Between gates the previous sample is repeated verbatim, so
    // ingest drops it as unchanged rather than the fold seeing a gap.
    if (this.last && now - this.lastPollAt < POLL_INTERVAL_MS) return this.last;
    this.lastPollAt = now;

    const session = readAgentSession(now);
    this.last = {
      type: 'agent:session',
      payload: {
        timestamp: new Date(now).toISOString(),
        cwd: session?.cwd ?? null,
        branch: session?.branch ?? null,
      },
    };
    return this.last;
  }
}
