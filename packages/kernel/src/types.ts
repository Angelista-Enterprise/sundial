import type { Event, SanitizedEvent } from '@sundial/helpers/sanitize-at-ingest.js';
import type {} from '@sundial/helpers/sundial-config.js';
import type { ENTITY_KINDS } from '@sundial/helpers/vocab.js';
import type { NoticesSlices } from './state/notices.js';
import type { ConversationSlices } from './state/conversation.js';
import type { LoopsSlices } from './state/loops.js';
import type { ReliabilitySlices } from './state/reliability.js';
import type { ActionsSlices } from './state/actions.js';
import type { FeedbackSlices } from './state/feedback.js';
import type { CalibratedSlices } from './state/calibrated.js';
import type { BriefsSlices } from './state/briefs.js';
import type { ActivitySlices } from './state/activity.js';
import type { WorkSlices } from './state/work.js';
import type { BoardSlices } from './state/board.js';
import type { PeopleSlices } from './state/people.js';
import type { MemorySlices } from './state/memory.js';
import type { ConfigSlices } from './state/config.js';
import type { AttributedEffect, Effect } from './effects.js';
export type * from './state/notices.js';
export type * from './state/conversation.js';
export type * from './state/loops.js';
export type * from './state/reliability.js';
export type * from './state/actions.js';
export type * from './state/feedback.js';
export type * from './state/calibrated.js';
export type * from './state/briefs.js';
export type * from './state/activity.js';
export type * from './state/work.js';
export type * from './state/board.js';
export type * from './state/people.js';
export type * from './state/memory.js';
export type * from './state/config.js';
export type * from './effects.js';

export type { Event, SanitizedEvent };

/**
 * docs/design/06-macos-ui-data-wiring.md's Timeline classification — a
 * closed-moment display concern computed once at write time
 * (`packages/rules/src/moment-kind.ts`'s `computeMomentKind`), not part of
 * `MomentRollup` itself (a still-open moment has no `kind` yet). Lives here,
 * not in `packages/rules`, so `MomentRow.data` below can reference it
 * without `@sundial/kernel` depending on the rules package.
 */
/**
 * `leisure` was added for the noticing gate's omission detector: "no downtime in
 * eight days" is not computable without a category for downtime, and every other
 * kind here describes a flavour of work. It sits in this union rather than in a
 * separate boolean because a moment has exactly one kind, and a moment that is
 * leisure is not simultaneously `browse`.
 *
 * Deliberately NOT inferred from "absence of work signals" — see
 * `classifyActivity`, which reads the browser profile first. The measured reason
 * is in that function's doc comment: 202 of 213 youtube.com visits in the
 * reference corpus sat in one Chrome profile, so the profile carries the signal
 * that a domain list cannot.
 */
export type MomentKind = 'setup' | 'focus' | 'meeting' | 'switch' | 'browse' | 'leisure';

/**
 * P2a (docs/design/07) — a numeric per-moment focus score (0–1) and its
 * bucket, computed once at close (`packages/rules/src/focus-score.ts`) from
 * duration + within-moment disruption/engagement, then merged into
 * `MomentRow.data` alongside `kind` (not on the open `MomentRollup`, same as
 * `kind`). Deliberately treats a long single-activity moment as focused — the
 * WCS deepWorkBlocks false-negative this fixes at the moment level.
 */
export type FocusQuality = 'deep' | 'steady' | 'shallow';

/**
 * C17 — what a moment's audio actually was, computed once at close by
 * `computeAudioContext` from the fused mic/playback/app/title/calendar signals
 * (the audio DEVICE alone was the refuted proxy). Lives here beside `MomentKind`
 * for the same reason: a close-time display derivation on `MomentRow.data`, not a
 * field of the open `MomentRollup`.
 */
export type AudioContext = 'call' | 'music' | 'video' | 'audio' | 'none';

/**
 * How a moment/window's project attribution was derived — recorded so a weak
 * guess never masquerades as a fact. `editor-doc` (AX documentPath under a
 * known root) and `shell-cwd` (a terminal window, project from the last
 * shell/git cwd) are `certain`; `title-folder` (an editor window with no
 * documentPath but a `"… — <name>"` title matching a known project) is `weak`.
 * `git-activity` is reserved for a future direct-from-git attribution.
 *
 * `span-continuation` is not a locator at all — it records that a moment INHERITED
 * the surrounding project because its own attribution was too brief and too weak
 * to count as having left (see `momentClose`'s brief-excursion absorption). It is
 * a distinct value rather than a silent overwrite so the record still says how the
 * project got there, and anyone who disagrees with the heuristic can filter these
 * out instead of being unable to find them.
 */
