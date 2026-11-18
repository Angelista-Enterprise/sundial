// gnomon_skill (Set 2 Round 3): the owner says "run <skill>" and a route they kept as a skill (self-review's shelf,
// `state.selfReview.skills`) runs, all its steps in one screen_act call with no model step between them. The call goes
// through dsh's own pipeline (tools.execute, as gnomon_pull_up does), so the gate asks for it as for any screen_act: a
// final in it asks under every preset, test mode too. A refused or failed step stops it (screen_act does) and the turn
// goes back to the model with the window as it is. A private app is refused; the rig's skills run only in the rig's chats.
// Set 5 2A: a learned route runs the same way by its id, as "Worked here before" lists it: {app, route: "r12345", values:
// {"To": ..., "Subject": ...}}, the values by the route's named places.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { routeIdOfKey, skillLabel } from '@sundial/helpers/screen-routes.js'
import { keptKeys, keptSkills, replayRows, replayed, routeById, routeBySkill } from './screen-pick.js'

const textOf = (result) => (result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') || String(result?.error?.message ?? '')
const norm = (s) => String(s ?? '').trim().replace(/^run\s+/i, '').replace(/^["']|["']$/g, '').toLowerCase()

/** `tools` is dsh's registry; `readSteps(app)` the app's `screen:step` rows, `readWorks(app)` its `routeWorks` route keys (index.js). */
export function skillTool({ tools, getState, readSteps, readWorks = async () => [], appendSignal }) {
  return defineTool({
    name: 'gnomon_skill',
    description: 'Run a learned route by its id, {app, route: "r12345", values: {"<place>": "<text>"}}, as "Worked here before" lists it, or a skill the owner kept, by its name ("run <name>"): all its steps in one call. Every text comes from this task, never an earlier one. The owner approves it as a screen_act. A failed step hands back the window: go on from there.',
    parameters: {
      route: { type: 'string', description: 'A route\'s id, as "Worked here before" lists it ("r12345"), with app and values.' },
      app: { type: 'string', description: 'With route: the app the route was learned in, as the list names it.' },
      values: { type: 'json', description: 'With route: a text for each named place of the route, by its name: {"To": "...", "Subject": "..."}.' },
      name: { type: 'string', description: 'A kept skill\'s id (or name), as the brief lists it.' },
      blanks: { type: 'json', description: 'With name: the texts it types, by place name or in order: ["Groceries"].' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const session = exec?.agent?.session?.id
      const state = getState()
      const skills = keptSkills(state, session)
      // Set 5 R1: a kept skill by its name or its id (the brief lists it by id, `skillLabel`), also when sent as a route's id.
      const skill = skills.find((s) => norm(s.name) === norm(args?.name ?? args?.route) || routeIdOfKey(s.app, s.routeKey) === String(args?.name ?? args?.route ?? '').trim())
      if (!skill && args?.route !== undefined && args?.route !== null && String(args.route).trim() !== '') return byId(args, exec, session, state)
      if (!skill) throw new Error(`No kept skill is called ${JSON.stringify(String(args?.name ?? '').trim())}. ${skills.length ? `The kept skills: ${skills.map((s) => skillLabel(s.app, s.name, s.routeKey)).join(', ')}.` : 'The owner has kept no skill yet.'}`)
      const found = routeBySkill({ app: skill.app, name: skill.name, routeKey: skill.routeKey, values: args.values ?? args.blanks, rows: replayRows(await readSteps(skill.app), state, session, { rigOnly: true }) })
      if (found.error) throw new Error(found.error)
      const label = skillLabel(skill.app, skill.name, skill.routeKey)
      return run(found, skill.app, `Run the skill ${label}`, exec, session, label)
    },
  })

  /** The found steps as one screen_act call through dsh's pipeline (the gate asks for it), counted by `replayed`. */
  function run(found, app, because, exec, session, skill) {
    const step = { callId: `${exec?.callId}:screen_act`, rootCallId: exec?.rootCallId ?? exec?.callId, name: 'screen_act', arguments: { app, goal: found.goal, steps: found.steps, because }, agent: exec?.agent, parent: exec?.token, signal: exec?.signal }
    return replayed({ found, app, session, appendSignal, getState, ...(skill ? { skill } : {}) }, async () => {
      const result = await tools.execute(step)
      if (result?.isError) throw new Error(textOf(result))
      return textOf(result)
    })
  }

  /** A learned route by its id (Set 5 2A): the rig's runs in the rig's chats, the owner's in the owner's, as screen_act replays them. */
  async function byId(args, exec, session, state) {
    const app = String(args.app ?? '').trim()
    const id = String(args.route).trim()
    if (!app) throw new Error(`invalid arguments: the route ${id} needs the app it was learned in, as the list names it: {"app": "<the app>", "route": ${JSON.stringify(id)}, "values": {...}}`)
    const found = routeById({ app, id, values: args.values ?? args.blanks, rows: replayRows(await readSteps(app), state, session), works: await readWorks(app).catch(() => []), kept: keptKeys(state, session, app) })
    if (found.error) throw new Error(found.error)
    return run(found, app, `Run the route ${id} (${found.name})`, exec, session)
  }
}
