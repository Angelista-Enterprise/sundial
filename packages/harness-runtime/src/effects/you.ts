// Effects that reach the owner.
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { sendAppCommand } from '../app-channel.js';
import type { Handlers } from './index.js';

export const YOU = {
  Notify: (host, effect) => {
    // The daemon could only console.log this. The harness forwards it to the
    // delivery hook (→ Cordis `gnomon/notice` event; the proactive plugin
    // subscribes) AND keeps the log line.
    console.log(`[sundial-kernel] notify(${effect.channel}):`, effect.payload);
    host.onNotify?.({ channel: effect.channel, payload: effect.payload });
  },
  // Plan 15, 2.3: Sundial.app says it; the engine is the owner's config, read when a line is said.
  Speak: (_host, { text, sound, mode, noticeKey }) => sendAppCommand({ type: 'speak', text, sound, mode, noticeKey, voice: loadSundialConfig().voice }),
  Mark: (_host, { marks, judge }) => sendAppCommand({ type: 'marks', marks, ...(judge ? { judge } : {}) }),
} satisfies Handlers;
