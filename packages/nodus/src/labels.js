// Label placing for a scene, on screen (stage.js, and Studio's runtime, which
// gets this file as text).

/** Do two placed labels overlap? (The tests' and the browser check's rule.) */
export const overlaps = (a, b) => a.x - a.w / 2 < b.x + b.w / 2 && b.x - b.w / 2 < a.x + a.w / 2 && a.y - a.h < b.y && b.y - b.h < a.y

// ── Margin labels, the engraving's key ──────────────────────────────────────
// Every part is named from the margin: labels stand in two columns beside the
// figure (or two rows above and below it when the set is wide), each column in
// the order of its parts' height on screen, with a hairline leader from the
// label to a small dot on the part. A column packs by construction (groups of
// labels that would touch merge and centre on their parts), then neighbours
// whose leaders cross swap places. A part alone in its region, with room above
// it that touches no other part, keeps its label beside it.

const PAD = 12
/** A part is alone in its region when no other part stands within this share of the plate's diagonal. */
const ALONE = 0.3

/** Do two segments cross (not merely touch at an end)? */
export function crosses([a, b], [c, d]) {
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
}

/** One column (or row) packed along an axis: `want` is each label's wished centre, `size` its extent; returns each start, none touching, groups kept within [lo, hi] when they fit. */
function pack1d(want, size, lo, hi) {
  const groups = []
  want.forEach((c, i) => {
    // `sum` is the sum of the group starts its labels wish for (each label's centre less its offset in the group).
    let g = { items: [i], size: size[i], sum: c - size[i] / 2 }
    for (;;) {
      g.start = Math.min(Math.max(g.sum / g.items.length, lo), Math.max(lo, hi - g.size))
      const prev = groups.at(-1)
      if (!prev || prev.start + prev.size <= g.start) break
      // Two groups that touch become one, centred on the mean of what its labels want.
      groups.pop()
      prev.sum += g.sum - prev.size * g.items.length
      prev.items.push(...g.items)
      prev.size += g.size
      g = prev
    }
    groups.push(g)
  })
  const out = new Array(want.length)
  for (const g of groups) {
    let at = g.start
    for (const j of g.items) {
      out[j] = at
      at += size[j]
    }
  }
  return out
}

/**
 * Place labels in the margins of a plate.
 * @param items `[{ id, x, y, w, h, hot? }]`, (x, y) the anchor on the part in pixels, w and h the label's box
 * @param plate `{ inner: { x0, y0, x1, y1 }, w, h }`: where the figure is drawn, and the whole plate
 * @param opts.wide labels above and below instead of beside (a set wider than the plate)
 * @param opts.discs `[{ x, y, r }]` the parts on screen, so a label kept beside its part touches none
 * @returns per item, in order: `{ id, side, x, y }` the box's top left, and `leader: [[x, y], [ax, ay]]`
 */
