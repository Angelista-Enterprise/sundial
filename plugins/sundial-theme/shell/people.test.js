import { describe, expect, it } from 'vitest'
import { bySeen, daysSince, displayName, foldPeople, isGroup, isHash, isOwner, isRoom, mergeHint, normalizeName, notAPerson, withWhom } from './people.js'

describe('what is not a person', () => {
  // Every string here is one the live calendar actually sent.
  it('knows a meeting room by its capacity or its site code', () => {
    for (const room of ['RTM-1-08 (12)', 'AMS-1-07 - The Board Room (14)', 'GTP-5-04-INTERNAL (4)', 'RTM-1-05 (4)']) expect(isRoom(room), room).toBe(true)
    for (const human of ['Alex Morgan', 'Thomas', 'person-c205ca11f2']) expect(isRoom(human), human).toBe(false)
  })

  it('knows a distribution list by its collective noun, not by its company', () => {
    for (const group of ['Acme Employees', 'Acme Interns', 'Acme Office', 'puzzlebox-team', 'Studio - developers']) expect(isGroup(group), group).toBe(true)
    // The trap: a surname that contains one of the words as a substring.
    for (const human of ['Tom Claassen', 'Alan Alloway', 'Mira Bakker']) expect(isGroup(human), human).toBe(false)
  })

  it('knows the owner from the names the config gave it', () => {
    const aliases = ['pat', 'Pat Doe', 'person-c8cd3c6427']
    expect(isOwner('Pat Doe', aliases)).toBe(true)
    expect(isOwner('person-c8cd3c6427', aliases)).toBe(true)
    expect(isOwner('Pat Holm', aliases)).toBe(false)
    expect(isOwner('', aliases)).toBe(false)
  })

  it('says WHY, because a row that vanishes is a row nobody can question', () => {
    expect(notAPerson('Acme Office', [])).toBe('a group')
    expect(notAPerson('RTM-1-05 (4)', [])).toBe('a room')
    expect(notAPerson('Pat Doe', ['Pat Doe'])).toBe('you')
    expect(notAPerson('Mira Bakker', [])).toBe(null)
  })

  it('knows a hashed attendee', () => {
    expect(isHash('person-c205ca11f2')).toBe(true)
    expect(isHash('Alex Morgan')).toBe(false)
  })
})

describe('what to call someone', () => {
  it('prefers what the owner asserted over what the calendar sent', () => {
    expect(displayName({ alias: 'person-c205ca11f2', name: 'person-c205ca11f2', knownAs: 'Alex Morgan' })).toBe('Alex Morgan')
  })

  it('applies the config alias, case- and punctuation-insensitively', () => {
    expect(displayName({ name: 'Alexm' }, { alexm: 'Alex Morgan' })).toBe('Alex Morgan')
    expect(displayName({ name: 'Noah' }, { Noah: 'Thomas' })).toBe('Thomas')
  })

  it('runs an assertion through the alias map too, so a variant still lands canonically', () => {
    expect(displayName({ name: 'person-c0ffee0002', knownAs: 'Marek' }, { marek: 'Mark Janssen' })).toBe('Mark Janssen')
  })

  it('normalizes accents and punctuation but keeps distinct people distinct', () => {
    expect(normalizeName('Renée  O’Brien')).toBe('renee o brien')
    expect(normalizeName('Jordan Holm')).not.toBe(normalizeName('Jordan De Wit'))
  })
})

describe('folding many rows into one human', () => {
  const row = (alias, name, events, extra = {}) => ({ alias, name, named: true, events, ...extra })

  it('merges two ids that resolve to the same words', () => {
    const folded = foldPeople([
      row('Mira Bakker', 'Mira Bakker', [['e1', { at: '2026-09-17T20:00:00.000Z', title: 'Weekly' }]]),
      row('person-f288735ee8', 'Mira Bakker', [['e2', { at: '2026-09-04T09:00:00.000Z', title: 'Kickoff' }]]),
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0].aliases).toEqual(['Mira Bakker', 'person-f288735ee8'])
    expect(folded[0].meetings).toBe(2)
    expect(folded[0].lastSeen).toBe('2026-09-17T20:00:00.000Z')
  })

  it('counts ONE meeting once, however many addresses invited the same person to it', () => {
    // The bug the event key exists to stop: a fold that summed counts would make
    // the duplicates look twice as sociable, which is the opposite of the point.
    const folded = foldPeople([
      row('Jordan De Wit', 'Jordan De Wit', [['same', { at: '2026-09-16T12:30:00.000Z', title: 'Standup' }]]),
      row('person-d1feb17d9f', 'Jordan De Wit', [['same', { at: '2026-09-16T12:30:00.000Z', title: 'Standup' }]]),
    ])
    expect(folded[0].meetings).toBe(1)
  })

  it('keeps two genuinely different people apart', () => {
    const folded = foldPeople([row('Jordan Holm', 'Jordan Holm', []), row('Jordan De Wit', 'Jordan De Wit', [])])
    expect(folded).toHaveLength(2)
  })

  it('shows the longest spelling, because a first name is not a person', () => {
    const folded = foldPeople([row('Alex', 'Alex Morgan', []), row('Alex Morgan', 'Alex Morgan', [])])
    expect(folded[0].name).toBe('Alex Morgan')
  })

  it('draws one trail mark per meeting, newest first', () => {
    const folded = foldPeople([
      row('Marco Kuiper', 'Marco Kuiper', [
        ['a', { at: '2026-09-01T09:00:00.000Z' }],
        ['b', { at: '2026-09-16T09:00:00.000Z' }],
      ]),
    ])
    expect(folded[0].life.map((e) => e.at)).toEqual(['2026-09-16T09:00:00.000Z', '2026-09-01T09:00:00.000Z'])
  })
})

