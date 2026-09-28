// What the owner said they want, read back out of the record.
//
// Three things the raw rows cannot say on their own, and all three were audit
// findings on this card.
//
// **The why is invisible.** It is there — the owner wrote "open — easy to
// toggle, like Notion; with or without a meeting, record and transcribe what is
// happening so afspraken are remembered" — but it was written into the same
// free-text field as the state, so the card printed the whole paragraph in a
// column called State and called it a status. The head of that string is the
// state; everything after the dash is the reason the goal exists, which is what
// the owner asked to see as the row's subtitle.
//
// **Status "open" on every row is uninformative.** A goal by itself has no
// movement to show; the record keeps movement somewhere else, on the branch the
// goal names. `Ledger failure views (L1–L7)` says "delegated to Claude Code on
// branch ledger-failure-views", and `commitments` holds that branch with its
// last touch and its touch count, and the `git/commit` signals on it carry
// `[6/7]` in their subjects. So the link is real, and it is the goal's own words
// that make it — not a guess about which work belongs to which intention.
//
// **A goal nobody has touched for a fortnight looks exactly like a live one.**
// Quiet is computed here rather than stored, because it is a function of the
// clock and storing it would mean a field that is wrong the moment nobody
// writes to it.
import { entitySlug } from './entity-id.js'

const DAY = 86_400_000

/** How long a goal may go unmoved before the card asks about it. */
export const QUIET_AFTER_DAYS = 14

/**
 * A stored status, split into the state and the reason for it.
 *
 * The owner writes one field. `open — query params are saved verbatim…` is a
 * state and a why sharing a string, and the em dash is where they part. A bare
 * `open` has no tail, and a status that is all prose (`Bring the momentum-driven
 * bedtime "in check"`) is all why with the state left implied — which is `open`,
 * because a goal the owner wrote a paragraph about is not a goal they closed.
 */
export function splitStatus(stored) {
  const raw = String(stored ?? '').trim()
  const cut = raw.search(/\s[—–-]\s/)
  const head = (cut === -1 ? raw : raw.slice(0, cut)).trim()
  const tail = cut === -1 ? '' : raw.slice(cut).replace(/^\s[—–-]\s/, '').trim()
  const known = ['open', 'doing', 'paused', 'done', 'dropped', 'waiting', 'blocked']
  const state = known.find((s) => s === head.toLowerCase())
  return state ? { state, why: tail } : { state: 'open', why: raw }
}

/**
 * The work the goal points at, if it points at any.
 *
 * Matched on the goal's own slug containing the branch's — `ledger-failure-views-l1-l7`
 * contains `ledger-failure-views`, `gnomon-board-audit` contains `board-audit`.
 * A branch slug shorter than eight characters or with no hyphen in it is not
 * used: `dsh-0` appears inside half the sentences anyone writes, and a link the
 * owner cannot recognise is worse than no link.
 */
export function linkMovement(goalName, commitments, commits) {
  const slug = entitySlug(goalName)
  const match = (Array.isArray(commitments) ? commitments : []).find((c) => {
    const branch = entitySlug(c?.branch ?? c?.name ?? '')
    return branch.length >= 8 && branch.includes('-') && slug.includes(branch)
  })
  if (!match) return null
  const lines = (Array.isArray(commits) ? commits : []).filter((c) => c?.branch === match.branch)
  // `[6/7]` in a commit subject: the owner's own progress token, put there on
  // purpose so a delegated job could be checked without reading the diff. The
  // highest one seen is where the work got to.
  let done = 0
  let total = 0
  for (const line of lines) {
    const token = /\[(\d+)\/(\d+)\]/.exec(String(line?.commitLine ?? ''))
    if (token && Number(token[1]) >= done) {
      done = Number(token[1])
      total = Number(token[2])
    }
  }
  return {
    branch: match.branch,
    project: match.projectName ?? null,
    lastAt: match.lastTouchedAt ?? null,
    touches: match.touches ?? 0,
    commits: lines.length,
    // Newest first, like every other list. Capped: a long-lived branch has
    // hundreds and the fold is evidence, not a git log.
    log: [...lines].reverse().slice(0, 30),
    ...(total > 0 ? { done, total } : {}),
  }
}

// ── The checklist ──────────────────────────────────────────────────────────
// A goal's steps are ONE fact, rewritten whole on every edit, because a plan is
// one value and `predicateCardinality` marks `steps` functional so the newest
// supersedes. The superseded versions stay in the fact timeline, which means the
// plan keeps its own history without anything being built for it.
//
// Stored as one line per step, `status: text`, rather than as JSON. Both parse
// the same; only one of them is readable when the fact turns up on the Memory
// card, and "say the thing, not its storage" applies to a fact object as much as
// to a row.

/** The four a step can be in. `skip` is kept because a plan's dead steps are evidence. */
export const STEP_STATES = ['todo', 'doing', 'done', 'skip']

/** One tap moves a step on; `skip` is a corner the cycle does not visit. */
export const nextStepState = (state) => (state === 'skip' ? 'todo' : STEP_STATES[(STEP_STATES.indexOf(state) + 1) % 3])

