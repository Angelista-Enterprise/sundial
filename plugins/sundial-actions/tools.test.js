// The two capabilities whose tool half can disagree with their rule half.
//
// A wake-up's key and an ask's id are the ONLY handles the model gets back, and
// both are used later to cancel or to answer. A tool that reports a handle the
// fold never stored produces a cancel that silently does nothing, which reads as
// "Gnomon ignored me" and cannot be diagnosed from either side alone.
import { describe, it, expect, vi } from 'vitest'
import { internalTools, calendarCreateTool } from './tools.js'

function harness(state = { ownerAsk: { open: null } }) {
  const sent = []
  const tools = internalTools(async (type, payload) => sent.push({ type, payload }), () => state)
  return { sent, byName: Object.fromEntries(tools.map((t) => [t.name, t])) }
}

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()

describe('gnomon_schedule_wakeup', () => {
  it('returns the SAME key it put on the signal, so a later cancel names something real', async () => {
    const { sent, byName } = harness()
    const result = await byName.gnomon_schedule_wakeup.execute({ at: inAnHour(), reason: 'Check the deploy' })

    expect(result.key).toBe('check-the-deploy')
    expect(sent[0].type).toBe('wakeup:scheduled')
    expect(sent[0].payload.key).toBe(result.key)
  })

  it('honours an explicit key unchanged', async () => {
    const { sent, byName } = harness()
    const result = await byName.gnomon_schedule_wakeup.execute({ at: inAnHour(), reason: 'anything', key: 'deploy-watch' })
    expect(result.key).toBe('deploy-watch')
    expect(sent[0].payload.key).toBe('deploy-watch')
  })

  it('refuses a past time loudly instead of letting the rule drop it silently', async () => {
    const { sent, byName } = harness()
    await expect(byName.gnomon_schedule_wakeup.execute({ at: '2020-01-01T00:00:00.000Z', reason: 'too late' })).rejects.toThrow('future')
    expect(sent).toEqual([])
  })

  it('refuses a time beyond the horizon the rule would reject', async () => {
    const far = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString()
    const { byName } = harness()
    await expect(byName.gnomon_schedule_wakeup.execute({ at: far, reason: 'too far' })).rejects.toThrow('14 days')
  })

  it('refuses a reason that slugifies to nothing rather than storing an empty key', async () => {
    const { byName } = harness()
    await expect(byName.gnomon_schedule_wakeup.execute({ at: inAnHour(), reason: '???' })).rejects.toThrow('letter or digit')
  })
})

describe('gnomon_ask_owner', () => {
  it('refuses a second question while one is open, naming the one still outstanding', async () => {
    const open = { askId: 'owner-ask:1', question: 'Which project is this?' }
    const { sent, byName } = harness({ ownerAsk: { open } })
    const result = await byName.gnomon_ask_owner.execute({ question: 'And this one?' })

    expect(result.asked).toBe(false)
    expect(result.askId).toBe('owner-ask:1')
    expect(result.reason).toContain('Which project is this?')
    expect(sent).toEqual([])
  })

  it('returns the askId it put on the signal, so the answer can be recorded against it', async () => {
    const { sent, byName } = harness()
    const result = await byName.gnomon_ask_owner.execute({ question: 'Which project?', reason: 'two match' })

    expect(result.asked).toBe(true)
    expect(sent[0].type).toBe('ask:owner-opened')
    expect(sent[0].payload.askId).toBe(result.askId)
    expect(sent[0].payload.reason).toBe('two match')
    expect(sent[0].payload.mode).toBeUndefined()
  })

  it('wait: true holds the turn until the fold closes the ask, then returns the recorded answer', async () => {
    const state = { ownerAsk: { open: null, recent: [] } }
    const sent = []
    const tools = internalTools(
      async (type, payload) => {
        sent.push({ type, payload })
        // Stand-in for the fold: open now, answered one poll later.
        state.ownerAsk.open = { askId: payload.askId, question: payload.question }
        setTimeout(() => {
          state.ownerAsk.open = null
          state.ownerAsk.recent = [{ askId: payload.askId, question: payload.question, answer: 'sundial', answeredAt: 'now' }]
        }, 15)
      },
      () => state,
      { askWaitMs: 500, askPollMs: 5 },
    )
    const ask = tools.find((t) => t.name === 'gnomon_ask_owner')
    const result = await ask.execute({ question: 'Which project?', choices: ['sundial', 'overture'], wait: true })

    expect(sent[0].payload.mode).toBe('wait')
    expect(result).toMatchObject({ asked: true, answered: true, answer: 'sundial' })
  })

  it('wait: true gives up after the deadline and says the question stays open', async () => {
    const state = { ownerAsk: { open: null, recent: [] } }
    const tools = internalTools(
      async (_type, payload) => {
        state.ownerAsk.open = { askId: payload.askId, question: payload.question }
      },
      () => state,
      { askWaitMs: 20, askPollMs: 5 },
    )
    const ask = tools.find((t) => t.name === 'gnomon_ask_owner')
    const result = await ask.execute({ question: 'Still there?', wait: true })
    expect(result.asked).toBe(true)
    expect(result.answered).toBe(false)
    expect(result.reason).toContain('stays open')
  })
})


