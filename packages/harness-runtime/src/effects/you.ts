// Effects that reach the owner.
import type { Handlers } from './index.js';

export const YOU = {
  Notify: (host, effect) => {
    // The daemon could only console.log this. The harness forwards it to the
    // delivery hook (→ Cordis `gnomon/notice` event; the proactive plugin
    // subscribes) AND keeps the log line.
    console.log(`[sundial-kernel] notify(${effect.channel}):`, effect.payload);
    host.onNotify?.({ channel: effect.channel, payload: effect.payload });
  },
} satisfies Handlers;
