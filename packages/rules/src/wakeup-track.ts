import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, KernelState, Rule, ScheduledWakeup } from '@sundial/kernel/types.js';

/**
 * Scheduled wake-ups: "check this again at 17:00", folded rather than timed.
 *
 * The capability Gnomon was missing is not "run something later" — a
 * `setTimeout` is one line. It is that the thing running later has to survive a
 * restart, replay identically, and be visible as a decision the owner can
 * inspect and cancel. dsh's own schedule package gives none of that: its
 * reminders live in one session's event log, so a wake-up set on Monday does
 * not exist on Tuesday, and the owner has no way to see what is armed. That is
 * exactly the "module-level timer nobody remembers arming" shape the kernel law
 * exists to forbid.
 *
 * So a wake-up is a fold. `wakeup:scheduled` puts an entry in
 * `state.wakeups.open`, `clock:tick` fires the due ones, and firing REMOVES the
 * entry — the same naturally edge-triggered shape `commitmentTrack` gets from a
 * thread leaving `open`, with no marker to keep and nothing to re-arm.
 *
 * It emits a `notice:candidate` rather than delivering anything itself. That is
 * the point of routing through the gate: a wake-up that comes due mid-call
 * should be DEFERRED, not blared, and the gate is the only thing in the system
 * that knows what the owner is doing. A wake-up asked for is not a wake-up owed
 * at any cost.
 */

/**
 * Beyond this, a schedule stops being a set of intentions and becomes an alarm
 * clock nobody reads. Also the bound on the snapshot slice: this rides in every
 * `kernel_state_snapshots` row.
 */
const MAX_OPEN_WAKEUPS = 10;

/**
 * A wake-up further out than this is almost always a typo (a year mistyped, an
 * epoch in seconds read as milliseconds). Refusing it here keeps a nonsense
 * entry from occupying one of the ten slots forever.
 */
const MAX_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Surprise 2.0 with full precision clears both `phasicThreshold` (1.6) and
 * `budgetExemptAbove` (1.6) in `DEFAULT_GATE_POLICY`.
 *
 * This is the one producer where a fixed weight is honest rather than lazy.
 * Every other candidate estimates how surprising an observation is, because
 * nobody asked to hear it. A wake-up was requested, so its value is not in
 * question — what remains for the gate to decide is only WHEN, which is the
 * deferral machinery, not the threshold.
 */
const WAKEUP_SURPRISE = 2.0;

/**
 * Half an hour, which is under `urgentBelowMs` (2h) and so puts a due wake-up
 * on the phasic path. A wake-up whose whole content is "now is the time" is
 * worth much less an hour from now, which is precisely what this field means.
 */
const WAKEUP_VALUE_HALF_LIFE_MS = 30 * 60 * 1000;

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `check the deploy` → `check-the-deploy`, so the same concern set twice is one wake-up. */
function slugify(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export const wakeupTrack: Rule = (state, event) => {
  if (event.type === 'wakeup:scheduled') {
    const reason = trim(event.payload.reason);
    const at = trim(event.payload.at);
    if (reason === '' || at === '') return { state, effects: [] };

    const dueAt = Date.parse(at);
    const now = Date.parse(event.ts);
    // A wake-up already in the past would fire on the very next tick, which is
    // not scheduling — it is an immediate notice wearing a schedule's clothes.
    if (!Number.isFinite(dueAt) || dueAt <= now || dueAt - now > MAX_HORIZON_MS) return { state, effects: [] };

    const key = trim(event.payload.key) || slugify(reason);
    if (key === '') return { state, effects: [] };

    const wakeup: ScheduledWakeup = { key, at: new Date(dueAt).toISOString(), reason, scheduledAt: event.ts };
    // Same key REPLACES: "actually, make it 18:00" is a correction, not a
    // second wake-up. Dropping the oldest when full keeps the most recently
    // expressed intentions, which are the ones the owner still remembers.
    const others = state.wakeups.open.filter((w) => w.key !== key);
    const open = [...others, wakeup].slice(-MAX_OPEN_WAKEUPS);

    return { state: { ...state, wakeups: { open } }, effects: [] };
  }

  if (event.type === 'wakeup:cancelled') {
    const key = trim(event.payload.key);
    if (key === '') return { state, effects: [] };
    const open = state.wakeups.open.filter((w) => w.key !== key);
    if (open.length === state.wakeups.open.length) return { state, effects: [] };
    return { state: { ...state, wakeups: { open } }, effects: [] };
  }

  if (event.type !== 'clock:tick') return { state, effects: [] };
  if (state.wakeups.open.length === 0) return { state, effects: [] };

  const now = Date.parse(event.ts);
  const due = state.wakeups.open.filter((w) => Date.parse(w.at) <= now);
  if (due.length === 0) return { state, effects: [] };

  const effects: Effect[] = due.map((wakeup) => ({
    type: 'EmitEvent',
    event: {
      id: deriveId(event.ts, event.id, 'wakeup-track', `due:${wakeup.key}:${wakeup.at}`),
      type: 'notice:candidate',
      ts: event.ts,
      payload: {
        timestamp: event.ts,
        shape: 'anticipatory',
        kind: 'wakeup',
        /**
         * The concrete `at` is IN the key deliberately, so a recurring wake-up
         * presents a fresh stimulus each time instead of habituating itself
         * into silence. That is safe here and nowhere else: habituation exists
         * to stop a producer repeating an observation the owner never asked
         * for, and every one of these was asked for — twice over, since setting
         * a wake-up is an explicit act bounded at MAX_OPEN_WAKEUPS.
         */
        key: `wakeup:${wakeup.key}:${wakeup.at}`,
        surprise: WAKEUP_SURPRISE,
        precision: 1,
        valueHalfLifeMs: WAKEUP_VALUE_HALF_LIFE_MS,
        observation: wakeup.reason,
        evidence: [`you asked me to check this at ${wakeup.at.slice(11, 16)}`, `set ${wakeup.scheduledAt.slice(0, 16).replace('T', ' ')}`],
        concerns: [],
      },
    },
  }));

  const wakeups: KernelState['wakeups'] = { open: state.wakeups.open.filter((w) => Date.parse(w.at) > now) };
  return { state: { ...state, wakeups }, effects };
};
