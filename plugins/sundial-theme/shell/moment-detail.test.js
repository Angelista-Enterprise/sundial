// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { chipWords, flatten, focusWhy, momentBrief, momentDetail, momentFacts, momentRow, momentSentence, projectName } from './moment-detail.js'

/**
 * The moment the 2026-09-17 audit was run against, as the record holds it —
 * 31 minutes in Arc with the owner dictating, 32 shell commands in sundial, and
 * an intent that said "Working in Arc browser".
 */
const audited = {
  id: '01M2RBVDHHANB0SJBP8V31Q6CT',
  startTime: '2026-09-17T19:00:19.000Z',
  endTime: '2026-09-17T19:31:23.000Z',
  durationMs: 1_864_000,
  processName: 'Arc',
  projectId: 'named:sundial',
  data: {
    activeMs: 893_614,
    audioApp: 'Spotify',
    audioContext: 'call',
    focusQuality: 'deep',
    focusScore: 1,
    intent: { status: 'done', text: 'Working in Arc browser', analyzedAt: '2026-09-17T19:31:23.490Z' },
    narrative: 'Worked in the Arc browser with audio and clipboard activity.',
    micActive: true,
    playbackActive: true,
    projectConfidence: 'weak',
    shellCommandCount: 32,
    notableCommands: [],
    spokenExcerpt: "dictate right now what I'm saying and it'll just pick it up",
    spokenLanguages: ['english'],
    typingEventCount: 184,
    windowTitles: ['Gnomon'],
    lifeEvents: ['media:audio-input:on', 'clipboard:activity'],
  },
}

const text = (nodes) => nodes.map((n) => n.textContent).join(' | ')

describe('momentSentence', () => {
  it('says what the moment was, where the intent said what app was open', () => {
    const said = momentSentence(audited)
    expect(said).toContain('31 min deep focus')
    expect(said).toContain('speaking aloud')
    expect(said).toContain('on a call')
    expect(said).toContain('32 shell commands in sundial')
    // The model's own reading is NOT the sentence. It sits below, marked, because
    // the audit's worst finding was an intent that contradicted the evidence and
    // was printed as though it were the fact.
    expect(said).not.toContain('Working in Arc browser')
  })

  it('calls a long window with nothing at the keys what it is', () => {
    const idle = { startTime: '2026-09-17T09:00:00.000Z', endTime: '2026-09-17T10:00:00.000Z', durationMs: 3_600_000, processName: 'Mail', data: { activeMs: 0 } }
    expect(momentSentence(idle)).toContain('nothing at the keys')
    // And a short one is not accused of it: five minutes away from the keys is
    // reading the screen, not an abandoned window.
    expect(momentSentence({ ...idle, durationMs: 120_000, endTime: '2026-09-17T09:02:00.000Z' })).not.toContain('nothing at the keys')
  })

  it('has something to say about a moment with almost nothing in it', () => {
    expect(momentSentence({ startTime: '2026-09-17T09:00:00.000Z', durationMs: 60_000, processName: 'Finder', data: {} })).toContain('Finder in front')
    expect(momentSentence({})).toBe('A moment with nothing in it.')
  })
})

describe('projectName', () => {
  it('gives the name, never the storage', () => {
    expect(projectName('named:sundial')).toBe('sundial')
    expect(projectName('~/Projects/doe/familybudget-backend')).toBe('familybudget-backend')
    expect(projectName(null)).toBeNull()
  })
})

describe('focusWhy', () => {
  it('gives the reason instead of the score', () => {
    expect(focusWhy(audited)).toEqual(['15 min of 31 min at the keys', 'one window throughout', '184 typing bursts'])
  })
})

