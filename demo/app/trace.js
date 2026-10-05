// The journal of everything Gnomon has done — the Trace card's own material.
//
// **What this card is for, settled before any of it was written.** The audit's
// reframe was "every decision I made in the last 2h and what came of it", and
// that is a good sentence about a table that does not exist. `applied_effects`
// holds EFFECTS: things that were applied. A rule that evaluated and decided to
// do nothing writes no row anywhere — the one exception is `noticeGate`, which
// keeps its own `gate_decisions` table and already has the Unsaid card. There
// is no outcome column either. So "decisions and what came of it" would have to
// be invented on both sides.
//
// What the journal IS, and nothing else in Gnomon has this property: the one
// complete record of everything the system has ever DONE. Every side effect in
// the running system goes through a single executor, and that executor journals
// each one with the rule that asked for it and the event that provoked it. So
// the card answers **what has Gnomon actually done, and what set it off** — and
// the three real questions an owner brings to it are all shapes of that. *Is it
// even running?* (the journal is the only surface that says so, and 112 rows on
// 20 September against 16,663 today is what a bad day looks like). *What is it
// spending itself on?* (three quarters of everything it does is changing its
// own record of the owner). *Why did that particular thing happen?* (find the
// row, open the moment it names).
//
// Ranked by count the journal says `applyMomentJudgement` — 10,576 rows of
// 27,029, all of them patching a moment — and nothing else. That is the first
// thing the audit asked to fix, and the fix is not a better sort: it is that
// the ranking's axis was wrong. What a rule DID is the question, so the census
// is by family (`EFFECT_FAMILY` in the kernel, build-enforced over the effect
// union) and every rule row carries the kinds of thing it does beside its
// count.

import { el } from './surfaces.js'

/**
 * The four things a side effect can be, in the order the bar draws them.
 *
 * Ochre is `you` and NOTHING else on this bar, and that is the whole reason
 * the four inks are what they are. DESIGN.md's rule is that ochre is Gnomon's
 * voice, and `Notify` is the only effect in the union that leaves the machine
 * towards the owner — but the first draw gave `think` the darker ochre, and
 * the two bands sit next to each other: a 1.7px hairline against 84px of a
 * neighbouring ochre is a hairline nobody can find. `itself` is the quiet
 * version of `record`'s ink, which is what it is — the same machinery, turned
 * inward — and `think` takes the navy, so the ochre at the end has no
 * neighbour it can be mistaken for.
 */
export const FAMILIES = {
  record: { label: 'changed what it knows', ink: 'var(--ink)', says: 'A row, a fact, a vector, a score — Gnomon writing to its own record of you.' },
  itself: { label: 'talked to itself', ink: 'var(--ink-subtle)', says: 'Fed an event back into its own fold, which then set off more rules. This is why most of what provokes Gnomon is not a sensor.' },
  think: { label: 'spent a model call', ink: 'var(--navy)', says: 'Asked a language model something. The Ledger has what each one cost.' },
  you: { label: 'spoke to you', ink: 'var(--ochre)', says: 'Left the machine towards the owner. Exactly one effect in the whole union does this.' },
}

/**
 * What each effect variant did, in words the owner can say out loud.
 *
 * DESIGN.md: say the thing, not its storage. `UpdateMomentData 01M356…` is the
 * journal's own text and it is two unsayable things at once — a type name and a
 * raw id. The closed row gets the phrase; the fold gets the exact line,
 * because this card is also the place someone debugging goes.
 *
 * Held against `EFFECT_FAMILY` by *trace.test.js* in both directions, so a new
 * effect variant cannot reach the card as a bare type name.
 */
export const DOING = {
  WriteDB: 'wrote a row',
  UpdateMomentData: 'filled in a moment',
  UpdateOwnerAsk: 'updated a question it asked you',
  UpsertEntityFact: 'recorded a belief',
  SupersedeFact: 'replaced a belief',
  RetractFact: 'took a belief back',
  RetractKnowledgeEntry: 'took an entry back',
  ReinforceFact: 'grew surer of a belief',
  DecayFactConfidence: 'let belief fade',
  DecayScores: 'let scores fade',
  Embed: 'indexed something for search',
  DeleteRows: 'pruned old rows',
  MergeProject: 'merged two projects',
  MergeEntity: 'merged two people',
  RecordPrediction: 'filed a prediction',
  RecordGateDecision: 'filed what it decided to say',
  RecordGateFeatures: 'filed a second reading of a notice',
  AttachTranscript: 'attached a transcript',
  ScheduleLLM: 'asked a model',
  Judge: 'asked the fast judge',
  RunReflection: 'reflected on the day',
  RunFactExtraction: 'looked for facts',
  RunConversationExtraction: 'looked for facts in a conversation',
  RunMeetingPromises: 'looked for promises in a meeting',
  RunRefutation: 'tried to disprove itself',
  RunBeliefAudit: 'audited its beliefs',
  RunAliasAlignment: 'looked for people it had counted twice',
  ResolveAliases: 'resolved a name',
  RunAskHarvestBackfill: 'read an old answer of yours',
  RunJournal: 'wrote the journal',
  RunGoalTrial: 'ran a study',
  RunGoalPlan: 'planned a goal',
  ComposeWeekReview: 'reviewed the week',
  RunWorldHygiene: 'tidied what it knows',
  RunRejudge: 'judged its moments again',
  StartJob: 'started a night job',
  StopJob: 'stopped a night job',
  StartSubagent: 'started a job of its own',
  StopSubagent: 'stopped a job',
  EmitEvent: 'told itself something',
  Notify: 'said something to you',
}

