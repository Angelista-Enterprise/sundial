import { NOT_A_CALL_APPS } from '@sundial/kernel/watch.js';
import type { CallSpan, Rule } from '@sundial/kernel/types.js';

interface MediaStatePayload {
  timestamp?: string;
  audioInput?: boolean;
  audioOutput?: boolean;
  camera?: boolean;
  audioInputProcess?: string | null;
  audioOutputProcess?: string | null;
  cameraProcess?: string | null;
}

const WORK_CALL_APPS = ['zoom', 'microsoft teams', 'teams', 'google meet', 'meet', 'webex', 'slack', 'around', 'tuple', 'pop', 'google chrome', 'chrome', 'safari', 'arc', 'firefox'];
// avconferenced: macOS's own FaceTime / iPhone-call service — on the record it held the mic through a meeting the owner skipped.
const PERSONAL_CALL_APPS = ['whatsapp', 'facetime', 'avconferenced', 'signal', 'telegram', 'discord', 'messages', 'skype'];

/** Which kind of call an app holding the microphone most likely is. A browser is a work call: meet/teams run there. */
export function classifyCallApp(app: string): CallSpan['kind'] {
  const name = app.trim().toLowerCase().replace(/^‎/, '');
  if (PERSONAL_CALL_APPS.some((known) => name === known || name.startsWith(known))) return 'personal-call';
  if (WORK_CALL_APPS.some((known) => name === known || name.startsWith(known))) return 'work-call';
  return 'call';
}

/**
 * `momentRollup` records the app driving audio OUTPUT and treats "on a call" as
 * one label a moment either is or is not — so a three-hour WhatsApp call under
 * a morning of PR review was recorded as neither
 * (`issues/momentrollup-drops-the-mics-owning-process`, and
 * `enhancements/call-span-overlay-on-moments`, retired from the almanac once built). This is the overlay that page
 * asked for: `state.av.call` opens when an app takes the microphone and closes
 * when it releases it, independent of whatever the moments underneath decide
 * they are.
 *
 * The microphone is the discriminator, not audio output: music is output
 * without input; a call is input, with or without output.
 */
export const callSpanTrack: Rule = (state, event) => {
  if (event.type !== 'media:state') return { state, effects: [] };
  const payload = event.payload as MediaStatePayload;
  const raw = payload.audioInput === true && typeof payload.audioInputProcess === 'string' ? payload.audioInputProcess.trim() : '';
  // Sundial's own hearing holds the microphone under its own name: that is not a call (it read as one in every meeting).
  const micApp = raw !== '' && !NOT_A_CALL_APPS.some((name) => raw.toLowerCase().includes(name)) ? raw : null;
  const camera = payload.camera === true;
  const open = state.av.call;

  if (micApp === null) {
    if (open === null) return { state, effects: [] };
    return { state: { ...state, av: { call: null, lastCall: { ...open, until: event.ts } } }, effects: [] };
  }

  if (open !== null && open.app === micApp) {
    if (camera && !open.cameraEver) return { state: { ...state, av: { ...state.av, call: { ...open, cameraEver: true } } }, effects: [] };
    return { state, effects: [] };
  }

  // A different app took the mic: close the old span, open the new one.
  const call: CallSpan = { app: micApp, kind: classifyCallApp(micApp), since: event.ts, cameraEver: camera };
  return { state: { ...state, av: { call, lastCall: open ? { ...open, until: event.ts } : state.av.lastCall } }, effects: [] };
};
