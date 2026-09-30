// W5: the calibrated-parameter slice and the autonomy slice (`calibrate`, `autonomyTrack`).

/** Sufficient statistics for one parameter: n outcomes, and the hits (a rate) or the sum (a mean) behind them. */
export interface ParamStats {
  n: number;
  hits: number;
  sum: number;
  updatedAt: string | null;
}

/** One kind's delivered notices on one local day, and what became of them (W4 step 8). */
export interface NoticeDay {
  delivered: number;
  /** Delivered notices with any label: a verdict, seen, or the kind's own action. */
  labelled: number;
  useful: number;
  wrong: number;
  notNow: number;
  seen: number;
  acted: number;
  /** Delivered as exploration: a suppressed candidate of a thin kind, said tonic so the kind still earns labels. */
  explored: number;
}

/** One notice the gate delivered, as `notices.lastDelivered` names it. */
export interface DeliveredNotice {
  key: string;
  kind: string;
  channel: 'tonic' | 'phasic';
  cost: number;
  evidence: string[];
  sessionId: string | null;
  askId: string | null;
  exploration?: boolean;
}

/** A delivered notice, watched for what the owner did next (W5 step 5). */
export interface WatchedNotice {
  key: string;
  kind: string;
  channel: 'tonic' | 'phasic';
  at: string;
  /** The local day it was delivered on: its labels are counted there. */
  day: string;
  /** What the kind's own action would touch: an agent session, a branch. */
  subject: string | null;
  /** The chat a follow-up was addressed to. */
  sessionId: string | null;
  askId: string | null;
  /** The interruption cost it was delivered at (0 on the tonic path). */
  cost: number;
  /** The app in front when it landed, for the return-to-the-app lag (phasic only). */
  app: string | null;
  leftAt: string | null;
  seen?: boolean;
  acted?: boolean;
  returned?: boolean;
  answered?: boolean;
  verdict?: string;
  labelled?: boolean;
}

export interface CalibratedState {
  /** Parameter id → its outcomes so far. Ids and priors are declared in `PARAMETERS`. */
  params: Record<string, ParamStats>;
  /** Kind → local day → counts, the last 30 days. */
  noticeByKind: Record<string, Record<string, NoticeDay>>;
  /** The last delivered notices, newest last. */
  watch: WatchedNotice[];
  /** The routine forecast standing since the trail's last step, scored at the next step. */
  routine: { from: string; expected: string | null; at: string } | null;
  /** The app in front, from `window:changed`. */
  app: string | null;
  /** Presence probes at fixed times (every 15 min), scored like a notice's "seen": the baseline for the lift. */
  probes: string[];
}

export type AutonomyLevel = 'off' | 'ask' | 'act';

/** W5 step 10: what each capability may do alone, and why. */
export interface AutonomyState {
  /** Capability → its level now, whether the scorecard rows meet target, and since when. */
  levels: Record<string, { level: AutonomyLevel; earned: boolean; since: string }>;
  /** Capability → when the owner said it may act alone (`autonomy:granted`). */
  granted: Record<string, string>;
  /** Capability → the owner's own ceiling (`autonomy:set`); always wins. */
  lowered: Record<string, AutonomyLevel>;
}

/** KernelState's Calibrated fields; `KernelState` extends this. */
export interface CalibratedSlices {
  /** W5: the calibrated parameters and each notice kind's outcomes, by `calibrate`. */
  calibrated: CalibratedState;
  /** W5 step 10: what each capability may do alone, by `autonomyTrack`. */
  autonomy: AutonomyState;
}
