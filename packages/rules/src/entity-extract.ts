import { createHash } from 'node:crypto';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import type { EntityKind, FactProvenance, KernelState, Rule } from '@sundial/kernel/types.js';
import { knownProjectNames } from './entity-name-validation.js';
import { closingMomentRow } from './moment-close.js';

/**
 * Attendees minted from one meeting. A calendar invite can carry a whole
 * department; the cursor `contradictionCheck` keeps is 512 entries and evicts
 * unconfirmed ones first, so an all-hands would otherwise flush every in-flight
 * `usesTool`/`relatesToProject` streak. Eight is above the size of a real working
 * meeting and far below a distribution list.
 */
const MAX_ATTENDEE_CANDIDATES = 8;

/** Bounded ring of already-minted meetings. Generous: overlapping meetings and a polling trigger. */
const MAX_RECENT_MEETING_KEYS = 32;

/**
 * The object every attendee fact carries.
 *
 * A constant, and that is the entire point. The removed calendar producer failed
 * three ways on its object — the ambient project pointer (unverifiable), then the
 * meeting title (durable only for recurring titles, one unconfirmable cursor entry
 * per meeting, and a raw unredacted title written into `entity_facts` and
 * `memory_embeddings`). A constant object clears all three at once: one stable
 * cursor key per person, corroborated by the SECOND distinct meeting, and nothing
 * from the calendar reaches core memory except the attendee name, which
 * `sanitizeAtIngest` has already aliased.
 *
 * What the fact asserts is exactly what was observed: this person was in a meeting
 * with the owner. Which meeting, and when, is the fact's own `validFrom` chain —
 * `getEntityFactTimeline` already returns it.
 */
const ATTENDEE_OBJECT = 'owner';

/**
 * Identity of a meeting, for the once-per-meeting guard on `state.memory`.
 *
 * Hashed, and built from the local day plus the sorted attendee names rather than
 * the meeting title, because a calendar title is the one field `sanitizeAtIngest`
 * leaves verbatim. The names are already destined for `entities.canonical_name`, so
 * keying on them adds no surface the fact itself does not.
 */
function meetingAttendeeKey(attendees: string[], ts: string, timezone: string): string {
  const digest = createHash('sha256').update(localDate(ts, timezone)).update('|').update([...attendees].sort().join(',')).digest('hex');
  return digest.slice(0, 16);
}

export interface FactCandidate {
  entityId: string;
  entityKind: EntityKind;
  canonicalName: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceEventId: string;
  /**
   * The fact's real project scope, for `state.memory.factCursor`'s
   * per-project filtering (Working Memory). Heuristic candidates here always
   * have a certain answer: the ambient `state.project.current` they already
   * read to build the candidate. `null` only for facts with no project
   * context at all. The nightly LLM pass (`nightlyFactExtract`) fills this in
   * separately, in the executor, after resolving its own project label.
   */
  projectId: string | null;
  /** See `FactProvenance` — every candidate this rule produces is a heuristic guess, never an owner assertion. */
  provenance: FactProvenance;
}

/**
 * C13 / enhancements/task-tier-on-the-entity-model — task identity from the git
 * branch a moment carried. `BASE_BRANCH` is the long-lived trunk a task is NOT
 * (the C13 probe imports this exact list rather than keeping its own copy, so the
 * measurement cannot drift from the rule); `TICKET` is the strongest task name
 * when present (`BOX-508`); `BRANCH_PREFIX` is the conventional `feat/`, `fix/` …
 * prefix that is noise in a name.
 *
 * `stable` is a release channel, not a piece of work — the same kind of name as
 * `production` and `staging`, which were here from the start. It was found in the
 * reference corpus carrying 21 moments across three separate projects, which is
 * the tell: a task belongs to one project, a channel name is shared vocabulary.
 */
export const BASE_BRANCH = /^(main|master|develop|dev|trunk|release(\/.*)?|staging|production|stable)$/i;
const TICKET = /\b[A-Z]{2,6}-\d{1,6}\b/;
const BRANCH_PREFIX = /^(feat|feature|fix|bugfix|hotfix|chore|refactor|docs|test|style|perf|build|ci|release|wip)\//i;

