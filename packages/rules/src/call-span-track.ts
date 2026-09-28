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
const PERSONAL_CALL_APPS = ['whatsapp', 'facetime', 'signal', 'telegram', 'discord', 'messages', 'skype'];

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
 * (`issues/momentrollup-drops-the-mics-owning-process`,
 * `enhancements/call-span-overlay-on-moments`). This is the overlay that page
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
  const micApp = payload.audioInput === true && typeof payload.audioInputProcess === 'string' && payload.audioInputProcess.trim() !== '' ? payload.audioInputProcess.trim() : null;
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
