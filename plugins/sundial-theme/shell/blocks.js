// Two shapes the whole board shares: a block of long text, and a belief.
//
// Both came out of the same audit finding, twice. Long text was being squeezed
// into table columns — "question / answer / why are long text squeezed into
// vertical columns; text wraps ugly; design rows horizontally at full width so
// text flows" — and beliefs were being printed as their storage: `usesTool →
// Code`, a row the owner called uninformative and unable to back itself up.
//
// So: one stacked block, and one sentence with its evidence.
import { el } from './surfaces.js'

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null)

/**
 * One thing, down the page instead of across it.
 *
 * A table column is the wrong container for a paragraph: every cell is as
 * narrow as the widest column allows, so a two-line question and a six-line
 * answer both wrap into a ribbon. This stacks them at the card's full width and
 * gives the body a quote rule, because the body is the part worth reading.
 *
 *   headline  what it is, in one line
 *   body      the long part, ruled — a string or a node
 *   subline   the small explanation under it
 *   meta      when, how long, who — a row of small facts
 *   chips     labels
 *   acts      buttons, right of the headline
 *   index     its place in a list, for the stagger
 *
 * Every field is optional. A block with only a headline is a headline.
 */
export function stackedBlock({ headline, body, subline, meta, chips, acts, tone = null, index = 0 } = {}) {
  const metaLine = (Array.isArray(meta) ? meta : [meta]).filter((m) => m !== null && m !== undefined && m !== '')
  const chipList = (Array.isArray(chips) ? chips : [chips]).filter((c) => c !== null && c !== undefined && c !== '')
  return el('article', { class: 'sb', 'data-tone': tone, style: { '--i': index } }, [
    headline || acts
      ? el('div', { class: 'sb-head' }, [headline instanceof Node ? headline : el('h3', { class: 'sb-headline', text: String(headline ?? '') }), acts ?? null])
      : null,
    body === null || body === undefined || body === '' ? null : el('div', { class: 'sb-body' }, [body instanceof Node ? body : el('p', { class: 'sb-text', text: String(body) })]),
    subline ? el('p', { class: 'sb-sub', text: String(subline) }) : null,
    metaLine.length ? el('div', { class: 'sb-meta' }, metaLine.map((m) => (m instanceof Node ? m : el('span', { text: String(m) })))) : null,
    chipList.length ? el('div', { class: 'sb-chips' }, chipList.map((c) => (c instanceof Node ? c : el('span', { class: 'sb-chip', text: String(c) })))) : null,
  ])
}

/**
 * How a predicate reads in a sentence.
 *
 * Only the ones a generic rule gets wrong. Everything else falls through to
 * splitting the camel case, which is usually right: `worksOn` → "works on",
 * `usesTool` → "uses tool", `collaboratesOn` → "collaborates on".
 */
const PREDICATE_VERBS = {
  // Two predicates are named wrong in the record, and no verb phrase can save
  // them — so these are FRAMES, `(subject, object) => sentence`, and each one
  // says what was actually measured rather than what the column is called.
  //
  // `usesTool` is minted by `entity-extract.ts:320` from the process that was
  // in front when a moment on that project closed. It is adjacency, not a
  // toolchain: the live record has "puzzlebox-studio uses tool WhatsApp" with
  // 549 corroborations, and the entity audit read the same row as Photo Booth
  // and Find My. Drawn as "uses tool X" the card states a falsehood 146 times;
  // drawn as what it measured, every one of those rows is true.
  usesTool: (subject, object) => `${object} was in front while you worked on ${subject}`,
  // The object is always the literal string `owner` — 62 of 62 rows. Said as
  // stored it reads "Noah attended meeting with owner", which is the storage
  // wearing a sentence.
  attendedMeetingWith: (subject, object) =>
    String(object).toLowerCase() === 'owner' ? `You have been in a meeting with ${subject}` : `${subject} has been in a meeting with ${object}`,
  knownAs: 'is also known as',
  status: 'is',
  occupation: 'is a',
  relatesToProject: 'belongs to',
  hasPendingFeature: 'has a pending feature:',
  asleepBy: 'is asleep by',
  dayBeginsAt: 'starts the day at',
  wakeTime: 'wakes at',
  workSchedule: 'works',
  worksOnDevice: 'works on',
  foundEffective: 'finds this works:',
  worksBy: 'works by',
  instructs: 'asks Gnomon to',
  expects: 'expects',
  prefers: 'prefers',
  targetDate: 'is aimed at',
  why: 'exists because',
  // Noun predicates a model picks when the owner states a fact ("Daan is the SRE lead"): "Daan role SRE lead" is
  // the storage wearing a sentence; "Daan's role is SRE lead" is what was said.
  ...Object.fromEntries(['role', 'title', 'team', 'company', 'employer', 'email', 'phone', 'location', 'timezone', 'manager', 'birthday', 'pronouns'].map((noun) => [noun, (subject, object) => `${subject}'s ${noun} is ${object}`])),
}

