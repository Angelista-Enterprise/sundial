// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { factEvidence, factLine, factSentence, ownerFirst, predicatePhrase, stackedBlock } from './blocks.js'

describe('stackedBlock', () => {
  it('puts the long part in a body of its own, not in a column', () => {
    const node = stackedBlock({
      headline: 'How did the borrel go?',
      body: 'Fine, nothing to keep',
      subline: 'ended 22:00 with Rik Verbeek, Mira Bakker and 3 more',
      meta: ['asked 22:02', 'answered in 2 min'],
      chips: ['answered'],
    })
    expect(node.querySelector('.sb-headline').textContent).toBe('How did the borrel go?')
    expect(node.querySelector('.sb-body').textContent).toBe('Fine, nothing to keep')
    expect(node.querySelector('.sb-sub').textContent).toContain('Rik Verbeek')
    expect(node.querySelector('.sb-meta').textContent).toContain('answered in 2 min')
    expect(node.querySelector('.sb-chip').textContent).toBe('answered')
  })

  it('draws only the parts it was given', () => {
    const node = stackedBlock({ headline: 'Just a headline' })
    expect(node.querySelector('.sb-body')).toBeNull()
    expect(node.querySelector('.sb-meta')).toBeNull()
    expect(node.querySelector('.sb-chips')).toBeNull()
  })

  it('takes nodes as well as strings, so a caller can hand it a door', () => {
    const node = stackedBlock({ headline: 'x', body: document.createElement('table'), meta: [document.createElement('a')] })
    expect(node.querySelector('.sb-body table')).not.toBeNull()
    expect(node.querySelector('.sb-meta a')).not.toBeNull()
  })
})

