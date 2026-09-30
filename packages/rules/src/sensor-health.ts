// lane H (H1, H2, H3, H4, H8)
import type { HealthTrouble, KernelState, Rule, SensorHealthState } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { formatClock, localDate } from '@sundial/helpers/local-day.js';

const MINUTE = 60_000;
/** How long a grant, a helper or the microphone must stay broken before it is said. */
export const HEALTH_HOLD_MS = 5 * MINUTE;
/** The window the "no key presses while clicking" check is timed in. */
export const KEYS_WINDOW_MS = 30 * MINUTE;
/** Clicks inside one key-less window that make it a fault rather than reading. */
export const KEYS_MIN_CLICKS = 30;
/**
 * And this many 10-s windows with the mouse in use inside it. Clicking through
 * a browser for ten minutes and leaving is 30 clicks with no key and is fine;
 * a dropped keyboard tap is the mouse busy most of the half hour. On the
 * record the real episode's windows had 76–126 active windows, the false
 * alarms 17–40.
 */
export const KEYS_MIN_ACTIVE = 60;
/** Auth refusals in a row from one provider before it is said. */
export const AUTH_FAILURES_TO_SAY = 3;
/** A gap in `clock:tick` (or in input windows) longer than this was a sleep: clocks restart. */
export const WAKE_GAP_MS = 3 * MINUTE;
/** Worth little by tomorrow, and it wants an interruption: under the gate's two-hour urgent line. */
export const HEALTH_HALF_LIFE_MS = 60 * MINUTE;
/** W6 D9: down this long while the Mac was on, and the next start says so. */
export const DOWN_TO_SAY_MS = 60 * MINUTE;

/** The audio helper states that mean hearing is on and nothing is being heard, in words. */
const MIC_SAYS: Record<string, string> = {
  denied: 'Hearing is on, but macOS refuses Sundial the microphone. Grant it in System Settings → Privacy & Security → Microphone.',
  'no-transcriber': 'Hearing is on, but whisper-server is not installed, so nothing is transcribed (brew install whisper-cpp).',
  'no-model': 'Hearing is on, but the whisper model file is missing, so nothing is transcribed.',
  'transcriber-failed': 'Hearing is on, but whisper-server could not start, so nothing is transcribed. Restart Sundial.',
  'capture-failed': 'Hearing is on, but the microphone could not be opened.',
  'transcribe-failed': 'Hearing is on, but whisper-server stopped answering, so nothing heard since is transcribed. Restart Sundial.',
};

const SIDECAR_WORDS: Record<string, string> = {
  window: 'window reader',
  'focus-mode': 'Focus mode reader',
  'audio/camera': 'microphone and camera reader',
  'input-activity': 'keyboard and mouse counter',
  notifications: 'notification badge reader',
  browser: 'browser tab reader',
};

const idle = (): SensorHealthState => ({ troubles: {}, lastTickAt: null, keys: null, llmAuth: {}, budgetExhausted: {}, push: { lastOkAt: null, lastFailedAt: null, lastError: null } });

function withTrouble(h: SensorHealthState, key: string, ts: string, holdMs: number, observation: string, evidence: string[]): SensorHealthState {
  // A standing trouble keeps its clock and its raised mark; only the words move.
  const prior = h.troubles[key];
  const next: HealthTrouble = prior ? { ...prior, observation, evidence } : { since: ts, holdMs, observation, evidence, raisedAt: null };
  return { ...h, troubles: { ...h.troubles, [key]: next } };
}

function without(h: SensorHealthState, key: string): SensorHealthState {
  if (!(key in h.troubles)) return h;
  const { [key]: _cleared, ...rest } = h.troubles;
  return { ...h, troubles: rest };
}

/**
 * One `sensor-health` candidate, said once per incident: the shape every
 * health notice uses (W5's breaker too). `key` names what broke.
 */
