// Reach: every tool Gnomon can touch, which it used, and the Ask/Auto rungs.
import { el } from './surfaces.js'
import { byVerdict, capability, registry, RUNGS, tightenedByConfig, usedSentence, usedTitle, usedWord, VERDICT, verdictAt } from './reach.js'
import { table } from './view-kit.js'

/**
 * What Gnomon can touch outside its own record, and on what terms.
 *
 * One row per integration, mounted or not — WITH the reason, so "not mounted:
 * missing OBSIDIAN_API_KEY" is on this page and not in a log. Under each, its
 * tools with the verdict the gate will give: a read runs freely, a write asks.
 * The verdicts come from the same code the gate uses, so this page cannot lie
 * about what will and will not prompt.
 */
/**
 * What Gnomon can reach past this machine, and what happens when it tries.
 *
 * **Every verdict here is the gate's own.** The card asks
 * `ctx.gnomonReach.verdict(tool, preset)`, which runs the same `decideAction`
 * the `tools/pre-execute` hook runs. The surface it replaces wrote the answers
 * by hand — "On call: runs / asks", a column with the same word on all
 * twenty-eight of Gnomon's tools — and the foot said "under the
 * workspace-write preset every write above asks before it runs", which is a
 * sentence about a policy rather than the policy speaking. See `reach.js`.
 *
 * **Three of the audit's items were refused by the record, and each refusal is
 * on the card.** There is no destructive tier — the gate knows a read and a
 * not-read, so a delete and an append are the same thing to it, and badging a
 * tier it does not enforce is worse on a permission surface than badging none.
 * There is no usage telemetry — MCP calls append nothing, so of the record's
 * 120 action rows 119 are `run_shell` and one is `calendar_create`. And the
 * "+36 built-in tools" disclosure is now three: the registry has shrunk to 49
 * and Gnomon's own tools are 28 of them.
 */