describe('momentDetail', () => {
  it('leads with the sentence, quotes the speech, and never prints a bare score', () => {
    const out = text(momentDetail(audited))
    expect(out).toContain('31 min deep focus')
    expect(out).toContain('Heard aloud')
    expect(out).toContain("dictate right now what I'm saying")
    // `focusScore: 1` reached the owner as a bare number with no legend and read
    // as broken. The quality word and its reason replace it.
    expect(out).toContain('Deep.')
    expect(out).not.toMatch(/\b100%\b|focusScore/)
  })

  it('marks the model\'s reading as a reading, with the attribution it rests on', () => {
    const out = text(momentDetail(audited))
    expect(out).toContain('Gnomon read this as')
    expect(out).toContain('inferred · weak attribution')
    expect(out).toContain('Working in Arc browser')
  })

  it('says a count is only a count when the commands were not named', () => {
    expect(text(momentDetail(audited))).toContain('32 run, none recorded by name')
    const named = { ...audited, data: { ...audited.data, notableCommands: ['npx vitest run', 'git status --short'] } }
    const out = text(momentDetail(named))
    expect(out).toContain('npx vitest run · git status --short')
    expect(out).not.toContain('none recorded by name')
  })

  it('draws only the context that was true', () => {
    const out = text(momentDetail(audited))
    expect(out).toContain('mic on')
    expect(out).toContain('Spotify playing')
    expect(out).not.toContain('camera on')
  })

  it('shows the cost when the reader carries it, and nothing when it does not', () => {
    expect(text(momentDetail(audited))).not.toContain('What Gnomon spent on it')
    const priced = { ...audited, data: { ...audited.data, cost: { calls: 3, failed: 1, costUsd: 0.0421, purposes: ['intent', 'ask'] } } }
    const out = text(momentDetail(priced))
    expect(out).toContain('3 calls, 1 failed · $0.0421 at list price · intent, ask')
  })

  it('makes the project a door only when there is somewhere to go', () => {
    const asDoor = momentDetail(audited, { onDoor: true }).map((n) => n.outerHTML).join('')
    expect(asDoor).toContain('data-explore="entity:sundial"')
    expect(momentDetail(audited).map((n) => n.outerHTML).join('')).not.toContain('data-explore')
  })
})

describe('flatten', () => {
  it('reads the substance under `data` as the moment\'s own', () => {
    expect(flatten(audited).focusQuality).toBe('deep')
    expect(flatten({ id: 'x' }).focusQuality).toBeUndefined()
  })
})

describe('momentRow', () => {
  const row = { id: 'm1', startTime: '2026-09-17T19:00:00.000Z', durationMin: 31, activeMin: 15, processName: 'Arc', projectId: 'named:sundial', focusQuality: 'deep', intent: 'Working in Arc browser' }

  it('is a door onto the same moment the full page shows', () => {
    expect(momentRow(row).getAttribute('data-explore')).toBe('moment:m1')
    expect(momentRow(row).textContent).toContain('Working in Arc browser')
    // Active minutes, because a long window with nothing at the keys is not work.
    expect(momentRow(row).textContent).toContain('15 min')
  })

  it('names the project the way every other surface does', () => {
    // `named:sundial` reached one list as itself and the other as `sundial`.
    expect(momentRow(row).textContent).toContain('sundial')
    expect(momentRow(row).textContent).not.toContain('named:')
  })

  it('falls back through intent, title and app, and asks when there is no id', () => {
    expect(momentRow({ ...row, id: null, intent: null, title: 'index.ts' }).getAttribute('data-explore')).toBeNull()
    expect(momentRow({ ...row, id: null, intent: null, title: 'index.ts' }, { onAsk: true }).getAttribute('data-explore')).toBe('search:index.ts')
    expect(momentRow({ ...row, intent: null, title: null }).textContent).toContain('Arc')
  })

  it('reads an intent object as well as a string, since the record holds both shapes', () => {
    expect(momentRow({ ...row, intent: { status: 'done', text: 'Reading the ledger spec' } }).textContent).toContain('Reading the ledger spec')
  })
})

