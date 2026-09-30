import { describe, expect, it } from 'vitest';
import { deliveryActs } from './delivery-acts.js';

/** What `plugins/sundial-proactive/delivery.js` did before the gate chose the acts (at 8db917f7), as the oracle. */
function before(channel: 'phasic' | 'tonic', route: string | undefined, plain: boolean, pushAtMac: boolean): string[] {
  const acts = ['inject'];
  if (channel !== 'phasic') return acts;
  if (!plain) acts.push('turn');
  if (route !== 'mac' || pushAtMac) acts.push('push');
  if (route !== 'phone') acts.push('banner');
  return acts;
}

describe('deliveryActs (W2)', () => {
  const cases = (['phasic', 'tonic'] as const).flatMap((channel) => (['mac', 'phone', undefined] as const).flatMap((route) => [true, false].flatMap((plain) => [true, false].map((pushAtMac) => [channel, route, plain, pushAtMac] as const))));
  it.each(cases)('%s route=%s plain=%s pushAtMac=%s: the same acts delivery.js performed', (channel, route, plain, pushAtMac) => {
    expect(deliveryActs(channel, route, plain, null, { pushAtMac })).toEqual(before(channel, route, plain, pushAtMac));
  });

  it('pushes at the Mac when the setting is absent, as the old default did', () => {
    expect(deliveryActs('phasic', 'mac', false, null)).toEqual(['inject', 'turn', 'push', 'banner']);
  });

  it('a plain tonic notice addressed to a chat is that chat\'s line, and nothing else', () => {
    expect(deliveryActs('tonic', 'mac', true, 'session-7f', { pushAtMac: true })).toEqual(['line']);
    expect(deliveryActs('tonic', 'mac', false, 'session-7f')).toEqual(['inject']);
    expect(deliveryActs('tonic', 'mac', true, null)).toEqual(['inject']);
  });
});
