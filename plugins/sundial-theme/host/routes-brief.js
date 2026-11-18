// The brief Today shows: the standup draft or a meeting's prep until that meeting ends, and the week
// in review while it is due (`todayBrief` in the kernel's briefs.ts; the week is composed by the fold).
import { view } from './http.js'
import { todayBrief } from '@sundial/kernel/briefs.js'
import { summonLine } from '@sundial/kernel/read/summon-evidence.js'
import { readDayLine } from './read-ledger.js'

export function mountBrief(ctx, rows = undefined) {
  view(ctx, '/gnomon/brief', 'The brief could not be read.', () => todayBrief(ctx.gnomonKernel.getState?.(), Date.now()))
  // Plan 15 step 2: the one quiet line of a summon. The page asks once per summon.
  // Set 4 R2: with the Ledger's day line beside it (`day`, the same read as read-ledger.js `didToday`), which the slip shows
  // as its still line after 17:00 and on "what did you do today". Always the owner's day: a rig chat's rows never count.
  view(ctx, '/gnomon/summon', 'The summon could not be read.', async (url) => {
    const state = ctx.gnomonKernel.getState()
    const day = await readDayLine({ state, now: Date.now(), ...(rows ? { rows } : {}) })
    return { ...summonLine(state, new Date().toISOString(), url.searchParams.get('id')), day: day.line }
  })
}
