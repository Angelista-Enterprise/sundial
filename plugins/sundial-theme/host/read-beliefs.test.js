import { describe, expect, it } from 'vitest'
import { GROUPS, sourceOf, words } from './read-beliefs.js'

const groupOf = (predicate) => GROUPS.find(([, , re]) => re.test(predicate))[0]

describe('the belief page (plan 15 step 5)', () => {
  it('says a predicate in words', () => {
    expect(words('worksOn')).toBe('works on')
    expect(words('asleep_by')).toBe('asleep by')
  })

  it('puts each predicate in one of five groups', () => {
    expect(GROUPS).toHaveLength(5)
    expect(['asleepBy', 'wakeAt', 'dayBeginsAt', 'workSchedule'].map(groupOf)).toEqual(['days', 'days', 'days', 'days'])
    expect(['worksOn', 'occupation', 'usesTool', 'attended'].map(groupOf)).toEqual(['work', 'work', 'work', 'work'])
    expect(['worksBy', 'instructs', 'prefers', 'dislikes'].map(groupOf)).toEqual(['ways', 'ways', 'ways', 'ways'])
    expect(groupOf('plansTo')).toBe('plans')
    expect(groupOf('ownsCat')).toBe('other')
  })

  it('names the source in plain words', () => {
    expect(sourceOf({ provenance: 'assertion', validFrom: '2026-11-03T10:00:00Z' })).toBe('you said so on 3 November')
    expect(sourceOf({ provenance: 'conversation', validFrom: '2026-11-03T10:00:00Z' })).toBe('from a chat on 3 November')
    expect(sourceOf({ provenance: 'inferred', validFrom: '2026-11-03T10:00:00Z', record: { right: 14 } })).toBe('seen 14 times, since 3 November')
    expect(sourceOf({ provenance: 'inferred', validFrom: '2026-11-03T10:00:00Z' })).toBe('inferred on 3 November')
  })
})
