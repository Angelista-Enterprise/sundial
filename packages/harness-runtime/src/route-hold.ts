// What holds a model route at the one reservation point (`reserveLlmCall`): the breaker (W5), a 429's cooldown, and its background slots.
import { MAX_BACKGROUND_IN_FLIGHT } from '@sundial/kernel/budgets.js';
import type { KernelState } from '@sundial/kernel/types.js';

/** A reservation that never became a settled call (a caller that returned early) gives its slot back after this. */
const SLOT_MAX_MS = 5 * 60_000;

/** Epoch ms a route is held until by its breaker (`openUntil`) or its 429 cooldown (`cooldownUntil`); null once past. */
export function heldUntil(state: KernelState | null, route: string, field: 'openUntil' | 'cooldownUntil'): number | null {
  const at = state?.reliability?.llm?.[route]?.[field];
  return at && Date.now() < Date.parse(at) ? Date.parse(at) : null;
}

/**
 * Background calls in flight per route, at most `cap`: a slot is taken at the
 * reservation and given back when the call's first audit row settles (its id
 * is the reservation's). Runtime infrastructure, like the lane: never state.
 */
export class RouteSlots {
  private readonly held = new Map<string, string>(); // callId → route
  private waiting: (() => void)[] = [];
  constructor(private readonly cap = MAX_BACKGROUND_IN_FLIGHT) {}

  full(route: string): boolean {
    return [...this.held.values()].filter((r) => r === route).length >= this.cap;
  }

  /** A 429's cooldown or every slot taken. On the lane nothing can wait, so `ScheduleLLM` and `Judge` come back off it to wait their turn; the nightly single calls (one each) just take theirs. */
  busy(route: string, state: KernelState | null): boolean {
    return heldUntil(state, route, 'cooldownUntil') !== null || this.full(route);
  }

  /** On the lane nothing can wait, so a slot is taken as it is (the cap can be passed by the lane's single calls). */
  take(route: string, callId: string): void {
    this.held.set(callId, route);
    setTimeout(() => this.release(callId), SLOT_MAX_MS).unref();
  }

  release(callId: string): void {
    if (!this.held.delete(callId)) return;
    const woken = this.waiting;
    this.waiting = [];
    for (const wake of woken) wake();
  }

  /** Off the lane: wait out the route's cooldown (the fold may extend it) and for a free slot, then take it in the same step. */
  async hold(route: string, callId: string, state: () => KernelState | null, stopped: () => boolean): Promise<void> {
    for (;;) {
      const until = heldUntil(state(), route, 'cooldownUntil');
      if (stopped() || (until === null && !this.full(route))) return this.take(route, callId);
      await new Promise<void>((resolve) => (until !== null ? setTimeout(resolve, until - Date.now()).unref() : this.waiting.push(resolve)));
    }
  }
}