export function healthCandidate(state: KernelState, ts: string, eventId: string, key: string, since: string, observation: string, evidence: string[]): ReturnType<Rule>['effects'][number] {
  return {
    type: 'EmitEvent',
    event: {
      id: deriveId(ts, eventId, 'sensor-health', `${key}:${since}`),
      type: 'notice:candidate',
      ts,
      payload: {
        timestamp: ts,
        shape: 'transition',
        kind: 'sensor-health',
        // Per thing that broke: the next time the same grant drops, the gate
        // knows it said this before (a habituation key must recur).
        key: `sensor-health:${key}`,
        // A helper's own report, not a guess about the owner: high and fixed,
        // so an interruption clears full cost (2.7 − 0.8 ≥ 1.6) the first time.
        surprise: 3,
        precision: 0.9,
        valueHalfLifeMs: HEALTH_HALF_LIFE_MS,
        observation,
        evidence: [...evidence, `since ${formatClock(since, state.config.timezone)}`],
        concerns: [],
        // Its own sentence: no model turn writes it up.
        plain: true,
      },
    },
  };
}

/** Every trouble that has stood long enough and was not said yet, as one candidate each. */
function raiseDue(state: KernelState, h: SensorHealthState, ts: string, eventId: string, tick: boolean): { h: SensorHealthState; effects: ReturnType<Rule>['effects'] } {
  const effects: ReturnType<Rule>['effects'] = [];
  let troubles = h.troubles;
  for (const [key, t] of Object.entries(h.troubles)) {
    if (t.raisedAt !== null || Date.parse(ts) - Date.parse(t.since) < t.holdMs) continue;
    // A held trouble is judged on the tick only, after the tick has restarted
    // the clocks of a Mac that just woke: the first input window after a wake
    // would otherwise say a helper that was stale when the lid closed.
    if (t.holdMs > 0 && !tick) continue;
    troubles = { ...troubles, [key]: { ...t, raisedAt: ts } };
    effects.push(healthCandidate(state, ts, eventId, key, t.since, t.observation, t.evidence));
  }
  return { h: { ...h, troubles }, effects };
}

interface InputPayload {
  keyDownCount?: number;
  mouseClickCount?: number;
  mouseMoveCount?: number;
  scrollCount?: number;
  listenAccessGranted?: boolean;
  tapActive?: boolean;
  stale?: boolean;
}

function onInput(h: SensorHealthState, p: InputPayload, ts: string): SensorHealthState {
  if (p.stale === true) return h;
  // The grant. Only a hard false from the helper is a denial; an older helper says nothing.
  if (p.listenAccessGranted === false || p.tapActive === false) {
    h = withTrouble(h, 'input-grant', ts, HEALTH_HOLD_MS, 'Input Monitoring is off for Sundial: no key presses or clicks are counted. Grant it again in System Settings → Privacy & Security → Input Monitoring, then restart Sundial.', [
      p.listenAccessGranted === false ? 'grant: not given' : 'grant: given',
      p.tapActive === false ? 'event tap: not running' : 'event tap: running',
    ]);
  } else if (p.listenAccessGranted === true && p.tapActive === true) h = without(h, 'input-grant');

  // Keys gone while the mouse still clicks: the keyboard half of the tap died,
  // or an app holds Secure Input. Timed in 30-minute windows inside one run of
  // key-less windows; a gap in the windows (a sleep) starts the run again.
  const keys = typeof p.keyDownCount === 'number' ? p.keyDownCount : 0;
  const clicks = typeof p.mouseClickCount === 'number' ? p.mouseClickCount : 0;
  if (keys > 0) return without({ ...h, keys: null }, 'input-keys');
  const run = h.keys && Date.parse(ts) - Date.parse(h.keys.lastAt) <= WAKE_GAP_MS ? h.keys : { since: ts, windowStart: ts, windowClicks: 0, lastAt: ts };
  const windowClicks = run.windowClicks + clicks;
  const busy = clicks > 0 || (p.mouseMoveCount ?? 0) > 0 || (p.scrollCount ?? 0) > 0;
  const windowActive = (run.windowActive ?? 0) + (busy ? 1 : 0);
  if (Date.parse(ts) - Date.parse(run.windowStart) < KEYS_WINDOW_MS) return { ...h, keys: { ...run, windowClicks, windowActive, lastAt: ts } };
  if (windowClicks >= KEYS_MIN_CLICKS && windowActive >= KEYS_MIN_ACTIVE) {
    const minutes = Math.round((Date.parse(ts) - Date.parse(run.since)) / MINUTE);
    h = withTrouble(h, 'input-keys', ts, 0, `No key press has been counted for ${minutes} minutes while ${windowClicks} clicks were. Input Monitoring may have dropped for Sundial, or an app holds Secure Input.`, [
      `${windowClicks} clicks in the last 30 minutes`,
      '0 key presses',
    ]);
  }
  return { ...h, keys: { ...run, windowStart: ts, windowClicks: 0, windowActive: 0, lastAt: ts } };
}

