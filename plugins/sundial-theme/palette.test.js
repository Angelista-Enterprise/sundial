// The design, pinned against the client that actually draws it.
//
// Gnomon's client has no build step and no imports it could share a palette
// through: the colours are CSS custom properties in `shell/app.css` and the
// dial's geometry is a handful of constants in `shell/dial.js`. This pins both
// against the design's original notation in `design/`, so the drawing cannot
// drift from the design silently.
//
// Those Swift files used to live in `apps/macos-ui`, the second implementation
// of this design, deleted on 2026-09-03. They are frozen reference now —
// nothing builds them — and `design/README.md` explains why verbatim source
// nobody compiles beats a tidy JSON transcription: a constant is only pinned if
// it is pinned against something INDEPENDENT, and a table of numbers in the
// same tree is the file checking itself.
//
// It pins the LIVE client. `client.js` (the old tenant inside dsh's React app)
// is dark since Gnomon took over `/`, and pinning dead code proves nothing.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The views' source: views.js and the flat view-*.js files it re-exports (W4 step 14). */
const viewSource = () => readdirSync(join(HERE, 'shell')).filter((f) => f === 'views.js' || (f.startsWith('view-') && f.endsWith('.js') && !f.endsWith('.test.js'))).map((f) => readFileSync(join(HERE, 'shell', f), 'utf8')).join('\n')
const css = readFileSync(join(HERE, 'shell/app.css'), 'utf8')
const dial = readFileSync(join(HERE, 'shell/dial.js'), 'utf8')
const surfaces = readFileSync(join(HERE, 'shell/surfaces.js'), 'utf8')
const swift = readFileSync(join(HERE, 'design/GnomonColor.swift'), 'utf8')

/** `public static let page = Color(hex: "F0E9E3")` → `#F0E9E3`. */
function swiftHex(name) {
  const match = swift.match(new RegExp(`let ${name} = Color\\(hex: "([0-9A-Fa-f]{6})"\\)`))
  return match ? `#${match[1].toUpperCase()}` : null
}

/** `--ink-muted: #4a4743;` → `#4A4743`. */
function cssVar(token) {
  const match = css.match(new RegExp(`--${token}:\\s*(#[0-9A-Fa-f]{3,6})\\s*;`))
  return match ? match[1].toUpperCase() : null
}

/** GnomonColor's camelCase names, and the CSS custom properties they became. */
const TOKENS = [
  ['page', 'page'],
  ['panel', 'panel'],
  ['inkMuted', 'ink-muted'],
  ['superseded', 'superseded'],
  ['ochre', 'ochre'],
  ['navy', 'navy'],
  ['green', 'green'],
]

// `inkSubtle` and `inkFaint` LEFT this list on 2026-09-10, deliberately.
//
// Measured against `--panel`, the notation's values were 3.80:1 and 2.07:1.
// Both carry real text — every eyebrow, timestamp, unit and empty-state line
// in the product — and both were below the 4.5:1 floor, as was the ochre
// Gnomon speaks in, at 1.98:1. The paper is too close in value to carry four
// readable text tones, so light paper now has three and the fourth name
// resolves to the same value.
//
// They are pinned to the FLOOR instead of to the notation. That is a weaker
// pin and it is the honest one: the Swift file is a frozen record of a design
// that was wrong about this, and editing it to match would turn an independent
// check into the file checking itself.
const CONTRAST_PINNED = ['ink-subtle', 'ink-faint', 'ochre-text']

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Every `--name: #hex` inside one selector's block. */
function tokensIn(selector) {
  const block = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))[1]
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toUpperCase()]))
}

