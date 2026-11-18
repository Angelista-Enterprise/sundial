// Plan 15, 2.4: the colleague at the desk: its voice, the summoned panel, the marks on screen, the last task boundary.
// Each field is written by the rule of its step (`voiceKnock`, `overlayTrack`, `screenTrack`, `boundaryTrack`).
// Rates and histories are selectors over the log, not state. The witness pairs live in `witness`, the ask queue in `ownerAsk.queue`.
import type { ScreenMark } from '../effects.js';
import type { StepRow } from '@sundial/helpers/screen-routes.js';
import type { OpenedSlice } from '@sundial/helpers/opened.js';
export type { OpenedItem, OpenedSlice } from '@sundial/helpers/opened.js';
import type { JudgementQuestionRecord } from './feedback.js';

/** Plan 15 step 7: one step of a guide: the thing to point at, and the one line said beside it. */
export interface GuideStep {
  target: ScreenMark['target'];
  line: string;
}

/** One chat's screen tools: the last look an answer printed there, when each app's was (at most 8), the app of its last look or act, the app its last step quit. */
export interface ScreenChat {
  look?: { id: string; tag?: string; app: string; at: string; act: string | null };
  apps?: Record<string, string>;
  app?: { app: string; at: string };
  quit?: { app: string; at: string };
  /** The chat's last step (`screen:step`): its act id, whose after-look holds where the keyboard went. */
  step?: { id: string; app: string; at: string };
  /**
   * The chat's last set-value that went through, by its thing (never its value): the field may hold Gnomon's own text, which Sundial.app confirms at the act.
   * S5R1 (Fable M2): `task`, the chat's task then, and `chars`, how many characters it set, bound it; a set-value refused since drops it.
   */
  set?: { app: string; name: string; role?: string; at: string; task?: string; chars?: number };
}

export interface DeskSlices {
  voice?: {
    /** The one knock that waits for a go. */
    pendingKnock: { noticeKey: string; kind?: string; mode: 'knock-wait' | 'knock-speak'; at: string; sessionId?: string | null; askId?: string | null; turn?: boolean } | null;
    /** The last window with a key press, and the last speech heard: the knock stays out of both. */
    typedAt?: string | null;
    heardAt?: string | null;
    /** The last holding lines said, so none is said twice in a row. At most 8. */
    recentLines: string[];
    /** The end of "quiet". */
    mutedUntil: string | null;
    /** Plan 15 4.4: a job came back at this time; the return sound waits for the next boundary. */
    returnAt?: string | null;
    /** Plan 15 step 3: the last spoken replies (at most 5), so hearing drops its own voice; the owner's last stop. */
    recentSaid?: { text: string; at: string }[];
    interruptedAt?: string | null;
    /**
     * Set 2 R3: the newest spoken turn (`voice:turn`) and the lines sent to the app in it, as `voice:line` rows with its
     * session and `turnAt` (at most 12), the next seq, and whether its last line went. After a restart the reply goes on
     * past these lines instead of saying them again (voice-turn.js). `voice:said` cannot be the source: the app writes a
     * reply's row only once the whole turn has sounded, so a turn cut by a restart has none yet.
     */
    said?: { session: string; at: string; lang: string | null; lines: string[]; seq: number; ended?: boolean } | null;
  };
  overlay?: {
    /** The summon that is open. */
    open: { summonId: string; at: string; evidence: string[]; guess: string | null; firstMove: string | null } | null;
    /** Per sign: how often it was the guess at a summon, and how often the owner's first move then was to type, look or talk. The fixed set of signs. */
    tally: Record<string, { n: number; hits: number }>;
  };
  /** Not `screen`: that is the screen reader's slice. */
  marks?: {
    /** On screen now. At most 12. */
    now: ScreenMark[];
    /** The guide that runs, with its steps (at most 7, the Nodus limit). */
    guide: { taskKey: string; step: number; total: number; steps?: GuideStep[]; shown?: 'ring-line' | 'ring' } | null;
    /** Per task: times guided. At most 50, the oldest out. */
    guideTally: Record<string, number>;
    /** The marks the app found and drew (`screen:mark-placed`); at most 12. */
    placed?: string[];
    /** Plan 15 step 6: marks the owner judged so far; the panel asks "Right spot?" for the first 20. */
    judged?: number;
    /** Plan 15 step 8: the app's answer to the last act, for the tool that waits on it. `at`: when it came (SET4 R2: a look before it is stale). `own`: the set-value replaced text Gnomon set there itself, unchanged since. */
    lastAct?: { id: string; at?: string; outcome: 'performed' | 'refused'; replaced?: boolean; own?: boolean; reason?: string; target?: ScreenMark['target']; names?: string[]; proof?: 'confirmed' | 'unconfirmed' } | null;
    /** Doc 16: the last look at an app (`screen:looked`). A pointer: the elements stay in the log row. */
    lastLook?: { id: string; app: string; window?: string; n: number; at?: string; after?: string; refused?: string; tag?: string } | null;
    /** Round 2: per chat (`''` for none), what its screen tools last did, from `screen:printed` and `screen:step`. At most 20 chats. */
    chats?: Record<string, ScreenChat>;
    /** Round 2: per app, when a press on Send there went unconfirmed (`screen:step` with `proof`); a confirmed one clears it. At most 8. */
    unsent?: Record<string, string>;
  };
  /** Doc 16's fast path (`screenPickTrack`): the pick waiting for its step, and one grade per question id (at most 8). */
  screenPick?: { last: { qid: string; p: number; acted: boolean; app: string; role?: string; name: string; at: string } | null; grades: Record<string, JudgementQuestionRecord> };
  /** Plan 15 4.3: the stuck signs of the last ten minutes (at most 8), the error lines seen on screen (at most 5), the last stuck notice. */
  stuck?: { signs: { sign: string; at: string; line: string; id: string }[]; errors: { key: string; at: string; gone?: boolean }[]; noticedAt: string | null };
  /**
   * S6 `offerNow`: the window context in front and since when (`asked` once the model was put the question for it), the last few
   * contexts of the last ten minutes (at most 6), and the last ask. Single writer: `offerNow`. Optional: an older snapshot has none.
   */
  offerNow?: { context: { key: string; app: string; title: string; since: string; asked: boolean } | null; recent: { app: string; title: string; at: string }[]; lastAskAt: string | null };
  boundary?: { last: { kind: string; at: string } | null; idleSince?: string | null };
  /** `routePromote`: the steps of the newest screen runs (a run is one app, goal and chat; at most 8 runs of 16 steps), the run of the last step, and the route key each run last offered as a fact. */
  routePromote?: { runs: Record<string, StepRow[]>; last: string | null; said: Record<string, string> };
  /** Round 5 `selfReview`: Gnomon's own failed steps in clusters, the proposals on the shelf, the routes counted toward a skill, what the owner kept. Every part bounded. */
  selfReview?: SelfReviewSlice;
  /** Set 5 R2 (plan 21, 2E) `openedTrack`: what Gnomon's screen steps opened and the log has not seen closed, per chat; and per app, whether its newest look had a sheet or dialog in front. */
  opened?: OpenedSlice;
}