describe('gnomon_calendar_create', () => {
  const helperOk = { created: true, event: { eventId: 'E1', title: 'Deep work', startDate: '2026-09-04T12:00:00.000Z', endDate: '2026-09-04T14:00:00.000Z', calendar: 'Work' }, error: null, accessGranted: true }
  const fakeRun = (reply) => vi.fn((_path, _argv, _opts, cb) => cb(null, JSON.stringify(reply)))

  it('spawns the helper with --create and the event as arguments, then records the action', async () => {
    const appendSignal = vi.fn(async () => {})
    const run = fakeRun(helperOk)
    const tool = calendarCreateTool(appendSignal, '/bundle/sundial-calendar-helper', run)
    const result = await tool.execute({ title: 'Deep work', start: '2026-09-04T14:00:00+02:00', end: '2026-09-04T16:00:00+02:00', calendar: 'Work' })

    expect(run.mock.calls[0][0]).toBe('/bundle/sundial-calendar-helper')
    expect(run.mock.calls[0][1]).toEqual(['--create', '--title', 'Deep work', '--start', '2026-09-04T14:00:00+02:00', '--end', '2026-09-04T16:00:00+02:00', '--calendar', 'Work'])
    expect(result).toEqual({ created: true, eventId: 'E1', title: 'Deep work', start: '2026-09-04T12:00:00.000Z', end: '2026-09-04T14:00:00.000Z', calendar: 'Work' })
    expect(appendSignal).toHaveBeenCalledWith('action:performed', expect.objectContaining({ tool: 'calendar_create', eventId: 'E1' }))
  })

  it('reports a refusal from EventKit without recording an action', async () => {
    const appendSignal = vi.fn(async () => {})
    const tool = calendarCreateTool(appendSignal, '/h', fakeRun({ created: false, event: null, error: 'no writable calendar named Nope; writable calendars: Work, Home', accessGranted: true }))
    const result = await tool.execute({ title: 'x', start: 'a', end: 'b', calendar: 'Nope' })
    expect(result.created).toBe(false)
    expect(result.error).toContain('Work, Home')
    expect(appendSignal).not.toHaveBeenCalled()
  })

  it('names the missing permission when Calendar access was never granted', async () => {
    const tool = calendarCreateTool(vi.fn(), '/h', fakeRun({ created: false, event: null, error: 'Calendar access not granted', accessGranted: false }))
    const result = await tool.execute({ title: 'x', start: 'a', end: 'b' })
    expect(result.error).toContain('System Settings')
  })

  it('refuses to run without a title, start and end', async () => {
    const tool = calendarCreateTool(vi.fn(), '/h', vi.fn())
    await expect(tool.execute({ title: '', start: 'a', end: 'b' })).rejects.toThrow('required')
  })
})

describe('repeating jobs', () => {
  const kept = { standup: { subject: 'Standup', brief: 'b', schedule: 'every monday at 9am', lastRunAt: '2026-09-24T10:00:00.000Z' } }

  it('keeps a job on a readable schedule and says when it runs next', async () => {
    const { sent, byName } = harness({ config: { timezone: 'Europe/Amsterdam' }, workbench: { queue: [] } })
    const result = await byName.gnomon_start_job.execute({ subject: 'Standup', brief: 'Last week, per project.', repeat: 'every monday at 9am' })
    expect(sent).toEqual([{ type: 'work:requested', payload: { subject: 'Standup', brief: 'Last week, per project.', repeat: 'every monday at 9am' } }])
    expect(result).toMatchObject({ queued: false, subject: 'Standup', repeat: 'every monday at 9am' })
    expect(result.nextRun).toMatch(/Monday/)
  })

  it('refuses a schedule it cannot read, with the shape it wants', async () => {
    const { sent, byName } = harness({ workbench: {} })
    await expect(byName.gnomon_start_job.execute({ subject: 'X', brief: 'y', repeat: 'every 2 hours' })).rejects.toThrow(/days then a time/)
    expect(sent).toEqual([])
  })

  it('stops one by subject, and names the kept ones when the subject is wrong', async () => {
    const { sent, byName } = harness({ workbench: { repeats: kept } })
    await expect(byName.gnomon_stop_repeat.execute({ subject: 'standups' })).rejects.toThrow(/"Standup" \(every monday at 9am\)/)
    expect(await byName.gnomon_stop_repeat.execute({ subject: 'standup' })).toEqual({ stopped: 'Standup', remaining: [] })
    expect(sent).toEqual([{ type: 'work:repeat-stopped', payload: { subject: 'standup' } }])
  })
})
