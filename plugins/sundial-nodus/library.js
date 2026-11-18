// The library: walks Jev passed, kept so a like ask starts from one that worked.
//
// What is kept is the ask, the view and the walk (its sentences and the ids
// they point at), never the parts: the parts are the record's and are re-read;
// the walk is the craft. The same figure asked again within the hour reuses
// its kept walk outright (`reuse`), with no model call. An entry is
// kept only when the critic scored it at least KEEP_FITS of 3, and is found
// again by the ask's embedding (the same local scheme @sundial/memory uses,
// computed over the owner's own already-sanitized words, never sent anywhere).
//
// A runtime file beside brief-given.json, not the record: it is derived from
// the board's `nodus` placements and can be thrown away; the figures
// themselves stay in the log as their `board:place` signals.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const KEEP_FITS = 2
/** A kept walk stands for the same figure (view, shape, day) this long; after it the record has moved on. */
const REUSE_MS = 3_600_000
const MAX_ENTRIES = 400
const MIN_LIKE = 0.35

/** Both vectors are normalized, so the dot product is the cosine. */
const cosine = (a, b) => (a.length !== b.length ? 0 : a.reduce((n, x, i) => n + x * b[i], 0))

/**
 * @param file the JSONL path
 * @param embed (text) → { vector, model }, normalized
 */
export function createLibrary({ file, embed }) {
  // Read once, on first use: a cache of the file, which stays the truth.
  const held = { entries: null }
  const load = () => {
    if (held.entries) return held.entries
    try {
      held.entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).slice(-MAX_ENTRIES)
    } catch {
      held.entries = []
    }
    return held.entries
  }

  /** Keep a walk the critic passed. Returns whether it was kept. */
  async function keep(spec) {
    const fits = spec?.by?.critic?.fits
    if (spec?.by?.storyboard !== 'model' || !(fits >= KEEP_FITS) || !spec.ask) return false
    const { vector, model } = await embed(spec.ask)
    const entry = { at: new Date().toISOString(), ask: spec.ask, view: spec.view, source: spec.source ?? null, fits, title: spec.headline || spec.title, steps: spec.steps.map((s) => s.say), walk: spec.steps, model, vector: vector.map((x) => Math.round(x * 1e4) / 1e4) }
    load().push(entry)
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch (error) {
      console.warn(`[sundial-nodus] library entry not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  /** The kept walks nearest this ask for this view, best first; only one per ask. */
  async function like(ask, view, k = 2) {
    const held = load().filter((e) => e.view === view)
    if (held.length === 0 || !ask) return []
    const { vector, model } = await embed(ask)
    const seen = new Set()
    return held
      .filter((e) => e.model === model)
      .map((e) => ({ e, s: cosine(vector, e.vector) }))
      .filter((x) => x.s >= MIN_LIKE)
      .sort((a, b) => b.s - a.s || b.e.fits - a.e.fits)
      .filter((x) => !seen.has(x.e.ask) && seen.add(x.e.ask))
      .slice(0, k)
      .map((x) => ({ ask: x.e.ask, steps: x.e.steps }))
  }

  /** The newest walk kept for this very figure (view and arguments, the day and the shape among them) within the hour. */
  function reuse(source, at = Date.now()) {
    if (!source) return null
    const key = JSON.stringify(source)
    const e = load().findLast((x) => x.walk && JSON.stringify(x.source) === key && at - Date.parse(x.at) < REUSE_MS)
    return e ? { at: e.at, steps: e.walk, title: e.title, fits: e.fits } : null
  }

  return { keep, like, reuse, size: () => load().length }
}