/** One cluster: failures of one kind (a refusal reason, `denied`, `refused`) in one app and one chat (`''` for none). */
export interface ReviewCluster {
  app: string;
  session: string;
  kind: string;
  n: number;
  firstAt: string;
  /** The failed steps in plain words, the newest 5, for the job. */
  steps: string[];
}

/** One thing put to the owner on the shelf, applied only on their Keep. */
export type ReviewProposal =
  | { kind: 'drop-route'; app: string; routeKey: string }
  | { kind: 'app-note'; app: string; line: string }
  | { kind: 'fact'; app: string; predicate: string; object: string }
  | { kind: 'skill'; app: string; name: string; routeKey: string }
  | { kind: 'drop-skill'; app: string; name: string };

export interface SelfReviewSlice {
  /** Open clusters by `app\nsession\nkind`, at most 8, the oldest out. */
  pending: Record<string, ReviewCluster>;
  /** The ids of failure rows already counted (an act's refusal and its step are one), the newest 32. */
  seen: string[];
  /** Proposals on the shelf by shelf row id, at most 10. */
  proposed: Record<string, ReviewProposal & { cluster?: string; n?: number }>;
  /** Routes by `app\nroute key`: clean runs, the owner-local days they ran on (newest 7), failed steps since the count began, when offered as a skill or for dropping. At most 32. */
  routes: Record<string, { app: string; key: string; name: string; clean: number; days?: string[]; failed: number; offeredAt?: string; dropOfferedAt?: string }>;
  /** Skills the owner kept, by name: the app and route key. At most 20. `rig`: kept in the rig's chat, or said so; run and offered only there. */
  skills: Record<string, { app: string; routeKey: string; at: string; rig?: true }>;
  /** App notes the owner kept, for the brief, the newest 20. */
  notes: { app: string; line: string; at: string }[];
  /** Set 5 R3: what the owner dismissed (`proposalSignature`), the newest 32, so the same proposal is never put again. */
  dismissed?: string[];
}
