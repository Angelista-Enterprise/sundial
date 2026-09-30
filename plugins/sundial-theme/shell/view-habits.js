// Habits: routines, rituals and how days end, as learned from the record.
import { el } from './surfaces.js'
import { boardLink } from './markdown.js'
import { icon, iconLabel } from './icons.js'
import { dayClock, dayScale, scaleHours } from './day-clock.js'
import { table } from './view-kit.js'

/**
 * When each day ended — as a sentence, because a picture of it would be a lie.
 *
 * This panel was a strip of leaning slabs and the owner's verdict was the
 * shortest in the audit: "I don't like this one at all with its 3d aspects."
 * Redrawing it honestly — a dot per day at its real date and its real time,
 * no lean, no floored heights, gaps in the record left as gaps — is what showed
 * WHY no chart of this will ever read: nineteen of the last twenty-one nights
 * fall between 23:43 and 23:59. Nineteen dots in a sixteen-minute band, one
 * outlier and today. There is no slope to see because there is no spread.
 *
 * And the flatness is the measurement, not the owner. `recordDayEnd`
 * (`packages/rules/src/expectations.ts:303`) keeps the LARGEST local minute
 * inside a local calendar day, so work at 00:30 becomes minute 30 of the NEXT
 * day and can never be the end of the one before it. A measure clipped at
 * midnight, given someone who works past midnight, reports 23:5x forever — and
 * this record has four days of 00:04–07:25 work that the panel cannot see.
 *
 * So the panel says the one thing the samples honestly support, names its two
 * exceptions, and states the clipping rather than drawing around it. Repairing
 * it is a kernel change — a day-end that closes on the first long silence
 * rather than on the calendar — and it belongs to I13 (Rhythm), whose subject
 * this is. Drawing a prettier chart over a clipped number is the bug this whole
 * audit exists to stop.
 */
export function dayEndReading(days) {
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  const when = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  // The band the bulk of the nights fall in, and whatever sits outside it. A
  // night is "late" here at 23:00 — past that the clipping owns the number.
  const late = days.filter((d) => d.minutes >= 23 * 60)
  const rest = days.filter((d) => d.minutes < 23 * 60)
  const lateMin = late.length ? Math.min(...late.map((d) => d.minutes)) : 0
  const lateMax = late.length ? Math.max(...late.map((d) => d.minutes)) : 0

  return el('div', { class: 'dayend' }, [
    el('p', { class: 'dayend-say', text: late.length ? `On ${late.length} of the last ${days.length} days the last thing recorded fell between ${hhmm(lateMin)} and ${hhmm(lateMax)}.` : `The last thing recorded ran from ${hhmm(Math.min(...days.map((d) => d.minutes)))} to ${hhmm(Math.max(...days.map((d) => d.minutes)))}.` }),
    rest.length
      ? el('ul', { class: 'dayend-rest' }, rest.map((d) => el('li', {}, [el('span', { text: when(d.day) }), el('span', { class: 'dayend-rest-at', text: hhmm(d.minutes) })])))
      : null,
    // The caveat is not a footnote: it is the reason the number above is the
    // shape it is, and without it the panel reads as a finding about bedtime.
    el('p', { class: 'dayend-caveat', text: 'That band is the measure, not the night. The day-end sample keeps the latest activity inside a calendar day, so anything after midnight is filed as the next morning and can never close the evening before it — and this record holds four days of work between 00:04 and 07:25 that this panel cannot see. A real bedtime needs a day that ends on a long silence rather than on the clock.' }),
  ].filter(Boolean))
}

/**
 * A ritual: a stretch of work the owner does at about the same time, for about
 * the same thing, again and again.
 *
 * The card used to lead with `Claude → Warp → Google Chrome, seen 123×`, and the
 * owner's question about it is the whole reason this section exists: "We miss
 * context. What information is that bringing across?" A trigram of app switches
 * is ACTIVITY. It has no when, no what-for and no length, so there is nothing in
 * it to grab. All three are on the moments, so the rituals are read from there
 * (`@sundial/kernel/rituals.js`) and the switch table is demoted to a detail.
 *
 * Closed is a LINE — the shape DESIGN.md names: name, the usual hours, how many
 * days, how long a sitting runs, and the window drawn on the clock the whole
 * list shares. Everything that is a list or a paragraph waits inside the fold.
 */
