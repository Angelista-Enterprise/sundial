// The assistant's open proposals, what was decided on them this week, and the counts.
import { proposalsOf } from '@sundial/helpers/loops.js'

export async function readAssistantProposals({ state, now }) {
  const assistant = state.assistant ?? { proposedCount: 0, acceptedCount: 0, rejectedCount: 0 }
  const recent = proposalsOf(state)
  return {
    proposals: recent
      // `gnomon_run_shell` logged every command it ran to
      // `assistant:proposal` until 2026-09-09; it uses
      // `action:performed` now, but the rows it already wrote are still
      // in the ring, still `open`, and can never resolve — a command
      // that ran is not awaiting a verdict. All 23 rows on this record
      // were of that kind, which is why the surface first rendered as
      // 921px of shell history. Filtered by kind rather than migrated:
      // the log is append-only and these are readable there as what
      // they always were.
      .filter((p) => p.kind !== 'run_shell' && p.kind !== 'run_shell-refused')
      // Open ones only. A resolved proposal is a record, and Today is
      // for what still wants something from the owner.
      .filter((p) => p.outcome === 'open')
      .sort((a, b) => String(b.at).localeCompare(String(a.at))),
    // What was decided this week, newest first: a proposal that was
    // accepted is not "nothing to decide", it is the record of a decision.
    resolved: recent
      .filter((p) => p.kind !== 'run_shell' && p.kind !== 'run_shell-refused' && p.outcome !== 'open' && now - Date.parse(p.resolvedAt ?? p.at) < 7 * 86_400_000)
      .sort((a, b) => String(b.resolvedAt ?? b.at).localeCompare(String(a.resolvedAt ?? a.at)))
      .slice(0, 12),
    accepted: assistant.acceptedCount ?? 0,
    rejected: assistant.rejectedCount ?? 0,
  }
}