describe('who else was in the room', () => {
  // Isa's two meetings, as the live calendar sent them.
  const events = new Map([
    ['e1', { at: '2026-09-16T11:30:00.000Z', attendees: ['Mia Vos', 'Tom Jansen', 'Ben de Groot', 'person-c0ffee0001', 'Alex Morgan'] }],
    ['e2', { at: '2026-08-10T09:00:00.000Z', attendees: ['Mia Vos', 'Tom Jansen', 'Ben de Groot', 'person-c0ffee0001'] }],
  ])
  const isa = { name: 'Mia Vos', met: [{ id: 'e1', at: '2026-09-16T11:30:00.000Z' }, { id: 'e2', at: '2026-08-10T09:00:00.000Z' }] }

  it('counts every room shared, strongest first, and an unnamed one last of its tier', () => {
    expect(withWhom(isa, events).map((w) => [w.name, w.shared])).toEqual([
      ['Ben de Groot', 2],
      ['Tom Jansen', 2],
      ['person-c0ffee0001', 2],
      ['Alex Morgan', 1],
    ])
  })

  it('never counts the person as their own company', () => {
    expect(withWhom(isa, events).some((w) => w.name === 'Mia Vos')).toBe(false)
  })

  it('gives each of them marks at the shared meetings, for the trail', () => {
    const ruben = withWhom(isa, events)[0]
    expect(ruben.life.map((e) => [e.at, e.kind])).toEqual([
      ['2026-09-16T11:30:00.000Z', 'with'],
      ['2026-08-10T09:00:00.000Z', 'with'],
    ])
  })

  it('resolves a co-attendee through the same fold the list uses', () => {
    const named = withWhom(isa, events, (n) => (n === 'person-c0ffee0001' ? 'Julia' : n))
    expect(named.map((w) => w.name)).toContain('Julia')
    expect(named.find((w) => w.name === 'Julia').unnamed).toBe(false)
  })

  it('keeps an unresolved attendee, and marks it unnamed rather than showing a hash as a name', () => {
    expect(withWhom(isa, events).find((w) => w.name === 'person-c0ffee0001').unnamed).toBe(true)
  })

  it('returns nothing for someone the owner only ever meets alone', () => {
    const marco = { name: 'Marco Kuiper', met: [{ id: 'm1', at: '2026-09-16T09:00:00.000Z' }] }
    expect(withWhom(marco, new Map([['m1', { at: '2026-09-16T09:00:00.000Z', attendees: ['Marco Kuiper'] }]]))).toEqual([])
  })
})

describe('the merge it may suggest', () => {
  const people = [{ name: 'Alex' }, { name: 'Alex Morgan' }, { name: 'Jordan' }, { name: 'Jordan Holm' }, { name: 'Jordan De Wit' }, { name: 'Mira Bakker' }]

  it('is sure when exactly one longer name starts with this one', () => {
    expect(mergeHint(people[0], people)).toEqual({ sure: true, could: ['Alex Morgan'] })
  })

  it('refuses to pick when the prefix fits two people', () => {
    // The audit's own list said "Jordan×3 → one human". The record says Jordan is
    // two colleagues and a bare first name; auto-merging would weld two people.
    expect(mergeHint(people[2], people)).toEqual({ sure: false, could: ['Jordan Holm', 'Jordan De Wit'] })
  })

  it('suggests nothing for a full name, a lone name, or a hash', () => {
    expect(mergeHint(people[1], people)).toBe(null)
    expect(mergeHint(people[5], people)).toBe(null)
    expect(mergeHint({ name: 'person-c205ca11f2' }, [...people, { name: 'person-c205ca11f2 something' }])).toBe(null)
  })

  it('does not match a name that merely shares a first syllable', () => {
    expect(mergeHint({ name: 'Mark' }, [{ name: 'Mateo' }])).toBe(null)
  })
})

describe('recency', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z')

  it('counts whole days, and refuses to invent one', () => {
    expect(daysSince('2026-09-04T12:00:00.000Z', now)).toBe(14)
    expect(daysSince(null, now)).toBe(null)
  })

  it('sorts most recently seen first, and never-seen last', () => {
    const rows = [{ name: 'Never', lastSeen: null }, { name: 'Old', lastSeen: '2026-08-10T09:00:00.000Z' }, { name: 'Today', lastSeen: '2026-09-18T09:00:00.000Z' }]
    expect([...rows].sort(bySeen).map((r) => r.name)).toEqual(['Today', 'Old', 'Never'])
  })
})