export function marginLabels(items, { inner, w = inner.x1 + inner.x0, h = inner.y1 + inner.y0 }, { wide = false, discs = [] } = {}) {
  const out = new Array(items.length)
  const near = (it) => items.some((o) => o !== it && Math.hypot(o.x - it.x, o.y - it.y) < ALONE * Math.hypot(w, h))
  // Discs are a part's radius; a box or a gear reaches further at its corners, hence the half again.
  const clearOf = (b) => discs.every((d) => d.x + d.r * 1.5 < b.x || d.x - d.r * 1.5 > b.x + b.w || d.y + d.r * 1.5 < b.y || d.y - d.r * 1.5 > b.y + b.h)
  const sides = { a: [], b: [] }
  items.forEach((it, i) => {
    const box = { x: it.x - it.w / 2, y: it.y - PAD - it.h - Math.max(0, ...discs.filter((d) => Math.hypot(d.x - it.x, d.y - it.y) < 1).map((d) => d.r * 1.5)), w: it.w, h: it.h }
    if (!near(it) && clearOf(box) && box.x >= inner.x0 && box.x + box.w <= inner.x1 && box.y >= inner.y0) out[i] = { id: it.id, side: 'inline', x: box.x, y: box.y, leader: [[it.x, box.y + box.h], [it.x, it.y]] }
    else sides[(wide ? it.y < (inner.y0 + inner.y1) / 2 : it.x < (inner.x0 + inner.x1) / 2) ? 'a' : 'b'].push(i)
  })
  for (const [key, list] of Object.entries(sides)) {
    if (!list.length) continue
    // Along the column: by the parts' height (or across the row: by their x), then packed.
    const along = wide ? 'x' : 'y'
    const ext = wide ? 'w' : 'h'
    list.sort((i, j) => items[i][along] - items[j][along] || i - j)
    const place = (order) => {
      const starts = pack1d(order.map((i) => items[i][along]), order.map((i) => items[i][ext] + (wide ? 10 : 4)), wide ? 4 : 4, (wide ? w : h) - 4)
      return order.map((i, k) => {
        const it = items[i]
        const s = starts[k]
        const box = wide
          ? { x: s + 5, y: key === 'a' ? inner.y0 - PAD - it.h : inner.y1 + PAD, w: it.w, h: it.h }
          : { x: key === 'a' ? inner.x0 - PAD - it.w : inner.x1 + PAD, y: s + 2, w: it.w, h: it.h }
        const from = wide ? [box.x + box.w / 2, key === 'a' ? box.y + box.h : box.y] : [key === 'a' ? box.x + box.w : box.x, box.y + box.h / 2]
        return { i, box, leader: [from, [it.x, it.y]] }
      })
    }
    // Untangle: neighbours whose leaders cross trade places, a few passes at most.
    let order = list
    let laid = place(order)
    for (let pass = 0; pass < list.length; pass++) {
      let swapped = false
      for (let k = 0; k + 1 < laid.length; k++) {
        if (!crosses(laid[k].leader, laid[k + 1].leader)) continue
        order = [...order]
        ;[order[k], order[k + 1]] = [order[k + 1], order[k]]
        laid = place(order)
        swapped = true
      }
      if (!swapped) break
    }
    for (const { i, box, leader } of laid) out[i] = { id: items[i].id, side: wide ? (key === 'a' ? 'top' : 'bottom') : key === 'a' ? 'left' : 'right', x: box.x, y: box.y, leader }
  }
  return out
}

/** How wide the margins must be for these labels: beside the figure, or above and below it. */
export function marginsFor(sizes, { w, h }, wide) {
  const widest = Math.max(0, ...sizes.map((s) => s[0]))
  const tall = Math.max(0, ...sizes.map((s) => s[1]))
  return wide ? { x: 16, y: Math.min(h * 0.22, tall + PAD + 8) } : { x: Math.min(w * 0.28, widest + PAD + 12), y: 14 }
}

/** A leader as drawn: a short shelf out of the label, then straight to the part, with a tick where it leaves the label; `k` scales it (a snapshot). */
export function leaderPath({ side, leader }, k = 1) {
  // The leader starts a little off its label, so the tick never touches the last letter.
  const off = (side === 'left' ? 4 : side === 'right' ? -4 : 0) * k
  const [[x0, y0], [x1, y1]] = leader.map(([x, y], i) => [(x + (i ? 0 : off / k)) * k, y * k])
  const f = (v) => v.toFixed(1)
  const shelf = 14 * k
  if (side === 'left' || side === 'right') {
    const sx = x0 + (side === 'left' ? shelf : -shelf)
    return `M${f(x0)},${f(y0 - 3 * k)}V${f(y0 + 3 * k)}M${f(x0)},${f(y0)}H${f(sx)}L${f(x1)},${f(y1)}`
  }
  if (side === 'top' || side === 'bottom') {
    const sy = y0 + (side === 'top' ? shelf : -shelf)
    return `M${f(x0 - 3 * k)},${f(y0)}H${f(x0 + 3 * k)}M${f(x0)},${f(y0)}V${f(sy)}L${f(x1)},${f(y1)}`
  }
  return `M${f(x0)},${f(y0)}L${f(x1)},${f(y1)}`
}