describe('the heard block', () => {
  const clean = "Dictate right now what I'm saying, and it'll just pick it up and keep that in its memory."
  const withClean = { ...audited, data: { ...audited.data, spokenClean: { text: clean, cleanedAt: '2026-09-17T19:32:00.000Z' } } }

  it('shows only the capture when nothing has cleaned it', () => {
    const out = text(momentDetail(audited))
    expect(out).toContain("dictate right now what I'm saying")
    expect(out).not.toContain('Show what was captured')
  })

  it('leads with the cleaned copy and says it is not yet accepted', () => {
    // A transcript is evidence. A tidied piece of evidence nobody agreed to is
    // worse than an untidy one, so the badge says which copy this is.
    const out = text(momentDetail(withClean, { onAccept: async () => true }))
    expect(out).toContain(clean)
    expect(out).toContain('cleaned · not yet accepted, the capture below is the record')
    expect(out).toContain('Accept this reading')
  })

  it('puts the raw capture one press away, and never loses it', () => {
    const nodes = momentDetail(withClean, { onAccept: async () => true })
    const block = nodes.find((n) => /Heard aloud/.test(n.textContent))
    const toggle = [...block.querySelectorAll('button')].find((b) => b.textContent === 'Show what was captured')
    toggle.click()
    expect(block.querySelector('.md-quote').textContent).toBe(audited.data.spokenExcerpt)
    expect(block.textContent).toContain('as captured')
    // And back again.
    ;[...block.querySelectorAll('button')].find((b) => b.textContent === 'Show the cleaned copy').click()
    expect(block.querySelector('.md-quote').textContent).toBe(clean)
  })

  it('says so once the owner has accepted it, and stops asking', () => {
    const accepted = { ...withClean, data: { ...withClean.data, spokenCleanAccepted: true } }
    const out = text(momentDetail(accepted, { onAccept: async () => true }))
    expect(out).toContain('cleaned · you accepted this')
    expect(out).not.toContain('Accept this reading')
  })

  it('offers no Accept on a surface that cannot write', () => {
    expect(text(momentDetail(withClean))).not.toContain('Accept this reading')
  })
})

describe('the brief, as it folds open under a row', () => {
  it('leaves out what the surrounding surface already shows', () => {
    // The Day's table has a column for each of these; a fold repeating them
    // printed the same moment three times over.
    const html = momentBrief(audited, { omit: ['when', 'long', 'focus', 'app', 'project', 'intent'], sentence: false }).map((n) => n.outerHTML).join('')
    expect(html).not.toContain('mb-sentence')
    // No fact repeats a column.
    const facts = momentFacts(audited, { omit: ['when', 'long', 'focus', 'app', 'project', 'intent'] }).map((n) => n.textContent)
    expect(facts.join(' ')).not.toMatch(/Arc|deep|sundial/)
    // What has no column survives: the commands, the words spoken, and the
    // narrative, which says more than the intent the column carries.
    expect(html).toContain('32 commands')
    expect(html).toContain('mb-quote')
    expect(html).toContain('mb-read')
  })

  it('offers nothing when the row has already said it all', () => {
    expect(momentBrief({ startTime: '2026-09-17T19:00:00.000Z', processName: 'Arc', data: { focusQuality: 'deep' } }, { omit: ['when', 'long', 'focus', 'app', 'project', 'intent'], sentence: false })).toEqual([])
  })

  it('is counts across, not a page down', () => {
    const nodes = momentBrief(audited)
    const html = nodes.map((n) => n.outerHTML).join('')
    // One sentence, the model's reading, then the facts.
    expect(nodes[0].className).toBe('mb-sentence')
    expect(html).toContain('mb-facts')
    // Nothing that needs a paragraph to be understood: those stay on the page.
    expect(html).not.toContain('Heard aloud')
    expect(html).not.toContain('On screen')
    expect(html).not.toContain('md-quote')
  })

  it('pairs every mark with its own value', () => {
    for (const f of momentFacts(audited)) {
      expect(f.querySelector('svg.icon')).not.toBeNull()
      expect(f.textContent.trim()).not.toBe('')
    }
    const said = momentFacts(audited).map((f) => f.textContent)
    expect(said.some((t) => t.includes('32 commands'))).toBe(true)
    expect(said.some((t) => t.includes('sundial'))).toBe(true)
    // Speech is not a fact chip: the words themselves go in, because
    // first-party evidence outranks a count of it.
    expect(said.some((t) => t.includes('spoke'))).toBe(false)
    expect(momentBrief(audited).some((n) => n.className === 'mb-quote')).toBe(true)
  })

  it('keeps wall time and active time in one fact, so the gap shows', () => {
    const said = momentFacts(audited).map((f) => f.textContent)
    expect(said.some((t) => /min, .*active/.test(t))).toBe(true)
  })

  it('says a repeated context once, with its count', () => {
    // Nine context switches drew nine identical chips: a bar chart with the
    // bars taken out.
    expect(chipWords({ lifeEvents: ['event:context-switch', 'event:context-switch', 'event:thrashing'] })).toEqual(['context switch ×2', 'thrashing'])
  })
})
