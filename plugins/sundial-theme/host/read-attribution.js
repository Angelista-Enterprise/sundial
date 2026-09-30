// Untracked time, as proposals: the unattributed places `attributionPropose` timed, biggest first, each with a guess at its project from its own titles.

/** Show a candidate once it has this much unattributed time. */
const PROPOSAL_MIN_SECONDS = 15 * 60
const PROPOSALS_MAX = 8

/** Project names the owner already uses: known roots, rule targets, alias targets. */
function knownProjectNames(state) {
  const names = new Set()
  for (const k of Object.values(state.project?.known ?? {})) if (typeof k?.name === 'string' && k.name !== '') names.add(k.name)
  for (const r of state.config?.projectRules ?? []) if (typeof r?.project === 'string') names.add(r.project)
  for (const v of Object.values(state.config?.projectAliases ?? {})) if (typeof v === 'string') names.add(v)
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * A guess at which project a candidate belongs to, from its own titles: a
 * project-name token of four letters or more that appears in the label or a
 * title (`puzzlebox` in "Puzzlebox - Backlog - Jira"). Offered first, never
 * applied — the owner picks.
 */
function suggestProject(candidate, names) {
  const hay = [candidate.label, ...(candidate.titles ?? [])].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  const hits = names.map((name) => ({ name, score: name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4).find((t) => hay.includes(t))?.length ?? 0 }))
  // The longest matching token wins; the first name among equals, as before.
  return hits.reduce((best, h) => (h.score > (best?.score ?? 0) ? h : best), null)?.name ?? null
}

export async function readAttributionProposals({ state, url }) {
  // The tail is readable on request: 153 of 161 places on this record
  // are under the fifteen-minute bar, and "the rest is small" is only
  // trustworthy if it can be looked at.
  const query = url.searchParams
  const minSeconds = Math.max(0, Number(query.get('minMinutes') ?? '') * 60 || PROPOSAL_MIN_SECONDS)
  const limit = Math.min(400, Math.max(1, Number(query.get('limit') ?? '') || PROPOSALS_MAX))
  const ap = state.attributionProposals ?? { candidates: {}, decided: {} }
  const names = knownProjectNames(state)
  const all = Object.values(ap.candidates)
  const totalSeconds = all.reduce((n, c) => n + (c.seconds ?? 0), 0)
  const proposals = all
    .filter((c) => (c.seconds ?? 0) >= minSeconds)
    .sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0))
    .slice(0, limit)
    .map((c) => ({
      key: c.key,
      kind: c.kind,
      label: c.label,
      processName: c.processName,
      minutes: Math.round((c.seconds ?? 0) / 60),
      visits: c.visits ?? 0,
      days: (c.days ?? []).length,
      titles: (c.titles ?? []).slice(-4).reverse(),
      firstSeenAt: c.firstSeenAt,
      lastSeenAt: c.lastSeenAt,
      suggested: suggestProject(c, names),
      // The parts of a MULTI-PROJECT place, each answerable on its own:
      // figma.com is Northwind and Puzzles and overture, and one rule for
      // the host could only be wrong. Biggest first; a part worth under
      // a minute is not worth a row.
      parts: Object.entries(c.parts ?? {})
        .map(([partKey, part]) => ({
          partKey,
          kind: part.kind,
          label: part.label,
          minutes: Math.round(part.seconds / 60),
          seconds: Math.round(part.seconds),
          visits: part.visits,
          suggested: suggestProject({ label: part.label, titles: [] }, names),
        }))
        .filter((part) => part.seconds >= 60)
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 6),
    }))
  // Places already settled, so the owner sees the time is accounted for
  // rather than missing: shared work, personal time, and rules written.
  const settled = { assigned: 0, shared: 0, personal: 0, ambient: 0, ignored: 0 }
  for (const d of Object.values(ap.decided ?? {})) if (settled[d.decision] !== undefined) settled[d.decision] += 1
  return {
    proposals,
    projects: names,
    thresholdMin: PROPOSAL_MIN_SECONDS / 60,
    totalUntrackedMin: Math.round(totalSeconds / 60),
    candidates: all.length,
    settled,
    sharedPlaces: state.config?.sharedPlaces ?? [],
  }
}
