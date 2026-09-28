// Six vocabularies, one set of words.
//
// The record holds six separate status enums, each right for the thing it
// describes and each invented on its own day:
//
//   work jobs      shelved · nothing · failed · timed-out
//   lab questions  learned · stale · superseded · (open) · due · scheduled
//   proposals      open · accepted · rejected
//   verdicts       useful · wrong · not-now
//   owner asks     answered · expired
//   owner goals    open · done · dropped (free text underneath)
//
// On screen they collided. The same research question read "superseded" on the
// lab card and "open" on the calibration card; a finished job read "shelved",
// which the owner took to mean abandoned when it means the opposite — the
// result is on the shelf, waiting for them. The audit found the clash four
// times and called it one thing.
//
// The enums do NOT change. They are the record, and a stored vocabulary should
// not be rewritten because a label read badly. This is the layer between them
// and the page: internal word in, readable word out, plus a tone and whether
// the state owes a reason.

/**
 * `word` is what the owner reads. `tone` is how it should look: `done` for a
 * finished thing, `open` for a live one, `held` for something paused or
 * waiting, `bad` for a failure. `needsReason` marks a state that is meaningless
 * without a why — a job that failed and cannot say why is the audit's "failures
 * owe a one-line why", and a surface drawing one of these is expected to show
 * the reason beside it or a dash where the reason should be.
 */
const WORDS = {
  // Work jobs.
  shelved: { word: 'done, on the shelf', tone: 'done' },
  nothing: { word: 'nothing to shelve', tone: 'held', needsReason: true },
  failed: { word: 'failed', tone: 'bad', needsReason: true },
  'timed-out': { word: 'ran out of time', tone: 'bad', needsReason: true },

  // Lab questions.
  learned: { word: 'learned', tone: 'done' },
  stale: { word: 'went quiet', tone: 'held', needsReason: true },
  superseded: { word: 'superseded', tone: 'held', needsReason: true },
  due: { word: 'due', tone: 'open' },
  scheduled: { word: 'scheduled', tone: 'open' },

  // Proposals.
  accepted: { word: 'accepted', tone: 'done' },
  rejected: { word: 'rejected', tone: 'bad' },

  // Verdicts the owner gave.
  useful: { word: 'useful', tone: 'done' },
  wrong: { word: 'wrong', tone: 'bad' },
  'not-now': { word: 'not now', tone: 'held' },

  // Owner asks.
  answered: { word: 'answered', tone: 'done' },
  expired: { word: 'expired unanswered', tone: 'held' },

  // Goals, and anything else that is simply running or not.
  open: { word: 'open', tone: 'open' },
  doing: { word: 'doing', tone: 'open' },
  paused: { word: 'paused', tone: 'held' },
  waiting: { word: 'waiting', tone: 'held' },
  blocked: { word: 'blocked', tone: 'bad', needsReason: true },
  done: { word: 'done', tone: 'done' },
  dropped: { word: 'dropped', tone: 'held' },
  closed: { word: 'closed', tone: 'done' },
}

/**
 * One status, as the owner should read it.
 *
 * An unknown state is passed through with its dashes turned to spaces rather
 * than swallowed: a new state should look unfamiliar on the page, not invisible.
 */
export function status(name) {
  const key = typeof name === 'string' ? name.trim() : ''
  if (key === '') return { word: '—', tone: 'held', needsReason: false }
  const known = WORDS[key]
  return known ? { needsReason: false, ...known } : { word: key.replace(/[-_]/g, ' '), tone: 'held', needsReason: false }
}

/** Just the word. */
export const statusWord = (name) => status(name).word

/** Whether this state is meaningless without a reason beside it. */
export const needsReason = (name) => status(name).needsReason === true