/** `usesTool` → `uses tool`. */
const spaced = (predicate) =>
  String(predicate ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()

/** The verb phrase for a predicate, named where naming it helps. A frame has no phrase of its own. */
export const predicatePhrase = (predicate) => {
  const named = PREDICATE_VERBS[predicate]
  return typeof named === 'function' ? spaced(predicate) : (named ?? spaced(predicate))
}

/**
 * A belief as a sentence a person would say out loud.
 *
 * The test the owner set for the redesign: every row must be a sentence a human
 * would say. `usesTool → Code` fails it twice — it is the storage, and it backs
 * nothing up.
 */
export function factSentence(fact, subject) {
  const name = subject ?? fact?.subject ?? fact?.canonicalName ?? fact?.entityId ?? 'It'
  const object = String(fact?.object ?? '').trim()
  const frame = PREDICATE_VERBS[fact?.predicate]
  const sentence = (typeof frame === 'function' ? frame(name, object) : `${name} ${predicatePhrase(fact?.predicate)} ${object}`).replace(/\s+/g, ' ').trim()
  // A sentence starts with a capital. Entity names are stored as they were
  // first seen, so most subjects arrive lowercase.
  const said = sentence.charAt(0).toUpperCase() + sentence.slice(1)
  return /[.!?]$/.test(said) ? said : `${said}.`
}

/**
 * What stands behind a belief, in the owner's words.
 *
 * `alpha` is the Beta posterior's successes and starts at 1, so `alpha - 1` is
 * how many times the record actually corroborated this — the "142 min today, 12
 * sessions" the audit asked for, in the units the fact itself carries. A count
 * under one observation is not shown rather than printed as "seen 0 times",
 * which would read as evidence against.
 */
export function factEvidence(fact) {
  const out = []
  const seen = typeof fact?.alpha === 'number' ? Math.round(fact.alpha - 1) : 0
  const provenance = fact?.provenance
  // Where it came from, first: "you told me" changes how the rest is read.
  if (provenance === 'assertion') out.push('you told me')
  else if (provenance === 'conversation') out.push('from a conversation')
  else if (seen >= 1) out.push(`seen ${seen} time${seen === 1 ? '' : 's'}`)
  else out.push('inferred')
  // An assertion's alpha is the weight the owner's word carries, not a count of sightings: "seen 39 times" for a fact typed once reads as a lie.
  if (provenance !== 'inference' && provenance !== 'assertion' && seen >= 1) out.push(`seen ${seen} time${seen === 1 ? '' : 's'}`)
  if (typeof fact?.confidence === 'number') out.push(`${Math.round(fact.confidence)}% sure`)
  // How the belief has done against what the owner then did — the server's
  // line ("right 12 of 13", "right 3 of 4, gathering" under twenty outcomes),
  // so the threshold lives in one place (`fact-tests.ts`).
  if (typeof fact?.record?.line === 'string') out.push(fact.record.line)
  const from = day(fact?.validFrom ?? fact?.createdAt)
  if (fact?.validTo) out.push(`held ${from ? `${from} ` : ''}until ${day(fact.validTo)}`)
  else if (from) out.push(`since ${from}`)
  return out
}

/**
 * One belief: the sentence, and what stands behind it.
 *
 * `acts` are the caller's — Fix and Wrong belong to the surface that can write,
 * not to the renderer.
 */
export function factLine(fact, { subject, acts = null, index = 0 } = {}) {
  const superseded = Boolean(fact?.validTo)
  // The door to what proved it, where the record can reach one. `momentId` is
  // resolved by `getCurrentFactsWithProof` and is `null` far more often than
  // not — for the owner's own assertions it is not missing but inapplicable,
  // which the evidence line already says as "you told me". No door is drawn
  // rather than a dead one: `data-explore="moment:…"` is the same door the
  // Day's rows use, so this opens the ONE moment page (S-B) instead of a
  // fourth reading of a moment.
  const proof =
    fact?.momentId && fact?.provenance !== 'assertion'
      ? el('span', {
          class: 'door fact-proof',
          'data-explore': `moment:${fact.momentId}`,
          tabindex: '0',
          role: 'link',
          title: 'Open the moment this was first seen in',
          text: `first seen ${day(fact.momentStart ?? fact.validFrom) ?? 'here'}`,
        })
      : null
  return el('div', { class: `fact-line${superseded ? ' fact-gone' : ''}`, style: { '--i': index }, 'data-owner': String(fact?.provenance === 'assertion') }, [
    el('div', { class: 'fact-said' }, [el('span', { class: 'fact-sentence', text: factSentence(fact, subject) }), acts ?? null]),
    el('p', { class: 'fact-because' }, [el('span', { text: factEvidence(fact).join(' · ') }), proof]),
  ])
}

/**
 * Beliefs in the order the owner should meet them: what they said first, then
 * what Gnomon worked out, then what it no longer believes.
 *
 * "Asserted facts buried" was a finding in its own right — the owner's own
 * pending-feature and worksOn facts sat BELOW Photo Booth on the entity card.
 * A thing the owner said outranks anything inferred, always.
 */
export function ownerFirst(facts) {
  const rank = (f) => (f?.validTo ? 2 : f?.provenance === 'assertion' ? 0 : 1)
  return [...(Array.isArray(facts) ? facts : [])].sort((a, b) => rank(a) - rank(b) || String(b?.validFrom ?? '').localeCompare(String(a?.validFrom ?? '')))
}
