// Round 3: the Routes card's read. Made-up apps and goals.
import { describe, expect, it } from 'vitest'
import { readLearnedRoutes } from './read-routes.js'

const step = (processName, session, goal, name, at, more = {}) => ({ data: { processName, verb: 'press', role: 'button', screenText: [name], goal, session, ok: true, changed: true, ...more }, capturedAt: at })
const LOG = [
  step('Notes', 'o1', 'make a note', 'New Note', '2026-11-10T08:00:00.000Z'),
  step('Notes', 'o2', 'make a note', 'New Note', '2026-11-12T08:00:00.000Z'),
  step('Notes', 'o3', 'pin a note', 'Pin', '2026-11-13T08:00:00.000Z', { ok: false, changed: undefined, reason: 'not-found' }),
  step('Spotify', 'o4', 'like a song', 'Like', '2026-11-14T08:00:00.000Z'),
  // The rig's session: one step on a Testbox page takes the whole session out.
  step('Notes', 'rig', 'archive a note', 'Archive', '2026-11-14T09:00:00.000Z', { windowTitle: 'Testbox - notes' }),
  step('Notes', 'rig', 'archive a note', 'Archive', '2026-11-14T09:01:00.000Z'),
  step('Mail', 'rig2', 'send it', 'Send', '2026-11-14T09:02:00.000Z', { windowTitle: 'Rig fixture: compose' }),
]

/** A stand-in for the two signal queries, filtering the made-up log as the database would. */
const queries = (log, drops = []) => {
  const pick = (types, contains) => (types?.[0] === 'screen:route-dropped' ? drops : log).filter((r) => !contains || JSON.stringify(r.data).toLowerCase().includes(contains))
  return {
    countSignalsInRange: async (_f, _t, types, contains) => pick(types, contains).length,
    getSignalsInRange: async (_f, _t, limit, types, offset = 0, contains) => pick(types, contains).slice(offset, offset + limit),
  }
}
const now = Date.parse('2026-11-15T10:00:00.000Z')

describe('readLearnedRoutes', () => {
  it('lists per app, newest app first, each route with n and when last, and the dead ends; the rig\'s routes are left out', async () => {
    expect(await readLearnedRoutes({ now, queries: queries(LOG) })).toEqual({
      days: 30,
      apps: [
        { app: 'Spotify', routes: [{ key: 'like a song', goal: 'like a song', n: 1, at: '2026-11-14T08:00:00.000Z' }], deadEnds: [] },
        { app: 'Notes', routes: [{ key: 'make a note', goal: 'make a note', n: 2, at: '2026-11-12T08:00:00.000Z' }], deadEnds: [{ step: 'press "Pin"', reason: 'not found', times: 1 }] },
      ],
    })
  })

  it('leaves out a route the owner dropped', async () => {
    const drops = [{ data: { app: 'Notes', routeKey: 'make a note', by: 'owner' }, capturedAt: '2026-11-14T12:00:00.000Z' }]
    const { apps } = await readLearnedRoutes({ now, queries: queries(LOG, drops) })
    expect(apps.find((a) => a.app === 'Notes').routes).toEqual([])
  })
})
