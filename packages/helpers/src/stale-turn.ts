import { TURN_IDLE_MS } from './vocab.js';

/**
 * A turn that sat this long with no step and no tool call has nobody behind it. The quiet-turn watchdog's own
 * figure: shorter than an approval's five-minute life, so an ask that ran out unanswered marks its turn stale.
 * Run 200 T07: its turn waited out four asks, five minutes each, and kept acting on the screen for 28 minutes,
 * through all of run 202 ("open ledger.txt in TextEdit" right after run 202's "Sent").
 */
export const STALE_TURN_MS = TURN_IDLE_MS;

interface LogEvent {
  readonly type?: string;
  readonly time?: number;
  readonly data?: { readonly callId?: unknown; readonly id?: unknown; readonly outcome?: unknown; readonly message?: { readonly toolCallId?: unknown }; readonly source?: { readonly kind?: unknown; readonly form?: unknown } };
}

/**
 * How long the running turn sat still, when it sat at least `STALE_TURN_MS`; null for a turn that keeps moving or
 * has ended. Read from the chat's own log: the gap between two events of the turn, or from its last event to `now`,
 * while no tool was running. A tool that runs (a long shell job, a wait) is work; a call held on an approval is not.
 * A gap the owner ends (an approval granted, their own words) is them being there, not a stale turn.
 */
export function staleTurn(events: readonly LogEvent[] | undefined, now: number): number | null {
  const list = events ?? [];
  const types = list.map((e) => e?.type);
  const start = types.lastIndexOf('turn/start');
  if (start < 0 || types.lastIndexOf('turn/end') > start) return null;
  const running = new Set<string>();
  const asked = new Map<string, string>();
  const call = (v: unknown) => String(v ?? '').split(':')[0];
  const busy = () => [...running].some((id) => ![...asked.values()].includes(id));
  let last = Number(list[start]?.time) || now;
  for (const e of list.slice(start + 1)) {
    const at = Number(e?.time);
    if (!Number.isFinite(at)) continue;
    const owner = (e.type === 'approval/decided' && e.data?.outcome !== 'rejected') || (e.type === 'user/message' && e.data?.source?.kind === 'user' && e.data.source.form === undefined);
    if (!owner && !busy() && at - last >= STALE_TURN_MS) return at - last;
    last = at;
    if (e.type === 'tool/call') running.add(call(e.data?.callId));
    else if (e.type === 'tool/result') running.delete(call(e.data?.message?.toolCallId));
    else if (e.type === 'approval/asked') asked.set(String(e.data?.id), call(e.data?.callId));
    else if (e.type === 'approval/decided') asked.delete(String(e.data?.id));
  }
  return !busy() && now - last >= STALE_TURN_MS ? now - last : null;
}

/** The one line a withdrawn turn's model is told, and the owner sees from it. */
export const staleLine = (ms: number) => `This turn sat ${Math.round(ms / 60_000)} minutes with no step (an ask nobody answered), so it is withdrawn: do not act. Say in one line that you stopped and why.`;
