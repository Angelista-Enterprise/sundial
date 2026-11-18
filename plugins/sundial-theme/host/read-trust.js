// Trust — is the machine working: how long the daemon watched (the honest denominator), the pipeline's coverage, embeddings, sensor freshness, redaction, retractions, the notices' precision per kind and the judge's record.
import { judgementTrust, noticesByKind, perception } from '@sundial/kernel/read/trust.js'
import { readKnockStats } from '@sundial/kernel/read/knock-stats.js'
import { readOfferStats } from '@sundial/kernel/read/offer-stats.js'
import { readSummonStats } from '@sundial/kernel/read/summon-stats.js'
import { readStuckStats } from '@sundial/kernel/read/stuck-stats.js'
import { readVoiceStats } from '@sundial/kernel/read/voice-stats.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { localDate } from '@sundial/helpers/local-day.js'
import { getEmbeddingHealth, getObservedHours, getPipelineCoverage, getRedactionHealth, getSignalFreshness, listRetractedFacts } from '@sundial/db/index.js'

const MINUTE = 60_000

export async function readTrust({ state, now, questions }) {
  const timeZone = loadSundialConfig().timezone
  const since = new Date(now - 24 * 60 * MINUTE).toISOString()
  // `getMemoryTierCounts` is GONE from this card, per the audit: signals,
  // moments, entries, entities and facts are VOLUME, and volume belongs on
  // the ledger beside what the thinking cost (L9). A trust surface answers
  // how much of the owner's life was seen and what became of it; how many
  // rows that filled is a different question and was the loudest panel here.
  const [pipeline, embeddings, freshness, redaction, retracted, observedDays, knocks, summons, stuck, voice, offers] = await Promise.all([
    getPipelineCoverage(),
    getEmbeddingHealth(),
    getSignalFreshness(),
    getRedactionHealth(since, 24),
    listRetractedFacts(40),
    // The whole record, from the log, not the fifteen days the kernel's
    // bounded mirror keeps — see `getObservedHours` for why the surface and
    // the fold read different sources for the same measure.
    getObservedHours(),
    readKnockStats({ now }),
    readSummonStats({ now }),
    readStuckStats({ now }),
    readVoiceStats({ now }),
    readOfferStats({ now }),
  ])

  // UTC hours folded into LOCAL days here rather than in SQL, where the
  // shift would have to be a constant and would be an hour wrong on one side
  // of every daylight saving change.
  const perDay = new Map()
  for (const { hour, share } of observedDays) perDay.set(localDate(`${hour}:00:00.000Z`, timeZone), (perDay.get(localDate(`${hour}:00:00.000Z`, timeZone)) ?? 0) + share)
  const observed = [...perDay.entries()].map(([date, hours]) => ({ date, hours: Math.round(hours * 100) / 100 })).sort((a, b) => (a.date < b.date ? -1 : 1))
  // Quietest first: a sensor that stopped is the only thing this list is for,
  // and one that fired a second ago says nothing worth ranking.
  const sensors = freshness
    .map((row) => ({
      stream: `${row.signalType}:${row.eventType}`,
      lastCapturedAt: row.lastCapturedAt,
      quietMin: Math.max(0, Math.round((now - Date.parse(row.lastCapturedAt)) / MINUTE)),
    }))
    .sort((a, b) => b.quietMin - a.quietMin)

  const config = loadSundialConfig()
  return {
    generatedAt: new Date(now).toISOString(),
    timeZone,
    // Calendar day, deliberately: the Trust card's coverage calendar is about
    // dates, and K0.6's waking day belongs only to the Rhythm arcs.
    today: localDate(new Date(now).toISOString(), timeZone),
    pipeline,
    embeddings,
    // The owner's taps by verdict (J0.8) — the tally every learned
    // threshold will hang off, read from the fold rather than the log.
    feedback: { countsByVerdict: state?.feedback?.countsByVerdict ?? {}, lastVerdictAt: state?.feedback?.lastVerdictAt ?? null },
    // N1 / W4 step 8: of the notices judged in thirty days, how many were worth hearing — per kind, with n, folded.
    noticePrecision: noticesByKind(state, now),
    // Plan 15 step 1: what became of each knock, per kind, from the log.
    knocks,
    // Plan 15 step 2: the first move after each summon, and how often the guess held, from the log.
    summons,
    // Plan 15 4.3: each stuck sign, its notices and the verdicts on them.
    stuck,
    // Plan 15 step 3: time to the nod and to the first spoken word, p50 and p90 with n.
    voice,
    // Set 2 R3: offers pressed over offers shown, the slip and the knock apart, from the log.
    offers,
    // J2.3: the belief audit — when it last ran, and every retraction with
    // the answers behind it (null when an owner tap closed the fact).
    beliefAudit: { lastRunAt: state?.memory?.lastBeliefAuditAt ?? null, retracted },
    // J2.4: names that may be one thing — the exact leg's same-name roots
    // and the judge's answers at or above its threshold. Suggestions only;
    // the owner's projectAliases is what merges.
    aliasAlignment: { lastRunAt: state?.memory?.lastAliasAlignmentAt ?? null, suggestions: state?.memory?.aliasSuggestions ?? [] },
    // J2.1's gate: the owner-state filter scored against the owner's own taps,
    // and how many days of taps there are toward the fourteen the gate wants.
    // J2.1's gate, and J5.4 / J5.2's self-evaluation (W4 step 8: `read/trust.ts`).
    perception: perception(state),
    judgement: judgementTrust(state, now, questions),
    redaction: {
      windowHours: redaction.windowHours,
      totalRedactions: redaction.totalRedactions,
      redactableEvents: redaction.redactableEvents,
      properties: redaction.properties,
      bySource: redaction.bySource.slice(0, 8),
    },
    sensors,
    observed,
    // Which opt-in sensors are actually switched on. A clipboard poller and
    // a screen reader running are exactly the facts a trust surface owes the
    // owner, and nothing on this board said either.
    optIn: {
      clipboardEnabled: Boolean(config.clipboardEnabled),
      ocr: Boolean(config.ocr?.enabled),
      vision: Boolean(config.ocr?.vision?.enabled),
      jevFrames: Boolean(config.ocr?.enabled && config.ocr?.jev?.frames === true),
      vault: typeof config.vault === 'string' && config.vault !== '',
      mail: config.privacy?.mail === true,
      messages: config.privacy?.messages === true,
    },
    // What leaves this Mac for a picture, beyond the model routes the ledger shows: one plain line each.
    outbound: [{ name: 'Atlas', does: 'a few search words from an atlas ask go to Wikimedia Commons, Poly Pizza, Smithsonian 3D and BodyParts3D; the files they name are fetched once and kept on this Mac.' }],
  }
}
