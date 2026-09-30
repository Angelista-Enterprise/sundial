// The Ledger: what Gnomon's thinking costs, by purpose, day and model, against today's caps.
import { el } from './surfaces.js'
import { whenVisible } from './read.js'
import { hm, json, num, panel, pct, secs, table, when } from './view-kit.js'

/**
 * What Gnomon's own thinking costs.
 *
 * Prices are LIST prices for the model a call actually used, not a bill. The
 * page says so on its face rather than in a tooltip, because a number that
 * looks like an invoice and is not one is the kind of thing an owner remembers
 * being misled by.
 */
export async function ledgerView(rerender, spanLine = null) {
  // Something stands here before the first read: the card now waits until it is
  // on screen, like every instrument, and a pane with no children at all reads
  // as a broken card rather than a card that has not looked yet.
  // No head of its own: in the Engine room the tab strip is the head of every
  // tab, and a Ledger title row only here made the page jump on Cost ↔ Trust.
  const view = el('div', { class: 'view' }, [el('div', { class: 'view-body' }, [el('div', { class: 'reading', text: 'Reading…' })])])

  const draw = async () => {
    // No window strip. It was a private control: `7d` here meant nothing to the
    // card beside it, so the board could show a fortnight of activity next to a
    // week of spend and say neither. The span in the foot moves both now, and
    // the strip's span line reports which one it is, not a second choice.
    // A re-read keeps what is drawn until the new reading replaces it, rather
    // than blanking to "Reading…" first. The span line is the strip's (`spanLine`).

    let data = null
    try {
      data = await json('/gnomon/ledger')
    } catch {
      view.lastChild.replaceChildren(el('div', { class: 'none', text: 'The ledger could not be read.' }))
      return
    }

    const s = data.summary ?? {}
    const wasted = data.wasted ?? {}
    const lost = data.lostAnswers ?? []
    const unanswered = lost.filter((r) => !r.answeredBy)
    if (spanLine) spanLine.textContent = data.window === 'all' ? 'all time' : data.window === 'today' ? 'today' : `the last ${data.window}`
    // Filtered, because `replaceChildren` is native and throws on a null —
    // and every optional panel below is a `cond ? node : null`. That was a
    // latent blank page waiting for the first machine with no `models` row;
    // the leak panel, which is null on every HEALTHY machine, would have made
    // it the normal case.
    view.lastChild.replaceChildren(
      ...[
      // Above everything, and only when it is not zero. A credential sitting in
      // a stored error string is the one thing on this page that is not an
      // accounting question.
      s.unredactedErrorCount
        ? panel(
            'A stored error still holds a credential',
            [['Rows', s.unredactedErrorCount]],
            'An error message named an endpoint and that endpoint carried a key. New rows are stripped at the write path, so these were written by something that bypasses it — find that caller before clearing them.',
          )
        : null,
      panel(
        'This window',
        [
          ['Calls', s.calls ?? 0],
          ['Failed', s.failedCount ?? 0, s.calls ? pct(1 - (s.successRate ?? 1)) : null],
          // Was labelled "Median" and was never one — it is the mean, and a
          // mean of call latencies is dragged by a few long tool loops. The
          // real median is per purpose, in the table below.
          ['Mean latency', secs(s.avgLatencyMs)],
          ['Tokens', (s.totalTokens ?? 0).toLocaleString()],
          ['At list price', `$${num(s.estimatedCostUsd, 2)}`],
          ['On this machine', `${s.localCalls ?? 0} of ${s.calls ?? 0}`],
        ],
        'List price for the model each call actually used — an estimate of what the thinking would cost, never a bill.',
      ),
      // ── Lost answers ────────────────────────────────────────────────
      // The question the ledger could not answer, directly above the money.
      // A failed call and a call that was retried and succeeded read the same,
      // so a reader could not tell a broken Gnomon from a slow one.
      lost.length
        ? el('section', { class: 'panel' }, [
            el('h2', { class: 'panel-title', text: 'Lost answers' }),
            table(
              [
                { label: 'Purpose', cell: (r) => r.purpose },
                { label: 'When', cell: (r) => when(r.requestedAt) },
                { label: 'Why', cell: (r) => r.errorClass ?? 'unknown' },
                // The class is what you count; the message is what you read
                // when the count looks strange. It was shown nowhere after the
                // class replaced it, which is how 93 rows kept an endpoint URL
                // that no readout mentioned any more.
                { label: 'Said', cell: (r) => (r.message ? (r.message.length > 64 ? `${r.message.slice(0, 64)}…` : r.message) : '—') },
                // The tail of the id, not the whole 26 characters. It is a
                // reference for gnomon_moment_detail, not a value to read, and
                // at full width it was the widest column on the page.
                // `absent` is not a dead link: a moment's id is minted when it
                // OPENS and a moment under twenty seconds is dropped rather than
                // written, so the pointer is real and the moment was never kept.
                // Chasing one of these from here read as a broken reader during
                // the audit, so the card says which it is.
                { label: 'Moment', cell: (r) => (r.momentId ? (r.momentState === 'absent' ? `…${r.momentId.slice(-6)} · not kept` : `…${r.momentId.slice(-6)}`) : '—') },
                { label: 'Try', num: true, cell: (r) => String(r.attempt ?? 1) },
                // The whole point of the section: did anything answer in its place?
                { label: 'Answered', cell: (r) => (r.answeredBy ? 'yes, later' : 'no') },
              ],
              // Newest first, and only a screen of them: fifty rows of failure
              // buried every panel under it, and the count below says the rest.
              lost.slice(0, 12),
            ),
            el('p', {
              class: 'panel-note',
              text: `${unanswered.length} of the last ${lost.length} failures were never answered by anything${lost.length > 12 ? '; the 12 most recent are shown' : ''}. A later call counts as the answer when it retried this one, or asked the same purpose about the same moment within fifteen minutes.`,
            }),
          ])
        : null,
      // ── Wasted money ────────────────────────────────────────────────
      panel(
        'Wasted money',
        [
          ['Uploaded into failures', `${(wasted.billedOnFailureTokens ?? 0).toLocaleString()} tokens`, `$${num(wasted.billedOnFailureUsd, 2)}`],
          ['Paid twice on retries', `$${num(wasted.retrySpendUsd, 2)}`],
          ['Time spent failing', hm(Math.round((wasted.failedMs ?? 0) / 60000))],
          ['Last failure', wasted.lastFailureAt ? when(wasted.lastFailureAt) : 'none in this window'],
        ],
        'A dead request still uploaded its prompt, and the provider bills what it received. The upload is estimated from the prompt text — the answer that would have counted it never arrived.',
      ),
      el('section', { class: 'panel' }, [
        el('h2', { class: 'panel-title', text: 'By purpose' }),
        table(
          [
            { label: 'Purpose', cell: (r) => r.purpose },
            { label: 'Calls', num: true, cell: (r) => String(r.calls) },
            { label: 'Failed', num: true, cell: (r) => String(r.failedCount ?? 0) },
            // The mean alone described no call that was ever made: companion
            // reads 323s average because a few minutes-long tool loops drag it.
            // p50 is what a call is like, p95 what the bad ones are like.
            { label: 'Typical', num: true, cell: (r) => secs(r.p50LatencyMs) },
            { label: 'Slowest 5%', num: true, cell: (r) => secs(r.p95LatencyMs) },
            { label: 'Mean', num: true, cell: (r) => secs(r.avgLatencyMs) },
            { label: 'Tokens', num: true, cell: (r) => (r.totalTokens ?? 0).toLocaleString() },
            { label: 'Cost', num: true, cell: (r) => `$${num(r.estimatedCostUsd, 2)}` },
          ],
          data.byPurpose ?? [],
        ),
      ]),
      data.models?.length
        ? el('section', { class: 'panel' }, [
            el('h2', { class: 'panel-title', text: 'By model' }),
            table(
              [
                { label: 'Model', cell: (r) => r.model ?? '—' },
                { label: 'Where', cell: (r) => r.provider ?? '—' },
                { label: 'Calls', num: true, cell: (r) => String(r.calls) },
                { label: 'Tokens', num: true, cell: (r) => (r.totalTokens ?? 0).toLocaleString() },
                // An unpriced model is not a free one. Saying "$0.00" for it
                // would understate the bill by exactly the amount nobody knows.
                { label: 'Cost', num: true, cell: (r) => (r.unpriced ? 'no price' : `$${num(r.estimatedCostUsd, 2)}`) },
              ],
              data.models,
            ),
            data.unpricedRemoteModels?.length
              ? el('p', {
                  class: 'panel-note',
                  text: `No list price on record for ${data.unpricedRemoteModels
                    .map((m) => `${m.model} (${(m.totalTokens ?? 0).toLocaleString()} tokens)`)
                    .join(', ')} — those tokens are real and are missing from the total above.`,
                })
              : null,
          ])
        : null,
      data.budgets?.purposes?.length
        ? el('section', { class: 'panel' }, [
            el('h2', {
              class: 'panel-title',
              // The window's total says whether this is expensive; only today's
              // says whether it is expensive right now.
              text: `Today's budget · ${data.budgets.day ?? ''} · ${data.budgets.calls ?? 0} calls, $${num(data.budgets.spentUsd, 2)}`,
            }),
            table(
              [
                { label: 'Purpose', cell: (r) => r.purpose },
                { label: 'Used', num: true, cell: (r) => String(r.used ?? 0) },
                { label: 'Cap', num: true, cell: (r) => (r.cap === null || r.cap === undefined ? 'uncapped' : String(r.cap)) },
              ],
              data.budgets.purposes,
            ),
          ])
        : null,
      data.failureReasons?.length
        ? el('section', { class: 'panel' }, [
            el('h2', { class: 'panel-title', text: 'Why calls failed' }),
            table(
              [
                { label: 'Reason', cell: (r) => r.reason },
                { label: 'Times', num: true, cell: (r) => String(r.count) },
              ],
              data.failureReasons,
            ),
          ])
        : null,
      ].filter(Boolean),
    )
  }

  // Registered like every instrument, which it was not before: it drew once and
  // then sat there. So it re-reads when the span moves, and when the call log
  // moves, and only while the owner can see it.
  whenVisible(view, draw, '/gnomon/ledger')
  return view
}
