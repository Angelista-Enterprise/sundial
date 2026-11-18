// What each capability may do alone, the numbers that earn it, what else the record holds
// about it, and the latest things Gnomon said that wait for the owner's verdict (W5 step 10).
import { getAllSignalsInRange } from '@sundial/db/index.js'
import { awaitingVerdict, capabilities, earnedBy, evidenceOf, levelOf } from '@sundial/kernel/autonomy.js'
import { foldedScorecard } from '@sundial/kernel/read/scorecard.js'

export async function readAutonomy({ state, now }) {
  const level = (cap) => state?.autonomy?.levels?.[cap] ?? { level: levelOf(state, cap), earned: false, since: null }
  // A verdict is the only thing that moves a row: the latest unjudged deliveries, in the words Gnomon said them.
  const waiting = awaitingVerdict(state)
  const said = new Map()
  if (waiting.length > 0) {
    const from = waiting.reduce((a, w) => (w.at < a ? w.at : a), waiting[0].at)
    for (const r of await getAllSignalsInRange(new Date(Date.parse(from) - 3_600_000).toISOString(), new Date(now).toISOString(), ['notice:candidate'])) if (typeof r.data.key === 'string' && typeof r.data.observation === 'string') said.set(r.data.key, r.data.observation)
  }
  return {
    capabilities: capabilities(state).map((capability) => ({ capability, ...level(capability), ...earnedBy(state, capability), evidence: evidenceOf(state, capability, now), granted: state?.autonomy?.granted?.[capability] ?? null, lowered: state?.autonomy?.lowered?.[capability] ?? null })),
    toJudge: waiting.map((w) => ({ ...w, text: (said.get(w.key) ?? '').slice(0, 240) })).filter((w) => w.text !== ''),
    scorecard: foldedScorecard(state, now),
  }
}
