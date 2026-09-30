// Lab — the experiments Gnomon scheduled for itself, the questions it holds open (with each cell's live evidence), and how its proposals and notices fared this week (`LabReading`).
import { proposalsOf, wakeupsOf } from '@sundial/helpers/loops.js'

export async function readLab({ state, now }) {
  const week = new Date(now)
  week.setHours(0, 0, 0, 0)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7)) // Monday
  const inWeek = (iso) => typeof iso === 'string' && Date.parse(iso) >= week.getTime()
  const mind = state?.mind ?? {}
  // Every scheduled wakeup that is LAB work, not just the ones whose key
  // happens to start with `experiment-`. That prefix match reported an empty
  // bench while `weekly-self-audit` — Gnomon's own standing review of its
  // week, and the most lab-like thing it does — sat scheduled on it.
  const experiments = wakeupsOf(state).filter((w) => typeof w.key === 'string' && (w.key.startsWith('experiment-') || w.key.includes('audit')))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    // The prefix comes off only when it IS the prefix. `slice(11)` on
    // `weekly-self-audit` produced a bench row literally called " audit".
    .map((w) => ({
      key: w.key,
      name: (w.key.startsWith('experiment-') ? w.key.slice('experiment-'.length) : w.key).replace(/-/g, ' '),
      at: w.at,
      scheduledAt: w.scheduledAt,
      reason: w.reason,
      status: Date.parse(w.at) <= now ? 'due' : 'scheduled',
    }))
  const questions = (mind.goals ?? []).map((goal) => {
    // The cell's evidence as it stands now; a goal whose cell left the map keeps the count it closed (or opened) with.
    const cell = (mind.gaps ?? []).find((gap) => `${gap.forecaster}:${gap.cell}` === goal.id) ?? null
    return {
      id: goal.id,
      question: goal.question,
      label: goal.label,
      evidence: cell?.n ?? goal.closedWith?.n ?? goal.openedWith?.n ?? 0,
      status: goal.closedAt ? (goal.outcome ?? 'closed') : 'open',
      openedAt: goal.openedAt,
      closedAt: goal.closedAt ?? null,
      // What the card needs to decide whether to believe an outcome: how
      // much evidence the study actually gathered while it ran, and whether
      // anyone wrote down what it concluded. Both were already in state and
      // neither reached the page — so "learned" was printed with nothing
      // beside it on a verdict that rests on two new observations.
      openedWith: goal.openedWith ?? null,
      closedWith: goal.closedWith ?? null,
      finding: goal.finding ?? null,
      hypothesis: goal.hypothesis ?? null,
      tried: goal.tried ?? [],
    }
  })
  const assistant = state?.assistant ?? {}
  const proposals = proposalsOf(state)
    .filter((p) => p.kind !== 'run_shell' && p.kind !== 'run_shell-refused' && p.outcome !== 'open' && inWeek(p.resolvedAt ?? p.at))
    .sort((a, b) => String(b.resolvedAt ?? b.at).localeCompare(String(a.resolvedAt ?? a.at)))
    .map((p) => ({ id: p.id, summary: p.summary, kind: p.kind, outcome: p.outcome, at: p.resolvedAt ?? p.at }))
  const notices = { useful: 0, wrong: 0, notNow: 0 }
  for (const f of state?.feedback?.recent ?? []) {
    if (f.artifactKind !== 'notice' || !inWeek(f.ts)) continue
    const slot = f.verdict === 'not-now' ? 'notNow' : f.verdict
    if (slot in notices) notices[slot] += 1
  }
  // **These two counters are LIFETIME, and the card called them "this
  // week".** `assistantTrack` increments `acceptedCount` on every accept and
  // never resets it, so "18 of 23 accepted" was all-time — printed under a
  // heading that said this week, beside notice counts that really were
  // week-scoped. One heading over two different spans is worse than either
  // being wrong on its own, so they are named for what they are now.
  const accepted = assistant.acceptedCount ?? 0
  const rejected = assistant.rejectedCount ?? 0
  return {
    lab: {
      experiments,
      questions,
      // Since the beginning, and labelled so.
      proposalsEver: { accepted, rejected, resolved: accepted + rejected },
      // Genuinely this week, from `state.feedback.recent` — a 50-entry ring,
      // so this is a floor rather than a count, and the card says that.
      thisWeek: { notices, proposals, since: week.toISOString() },
    },
  }
}
