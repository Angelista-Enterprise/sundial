// What the slip's locator draws (shell/eye.js): the newest look (`screen:looked`, sanitized at ingest), the part the last
// act was on and the part a waiting ask marks on it. The fold holds a pointer (`marks.lastLook`); the parts stay in the row.
// The smallest data out: each part's label, role, area and frame; the app, the window's title and frame; the screen's frame.
// No values: what is typed in a field never leaves here.
import { getSignalsInRange } from '@sundial/db/index.js'
import { eyeKey } from '../shell/eye.js'

const ok = (f) => Array.isArray(f) && f.length === 4 && f.every(Number.isFinite) && f[2] > 0 && f[3] > 0
const field = (role) => /field|textarea|combo/i.test(role)

/** A part as the locator says it: its name (a text's words are its name; a field's typed value never is), role, area, frame. */
const partOf = (e) => {
  if (!e || !ok(e.frame)) return null
  const role = `${e.sub ?? ''}${e.role ?? ''}`
  const said = Array.isArray(e.screenText) ? e.screenText : []
  return { role, label: String(said[0] || (field(role) ? '' : said[1]) || ''), area: String(said[2] ?? ''), frame: e.frame }
}

/** The display the window is on, as [x, y, w, h] in the look's points: `screen.displays` when there are several, else `screen.size`. */
export function screenOf(row) {
  const s = row?.screen
  const f = ok(row?.frame) ? row.frame : null
  const mid = f ? [f[0] + f[2] / 2, f[1] + f[3] / 2] : [0, 0]
  const shown = (Array.isArray(s?.displays) ? s.displays : []).filter(ok).find(([x, y, w, h]) => mid[0] >= x && mid[0] < x + w && mid[1] >= y && mid[1] < y + h)
  if (shown) return shown
  if (Array.isArray(s?.size) && s.size.length === 2 && s.size.every((n) => Number.isFinite(n) && n > 0)) return [0, 0, s.size[0], s.size[1]]
  return f ? [0, 0, f[0] + f[2], f[1] + f[3]] : null
}

export async function readEye({ state, queries = { getSignalsInRange } }) {
  const marks = state?.marks
  const key = eyeKey(marks)
  const last = marks?.lastLook
  if (!last) return { key, look: null }
  if (last.refused) return { key, look: { id: last.id, at: last.at ?? null, refused: true } }
  const t = Date.parse(last.at ?? '')
  const [from, to] = Number.isNaN(t) ? [Date.now() - 60_000, Date.now() + 5_000] : [t - 5_000, t + 5_000]
  const rows = await queries.getSignalsInRange(new Date(from).toISOString(), new Date(to).toISOString(), 8, ['screen:looked'], 0, last.id)
  const row = rows.findLast((r) => r.data?.id === last.id)?.data
  if (!row) return { key, look: null }
  const parts = (Array.isArray(row.elements) ? row.elements : []).slice(0, 150)
  const find = (ref) => (ref ? parts.find((e) => e.ref === ref) : undefined)
  // ponytail: a ref is the act's when the act was on this look, this look followed it, or the run's tag keeps refs across looks.
  const act = marks.lastAct
  const ref = String(act?.target?.ref ?? '')
  const acted = ref && find(ref) && (act.target.look === last.id || row.after === act.id || row.tag) ? ref : null
  const asked = (marks.now ?? []).find((m) => m.id.startsWith('ask:') && m.target?.look === last.id && find(m.target?.ref))?.target.ref ?? null
  return {
    key,
    look: { id: last.id, at: last.at ?? null, app: row.processName ?? last.app, window: row.windowTitle ?? '', frame: ok(row.frame) ? row.frame : null },
    screen: screenOf(row),
    acted: partOf(find(acted)),
    asked: partOf(find(asked)),
  }
}
