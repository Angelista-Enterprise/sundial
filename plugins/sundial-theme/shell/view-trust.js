// Trust: whether the machine is working — coverage, sensors, redaction, notice precision and the belief audit.
import { el, svg } from './surfaces.js'
import { sensorRoster, SPEECH, switchedOn } from './sensors.js'
import { coverageGrid, coverageWeeks, weekdayOf, weekdayTypical } from './coverage-grid.js'
import { num, panel, pct, table } from './view-kit.js'

/**
 * How much of your life Gnomon actually saw, and what it could not.
 *
 * **The card's subject, and the two things it had to stop doing.** It shipped
 * as an inventory — five volume counts, an embedding tally, a redaction tally
 * and a 96-row list called "Sensors, quietest first" — and none of that
 * answers the question an owner puts to a local-first agent. The question is
 * how much it saw. So the volume counts are GONE (the audit sends them to the
 * ledger, beside what the thinking cost), and the silence ranking is gone too,
 * for a reason worth keeping:
 *
 * **Ranking sensors by silence measures the owner's week, not the machine.**
 * 69 of that list's 96 rows were not sensors at all — `board:step`,
 * `llm:dispatched`, `clock:tick` — because it was derived from every event
 * type in the log, and its quietest rows were a one-off consent grant and the
 * Ask surface I7 deleted. Worse, among the real sensors silence means three
 * different things and only one of them is a fault: see `sensors.js`. The
 * audit's "64 live / 18 quiet / 8 dead" is therefore not a number that was
 * wrong, it is a number that cannot be computed.
 *
 * **What the record CAN answer is the heartbeat, and that is the hero.** One
 * sensor emits on a clock whatever happens, so its density is elapsed watched
 * time; 2026-09-20 holds 0.15 hours against a usual nine or ten, and that is
 * what "something was wrong" looks like here. Drawn as a calendar rather than
 * a strip, because the audit also asked for a weekday rhythm and a rhythm is a
 * question you ask down a column.
 */
export function noticePrecisionPanel(p) {
  const pct = (useful, n) => (n > 0 ? `${Math.round((useful / n) * 100)}%` : '—')
  const title = el('h2', { class: 'panel-title', text: 'Worth hearing · thirty days' })
  if (!p || p.n === 0) return el('section', { class: 'panel' }, [title, el('p', { class: 'panel-note', text: 'No notice has been judged in thirty days.' })])
  return el('section', { class: 'panel' }, [
    title,
    el('p', { class: 'panel-lead', text: `${p.useful} of ${p.n} notices you judged were worth hearing (${pct(p.useful, p.n)}).` }),
    table(
      [
        { label: 'Kind', cell: (r) => r.kind },
        { label: 'Useful', num: true, cell: (r) => String(r.useful) },
        { label: 'n', num: true, cell: (r) => String(r.n) },
        { label: 'Share', num: true, cell: (r) => (r.n < 3 ? 'too few' : pct(r.useful, r.n)) },
      ],
      p.byKind,
    ),
    el('p', { class: 'panel-note', text: `The latest verdict on each notice counts once.${p.excluded ? ` ${p.excluded} ${p.excluded === 1 ? 'verdict' : 'verdicts'} on test or smoke keys left out.` : ''}` }),
  ])
}

