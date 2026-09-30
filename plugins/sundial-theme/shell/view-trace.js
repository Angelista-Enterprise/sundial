// The effect journal: what Gnomon did, by family, and the chain behind one event.
import { el } from './surfaces.js'
import { compositionBar, DOING, doing, FAMILIES, journalDays, share } from './trace.js'
import { table } from './view-kit.js'

/**
 * Everything Gnomon has actually done, and what set it off.
 *
 * The argument for the card's subject is in `trace.js`'s own head; what
 * follows is what the record refused and what it could not be asked.
 *
 * **The heading was wrong and the route made it wrong.** It read "Rules that
 * fired, last 120 minutes" over a `window` that was `triggers.length` — a ROW
 * COUNT — while `getRecentRuleTriggers(120)` returned 120 rows, which on this
 * record span twenty-one minutes. Row-limited and time-windowed are different
 * cards and it was drawn as both. This one is neither: it is pinned to the
 * WHOLE journal and says its own dates on its face, because the journal begins
 * on 17 September (when the harness executor first ran) against a log that
 * begins on 30 July, and nothing in the system ever prunes it. A board span of
 * a month would draw twenty-five empty days; a span of a day would hide the
 * only history there is.
 *
 * **"fired / suppressed / errored" is not three things this table holds, and
 * each is refused for its own reason.** There is no `errored` status — the
 * column's three values are `started`, `completed` and `indeterminate` — and
 * the finding is not that a column is missing. When an effect THROWS, the
 * exception leaves `executeEffects` with the row still `started`; the next
 * boot consults the delivery guarantee, finds `at-least-once` (which every
 * variant in the union is), runs it again and marks it `completed`. A failure
 * heals into a success. `indeterminate` is only ever written for an
 * `at-most-once` effect and nothing is classified that way yet. So all 27,029
 * rows saying `completed` is not "nothing has ever failed" — it is that this
 * journal has nowhere to record a failure, which is what the card says instead
 * of a green tick. And "suppressed" is not in this table at all: a rule that
 * decided to do nothing writes no row anywhere. `noticeGate` is the single
 * exception, with its own `gate_decisions` table and its own card, so the
 * audit's example — "noticeGate evaluated 43, suppressed 40" — is answerable
 * for exactly one of the fifty-five rules here. The card points at Unsaid
 * rather than inventing a denominator for the other fifty-four.
 *
 * **The call-trees are one level deep, because that is all the record holds.**
 * Grouping by `event_id` works and the fan-out is real — one event reaches
 * twenty-one effects at its widest. But 17,581 of 20,839 events produce
 * exactly one effect, so a tree drawn per row would be a single node 84% of
 * the time: it is the row's FOLD instead, which says nothing extra where there
 * is nothing extra. The deeper tree is not recoverable at all. An `EmitEvent`
 * effect is journalled as `EmitEvent <type>` and never carries the id of the
 * event it emitted, so the chain from one sensor reading through three
 * internal hops cannot be rebuilt — and that chain is most of the traffic:
 * 16,884 of the 20,839 events Gnomon acted on, Gnomon caused itself.
 *
 * **No write door, and there should not be one.** A trace is a record of what
 * already happened; there is no field here the owner knows better than the
 * machine does, and a verdict on an effect that ran is an opinion about
 * arithmetic. Same answer as the Calibration card, for the same reason.
 */
