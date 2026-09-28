// The owner's verdict on one thing Gnomon produced — the same three taps on
// every shown line (J0.8). Goes to the kernel as `feedback:verdict` with no
// model in between; `feedbackTrack` folds it (a `wrong` on a fact RETRACTS it,
// a `not-now` quiets the notice key). The taps settle into one word once
// recorded, so a line cannot be rated twice by accident.
//
// `not-now` is a verdict, not a dismissal: it says the timing was off without
// disputing the observation, and the gate learns from it. Until now only the
// notice card and the shelf offered it; every other surface had two taps and
// so could not say the one thing the gate can act on.
import { el } from './surfaces.js'

export const VERDICT_LABELS = { useful: 'Useful', 'not-now': 'Not now', wrong: 'Wrong' }
/** The word a settled line shows. */
export const VERDICT_WORDS = { useful: 'useful', 'not-now': 'not now', wrong: 'wrong' }

/** POST one verdict. Resolves true when the kernel took it. */
export async function postVerdict(artifactKind, artifactId, verdict, note) {
  try {
    const res = await fetch('/gnomon/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifactKind, artifactId, verdict, ...(note ? { note } : {}) }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Three small acts. `onSettled(verdict|null)` fires after the kernel answered
 * (null when it did not), for a caller that wants to dim or remove its line.
 */
export function verdictActs(artifactKind, artifactId, { onSettled = null, words = VERDICT_WORDS } = {}) {
  const wrap = el('span', { class: 'verdicts' })
  const settle = (text) => wrap.replaceChildren(el('span', { class: 'verdict-done', text }))
  for (const verdict of ['useful', 'not-now', 'wrong']) {
    wrap.append(
      el('button', {
        type: 'button',
        class: 'act act-small',
        text: VERDICT_LABELS[verdict],
        onclick: async () => {
          for (const b of wrap.querySelectorAll('button')) b.disabled = true
          const ok = await postVerdict(artifactKind, artifactId, verdict)
          settle(ok ? words[verdict] ?? verdict : 'not recorded')
          onSettled?.(ok ? verdict : null)
        },
      }),
    )
  }
  return wrap
}
