// The scene's dice: a seeded generator, so a scene drawn twice is drawn the
// same (the same rain, the same cloud puffs, the same first guess for a
// solver). Nothing in a scene calls Math.random.

/** mulberry32: a 32-bit state, fast and good enough for placing puffs of cloud. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A spec's seed: its own, or FNV-1a over the title and the part ids, so a re-read with the same parts looks the same. */
export function seedOf(spec) {
  if (Number.isFinite(spec?.seed)) return spec.seed >>> 0
  let h = 0x811c9dc5
  for (const ch of [spec?.title ?? '', ...(spec?.lanes ?? []).map((l) => l.id)].join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return h
}

export const rngOf = (spec) => mulberry32(seedOf(spec))