export function tracePanel(d) {
  const total = d.total ?? 0
  const families = d.families ?? []
  const you = families.find((f) => f.family === 'you')
  const itself = families.find((f) => f.family === 'itself')
  const days = journalDays(d.span?.firstAt, d.span?.lastAt)
  const since = d.span?.firstAt ? new Date(d.span.firstAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : null

  return [
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What Gnomon has done' }),
      el('p', { class: 'panel-lead' }, [
        el('span', {
          text: total
            ? `${total.toLocaleString()} side effects, from ${(d.events ?? 0).toLocaleString()} events${since ? `, since ${since}` : ''}${days ? ` — about ${Math.round(total / days).toLocaleString()} a day` : ''}.`
            : 'The journal is empty.',
        }),
      ]),
      compositionBar(families, total),
      el(
        'div',
        { class: 'trace-legend' },
        families
          .filter((f) => f.count > 0)
          .map((f) =>
            el('div', { class: 'trace-key' }, [
              el('span', { class: 'trace-swatch', style: { background: FAMILIES[f.family]?.ink ?? 'var(--ink)' } }),
              el('span', { class: 'trace-key-label', text: FAMILIES[f.family]?.label ?? f.family }),
              el('span', { class: 'trace-key-value', text: `${f.count.toLocaleString()} · ${share(f.count, total)}` }),
              el('span', { class: 'trace-key-says', text: FAMILIES[f.family]?.says ?? '' }),
            ]),
          ),
      ),
      // The hairline IS the finding, so it is said in words as well: a band
      // under a pixel is drawn at a pixel, which understates it.
      you && total
        ? el('p', {
            class: 'panel-note',
            text: `${you.count} of those ${total.toLocaleString()} left the machine towards you — ${share(you.count, total)} of everything Gnomon has ever done. Its band above is a hairline, and it is floored at one pixel so it cannot vanish on a narrow card — which draws it smaller than its share rather than larger. ${itself ? `Another ${share(itself.count, total)} was Gnomon telling itself something, which then set off more rules.` : ''}`,
          })
        : null,
      // K0.5 — the journal can report a failure now, and the sentence has to
      // keep saying what its silence means for the rows that predate it.
      // `failures: 0` on an old row is "never counted", not "never failed".
      (d.byStatus ?? []).length
        ? el('p', {
            class: 'panel-note',
            text: (d.failed?.rows ?? 0) > 0
              ? `${(d.failed.rows).toLocaleString()} of these threw at least once — ${(d.failed.throws).toLocaleString()} ${d.failed.throws === 1 ? 'throw' : 'throws'} in all — and every one was retried on the next boot. Before 23 September there was nowhere to record that: a thrown effect was re-run and stamped done, so a failure healed into a success and the older rows say nothing about it either way.`
              : `Nothing has thrown since Gnomon started counting throws, on 23 September. Before then there was nowhere to record one: an effect that threw was re-run on the next boot and stamped done, so a failure healed into a success and the older rows cannot say whether anything went wrong.`,
          })
        : null,
    ]),

    // What set it off. The origin word comes from the Trust card's sensor
    // roster — the list `sensors.test.js` holds against `packages/sensors/src`
    // — rather than from a second table of event types written here.
    (d.byEventType ?? []).length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'What set it off' }),
          el('p', {
            class: 'panel-note',
            text: `${(d.origin?.world?.events ?? 0).toLocaleString()} of these events came from a sensor — something you or your machine did. The other ${(d.origin?.gnomon?.events ?? 0).toLocaleString()} Gnomon raised itself, in answer to one of the first.${
              (d.emitEdges?.emits ?? 0) > 0
                ? ` ${(d.emitEdges.withEdge ?? 0) === 0 ? 'None of those' : `${d.emitEdges.withEdge.toLocaleString()} of the ${d.emitEdges.emits.toLocaleString()}`} emissions record which event they became, so the chain can only be followed where they do — the rest were written before Gnomon kept that link.`
                : ''
            }`,
          }),
          table(
            [
              { label: 'Event', cell: (r) => r.eventType },
              { label: 'From', cell: (r) => (r.origin === 'world' ? 'the world' : 'Gnomon itself') },
              { label: 'Times', num: true, cell: (r) => r.events.toLocaleString() },
              { label: 'Effects', num: true, cell: (r) => r.effects.toLocaleString() },
              { label: 'Each', num: true, cell: (r) => (r.events > 0 ? (r.effects / r.events).toFixed(1) : '—') },
            ],
            d.byEventType,
          ),
        ])
      : null,

    // The rules, with what KIND of thing each does beside the count — which is
    // the whole repair. Ranked by count alone the first row is 39% of the
    // table and says nothing about itself.
    (d.byRule ?? []).length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'Which rules acted' }),
          el('p', {
            class: 'panel-note',
            text: `${d.byRule.length} rules have caused an effect since the journal began. A rule missing from this list is not a rule that did nothing: the journal records EFFECTS, and a rule that only folds something into Gnomon's working memory — which is most of the trackers — never writes a row here at all.`,
          }),
          table(
            [
              { label: 'Rule', cell: (r) => r.rule },
              { label: 'Does', cell: (r) => (r.kinds ?? []).map((k) => DOING[k] ?? k).join(', ') },
              { label: 'Effects', num: true, cell: (r) => r.count.toLocaleString() },
            ],
            d.byRule,
          ),
        ])
      : null,

    // The tail. A row's fold is the rest of its own event — the call-tree, one
    // level, which is the only level the record holds.
    (d.recent ?? []).length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: `The last ${d.recent.length} things it did` }),
          table(
            [
              { label: 'When', cell: (r) => new Date(r.appliedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) },
              { label: 'Because of', cell: (r) => r.eventType },
              { label: 'Rule', cell: (r) => r.ruleName },
              {
                label: 'Did',
                cell: (r) =>
                  r.moment
                    ? el('span', { class: 'door', 'data-explore': `moment:${r.moment}`, tabindex: '0', role: 'link', text: doing(r.effectDetail) })
                    : doing(r.effectDetail),
              },
            ],
            d.recent,
            (r) => {
              const kin = (d.siblings?.[r.eventId] ?? []).filter((s) => s.effectIndex !== r.effectIndex)
              // K0.5 — one hop down the chain, where the record now holds it.
              const born = r.emittedEventId ? (d.children?.[r.emittedEventId] ?? []) : []
              return [
                // The exact journal line, which the closed row deliberately
                // does not carry: "say the thing, not its storage" upstairs,
                // and the storage down here, where someone debugging looks.
                el('p', { class: 'trace-raw', text: r.effectDetail }),
                // A failure is said in the fold and not on the row: it is rare,
                // it is a paragraph, and the row is a scan line.
                r.failures > 0
                  ? el('p', { class: 'panel-note', text: `This threw ${r.failures === 1 ? 'once' : `${r.failures} times`} before it ran${r.lastError ? `. The last error: ${String(r.lastError).split('\n')[0]}` : '.'}` })
                  : null,
                born.length
                  ? el('div', { class: 'trace-kin' }, [
                      el('p', { class: 'panel-note', text: `What it told itself then caused ${born.length === 1 ? 'one more thing' : `${born.length} more things`}:` }),
                      el(
                        'ul',
                        {},
                        born.map((c) =>
                          el('li', {}, [
                            el('span', { class: 'trace-kin-rule', text: c.ruleName }),
                            c.moment
                              ? el('span', { class: 'door', 'data-explore': `moment:${c.moment}`, tabindex: '0', role: 'link', text: doing(c.effectDetail) })
                              : el('span', { text: doing(c.effectDetail) }),
                          ]),
                        ),
                      ),
                    ])
                  : null,
                kin.length
                  ? el('div', { class: 'trace-kin' }, [
                      el('p', { class: 'panel-note', text: `The same event also caused ${kin.length === 1 ? 'one other thing' : `${kin.length} other things`}:` }),
                      el(
                        'ul',
                        {},
                        kin.map((s) =>
                          el('li', {}, [
                            el('span', { class: 'trace-kin-rule', text: s.ruleName }),
                            s.moment
                              ? el('span', { class: 'door', 'data-explore': `moment:${s.moment}`, tabindex: '0', role: 'link', text: doing(s.effectDetail) })
                              : el('span', { text: doing(s.effectDetail) }),
                          ]),
                        ),
                      ),
                    ])
                  : el('p', { class: 'panel-note', text: 'This event caused nothing else.' }),
              ]
            },
          ),
        ])
      : null,

    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What this cannot tell you' }),
      el('p', {
        class: 'panel-note',
        text: 'Whether anything failed before 23 September — until then a thrown effect was re-run on the next boot and recorded as a success, and nothing was kept. What a rule decided NOT to do — nothing is written when a rule declines, except by the noticing gate, which keeps its own record on the Unsaid card. And the chain through any emission written before that same date, which named the kind of event a rule raised but not which event it became.',
      }),
      el('p', { class: 'panel-note', text: 'Nothing on this card can be corrected, so nothing on it asks you to. It is a record of what happened.' }),
    ]),
  ]
}
