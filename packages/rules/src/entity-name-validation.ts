import type { FactProvenance } from '@sundial/kernel/types.js';
import { isMeetingRoom } from '@sundial/helpers/person-name.js';

/**
 * Whether a candidate's `canonicalName` is shaped like a name at all.
 *
 * ## Why this exists, and why it lives on the CONSUMER side
 *
 * An `entity:fact-candidate` event is permanent. The entities table can be
 * purged and a defective producer can be deleted from the codebase, but the
 * candidate events that producer already emitted stay in the append-only log
 * forever — and every replay folds them again. That is exactly what happened:
 * false collaboration facts and non-person entities were purged on 2026-07-28
 * and the ambient-pointer producer removed, then the first full recompute
 * (`scripts/recompute-derived.ts`) resurrected all of it from the 17,234
 * historical candidate events, including a bare `)` as a topic, whole window
 * titles as topics, a meeting room (`HQ-2-14 (8)`) as a person, and the
 * redaction alias `person-0a1b2c3d4e` as a person.
 *
 * So "purge the rows, fix the producer" is not a durable remedy in an
 * event-sourced system. The only remedy that survives replay is a gate on the
 * consuming side, which is why this is applied in `contradictionCheck` rather
 * than (only) in `entityExtract`. Fixing the producer stops new junk; gating the
 * consumer stops old junk, permanently, without rewriting history.
 *
 * ## Why it leans strict
 *
 * The two failure directions are not symmetric. A false REJECT costs one
 * candidate that will be re-observed on the next sighting, or can be stated
 * outright with `gnomon_assert`. A false ACCEPT writes a durable belief into core
 * memory that decays but never disappears, and that an LLM will later read back
 * as fact. Given that asymmetry the heuristics below err toward rejecting, which
 * is the same reasoning `decisions/fact-lifecycle-policy` applies to promotion
 * thresholds.
 *
 * ## What it deliberately does NOT try to do
 *
 * It does not judge meaning. `puzzlebox-team` is not a person and this cannot
 * tell so — distinguishing a team name from a personal name needs knowledge this
 * function does not have, and guessing would reject real names like
 * `Jean-Luc Picard`. Only SHAPE is checked. Semantic misclassification is a
 * separate problem, correctable by the owner through `gnomon_assert`.
 */

/** Longer than any real person, project, tool or topic name; short enough to exclude window titles. */
const MAX_NAME_LENGTH = 48;

/** A topic or tool is a label, not a sentence. Search queries like "stop sleeping when lid is closed mac" land here. */
const MAX_LABEL_WORDS = 4;

/** `sanitizeAtIngest`'s email alias. A pseudonym is not a name, and it must never become one. */
/** The shape `sanitizeAtIngest` gives an email-only attendee. Exported so a reader can tell an alias from a name. */
export const REDACTION_ALIAS = /^person-[0-9a-f]{6,}$/i;

/** Any window title that made it in as a name: `… - Google Chrome`, `… · Pull Request #143 …`, `(https://…)`. */
const TITLE_MARKERS = [' · ', '://', '(http'];

export interface EntityNameRejection {
  reason: string;
}

/**
 * The two things a name has to be checked against that cannot be derived from the
 * name itself. Both come straight off `KernelState` — `config.ownerAliases` and
 * the project registry — so a rule reading them stays a pure `(state, event)`
 * function with no external lookup.
 */
export interface EntityNameContext {
  /** `config.ownerAliases` — every name the owner appears under in their own data. */
  ownerAliases?: string[];
  /** Known project names and aliases, for catching a project misread as a person. */
  projectNames?: string[];
}

function matchesAny(name: string, candidates: string[] | undefined): boolean {
  if (!candidates || candidates.length === 0) return false;
  const needle = name.trim().toLowerCase();
  return candidates.some((c) => c.trim().toLowerCase() === needle);
}

/**
 * Context rejects — the owner recorded as a third party, and a project recorded as
 * a person. Both are wrong for a reason no amount of string inspection can see,
 * and both were resurrected by the first full recompute.
 *
 * The owner is never a `person` entity. Gnomon's whole model makes the owner the
 * implicit subject of the knowledgebase, so entities are other people, projects
 * and tools; a `person:<owner>` row means the system has started modelling its
 * own user as one of their colleagues. Concretely it produced five
 * `sam collaboratesOn …` facts — the owner collaborating with themselves,
 * which is the exact failure `ownerAliases` exists to prevent (CLAUDE.md). That
 * filter previously lived only in the calendar producer, so removing the producer
 * left the historical candidates unguarded; checking here covers replay too.
 *
 * A project misread as a person came from the same defect: `puzzlebox-team` is a
 * key in `projectAliases`, which is how we know it names a project, and it was
 * promoted as a colleague. This is the shape check's documented blind spot —
 * telling a team name from a personal name needs knowledge, and the project
 * registry IS that knowledge.
 *
 * Applied to assertions as well. If the owner genuinely wants to record something
 * about themselves it belongs on a different kind than `person`, and an assertion
 * naming a known project as a person is a mistake worth surfacing rather than
 * honouring.
 */