/**
 * The same shape as `TICKET`, case-insensitive, for the BRANCH only — see
 * `taskIdentity`. Global because the first match is not necessarily the ticket:
 * `fix-2-box-411` has to be able to skip `fix-2` and keep looking.
 */
const TICKET_ANY_CASE = /\b[A-Za-z]{2,6}-\d{1,6}\b/g;

/**
 * Keys the lowercase pass must NOT accept, because lowercased they are ordinary
 * branch vocabulary rather than a project key: `po-fixes-5` is the fifth round of
 * PO fixes, not ticket FIXES-5, and `chore/node-18` is a runtime version.
 *
 * Only ever consulted for the lowercase pass. An uppercase `FIX-4` is still taken
 * verbatim by `TICKET` above, so nothing that resolved to a ticket before this
 * list existed stops resolving now — the list can only decline to WIDEN, never
 * narrow. That asymmetry is deliberate: a wrong entry here costs only the
 * previous behaviour (fall through to the branch name), while a missing entry
 * costs a junk `task` entity AND a junk row in the `commitments` ledger.
 */
const NOT_A_TICKET_KEY = new Set([
  // Iteration and workflow counters.
  'fix', 'fixes', 'bug', 'bugs', 'issue', 'part', 'step', 'phase', 'round', 'take', 'try', 'pass',
  'rev', 'revert', 'patch', 'pr', 'wip', 'draft', 'test', 'tests', 'demo', 'poc', 'spike', 'tmp',
  'temp', 'old', 'new', 'copy', 'v', 'ver', 'day', 'week', 'sprint', 'q', 'no', 'nr', 'top',
  // Runtime and library versions, which share the key-number shape exactly.
  'node', 'php', 'vue', 'react', 'next', 'nuxt', 'ios', 'es', 'http', 'py', 'css', 'html',
  'svelte', 'angular', 'rails', 'java', 'ruby', 'net', 'tls', 'ssl', 'utf', 'sha', 'md',
]);

/** The first ticket in a branch whose key is plausibly a project key, or null. */
function branchTicket(branch: string): string | null {
  // An uppercase id wins outright and is never filtered — the behaviour that
  // already shipped, preserved verbatim.
  const strict = branch.match(TICKET)?.[0];
  if (strict) return strict;

  for (const match of branch.matchAll(TICKET_ANY_CASE)) {
    const key = match[0].slice(0, match[0].indexOf('-'));
    if (!NOT_A_TICKET_KEY.has(key.toLowerCase())) return match[0];
  }
  return null;
}

/**
 * A human-legible task name from a branch (+ the moment's window titles for a
 * ticket the branch itself may not carry), or null when there is nothing usable.
 *
 * Prefers a ticket id — clean, stable, and free of the `/` that `rejectEntityName`
 * refuses as a path fragment. Otherwise the branch, minus its conventional prefix
 * and with slashes collapsed, so `feat/redesign-and-ios` becomes `redesign-and-ios`
 * rather than being rejected outright or minted with a `feat/` that means nothing.
 *
 * The BRANCH is matched case-insensitively but the WINDOW TITLES are not, and the
 * asymmetry is the point rather than an oversight. A branch is a structured name
 * its author chose, so a lowercase segment in it is a plausible ticket:
 * `claude/box-411-po-fixes` and `fix/BOX-411-compact-header` are one piece of
 * work, and until this they minted two `task` entities and two `commitments`
 * rows. A window title is arbitrary prose, where the same widening reads ordinary
 * words as tickets — measured over the reference corpus it invented `CHECK-3` and
 * `FIX-4` out of sentences and `JUNI-2026` out of a Dutch date, and because the
 * first match wins it also DISPLACED a real `PL-448`. Prose keeps the strict
 * pattern for the same reason this rule no longer mints topics from tab titles:
 * a title is evidence, not a name.
 */