describe('factSentence', () => {
  it('says the belief out loud instead of printing its storage', () => {
    // The owner's test for the redesign: every row must be a sentence a human
    // would say. `usesTool → Code` fails it twice.
    expect(factSentence({ predicate: 'worksOn', object: 'hub' }, 'Noah')).toBe('Noah works on hub.')
    expect(factSentence({ predicate: 'knownAs', object: 'Noah' }, 'person-32d7')).toBe('Person-32d7 is also known as Noah.')
    expect(factSentence({ predicate: 'status', object: 'open' }, 'Sleep rhythm')).toBe('Sleep rhythm is open.')
  })

  it('says what a wrongly-named predicate MEASURED, not what it is called', () => {
    // `usesTool` is minted from the process in front when a moment on that
    // project closed — adjacency, not a toolchain. Said as stored, the live
    // record claims "puzzlebox-studio uses tool WhatsApp" 549 times over. Said
    // as measured, every one of those 146 rows is true.
    expect(factSentence({ predicate: 'usesTool', object: 'WhatsApp' }, 'puzzlebox-studio')).toBe('WhatsApp was in front while you worked on puzzlebox-studio.')
    // Entity names are stored as first seen, so the subject can arrive
    // lowercase — the capital goes on whatever word starts the sentence, which
    // for a frame is the OBJECT.
    expect(factSentence({ predicate: 'usesTool', object: 'code' }, 'sundial')).toBe('Code was in front while you worked on sundial.')
    // The object here is the literal string `owner`, in 62 of 62 rows.
    expect(factSentence({ predicate: 'attendedMeetingWith', object: 'owner' }, 'Noah')).toBe('You have been in a meeting with Noah.')
    expect(factSentence({ predicate: 'attendedMeetingWith', object: 'Mira' }, 'Noah')).toBe('Noah has been in a meeting with Mira.')
  })

  it('does not double a full stop the object already has', () => {
    expect(factSentence({ predicate: 'instructs', object: 'say nothing after "not now".' }, 'Pat')).toMatch(/\."$|\.$/)
    expect(factSentence({ predicate: 'instructs', object: 'stay quiet' }, 'Pat').endsWith('..')).toBe(false)
  })

  it('reads an unknown predicate acceptably rather than refusing it', () => {
    // The predicate vocabulary is open: a table that had to know every one would
    // go stale the first time a rule invented one.
    expect(predicatePhrase('sendsPullRequestsTo')).toBe('sends pull requests to')
    expect(factSentence({ predicate: 'sendsPullRequestsTo', object: 'hub' }, 'Ada')).toBe('Ada sends pull requests to hub.')
  })
})

describe('factEvidence', () => {
  // Dates are written in the reader's own locale, so these check the words
  // around them rather than pinning a format this machine happens to use.
  it('leads with where it came from, then what backs it', () => {
    const owner = factEvidence({ provenance: 'assertion', alpha: 4, confidence: 97, validFrom: '2026-09-12T00:00:00.000Z' })
    expect(owner.slice(0, 3)).toEqual(['you told me', 'seen 3 times', '97% sure'])
    expect(owner.at(-1)).toMatch(/^since .*Sep/)

    const inferred = factEvidence({ provenance: 'inference', alpha: 18, confidence: 89, validFrom: '2026-08-16T00:00:00.000Z' })
    expect(inferred.slice(0, 2)).toEqual(['seen 17 times', '89% sure'])
    expect(inferred.at(-1)).toMatch(/^since .*Aug/)
  })

  it('says a fact was held, not that it is true, once it is superseded', () => {
    const got = factEvidence({ provenance: 'inference', alpha: 3, validFrom: '2026-08-01T00:00:00.000Z', validTo: '2026-09-01T00:00:00.000Z' })
    expect(got.at(-1)).toMatch(/^held .*Aug.* until .*Sep/)
    expect(got.at(-1)).not.toContain('since')
  })

  it('says "inferred" rather than "seen 0 times", which would read as evidence against', () => {
    expect(factEvidence({ provenance: 'inference', alpha: 1 })).toEqual(['inferred'])
  })
})

describe('factLine', () => {
  it('draws the sentence and its evidence, and marks the owner\'s own', () => {
    const node = factLine({ predicate: 'hasPendingFeature', object: 'pause and resume gating', provenance: 'assertion', confidence: 97, alpha: 2, validFrom: '2026-09-15T00:00:00.000Z' }, { subject: 'Sundial' })
    expect(node.querySelector('.fact-sentence').textContent).toBe('Sundial has a pending feature: pause and resume gating.')
    expect(node.querySelector('.fact-because').textContent).toContain('you told me')
    expect(node.dataset.owner).toBe('true')
    expect(node.className).not.toContain('fact-gone')
  })

  it('never prints a predicate arrow', () => {
    const node = factLine({ predicate: 'usesTool', object: 'Warp', provenance: 'inference', alpha: 40 }, { subject: 'Sundial' })
    expect(node.textContent).not.toContain('→')
    expect(node.textContent).not.toContain('usesTool')
  })

  it('opens the moment it was first seen in, where the record can reach one', () => {
    // The door is the SAME one the Day's rows use, so a fact leads to the one
    // moment page (S-B) rather than to a fourth reading of a moment.
    const proved = factLine({ predicate: 'usesTool', object: 'Warp', provenance: 'inference', alpha: 40, momentId: 'm-1', momentStart: '2026-08-16T09:00:00.000Z' }, { subject: 'Sundial' })
    expect(proved.querySelector('.fact-proof').getAttribute('data-explore')).toBe('moment:m-1')
    expect(proved.querySelector('.fact-proof').textContent).toMatch(/^first seen /)
  })

  it('draws no door where there is nothing behind it', () => {
    // Two different silences, and neither is a failure to render. The owner's
    // own assertions were said in a conversation and never watched — 96 of the
    // live record's 442 — and the evidence line already says "you told me".
    const said = factLine({ predicate: 'asleepBy', object: '23:00', provenance: 'assertion', alpha: 3, momentId: 'm-2' }, { subject: 'Pat' })
    expect(said.querySelector('.fact-proof')).toBeNull()
    // And a fact minted at a moment's edge falls inside no moment at all.
    const unproved = factLine({ predicate: 'usesTool', object: 'Warp', provenance: 'inference', alpha: 40, momentId: null }, { subject: 'Sundial' })
    expect(unproved.querySelector('.fact-proof')).toBeNull()
  })
})

describe('ownerFirst', () => {
  it('puts what the owner said above what Gnomon worked out, and the dead last', () => {
    // "Asserted facts buried" was a finding in its own right: the owner's own
    // pending-feature fact sat below Photo Booth on the entity card.
    const facts = [
      { predicate: 'usesTool', object: 'Photo Booth', provenance: 'inference', validFrom: '2026-09-01' },
      { predicate: 'usesTool', object: 'Gone', provenance: 'inference', validFrom: '2026-08-01', validTo: '2026-09-01' },
      { predicate: 'hasPendingFeature', object: 'pause and resume', provenance: 'assertion', validFrom: '2026-08-20' },
      { predicate: 'usesTool', object: 'Code', provenance: 'inference', validFrom: '2026-09-10' },
    ]
    expect(ownerFirst(facts).map((f) => f.object)).toEqual(['pause and resume', 'Code', 'Photo Booth', 'Gone'])
  })
})
