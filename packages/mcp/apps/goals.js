// The goals app: what the owner said they want, each on its own trail against one shared scale.
//
// Draws `gnomon_goals`' structuredContent: `{ goals, quietAfterDays }`, the same object
// the web client's Goals surface reads from /gnomon/goals.
import { goalTrail, trailScale } from '../../../plugins/sundial-theme/shell/goal-trail.js'
import { el } from '../../../plugins/sundial-theme/shell/surfaces.js'
import { frame } from './lib.js'

const LIVE = new Set(['open', 'doing', 'waiting', 'blocked'])

export function row(goal, scale) {
  const live = LIVE.has(goal.state)
  const foot = [
    goal.progress?.total ? `${goal.progress.done}/${goal.progress.total} steps` : null,
    goal.targetDate ? `by ${goal.targetDate}` : null,
    goal.stale ? `quiet ${goal.quietDays} days` : null,
  ].filter(Boolean)
  return el('div', { class: `app-row${goal.child ? ' app-child' : ''}` }, [
    el('span', { class: 'app-name', text: goal.goal }),
    el('span', { class: 'app-state', text: [goal.state ?? 'open', ...foot].join(' · ') }),
    goal.why ? el('span', { class: 'app-why', text: goal.why }) : null,
    el('span', { class: 'app-trail goal-trail-cell' }, goalTrail({ life: goal.life ?? [], live, width: 420 }, scale)),
  ])
}

export function draw(data) {
  const goals = Array.isArray(data?.goals) ? data.goals : []
  if (goals.length === 0) return frame('Goals', '', el('div', { class: 'surface-fail', text: 'No goals on the record. One is recorded with gnomon_assert on kind goal.' }))
  const scale = trailScale(goals)
  const open = goals.filter((g) => LIVE.has(g.state)).length
  return frame('Goals', `${open} open of ${goals.length}`, el('div', { class: 'app-rows' }, goals.map((g) => row(g, scale))))
}
