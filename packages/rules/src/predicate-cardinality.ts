/**
 * Phase 2a (docs/design/08-endogenous-life.md §5.4, decision D9) — predicate
 * cardinality governs whether a competing object is COMPETITIVE or INDEPENDENT:
 *
 *  - `functional`: mutually exclusive (a project has one `primaryTool`), so a
 *    new value is evidence against the old and eventually supersedes it.
 *  - `set`: coexisting (a person `collaboratesOn` many projects), so a new
 *    value is an ADDITIONAL fact, never superseding a sibling.
 *
 * `contradictionCheck` keys its fact cursor by cardinality: functional gets one
 * slot per (entity, predicate) — supersession; set-valued gets a slot per
 * (entity, predicate, object) — each value promoted on its own recurrence and
 * kept alongside the others. This fixes the pre-Phase-2a bug where every
 * predicate was treated as functional, so set-valued ones like `collaboratesOn`
 * wrongly superseded each other.
 *
 * Heuristic: functional iff the predicate names a single "primary/current/main"
 * attribute; everything else is set-valued (the common case for human
 * knowledge). Explicit overrides win; freeform LLM-extracted predicates fall
 * through to the heuristic.
 */
export type Cardinality = 'functional' | 'set';

const EXPLICIT: Record<string, Cardinality> = {
  primaryTool: 'functional',
  primaryEditor: 'functional',
  currentEmployer: 'functional',
  currentRole: 'functional',
  collaboratesOn: 'set',
  attendedMeetingWith: 'set',
  relatesToProject: 'set',
  deployedVia: 'set',
  usesTool: 'set',
  worksOn: 'set',
  worksWith: 'set',
  // Owner-profile predicates: one value at a time. Measured on the live record
  // 2026-09-04 — the owner corrected `asleepBy` and `dayBeginsAt` in chat and
  // BOTH values stayed current, because these fell through to the set-valued
  // default and the correction was filed as an additional fact. A profile
  // attribute is functional by nature: a person has one wake time, one current
  // occupation, one place they are staying tonight.
  wakeAt: 'functional',
  asleepBy: 'functional',
  dayBeginsAt: 'functional',
  dayEndsAt: 'functional',
  workSchedule: 'functional',
  occupation: 'functional',
  stayingAt: 'functional',
  visitingToday: 'functional',
  worksOnDevice: 'functional',
  livesIn: 'functional',
  timezone: 'functional',
  // A goal's state and deadline; a person's readable name for an alias.
  status: 'functional',
  targetDate: 'functional',
  knownAs: 'functional',
  // A goal's checklist is ONE value: the whole list, rewritten each time the
  // owner ticks anything. Set-valued (the default) would file every edit as an
  // additional fact and leave five versions of the same plan all current at
  // once, which is the bug `asleepBy` hit and the reason that block exists.
  // The superseded versions stay in the timeline, so the plan keeps its history
  // for free.
  steps: 'functional',
  partOf: 'functional',
};

/**
 * lane Q: one entity kind where a set-valued predicate has one value. A task
 * (a ticket, a branch) belongs to one project; set-valued, a stray window
 * title filed a second and a third, and six live tasks held 2 to 5 current
 * `relatesToProject` facts at once.
 */
const FUNCTIONAL_FOR_KIND: Record<string, Record<string, true>> = { task: { relatesToProject: true } };

export function predicateCardinality(predicate: string, entityKind?: string): Cardinality {
  if (entityKind !== undefined && FUNCTIONAL_FOR_KIND[entityKind]?.[predicate]) return 'functional';
  const explicit = EXPLICIT[predicate];
  if (explicit) return explicit;
  return /^(primary|current|main)/i.test(predicate) ? 'functional' : 'set';
}