interface HealthPayload {
  sidecars?: Record<string, unknown>;
  microphone?: unknown;
  screenRecording?: unknown;
  configUnreadable?: unknown;
}

function onHealth(h: SensorHealthState, p: HealthPayload, ts: string): SensorHealthState {
  const sidecars = p.sidecars && typeof p.sidecars === 'object' ? p.sidecars : {};
  for (const key of Object.keys(h.troubles)) if (key.startsWith('sidecar:') && sidecars[key.slice(8)] === undefined) h = without(h, key);
  for (const [label, status] of Object.entries(sidecars)) {
    if (status === 'ok' || typeof status !== 'string') {
      h = without(h, `sidecar:${label}`);
      continue;
    }
    const words = SIDECAR_WORDS[label] ?? `${label} helper`;
    const what = status === 'stale' ? 'has stopped writing' : status === 'blocked' ? 'is on but has written nothing' : 'is not running';
    h = withTrouble(h, `sidecar:${label}`, ts, HEALTH_HOLD_MS, `Sundial's ${words} ${what}. Restart Sundial; if it stays quiet, check its permission in System Settings.`, [`${label}: ${status}`]);
  }
  const mic = typeof p.microphone === 'string' ? p.microphone : null;
  h = mic !== null && MIC_SAYS[mic] ? withTrouble(h, 'microphone', ts, HEALTH_HOLD_MS, MIC_SAYS[mic]!, [`hearing: ${mic}`]) : without(h, 'microphone');
  h =
    p.screenRecording === false
      ? withTrouble(h, 'screen-recording', ts, HEALTH_HOLD_MS, 'Screen text is on, but macOS refuses Sundial Screen Recording. Grant it in System Settings → Privacy & Security → Screen Recording.', ['screen recording: not granted'])
      : without(h, 'screen-recording');
  h = p.configUnreadable === true ? withTrouble(h, 'config', ts, 0, 'config.json could not be read, so Sundial runs on its defaults. Fix the file and restart Sundial.', ['config.json: not valid JSON']) : without(h, 'config');
  return h;
}

/**
 * Sundial's own health, said once per incident through the gate.
 *
 * Folds the helpers' grant flags on `input:activity`, the once-a-minute
 * `sensor:health` state, model auth refusals, budget and push outcomes. A
 * trouble has a clock (`since`) and a hold; on a `clock:tick` past the hold it
 * becomes ONE `sensor-health` candidate and is marked raised. Only its
 * recovery clears it, which re-arms it. A sleep restarts every clock, so a
 * helper that was stale when the lid closed is not said on wake before it
 * had a chance to write again.
 */