export function trustPanel(d) {
  const pipe = d.pipeline ?? {}
  const emb = d.embeddings ?? {}
  const red = d.redaction ?? {}
  const fb = d.feedback ?? {}
  const counts = fb.countsByVerdict ?? {}
  const audit = d.beliefAudit ?? {}
  const align = d.aliasAlignment ?? {}
  const suggestions = align.suggestions ?? []
  const retracted = audit.retracted ?? []
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never')

  const observed = Array.isArray(d.observed) ? d.observed : []
  const weeks = coverageWeeks(observed)
  const typical = weekdayTypical(observed)
  const roster = sensorRoster(d.sensors ?? [], d.optIn ?? {})
  const on = switchedOn(roster)
  const todayRow = observed.find((day) => day.date === d.today) ?? null
  const todayTypical = d.today ? typical[weekdayOf(d.today)] : null
  const hours = (n) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}h`)
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`

  // The days the heartbeat nearly stopped. Named, not just drawn pale: the
  // calendar shows THAT it happened and the sentence says WHEN, which is what
  // the owner needs to go and remember why.
  const thin = observed.filter((day) => day.hours < 3).slice(-4)

  // ── The calendar ─────────────────────────────────────────────────────────
  const slab = el('div', { class: 'cov-slab' })
  const picture = svg('svg', { class: 'cov', preserveAspectRatio: 'none', role: 'img', 'aria-label': `hours watched on each of the last ${observed.length} days` })
  slab.append(picture)
  const note = el('p', { class: 'cov-picked' })
  const paint = () =>
    coverageGrid(picture, {
      weeks,
      typical,
      today: d.today,
      // Width only. The height comes BACK from the drawing, so the cells keep
      // their proportion instead of being squashed into a box somebody picked
      // — the owner's "doesn't scale well" on the first draw.
      width: Math.round(slab.clientWidth),
      onPick: (day) => {
        note.textContent = `${new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} — ${day.hours === null ? 'nothing in the log at all; Gnomon was not running' : `${day.hours.toFixed(1)} hours watched`}.`
      },
    })
  let queued = 0
  new ResizeObserver(() => {
    cancelAnimationFrame(queued)
    queued = requestAnimationFrame(paint)
  }).observe(slab)
  // And once, synchronously. The observer fires on observe, but through a
  // frame — and a frame does not come while the pane is hidden, which is
  // exactly when an instrument first draws itself.
  paint()

  // ── The roster ───────────────────────────────────────────────────────────
  // Grouped by what makes a sensor speak, because that is the only thing that
  // makes its silence readable. Within a group, longest-quiet last: a sensor
  // heard from recently is the uninteresting one.
  const quiet = (min) => (min === null ? 'never' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)} days ago`)
  const group = (key) => {
    const mine = roster.filter((sensor) => sensor.speech === key).sort((a, b) => (a.quietMin ?? Infinity) - (b.quietMin ?? Infinity))
    if (mine.length === 0) return null
    return el('div', { class: 'sensor-group' }, [
      el('h3', { class: 'sensor-group-head', text: `Speaks ${SPEECH[key].word}` }),
      el('p', { class: 'sensor-group-note', text: SPEECH[key].means }),
      el(
        'ul',
        { class: 'sensor-list' },
        mine.map((sensor) =>
          el('li', { class: 'sensor', 'data-off': sensor.optIn && !sensor.on ? 'yes' : null }, [
            el('span', { class: 'sensor-name', text: sensor.name }),
            el('span', { class: 'sensor-does', text: sensor.does }),
            el('span', {
              class: 'sensor-heard',
              // A stream that has NEVER spoken is a different fact from a quiet
              // one, and on the phone it is four of five streams — which is the
              // card's own finding about that path.
              text: sensor.optIn && !sensor.on ? 'switched off' : sensor.silentEvents.length === sensor.events.length ? 'never heard' : quiet(sensor.quietMin),
            }),
          ]),
        ),
      ),
    ])
  }

  return [
    el('section', { class: 'panel' }, [
      el('p', {
        class: 'panel-lead',
        text: observed.length
          ? `How much of your life Gnomon actually saw. ${count(observed.length, 'day')} in the record; one sensor reports on a clock whether or not anything happens, so the darkness of a square is the hours it was genuinely watching — not how busy you were.`
          : 'Nothing has been watched yet.',
      }),
      observed.length
        ? el('div', { class: 'cov-figure' }, [
            slab,
            note,
            el('div', { class: 'cov-says' }, [
              // Today against a typical one of the same weekday. MEDIAN, not
              // mean: Wednesday runs 1.8 to 23.9 hours on this record and a
              // mean describes neither end.
              todayRow && todayTypical?.median !== null
                ? el('p', {
                    text: `Today: ${hours(todayRow.hours)} watched, against ${hours(todayTypical.median)} on a usual ${todayTypical.label} — ${todayRow.hours >= todayTypical.median ? 'more' : 'less'} than usual, over ${count(todayTypical.n, 'sample')}.`,
                  })
                : el('p', { text: 'Today has not been watched long enough to compare.' }),
              // The gaps, named. This is the only genuine health signal the
              // record carries, so it gets a sentence rather than a pale cell
              // the eye can skip.
              thin.length
                ? el('p', {
                    class: 'cov-gaps',
                    text: `${count(thin.length, 'day')} in the record hold under three hours — ${thin.map((day) => `${new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${hours(day.hours)}`).join(', ')}. An empty square is a day with nothing in the log at all, which is Gnomon not running rather than Gnomon seeing nothing.`,
                  })
                : null,
              el('p', {
                text: `Of ${(pipe.moments ?? 0).toLocaleString()} sessions, ${pct((pipe.momentsWithIntent ?? 0) / (pipe.moments || 1))} got a reading of what you were doing and ${pct((pipe.momentsWithProject ?? 0) / (pipe.moments || 1))} could be tied to a project. The rest were watched and never understood.`,
              }),
            ]),
          ])
        : null,
    ]),

    // ── The sensors ────────────────────────────────────────────────────────
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `${count(roster.length, 'sensor')}, by what makes them speak` }),
      el('p', {
        class: 'panel-note',
        text: on.length
          ? `${on.map((sensor) => sensor.name).join(' and ')} ${on.length === 1 ? 'is' : 'are'} off by default and you have switched ${on.length === 1 ? 'it' : 'them'} on.`
          : 'Every sensor that is off by default is still off.',
      }),
      ...['heartbeat', 'state', 'event'].map(group),
    ]),

    // ── Redaction ──────────────────────────────────────────────────────────
    // The audit asked for three before→after samples. **There is no before.**
    // Redaction happens once, at ingest, and the privacy signal records only
    // `{properties: {name: count}, total, sourceType}` — a tally of which field
    // was scrubbed, never the value. That is `sanitize-at-ingest` working as
    // designed, and the honest version of the ask is the AFTER: which fields
    // are being scrubbed, how often, and on what.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `What was scrubbed, last ${red.windowHours ?? 24}h` }),
      el('p', {
        class: 'panel-note',
        text: `${(red.totalRedactions ?? 0).toLocaleString()} values removed from ${(red.redactableEvents ?? 0).toLocaleString()} events, across ${count((red.properties ?? []).length, 'field')}: ${(red.properties ?? []).join(', ')}. It happens once, at ingest — the original never reaches the log, so there is nothing here to show you a "before" of, and every read boundary after this trims a value that was already safe.`,
      }),
      (red.bySource ?? []).length
        ? table(
            [
              { label: 'From', cell: (r) => r.sourceType },
              { label: 'Values removed', num: true, cell: (r) => r.redactions.toLocaleString() },
              { label: 'Events', num: true, cell: (r) => r.events.toLocaleString() },
            ],
            red.bySource,
          )
        : el('p', { class: 'panel-note', text: 'Nothing has needed scrubbing in this window.' }),
      el('p', {
        class: 'panel-note',
        text: `Retrieval is ${emb.total ? `${emb.total.toLocaleString()} vectors from ${emb.model}` : 'not built yet'}, computed on this machine over text that was already scrubbed. There is no remote-embedding path.${emb.hashFallback ? ' The local model is not loaded, so retrieval is running on a hash fallback and is quietly worse than it looks.' : ''}`,
      }),
    ]),

    // The owner's taps, by verdict. The one number every learned threshold
    // hangs off (J0.8): a Trust page that cannot say how many verdicts exist
    // cannot say whether anything is calibrated.
    panel(
      'Your verdicts',
      [
        ['Useful', counts.useful ?? 0],
        ['Not now', counts['not-now'] ?? 0],
        ['Wrong', counts.wrong ?? 0],
        ['Last', fb.lastVerdictAt ? new Date(fb.lastVerdictAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never'],
      ],
      'Every shown line has three taps, and so does a push on the phone. Thresholds start moving at twenty.',
    ),
    // N1: the verdicts above, turned into the question they answer — was it
    // worth hearing — per kind, because one family can sink the whole figure.
    noticePrecisionPanel(d.noticePrecision),
    // J5.4 / J5.2: the judge, graded by the owner. One row per question that
    // has been asked; the deciles show where its probabilities landed and how
    // often the owner then said useful — the two lining up IS calibration.
    selfEvaluation(d.judgement ?? {}, d.perception ?? null),
    // J2.3: retractions with evidence. The audit's answers travel with the
    // row; a fact the owner tapped wrong has none, and says so.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `Belief audit · last run ${when(audit.lastRunAt)}` }),
      retracted.length
        ? table(
            [
              { label: 'Retracted belief', cell: (r) => `${r.canonicalName} ${r.predicate} ${r.object}` },
              { label: 'is false', num: true, cell: (r) => (r.audit ? num(r.audit.is_false, 2) : '—') },
              { label: 'artifact', num: true, cell: (r) => (r.audit ? num(r.audit.is_artifact, 2) : '—') },
              { label: 'By', cell: (r) => (r.audit ? 'audit' : 'your tap') },
              { label: 'When', cell: (r) => new Date(r.retractedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) },
            ],
            retracted,
          )
        : el('p', { class: 'panel-note', text: 'Nothing retracted yet.' }),
      el('p', { class: 'panel-note', text: 'Every live inferred belief goes to the judge nightly. A belief is retracted only when it reads as malformed — subject and object swapped, a room as a person — at 0.7 or above; the bench found zero false alarms there. The judge cannot see a plausible misattribution, so it never retracts one.' }),
    ]),
    // J2.4: two names, one thing? Listed, never merged by a model. A same-name
    // pair is exact (two real roots for one project name); a judged pair is
    // the judge's probability. Adding the alias to projectAliases merges it.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `Possible aliases · last run ${when(align.lastRunAt)}` }),
      suggestions.length
        ? table(
            [
              { label: 'Kind', cell: (r) => r.kind },
              // Two real roots for one name ARE the same string; the path is what tells them apart.
              { label: 'This', cell: (r) => (r.basis === 'same-name' ? r.aId : r.a) },
              { label: 'May be', cell: (r) => (r.basis === 'same-name' ? r.bId : r.b) },
              { label: 'P(same)', num: true, cell: (r) => num(r.p, 2) },
              { label: 'Basis', cell: (r) => (r.basis === 'same-name' ? 'same name' : 'judge') },
            ],
            suggestions,
          )
        : el('p', { class: 'panel-note', text: 'No pair looks like one thing under two names.' }),
      el('p', { class: 'panel-note', text: 'Nothing here is merged on its own. A project pair merges when you add the alias to projectAliases in ~/.sundial/config.json; a synthetic named: project beside its real root is folded in nightly without asking. People are listed only — there is no person merge yet.' }),
    ]),
  ]
}

/**
 * Is it getting better? The judge's questions, each with the threshold it
 * decides on (default until twenty verdicts, then learned), the owner's
 * verdicts on the answers behind what they saw, and the reliability deciles.
 * Questions nobody has graded yet are counted, not listed: a table of zeros
 * says less than the sentence.
 */
export function selfEvaluation(j, perception) {
  const questions = Array.isArray(j.questions) ? j.questions : []
  const graded = questions.filter((q) => q.n > 0).sort((a, b) => b.n - a.n || a.set.localeCompare(b.set))
  const learned = questions.filter((q) => q.learned).length
  const mins = Math.round((j.degradedMs ?? 0) / 60_000)
  const mode = j.degraded === 'none' ? 'on Jev' : j.degraded === 'local-fallback' ? `on the text model since ${new Date(j.degradedSince).toLocaleTimeString(undefined, { timeStyle: 'short' })}` : `off since ${new Date(j.degradedSince).toLocaleTimeString(undefined, { timeStyle: 'short' })}`
  const deciles = (q) =>
    el(
      'div',
      { class: 'bins bins-tight', role: 'img', 'aria-label': `${q.n} graded answers by probability decile; the mark is the share the owner found useful` },
      q.bins.n.map((n, i) =>
        n === 0
          ? null
          : el('div', { class: 'bin' }, [
              el('span', { class: 'bin-label', text: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}` }),
              el('div', { class: 'bin-track' }, [el('div', { class: 'bin-fill', style: `width:${Math.round((n / q.n) * 100)}%` }), el('div', { class: 'bin-tick', style: `left:${Math.round((q.bins.hits[i] / n) * 100)}%` })]),
              el('span', { class: 'bin-n', text: `${q.bins.hits[i]}/${n} useful` }),
            ]),
      ),
    )
  return el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title', text: 'Self-evaluation' }),
    el('p', {
      class: 'panel-note',
      text: `${questions.length} question${questions.length === 1 ? '' : 's'} have been asked; ${graded.length} ${graded.length === 1 ? 'has' : 'have'} a verdict behind ${graded.length === 1 ? 'it' : 'them'}, ${learned} ${learned === 1 ? 'has' : 'have'} earned ${learned === 1 ? 'its' : 'their'} own threshold (that takes ${j.learnsAt ?? 20}). The judge is ${mode}; ${mins === 0 ? 'no time' : `${mins} min`} spent off it so far.`,
    }),
    // J2.1: the owner-state filter against the owner's taps — the bar it must
    // clear before it may price an interruption.
    perception
      ? el('p', {
          class: 'panel-note',
          text:
            perception.n === 0
              ? 'How-is-it-going taps: none yet. The strip asks three times a day; the filter is scored against each one, and may enter the gate only after 14 days at a Brier of 0.15 or under.'
              : `How-is-it-going taps: ${perception.n} over ${perception.days} day${perception.days === 1 ? '' : 's'} of ${perception.target.days}; Brier ${perception.brier.toFixed(3)} against the ${perception.target.brier} bar. ${perception.inGateCost ? 'The filter prices interruptions.' : 'The filter does not price interruptions yet.'}`,
        })
      : null,
    graded.length
      ? table(
          [
            { label: 'Question', cell: (q) => `${q.set} · ${q.key}` },
            { label: 'θ', num: true, cell: (q) => `${num(q.threshold, 1)}${q.learned ? '' : ' (default)'}` },
            { label: 'Verdicts', num: true, cell: (q) => `${q.n}` },
            { label: 'Useful', num: true, cell: (q) => `${q.hits}/${q.n}` },
            { label: 'Last', cell: (q) => (q.lastVerdictAt ? new Date(q.lastVerdictAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—') },
          ],
          graded,
          (q) => [deciles(q)],
        )
      : el('p', { class: 'panel-note', text: 'No verdict has reached a judgement yet. A tap on a moment line grades its fan-out and its line judge; a tap on a notice grades the gate features behind it; a tap on a belief grades its audit.' }),
  ])
}
