// Markdown, rendered to DOM.
//
// The model answers in Markdown — headings, lists, tables, fenced code, links —
// and the canvas was showing it verbatim: literal asterisks, literal backticks,
// `- ` at the start of every bullet.
//
// WHY IT IS WRITTEN HERE rather than pulled in. There is no build step for this
// client, so a library means either a bundler or a CDN, and a CDN means a
// local-first product that renders its own record worse when the network is
// gone. This is a few hundred lines against a format the model actually emits.
//
// WHY IT BUILDS NODES and never touches innerHTML. The text is model output —
// the least trusted thing in the system, since a tool result it read could have
// carried anything. Constructing elements makes injection impossible by
// construction rather than by remembering to escape, and no amount of `<script>`
// in a paragraph can become one.
//
// WHAT IT DELIBERATELY DOES NOT DO: reference links, footnotes, HTML
// pass-through, setext headings, loose-vs-tight list semantics. None of them
// appear in an assistant's answer, and each one is a place to be subtly wrong.
import { el } from './surfaces.js'

/** Schemes a link may use. Anything else renders as its own text. */
const SAFE_LINK = /^(https?:\/\/|mailto:|\/)/i

/**
 * `board:<card id>` — a place on the board rather than a page on the web.
 *
 * WHY. Gnomon says "the goals card on your board should read accordingly now"
 * and the owner then has to go find it. The card is already on screen beside
 * the words, so the shortest distance between the sentence and the thing it
 * names is one click. `board:` on its own frames the whole board.
 *
 * It is a BUTTON, not an anchor: nothing is being navigated to, and an `<a>`
 * with a dead href reads wrong to a screen reader. The click leaves by a
 * document event because `stage.js` imports this file — the arrow may only
 * point one way.
 */
const BOARD_LINK = /^board:(.*)$/i

/**
 * The name of the card this id opens, or null when it opens none. Set by the
 * app from the stage; null everywhere else, so a note card or a test renders
 * the same words with nothing clickable rather than a link into nothing.
 *
 * WHY THE CLIENT DECIDES rather than the writer. Asked to link its cards, the
 * model wrote `**[inst:goals]**` — the brackets, none of the target — and in
 * the next turn named `work`, `threads` and `day` in backticks with no link at
 * all. Prompting harder buys a model that complies most of the time, which is
 * a feature that works most of the time. The card ids are a CLOSED set the
 * client already holds, so the client can recognise one wherever it appears
 * and make it a place. The writer is then free to name cards the way it
 * naturally does, which is what it was going to do anyway.
 *
 * It answers with the card's NAME, not a yes: `inst:goals` is a link that
 * reads "Goals". The id is how the record addresses a card and how the model
 * names one; it is not something the owner should ever have to read.
 */
let cardLabel = () => null
export const setCardLabel = (fn) => {
  cardLabel = fn
}

/** The one shape a board link takes, wherever it was recognised — and in a card that points at the card owning a fact. */
export function boardLink(id, children) {
  return el('button', {
    type: 'button',
    class: 'board-link',
    title: id === '' ? 'Show the whole board' : `Open ${cardLabel(id) ?? id} on the board`,
    onclick: () => document.dispatchEvent(new CustomEvent('gnomon:card', { detail: id })),
  }, children)
}

/** A fence: ``` or ~~~, with an optional language. */
const FENCE = /^(\s*)(```+|~~~+)\s*([^\s`]*)\s*$/

const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const NUMBER = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const TABLE_RULE = /^\s*\|?[\s:-]*[-][\s|:-]*$/

// ── Inline ────────────────────────────────────────────────────────────────

/**
 * The inline forms, tried by earliest match rather than in list order, so
 * `**bold** and \`code\`` resolves left to right the way it reads.
 *
 * A code span is LITERAL: its content is not re-scanned, which is the whole
 * reason to write `**` inside backticks.
 */
