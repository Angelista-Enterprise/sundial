// The brief Today shows: the standup draft or a meeting's prep until that meeting ends, and the week
// in review while it is due (`todayBrief` in the kernel's briefs.ts; the week is composed by the fold).
import { view } from './http.js'
import { todayBrief } from '@sundial/kernel/briefs.js'

export function mountBrief(ctx) {
  view(ctx, '/gnomon/brief', 'The brief could not be read.', () => todayBrief(ctx.gnomonKernel.getState?.(), Date.now()))
}
