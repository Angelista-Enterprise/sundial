// Setup and Settings: model providers, services, settings, back-fills, permissions, hearing and
// speech-to-text. Config writes go through config.json and the log (W3).
import { readJson, sendJson } from './http.js'
import { withConfigLock, writeConfigAtomic } from '@sundial/helpers/config.js'
import { isHttpUrl, isLocalUrl, parseProviders, parseUse, providerKeyEnv, providerLabel, setEnvValues } from '@sundial/helpers/llm-providers.js'
import { readFile, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { NOTICE_GROUPS } from '@sundial/kernel/notice-groups.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveSundialConfig } from '@sundial/helpers/sundial-config.js'
import { configChange, restartPaths } from '@sundial/kernel/config-log.js'
import { readSundialEnvFile } from '@sundial/helpers/sundial-env.js'
import { readFreshness } from './read-freshness.js'
import { allowed, describe, SERVICES, setPath, textValue } from '../shell/services.js'

const execFileP = promisify(execFile)

export function mountConfig(ctx, shell) {
  const { PLUGIN, agentFor, api, broadcast, home, snapshot } = shell

  /**
   * The first-run back-fill (/setup). GET: the folders worth offering and the
   * last run. POST `{roots, gitDays, calendarDays, dryRun}`: a count when
   * `dryRun`, otherwise the run itself. One run at a time: a second POST while
   * one writes gets 409, never a second copy of the same history.
   */
  /**
   * Model providers (/setup). Read from the saved files; "saved — restart to
   * use it" comes from the log (`state.config.pendingRestart`, W3).
   * API keys are written, never read back: a GET says only whether one is set.
   *
   * POST `{op}`:
   *   check   `{baseUrl, apiKey?, target?}` → the models the endpoint lists
   *   save    `{target: 'default' | 'new' | <id>, label?, baseUrl, model, apiKey?}` (empty apiKey keeps the saved one)
   *   remove  `{target}`
   *   use     `{purpose: 'default' | <purpose>, target: 'openai' | <id> | ''}` — which model does that work ('' = the default)
   *   restart → the LaunchAgent restarts Sundial; without one, the command to run
   */
  const envPath = join(home, '.env')
  const configPath = join(home, 'config.json')
  const readEnvFile = async () => readSundialEnvFile(envPath)
  const readConfigFile = async () => {
    try {
      return JSON.parse(await readFile(configPath, 'utf8'))
    } catch {
      return {}
    }
  }
  const savedProviders = async () => {
    const [env, config] = await Promise.all([readEnvFile(), readConfigFile()])
    const row = (id, baseUrl, model, label) => ({ id, label: label ?? providerLabel(baseUrl), baseUrl, model, hasKey: (env[providerKeyEnv(id)] ?? '') !== '', local: isLocalUrl(baseUrl) })
    const base = env.SUNDIAL_LLM_BASE_URL ?? ''
    return {
      default: base !== '' ? row('openai', base.replace(/\/+$/, ''), env.SUNDIAL_LLM_MODEL ?? '') : null,
      providers: parseProviders(config?.llm?.providers).map((p) => row(p.id, p.baseUrl, p.model, p.label)),
      use: parseUse(config?.llm?.use),
    }
  }
  // The background work /setup can send to one provider or another (the chat is chosen in its own picker).
  const USE_PURPOSES = ['default', 'intent', 'companion', 'extract', 'journal', 'reflect', 'refute', 'goal', 'transcript']
  // W3: every write to config.json (or .env) is also a `config:changed` in the log, inside the same lock.
  const writeConfig = async (before, next, restart = []) => {
    if (next) await writeConfigAtomic(configPath, next)
    const change = configChange(ctx.gnomonKernel.getState()?.config, resolveSundialConfig(next ?? before), [...new Set([...restartPaths(before, next ?? before), ...restart])])
    if (change) await ctx.gnomonKernel.appendSignal('config:changed', change)
  }
  const pendingRestart = () => ctx.gnomonKernel.getState()?.config?.pendingRestart ?? []
  const modelsWaiting = () => pendingRestart().some((p) => p.startsWith('llm.'))
  const LABEL = process.env.SUNDIAL_LABEL || 'dev.sundial.agent'

  api('/gnomon/api/providers', (req, res) => withConfigLock(() => providersRoute(req, res)))
  async function providersRoute(req, res) {
    if (req.method !== 'POST') {
      const saved = await savedProviders()
      sendJson(res, 200, { ...saved, restartNeeded: modelsWaiting() })
      return
    }
    const body = (await readJson(req, 8192)) ?? {}
    const text = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
    const baseUrl = text(body.baseUrl).replace(/\/+$/, '')
    const target = text(body.target, 40)

    if (body.op === 'check') {
      if (!isHttpUrl(baseUrl)) return sendJson(res, 200, { ok: false, error: 'That is not an http(s) address.' })
      const key = text(body.apiKey, 400) || (await readEnvFile())[providerKeyEnv(target === 'default' || target === '' ? 'openai' : target)] || 'gnomon-local'
      try {
        const answer = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
        if (answer.status === 401 || answer.status === 403) return sendJson(res, 200, { ok: false, error: 'The provider refused the key.' })
        if (!answer.ok) return sendJson(res, 200, { ok: false, error: `The provider answered ${answer.status}.` })
        const data = await answer.json().catch(() => null)
        const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter((id) => typeof id === 'string').sort().slice(0, 500) : []
        return sendJson(res, 200, { ok: true, label: providerLabel(baseUrl), local: isLocalUrl(baseUrl), models })
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error?.name === 'TimeoutError' ? 'No answer within 8 seconds.' : 'Nothing answered at that address.' })
      }
    }

    if (body.op === 'save') {
      const model = text(body.model, 200)
      const apiKey = text(body.apiKey, 400)
      if (!isHttpUrl(baseUrl) || model === '' || /[\s]/.test(model) || /[\s]/.test(apiKey)) return sendJson(res, 400, { unavailable: 'A provider needs an http(s) address and a model name, with no spaces.' })
      if (target === 'default') {
        setEnvValues(envPath, { SUNDIAL_LLM_BASE_URL: baseUrl, SUNDIAL_LLM_MODEL: model, ...(apiKey ? { SUNDIAL_LLM_API_KEY: apiKey } : {}) })
        await writeConfig(await readConfigFile(), null, ['llm.default'])
      } else {
        const config = await readConfigFile()
        const list = parseProviders(config?.llm?.providers)
        const label = text(body.label, 60) || providerLabel(baseUrl)
        let id = target
        if (target === 'new') {
          const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'provider'
          const stem = /^[a-z]/.test(slug) && slug.length > 1 && slug !== 'openai' && slug !== 'tensorx' ? slug : `p-${slug}`
          id = stem
          for (let n = 2; list.some((p) => p.id === id); n++) id = `${stem}-${n}`
          list.push({ id, label, baseUrl, model })
        } else {
          const at = list.findIndex((p) => p.id === target)
          if (at < 0) return sendJson(res, 404, { unavailable: 'No provider by that name.' })
          list[at] = { id, label, baseUrl, model }
        }
        if (apiKey) setEnvValues(envPath, { [providerKeyEnv(id)]: apiKey })
        await writeConfig(config, { ...config, llm: { ...(config.llm ?? {}), providers: list } }, apiKey ? ['llm.providers'] : [])
      }
      return sendJson(res, 200, { ...(await savedProviders()), restartNeeded: modelsWaiting() })
    }

    if (body.op === 'remove') {
      if (target === 'default') {
        setEnvValues(envPath, { SUNDIAL_LLM_BASE_URL: '', SUNDIAL_LLM_MODEL: '', SUNDIAL_LLM_API_KEY: '' })
        await writeConfig(await readConfigFile(), null, ['llm.default'])
      } else {
        const config = await readConfigFile()
        const list = parseProviders(config?.llm?.providers).filter((p) => p.id !== target)
        const use = Object.fromEntries(Object.entries(parseUse(config?.llm?.use)).filter(([, id]) => id !== target))
        setEnvValues(envPath, { [providerKeyEnv(target)]: '' })
        await writeConfig(config, { ...config, llm: { ...(config.llm ?? {}), providers: list, use } })
      }
      return sendJson(res, 200, { ...(await savedProviders()), restartNeeded: modelsWaiting() })
    }

    if (body.op === 'use') {
      const purpose = text(body.purpose, 20)
      const config = await readConfigFile()
      const ids = ['openai', ...parseProviders(config?.llm?.providers).map((p) => p.id)]
      if (!USE_PURPOSES.includes(purpose) || (target !== '' && !ids.includes(target))) return sendJson(res, 400, { unavailable: 'No such work or provider.' })
      const use = { ...parseUse(config?.llm?.use), [purpose]: target }
      if (target === '') delete use[purpose]
      await writeConfig(config, { ...config, llm: { ...(config.llm ?? {}), use } })
      return sendJson(res, 200, { ...(await savedProviders()), restartNeeded: modelsWaiting() })
    }

    if (body.op === 'restart') {
      // Under Sundial.app the app restarts this process when it exits.
      if (process.env.SUNDIAL_APP === '1') {
        sendJson(res, 200, { restarted: true })
        setTimeout(() => process.exit(0), 300)
        return
      }
      const uid = process.getuid?.() ?? 0
      const loaded = await execFileP('launchctl', ['print', `gui/${uid}/${LABEL}`]).then(() => true, () => false)
      if (!loaded) return sendJson(res, 200, { restarted: false, command: 'sundial restart' })
      sendJson(res, 200, { restarted: true })
      // After the answer has left: this process is the one being restarted.
      setTimeout(() => spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`], { detached: true, stdio: 'ignore' }).unref(), 300)
      return
    }

    sendJson(res, 400, { unavailable: 'Unknown operation.' })
  }

  /**
   * Services (the Settings card): every switch in config.json, its value, and
   * its last signal. POST `{id, value}` writes that one key and nothing else,
   * and logs it (W3); a switch that only a restart applies waits for one
   * (`/gnomon/api/providers` `{op: 'restart'}`), the rest apply at once.
   */
  // When this process started: a tab that asked for a restart polls until it changes.
  const bootedAt = new Date().toISOString()
  // The Claude Code hooks live in Claude's own settings, written by `sundial claude-hooks` / `claude-context`.
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const claudeSettings = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
  const claudeInstalled = async () => {
    const text = await readFile(claudeSettings, 'utf8').catch(() => '')
    const ours = (script) => text.split('\n').some((line) => line.includes(script) && line.includes(home))
    return { hooks: ours('claude-hook.mjs'), context: ours('claude-context.mjs') }
  }
  api('/gnomon/api/services', (req, res) => withConfigLock(() => servicesRoute(req, res)))
  async function servicesRoute(req, res) {
    if (req.method === 'POST') {
      const body = (await readJson(req, 1024)) ?? {}
      const service = SERVICES.find((s) => s.id === body.id)
      const typed = textValue(service, body.text)
      if (service?.text && body.text !== undefined) {
        if (typed === null) return sendJson(res, 400, { unavailable: service.id === 'push' ? 'That is not an http(s) address.' : 'Give the folder as a full path, starting with / or ~/.' })
        const folder = typed.startsWith('~/') ? join(homedir(), typed.slice(2)) : typed
        if (service.id === 'vault' && typed !== '' && !(await stat(folder).then((st) => st.isDirectory(), () => false))) return sendJson(res, 400, { unavailable: 'There is no folder at that path.' })
      } else if (!allowed(service, body.value)) return sendJson(res, 400, { unavailable: 'That service has no such switch.' })
      if (service.text) {
        const config = await readConfigFile()
        await writeConfig(config, typed === '' ? setPath(config, service.path, undefined) : setPath(config, service.path, typed))
        console.log(`[${PLUGIN}] services: ${service.path} ${typed === '' ? 'cleared' : 'set'}`)
      } else if (service.claude) {
        // The CLI owns that file's shape (idempotent, keeps every other key), so the route never edits it itself.
        const command = service.claude === 'hooks' ? 'claude-hooks' : 'claude-context'
        const ran = await execFileP(process.execPath, [join(repo, 'bin', 'sundial'), command, ...(body.value ? [] : ['--remove'])], { env: { ...process.env, SUNDIAL_HOME: home }, timeout: 20_000 }).then(() => null, (e) => e)
        if (ran) return sendJson(res, 500, { unavailable: `Could not change the Claude Code hook. Run: sundial ${command}${body.value ? '' : ' --remove'}` })
        console.log(`[${PLUGIN}] services: Claude Code ${command} ${body.value ? 'on' : 'off'} (next Claude session)`)
      } else {
        const config = await readConfigFile()
        await writeConfig(config, setPath(config, service.path, body.value))
        console.log(`[${PLUGIN}] services: ${service.path} = ${JSON.stringify(body.value)}`)
      }
    }
    const [config, freshness, claude] = await Promise.all([readConfigFile(), readFreshness(), claudeInstalled()])
    const services = describe(config, pendingRestart(), freshness, claude)
    const waiting = services.filter((s) => s.changed).map((s) => s.label)
    sendJson(res, 200, { services, restartNeeded: waiting.length > 0, waiting, bootedAt, noticeGroups: NOTICE_GROUPS.map(({ id, label, what }) => ({ id, label, what })) })
   }

  let backfilling = false
  api('/gnomon/api/backfill', async (req, res) => {
    const backfill = ctx.gnomonKernel.backfill
    if (req.method !== 'POST') return sendJson(res, 200, await Promise.all([backfill.defaults(), backfill.last()]).then(([roots, last]) => ({ roots, gitDays: 30, calendarDays: 7, mailDays: 7, last, running: backfilling })))
    const body = (await readJson(req, 8192)) ?? {}
    const opts = { roots: Array.isArray(body.roots) ? body.roots.filter((r) => typeof r === 'string' && r.trim() !== '').slice(0, 20) : [], gitDays: Number(body.gitDays ?? 30), calendarDays: Number(body.calendarDays ?? 7), mailDays: Number(body.mailDays ?? 0) }
    if (body.dryRun === true) return sendJson(res, 200, await backfill.plan(opts))
    if (backfilling) return sendJson(res, 409, { unavailable: 'A back-fill is already running.' })
    backfilling = true
    sendJson(res, 200, await backfill.run(opts).finally(() => (backfilling = false)))
  })

  /**
   * The owner's settings: read them, or change any subset.
   *
   * A POST is one `settings:set` event through the kernel, like every other
   * change — so the rules see it on the same tick, the model's tools are
   * refused by it, and every open tab hears it on the live channel.
   */
  // W5 step 10: a capability's level — the owner lowers it or lifts the ceiling (`autonomy:set`), or says yes to it acting alone (`autonomy:granted`).
  api('/gnomon/api/settings', async (req, res) => {
    const read = () => ctx.gnomonKernel.getState()?.settings ?? null
    if (req.method !== 'POST') return sendJson(res, 200, read())
    const body = await readJson(req, 4096)
    if (body === null || typeof body !== 'object') return sendJson(res, 400, { unavailable: 'The settings could not be read.' })
    if (typeof body.capability === 'string') await ctx.gnomonKernel.appendSignal(body.grant === true ? 'autonomy:granted' : 'autonomy:set', { capability: body.capability, ...(body.grant === true ? {} : { level: body.level }), by: 'owner' })
    else await ctx.gnomonKernel.appendSignal('settings:set', { ...body, by: 'owner' })
    ctx.emit('gnomon/settings', read())
    sendJson(res, 200, read())
  })

  /**
   * How much this session may do without stopping to ask.
   *
   * dsh's permission preset already IS this control — `gnomon-actions` derives
   * every one of its own verdicts from the same preset, so one switch governs
   * dsh's built-ins and Gnomon's tools together. What was missing was a way to
   * reach it: the preset lives behind a `/permission` slash command in a client
   * that does not boot here, so every session ran on whatever it was pinned
   * with and `gnomon_run_shell` asked forever.
   *
   * Auto is NOT unguarded. The destructive-command refusal in
   * `plugins/sundial-actions/destructive.js` runs regardless of preset — rm -rf,
   * sudo, dd, a curl piped into a shell, a force push — so the thing Auto turns
   * off is the prompt, not the backstop.
   *
   * A GET never wakes a sleeping session just to read a label: an agent that is
   * not live yet has no preset of its own, and the deployment default is the
   * honest answer for it.
   */
  api('/gnomon/api/permission', async (req, res, url) => {
    const presets = ctx.get?.('permissionPresets')
    if (presets === undefined) {
      sendJson(res, 200, { current: null, names: [], available: false })
      return
    }
    const names = [...presets.names]
    if (req.method !== 'POST') {
      const sessionId = url.searchParams.get('session') ?? ''
      let current = presets.defaultPreset
      const live = sessionId === '' ? undefined : ctx.agents.get(SessionId(sessionId))
      if (live !== undefined && live.status !== 'disposed') current = presets.current(live.session)
      sendJson(res, 200, { current, names, available: true, live: live !== undefined })
      return
    }
    const body = await readJson(req, 1024)
    const preset = typeof body?.preset === 'string' ? body.preset : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (!names.includes(preset) || sessionId === '') {
      sendJson(res, 400, { unavailable: 'A permission change needs a session and a known preset.' })
      return
    }
    // Resume rather than read: the switch has to land on the session the owner
    // is looking at, and a preset set on nothing is a switch that does nothing.
    const agent = await agentFor(sessionId)
    presets.set(agent.session, preset)
    const current = presets.current(agent.session)
    console.log(`[${PLUGIN}] session ${sessionId} is now ${current}`)
    sendJson(res, 200, { current, names, available: true, live: true })
  })

  /**
   * Ambient hearing, by hand: read the window, or open and close it.
   *
   * The window is normally the `hearingWindow` rule's own reading of the
   * calendar and the microphone. This is the owner overriding that reading —
   * the huddle nobody scheduled, or the hour they would rather not have heard.
   * One `hearing:set` event, folded by the same rule, so the override replays
   * and the sidecar picks it up on the next poll like any other decision.
   */
  api('/gnomon/api/hearing', async (req, res) => {
    const read = () => ctx.gnomonKernel.getState()?.hearing ?? null
    if (req.method !== 'POST') return sendJson(res, 200, read())
    const body = await readJson(req, 1024)
    if (typeof body?.listen !== 'boolean') return sendJson(res, 400, { unavailable: 'Say listen: true or listen: false.' })
    await ctx.gnomonKernel.appendSignal('hearing:set', { listen: body.listen, ...(typeof body.minutes === 'number' ? { minutes: body.minutes } : {}), by: 'owner' })
    // The strip reads hearing off the `now` frame, so every open tab sees the chip flip now, not at the next pulse.
    broadcast({ type: 'now', now: snapshot() })
    sendJson(res, 200, read())
  })

  /**
   * A spoken message, typed out by the machine's own ears.
   *
   * The audio goes to the whisper server the hearing sensor already runs on
   * loopback — never to a browser speech service, which would send the owner's
   * voice off the machine for a convenience. Body in, text out; nothing is kept.
   */
  const WHISPER = 'http://127.0.0.1:8771/inference'
  api('/gnomon/api/transcribe', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Speech takes a POST.' })
      return
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 8_000_000) {
        sendJson(res, 413, { unavailable: 'That recording is too long.' })
        return
      }
      chunks.push(chunk)
    }
    try {
      // The browser records webm/opus; whisper wants PCM WAV. ffmpeg is already
      // on this machine for the hearing sensor, so the conversion is a pipe
      // rather than a dependency — and a failure here is a clear message, not
      // a mystery empty transcript.
      let audio = Buffer.concat(chunks)
      const isWav = audio.subarray(0, 4).toString() === 'RIFF'
      if (!isWav) {
        audio = await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'wav', '-ac', '1', '-ar', '16000', 'pipe:1'])
          const out = []
          const err = []
          ff.stdout.on('data', (d) => out.push(d))
          ff.stderr.on('data', (d) => err.push(d))
          ff.on('error', reject)
          ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().slice(0, 200) || `ffmpeg exited ${code}`))))
          ff.stdin.on('error', () => {})
          ff.stdin.end(audio)
        })
      }
      const form = new FormData()
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav')
      form.append('response_format', 'json')
      const got = await fetch(WHISPER, { method: 'POST', body: form })
      if (!got.ok) {
        sendJson(res, 502, { unavailable: `The local transcriber answered ${got.status}.` })
        return
      }
      const body = await got.json()
      sendJson(res, 200, { text: String(body?.text ?? '').trim() })
    } catch (error) {
      // Not running is the ordinary case, not a fault: the hearing sensor owns
      // that process, and the owner may have it off.
      sendJson(res, 503, { unavailable: `The local transcriber is not answering on 8771. ${error instanceof Error ? error.message : ''}`.trim() })
    }
  })
}
