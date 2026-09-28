import { type ActivityTaxonomy, classifyActivity, isBrowser, isConferencingApp, isMusicApp } from '@sundial/helpers/window-classification.js';
import type { AudioContext, MomentKind, MomentRollup } from '@sundial/kernel/types.js';

export type { MomentKind, AudioContext };

/**
 * Computed once at close, alongside `kind`/`focusScore`. Order matters: a live
 * mic/camera is the clearest call; then a conferencing app (or a Google Meet /
 * Zoom window title) driving audio catches the SILENT, muted meeting the mic
 * misses — the case A04 undercounts; then a music app is music, a browser playing
 * a YouTube title is video, and any other playback is unclassified `audio`.
 */
export function computeAudioContext(rollup: MomentRollup): AudioContext {
  if (rollup.micActive || rollup.cameraActive) return 'call';

  const audioApp = rollup.audioApp ?? '';
  const foreground = rollup.processName ?? '';
  const titles = rollup.windowTitles.join(' ').toLowerCase();
  // `meet - ` covers Google Meet's actual tab title (`"Meet - <code|name>"`), which carries no "google" in it.
  const inMeetTab = titles.includes('google meet') || titles.includes('meet - ') || titles.includes('zoom') || titles.includes('webex');

  // A conferencing app or a meeting tab, with sound or a calendar event to back
  // it — a meeting you are listening to without unmuting.
  if (isConferencingApp(audioApp) || isConferencingApp(foreground) || inMeetTab) {
    return rollup.playbackActive || rollup.calendarActive ? 'call' : 'none';
  }

  if (!rollup.playbackActive) return 'none';
  if (isMusicApp(audioApp) || isMusicApp(foreground)) return 'music';
  if (isBrowser(audioApp) || isBrowser(foreground)) return titles.includes('youtube') ? 'video' : 'audio';
  return 'audio';
}

/**
 * `event:context-switch` fires once per cross-project switch onto
 * `rollup.lifeEvents` (uncapped-per-fire, capped at 20 total —
 * `moment-rollup.ts`'s `LIFE_EVENT_TYPES`); this many within one moment is
 * "thrashing," not a single deliberate switch.
 */
const SWITCH_DENSITY_THRESHOLD = 3;

/** A focusScore at/above this reads as a `focus` moment even without a focus-flow life event (P2c). */
const FOCUS_SCORE_THRESHOLD = 0.7;

/**
 * P2b/P2c (docs/design/07) — a moment is a *real* meeting only when a calendar
 * event overlaps AND there's corroborating truth: named attendees, or a live
 * mic/camera. Bare `calendarActive` (an all-day or zero-attendee event with no
 * mic/cam) no longer counts — the fix for meetings that fell to the audit as
 * all-day false positives. Camera is approximate (CPU-proxy) but only ever
 * *raises* confidence here, never the sole basis asserted downstream.
 *
 * A04's other half — the ad-hoc call the calendar never knew about — is the
 * second branch: a live mic or camera INSIDE a meeting surface (a conferencing
 * app, a Slack huddle, a Meet/Zoom browser tab) is a meeting with or without a
 * calendar event behind it. Measured over one week, calendar-gated detection
 * produced 2 meeting moments (0.1 h) while the log held ~4.7 h of mic-on call
 * time: Slack huddles and ad-hoc Meet links all fell through to focus/browse.
 * The meeting-surface gate is what keeps this narrow — a bare `micActive`
 * (dictation, or a personal call: a real 3 h WhatsApp call once ran backgrounded
 * under a morning of PR review) never qualifies on its own, and personal-call
 * apps are deliberately not meeting surfaces: a personal call is not a meeting,
 * however real it is. See issues/momentrollup-drops-the-mics-owning-process for
 * why the record itself cannot yet tell a call from a stuck mic.
 */
export function isRealMeeting(rollup: MomentRollup): boolean {
  const liveAv = rollup.micActive || rollup.cameraActive;
  if (rollup.calendarActive && (rollup.meetingAttendees.length > 0 || liveAv)) return true;
  return liveAv && isMeetingSurface(rollup);
}

/**
 * A surface the owner holds meetings in: a conferencing app in the foreground
 * or driving audio, a Slack window (a huddle is a call inside the chat app),
 * or a Meet/Zoom/Webex browser tab. Title matching covers Google Meet's
 * `"Meet - <code|name>"` tab title, which carries no "google" in it.
 */
function isMeetingSurface(rollup: MomentRollup): boolean {
  const foreground = rollup.processName ?? '';
  const audioApp = rollup.audioApp ?? '';
  if (isConferencingApp(foreground) || isConferencingApp(audioApp)) return true;
  if (foreground.toLowerCase() === 'slack' || audioApp.toLowerCase() === 'slack') return true;
  const titles = rollup.windowTitles.join(' | ').toLowerCase();
  return titles.includes('google meet') || titles.includes('meet - ') || titles.includes('zoom') || titles.includes('webex');
}

/**
 * docs/design/06-macos-ui-data-wiring.md's Timeline `kind` classification,
 * refined by P2c to take the close-time `focusScore` and real meeting truth.
 * Computed once at close (`momentClose`), one writer, replay-deterministic.
 * Order: a real meeting → a sustained-focus span (focus-flow OR a high
 * focusScore) → thrashing → "just a browser window" → engaged-but-brief work
 * → `setup` fallback.
 *
 * `focusScore` is duration-led (`focus-score.ts`), so any moment under ~10
 * minutes can't cross `FOCUS_SCORE_THRESHOLD` on duration alone even when
 * real work happened in it — this used to dump every short, choppy burst of
 * typing/shell/git activity into `setup` (misread by the journal LLM as
 * literal environment setup — see `docs/design/07`'s tldr shape hint). A
 * moment with any engagement signal is real, just brief; `setup` is now
 * reserved for spans with none.
 */
export function computeMomentKind(rollup: MomentRollup, focusScore: number, taxonomy?: ActivityTaxonomy): MomentKind {
  if (isRealMeeting(rollup)) return 'meeting';

  // Before the focus check, and that ordering is the point: `focusScore` is
  // duration-led, so forty unbroken minutes of television scores as `focus` and the
  // downtime detector never sees a single occurrence. A moment the owner's own
  // taxonomy calls personal is leisure however long and unbroken it was.
  //
  // `ambient` deliberately does not land here — music playing through a coding
  // session is not rest, and counting it would mean the owner never lacks downtime,
  // silently disabling the omission this classification exists to enable.
  if (taxonomy && classifyActivity(rollup.processName ?? '', rollup.windowTitles.join(' | '), taxonomy) === 'personal') return 'leisure';

  if (rollup.lifeEvents.includes('event:focus-flow') || focusScore >= FOCUS_SCORE_THRESHOLD) return 'focus';
  const switchCount = rollup.lifeEvents.filter((event) => event === 'event:context-switch').length;
  if (switchCount >= SWITCH_DENSITY_THRESHOLD) return 'switch';
  if (isBrowser(rollup.processName)) return 'browse';
  const engaged = rollup.typingEventCount > 0 || rollup.shellCommandCount > 0 || rollup.gitCommitCount > 0;
  if (engaged) return 'focus';
  return 'setup';
}
