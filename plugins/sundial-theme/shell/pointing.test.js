import { describe, expect, it } from 'vitest'
import { points, turnPlace } from './pointing.js'

const view = () => 'Today'

describe('turnPlace (plan 15 step 2)', () => {
  it('without a summon: the place set, else the view', () => {
    expect(turnPlace('hi', {}, view)).toEqual({ place: 'Today' })
    expect(turnPlace('hi', { place: 'Xcode: Board.swift' }, view)).toEqual({ place: 'Xcode: Board.swift' })
  })

  it('a quiet summon offers the place; plain words leave it off', () => {
    expect(turnPlace('what is next?', { summon: 's1', offer: 'Xcode: Board.swift', selected: 'let x = 3' }, view)).toEqual({ place: '', summon: 's1' })
  })

  it('pointing words, in English or Dutch, attach the place but not the selection', () => {
    const data = { summon: 's1', offer: 'Xcode: Board.swift', selected: 'let x = 3' }
    expect(turnPlace('why does this fail?', data, view)).toEqual({ place: 'Xcode: Board.swift', summon: 's1' })
    expect(turnPlace('wat doet dit?', data, view).place).toBe('Xcode: Board.swift')
    expect(points('thistle')).toBe(false)
  })

  it('the chip attached it: the selection rides without a pointing word', () => {
    expect(turnPlace('explain', { summon: 's1', offer: 'Mail', place: 'Mail', selected: 'Dear Mira' }, view)).toEqual({ place: 'Mail', summon: 's1', selected: 'Dear Mira' })
  })

  it('the exact words said with the key held are a spoken turn; other words are not (plan 15 step 3)', () => {
    const data = { spoken: JSON.stringify({ text: 'when is my next meeting', lang: 'english' }) }
    expect(turnPlace('when is my next meeting', data, view)).toEqual({ place: 'Today', voice: true, lang: 'english' })
    expect(turnPlace('typed later', data, view)).toEqual({ place: 'Today' })
    expect(turnPlace('x', { spoken: '{bad' }, view)).toEqual({ place: 'Today' })
  })
})
