// The effect journal, whole (`tracePanel`): the census of `applied_effects` in grouped scans, and the chain behind one event or moment.
import { SENSORS } from '../shell/sensors.js'
import { momentIdIn, openDoors } from '../shell/trace.js'
import { EFFECT_FAMILY } from '@sundial/kernel/effect-delivery.js'
import { getEffectJournalCensus, getEffectsForEvents, getMomentsByIds, getRecentRuleTriggers } from '@sundial/db/index.js'

export async function readTrace({ url }) {
  const limit = Math.min(200, Math.max(20, Number(url.searchParams.get('limit')) || 40))
  const [census, recent] = await Promise.all([getEffectJournalCensus(), getRecentRuleTriggers(limit)])
  const siblings = await getEffectsForEvents([...new Set(recent.map((row) => row.eventId))])

  // K0.5 — one hop further down the chain. An `EmitEvent` row now carries the
  // id of the event it raised, so the fold can show what that event went on
  // to cause rather than stopping at "it told itself something". Only the
  // children of the rows on screen are fetched, and only one level: a full
  // tree would be a fan-out of a fan-out for a list of forty.
  const emitted = [...new Set([...recent, ...siblings].map((row) => row.emittedEventId).filter(Boolean))]
  const children = await getEffectsForEvents(emitted)

  // A door is only a door if the thing behind it exists, and on this card
  // the newest rows are the likeliest to be shut. `Judge … moment=<id>` is
  // written when the judge is ASKED, which happens before the moment is
  // closed and written — 13 of the record's 635 of them name a moment that
  // is not in `moments` yet, and they are exactly the recent ones a
  // "last 40" list shows. Clicking one opened nothing and said nothing,
  // which is the worst kind of dead link. Asked rather than assumed.
  const named = [...new Set([...recent, ...siblings].map((row) => momentIdIn(row.effectDetail)).filter(Boolean))]
  const open = new Set((await getMomentsByIds(named)).map((moment) => moment.id))

  // What set an event off: the world, or Gnomon itself. Read off the Trust
  // card's own sensor roster — the one `sensors.test.js` holds against
  // `packages/sensors/src` — rather than off a second hand-written list of
  // event types, which would agree on the day it was written and drift.
  const sensorEvents = new Set(SENSORS.flatMap((sensor) => sensor.events))
  const origin = { world: { events: 0, effects: 0 }, gnomon: { events: 0, effects: 0 } }
  const byEventType = census.byEventType.map((row) => {
    const from = sensorEvents.has(row.eventType) ? 'world' : 'gnomon'
    origin[from].events += row.events
    origin[from].effects += row.effects
    return { ...row, origin: from }
  })

  const families = new Map()
  for (const row of census.byKind) {
    const family = EFFECT_FAMILY[row.kind] ?? 'record'
    const seat = families.get(family) ?? { family, count: 0, kinds: [] }
    seat.count += row.count
    seat.kinds.push(row)
    families.set(family, seat)
  }

  return {
    span: { firstAt: census.firstAt, lastAt: census.lastAt },
    total: census.total,
    events: census.events,
    byStatus: census.byStatus,
    failed: census.failed,
    emitEdges: census.emitEdges,
    families: ['record', 'itself', 'think', 'you'].map((family) => families.get(family) ?? { family, count: 0, kinds: [] }),
    byRule: census.byRule.map((row) => ({ ...row, kinds: (row.kinds ?? '').split(',').filter(Boolean).sort() })),
    byEventType,
    origin,
    byDay: census.byDay,
    recent: openDoors(recent, open).map((row) => ({ ...row, failures: row.failures ?? 0, lastError: row.lastError ?? null, emittedEventId: row.emittedEventId ?? null })),
    // Keyed by the CHILD event's id, so a row looks its own emission up.
    children: Object.fromEntries(
      emitted.map((id) => [
        id,
        openDoors(children.filter((row) => row.eventId === id), open).map((row) => ({ ruleName: row.ruleName, effectDetail: row.effectDetail, moment: row.moment })),
      ]),
    ),
    siblings: Object.fromEntries(
      [...new Set(recent.map((row) => row.eventId))].map((id) => [
        id,
        openDoors(siblings.filter((row) => row.eventId === id), open).map((row) => ({ effectIndex: row.effectIndex, ruleName: row.ruleName, effectDetail: row.effectDetail, moment: row.moment, emittedEventId: row.emittedEventId ?? null })),
      ]),
    ),
  }
}