export function ritualsSection(data) {
  const meta = data?.rituals ?? {}
  const list = Array.isArray(meta.list) ? meta.list : []
  const scale = dayScale(list)
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  // Minutes from local midnight, right now — the one ochre mark on the picture,
  // and what makes the column answer "am I on my usual path" without a word.
  const at = new Date()
  const nowMin = at.getHours() * 60 + at.getMinutes()
  const daysSince = (day) => Math.floor((Date.now() - Date.parse(`${day}T12:00:00`)) / 86_400_000)
  const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  const row = (ritual, index) => {
    const cold = daysSince(ritual.lastDay)
    const busiest = Math.max(1, ...(ritual.weekdays ?? [1]))
    return el('details', { class: 'ritual', style: { '--i': index } }, [
      el('summary', { class: 'ritual-line' }, [
        el('span', { class: 'goal-caret' }, [icon('more')]),
        el('span', { class: 'ritual-name', text: ritual.name }),
        // The hours in words as well as in the picture: the owner asked for
        // "09:10–10:00" by name, and a band on an axis cannot be read to the
        // minute. This is the small table beside the picture, not more of it.
        el('span', { class: 'ritual-hours', text: `${hhmm(ritual.startMin)}–${hhmm(ritual.endMin)}` }),
        el('span', { class: 'ritual-facts', text: `${ritual.days} days · ${ritual.when} · about ${ritual.medianMin} min` }),
        el('span', { class: 'ritual-clock-cell', title: `${ritual.occurrences} sittings on ${ritual.days} days, usually ${hhmm(ritual.startMin)} to ${hhmm(ritual.endMin)}` }, [dayClock({ startMin: ritual.startMin, endMin: ritual.endMin, width: 380, now: nowMin }, scale)]),
        // The one question allowed out of the fold, for the same reason the
        // goals card's stale nudge is: inside `<details>` it is invisible on
        // every row the owner has not opened, which is all of them. A ritual
        // that stopped a month ago is the row they came to see.
        cold > 14 ? el('p', { class: 'ritual-nudge', text: `Nothing like this for ${Math.floor(cold / 7)} weeks — last on ${ritual.lastDay}.` }) : null,
      ]),
      el('div', { class: 'goal-open' }, [
        // The raw sequence, demoted to exactly where the audit put it: inside
        // the thing it is evidence for, rather than standing at the top of the
        // card as though it were the finding.
        el('p', { class: 'ritual-apps' }, [iconLabel('app', 'In front'), el('span', { text: (ritual.apps ?? []).join(' · ') })]),
        // Which days it lands on, as bars rather than as a seven-number list —
        // the comparison the eye was making anyway, scaled to this ritual's own
        // busiest day because the question is "which day", not "how many".
        el(
          'ul',
          { class: 'ritual-week' },
          WEEK.map((name, i) =>
            el('li', { 'data-none': (ritual.weekdays?.[i] ?? 0) === 0 ? '' : null, title: `${ritual.weekdays?.[i] ?? 0} on a ${name}` }, [
              el('span', { class: 'ritual-week-bar', style: { '--fill': `${Math.round(((ritual.weekdays?.[i] ?? 0) / busiest) * 100)}%` } }),
              el('span', { class: 'ritual-week-day', text: name[0] }),
            ]),
          ),
        ),
        // What it WAS, in the model's own sentences, ochre because a model wrote
        // them. This is the answer to "what information is that bringing across"
        // that no sequence of app names could give.
        (ritual.intents ?? []).length
          ? el('ul', { class: 'ritual-intents' }, ritual.intents.map((text) => el('li', { text })))
          : el('p', { class: 'none', text: 'No moment in this stretch was ever read, so there is nothing to say about what it was for.' }),
        el('p', { class: 'goal-derived', text: `${ritual.occurrences} sittings, last on ${ritual.lastDay}. Read from the moments each time this card opens — nothing here is stored, so correcting the record corrects this.` }),
      ]),
    ])
  }

  return el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title', text: `Rituals · ${list.length}` }),
    el('p', { class: 'panel-lead', text: `What you do again and again, read off ${(meta.observed ?? 0).toLocaleString()} moments from the last ${meta.weeks ?? 8} weeks. A stretch of work on one project counts as a ritual once it has happened on four separate days; anything Gnomon cannot put a project to is not shown, because a band it cannot name is a row you cannot use.` }),
    list.length
      ? el('div', { class: 'ritual-list' }, [
          // The hour labels, on the same track and at the same x as every band
          // below them. A shared axis with nothing naming it is a picture that
          // asks the reader to guess the scale.
          el('div', { class: 'ritual-head' }, [
            el('span', { class: 'ritual-head-label', text: 'through the day' }),
            el(
              'span',
              { class: 'ritual-clock-cell ritual-hours-row' },
              scaleHours(scale).map((hour) =>
                el('span', { class: 'ritual-hour', style: { '--at': `${((hour * 60 - scale.from) / (scale.to - scale.from)) * 100}%` }, text: String(hour).padStart(2, '0') }),
              ),
            ),
          ]),
          ...list.map(row),
        ])
      : el('div', { class: 'none', text: 'Nothing has recurred on four separate days yet.' }),
  ])
}

