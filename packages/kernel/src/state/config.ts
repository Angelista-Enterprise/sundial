// The owner's configuration as the fold holds it (`config:changed`, W3) and their settings (`settings:set`).
import type { NightJobsConfig } from './actions.js';
import type { ResolvedSundialConfig } from '@sundial/helpers/sundial-config.js';

/** KernelState's Config fields; `KernelState` extends this. */
export interface ConfigSlices {
  /**
   * C4 (docs/audit/production-proposal-and-enhancements.md, fixes A§5.6) —
   * the two config values pure *rules* need (`retentionPrune`,
   * `memoryDecay`) live in `KernelState` itself rather than a module-level
   * config singleton, so a rule stays a pure `(state, event) => ...`
   * function with no external mutable read. `startDaemon` overwrites this
   * slice with the freshly-loaded `~/.sundial/config.json` values every
   * boot, *after* `hydrateSnapshot`/`createInitialState` — config is meant
   * to reflect what's on disk right now, not whatever a stale snapshot
   * captured, so it's deliberately exempt from the normal
   * snapshot-is-authoritative treatment every other slice gets.
   */
  config: KernelConfig;
  /** The owner's settings — see `OwnerSettings`. Written by `settingsTrack`. */
  settings: OwnerSettings;
}

/**
 * The subset of `~/.sundial/config.json` a PURE rule may read, copied onto
 * `state.config` every boot so a rule stays a `(state, event)` function.
 *
 * DERIVED from the resolved config rather than hand-listed: the hand-written
 * version meant one new field cost seven edits (the helpers interface, its
 * default, its parser, this type, `createInitialState`, the harness copy and
 * the retired daemon's copy) and a field added to only six of them type-checks
 * everywhere except the one file that reads it. `Pick` makes the list of what
 * rules may see the single thing to maintain.
 *
 * `screenTextRetentionDays`, `transcriptRetentionDays` and `autoHearMeetings`
 * are named differently from the file's (`ocr.retentionDays`,
 * `audio.retentionDays`, `audio.autoMeetings`), so they are stated separately.
 */
export type KernelConfig = Pick<
  ResolvedSundialConfig,
  'retentionDays' | 'decayFactor' | 'projectRules' | 'sharedPlaces' | 'projectAliases' | 'orgByPath' | 'locationLabels' | 'ownerAliases' | 'timezone' | 'refutationEnabled' | 'leisureRules' | 'experiments' | 'vault' | 'budgets' | 'llm' | 'actions'
> & {
  /** Days `screen:ocr` signals are kept — shorter than `retentionDays`; see `OcrConfig.retentionDays`. */
  screenTextRetentionDays: number;
  /** Days `audio:transcript` signals are kept; `AudioConfig.retentionDays`. */
  transcriptRetentionDays: number;
  /** `audio.autoMeetings`: meetings and calls open the microphone by themselves. Off: only Listen does. */
  autoHearMeetings: boolean;
  // lane E (#12)
  /** `config.jobs` (the night shift). Optional: absent means off, and so does every snapshot from before it. */
  jobs?: NightJobsConfig;
  /** W2: whether a notice also pushes to the phone while the owner is at the Mac. Absent means yes (the default). W3: and whether banners are on. */
  notifications?: Pick<ResolvedSundialConfig['notifications'], 'pushAtMac' | 'enabled'>;
  /** W3: config paths changed since boot that only a restart applies (`config-log.ts` RESTART_PATHS); cleared by the boot's `config:changed`. */
  pendingRestart?: string[];
};

/**
 * The owner's settings, as the whole system sees them.
 *
 * Deliberately kernel state, not a file and not `localStorage`: a rule must be
 * able to read them (the notice gate asks whether it may speak at all), the
 * model's tools must be refused by them, and every open tab must agree. They
 * arrive as `settings:set` events like everything else, so a replay reproduces
 * the settings that were in force when a decision was made.
 */
export interface OwnerSettings {
  /**
   * How much Gnomon does unasked.
   *
   * `off` — it answers, and nothing else: the gate admits no notice, the board
   * tools refuse. `notice` — it may speak first when the gate says so, but it
   * does not touch the board. `act` — it may also place cards, walk the owner
   * through something, and open surfaces.
   */
  autonomy: 'off' | 'notice' | 'act';
  /**
   * How much a notice must be worth before it is said, as a nudge on the gate's
   * own bar: 0 leaves the policy alone, +1 is twice as hard to clear, -1 half.
   */
  noticeBias: number;
  /** Walk steps advance on their own after this many ms; `null` waits for Next. */
  autoAdvanceMs: number | null;
  /** The paper, for every tab: `system` follows the machine. */
  paper: 'system' | 'light' | 'dark';
  /** `reduced` stills every animation, whatever the machine says. */
  motion: 'full' | 'reduced';
  /**
   * How much a card's glass blurs what is behind it, for every tab.
   *
   * `off` is not a zero blur: it spends no backdrop layer at all, which is the
   * whole reason the switch exists — a blur is re-sampled on every frame, and
   * it was the board's hottest cost.
   */
  blur: 'off' | 'soft' | 'full';
  /** Notice groups the owner turned off (`notice-groups.ts`). Missing on an older fold = none. */
  quiet?: string[];
  /** When the settings last changed, or null if they never have. */
  updatedAt: string | null;
}
