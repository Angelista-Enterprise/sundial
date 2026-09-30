/**
 * What delivering one admitted notice means, as a list of acts (W2). The gate
 * computes it and the delivery plugin performs it, so the plugin makes no
 * routing decision of its own; the plugin calls it too, only for a payload
 * that arrived without `acts` (an older journaled Notify, the dev test hook).
 *
 *   inject — the notice as model-facing context in the chat
 *   turn   — wake the chat's agent to say it (an interruption that is not plain)
 *   line   — one `Follow-up:` line drawn in the chat, no model turn (a plain notice addressed to a chat)
 *   push   — ntfy to the phone; at the Mac only while `pushAtMac`
 *   banner — the native banner (a no-op unless the owner enabled them); never when the route is `phone`
 *
 * Moved unchanged from `delivery.js`: an interruption injects, wakes the agent
 * unless it is plain, and pushes and banners by its route; a tonic notice only
 * injects — or, plain and addressed to a chat, becomes that chat's line.
 */
export type DeliveryAct = 'turn' | 'line' | 'inject' | 'push' | 'banner';

export function deliveryActs(channel: 'phasic' | 'tonic', route: string | null | undefined, plain: boolean, sessionId: string | null | undefined, notifications?: { pushAtMac?: boolean }): DeliveryAct[] {
  if (channel === 'tonic') return plain && typeof sessionId === 'string' && sessionId !== '' ? ['line'] : ['inject'];
  const acts: DeliveryAct[] = plain ? ['inject'] : ['inject', 'turn'];
  if (route !== 'mac' || notifications?.pushAtMac !== false) acts.push('push');
  if (route !== 'phone') acts.push('banner');
  return acts;
}