/** `done: retry lineage` → `{ state: 'done', text: 'retry lineage' }`. */
export function parseSteps(stored) {
  return String(stored ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Split on the FIRST colon only: a step's own text may hold others.
      const cut = /^([a-z]+):\s*(.*)$/.exec(line)
      return cut && STEP_STATES.includes(cut[1]) ? { state: cut[1], text: cut[2].trim() } : { state: 'todo', text: line }
    })
    .filter((step) => step.text !== '')
}

/**
 * Back to the one line the record holds.
 *
 * Capped, because the assert route caps an object at 1000 characters and a list
 * silently cut in half is worse than a list that refuses to grow. Twenty steps
 * is a plan; more than that is a project, which is what `partOf` is for.
 */
export const formatSteps = (steps) =>
  steps
    .slice(0, 20)
    .map((s) => `${STEP_STATES.includes(s.state) ? s.state : 'todo'}: ${String(s.text).replace(/\s+/g, ' ').trim()}`)
    .join('\n')

/** How far a list has got, for the line the fold hangs off. */
export const stepProgress = (steps) => ({ done: steps.filter((s) => s.state === 'done').length, total: steps.filter((s) => s.state !== 'skip').length })

/**
 * The `[n/7]` tokens, read back out as the steps they stood for.
 *
 * The owner puts `[3/7]` in a commit subject on purpose, so a delegated job can
 * be checked without reading the diff. That IS a checklist — it was just stored
 * as seven separate sentences with a fraction on the end. This turns it back
 * into a list: each seen index is a done step named by its own subject, and each
 * index never seen is a step still outstanding.
 *
 * Derived on read and never written. The moment the owner touches a step the
 * card writes a real `steps` fact, which takes over — so nothing is migrated and
 * nothing is invented into the record on the owner's behalf.
 */
export function stepsFromCommits(commits) {
  const seen = new Map()
  let total = 0
  for (const commit of commits ?? []) {
    const line = String(commit?.commitLine ?? '')
    const token = /\[(\d+)\/(\d+)\]/.exec(line)
    if (!token) continue
    total = Math.max(total, Number(token[2]))
    // `94cb291 ledger(L1): retry lineage on the call ledger [1/7]` → the work,
    // without the hash, the conventional-commit prefix, or the token that is
    // about to become the step's position.
    const text = line
      .replace(/^[0-9a-f]{7,40}\s+/, '')
      .replace(/\s*\[\d+\/\d+\]\s*$/, '')
      .replace(/^[a-z]+(\([^)]*\))?:\s*/i, '')
      .trim()
    seen.set(Number(token[1]), text)
  }
  if (total === 0) return []
  return Array.from({ length: total }, (_, i) => {
    const text = seen.get(i + 1)
    return text ? { state: 'done', text } : { state: 'todo', text: `step ${i + 1}` }
  })
}

/**
 * When this goal last moved, by anything — the owner changing its state, or a
 * commit landing on the branch it names.
 */
export const lastMoved = (since, movement) => [since, movement?.lastAt].filter(Boolean).sort().pop() ?? null

/** Whole days since the goal last moved. `null` when nothing is dated. */
export function quietDays(since, movement, now = Date.now()) {
  const at = lastMoved(since, movement)
  if (!at) return null
  const ms = now - new Date(at).getTime()
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / DAY)) : null
}

/**
 * Two ids, one goal.
 *
 * Folds rows that slug to the same thing (see `entity-id.js`) and keeps the
 * newest live status, which is the one the owner set last. Without this the
 * card draws `Ask team whether moving standup to 9:30 still stands` twice, once
 * reading "done" and once "dropped", both live, both true of a different row in
 * a table the owner has no way to tell apart.
 */
export function foldDuplicates(rows) {
  const bySlug = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = entitySlug(row?.goal)
    const seen = bySlug.get(key)
    if (!seen) bySlug.set(key, { ...row, id: `goal:${key}` })
    else if (String(row?.since ?? '') > String(seen.since ?? '')) bySlug.set(key, { ...row, id: `goal:${key}`, alsoStored: [...(seen.alsoStored ?? []), seen.status] })
    else bySlug.set(key, { ...seen, alsoStored: [...(seen.alsoStored ?? []), row?.status] })
  }
  return [...bySlug.values()]
}

/**
 * Parents first, each followed by its children.
 *
 * "The three recording rows are one goal with two children" — which is true, and
 * which nothing in the record knew, because no predicate said so. `partOf` is
 * the owner's to assert; until they do, every goal is its own parent and the
 * list reads exactly as it did.
 */
export function groupByParent(goals) {
  const byId = new Map(goals.map((g) => [g.id, g]))
  const children = new Map()
  const roots = []
  for (const goal of goals) {
    const parent = goal.partOf && byId.has(goal.partOf) && goal.partOf !== goal.id ? goal.partOf : null
    if (parent) children.set(parent, [...(children.get(parent) ?? []), goal])
    else roots.push(goal)
  }
  // Live before settled, then the most recently moved — a goal the owner is in
  // the middle of outranks one they finished in July.
  const rank = { doing: 0, open: 1, waiting: 2, blocked: 2, paused: 3, done: 4, dropped: 5 }
  const order = (a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || String(b.movedAt ?? '').localeCompare(String(a.movedAt ?? ''))
  return roots.sort(order).flatMap((root) => [root, ...(children.get(root.id) ?? []).sort(order).map((c) => ({ ...c, child: true }))])
}
