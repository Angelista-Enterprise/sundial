// What the owner said they want (goal entities): status, why, steps, the work that moved each and how long it has been quiet.
import { entitySlug } from '../shell/entity-id.js'
import { foldDuplicates, groupByParent, lastMoved, linkMovement, parseSteps, QUIET_AFTER_DAYS, quietDays, splitStatus, stepProgress, stepsFromCommits } from '../shell/goals.js'
import { getAllEntities, getCurrentEntityFacts, getEntityFactTimeline, getOpenCommitments, getSignalsInRange } from '@sundial/db/index.js'

export async function readGoals({ now }) {
  // Pinned to the whole record, and the card says so on its face. A
  // goal set in July is not less true in a seven-day span, and the
  // board's span would empty this card every morning.
  const [entities, commitments, commitSignals] = await Promise.all([
    getAllEntities(),
    getOpenCommitments(50),
    // Sixty days of commit subjects, for the `[n/7]` progress tokens the
    // owner puts in them. `getCommitsBetween` drops the subject line, so
    // this reads the stream itself.
    getSignalsInRange(new Date(now - 60 * 86_400_000).toISOString(), new Date(now + 86_400_000).toISOString(), 4000, ['git']),
  ])
  const commits = commitSignals.filter((s) => s.eventType === 'commit').map((s) => s.data)
  const rows = await Promise.all(
    entities
      .filter((entity) => entity.kind === 'goal')
      .map(async (entity) => {
        // The whole timeline, not only what is believed now: a goal's
        // life is every time the owner said something about it, and a
        // superseded status is exactly such a saying.
        const [facts, timeline] = await Promise.all([getCurrentEntityFacts(entity.id), getEntityFactTimeline(entity.id)])
        const pick = (predicate) => facts.find((fact) => fact.predicate === predicate)
        const status = pick('status')
        const { state, why } = splitStatus(status?.object ?? 'open')
        // A goal captured in a conversation has no `status` at all — it
        // arrives as `plansTo` or `goal`, which IS its why. Reading
        // those is what makes a goal said in chat land as a row here.
        const said = pick('why') ?? pick('plansTo') ?? pick('goal')
        const anchor = status ?? said
        return {
          id: entity.id,
          goal: entity.canonicalName,
          status: status?.object ?? null,
          state,
          why: why || said?.object || null,
          targetDate: pick('targetDate')?.object ?? null,
          stored: pick('steps')?.object ?? null,
          partOf: pick('partOf') ? `goal:${entitySlug(pick('partOf').object)}` : null,
          since: anchor?.validFrom ?? null,
          saidBy: anchor?.provenance === 'assertion' ? 'owner' : (anchor?.provenance ?? null),
          saidAt: timeline.map((fact) => fact.validFrom).filter(Boolean),
        }
      }),
  )
  const goals = foldDuplicates(rows).map(({ stored, saidAt, ...row }) => {
    const movement = linkMovement(row.goal, commitments, commits)
    const quiet = quietDays(row.since, movement, now)
    // The owner's own list if they have written one; otherwise the
    // `[n/7]` tokens read back as the checklist they always were. The
    // second is DERIVED and says so, because the owner has not agreed
    // to it and the first edit replaces it wholesale.
    const own = stored === null ? [] : parseSteps(stored)
    const steps = own.length ? own : stepsFromCommits(movement?.log ?? [])
    return {
      ...row,
      // What this goal's own trail is drawn from. Two kinds, because
      // they answer different questions: a `said` is the owner giving
      // it attention, a `did` is work landing on the branch it names,
      // and a goal can have plenty of one and none of the other.
      life: [
        ...(saidAt ?? []).map((at) => ({ at, kind: 'said' })),
        ...(movement?.log ?? []).map((c) => ({ at: c.timestamp, kind: 'did' })).filter((e) => e.at),
      ],
      steps,
      stepsAreDerived: own.length === 0 && steps.length > 0,
      progress: stepProgress(steps),
      movement,
      movedAt: lastMoved(row.since, movement),
      quietDays: quiet,
      // Only a goal still in play can go quiet. A dropped one is not
      // neglected, it is decided.
      stale: quiet !== null && quiet >= QUIET_AFTER_DAYS && ['open', 'doing', 'waiting', 'blocked'].includes(row.state),
    }
  })
  return { goals: groupByParent(goals), quietAfterDays: QUIET_AFTER_DAYS }
}