function contextRejection(kind: string, name: string, context: EntityNameContext | undefined): EntityNameRejection | null {
  // The one entity of kind `owner` is named by an owner alias and nothing else:
  // a producer that mints "owner:someone-else" has misread who is speaking.
  if (kind === 'owner') {
    if (!context?.ownerAliases || context.ownerAliases.length === 0) return { reason: 'no ownerAliases configured, so nothing can be the owner' };
    return matchesAny(name, context.ownerAliases) ? null : { reason: 'not an owner alias' };
  }
  if (!context) return null;
  // W1 (2026-09-23) — on EVERY kind, not only `person`. The check used to stop at
  // `person`, so the owner's own words landed on `topic:Pat` instead — nine
  // assertions (bedtime, wake time, occupation) beside `owner:pat`'s 28, and
  // a reader of either saw half of what the owner had said about themselves.
  if (matchesAny(name, context.ownerAliases)) return { reason: `the owner is not a ${kind} entity` };
  if (kind === 'person' && matchesAny(name, context.projectNames)) return { reason: 'names a known project, not a person' };
  return null;
}

/**
 * Hard rejects — applied to EVERY candidate regardless of provenance, including
 * an owner assertion. These are not matters of style: an empty name and a name
 * with no letters or digits in it are incapable of identifying anything, so
 * honouring them would create an entity nobody can refer to.
 */
/**
 * Words that name a KIND of activity, not a subject. The nightly pass was told
 * to pair every topic with its project, and obliged with "email relatesToProject
 * hub", "terminal relatesToProject puzzlebox-studio", "chat", "code", "notes",
 * "browser" — twenty-seven such facts in a month, none of them knowledge. A
 * topic is what the work was about; these are what the work was done in.
 */
export const ACTIVITY_CLASS_TOPICS = new Set([
  'email', 'mail', 'chat', 'ai-chat', 'ai chat', 'messaging', 'browser', 'browsing', 'browse', 'web', 'code', 'coding', 'programming',
  'terminal', 'shell', 'notes', 'note-taking', 'writing', 'reading', 'meeting', 'meetings', 'calendar', 'video call', 'call',
  'jira', 'github', 'gitlab', 'slack', 'whatsapp', 'discord', 'teams', 'zoom', 'notion', 'obsidian', 'figma', 'music', 'video',
  'social media', 'search', 'searching', 'documentation', 'docs', 'review', 'code review', 'testing', 'debugging', 'planning',
  'work', 'focus', 'leisure', 'setup', 'switch', 'break', 'admin',
]);

function hardRejection(_kind: string, name: string): EntityNameRejection | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { reason: 'empty' };
  if (!/[a-z0-9]/i.test(trimmed)) return { reason: 'no alphanumeric characters' };
  // A `person-<hash>` alias is admitted as a person (decision 2026-09-04, closing
  // the attendees-with-no-display-name issue (now `decisions/derive-colleague-names-from-address`) with its option
  // 2): `sanitizeAtIngest` derives it deterministically from the address so the
  // same invitee is one entity across every meeting, and a stable, unreadable
  // name still accumulates `collaboratesOn` / `attendedMeetingWith` evidence. A
  // reader shows it as the alias until the owner names them — `knownAs`, via
  // gnomon_assert or the conversation pass ("person-32d7 is Sam from Acme").
  return null;
}

/**
 * Shape heuristics — skipped for `assertion` provenance.
 *
 * When the owner states a fact themselves they have typed the name deliberately,
 * and second-guessing their formatting would make the one authoritative input
 * path the most restricted one. The hard rejects above still apply to them.
 */