/** The phrase for a journal row's `effect_detail`, falling back to its own first token. */
export function doing(detail) {
  const kind = String(detail ?? '').split(' ')[0]
  return DOING[kind] ?? kind ?? '—'
}

/**
 * The moment id inside a journal detail line, or null.
 *
 * Four of `describeEffect`'s arms put one there and they use two shapes — a
 * positional id (`UpdateMomentData <id>`, `WriteDB moment <id>`,
 * `Embed moment <id>`) and a keyed one (`Judge … moment=<id>`). Both are
 * matched on the ULID alphabet rather than on the arm, so a fifth arm that
 * names a moment the same way is picked up for free and one that invents a
 * third shape is not silently half-read.
 *
 * This is a parser over a pre-rendered string, which is a second copy of a
 * format — the thing DESIGN.md keeps finding drifts. It is held against
 * `describeEffect`'s own source by *trace.test.js* rather than trusted, and
 * the alternative (journalling the id in its own column) is a kernel change
 * that would fix nothing already written.
 */
const ULID = '[0-9A-HJKMNP-TV-Z]{26}'
const MOMENT_PATTERNS = [new RegExp(`^UpdateMomentData (${ULID})$`), new RegExp(`^(?:WriteDB|Embed) moment (${ULID})$`), new RegExp(`moment=(${ULID})`)]

export function momentIdIn(detail) {
  const text = String(detail ?? '')
  for (const pattern of MOMENT_PATTERNS) {
    const hit = pattern.exec(text)
    if (hit) return hit[1]
  }
  return null
}

/**
 * The moment each row may open, but only where the record actually holds it.
 *
 * `Judge … moment=<id>` is written when the judge is ASKED, and a moment is
 * written when it CLOSES — so the journal names moments that do not exist yet.
 * 13 of the record's 635 judge rows are in that state, and they are the newest
 * ones, which is exactly what a "last 40" list shows. Clicking one opened
 * nothing and said nothing.
 *
 * `open` is the set of ids the caller found in `moments`. A row whose moment
 * is not there keeps its phrase and loses its underline, which is the honest
 * version: the effect happened, the thing it names is not there to look at.
 */
export function openDoors(rows, open) {
  const held = open instanceof Set ? open : new Set(open ?? [])
  return (rows ?? []).map((row) => {
    const id = momentIdIn(row.effectDetail)
    return { ...row, moment: id !== null && held.has(id) ? id : null }
  })
}

/**
 * The composition bar: one band per family, at its true share.
 *
 * Not an SVG, because a proportional band is exact at every width in CSS and
 * needs no measuring, no `viewBox` and no redraw on a drag — DESIGN.md's "one
 * user unit per pixel" is about a drawing that has to be scaled, and this one
 * never is.
 *
 * The one adjustment, and it is deliberately the understating direction: a
 * non-zero band gets a 1px floor. `you` is 42 rows of 27,029, which is 0.16% —
 * about 1.7px on a wide card and nothing at all once a browser rounds it. A
 * floor of one pixel draws it SMALLER than it is rather than larger, so the
 * hairline is still the finding and the legend carries the number. A minimum
 * generous enough to see would have been the lie.
 */
export function compositionBar(families, total) {
  if (!(total > 0)) return null
  return el(
    'div',
    { class: 'trace-bar', role: 'img', 'aria-label': families.map((f) => `${FAMILIES[f.family]?.label ?? f.family}: ${f.count}`).join('; ') },
    families
      .filter((f) => f.count > 0)
      .map((f) =>
        el('span', {
          class: 'trace-band',
          style: { flex: `${f.count} 0 auto`, background: FAMILIES[f.family]?.ink ?? 'var(--ink)' },
          title: `${FAMILIES[f.family]?.label ?? f.family} — ${f.count.toLocaleString()} of ${total.toLocaleString()}`,
        }),
      ),
  )
}

/** A share, to the precision it deserves: 0.16% is the whole point of the `you` band. */
export function share(count, total) {
  if (!(total > 0)) return '—'
  const pct = (count / total) * 100
  return pct >= 10 ? `${Math.round(pct)}%` : pct >= 1 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`
}

/** Whole days between the journal's first and last row, for the rate sentence. */
export function journalDays(firstAt, lastAt) {
  const from = Date.parse(firstAt ?? '')
  const to = Date.parse(lastAt ?? '')
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  return Math.max(1, Math.round((to - from) / 86400000))
}