describe('the paper palette', () => {
  it.each(TOKENS)('carries %s over from GnomonColor.swift unchanged', (swiftName, cssName) => {
    const expected = swiftHex(swiftName)
    expect(expected, `GnomonColor.${swiftName} not found in the Swift source`).not.toBeNull()
    expect(cssVar(cssName)).toBe(expected)
  })

  // Two papers, one language. The dark block must redefine EVERY token the
  // light root defines and introduce none — a component that needs a colour the
  // token list does not have is a component that will be wrong on one paper.
  it('redefines every colour token for dark paper, and only those', () => {
    const rootBlock = css.match(/:root\s*\{([^}]*)\}/)[1]
    const lightTokens = [...rootBlock.matchAll(/--([a-z-]+):\s*(#|rgba)/g)].map((m) => m[1]).sort()
    const darkBlock = css.match(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/)[1]
    const darkTokens = [...darkBlock.matchAll(/--([a-z-]+):/g)].map((m) => m[1]).sort()
    expect(lightTokens.length).toBeGreaterThan(8)
    expect(darkTokens).toEqual(lightTokens)
  })

  // The guard that replaces the notation pin for the three text tones. It runs
  // on BOTH papers and against BOTH grounds, because `--panel` is the harder
  // one and is where the old values failed worst.
  it.each([
    [':root', 'light'],
    [":root\\[data-theme='dark'\\]", 'dark'],
  ])('keeps every text tone readable on %s paper', (selector) => {
    const t = tokensIn(selector)
    for (const name of CONTRAST_PINNED) {
      expect(t[name], `--${name} is not defined as a hex in this block`).toBeDefined()
      for (const ground of ['page', 'panel']) {
        const ratio = contrast(t[name], t[ground])
        expect(ratio, `--${name} on --${ground} is ${ratio.toFixed(2)}:1, below the 4.5:1 floor`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  // The identity ochre is exempt on purpose: it draws MARKS — the dial's now
  // line, a live dot, a bar — and a shape is not text. Every `color:` in the
  // sheet reaches for `--ochre-text` instead, and this is what stops the two
  // from being quietly swapped back.
  it('paints text with --ochre-text and marks with --ochre', () => {
    const afterTokens = css.split('* { box-sizing: border-box; }')[1]
    const asText = afterTokens.match(/(^|[;{ ])color: var\(--ochre\)/gm) ?? []
    expect(asText, 'a text colour reached for the mark ochre').toEqual([])
    expect(afterTokens).toMatch(/color: var\(--ochre-text\)/)
  })

  it('offers dark paper both ways: the system preference and an explicit choice', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/)
    expect(css).toMatch(/:root\[data-theme='dark'\]/)
    expect(css).toMatch(/:root\[data-theme='light'\]/)
  })

  it('keeps the one accent on both papers', () => {
    // The ochre is the identity. Dark paper may brighten it; it may not replace it.
    const dark = css.match(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/)[1]
    expect(dark).toMatch(/--ochre:\s*#e[0-9a-f]{5}/i)
  })

  it('uses no colour literal outside the token blocks', () => {
    // Everything after the token blocks must reach colour through var(). A
    // literal rgba(0,0,0,…) hover wash is invisible on dark paper.
    const afterTokens = css.split('* { box-sizing: border-box; }')[1]
    const literals = afterTokens.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,6}\b/g) ?? []
    expect(literals).toEqual([])
  })

  it('draws the icon catalogue in the text’s own colour, never its own', () => {
    // The same rule as the stylesheet's, held against the one file that draws
    // shapes in JS. An icon takes `currentColor` so it reads on both papers and
    // needs no token; a literal here would be invisible on one of them.
    const icons = readFileSync(join(HERE, 'shell/icons.js'), 'utf8')
    expect(icons.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,6}\b/g) ?? []).toEqual([])
    expect(icons).toContain("stroke: 'currentColor'")
  })

  it('holds the rule that carries the look: no radius anywhere', () => {
    // Not a `!important` override any more — the client owns its own sheet, so
    // the absence of a radius IS the implementation. This guards the absence.
    const radii = css.match(/border-radius:\s*([^;]+);/g) ?? []
    expect(radii.filter((rule) => !/:\s*(0|999px)\b/.test(rule))).toEqual([])
  })

  it('never caps a card\'s content at a percentage of nothing', () => {
    // The web card's excerpt was `max-height: 38%` inside an `auto` grid track,
    // which is a percentage of an indefinite height, which is a percentage of
    // nothing: the reading was cut at an unpredictable place with no ellipsis
    // and no sign it had been cut. A card's content is capped in its own units
    // — lines, ems, a `minmax(0,1fr)` track — or it is not capped.
    //
    // `vh` is allowed: the viewport HAS a definite height, and the two uses of
    // it are overlays sized against the window rather than against a card.
    // Comments stripped first: this reads the rules, not the prose about them —
    // the note above `.web-excerpt` quotes the very value it warns against.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const percentCaps = (rules.match(/max-height:\s*[0-9.]+%/g) ?? []).filter((rule) => !/max-height:\s*100%/.test(rule))
    expect(percentCaps).toEqual([])
  })

  it('gives the card\'s body the flexible row by name', () => {
    // The frame is `auto auto minmax(0,1fr)` — head, remark, body — and the
    // remark is `hidden` on almost every card. A hidden element is not a grid
    // item, so the body silently fell back to the second track, which is
    // `auto`: it sized to its content and left the whole flexible third track
    // standing empty below it. 115px of dead card under a list that looked
    // chopped off. Naming the rows is the fix, and this guards the naming.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const [selector, row] of [['.pane-head', 1], ['.pane-remark', 2], ['.pane-body', 3]]) {
      expect(new RegExp(`\\${selector} \\{[^}]*grid-row: ${row};`).test(rules), `${selector} must declare grid-row: ${row}`).toBe(true)
    }
  })

  it('leans only the surfaces on the roster, because a lean costs sharpness', () => {
    // A rotated layer is composited off the pixel grid, so every glyph on it is
    // resampled and comes out soft. The strata leaned like the plates do, and
    // the owner read the card once and said the text was not sharp — on a card
    // whose whole subject is fourteen rows of labels and numbers.
    //
    // A lean is for a DRAWING with a few large marks, never for a surface the
    // owner reads. So the surfaces allowed to lean are a roster, like the icon
    // catalogue: adding one means deciding out loud that nothing on it is read.
    // The day-end strip came OFF this roster on the owner's verdict — "I don't
    // like this one at all with its 3d aspects" — and it should never have been
    // on it: every slab was a value, and a value is read.
    const LEANS = ['.plate', '.surface-body:has(> svg)', '.gauges', '.bins', '.focus-track', '.sd-stage']
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const leaning = [...rules.matchAll(/([^{}]+)\{[^}]*transform:[^;]*rotate[XY]\(/g)]
      .flatMap(([, selector]) => selector.split(','))
      .map((s) => s.trim().replace(/:hover$/, ''))
      .filter(Boolean)
    expect([...new Set(leaning)].filter((s) => !LEANS.includes(s))).toEqual([])
  })

  it('keeps a per-row control legible at rest, and only boxes it under the hand', () => {
    // Four ways to change a state, on thirteen goals, is fifty-two bordered
    // boxes drawn over the thing the owner came to read. The answer is not to
    // hide them — "how do I add a goal" is exactly what a hidden affordance
    // costs — but to take the BOX away at rest and leave the word.
    //
    // So the rule is two-sided and both sides matter: a repeated row control
    // that clears its border must still declare a colour at rest, and must get
    // the border back on `:hover` or `:focus-within` of its row.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const cleared = [...rules.matchAll(/([^{}]+)\{[^}]*border-color: transparent/g)]
      .flatMap(([, s]) => s.split(',').map((x) => x.trim()))
      .filter((s) => s.endsWith('.act'))
    expect(cleared.length, 'this rule has nothing to hold if no control clears its border').toBeGreaterThan(0)
    for (const selector of cleared) {
      const block = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(rules)?.[1] ?? ''
      expect(/color: var\(--/.test(block), `${selector} clears its border, so it must still name an ink at rest`).toBe(true)
      const base = selector.replace(/^\.sb[^ ]* /, '').trim()
      // The state can sit on the ROW rather than in front of it —
      // `.goal:hover .goal-acts .act` puts it in front, `.fact-line:hover
      // .verdicts .act` attaches it to the first token — so the state is
      // stripped before comparing, and what must match is the selector itself.
      const restored = [...rules.matchAll(/([^{}]+)\{[^}]*border-color:[^}]*\}/g)]
        .flatMap(([, s]) => s.split(','))
        .filter((s) => /:hover|:focus-within/.test(s))
        .map((s) => s.replace(/:hover|:focus-within/g, '').replace(/\s+/g, ' ').trim())
      expect(
        restored.some((s) => s === base || s.endsWith(` ${base}`) || base.endsWith(s)),
        `${base} must take its border back under the hand or the keyboard`,
      ).toBe(true)
    }
  })

  it('ends every grid that holds a shared axis on the same track', () => {
    // A small picture on a row is a column, and a fold's picture is part of the
    // same column. The people card draws one axis for the whole list: the
    // person's own trail on the line, each of their meetings under it, and each
    // person who shared one under that. They land on the same scale only if
    // every one of those grids ENDS on the same fixed track — neither grid has
    // right padding, so a matching last track is what makes the columns align
    // whatever the fold's indent is. Change one and the marks stop meaning
    // anything, silently.
    // Media blocks are dropped first: the narrow layout drops the axis
    // altogether, so its shorter track list is the point, not a violation.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(?:media|container)[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '')
    const wide = [...rules.matchAll(/([^{}]*)\{[^}]*grid-template-columns:([^;]+);/g)]
      .filter(([, selector]) => /person-line|person-met-list li|person-with-list li/.test(selector))
      .map(([, selector, tracks]) => [selector.trim(), tracks.trim().split(/\s+/).pop()])
    // All three grids must be present — the row, its meetings, and the people
    // who shared them — however few rules they are written as.
    for (const grid of ['.person-line', '.person-met-list li', '.person-with-list li'])
      expect(wide.some(([selector]) => selector.includes(grid)), `${grid} must sit on the shared axis`).toBe(true)
    const tracks = new Set(wide.map(([, last]) => last))
    expect(tracks.size, `every grid on the shared axis must end on one track, found ${[...tracks].join(' / ')}`).toBe(1)
  })

  it('reserves exactly the track the trail is drawn at, on every list that draws one', () => {
    // Two numbers, in two files, that must be one number: `goalTrail({width})`
    // decides how many pixels the SVG is painted at, and the row's last grid
    // track decides how many it is given. They agree today at 200 on the
    // goals, people and memory lists — and if one drifts, the axis silently
    // starts or stops at a different x on that card while the legend, the
    // header and every neighbouring row keep saying it did not. Nothing about
    // the picture looks broken; it is simply no longer the same scale.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(?:media|container)[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '')
    const views = viewSource()
    const drawn = new Set([...views.matchAll(/goalTrail\(\{[^}]*width:\s*(\d+)/g)].map(([, w]) => w))
    expect(drawn.size, `every trail must be drawn at one width, found ${[...drawn].join(' / ')}`).toBe(1)
    const lists = ['.goal-line', '.person-line', '.mem-line']
    for (const grid of lists) {
      const rule = [...rules.matchAll(/([^{}]*)\{[^}]*grid-template-columns:([^;]+);/g)].find(([, selector]) => selector.trim().includes(grid))
      expect(rule, `${grid} must name its tracks`).toBeTruthy()
      expect(rule[2].trim().split(/\s+/).pop(), `${grid} must end on the track the trail is drawn at`).toBe(`${[...drawn][0]}px`)
    }
  })

  it('keeps every clock column and its hour labels on one track', () => {
    // Two cards draw ONE clock down a column — the rituals' usual windows, and
    // the asks' asked-at and how long the owner was left holding it — and on
    // each the hour labels sit on the same track at the head. They mean
    // anything only while both grids END on the same fixed track: change one
    // and every band silently moves off the hour naming it. Held across both
    // cards rather than per card, because `dayClock`'s drawn width is one
    // number in one file and these are the tracks it is given.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(?:media|container)[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '')
    const wide = [...rules.matchAll(/([^{}]*)\{[^}]*grid-template-columns:([^;]+);/g)]
      .filter(([, selector]) => /\.ritual-line|\.ritual-head\b|\.question-line|\.question-head\b/.test(selector))
      .map(([, selector, tracks]) => [selector.trim(), tracks.trim().split(/\s+/).pop()])
    for (const grid of ['.ritual-line', '.ritual-head', '.question-line', '.question-head']) expect(wide.some(([selector]) => selector.includes(grid)), `${grid} must sit on the shared clock`).toBe(true)
    const tracks = new Set(wide.map(([, last]) => last))
    expect(tracks.size, `every clock row and its hour labels must end on one track, found ${[...tracks].join(' / ')}`).toBe(1)
    // And that track is the width the picture is actually painted at.
    const drawn = new Set([...viewSource().matchAll(/dayClock\(\{[^}]*width:\s*(\d+)/g)].map(([, w]) => w))
    expect(drawn.size, `every clock must be drawn at one width, found ${[...drawn].join(' / ')}`).toBe(1)
    expect([...tracks][0], 'the clock track and the width dayClock paints at are one number').toBe(`${[...drawn][0]}px`)
  })

  it('does not give the Unsaid row a picture of its own', () => {
    // The owner's verdict on the first draw of that card: "now all cards have
    // the same feeling and information depiction." Five lists already put a
    // mark per row on a shared horizontal axis, and drawn that way the Unsaid
    // card was indistinguishable from the asks card beside it — and answering
    // the wrong question, because a band per row says where THIS decision sat
    // while the card exists to ask where the BAR should sit. Its picture is
    // one ladder above the list. This holds the row free of a picture track:
    // every track it names is a text column in `rem` or `auto`.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const row = [...rules.matchAll(/([^{}]*)\{[^}]*grid-template-columns:([^;]+);/g)].find(([, selector]) => selector.trim().startsWith('.gate-line'))
    expect(row, '.gate-line must name its tracks').toBeTruthy()
    for (const track of row[2].trim().split(/\s+/)) {
      expect(/px/.test(track), `.gate-line must not carry a pixel picture track, found ${track}`).toBe(false)
    }
    expect(/\.gate-mark-cell|\.gate-axis\b/.test(css), 'the per-row axis must be gone, not merely unused').toBe(false)
  })

  it('draws the ladder at the size it was measured at, and caps it in pixels', () => {
    // One user unit per pixel: the slab has a real height in `px`, the picture
    // fills it, and `gateLadder` takes the measured numbers rather than
    // scaling a fixed viewBox to fit. A percentage height here is a percentage
    // of an indefinite track, which is the cut-off-at-an-unpredictable-place
    // bug this client has already paid for.
    const slab = /\.ladder-slab\s*\{[^}]*height:\s*([0-9]+)px/.exec(css)
    expect(slab, 'the ladder slab must be capped in pixels').toBeTruthy()
    expect(Number(slab[1]), 'tall enough that the band under the bar can separate').toBeGreaterThanOrEqual(300)
    const source = readFileSync(join(HERE, 'shell/gate-ladder.js'), 'utf8')
    expect(/setAttribute\('viewBox', `0 0 \$\{width\} \$\{height\}`\)/.test(source), 'the viewBox must be the measured box').toBe(true)
    expect(/ResizeObserver/.test(viewSource()), 'and a card the owner drags must repaint').toBe(true)
  })

  it('sizes a card against its pane, not against the window', () => {
    // A pane is dragged to whatever width the owner wants; the window is
    // whatever the screen is. A card that asks the WINDOW how much room it has
    // gets an answer about somewhere else. Measured 2026-09-22: the asks row's
    // breakpoint fired at a 1600px window while the card sat in a 1120px pane,
    // so the row kept all six of its tracks and the question was drawn at
    // 195px — four words and an ellipsis, the template wall the card had just
    // been redesigned out of. `container-type` is the fix and this holds it:
    // the card declares a container, and every breakpoint that reshapes its row
    // is a `@container` query keyed on that.
    // Held for both cards with a row on a shared axis. The Unsaid card was
    // built after the rule was written and would have hit it for the same
    // reason: its axis track is 380px fixed, so a row reshaped against the
    // window loses the observation to an ellipsis inside a narrow pane.
    for (const [list, row] of [
      ['.question-list', 'question'],
      ['.gate-list', 'gate'],
    ]) {
      expect(new RegExp(`\\.view:has\\(\\${list}\\)[^{}]*\\{[^}]*container-type:\\s*inline-size`).test(css), `${list} must be its own container`).toBe(true)
      const named = new RegExp(`\\.view:has\\(\\${list}\\)[^{}]*\\{[^}]*container-name:\\s*([a-z-]+)`).exec(css)
      expect(named, `${list} must NAME its container, so a query cannot bind to the wrong ancestor`).toBeTruthy()
      for (const [, condition, block] of css.matchAll(/@media([^{]*)\{((?:[^{}]*\{[^}]*\})*)/g)) {
        expect(new RegExp(`\\.${row}-(line|head)\\b`).test(block), `a window query must not reshape the ${row} row: @media${condition.trim()}`).toBe(false)
      }
      expect(css.includes(`@container ${named[1]} `), `the ${row} row must be reshaped by a container query`).toBe(true)
    }
  })

  it('hides a word the picture is carrying, and never deletes it', () => {
    // A picture that says WHEN retires the word beside it. On the people row
    // that retirement is conditional — the trail is the first thing to go below
    // 860px, and a person with no meetings has nothing to draw — so the word is
    // RENDERED on every row and taken back by `visibility`, which keeps the
    // track's width, the reading order and the screen reader intact.
    //
    // Two things this holds. `display: none` would collapse the track and make
    // the trail start at a different x on the rows that kept their word, which
    // is the one thing the shared axis exists to prevent. And the hiding must be
    // inside a min-width query, or the narrow layout loses its recency entirely.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const hidden = [...rules.matchAll(/@media \(min-width[^{]*\{\s*([^{}]+)\{([^}]*)\}/g)].filter(([, , block]) => /visibility: hidden/.test(block))
    expect(hidden.length, 'this rule has nothing to hold if no word defers to a picture').toBeGreaterThan(0)
    for (const [, selector] of hidden) {
      expect(/:not\(/.test(selector), `${selector.trim()} must defer only where the picture actually carries it`).toBe(true)
      const base = selector.trim().replace(/:not\([^)]*\).*$/, '')
      expect(new RegExp(`\\${base} \\{[^}]*color: var\\(--`).test(rules), `${base} must still name an ink: it is shown whenever the picture cannot speak for it`).toBe(true)
      expect(/display: none/.test(rules.slice(rules.indexOf(selector), rules.indexOf(selector) + 200)), `${base} must keep its grid track — display:none moves the axis`).toBe(false)
    }
  })

  it('separates surfaces with hairlines and never with lift', () => {
    // One shadow is permitted and is not elevation: the hover bleed on an
    // askable row, which paints the same flat wash past its own edges.
    const shadows = css.match(/box-shadow:\s*([^;]+);/g) ?? []
    expect(shadows.every((rule) => rule.includes('var(--wash)'))).toBe(true)
  })
})

describe('the energy curve', () => {
  it('reads the score as an integer 0-100, the way DialModel.swift does', () => {
    // Treating it as a fraction clamps every hour to full height and draws the
    // whole day as one solid block — the first thing that went wrong here.
    const model = readFileSync(join(HERE, 'design/DialModel.swift'), 'utf8')
    expect(model).toMatch(/score \/ 100/)
    expect(dial).toMatch(/ENERGY_FULL_SCALE = 100/)
  })

  // The client and the Swift notation diverge HERE, on purpose, and this pins
  // the divergence so it stays a decision rather than a drift: the score keeps
  // the notation's 0-100 meaning, and only its HEIGHT on the plate is shaped.
  // Real hours run about 2-33, so drawn linearly every day is the same flat
  // line along the baseline.
  it('draws the curve through the plate transform, not the raw fraction', () => {
    expect(dial).toMatch(/plateFraction\(p\.score\)/)
    expect(dial).toMatch(/export const plateFraction = \(score\) => Math\.sqrt\(energyFraction\(score\)\)/)
  })
})

describe('the dial plate', () => {
  it('is authored against the same 1000x150 plate as Dial.swift', () => {
    const source = readFileSync(join(HERE, 'design/Dial.swift'), 'utf8')
    const swiftValue = (name) => Number(source.match(new RegExp(`let ${name}: CGFloat = ([0-9.]+)`))?.[1])
    const clientValue = (name) => Number(dial.match(new RegExp(`export const ${name} = ([0-9.]+)`))?.[1])

    expect(clientValue('PLATE_H')).toBe(swiftValue('plateH'))
    expect(clientValue('BASELINE_Y')).toBe(swiftValue('baselineY'))
    expect(clientValue('CURVE_TOP_Y')).toBe(swiftValue('curveTopY'))
    expect(clientValue('DEEP_Y')).toBe(swiftValue('deepY'))
    expect(clientValue('DEEP_H')).toBe(swiftValue('deepH'))
    expect(clientValue('BAND_Y')).toBe(swiftValue('bandY'))
    expect(clientValue('BAND_H')).toBe(swiftValue('bandH'))
  })
})

describe('the mark grammar', () => {
  it('colours every surface from the mark, so certainty cannot be invented', () => {
    // observed is ink, verified is green, derived and inferred share the one
    // ochre, absent is the superseded grey. A renderer that picked its own
    // colour could show a guess as a fact.
    for (const mark of ['observed', 'verified', 'derived', 'inferred', 'absent']) {
      expect(surfaces, `MARK_FILL is missing ${mark}`).toMatch(new RegExp(`${mark}:\\s*C\\.`))
    }
  })
})