export const sensorHealth: Rule = (state, event) => {
  const t = event.type;
  if (
    t !== 'clock:tick' &&
    t !== 'input:activity' &&
    t !== 'sensor:health' &&
    t !== 'llm:auth-failed' &&
    t !== 'llm:auth-ok' &&
    t !== 'llm:budget-exhausted' &&
    t !== 'push:sent' &&
    t !== 'push:failed' &&
    t !== 'sundial:up'
  )
    return { state, effects: [] };
  let h: SensorHealthState = state.sensorHealth ?? idle();
  const ts = event.ts;
  const p = (event.payload ?? {}) as Record<string, unknown>;

  if (t === 'clock:tick') {
    if (h.lastTickAt !== null && Date.parse(ts) - Date.parse(h.lastTickAt) > WAKE_GAP_MS) {
      h = { ...h, troubles: Object.fromEntries(Object.entries(h.troubles).map(([k, v]) => [k, v.raisedAt === null ? { ...v, since: ts } : v])) };
    }
    // W6 D9: the heartbeat, as minutes up per local day; a said downtime clears on the first tick after it.
    const day = localDate(ts, state.config.timezone);
    const up = h.uptime ?? [];
    const uptime = up.at(-1)?.day === day ? [...up.slice(0, -1), { day, minutes: up.at(-1)!.minutes + 1 }] : [...up, { day, minutes: 1 }].slice(-7);
    h = without({ ...h, lastTickAt: ts, uptime }, 'downtime');
  } else if (t === 'sundial:up') {
    // W6 D9: down while the Mac was on — since the last heartbeat, or since the Mac booted if that came after it.
    const last = typeof p.lastSeenAt === 'string' ? Date.parse(p.lastSeenAt) : NaN;
    const boot = typeof p.macBootAt === 'string' ? Date.parse(p.macBootAt) : NaN;
    const from = Math.max(last, Number.isFinite(boot) ? boot : last);
    if (Number.isFinite(from) && Date.parse(ts) - from > DOWN_TO_SAY_MS) {
      const since = new Date(from).toISOString();
      const hours = Math.round((Date.parse(ts) - from) / 360_000) / 10;
      h = withTrouble(h, 'downtime', since, 0, `Sundial was not running for ${hours} hours while this Mac was on, so nothing was recorded from ${formatClock(since, state.config.timezone)} until now.`, [`down ${hours} h`]);
    }
  } else if (t === 'input:activity') h = onInput(h, p as InputPayload, ts);
  else if (t === 'sensor:health') h = onHealth(h, p as HealthPayload, ts);
  else if (t === 'llm:auth-failed' || t === 'llm:auth-ok') {
    const provider = typeof p.provider === 'string' && p.provider !== '' ? p.provider : 'model';
    if (t === 'llm:auth-ok') h = without({ ...h, llmAuth: Object.fromEntries(Object.entries(h.llmAuth).filter(([k]) => k !== provider)) }, `llm-auth:${provider}`);
    else {
      const label = typeof p.label === 'string' && p.label !== '' ? p.label : provider;
      const statusCode = typeof p.statusCode === 'number' ? p.statusCode : null;
      const count = (h.llmAuth[provider]?.count ?? 0) + 1;
      h = { ...h, llmAuth: { ...h.llmAuth, [provider]: { count, label, statusCode } } };
      if (count >= AUTH_FAILURES_TO_SAY) {
        h = withTrouble(h, `llm-auth:${provider}`, ts, 0, `${label} refused Sundial's key ${count} times in a row${statusCode ? ` (HTTP ${statusCode})` : ''}. Check the key in Sundial's .env, then restart Sundial.`, [`${count} refusals in a row`]);
      }
    }
  } else if (t === 'llm:budget-exhausted') {
    if (typeof p.purpose === 'string') h = { ...h, budgetExhausted: { ...h.budgetExhausted, [p.purpose]: localDate(ts, state.config.timezone) } };
  } else if (t === 'push:sent') h = { ...h, push: { ...h.push, lastOkAt: ts } };
  else h = { ...h, push: { ...h.push, lastFailedAt: ts, lastError: typeof p.reason === 'string' ? p.reason.slice(0, 80) : null } };

  const raised = raiseDue(state, h, ts, event.id, t === 'clock:tick');
  return { state: { ...state, sensorHealth: raised.h }, effects: raised.effects };
};