export function taskIdentity(branch: string, titles: string): string | null {
  const ticket = branchTicket(branch) ?? titles.match(TICKET)?.[0];
  if (ticket) return ticket.toUpperCase();
  const name = branch.replace(BRANCH_PREFIX, '').replace(/\//g, '-').trim();
  return name || null;
}

/**
 * Whether a derived task name is really a project's own name — the trunk wearing
 * the repository's label, which is a codebase rather than a piece of work.
 *
 * ## Why ANY known project, not just the current one
 *
 * Both call sites used to compare against `state.project.current.name` alone,
 * which only fires when the branch name and the resolved project agree. In the
 * reference corpus they systematically do not: the branch `gnomon` carried 336
 * moments over 6 days and resolved to five DIFFERENT projects — `gnomon-base`,
 * `puzzlebox-studio`, `wcs`, `hosted-money`, `hosted-km-teller` — because the work
 * happened in worktrees and sibling checkouts, never in a directory the resolver
 * calls `gnomon`. The guard therefore never fired once, and `commitmentTrack`
 * ranked that trunk as the single largest carried thread in the ledger.
 *
 * `knownProjectNames` is the registry `contradictionCheck` already uses to refuse
 * a project misread as a person, and it is the right one here for the same
 * reason: it spans the alias map (`WCS`, `gnomon-base` → `gnomon`) as well as the
 * projects detected on disk, so a branch named after a repository is recognised
 * even from a checkout that repository's own resolver never sees. The alias map
 * comes from config and is populated at boot, so this does not depend on the
 * project having been detected earlier in the replay.
 *
 * The accepted cost is a real branch that happens to be named exactly after a
 * known project or alias — it mints no task and opens no thread. That is the same
 * side of the asymmetry `rejectEntityName` documents: a skipped branch costs one
 * name the owner can still state with `gnomon assert`, while a trunk admitted to
 * the ledger presents a codebase as the thing you have been carrying.
 */
export function namesAKnownProject(name: string, state: KernelState): boolean {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return false;
  if (state.project.current && needle === state.project.current.name.trim().toLowerCase()) return true;
  return knownProjectNames(state.config.projectAliases, state.project.known).some((p) => p.trim().toLowerCase() === needle);
}

export function slugifyEntityName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function entityId(kind: FactCandidate['entityKind'], canonicalName: string): string {
  return `${kind}:${slugifyEntityName(canonicalName)}`;
}

/**
 * The entity→path map's key. A project entity is keyed by the slug of the
 * project row's `name` (the name attribution resolved it to, aliases already
 * applied), so `projectEntityId(project.name)` for every `projects` row groups
 * that entity's paths — the executor's belief audit and J2.4 both read it.
 */
export const projectEntityId = (projectName: string): string => entityId('project', projectName);

function candidateEvent(candidate: FactCandidate, ts: string) {
  return {
    type: 'EmitEvent' as const,
    event: {
      id: deriveId(ts, candidate.sourceEventId, 'entity-extract', candidate.entityId, candidate.predicate),
      type: 'entity:fact-candidate',
      ts,
      payload: candidate as unknown as Record<string, unknown>,
    },
  };
}

interface EventDeployPayload {
  projectName?: string | null;
  target?: string | null;
}

/**
 * Proposes candidate core-memory facts (docs/design/05-memory-and-
 * knowledgebase.md §4) — heuristic only, no LLM call, matching the design
 * doc's note that most entity extraction is "regex/heuristic over
 * structured event fields," not something that needs the `extract` LLM
 * budget. Emits `entity:fact-candidate` events for `contradictionCheck`
 * (next rule in the manifest) to decide insert/update/supersede — this rule
 * never emits `UpsertEntityFact` directly, so it never needs to know
 * whether a fact already exists.
 *
 * Scoped to the heuristic facts that reuse already-captured structured fields
 * with a RELIABLE project link: `project → usesTool` (the about-to-close
 * moment's process) and `project → deployedVia` (`event:deploy`).
 *
 * Person candidates ARE minted here as of 2026-08-14, but from the closing
 * moment's `rollup.meetingAttendees` and with a CONSTANT object
 * (`attendedMeetingWith` → `owner`), which is what makes them safe where the
 * removed `calendar:active` path below was not. Each of that path's three
 * failures is structurally impossible for this one: no project is asserted (so
 * no ambient pointer), no meeting title is read (so nothing unredacted reaches
 * `entity_facts` or `memory_embeddings`, and there is one stable cursor entry
 * per person instead of one per meeting), and a `state.memory` guard keys on the
 * day plus attendee set so a meeting spanning four moments corroborates a
 * colleague once rather than four times. Measured on the live corpus before
 * building it: 30 distinct attendee strings, 21 correctly rejected by
 * `rejectEntityName`, 5 surviving with two or more shared meetings —
 * `apps/daemon/src/scripts/measure-person-recovery.ts` is that measurement and
 * is the thing to re-run if this producer's yield is ever questioned.
 *
 * The ORIGINAL heuristic path, kept here as the record of what not to do again:
 * `person` from `calendar:active`.
 * That path stamped every attendee's fact object with `state.project.current`
 * — the ambient pointer, which for a meeting is whichever repository happened
 * to be open while it ran, so the project link was never verifiable
 * (issues/ambient-pointer-survives-in-collaborates-on; 60 demonstrably false
 * rows, plus `person` entities for a meeting room, a distribution list and a
 * redaction hash). Repointing the object at the meeting *title* instead was
 * tried and rejected on three counts: it made the fact durable only for
 * meetings whose exact title recurs; it created an unconfirmable
 * `(attendee × title)` cursor entry per meeting, and `touchFactCursor` evicts
 * unconfirmed entries FIRST, so those would starve legitimate in-flight
 * `usesTool`/`relatesToProject` streaks out of the 512-entry cursor; and
 * worst, a calendar title gets no process-gated redaction (nothing under
 * `payload.event` carries a `processName`, so `sanitizeAtIngest` leaves it
 * verbatim), which would have written raw meeting titles into `entity_facts`
 * AND `memory_embeddings` — from there into `ask`/`search` and LLM prompts.
 * Collaborators came only from the nightly LLM `extract` pass
 * (`nightlyFactExtract`) between that removal and 2026-08-14 — which measured as
 * zero people in fourteen days, because a once-a-night model call is a thin and
 * expensive way to notice who was in a meeting the structured data already names.
 * The attendee producer above is the cheap deterministic path that removal left
 * missing; the nightly pass keeps its own richer collaborator extraction, and the
 * two agree through the same promotion policy rather than through a shared code
 * path. `topic` below is still resolved the old way, for its own reasons.
 *
 * Also deliberately NOT extracted heuristically: `topic` from
 * `document:opened`/`search:performed`. That C2 path (fixes A§4.2) was removed
 * — a browser tab title / search query makes a poor topic *name* (whole
 * slugified titles, typos), and it attributed `relatesToProject` to the same
 * ambient pointer. `tool` extraction stays deferred (no cheap heuristic
 * signal yet).
 *
 * Must run before `momentClose` in `RULE_MANIFEST` — same requirement as
 * `contextSwitch`/`momentAnalysisSchedule`/`anomalyZscore`, since the project-tool
 * candidate reads the about-to-close `state.moment`.
 */
export const entityExtract: Rule = (state, event) => {
  if (event.type === 'window:changed') {
    if (!state.moment) return { state, effects: [] };
    // The moment as it will be WRITTEN, or nothing (see `closingMomentRow`):
    // a B1 title-change append is not a close, and a moment under the write
    // floor never becomes a row. Both used to mint a candidate anyway — the
    // 2026-09-22 audit found 78 of 131 live `usesTool` facts with ZERO
    // sessions of that tool inside the project, because the candidate read
    // the open moment's process and the AMBIENT project pointer, not the row.
    const closed = closingMomentRow(state, event);
    if (!closed) return { state, effects: [] };

    const effects: ReturnType<typeof candidateEvent>[] = [];

    // The row's attribution, not the ambient pointer: the project this moment
    // was actually resolved to (per-window locator, dev-activity fallback,
    // brief-excursion absorption all applied). Its name is what the entity is
    // keyed by (`projectEntityId`), so a fact's entity and the row's
    // `project_id` now agree by construction — the entity→path map.
    const projectId = closed.projectId;
    const projectName = projectId === null ? null : (state.project.known[projectId]?.name ?? (state.project.current?.id === projectId ? state.project.current.name : null));
    if (projectId === null || projectName === null) return { state, effects };
    const project = { id: projectId, name: projectName };
    // E3 (docs/audit/production-proposal-and-enhancements.md, fixes A§6.3)
    // — a hidden process's name is blanked to `[private]`/`[hidden]` by
    // sanitizeAtIngest; writing "project X's primaryTool is [hidden]" into
    // core memory is a wrong, permanent fact, not a redacted one.
    if (isRedactedPlaceholder(closed.processName)) return { state, effects };

    const candidate: FactCandidate = {
      entityId: projectEntityId(project.name),
      entityKind: 'project',
      canonicalName: project.name,
      // `usesTool` (set-valued), not `primaryTool` (functional): a project uses
      // several tools over time (editor, terminal, browser) and should keep
      // them all as coexisting facts, rather than each new tool superseding the
      // last so only the most-recent survives (Phase 5 #3).
      predicate: 'usesTool',
      object: closed.processName,
      confidence: 70,
      sourceEventId: event.id,
      projectId: project.id,
      provenance: 'inference',
    };

    effects.push(candidateEvent(candidate, event.ts));

    // C13 — a `task` entity from the moment's git branch, tied to its project.
    // The tier the memory model was missing: a person's day is projects, but a
    // single piece of work is a branch/ticket that spans hours to weeks. Routed
    // through `contradictionCheck`'s normal 2-observation promotion — a branch
    // recurs across a session, so a real task promotes and one-off noise does not.
    const branch = state.moment.rollup.gitBranch;
    if (branch && !BASE_BRANCH.test(branch)) {
      const taskName = taskIdentity(branch, state.moment.rollup.windowTitles.join(' '));
      // Skip a branch named after a repository — the default-branch inflation the
      // almanac warns about, where the trunk carries a project's own name. Matched
      // against every known project rather than the resolved one; see
      // `namesAKnownProject` for why the narrower test never fired.
      if (taskName && !namesAKnownProject(taskName, state)) {
        effects.push(
          candidateEvent(
            {
              entityId: entityId('task', taskName),
              entityKind: 'task',
              canonicalName: taskName,
              predicate: 'relatesToProject',
              object: project.name,
              confidence: 75,
              sourceEventId: event.id,
              projectId: project.id,
              provenance: 'inference',
            },
            event.ts,
          ),
        );
      }
    }

    return { state, effects };
  }

  // Colleagues, from the calendar event itself rather than from the moment it
  // landed in.
  //
  // The moment rollup was the obvious place and is the wrong one: measured on the
  // live corpus, attendee lists reach 17 `calendar:active` events but only 5
  // moments, so reading the rollup discards two thirds of the supply before the
  // name gate has even seen it. The event is the source; the moment is a lossy
  // copy of it.
  //
  // This is the same TRIGGER as the removed producer and deliberately not the same
  // producer — every one of that path's three recorded failures was about the fact
  // it wrote, not about when it ran. See the header for the full argument: constant
  // object, no project claim, no title read.
  if (event.type === 'calendar:active') {
    const calendarEvent = (event.payload as { event?: { attendees?: unknown; eventId?: unknown } }).event;
    const rawAttendees = Array.isArray(calendarEvent?.attendees) ? calendarEvent.attendees : [];
    const attendees = [...new Set(rawAttendees.filter((a): a is string => typeof a === 'string' && a.trim().length > 0))].slice(0, MAX_ATTENDEE_CANDIDATES);
    if (attendees.length === 0) return { state, effects: [] };

    // `calendar:active` polls: 17 emissions covered 6 distinct meetings on the live
    // corpus, so without a per-meeting guard one meeting would mint the same
    // candidate a dozen times. `eventId` is the calendar's own identity for the
    // occurrence (it carries the recurrence id, so each instance of a standup is
    // distinct), which is a truer key than anything derived from the payload —
    // hashed only to keep `KernelState` small and free of calendar identifiers.
    const eventId = typeof calendarEvent?.eventId === 'string' ? calendarEvent.eventId : null;
    const key = eventId ? createHash('sha256').update(eventId).digest('hex').slice(0, 16) : meetingAttendeeKey(attendees, event.ts, state.config.timezone);
    if (state.memory.recentMeetingKeys.includes(key)) return { state, effects: [] };

    // A ring rather than a single slot: two meetings can overlap, and the poll
    // alternating between them would re-mint both on every tick against a
    // last-one-wins field.
    const recentMeetingKeys = [...state.memory.recentMeetingKeys, key].slice(-MAX_RECENT_MEETING_KEYS);

    return {
      state: { ...state, memory: { ...state.memory, recentMeetingKeys } },
      effects: attendees.map((attendee) =>
        candidateEvent(
          {
            entityId: entityId('person', attendee),
            entityKind: 'person',
            canonicalName: attendee,
            predicate: 'attendedMeetingWith',
            object: ATTENDEE_OBJECT,
            // Below `usesTool`'s 70: a shared invite is weaker evidence of a working
            // relationship than a repeatedly-observed tool, and a fact that promotes
            // on ONE observation should not also seed a heavy posterior — decay is
            // what keeps a one-off contact from reading as settled truth.
            confidence: 60,
            sourceEventId: event.id,
            // No project claim. Asserting one from the ambient pointer is precisely
            // what produced 60 false rows the first time.
            projectId: null,
            provenance: 'inference',
          },
          event.ts,
        ),
      ),
    };
  }

  // `document:opened`/`search:performed` topic extraction removed — see the
  // header. Those events still flow (contextUrlClassify emits them, momentRollup
  // and the day-derivations read them); this rule just no longer mints noisy,
  // ambiently-misattributed `topic` facts from them. Topics come from the
  // nightly LLM `extract` pass instead.

  // Phase 5 #2 — `topic` facts from screen-OCR (opt-in; the sensor only emits
  // `screen:ocr` when `ocr.enabled`). The OCR helper derives clean topic tags
  // from the FOCUSED app's screen, so — unlike a browser tab title — attributing
  // them to that app's project is right. The ambient-misattribution bug the
  // header warns about is avoided by keying off the CURRENT MOMENT's own
  // resolved `projectId` (per-window attribution), NOT `state.project.current`:
  // an unattributed moment (a browser with no project) mints nothing. Routed
  // through `contradictionCheck`'s 2-observation promotion, so one-off OCR noise
  // never becomes a fact.
  // RETIRED 2026-09-07 — two topic/relatesToProject producers used to live here:
  // one from `symbol:edited` (an edited identifier became a topic of the repo),
  // one from `screen:ocr` (a screen-text topic became a topic of the moment's
  // project). Measured over thirty days on the live record they wrote 85 facts
  // — `describe`, `waitCount`, `set_action_done`, `tasksPanel` — and the owner
  // marked none useful. An identifier the owner edits is evidence about a
  // MOMENT (and `momentRollup` keeps it there); as a belief about the project it
  // is noise the graph then has to be read around. Topic facts now come only
  // from the nightly LLM pass, which sees a whole day and is told what a topic
  // is not (see `entity-name-validation.ts` `ACTIVITY_CLASS_TOPICS`).
  //
  // Symbols stay in the log and in the moment for `gnomon_code_activity`; nothing
  // about capture changed, only what becomes knowledge.

  // C2 — a deploy is a strong, unambiguous signal (confidence 80): the
  // project really was deployed via this target, not just associated with
  // it in passing the way a search query is.
  if (event.type === 'event:deploy') {
    const payload = event.payload as EventDeployPayload;
    const projectName = payload.projectName ?? state.project.current?.name;
    const target = payload.target;
    if (!projectName || !target) return { state, effects: [] };

    return {
      state,
      effects: [
        candidateEvent(
          {
            entityId: entityId('project', projectName),
            entityKind: 'project',
            canonicalName: projectName,
            predicate: 'deployedVia',
            object: target,
            confidence: 80,
            sourceEventId: event.id,
            projectId: state.project.current?.id ?? null,
            provenance: 'inference',
          },
          event.ts,
        ),
      ],
    };
  }

  return { state, effects: [] };
};