function shapeRejection(kind: string, name: string): EntityNameRejection | null {
  // An activity class is what the work was done IN, not what it was about.
  // Twenty-seven such facts in a month, none of them knowledge. It sits in the
  // SHAPE tier, not the hard one: the hard tier runs before the `assertion`
  // bypass, and putting it there silently discarded the owner's own
  // `topic: "code review"` while telling them it was recorded.
  if (kind === 'topic' && ACTIVITY_CLASS_TOPICS.has(name.trim().toLowerCase())) return { reason: 'an activity class, not a subject' };

  const trimmed = name.trim();

  if (trimmed.length > MAX_NAME_LENGTH) return { reason: `longer than ${MAX_NAME_LENGTH} characters` };

  // Catches `)`, `): polish popup intro…`, `] BE/FE: Paywall…`, `/changes)` — a
  // real name starts with the name.
  if (!/^[a-z0-9]/i.test(trimmed)) return { reason: 'starts with punctuation' };

  for (const marker of TITLE_MARKERS) {
    if (trimmed.includes(marker)) return { reason: `contains "${marker}" — looks like a window title or URL` };
  }

  // A path separator, which catches URL and path fragments that carry no other
  // tell: `localhost:3000artikelen/instrument-gezocht` is one word, starts with a
  // letter and has balanced brackets, so every other rule here passes it.
  //
  // The accepted cost is a genuine `CI/CD`- or `TCP/IP`-shaped label being
  // rejected. That is the right side of the asymmetry — a rejected label returns
  // on the next sighting or can be stated with `gnomon_assert`, which bypasses
  // this rule, whereas an accepted URL fragment is a permanent entity.
  if (trimmed.includes('/')) return { reason: 'contains a path separator — looks like a URL or path fragment' };

  // More closers than openers: `featured-article-overview-layout)`. A balanced
  // `(12)` is left to the person-specific rule below.
  const openers = (trimmed.match(/[([]/g) ?? []).length;
  const closers = (trimmed.match(/[)\]]/g) ?? []).length;
  if (closers > openers) return { reason: 'unbalanced bracket — looks like a fragment' };

  // A meeting room on an attendee list (`HQ-2-14 (8)`, `HQ-2-14`): the one
  // room test every reader shares.
  if (kind === 'person' && isMeetingRoom(trimmed)) return { reason: 'a meeting room, not a person' };

  // A person's canonical name does not carry parenthetical qualifiers either.
  if (kind === 'person' && /[()[\]]/.test(trimmed)) return { reason: 'person name contains brackets' };

  if (kind === 'topic' || kind === 'tool') {
    const words = trimmed.split(/\s+/).length;
    if (words > MAX_LABEL_WORDS) return { reason: `${words} words — a ${kind} is a label, not a phrase` };
  }

  return null;
}

/**
 * `null` when the name may be promoted; a rejection with a human-readable reason
 * otherwise. The reason is returned rather than logged so the caller decides
 * whether anyone hears about it — a rule cannot perform I/O.
 */
export function rejectEntityName(kind: string, name: string, provenance: FactProvenance, context?: EntityNameContext): EntityNameRejection | null {
  const hard = hardRejection(kind, name);
  if (hard) return hard;
  const contextual = contextRejection(kind, name, context);
  if (contextual) return contextual;
  if (provenance === 'assertion') return null;
  return shapeRejection(kind, name) ?? inferredShapeRejection(kind, name, context);
}

/**
 * W3 (2026-09-23) — two shapes the card audit found, refused only for what
 * Gnomon INFERRED; the owner can still assert either.
 *
 * A tool named for a part of Gnomon — `Gnomon board`, `gnomon window sensor` —
 * is Gnomon describing its own machinery as something the owner uses. `Gnomon`
 * alone is kept: the owner does use it.
 *
 * A project that is not a known project — `Board Audits`, `lets get sanity
 * certified`, `Daily client sprint`, all minted by the conversation pass from a
 * sentence in a chat. A project here is a repository the owner works in, so the
 * registry of detected projects and the alias map ARE the list; a phrase in a
 * conversation that is not on it is a topic at most. Only applied when the
 * caller passed that list — a producer with no project context is not guessed at.
 */
function inferredShapeRejection(kind: string, name: string, context: EntityNameContext | undefined): EntityNameRejection | null {
  const lower = name.trim().toLowerCase();
  if (kind === 'tool' && lower !== 'gnomon' && /\bgnomon\b/.test(lower)) return { reason: 'a part of Gnomon, not a tool the owner uses' };
  if (kind === 'project' && context?.projectNames && context.projectNames.length > 0 && !matchesAny(name, context.projectNames)) return { reason: 'not a known project' };
  return null;
}

/**
 * The owner's one canonical name: `ownerAliases[0]`, so every alias the owner
 * appears under lands on the same `owner:<slug>` entity. Returns null when the
 * name is not an owner alias (or no aliases are configured), which a producer
 * reads as "this is somebody else".
 */
export function canonicalOwnerName(name: string, ownerAliases: string[] | undefined): string | null {
  if (!ownerAliases || ownerAliases.length === 0) return null;
  return matchesAny(name, ownerAliases) ? ownerAliases[0] : null;
}

/** Convenience for call sites that only need the boolean. */
export function isPlausibleEntityName(kind: string, name: string, provenance: FactProvenance, context?: EntityNameContext): boolean {
  return rejectEntityName(kind, name, provenance, context) === null;
}

/**
 * Every name that identifies a project, gathered from the two places a rule can
 * reach: the alias map's keys AND values (a key is the wrong name someone used, a
 * value is the canonical one — either appearing as a "person" is the same defect)
 * and the registry of projects actually detected on disk.
 */
export function knownProjectNames(projectAliases: Record<string, string>, known: Record<string, { name: string }>): string[] {
  return [...Object.keys(projectAliases), ...Object.values(projectAliases), ...Object.values(known).map((p) => p.name)];
}