const INLINE = [
  // A card id in backticks — `work`, `threads`, `inst:goals` — is the shape the
  // model reaches for on its own, so that is a place too, and it reads as the
  // card's name rather than as the address the model happened to type.
  { re: /`([^`\n]+)`/, ok: (m) => cardLabel(m[1]) !== null, build: (m) => boardLink(m[1], [document.createTextNode(cardLabel(m[1]))]) },
  { re: /`([^`\n]+)`/, build: (m) => el('code', { text: m[1] }) },
  { re: /\*\*([^\n]+?)\*\*/, build: (m) => el('strong', {}, inline(m[1])) },
  { re: /__([^\n]+?)__/, build: (m) => el('strong', {}, inline(m[1])) },
  { re: /~~([^\n]+?)~~/, build: (m) => el('del', {}, inline(m[1])) },
  // Single-character emphasis last, and required to hug a non-space, so a
  // stray asterisk or a snake_case identifier is left alone.
  { re: /\*(?!\s)([^*\n]+?)(?<!\s)\*/, build: (m) => el('em', {}, inline(m[1])) },
  { re: /(?<![A-Za-z0-9_])_(?!\s)([^_\n]+?)(?<!\s)_(?![A-Za-z0-9_])/, build: (m) => el('em', {}, inline(m[1])) },
  {
    // A board target may hold a space (`entity:Mira Bakker`); a URL may not.
    re: /\[([^\]\n]*)\]\((board:[^)\n]*|[^)\s]+)(?:\s+"[^"]*")?\)/,
    build: (m) => {
      const place = BOARD_LINK.exec(m[2])
      if (place !== null) {
        const id = place[1].trim()
        // Its own words when it wrote any; the card's name when it did not.
        return boardLink(id, m[1] ? inline(m[1]) : [document.createTextNode(cardLabel(id) || id || 'the board')])
      }
      // An unsafe scheme is not an error and not a silent drop: the link's own
      // text is what the model meant to say, so it says it, plainly.
      if (!SAFE_LINK.test(m[2])) return document.createTextNode(m[1] || m[2])
      return el('a', { href: m[2], target: '_blank', rel: 'noreferrer noopener' }, inline(m[1] || m[2]))
    },
  },
  // `[inst:goals]` with no target: asked for a link to a card, the model writes
  // the brackets and forgets the rest. It named the card; that is enough. LAST,
  // so a real `[text](url)` starting at the same place wins the tie.
  { re: /\[([^\]\n]+)\]/, ok: (m) => cardLabel(m[1]) !== null, build: (m) => boardLink(m[1], [document.createTextNode(cardLabel(m[1]))]) },
]

/** One line of inline Markdown → an array of nodes. */
export function inline(text) {
  const out = []
  let rest = String(text ?? '')

  while (rest !== '') {
    let best = null
    for (const form of INLINE) {
      const match = form.re.exec(rest)
      if (match === null) continue
      // A form may decline what it matched — a code span is only a place when
      // the words inside it name a card that is there.
      if (form.ok && !form.ok(match)) continue
      if (best === null || match.index < best.match.index) best = { form, match }
    }
    if (best === null) break

    const { form, match } = best
    if (match.index > 0) out.push(document.createTextNode(rest.slice(0, match.index)))
    out.push(form.build(match))
    rest = rest.slice(match.index + match[0].length)
  }

  if (rest !== '') out.push(document.createTextNode(rest))
  return out
}

/** Inline, with a single newline drawn as a break. */
function inlineLines(text) {
  const out = []
  const lines = String(text ?? '').split('\n')
  lines.forEach((line, i) => {
    if (i > 0) out.push(el('br'))
    out.push(...inline(line))
  })
  return out
}

// ── Blocks ────────────────────────────────────────────────────────────────

const indentOf = (line) => (line.match(/^\s*/)?.[0].length ?? 0)

/**
 * A list, consuming every line that belongs to it — including continuation
 * lines and nested lists, which are recognised by indent alone.
 *
 * @returns [element, index of the first line after the list]
 */
function takeList(lines, start, ordered) {
  const pattern = ordered ? NUMBER : BULLET
  const base = indentOf(lines[start])
  const list = el(ordered ? 'ol' : 'ul')
  let i = start

  while (i < lines.length) {
    const match = pattern.exec(lines[i])
    if (match === null || indentOf(lines[i]) !== base) break

    // Everything more-indented than this marker belongs to this item.
    const own = [match[3]]
    i += 1
    while (i < lines.length && lines[i].trim() !== '' && indentOf(lines[i]) > base) {
      own.push(lines[i].slice(base + 2))
      i += 1
    }
    // A blank line inside a list does not end it, as long as the next line is
    // still part of it. Models indent continuation paragraphs this way.
    if (i < lines.length && lines[i].trim() === '' && i + 1 < lines.length && indentOf(lines[i + 1]) > base) {
      own.push('')
      i += 1
      while (i < lines.length && lines[i].trim() !== '' && indentOf(lines[i]) > base) {
        own.push(lines[i].slice(base + 2))
        i += 1
      }
    }

    const item = el('li')
    for (const node of blocks(own, { tight: true })) item.append(node)
    list.append(item)
  }

  return [list, i]
}