/**
 * What Gnomon has learned about how the owner works.
 *
 * Rituals first, because that is the question — what do I do again and again,
 * and what for. Then the switch table, demoted to what it actually is; then the
 * commitments and the expectations, which no comment on this card asked about.
 */
export function habitsPanel(d) {
  const r = d.routines ?? {}
  const c = d.commitments ?? {}
  const x = d.expectations ?? {}
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—')
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

  // Day-end as a strip of ticks: one per day, height = minutes from midnight.
  // A slope is bedtime drift, which no surprise detector can see.
  const dayEnd = x.dayEnd ?? []
  const minM = dayEnd.length ? Math.min(...dayEnd.map((p) => p.minutes)) : 0
  const maxM = dayEnd.length ? Math.max(...dayEnd.map((p) => p.minutes)) : 1
  const span = Math.max(60, maxM - minM)
  const blind = r.unclassified ?? []

  return [
    ritualsSection(d),
    // "Right now" (the next-app forecast) lives on Today's live strip: it is
    // about this moment, and Rhythm is about the days over time.
    // ── The blind spot ──────────────────────────────────────────────────────
    // Named on the card, because a gap the owner cannot see is a gap they
    // cannot close, and this one is theirs to close: the taxonomy is config.
    blind.length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'What I cannot tell apart' }),
          el(
            'ul',
            { class: 'ritual-blind' },
            blind.slice(0, 6).map((b) => el('li', {}, [el('span', { class: 'ritual-blind-app', text: b.app }), el('span', { class: 'ritual-blind-n', text: `${b.blind} of ${b.seen} moments` })])),
          ),
          el('p', { class: 'panel-note', text: 'Every step above records an app and whether it was work or personal. That second half comes from leisureRules in ~/.sundial/config.json, and for these it came out blank: an app with no entry there, or a browser window whose title carries no address and no profile, records only that it happened. It is a config change and it is yours — nothing Gnomon observes can tell it what an unlisted app means to you. The rituals above are unaffected: those are read from projects, not from this taxonomy.' }),
        ])
      : null,
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `Switch sequences · ${r.learnedCount ?? 0} learned` }),
      el('p', { class: 'panel-lead', text: 'The raw tier, kept because it is what the forecast above is made of. It is activity, not habit: the apps you moved between, with no when and no what-for. The rituals are the reading.' }),
      (r.top ?? []).length
        ? table(
            [
              { label: 'Sequence', cell: (row) => row.label },
              { label: 'Seen', num: true, cell: (row) => `${row.support}×` },
              // A mirror pair is ONE oscillation counted from both ends, and the
              // card used to print it as two of the owner's strongest habits —
              // 123 and 110 for the same back-and-forth. The reverse is folded
              // in and named, rather than dropped, so the total stays honest.
              { label: 'Reversed', num: true, cell: (row) => (row.mirrored ? `+${row.mirrored}×` : '—') },
              { label: 'Last', cell: (row) => fmtDay(row.lastSeenAt) },
            ],
            r.top,
          )
        : el('div', { class: 'none', text: 'Nothing repeated often enough yet.' }),
      el('p', { class: 'panel-note', text: 'A step is an app plus whether it was work or personal, never a window title. Alternation (A → B → A) is refused on purpose: that is thinking, not procedure. So is a sequence and its own reverse, which is why the same oscillation is one row here.' }),
    ]),
    // Open threads live on In play now; one line says how many and opens it.
    el('p', { class: 'panel-note' }, [boardLink('play', [document.createTextNode(`${(c.open ?? []).length} open threads — on In play`)])]),
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `When the day ends · ${dayEnd.length} days` }),
      dayEnd.length >= 3 ? dayEndReading(dayEnd) : el('div', { class: 'none', text: 'Fewer than three days recorded.' }),
    ]),
    (x.recurring ?? []).length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'What recurs' }),
          table(
            [
              { label: 'Stream', cell: (row) => row.stream },
              { label: 'Rhythm', cell: (row) => row.bucket },
              { label: 'Seen', num: true, cell: (row) => `${row.n}×` },
              { label: 'Every', num: true, cell: (row) => (row.meanIntervalMin >= 1440 ? `${(row.meanIntervalMin / 1440).toFixed(1)}d` : `${row.meanIntervalMin}m`) },
            ],
            x.recurring,
          ),
        ])
      : null,
  ]
}
