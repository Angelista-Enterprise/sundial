import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOING, FAMILIES, journalDays, momentIdIn, openDoors, share } from './trace.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DELIVERY = readFileSync(join(HERE, '../../../packages/kernel/src/effect-delivery.ts'), 'utf8')
const RUNTIME = readFileSync(join(HERE, '../../../packages/harness-runtime/src/effect-journal.ts'), 'utf8')

/** The keys of `EFFECT_FAMILY`, read out of the kernel's own source. */
const familyKeys = () => {
  const block = DELIVERY.slice(DELIVERY.indexOf('EFFECT_FAMILY: Record<'))
  return [...block.slice(0, block.indexOf('\n};')).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]).sort()
}

describe('the effect vocabulary', () => {
  it('has a sayable phrase for every effect the kernel classifies', () => {
    // The two lists are written in two files and neither can be derived from
    // the other, so a variant added to the union reaches `EFFECT_FAMILY`
    // (which fails the TypeScript build without it) and then has to reach
    // here — otherwise the card prints the raw type name, which is exactly the
    // "say the thing, not its storage" failure this card was rebuilt out of.
    expect(Object.keys(DOING).sort()).toEqual(familyKeys())
  })

  it('names four families and no more, because the bar has four bands', () => {
    expect(Object.keys(FAMILIES)).toEqual(['record', 'itself', 'think', 'you'])
  })

  it('gives every band an ink of its own', () => {
    // The `you` band is 42 of 27,000 — 1.7px on a wide card — and it sits
    // directly beside `think`. The first draw gave those two the two ochres
    // and the hairline was unfindable. A band that carries a finding cannot
    // share a hue with the band next to it, and the cheapest way to hold that
    // is to refuse any repeat at all.
    const inks = Object.values(FAMILIES).map((f) => f.ink)
    expect(new Set(inks).size).toBe(inks.length)
  })
})

describe('the moment door', () => {
  // `momentIdIn` parses a string `describeEffect` rendered, which is a second
  // copy of a format. These hold it against the arms that actually write one.
  it('reads a moment out of every shape describeEffect writes one in', () => {
    const id = '01M356ABCDEFGHJKMNPQRSTVWX'
    expect(momentIdIn(`UpdateMomentData ${id}`)).toBe(id)
    expect(momentIdIn(`WriteDB moment ${id}`)).toBe(id)
    expect(momentIdIn(`Embed moment ${id}`)).toBe(id)
    expect(momentIdIn(`Judge perceive purpose=perceive moment=${id}`)).toBe(id)
  })

  it('finds no id where there is none to find', () => {
    expect(momentIdIn('ScheduleLLM purpose=perceive')).toBeNull()
    expect(momentIdIn('EmitEvent judgement:result')).toBeNull()
    expect(momentIdIn('Embed knowledge_entry 01M356ABCDEFGHJKMNPQRSTVWX')).toBeNull()
    expect(momentIdIn(null)).toBeNull()
  })

  it('knows every arm of describeEffect that puts a moment in the line', () => {
    // The drift guard. If a new arm writes `moment` into its detail string and
    // the parser does not know its shape, the row silently stops being a door
    // — nothing looks broken, the link is simply not there. Any arm mentioning
    // a moment must be one of the four shapes above.
    const block = RUNTIME.slice(RUNTIME.indexOf('export function describeEffect'))
    const body = block.slice(0, block.indexOf('\n}\n'))
    const momentArms = body.split('\n').filter((line) => /`[^`]*moment/.test(line))
    expect(momentArms.map((l) => l.trim())).toEqual([
      '? `WriteDB moment ${effect.row.id}`',
      "return `Judge ${effect.questionSetId} purpose=${effect.purpose}${effect.momentId ? ` moment=${effect.momentId}` : ''}`;",
      'return `UpdateMomentData ${effect.momentId}`;',
    ])
  })
})

describe('the doors', () => {
  const rows = [
    { effectDetail: 'UpdateMomentData 01M356ABCDEFGHJKMNPQRSTVWX' },
    { effectDetail: 'Judge perceive purpose=perceive moment=01M999ABCDEFGHJKMNPQRSTVWX' },
    { effectDetail: 'EmitEvent judgement:result' },
  ]

  it('only offers a door where the record holds the moment', () => {
    // `Judge … moment=<id>` is written when the judge is asked; the moment is
    // written when it closes. So the journal names moments that do not exist
    // yet, and they are the NEWEST rows — the ones this card shows. A door
    // built from an id alone opened nothing and said nothing.
    expect(openDoors(rows, new Set(['01M356ABCDEFGHJKMNPQRSTVWX'])).map((r) => r.moment)).toEqual(['01M356ABCDEFGHJKMNPQRSTVWX', null, null])
  })

  it('shuts every door when the record holds none of them', () => {
    expect(openDoors(rows, []).every((r) => r.moment === null)).toBe(true)
  })
})

describe('the shares', () => {
  it('keeps the precision a rare band needs', () => {
    // 42 of 27,029 rounds to 0% and 0.2% is not what it is. The `you` band is
    // the card's own finding, so its figure keeps two places below 1%.
    expect(share(42, 27029)).toBe('0.16%')
    expect(share(2052, 27029)).toBe('7.6%')
    expect(share(19605, 27029)).toBe('73%')
    expect(share(1, 0)).toBe('—')
  })

  it('counts the journal in whole days, and refuses one it cannot', () => {
    expect(journalDays('2026-09-17T18:00:00.000Z', '2026-09-22T18:00:00.000Z')).toBe(5)
    expect(journalDays(null, '2026-09-22T18:00:00.000Z')).toBeNull()
    expect(journalDays('2026-09-22T18:00:00.000Z', '2026-09-22T18:00:00.000Z')).toBeNull()
  })
})
