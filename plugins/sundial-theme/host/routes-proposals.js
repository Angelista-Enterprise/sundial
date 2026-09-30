// What Gnomon proposed and what it could not place: the assistant's proposals and their verdicts,
// untracked time and the owner's decision on it.
import { guard } from './guard.js'
import { readFile } from 'node:fs/promises'
import { post, readJson, sendJson, view } from './http.js'
import { getSundialConfigPath, withConfigLock, writeConfigAtomic } from '@sundial/helpers/config.js'
import { ruleForPlace, sanitizeProjectRule, unstableRuleReason } from '@sundial/helpers/sundial-config.js'
import { readAssistantProposals } from './read-assistant-proposals.js'
import { readAttributionProposals } from './read-attribution.js'

export function mountProposals(ctx) {
  const registerRoute = (route) => ctx.webServer.register(guard(ctx.connection, route))

  // ── What the assistant proposed ──────────────────────────────────────────
  // `gnomon_propose` writes an `assistant:proposal` signal and `assistantTrack`
  // folds it into a `proposal` loop (`proposalsOf`). Until these two routes existed that
  // slice had two readers — `context.ts` and `ambient-context.ts`, both prompt
  // builders — and no surface: 23 proposals went into the model's OWN context
  // and nowhere a person could see, while the tool told the model the owner
  // could accept or reject them. These routes are the missing half. The verdict
  // writes the same `assistant:response` signal `gnomon_record_outcome` writes,
  // for the same reason a tapped answer and a typed one share a signal above.

  view(ctx, '/gnomon/assistant/proposals', 'The proposals could not be read.', () => readAssistantProposals({ state: ctx.gnomonKernel.getState(), now: Date.now() }))

  // `assistantTrack` ignores an id that is not an open proposal, so a stale tab is inert.
  post(ctx, '/gnomon/assistant/verdict', { method: 'A verdict takes a POST.', tooLong: 'That verdict is too long.' }, async (body) => {
    const proposalId = typeof body.proposalId === 'string' ? body.proposalId.trim() : ''
    const verdict = typeof body.verdict === 'string' ? body.verdict.trim() : ''
    if (proposalId === '' || (verdict !== 'accepted' && verdict !== 'rejected')) return 'A verdict needs a proposalId and either "accepted" or "rejected".'
    await ctx.gnomonKernel.appendSignal('assistant:response', { proposalId, verdict })
    return { recorded: true, proposalId, verdict }
  })

  // ── Untracked time, and what to call it ──────────────────────────────────
  // `attributionPropose` times every unattributed focus period by host or app.
  // These two routes are the surface: the biggest candidates as proposals, and
  // the owner's decision — which writes a ProjectRule to config.json AND
  // appends `attribution:rule-decided`, so the same rule lands on
  // `state.config.projectRules` in the fold and applies to the next window.

  // The one config path, honouring SUNDIAL_HOME: a second `join(homedir(), …)` is
// how a scratch run's decision lands in the real config file.
const CONFIG_PATH = getSundialConfigPath()

  view(ctx, '/gnomon/attribution/proposals', 'The untracked places could not be read.', (url) => readAttributionProposals({ state: ctx.gnomonKernel.getState(), url }))

  ctx.effect(() =>
    registerRoute({
      kind: 'exact',
      path: '/gnomon/attribution/decide',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { unavailable: 'Deciding takes a POST.' })
          return
        }
        let parsed = null
        try {
          parsed = await readJson(req, 4096)
        } catch (error) {
          sendJson(res, error.status, { unavailable: error.status === 413 ? 'That decision is too long.' : 'The decision could not be read.' })
          return
        }
        const key = typeof parsed?.key === 'string' ? parsed.key.trim() : ''
        const DECISIONS = { assign: 'assigned', ignore: 'ignored', shared: 'shared', personal: 'personal', ambient: 'ambient' }
        const decision = DECISIONS[parsed?.decision] ?? null
        const project = typeof parsed?.project === 'string' ? parsed.project.trim().slice(0, 80) : ''
        // The part of the place being assigned, when the owner is splitting a
        // multi-project host rather than claiming all of it.
        const partKey = typeof parsed?.partKey === 'string' ? parsed.partKey.trim().slice(0, 200) : ''
        if (key === '' || decision === null || (decision === 'assigned' && project === '')) {
          sendJson(res, 400, { unavailable: 'A decision needs a key, and a project when it assigns one.' })
          return
        }
        const state = ctx.gnomonKernel.getState()
        const candidate = state.attributionProposals?.candidates?.[key] ?? null
        const kind = candidate?.kind ?? (key.startsWith('host:') ? 'host' : key.startsWith('app:') ? 'app' : null)
        const label = candidate?.label ?? key.replace(/^(host|app):/, '')
        if (kind === null || label === '') {
          sendJson(res, 404, { unavailable: 'That is not something Gnomon is timing.' })
          return
        }

        // The part the owner picked, when they picked one: `path:/puzzlez` or
        // `title:Planner`. The part decides how NARROW the rule is.
        const part = partKey === '' ? null : (state.attributionProposals?.candidates?.[key]?.parts?.[partKey] ?? null)

        let rule = null
        if (decision === 'assigned') {
          // A part narrows the rule to one path, one page title or one meeting,
          // which is what lets figma.com be Northwind on one file and overture on
          // another, and a Meet tab be whichever project the calendar says.
          // A rule the caller stated wins over one derived from the place: a
          // title or meeting rule cannot be worked out from a host alone, and it
          // is the durable kind. Both go through the ONE validator and the ONE
          // durability guard, which live in helpers beside the config parser.
          const built = parsed?.rule !== undefined ? { rule: sanitizeProjectRule({ ...parsed.rule, project }) } : ruleForPlace(kind, label, part, project)
          if (built.rule === null) {
            sendJson(res, 409, { unavailable: built.reason ?? 'a rule needs a project and at least one matcher.' })
            return
          }
          const unstable = unstableRuleReason(built.rule)
          if (unstable !== null) {
            sendJson(res, 409, { unavailable: unstable })
            return
          }
          rule = built.rule
        }
        // config.json is the durable half of every decision: a rule to match on,
        // a shared place to stop asking about, a personal one to classify as the
        // owner's own time. Written first — nothing is folded that was not saved.
        if (decision !== 'ignored') {
          try {
            await withConfigLock(async () => {
            let file = {}
            try {
              file = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error
            }
            if (rule !== null) {
              const rules = Array.isArray(file.projectRules) ? file.projectRules : []
              if (!rules.some((r) => JSON.stringify(r) === JSON.stringify(rule))) rules.push(rule)
              file.projectRules = rules
            }
            if (decision === 'shared') {
              const shared = Array.isArray(file.sharedPlaces) ? file.sharedPlaces : []
              const entry = kind === 'host' ? label : `app:${label}`
              if (!shared.some((e) => String(e).toLowerCase() === entry.toLowerCase())) shared.push(entry)
              file.sharedPlaces = shared
            }
            if (decision === 'personal' || decision === 'ambient') {
              // The owner's own taxonomy, not a project rule: a host goes in the
              // domain overrides, an app in the process overrides. `ambient` is
              // the class their taxonomy has for music playing while they work —
              // filing that as leisure would mean they never lack rest, which
              // silently disables the detector that exists to notice exactly that.
              const leisure = typeof file.leisureRules === 'object' && file.leisureRules !== null ? file.leisureRules : {}
              const bucket = kind === 'host' ? 'domainOverrides' : 'processes'
              const group = typeof leisure[bucket] === 'object' && leisure[bucket] !== null ? leisure[bucket] : {}
              const list = Array.isArray(group[decision]) ? group[decision] : []
              if (!list.some((e) => String(e).toLowerCase() === label.toLowerCase())) list.push(label)
              file.leisureRules = { ...leisure, [bucket]: { ...group, [decision]: list } }
            }
            await writeConfigAtomic(CONFIG_PATH, file)
            })
          } catch (error) {
            console.error(`[sundial-theme] could not write ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`)
            sendJson(res, 500, { unavailable: 'The decision could not be written to config.json, so nothing was changed.' })
            return
          }
        }
        try {
          await ctx.gnomonKernel.appendSignal('attribution:rule-decided', { key, kind, decision, project: project || null, ...(partKey ? { partKey } : {}), ...(rule ? { rule } : {}) })
          console.log(`[sundial-theme] attribution ${decision}: ${key}${project ? ` → ${project}` : ''}`)
          sendJson(res, 200, { recorded: true, key, decision, rule })
        } catch (error) {
          console.error(`[sundial-theme] decision failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { unavailable: 'That decision could not be recorded.' })
        }
      },
    }),
  )
}
