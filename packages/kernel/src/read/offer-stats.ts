// Set 2 R3: offers pressed over offers shown, from the slip and from the knock, from the log. Trust a rate at n >= 20 shown.
import { getAllSignalsInRange } from '@sundial/db/index.js';

type Row = { signalType: string; eventType: string; data: Record<string, unknown> };
export interface OfferCount {
  shown: number;
  pressed: number;
}

/**
 * The slip: shown is a `notice:seen` from surface `slip-offer`, pressed an `notice:offer-taken` via `slip`.
 * The knock: shown is a `voice:knock` on a notice delivered with an offer, pressed an `offer-taken` via `knock`.
 */
export function offerCounts(signals: Row[]): { slip: OfferCount; knock: OfferCount } {
  // The plugin records the delivery after the fold knocked, so the offered keys are gathered first.
  const offered = new Set(signals.filter((s) => s.signalType === 'notice' && s.eventType === 'delivered' && typeof s.data.offer === 'string').map((s) => String(s.data.noticeKey ?? '')));
  const slip = { shown: 0, pressed: 0 };
  const knock = { shown: 0, pressed: 0 };
  for (const s of signals) {
    const type = `${s.signalType}:${s.eventType}`;
    const key = String(s.data.noticeKey ?? '');
    if (type === 'notice:seen' && s.data.surface === 'slip-offer') slip.shown += 1;
    else if (type === 'voice:knock' && offered.has(key)) knock.shown += 1;
    else if (type === 'notice:offer-taken' && s.data.via === 'slip') slip.pressed += 1;
    else if (type === 'notice:offer-taken' && s.data.via === 'knock') knock.pressed += 1;
  }
  return { slip, knock };
}

export async function readOfferStats({ now, days = 30 }: { now: number; days?: number }) {
  const signals = await getAllSignalsInRange(new Date(now - days * 86_400_000).toISOString(), new Date(now + 1).toISOString(), ['notice:delivered', 'notice:seen', 'notice:offer-taken', 'voice:knock']);
  return { days, ...offerCounts(signals) };
}
