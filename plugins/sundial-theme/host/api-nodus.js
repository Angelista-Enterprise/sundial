// The frame critic's door (Nodus plan step 5): a scene card sends the frame it
// drew, labels and leaders burnt in, and Jev judges the picture itself: does
// it show what was asked (`shows_intent`, 0 to 3) and can it be read
// (`legible`). The call is the kernel's `judgeNow` (purpose `judge`, budgeted
// and audited in `llm_audit`); nothing new goes in the log and the image is
// never stored. Without Jev, or out of budget, it answers `unavailable` and
// the card says nothing.
import { post } from './http.js'
import { FRAME_ASSET, FRAME_SET, frameQuestions, frameVerdict } from '@sundial/nodus/storyboard.js'

/** A JPEG data URL's payload, or null. Jev takes 280 to 1568 px a side; the card fits every frame into that (card.js `fitFrame`). */
export const jpegOf = (dataUrl) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl ?? ''))
  return m && m[1].length > 200 ? m[1] : null
}
const words = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '')

export function mountNodus(ctx) {
  post(ctx, '/gnomon/api/nodus-frame', { limit: 3_000_000, method: 'A frame takes a POST.', tooLong: 'That frame is too large.' }, async (body) => {
    const jpeg = jpegOf(body.jpeg)
    if (!jpeg) return 'That is not a JPEG frame.'
    const state = { frame: FRAME_ASSET, ask: words(body.ask), title: words(body.title), step: words(body.step, 300) || null, parts: (Array.isArray(body.parts) ? body.parts : []).slice(0, 24).map((p) => words(p, 60)) }
    const judged = await ctx.gnomonKernel?.judgeNow?.({ purpose: 'judge', questionSetId: FRAME_SET, momentId: null, state, questions: frameQuestions(), caller: 'nodus-frame', assets: { [FRAME_ASSET]: { type: 'image', data_base64: jpeg, format: 'jpeg' } } })
    return frameVerdict(judged?.answers) ?? [200, { unavailable: 'Jev did not judge this frame.' }]
  })
}
