// One moment, drawn one way.
//
// A moment was rendered five different ways before this file: the Explore
// pane's detail, the Day instrument's table, the Today card's "Just now"
// column, the Strata slab's hour cells, and the reader's own row shape. The
// owner met three of them in one evening's audit and said the same thing each
// time — "moment detail must be UNIFORM across all surfaces showing moment
// info, and redesigned". This is that one shape; the doors differ, what opens
// does not.
//
// The page the owner approved, in order, each block earning its place:
//
//   a human sentence, and when it happened
//   what Gnomon made of it, marked as inferred
//   what was said aloud, quoted, because first-party evidence outranks the rest
//   the evidence: commands, files, branch, what was on screen
//   focus as a sentence with its reason, never a bare score
//   what the thinking cost
//   the context it happened in, as chips
//
// Nothing here reads a route. It takes the moment the caller already has, so
// the same object drawn by three surfaces cannot disagree with itself.
import { el } from './surfaces.js'
import { icon, iconLabel } from './icons.js'
import { verdictActs } from './verdicts.js'

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—')
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '')
const mins = (ms) => (typeof ms === 'number' && ms > 0 ? Math.round(ms / 60_000) : 0)
const dur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`)

/**
 * A moment as the record keeps it, flattened.
 *
 * The substance lives under `data` and reads as the moment's own; `intent` is
 * an object in there, not a string, which is how a head that expected a string
 * fell through to the process name on every moment the intent pass HAD
 * described.
 */
export function flatten(m) {
  const data = m?.data && typeof m.data === 'object' && !Array.isArray(m.data) ? m.data : {}
  return { ...m, ...data }
}

/** The project's own name, never the path or the `named:` prefix it is stored under. */
export const projectName = (id) => (typeof id === 'string' && id !== '' ? (id.startsWith('named:') ? id.slice(6) : (id.split('/').filter(Boolean).at(-1) ?? id)) : null)

/**
 * The moment as one sentence a person would say out loud.
 *
 * Deterministic, from the fields — no model. That is the same argument the
 * moment pipeline itself rests on: a compiled sentence cannot invent a duration
 * or a project, and this one is read beside the model's own reading, where an
 * invented number would be worse than a plain one.
 *
 * The order is what the owner would lead with: when and how long, then the
 * loudest evidence of what was happening, then where. `intent` is deliberately
 * NOT the sentence — it sits in its own block below, marked inferred, because
 * the whole point of the audit's worst finding was an intent that contradicted
 * the evidence and was printed as though it were the fact.
 */
export function momentSentence(m) {
  const f = flatten(m)
  const wall = mins(f.durationMs)
  const active = mins(f.activeMs)
  const when = f.startTime ? `${clock(f.startTime)}${f.endTime ? `–${clock(f.endTime)}` : ''}` : null

  const quality = typeof f.focusQuality === 'string' && f.focusQuality !== '' ? f.focusQuality : null
  const head = [when, wall > 0 ? `${dur(wall)}${quality ? ` ${quality} focus` : ''}` : quality ? `${quality} focus` : null].filter(Boolean).join(' · ')

  // What was actually going on, loudest first. Speech beats everything: a
  // person saying what they are doing is the only first-party evidence here.
  const doing = []
  if (f.spokenExcerpt) doing.push(f.micActive ? 'speaking aloud' : 'speech in the room')
  if (f.meetingTitle) doing.push(`in “${f.meetingTitle}”`)
  else if (f.audioContext === 'call') doing.push('on a call')
  const commands = typeof f.shellCommandCount === 'number' ? f.shellCommandCount : 0
  const project = projectName(f.projectId)
  if (commands > 0) doing.push(`${commands} shell command${commands === 1 ? '' : 's'}${project ? ` in ${project}` : ''}`)
  else if (project) doing.push(`in ${project}`)
  if (typeof f.gitCommitCount === 'number' && f.gitCommitCount > 0) doing.push(`${f.gitCommitCount} commit${f.gitCommitCount === 1 ? '' : 's'}${f.gitBranch ? ` on ${f.gitBranch}` : ''}`)
  if (doing.length === 0 && f.processName) doing.push(`${f.processName} in front`)

  // An hour of window with nothing at the keys is a window left open, not work,
  // and the sentence should say so rather than letting the duration imply it.
  const idle = wall >= 5 && active === 0 ? 'nothing at the keys' : null
  const tail = [doing.join(', '), idle].filter(Boolean).join('; ')
  return [head, tail].filter(Boolean).join(' — ') || 'A moment with nothing in it.'
}

/**
 * Why the focus reading is what it is, in words.
 *
 * `focusScore: 1` reached the owner as a bare number with no legend and read as
 * broken. The score is not shown at all now: what makes it is shown instead,
 * and the quality word it produced. Evidence, not a score.
 */
export function focusWhy(m) {
  const f = flatten(m)
  const wall = mins(f.durationMs)
  const active = mins(f.activeMs)
  const why = []
  if (active > 0 && wall > 0) why.push(`${dur(active)} of ${dur(wall)} at the keys`)
  const titles = Array.isArray(f.windowTitles) ? f.windowTitles.filter(Boolean) : []
  if (titles.length === 1) why.push('one window throughout')
  else if (titles.length > 1) why.push(`${titles.length} windows`)
  if (typeof f.typingEventCount === 'number' && f.typingEventCount > 0) why.push(`${f.typingEventCount} typing bursts`)
  if (f.calendarActive) why.push('a calendar event was running')
  return why
}

/** A labelled line. The same grammar every instrument uses. */
/** A label → value line. `label` may be `[iconName, word]` to mark the line. */
const line = (label, value, attrs = {}) =>
  el('div', { class: 'panel-row', ...attrs }, [
    Array.isArray(label) ? iconLabel(label[0], label[1], { className: 'panel-label' }) : el('span', { class: 'panel-label', text: label }),
    value instanceof Node ? value : el('span', { class: 'panel-value', text: value }),
  ])

/** A block of short strings as lines rather than one comma run. */
function seen(title, values, limit = 12) {
  const list = (Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && v !== '')
  if (list.length === 0) return null
  return el('section', { class: 'md-block' }, [
    el('h3', { class: 'md-title', text: title }),
    el('ul', { class: 'saw' }, list.slice(0, limit).map((v) => el('li', { text: v }))),
    list.length > limit ? el('p', { class: 'panel-note', text: `${list.length - limit} more.` }) : null,
  ])
}

/**
 * The context a moment happened in, as chips.
 *
 * `micActive: true` and `playbackActive: true` are a field dump; "mic on" and
 * "Spotify playing" are the same facts in a language the owner speaks. Only
 * what was TRUE is drawn — a chip saying a camera was off is noise.
 */
/**
 * The context the moment happened in, each thing said once.
 *
 * `lifeEvents` is a list, not a set: a moment with nine context switches in it
 * drew nine chips reading "context switch", which is a bar chart with the bars
 * removed. The same thing twice is one chip and a count.
 */
export function chipWords(f) {
  const out = []
  if (f.micActive) out.push('mic on')
  if (f.cameraActive) out.push('camera on')
  if (f.audioContext === 'call') out.push('call audio')
  if (f.playbackActive) out.push(f.audioApp ? `${f.audioApp} playing` : 'audio playing')
  if (f.calendarActive) out.push('calendar event')
  if (f.location) out.push(String(f.location))
  if (Array.isArray(f.spokenLanguages)) for (const l of f.spokenLanguages) out.push(l)
  for (const e of Array.isArray(f.lifeEvents) ? f.lifeEvents : []) out.push(String(e).replace(/^(event|media):/, '').replace(/[:-]/g, ' '))
  const counted = new Map()
  for (const word of out) counted.set(word, (counted.get(word) ?? 0) + 1)
  return [...counted].map(([word, n]) => (n > 1 ? `${word} ×${n}` : word))
}

function chips(f) {
  const words = chipWords(f)
  return words.length === 0 ? null : el('div', { class: 'md-chips' }, words.map((t) => el('span', { class: 'md-chip', text: t })))
}

/**
 * What was heard, in whichever copy the owner trusts.
 *
 * A local speech model's output reads like a room; the cleaned copy reads like
 * a sentence. The cleaned one leads WHEN IT EXISTS, and it is labelled as a
 * reading until the owner accepts it, because a transcript is evidence and a
 * tidied piece of evidence that nobody agreed to is worse than an untidy one.
 * The raw capture is always one press away and is never replaced.
 */
function heard(f, onAccept) {
  const raw = String(f.spokenExcerpt)
  const clean = f.spokenClean && typeof f.spokenClean.text === 'string' ? f.spokenClean.text : null
  let accepted = f.spokenCleanAccepted === true
  const quote = el('blockquote', { class: 'md-quote', text: clean ?? raw })
  const block = el('section', { class: 'md-block' }, [el('h3', { class: 'md-title', text: 'Heard aloud' })])
  if (clean === null) return (block.append(quote), block)

  let showing = 'clean'
  const mark = el('span', { class: 'md-flag' })
  const toggle = el('button', { type: 'button', class: 'act act-small' })
  const acts = el('span', { class: 'md-heard-acts' }, [toggle])

  // Built only when there is somewhere for the answer to go, and removed the
  // moment it is answered — a disabled or hidden button is still something the
  // owner has to read past on every visit to a decision they already made.
  const accept =
    onAccept === null || accepted
      ? null
      : el('button', {
          type: 'button',
          class: 'act act-small',
          text: 'Accept this reading',
          title: 'Keep the cleaned copy as the one you read. The capture stays.',
          onclick: async (e) => {
            const button = e.currentTarget
            button.disabled = true
            const ok = await onAccept()
            if (!ok) return void (button.textContent = 'not recorded')
            accepted = true
            button.remove()
            draw()
          },
        })
  if (accept) acts.append(accept)

  const draw = () => {
    const onClean = showing === 'clean'
    quote.textContent = onClean ? clean : raw
    toggle.textContent = onClean ? 'Show what was captured' : 'Show the cleaned copy'
    // The badge says which copy this is and how much to trust it. Without it
    // the two are indistinguishable, and one of them is a model's reading.
    mark.textContent = onClean ? (accepted ? 'cleaned · you accepted this' : 'cleaned · not yet accepted, the capture below is the record') : 'as captured'
    if (accept) accept.hidden = !onClean
    quote.dataset.copy = showing
  }

  toggle.onclick = () => {
    showing = showing === 'clean' ? 'raw' : 'clean'
    draw()
  }
  draw()
  block.append(el('div', { class: 'md-heard-head' }, [mark, acts]), quote)
  return block
}

/**
 * The moment, as nodes. One array, so a caller can put it in a pane, a drill or
 * a row's expansion without this file knowing which.
 *
 * `onDoor` is how a project name becomes a door: the Explore pane wires it to
 * its own opener, a surface that has nowhere to go passes nothing and the name
 * renders as plain text rather than as a link that does nothing.
 */
export function momentDetail(m, { onDoor = null, onAccept = null } = {}) {
  const f = flatten(m)
  const project = projectName(f.projectId)
  const intent = typeof f.intent?.text === 'string' && f.intent.text !== '' ? f.intent.text : null
  const why = focusWhy(m)

  const projectNode =
    project === null
      ? null
      : onDoor
        ? el('span', { class: 'door', 'data-explore': `entity:${project}`, tabindex: '0', role: 'link', text: project })
        : el('span', { class: 'panel-value', text: project })

  return [
    // One sentence, and the day under it. Everything below is the evidence for
    // this line; if they disagree, the line is wrong and should be read as such.
    el('section', { class: 'md-head' }, [el('p', { class: 'md-sentence', text: momentSentence(m) }), el('p', { class: 'md-when', text: [day(f.startTime), project].filter(Boolean).join(' · ') })]),

    // What Gnomon made of it, on the rule its voice takes everywhere else, and
    // marked. A 31-minute session of dictated work came back as "Working in Arc
    // browser": the reading has to be legible AS a reading.
    intent === null && !f.narrative
      ? null
      : el('section', { class: 'found-reading md-intent' }, [
          el('div', { class: 'found-reading-head' }, [el('span', { text: 'Gnomon read this as' }), el('span', { class: 'md-flag', text: f.projectConfidence === 'weak' ? 'inferred · weak attribution' : 'inferred' })]),
          intent ? el('p', { class: 'found-reading-text', text: intent }) : null,
          f.narrative && f.narrative !== intent ? el('p', { class: 'md-narrative', text: f.narrative }) : null,
          // The reading is a line Gnomon produced, so it takes the three taps
          // (J0.8). A `wrong` here is recorded, not acted on: the moment is
          // the sensor's, only its reading is the model's.
          f.id ? verdictActs('moment', f.id) : null,
        ]),

    // The owner's own words. When a moment has speech it is the hero, above
    // every inference — this quote was the "buried treasure" of the audit,
    // sitting under a field dump.
    f.spokenExcerpt ? heard(f, onAccept) : null,

    // Focus as a sentence. The bare score is gone on purpose.
    f.focusQuality || why.length
      ? el('section', { class: 'md-block' }, [
          el('h3', { class: 'md-title', text: 'Focus' }),
          el('p', { class: 'md-focus', text: [f.focusQuality ? `${String(f.focusQuality)[0].toUpperCase()}${String(f.focusQuality).slice(1)}.` : null, why.join(', ')].filter(Boolean).join(' ') }),
        ])
      : null,

    // The evidence, named. `shellCommandCount` without the commands was a count
    // nobody could check; when the list is empty the count still says what it
    // knows, and says that it is only a count.
    el('section', { class: 'md-block' }, [
      el('h3', { class: 'md-title', text: 'Evidence' }),
      projectNode ? line(['project', 'Project'], projectNode) : null,
      f.gitBranch ? line(['branch', 'Branch'], String(f.gitBranch)) : null,
      typeof f.gitCommitCount === 'number' && f.gitCommitCount > 0 ? line(['commit', 'Commits'], String(f.gitCommitCount)) : null,
      Array.isArray(f.notableCommands) && f.notableCommands.length > 0
        ? line(['terminal', 'Commands'], el('span', { class: 'panel-value', text: f.notableCommands.join(' · ') }))
        : typeof f.shellCommandCount === 'number' && f.shellCommandCount > 0
          ? line(['terminal', 'Commands'], `${f.shellCommandCount} run, none recorded by name`)
          : null,
      f.processName ? line(['app', 'App'], String(f.processName)) : null,
      f.kind ? line(['more', 'Kind'], String(f.kind)) : null,
    ]),

    seen('On screen', f.windowTitles),
    seen('Pages', f.pages),
    seen('Read off the screen', f.screenTopics),

    // What this moment cost Gnomon to think about. Absent until the reader
    // carries it, rather than drawn as a zero.
    f.cost && typeof f.cost.calls === 'number' && f.cost.calls > 0
      ? el('section', { class: 'md-block' }, [
          el('h3', { class: 'md-title', text: 'What Gnomon spent on it' }),
          el('p', { class: 'md-cost', text: `${f.cost.calls} call${f.cost.calls === 1 ? '' : 's'}${f.cost.failed ? `, ${f.cost.failed} failed` : ''} · $${f.cost.costUsd.toFixed(4)} at list price${f.cost.purposes?.length ? ` · ${f.cost.purposes.join(', ')}` : ''}` }),
        ])
      : null,

    chips(f),
  ].filter((part) => part instanceof Node)
}

/** One measured thing: the mark that says what kind, and the value. */
const fact = (name, text, label) => el('span', { class: 'mb-fact' }, [icon(name, { label }), el('span', { text })])

/**
 * Everything on this moment that is a COUNT, as one wide strip.
 *
 * The full page states each of these as a labelled line down a narrow column;
 * opened under a table row that is already 1500px wide, that column read as a
 * tall stack of near-empty lines with a chasm down the middle. Here the icon
 * carries the dimension and the value carries the meaning, so a dozen facts fit
 * on two lines instead of a dozen.
 *
 * Nothing here is prose. If a thing needs a sentence to be understood it
 * belongs on the page, which is one click further on.
 */
export function momentFacts(m, { omit = [] } = {}) {
  const f = flatten(m)
  const skip = new Set(omit)
  const wall = typeof f.durationMin === 'number' ? f.durationMin : mins(f.durationMs)
  const active = typeof f.activeMin === 'number' ? f.activeMin : mins(f.activeMs)
  const project = projectName(f.projectId)
  const commands = Array.isArray(f.notableCommands) && f.notableCommands.length > 0 ? f.notableCommands.slice(0, 3).join(' · ') : typeof f.shellCommandCount === 'number' && f.shellCommandCount > 0 ? `${f.shellCommandCount} commands` : null
  const windows = Array.isArray(f.windowTitles) ? f.windowTitles.length : 0
  return [
    ['when', f.startTime ? `${clock(f.startTime)}${f.endTime ? `–${clock(f.endTime)}` : ''}` : null, 'time', 'When'],
    // Wall time and active time in one fact, because the gap between them is
    // the honest part and two separate numbers hide it.
    ['long', wall > 0 ? (active > 0 && active !== wall ? `${dur(wall)}, ${dur(active)} active` : dur(wall)) : null, 'seen', 'How long'],
    ['focus', f.focusQuality ? String(f.focusQuality) : null, 'read', 'Focus'],
    ['project', project, 'project', 'Project'],
    ['branch', f.gitBranch ? String(f.gitBranch) : null, 'branch', 'Branch'],
    ['commits', typeof f.gitCommitCount === 'number' && f.gitCommitCount > 0 ? `${f.gitCommitCount} commit${f.gitCommitCount === 1 ? '' : 's'}` : null, 'commit', 'Commits'],
    ['commands', commands, 'terminal', 'Commands'],
    ['app', f.processName ? String(f.processName) : null, 'app', 'App'],
    ['windows', windows > 1 ? `${windows} windows` : null, 'search', 'Windows seen'],
    ['cost', f.cost && f.cost.calls > 0 ? `$${f.cost.costUsd.toFixed(2)}` : null, 'cost', 'What Gnomon spent on it'],
  ]
    .filter(([key, text]) => text !== null && !skip.has(key))
    .map(([, text, mark, label]) => fact(mark, text, label))
}

/**
 * A moment folded open UNDER its own row.
 *
 * Not the page — the page is the third size, one click away. And not a second
 * copy of the row either: `omit` names what the surrounding surface ALREADY
 * shows, and the brief leaves it out. The Day's table has columns for the time,
 * the duration, the focus, the app, the project and the intent, so a fold
 * repeating all six read as the same moment printed three times over.
 *
 * What is left is what the table has no column for: the branch, the commits,
 * the commands, how many windows went past, what was said aloud, what the
 * thinking cost, and the context as chips. An empty return means the record
 * holds nothing the row has not already said, and the caller should not offer
 * a fold at all.
 */
export function momentBrief(m, { omit = [], sentence = true } = {}) {
  const f = flatten(m)
  const skip = new Set(omit)
  const intent = typeof f.intent?.text === 'string' && f.intent.text !== '' ? f.intent.text : null
  // When the intent is already in a column, its longer form is still worth
  // showing — but only if it actually says more than the column does.
  const reading = skip.has('intent') ? (f.narrative && f.narrative !== intent ? f.narrative : null) : intent
  const facts = momentFacts(m, { omit })
  const words = chipWords(f)
  const parts = [
    sentence ? el('p', { class: 'mb-sentence', text: momentSentence(m) }) : null,
    reading ? el('p', { class: 'mb-read', text: reading }) : null,
    // The owner's own words, when there are any. First-party evidence outranks
    // every inference, and it is never in a column.
    f.spokenExcerpt ? el('blockquote', { class: 'mb-quote', text: String(f.spokenExcerpt) }) : null,
    facts.length ? el('div', { class: 'mb-facts' }, facts) : null,
    words.length ? el('div', { class: 'md-chips' }, words.map((t) => el('span', { class: 'md-chip', text: t }))) : null,
  ].filter(Boolean)
  return parts
}

/**
 * A moment as ONE ROW, for a list of them.
 *
 * The same object, the same grammar, wherever a surface lists moments: the
 * Day's "Through the day", Today's "Just now", and whatever lists them next.
 * Two nearly-identical copies of this existed in two files, which is how one
 * list came to sort oldest-first while the other sorted newest-first.
 *
 * It is a door onto the full detail, so the row and the page it opens are the
 * same reading at two sizes.
 */
export function momentRow(m, { onAsk = null } = {}) {
  const f = flatten(m)
  const active = typeof f.activeMin === 'number' ? f.activeMin : mins(f.activeMs)
  const wall = typeof f.durationMin === 'number' ? f.durationMin : mins(f.durationMs)
  const shown = active || wall
  const project = projectName(f.projectId)
  // The intent pass's sentence first, then the window title it read, then the
  // app. A row that says only "Obsidian" is still a true row.
  const what = (typeof f.intent === 'string' ? f.intent : f.intent?.text) || f.title || f.processName || '—'
  // `m.meta` lets a caller say what the row is FOR instead — the entity card
  // says where a name appeared (in a meeting, on screen), which is its point.
  const meta = m.meta ?? [f.processName, project, f.gitBranch, f.location].filter(Boolean).join(' · ')
  return el(
    'button',
    {
      type: 'button',
      class: 'moment row-ask',
      title: `${clock(f.startTime)}${meta ? ` · ${meta}` : ''}`,
      'data-explore': f.id ? `moment:${f.id}` : onAsk ? `search:${what}` : null,
    },
    [
      el('span', { class: `moment-when${f.id ? ' door' : ''}`, 'data-explore': f.id ? `moment:${f.id}` : null, tabindex: f.id ? '0' : null, role: f.id ? 'link' : null, text: clock(f.startTime) }),
      el('span', { class: 'moment-what' }, [el('span', { class: 'moment-intent', text: what }), meta ? el('span', { class: 'moment-meta', text: meta }) : null]),
      f.focusQuality ? el('span', { class: `moment-dot focus-${f.focusQuality}`, title: `${f.focusQuality} focus` }) : null,
      el('span', { class: 'row-value', text: shown > 0 ? dur(shown) : '' }),
    ],
  )
}