/**
 * A pipe table. The header separator is what makes it one — a lone row of
 * pipes is far more often prose than a table.
 *
 * @returns [element, next index] or null when these lines are not a table.
 */
function takeTable(lines, start) {
  if (start + 1 >= lines.length) return null
  if (!TABLE_ROW.test(lines[start]) || !TABLE_RULE.test(lines[start + 1])) return null

  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())

  // `:---:` and `---:` are alignment, and a right-aligned column is nearly
  // always the numeric one — which is exactly where tabular figures belong.
  const aligns = cells(lines[start + 1]).map((spec) => {
    if (/^:.*:$/.test(spec)) return 'center'
    if (/:$/.test(spec)) return 'right'
    return null
  })

  const head = el('tr')
  cells(lines[start]).forEach((cell, i) => head.append(el('th', { class: aligns[i] === 'right' ? 'num' : null }, inline(cell))))

  const body = el('tbody')
  let i = start + 2
  while (i < lines.length && TABLE_ROW.test(lines[i])) {
    const row = el('tr')
    cells(lines[i]).forEach((cell, index) => row.append(el('td', { class: aligns[index] === 'right' ? 'num' : null }, inline(cell))))
    body.append(row)
    i += 1
  }

  return [el('div', { class: 'md-table' }, [el('table', { class: 'grid' }, [el('thead', {}, head), body])]), i]
}

/**
 * Lines → block elements.
 *
 * `tight` suppresses the paragraph wrapper around a list item's first line, so
 * a one-line bullet is not a paragraph inside a list item.
 */
function blocks(lines, { tight = false } = {}) {
  const out = []
  let i = 0
  let paragraph = []

  const flush = () => {
    if (paragraph.length === 0) return
    const text = paragraph.join('\n')
    // In a tight list item the content is the item, not a paragraph in it.
    out.push(tight && out.length === 0 ? el('span', {}, inlineLines(text)) : el('p', {}, inlineLines(text)))
    paragraph = []
  }

  while (i < lines.length) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence !== null) {
      flush()
      const marker = fence[2][0]
      const body = []
      i += 1
      // An UNCLOSED fence is the normal case mid-stream: the model is still
      // typing the code. The rest of the text is the block, and it closes
      // itself when the closing fence arrives on a later delta.
      while (i < lines.length && !(lines[i].trimStart().startsWith(marker.repeat(3)) && lines[i].trim().replace(/[`~]/g, '') === '')) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      out.push(el('pre', { class: 'md-pre', 'data-lang': fence[3] || null }, [el('code', { text: body.join('\n') })]))
      continue
    }

    if (line.trim() === '') {
      flush()
      i += 1
      continue
    }

    if (RULE.test(line)) {
      flush()
      out.push(el('hr', { class: 'md-hr' }))
      i += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flush()
      out.push(el(`h${heading[1].length}`, { class: 'md-h' }, inline(heading[2])))
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      flush()
      const quoted = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])[1])
        i += 1
      }
      out.push(el('blockquote', { class: 'md-quote' }, blocks(quoted)))
      continue
    }

    const table = takeTable(lines, i)
    if (table !== null) {
      flush()
      out.push(table[0])
      i = table[1]
      continue
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      flush()
      const [list, next] = takeList(lines, i, NUMBER.test(line))
      out.push(list)
      i = next
      continue
    }

    paragraph.push(line)
    i += 1
  }

  flush()
  return out
}

/**
 * Markdown → a fragment ready to append.
 *
 * Safe to call on a partial document: the parser has no state that outlives one
 * call, and an unterminated fence, list or emphasis renders as the
 * in-progress thing it is rather than swallowing the rest of the answer.
 */
export function renderMarkdown(text) {
  const fragment = document.createDocumentFragment()
  for (const node of blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'))) fragment.append(node)
  return fragment
}
