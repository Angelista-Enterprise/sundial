// Gnomon's own tools, as the action gate (gate.js) governs them. Its own module so the gate's parts (gate-finals.js) read the
// same table without importing the gate.

/**
 * Gnomon's OWN tools, each mapped to the `config.actions` (kind, tool)
 * coordinate its optional tightening override reads. A tool NOT listed here is
 * a dsh built-in gnomon no longer governs (dsh's own sandbox + approval govern
 * it), with the single `bash` destructive-check exception handled in
 * `decideAction`. `shell: true` marks a tool that must additionally pass the
 * destructive-command check regardless of preset.
 */
export const GNOMON_TOOLS = {
  gnomon_claim: { kind: 'internal', tool: 'claim' },
  gnomon_assert: { kind: 'internal', tool: 'assert' },
  gnomon_propose: { kind: 'internal', tool: 'propose' },
  // J4.3: a draft is a record on Today; the SEND is the owner's tap in their own mail client.
  gnomon_draft: { kind: 'internal', tool: 'draft' },
  gnomon_record_outcome: { kind: 'internal', tool: 'record_outcome' },
  // Scheduling is an INTERNAL write despite feeling like an action: it appends
  // one event to Gnomon's own log and touches nothing outside it. What happens
  // when the wake-up comes due is a notice, which the gate for SPEAKING already
  // governs separately, so treating this as outward would price the same
  // interruption twice.
  gnomon_schedule_wakeup: { kind: 'internal', tool: 'schedule_wakeup', ownerTurnOnly: true },
  gnomon_cancel_wakeup: { kind: 'internal', tool: 'cancel_wakeup' },
  // UC1: one `commitment:heard` to Gnomon's own ledger. Owner-turn-only: a
  // promise is the owner's to state, never a job's to invent.
  gnomon_track_promise: { kind: 'internal', tool: 'track_promise', ownerTurnOnly: true },
  // Asking the owner a question is internal for the same reason: it writes one
  // event to Gnomon's own record. Nothing leaves the machine, and the decision
  // about whether the question is worth the owner's attention belongs to the
  // noticing gate, which prices interruptions, not to this one, which prices
  // writes.
  gnomon_ask_owner: { kind: 'internal', tool: 'ask_owner' },
  gnomon_owner_answer: { kind: 'internal', tool: 'owner_answer', ownerTurnOnly: true },
  // Handing Gnomon a job appends one event; the job itself runs read-only in
  // a child with approvals pinned off, so the write here is the whole risk.
  gnomon_start_job: { kind: 'internal', tool: 'start_job', ownerTurnOnly: true },
  gnomon_stop_repeat: { kind: 'internal', tool: 'stop_repeat', ownerTurnOnly: true },
  // lane E (#12): the night shift's two tools (registered by sundial-proactive,
  // and only while `jobs.enabled`). One event each to Gnomon's own log; the job
  // itself runs in its own worktree where every permission waits for the owner.
  gnomon_night_job: { kind: 'internal', tool: 'night_job', ownerTurnOnly: true },
  gnomon_night_job_stop: { kind: 'internal', tool: 'night_job_stop', ownerTurnOnly: true },
  // Gnomon's own rules: one event each to its own log. Owner-turn-only, because
  // a rule it adopts speaks on its own for as long as it is kept.
  gnomon_adopt_rule: { kind: 'internal', tool: 'adopt_rule', ownerTurnOnly: true },
  gnomon_drop_rule: { kind: 'internal', tool: 'drop_rule', ownerTurnOnly: true },
  // A paused rule says nothing until resumed; a resumed one speaks on its own again. The owner's, like adopting.
  gnomon_pause_rule: { kind: 'internal', tool: 'pause_rule', ownerTurnOnly: true },
  gnomon_resume_rule: { kind: 'internal', tool: 'resume_rule', ownerTurnOnly: true },
  // Taking back a reach's leave to act alone only ever tightens; still the owner's word, not a notice's.
  gnomon_reach_revoke: { kind: 'internal', tool: 'reach_revoke', ownerTurnOnly: true },
  gnomon_run_shell: { kind: 'outward', tool: 'run_shell', shell: true },
  // Writing to the owner's calendar changes something outside this machine's
  // record: the first outward tool that is not a shell. It asks under
  // workspace-write like run_shell does, and has no destructive-command check
  // because there is no command: the arguments ARE the event.
  gnomon_calendar_create: { kind: 'outward', tool: 'calendar_create' },
  // UC1: a reminder in the owner's own Reminders is the same kind of write.
  gnomon_reminder_create: { kind: 'outward', tool: 'reminder_create' },
  // Acting on a web page (Phase 5) changes something outside this machine:
  // a form sent, a button pressed on someone's site. Outward: under
  // workspace-write the owner approves every act; a background job, whose
  // approval is pinned to never, cannot run it. Reading a page (web_page) is
  // not listed, like web_fetch.
  web_act: { kind: 'outward', tool: 'web_act' },
  // Plan 15 step 8: one step on a named control in another app, and putting a replaced value back.
  // Both ask under every preset (`alwaysAsk`): they press and type in any app, and a notice turn carries outside text.
  screen_act: { kind: 'outward', tool: 'screen_act', alwaysAsk: true },
  screen_undo: { kind: 'outward', tool: 'screen_undo', alwaysAsk: true },
}

/**
 * Tools another plugin declares to this gate, by name, with the final kind a call to it is (send, delete, transfer ...), or
 * null for a read. Only plugins/sundial-bench declares, and only on the bench install (index.js `gnomonGate`, which refuses
 * anywhere else): AgentDojo's tools, so their finals ask like any other. Empty on the owner's install. A declared final asks
 * under every preset (gate.js underFinal); a declared read stays what an unlisted tool is. Declaring only ever tightens.
 */
export const DECLARED_TOOLS = new Map()