export type LocatorSource = 'editor-doc' | 'shell-cwd' | 'agent-session' | 'title-folder' | 'git-activity' | 'rule-match' | 'span-continuation';
/**
 * Where a `entity:fact-candidate` came from — `contradictionCheck` branches
 * on this rather than treating every candidate as a noisy sensor reading
 * needing corroboration (see almanac's concepts/entity-facts-and-belief).
 * `inference`: a heuristic or LLM-derived guess from observed activity —
 * today's 2-of-3 promotion/supersession thresholds apply unchanged.
 * `assertion`: the owner directly stating or correcting a fact — supersedes
 * (never deletes) on a single observation and seeds a posterior that decays
 * slowly. `assistant`: reserved for a future assistant-authored claim (see
 * decisions/assistant-as-an-event-source) — not produced by anything today,
 * modeled now so adding it later isn't a migration. Absent on an
 * `entity:fact-candidate` event logged before this field existed; treat as
 * `inference` on replay.
 */
/**
 * `conversation` — the owner said it in a chat turn and the nightly
 * conversation pass extracted it (`conversationFactExtract`). Promotes on one
 * observation like an assertion, because a thing the owner said once never
 * recurs as the same triple and would otherwise never clear the two-observation
 * bar; seeded with LESS evidence than an assertion (`CONVERSATION_EVIDENCE_WEIGHT`)
 * because an extraction is one model's reading of a sentence, not the owner's
 * own typed claim. See `architecture/rules/memory-and-knowledge-rules`.
 */
export type FactProvenance = 'inference' | 'assertion' | 'assistant' | 'conversation';

/**
 * The kinds an entity can be (`ENTITY_KINDS` in helpers' vocab). `owner` is the person
 * Gnomon works for: exactly one entity, named by `config.ownerAliases[0]`, kept OUT of
 * `person` so a calendar attendee list never records the owner meeting themselves
 * (`entity-name-validation` refuses an owner alias as a person for that reason). Every
 * producer canonicalises an owner alias onto this kind with `canonicalOwnerName` first.
 */
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * P1 (docs/design/07) — a user-authored project-attribution rule, loaded from
 * `~/.sundial/config.json` into `state.config.projectRules`.
 *
 * Re-exported from `@sundial/helpers`, not restated: the kernel already imports
 * types from there (see `Event`/`SanitizedEvent` above), and the structural
 * copy that used to live here had to be edited in step with the original —
 * adding `meetingContains` meant two edits, and a mismatch only surfaced as a
 * build error in a third package. `resolveAttribution` matches these after the
 * certain filesystem locators and before the weak title-folder one.
 */
export type { ProjectRule } from '@sundial/helpers/sundial-config.js';

/**
 * One answered question, kept briefly so it is not asked again. See
 * `KernelState.ownerAsk.recent`. Re-exported from helpers, where the re-ask
 * predicate that reads it lives — the tool and the reducer share both.
 */
export type { AnsweredQuestion as AnsweredOwnerAsk } from '@sundial/helpers/asked.js';


/**
 * The owner-curated work/leisure taxonomy the rules see, copied onto
 * `state.config` every boot. Re-exported from `@sundial/helpers` for the same
 * reason `ProjectRule` is: one shape, one place to change it.
 */
export type { ActivityClass, LeisureRules } from '@sundial/helpers/sundial-config.js';

/**
 * One object, one source of truth, replayable from the log. Copied from
 * docs/design/02-state-and-reducer.md — the full shape exists from Phase 2
 * onward (not grown field-by-field later) because decision #2 (snapshot +
 * tail-replay, docs/design/00-overview.md) requires the *whole* state to
 * snapshot/replay correctly, even though most slices below stay at their
 * zero-value until the rules that populate them land in Phases 4-6.
 *
 * W4 step 13: composed of one slice interface per domain, each beside its own
 * types in `state/<domain>.ts`, with every field's documentation there.
 */
export interface KernelState
  extends ActivitySlices,
    WorkSlices,
    BoardSlices,
    PeopleSlices,
    MemorySlices,
    NoticesSlices,
    ConversationSlices,
    LoopsSlices,
    ReliabilitySlices,
    CalibratedSlices,
    FeedbackSlices,
    ActionsSlices,
    BriefsSlices,
    ConfigSlices {}


export type Rule = (state: KernelState, event: SanitizedEvent) => { state: KernelState; effects: Effect[] };

export interface ReduceResult {
  state: KernelState;
  effects: AttributedEffect[];
}
