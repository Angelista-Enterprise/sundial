// Plan 15 step 2: what a turn is about. After a quiet summon the place the
// app saw is only offered (`data.offer`); the owner attaches it with the chip
// or by pointing at it in words. The selected text rides only after the chip's click: a word is not a yes to send it.

const POINTING = /\b(this|here|that error|dit|deze|hier)\b/i

/** True when the words point at what is on screen. */
export const points = (text) => POINTING.test(String(text ?? ''))

/** The turn's place, and after a quiet summon its id and the selected text. `data` is the composer's dataset; `view` names the board view. */
export function turnPlace(text, data, view) {
  return { ...placeOf(text, data, view), ...spokenOf(text, data) }
}

function placeOf(text, data, view) {
  if (!data.summon) return { place: data.place ?? view() }
  const place = data.place ?? (data.offer && points(text) ? data.offer : '')
  return { place, summon: data.summon, ...(data.place !== undefined && data.place === data.offer && data.selected ? { selected: data.selected } : {}) }
}

/** Plan 15 step 3: the words the owner said with the key held. Only that exact text is a spoken turn: a later typed one is not. */
function spokenOf(text, data) {
  try {
    const spoken = data.spoken ? JSON.parse(data.spoken) : null
    return spoken?.text === text ? { voice: true, ...(typeof spoken.lang === 'string' ? { lang: spoken.lang } : {}) } : {}
  } catch {
    return {}
  }
}
