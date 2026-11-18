import { isOwnAudioProcess } from '@sundial/helpers/window-classification.js';
import { type AvProcessUsage, type AvSnapshot, readAvSnapshot } from './audio-context-capture.js';

export interface AudioContextEvent {
  type: 'media:state';
  payload: Record<string, unknown>;
}

/**
 * The current media state, as a SAMPLE rather than a transition.
 *
 * ## Why this replaced start/end events
 *
 * The previous design tracked every `${kind}:${pid}` in a `Map` held on the sensor
 * instance, emitting `start` when a key appeared and `end` when it vanished. An
 * instance field is exactly what a restarted process does not have, so a daemon
 * restart while audio was live dropped the tracked entry and the `end` for that
 * span was never emitted at all. Measured over three weeks: 161 starts against 131
 * ends for the microphone — 47 spans left open forever — with one resulting
 * implausible span accounting for 36% of all recorded microphone time.
 *
 * The asymmetry is the whole argument for sampling. A lost sample costs one poll
 * interval; a lost transition costs the entire remaining span, which is unbounded.
 *
 * ## The sensor is now stateless
 *
 * There is no lifecycle map, no heartbeat timer, no `lastKey` — nothing to lose on
 * restart. Each poll reports what is true right now, and deduplication happens
 * against `state.observed` in the kernel, which is snapshotted and therefore
 * survives the restart that used to break this. `media:state` is on
 * `stateSignature`'s allow-list, so an unchanged sample is dropped at ingest and
 * never reaches the log.
 *
 * That inverts the failure mode. Restart while the mic is live: the sample is
 * identical, so nothing is written and the span simply continues. Mic switched off
 * while the daemon was down: the next sample differs, so the change is recorded and
 * the span closes — at the sample's timestamp, or at the last observed instant if
 * an observation gap intervened (`momentClose`'s reconciliation).
 *
 * Process names are part of the state, so one app handing the microphone to another
 * is a change rather than a silent continuation.
 */
export interface MediaState {
  audioInput: boolean;
  audioOutput: boolean;
  camera: boolean;
  /** The first holder that is not Sundial itself; `audioInputProcesses` has them all. */
  audioInputProcess: string | null;
  audioInputProcesses: string[];
  audioOutputProcess: string | null;
  cameraProcess: string | null;
}

/** First process of a list, by name — the attribution, when the sidecar can see one. */
function primary(procs: AvProcessUsage[]): string | null {
  return procs.length > 0 ? procs[0].processName : null;
}

/**
 * Every holder of the microphone that is not Sundial's own hearing. The first of
 * a list used to be the attribution, and with hearing on that was Sundial itself
 * in 58% of mic-on samples, hiding whichever call ran beside it.
 */
function holders(procs: AvProcessUsage[]): string[] {
  return [...new Set(procs.map((p) => p.processName).filter((name) => name !== '' && !isOwnAudioProcess(name)))];
}

export function mediaStateFromSnapshot(snapshot: AvSnapshot): MediaState {
  /**
   * Live-tested finding (2026-07-17): camera *attribution* is confirmed to find
   * nothing on modern Apple Silicon Macs — the camera daemon mediates access via
   * IPC, not file descriptors `lsof` can see. `cameraActive` (the boolean) IS
   * reliably detected, via the camera daemon's CPU usage. So the boolean is taken
   * from either source, while attribution stays null when unknown: "the camera is
   * on, by an unknown process" is real signal, and inventing a placeholder process
   * to carry it (as the previous version did, with `pid: 0`) only made the
   * attribution look more certain than it was.
   */
  const camera = snapshot.cameraProcesses.length > 0 || snapshot.cameraActive;

  const mics = holders(snapshot.audioInputProcesses);
  return {
    // The mic is "on" when someone other than Sundial holds it: own hearing is not a call.
    audioInput: mics.length > 0,
    audioOutput: snapshot.audioOutputProcesses.length > 0,
    camera,
    audioInputProcess: mics[0] ?? null,
    audioInputProcesses: mics,
    audioOutputProcess: primary(snapshot.audioOutputProcesses),
    cameraProcess: primary(snapshot.cameraProcesses),
  };
}

export class AudioContextSensor {
  /**
   * Returns at most one event: the current state. An unchanged state is filtered at
   * ingest against durable kernel state, not here — see `MediaState`.
   */
  poll(): AudioContextEvent[] {
    const snapshot = readAvSnapshot();
    // A missing or unreadable sidecar file means "no observation", NOT "nothing is
    // active". Reporting all-false here would close every open span on a transient
    // read failure, which is the failure this rewrite exists to remove.
    if (!snapshot) return [];
    return [{ type: 'media:state', payload: { timestamp: new Date().toISOString(), ...mediaStateFromSnapshot(snapshot) } }];
  }
}