export function reachPanel(d) {
  const integrations = d.integrations ?? []
  const reg = registry(d)
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`
  const short = (text) => (text.length > 110 ? `${text.slice(0, 109)}…` : text)

  // The gate's verdict for one tool, at both rungs, as the two words the owner
  // reads on the chip. One cell, because it is one claim about one tool.
  const ladder = (tool) =>
    el(
      'span',
      { class: 'reach-ladder' },
      RUNGS.map((rung) => {
        const kind = verdictAt(tool, rung.preset)
        return el('span', { class: 'reach-rung', 'data-tone': VERDICT[kind].tone, title: tool.verdicts?.[rung.preset]?.reason ?? null }, [
          el('span', { class: 'reach-rung-word', text: rung.word }),
          el('span', { class: 'reach-rung-verdict', text: VERDICT[kind].word }),
        ])
      }),
    )

  const service = (i) => {
    const cap = capability(i)
    return el('section', { class: 'panel' }, [
      el('div', { class: 'reach-head' }, [
        el('h2', { class: 'panel-title', text: i.name }),
        el('span', { class: 'pill', 'data-on': i.mounted || null, text: i.mounted ? 'connected' : 'not connected' }),
        el('span', { class: 'reach-meta', text: `over ${i.transport}` }),
      ]),
      !i.mounted ? el('p', { class: 'panel-note', text: i.reason ?? 'Gnomon could not connect to it, and gave no reason.' }) : null,
      // The capability line the audit asked for, assembled from the gate's
      // verdicts rather than written down.
      i.mounted && i.tools.length
        ? el('p', {
            class: 'panel-lead',
            // Assembled from the verdicts, so the sentence cannot claim
            // something the gate would not do. The verb is written per rung
            // rather than patched out of the verdict word, which produced
            // "on Auto runs" with nothing to run.
            text: `${count(cap.reads, 'of its tools reads', 'of its tools read')}, and ${cap.readEverywhere ? 'Gnomon may use those whenever it likes' : 'some of those still stop for you'}. The other ${count(cap.writes, 'changes things in', 'change things in')} ${i.name} — ${cap.writeLadder
              .map((r) => `on ${r.word} it ${r.kind === null ? 'does nothing' : r.kind === 'allow' ? 'just runs' : r.kind === 'ask' ? 'stops for your nod' : 'is refused'}`)
              .join(', and ')}.`,
          })
        : null,
      // The half of that sentence that matters most, said on its own. The gate
      // has no destructive tier, so on Auto a delete goes through exactly like
      // an append, and nobody reading a permission card should have to work
      // that out from a table.
      i.mounted && cap.unpromptedWrites.length && cap.writes > 0
        ? el('p', {
            class: 'reach-warning',
            text: `On ${cap.unpromptedWrites.join(' and ')} that includes ${i.tools.filter((t) => !t.read && /delete|remove|overwrite/i.test(t.tool)).length ? 'deleting a file' : 'every one of those changes'}, with no prompt. Gnomon's gate sorts a service's tools into reads and everything-else; it has no separate rung for destroying something, so a delete travels the same road as an append.`,
          })
        : null,
      i.mounted && i.tools.length
        ? table(
            [
              { label: 'Tool', cell: (t) => t.tool },
              { label: 'Kind', cell: (t) => el('span', { class: 'reach-kind', 'data-read': t.read || null, text: t.read ? 'reads' : 'changes things' }) },
              { label: 'What the gate does', cell: ladder },
              // K0.1. A tool nothing has called says "not since" and not
              // "never": the counting started when the gate learned to write a
              // row, and everything before that is silence that means nothing.
              { label: 'Used', cell: (t) => el('span', { title: usedTitle(t.used), text: usedWord(t.used) }) },
              { label: 'What it does', cell: (t) => short(t.description) },
            ],
            i.tools,
          )
        : null,
      i.mounted && i.tools.length === 0 ? el('div', { class: 'none', text: 'Connected, but the server offered no tools.' }) : null,
      // K0.1. The counts live here and not in the Used column, which carries
      // the recency alone — see `usedWord` for the measurement that decided it.
      i.mounted && usedSentence(i.used) ? el('p', { class: 'panel-note', text: `Gnomon has reached this service ${usedSentence(i.used)}` }) : null,
      el('p', {
        class: 'panel-note',
        text: (i.reads ?? []).length
          ? `Gnomon decides which of these are reads by matching the name against ${i.reads.join(', ')} — the same match the gate makes when the tool is actually called. Anything else is a change.`
          : 'No read patterns are declared for this service, so the gate treats every one of its tools as a change.',
      }),
    ])
  }

  return [
    el('section', { class: 'panel' }, [
      el('p', {
        class: 'panel-lead',
        text: `What Gnomon can touch beyond this machine, and what happens when it reaches. ${count(reg.total, 'tool is', 'tools are')} on its bench: ${reg.own} it ships itself, ${reg.mcp} from ${count(integrations.filter((i) => i.mounted).length, 'service you have connected')}, and ${reg.builtIn} from the harness it runs in. Every verdict below is the gate's own answer, not a description of it.`,
      }),
      el('p', {
        class: 'panel-note',
        // Both rungs named as the chip names them, because that is the control
        // the owner actually has. `read-only` is in the gate's table and the
        // board cannot select it, which is worth one clause.
        text: `Ask and Auto are the two settings on the permission chip. The gate knows a third, read-only, which refuses everything outward — this board has no way to choose it.${d.autonomy && d.autonomy !== 'act' ? ` Your auto mode is "${d.autonomy}", which stops anything outward for your nod whatever the chip says.` : ''}`,
      }),
    ]),

    ...integrations.map(service),
    integrations.length === 0
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'Nothing connected' }),
          el('div', { class: 'none', text: 'Gnomon reaches no service of yours. Add an `integrations` entry to ~/.sundial/config.json to give it one.' }),
        ])
      : null,

    // ── Gnomon's own hands ────────────────────────────────────────────────
    // Grouped by what the gate does with them, not listed. There are
    // twenty-eight, and the question is never "what does gnomon_shelve do" —
    // it is "what can this thing do without asking me".
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `Its own hands · ${reg.own}` }),
      // K0.1. One line rather than a usage column: the section below is
      // grouped by VERDICT, which is the question ("what can this do without
      // asking me"), and a per-tool count down the side would answer a
      // different one at the same size.
      (() => {
        const rows = Object.values(d.ownUsed ?? {}).filter(Boolean)
        if (rows.length === 0) return null
        const calls = rows.reduce((n, r) => n + r.calls, 0)
        const failed = rows.reduce((n, r) => n + r.failed, 0)
        return el('p', {
          class: 'panel-note',
          text: `${count(rows.length, 'of these has', 'of these have')} actually been used since the counting began — ${count(calls, 'call')}${failed ? `, ${failed} of which failed` : ', none of which failed'}.`,
        })
      })(),
      ...RUNGS.map((rung) =>
        el('div', { class: 'reach-group' }, [
          el('h3', { class: 'reach-group-head', text: `On ${rung.word}` }),
          ...byVerdict(d.own ?? [], rung.preset).map((group) =>
            el('p', { class: 'reach-line' }, [
              el('span', { class: 'reach-line-verdict', 'data-tone': group.tone, text: group.word }),
              el('span', { class: 'reach-line-tools' }, [
                el('span', { text: group.tools.map((t) => t.tool).join(', ') }),
                // A shell tool's verdict depends on the command, so the row
                // says so rather than implying the preset settles it.
                group.tools.some((t) => t.verdicts?.[rung.preset]?.argDependent)
                  ? el('span', { class: 'reach-depends', text: ' — for an ordinary command; a destructive one is refused whatever this says' })
                  : null,
              ]),
            ]),
          ),
        ]),
      ),
      // Why Auto changes nothing for two of them. Read off the gate's own
      // reason string rather than re-derived, and absent when the owner has
      // tightened nothing — a line saying "0 tools are tightened" is one the
      // eye learns to skip.
      tightenedByConfig(d.own ?? []).length
        ? el('p', {
            class: 'panel-note',
            text: `${tightenedByConfig(d.own ?? []).join(' and ')} stop for you on Auto as well as on Ask, because you have held ${tightenedByConfig(d.own ?? []).length === 1 ? 'it' : 'them'} tighter than the chip does in config.actions. That setting can only tighten; nothing in ~/.sundial/config.json can loosen what the preset allows.`,
          })
        : null,
      // The one thing the gate refuses whatever the chip says, because it is
      // the only promise this card can make.
      el('p', {
        class: 'panel-note',
        text: 'A destructive shell command — rm -rf, sudo, dd, a piped curl, a force push — is refused at both settings and at every auto mode. That check runs on the command itself, not on the preset, and it is the only thing here that Auto does not turn off.',
      }),
    ]),

    // ── What the record cannot say ────────────────────────────────────────
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What this card cannot tell you' }),
      el('p', {
        class: 'panel-note',
        text: d.countingSince
          ? `What ran before ${new Date(d.countingSince).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}. Until then only two of Gnomon's own tools wrote a row when they acted, so of the record's first 120 action rows, 119 were shell runs and one was a calendar event — a call to a connected service appended nothing at all. The gate writes one row per call now, whatever the tool, so "not used" above means not since that date rather than never.`
          : 'When any of this was last used, or how often it failed. The gate now writes a row for every call it lets through, but none has been made since it started — so the counts above are empty because nothing has run, not because nobody wrote it down.',
      }),
    ]),
  ]
}
