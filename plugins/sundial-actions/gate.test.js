// The action gate is the one place a wrong answer lets the assistant touch
// something it should not, so it is tested to the corners — every preset ×
// tool-class cell of the table, the bash destructive-deny, and that
// config.actions can tighten but never loosen.
import { describe, it, expect } from 'vitest'
import { callFacts, callRecord, decideAction, decisionRecord, escalate, GNOMON_TOOLS, judgedAction, neverRan, openedByOwner, outwardCall, parseMcpToolName, shellWrite, unverifiedNotice } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { autonomyOf } from './index.js'

// A resolved actions config, defaults matching @sundial/helpers (internal auto,
// outward off). Most tests pass a permissive-internal config so the PRESET is
// what drives the verdict; the override tests deliberately tighten.
function config(over = {}) {
  return {
    internal: { default: 'auto', byTool: {}, ...over.internal },
    outward: { default: 'auto', byTool: {}, ...over.outward },
    filesystemAllow: over.filesystemAllow ?? [],
  }
}

// Decide with sensible defaults; override per test.
function decide(over) {
  return decideAction({
    toolName: over.toolName,
    args: over.args ?? {},
    preset: over.preset,
    approvalOverride: over.approvalOverride,
    actions: over.actions ?? config(),
    autonomy: over.autonomy,
    resolveActionPolicy,
    integrations: over.integrations ?? [],
    isIntegrationRead: over.isIntegrationRead,
    ownerTurn: over.ownerTurn,
  })
}

const INTERNAL_TOOLS = ['gnomon_claim', 'gnomon_assert', 'gnomon_propose', 'gnomon_draft', 'gnomon_record_outcome', 'gnomon_schedule_wakeup', 'gnomon_cancel_wakeup', 'gnomon_ask_owner', 'gnomon_owner_answer', 'gnomon_start_job', 'gnomon_stop_repeat']

describe('dsh built-in tools are no longer gated by gnomon', () => {
  it.each(['read', 'write', 'edit', 'web_fetch', 'web_search', 'read_image', 'get_goal'])(
    'allows dsh built-in %s regardless of preset (dsh governs it natively)',
    (toolName) => {
      for (const preset of ['read-only', 'workspace-write', 'danger-full-access', 'custom', undefined]) {
        expect(decide({ toolName, preset, args: { path: '/etc/passwd', url: 'https://x' } })).toEqual({ kind: 'allow' })
      }
    },
  )
})

describe('bash — the one dsh built-in gnomon adds a layer to', () => {
  it('runs an ordinary bash command on the outward ladder: off, ask, auto', () => {
    expect(decide({ toolName: 'bash', args: { command: 'ls -la' }, preset: 'read-only' }).kind).toBe('deny')
    expect(decide({ toolName: 'bash', args: { command: 'ls -la' }, preset: 'workspace-write' }).kind).toBe('ask')
    expect(decide({ toolName: 'bash', args: { command: 'ls -la' }, preset: 'custom' }).kind).toBe('ask')
    expect(decide({ toolName: 'bash', args: { command: 'ls -la' }, preset: 'danger-full-access' })).toEqual({ kind: 'allow' })
  })

  it('refuses bash in a job nobody can answer, the way it refuses an outward write', () => {
    expect(decide({ toolName: 'bash', args: { command: 'curl https://x' }, preset: undefined, approvalOverride: 'never' }).kind).toBe('deny')
  })

  it('DENIES a destructive bash command regardless of preset — even danger-full-access', () => {
    for (const preset of ['read-only', 'workspace-write', 'danger-full-access', undefined]) {
      const d = decide({ toolName: 'bash', args: { command: 'rm -rf ~' }, preset })
      expect(d.kind, `bash rm -rf ~ under ${preset}`).toBe('deny')
      expect(d.reason).toMatch(/destructive/i)
    }
  })
})

describe("gnomon's internal writes map from the preset", () => {
  it.each(INTERNAL_TOOLS)('read-only DENIES %s — read only means read only, and an internal write is a write', (toolName) => {
    expect(decide({ toolName, preset: 'read-only' }).kind).toBe('deny')
  })
  // The rung the internal/outward split exists for. `workspace-write` says
  // writes to the owner's working world are fine, and gnomon's own append-only
  // log is the most workspace-like thing it touches. The visible cost of the
  // old behaviour: gnomon needed the owner's approval in order to ask the owner
  // a question, which made gnomon_ask_owner unusable from any surface that
  // cannot draw an approval prompt.
  it.each(INTERNAL_TOOLS)('workspace-write ALLOWS %s without a prompt', (toolName) => {
    expect(decide({ toolName, preset: 'workspace-write' })).toEqual({ kind: 'allow' })
  })
  it.each(INTERNAL_TOOLS)('danger-full-access ALLOWS %s', (toolName) => {
    expect(decide({ toolName, preset: 'danger-full-access' })).toEqual({ kind: 'allow' })
  })

  it('does not extend that to outward tools — run_shell still stops at workspace-write', () => {
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'ls' }, preset: 'workspace-write' }).kind).toBe('ask')
  })
})

describe('gnomon_run_shell maps from the preset AND blocks destructive commands', () => {
  it('read-only DENIES run_shell', () => {
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'ls' }, preset: 'read-only' }).kind).toBe('deny')
  })
  it('workspace-write ASKS for a benign run_shell', () => {
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'ls' }, preset: 'workspace-write' }).kind).toBe('ask')
  })
  it('danger-full-access ALLOWS a benign run_shell', () => {
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'ls' }, preset: 'danger-full-access' })).toEqual({ kind: 'allow' })
  })
  it('DENIES a destructive run_shell regardless of preset — even danger-full-access', () => {
    for (const preset of ['read-only', 'workspace-write', 'danger-full-access', undefined]) {
      const d = decide({ toolName: 'gnomon_run_shell', args: { command: 'sudo rm -rf /' }, preset })
      expect(d.kind, `run_shell destructive under ${preset}`).toBe('deny')
      expect(d.reason).toMatch(/destructive/i)
    }
  })
})

describe('custom / unknown / missing preset falls back to the approval policy', () => {
  it.each(INTERNAL_TOOLS)('approval never → ALLOW for internal %s (a job must be able to report back)', (toolName) => {
    expect(decide({ toolName, args: { command: 'ls' }, preset: 'custom', approvalOverride: 'never' })).toEqual({ kind: 'allow' })
    expect(decide({ toolName, args: { command: 'ls' }, preset: undefined, approvalOverride: 'never' })).toEqual({ kind: 'allow' })
  })
  it.each(['gnomon_run_shell', 'gnomon_calendar_create', 'web_act'])('approval never → DENY for outward %s (nobody can approve inside a job)', (toolName) => {
    expect(decide({ toolName, args: { command: 'ls' }, preset: 'custom', approvalOverride: 'never' }).kind).toBe('deny')
    expect(decide({ toolName, args: { command: 'ls' }, preset: undefined, approvalOverride: 'never' }).kind).toBe('deny')
  })
  it.each([...INTERNAL_TOOLS, 'gnomon_run_shell'])('approval ask (or absent) → ASK for %s', (toolName) => {
    expect(decide({ toolName, args: { command: 'ls' }, preset: 'custom', approvalOverride: 'ask' }).kind).toBe('ask')
    expect(decide({ toolName, args: { command: 'ls' }, preset: 'my-weird-preset', approvalOverride: undefined }).kind).toBe('ask')
  })
  it('still blocks destructive run_shell under a custom preset', () => {
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'rm -rf /' }, preset: 'custom', approvalOverride: 'never' }).kind).toBe('deny')
  })
})

describe('config.actions is a TIGHTEN-ONLY override for gnomon tools', () => {
  it('tightens danger-full-access ALLOW → ASK when the tool is set to ask', () => {
    const actions = config({ internal: { default: 'auto', byTool: { claim: 'ask' } } })
    expect(decide({ toolName: 'gnomon_claim', preset: 'danger-full-access', actions }).kind).toBe('ask')
  })

  it('tightens danger-full-access ALLOW → DENY when the tool is set to off', () => {
    const actions = config({ outward: { default: 'off', byTool: { run_shell: 'off' } } })
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'ls' }, preset: 'danger-full-access', actions }).kind).toBe('deny')
  })

  it("an off tool's refusal names the config file this install reads, wherever SUNDIAL_HOME is", () => {
    const home = process.env.SUNDIAL_HOME
    process.env.SUNDIAL_HOME = '/tmp/sundial-elsewhere'
    try {
      const actions = config({ outward: { default: 'auto', byTool: { run_shell: 'off' } } })
      const d = decide({ toolName: 'gnomon_run_shell', args: { command: 'ls' }, preset: 'danger-full-access', actions })
      expect(d.reason).toContain('Enable it in /tmp/sundial-elsewhere/config.json.')
      expect(d.reason).not.toContain('~/.sundial')
    } finally {
      if (home === undefined) delete process.env.SUNDIAL_HOME
      else process.env.SUNDIAL_HOME = home
    }
  })

  it('tightens workspace-write ASK → DENY when the tool is off', () => {
    const actions = config({ internal: { default: 'auto', byTool: { assert: 'off' } } })
    expect(decide({ toolName: 'gnomon_assert', preset: 'workspace-write', actions }).kind).toBe('deny')
  })

  it('CANNOT loosen: read-only stays DENY even when config says auto', () => {
    const actions = config({ internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } })
    expect(decide({ toolName: 'gnomon_claim', preset: 'read-only', actions }).kind).toBe('deny')
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'ls' }, preset: 'read-only', actions }).kind).toBe('deny')
  })

  it('CANNOT loosen: workspace-write stays ASK for an outward tool even when config says auto', () => {
    const actions = config({ outward: { default: 'auto', byTool: {} } })
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'ls' }, preset: 'workspace-write', actions }).kind).toBe('ask')
  })

  // The override still bites on the rung that just opened: an owner who wants
  // to be asked about one internal write can still say so.
  it('tightens workspace-write ALLOW -> ASK for a named internal tool', () => {
    const actions = config({ internal: { default: 'auto', byTool: { ask_owner: 'ask' } } })
    expect(decide({ toolName: 'gnomon_ask_owner', preset: 'workspace-write', actions }).kind).toBe('ask')
    expect(decide({ toolName: 'gnomon_claim', preset: 'workspace-write', actions })).toEqual({ kind: 'allow' })
  })

  it('does NOT govern dsh built-ins — config off does not deny bash/write', () => {
    const actions = config({ outward: { default: 'off', byTool: {} } })
    expect(decide({ toolName: 'write', args: { path: '/tmp/x' }, preset: 'danger-full-access', actions })).toEqual({ kind: 'allow' })
    expect(decide({ toolName: 'bash', args: { command: 'ls' }, preset: 'danger-full-access', actions })).toEqual({ kind: 'allow' })
  })
})

describe("the owner's own services over MCP", () => {
  const isRead = (integration, tool) => integration.reads.some((p) => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p))
  const integrations = [{ name: 'obsidian', reads: ['search*', 'get_note'] }]
  const mcp = (toolName, preset) => decide({ toolName, preset, integrations, isIntegrationRead: isRead })

  it('parses the server-qualified name', () => {
    expect(parseMcpToolName('mcp__obsidian__search_notes')).toEqual({ server: 'obsidian', tool: 'search_notes' })
    expect(parseMcpToolName('gnomon_assert')).toBeNull()
  })

  it('allows a declared read at every preset — a read is a read', () => {
    for (const preset of ['read-only', 'workspace-write', 'danger-full-access', undefined]) {
      expect(mcp('mcp__obsidian__search_notes', preset)).toEqual({ kind: 'allow' })
      expect(mcp('mcp__obsidian__get_note', preset)).toEqual({ kind: 'allow' })
    }
  })

  it('treats anything undeclared as an outward write: deny, ask, allow by preset', () => {
    expect(mcp('mcp__obsidian__create_note', 'read-only').kind).toBe('deny')
    expect(mcp('mcp__obsidian__create_note', 'workspace-write').kind).toBe('ask')
    expect(mcp('mcp__obsidian__create_note', 'danger-full-access')).toEqual({ kind: 'allow' })
  })

  it('refuses a service write inside a job (custom preset, approvals pinned to never)', () => {
    expect(decide({ toolName: 'mcp__obsidian__delete_vault_file', preset: 'custom', approvalOverride: 'never', integrations, isIntegrationRead: isRead }).kind).toBe('deny')
    expect(decide({ toolName: 'mcp__obsidian__search_notes', preset: 'custom', approvalOverride: 'never', integrations, isIntegrationRead: isRead })).toEqual({ kind: 'allow' })
  })

  it('names the service and the tool in the reason, so the approval card can too', () => {
    expect(mcp('mcp__obsidian__create_note', 'workspace-write').reason).toContain('obsidian → create_note')
  })

  it('does not govern a server Gnomon did not mount', () => {
    expect(mcp('mcp__github__create_issue', 'read-only')).toEqual({ kind: 'allow' })
  })
})

describe('GNOMON_TOOLS map', () => {
  it('marks the calendar as an outward write that is not a shell', () => {
    expect(GNOMON_TOOLS.gnomon_calendar_create).toEqual({ kind: 'outward', tool: 'calendar_create' })
    expect(decide({ toolName: 'gnomon_calendar_create', preset: 'read-only' }).kind).toBe('deny')
    expect(decide({ toolName: 'gnomon_calendar_create', preset: 'workspace-write' }).kind).toBe('ask')
  })

  it('covers every gnomon-owned tool and nothing dsh owns', () => {
    for (const name of [...INTERNAL_TOOLS, 'gnomon_run_shell', 'gnomon_calendar_create']) expect(GNOMON_TOOLS[name]).toBeDefined()
    for (const name of ['bash', 'write', 'edit', 'web_fetch', 'read']) expect(GNOMON_TOOLS[name]).toBeUndefined()
  })
  it('marks run_shell as a shell tool (destructive check applies)', () => {
    expect(GNOMON_TOOLS.gnomon_run_shell.shell).toBe(true)
  })
})

describe('auto mode', () => {
  it('stops a command for the owner’s nod below "act", and lets it through at "act"', () => {
    const shell = { toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'danger-full-access' };
    expect(decide({ ...shell, autonomy: 'act' }).kind).toBe('allow');
    for (const autonomy of ['off', 'notice']) {
      const d = decide({ ...shell, autonomy });
      expect(d.kind).toBe('ask');
      expect(d.reason).toContain('auto mode');
    }
  });

  it('W5 step 10: at "act", a command Gnomon starts unasked still stops until actions have earned acting alone', () => {
    const d = decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: undefined, autonomy: 'earning' })
    expect(d.kind).toBe('ask')
    // bash asks on the outward ladder before autonomy is reached at all.
    expect(decide({ toolName: 'bash', args: { command: 'npm test' }, preset: undefined, autonomy: 'earning' }).kind).toBe('ask')
    expect(autonomyOf({ settings: { autonomy: 'act' } })).toBe('earning')
    expect(autonomyOf({ settings: { autonomy: 'act' }, autonomy: { levels: { actions: { level: 'act' } } } })).toBe('act')
    expect(autonomyOf({ settings: { autonomy: 'notice' } })).toBe('notice')
  })

  it('the owner\'s own preset is their yes: "earning" decides exactly as "act" did before W5, for every call, turn and config', () => {
    let n = 0
    for (const toolName of ['bash', 'gnomon_run_shell', 'gnomon_calendar_create', 'gnomon_claim'])
      for (const preset of ['read-only', 'workspace-write', 'danger-full-access'])
        for (const actions of [config(), config({ outward: { default: 'ask', byTool: {} } })])
          for (const ownerTurn of [undefined, true, false]) {
            const at = (autonomy) => decide({ toolName, args: { command: 'npm test' }, preset, actions, autonomy, ownerTurn })
            expect(at('earning')).toEqual(at('act'))
            n += 1
          }
    expect(n).toBe(72)
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'danger-full-access', autonomy: 'earning' }).kind).toBe('allow')
    // A thread on dsh's own default ('custom' since 0.1.5): the owner opening the turn is not a yes
    // to a shell command the model chose, since it can carry what Gnomon read anywhere.
    expect(decide({ toolName: 'bash', args: { command: 'npm test' }, preset: 'custom', autonomy: 'earning', ownerTurn: true }).kind).toBe('ask')
    expect(decide({ toolName: 'bash', args: { command: 'npm test' }, preset: 'custom', autonomy: 'earning', ownerTurn: false }).kind).toBe('ask')
  })

  it('leaves a read alone: the dial is about acting, not about looking', () => {
    // A dsh built-in that is not bash is not gnomon's to gate at any level.
    expect(decide({ toolName: 'read_file', args: {}, preset: 'read-only', autonomy: 'off' }).kind).toBe('allow');
  });

  it('never turns a deny into an ask', () => {
    const d = decide({ toolName: 'bash', args: { command: 'rm -rf ~' }, preset: 'danger-full-access', autonomy: 'off' });
    expect(d.kind).toBe('deny');
  });
})

describe('J4.1 escalate — the judge as the second key, tightening only', () => {
  it('turns an allow into an ask when the judge reads outward or irreversible above its threshold', () => {
    const asked = escalate({ kind: 'allow' }, { level: 'outward', p: 0.82, stakes: 2, escalate: true }, 'gnomon_run_shell')
    expect(asked.kind).toBe('ask')
    expect(asked.reason).toContain('outward (p 0.82, stakes 2/3)')
  })
  it('never loosens, and leaves the code decision alone when the judge is silent or unsure', () => {
    expect(escalate({ kind: 'deny', reason: 'x' }, { level: 'read', p: 0.9, stakes: 0, escalate: false }, 'bash')).toEqual({ kind: 'deny', reason: 'x' })
    expect(escalate({ kind: 'allow' }, null, 'bash')).toEqual({ kind: 'allow' })
    expect(escalate({ kind: 'allow' }, { level: 'internal_reversible', p: 0.95, stakes: 1, escalate: false }, 'gnomon_claim')).toEqual({ kind: 'allow' })
  })
  it('judges gnomon writes, bash and integration tools; not dsh reads', () => {
    expect(judgedAction('gnomon_run_shell')).toBe(true)
    expect(judgedAction('bash')).toBe(true)
    expect(judgedAction('mcp__obsidian__create_note')).toBe(true)
    expect(judgedAction('read')).toBe(false)
    expect(judgedAction('gnomon_today_summary')).toBe(false)
  })
  it('J4.2: a failed verification is one self-report notice keyed by tool, in words, never the arguments', () => {
    const what = outwardCall('gnomon_run_shell', { command: 'cd ~/Projects/puzzlebox-studio && git push origin main' })
    const n = unverifiedNotice('gnomon_run_shell', what, 0.12, '2026-09-22T10:00:00.000Z')
    expect(n).toMatchObject({ shape: 'self-report', kind: 'action-unverified', key: 'action-unverified:gnomon_run_shell', precision: 0.7 })
    expect(n.observation).toBe('The command Gnomon ran (git push) may not have worked: its result does not show that it happened.')
    expect(n.observation).not.toContain('puzzlebox')
  })

  it('Q4: only an outward or irreversible call is verified; reads and Gnomon\'s own memory writes are not', () => {
    expect(outwardCall('gnomon_owner_answer', { answer: 'Mira Bakker is the studio lead' })).toBeNull()
    expect(outwardCall('gnomon_assert', { fact: 'x' })).toBeNull()
    expect(outwardCall('gnomon_calendar_create', { title: 'x' })).toBe('The calendar event Gnomon made')
    expect(outwardCall('web_act', {})).toBe('What Gnomon did on a web page')
    expect(outwardCall('mcp__obsidian__search_vault_simple', {})).toBeNull()
    expect(outwardCall('mcp__obsidian__create_vault_file', {})).toBe("Gnomon's call to obsidian (create vault file)")
    // The owner's config wins over the verb.
    expect(outwardCall('mcp__notes__get_or_create', {}, () => false)).toBe("Gnomon's call to notes (get or create)")
    expect(outwardCall('mcp__notes__append', {}, () => true)).toBeNull()
    expect(outwardCall('bash', { command: 'ls -la ~/Projects 2>&1 | head -50' })).toBeNull()
  })

  it('Q4: a shell command is a read only when every part is a known read; anything else is checked', () => {
    const reads = ['pwd', 'sleep 60 && echo done', 'cd ~/Projects/x && git log --since="2026-09-20" --oneline', 'for d in ~/Projects/*; do git -C "$d" branch --show-current 2>/dev/null; done', 'grep -rn foo . > /dev/null', 'git status 2>&1', 'git branch --list', "sqlite3 db \"select 1 where at >= '2026-09-01'\""]
    const writes = { 'git commit -m x': 'git commit', 'cd a && git push': 'git push', 'echo hi > notes.txt': '>', 'rm build.log': 'rm', 'pnpm install': 'pnpm install', 'curl -X POST https://example.com': 'curl -X POST', 'sed -i "" s/a/b/ f': 'sed -i', 'git branch -D old': 'git branch -D', 'gh pr create -t x': 'gh', 'ssh host "rm -rf x"': 'ssh', 'rsync -a a b': 'rsync', 'make deploy': 'make', 'python3 x.py': 'python3', 'node -e "[1].map((x) => x)"': 'node', 'sqlite3 db "delete from t"': 'sqlite3', 'find . -name x -delete': 'find' }
    expect(reads.map(shellWrite)).toEqual(reads.map(() => null))
    expect(Object.keys(writes).map(shellWrite)).toEqual(Object.values(writes))
  })
})

// S10: untrusted text (a calendar title, OCR, a mail subject) reaches the
// companion inside a notice, and a notice opens a turn the owner never typed.
describe('S10 — a turn the owner did not open', () => {
  const msg = (source) => ({ type: 'user/message', data: { source } })
  const owner = msg({ kind: 'user' })
  const wake = msg({ kind: 'plugin', plugin: 'sundial-proactive' })
  const notice = msg({ kind: 'plugin', plugin: 'sundial-proactive', form: 'notice', summary: 'Gnomon noticed: x' })

  it('reads the latest ordinary message, and skips context blocks', () => {
    expect(openedByOwner([notice, wake])).toBe(false)
    expect(openedByOwner([wake, notice, owner, { type: 'turn/start' }])).toBe(true)
    // The place caption rides the owner's turn and must not hide it.
    expect(openedByOwner([owner, notice])).toBe(true)
    // The owner answering inside a notice turn is the owner speaking.
    expect(openedByOwner([notice, wake, owner])).toBe(true)
    // A compaction checkpoint lands after the owner's message mid-turn; it is not a new opener.
    const checkpoint = msg({ kind: 'plugin', plugin: 'compact', compactionId: 'c1' })
    expect(openedByOwner([owner, checkpoint])).toBe(true)
    expect(openedByOwner([wake, checkpoint])).toBe(false)
    expect(openedByOwner([notice])).toBeUndefined()
    expect(openedByOwner(undefined)).toBeUndefined()
  })

  it("refuses saidBy 'owner' in a notice turn, and keeps 'me'", () => {
    const base = { toolName: 'gnomon_assert', preset: 'danger-full-access' }
    expect(decide({ ...base, args: { saidBy: ' Owner ' }, ownerTurn: false }).kind).toBe('deny')
    expect(decide({ ...base, args: { saidBy: 'me' }, ownerTurn: false }).kind).toBe('allow')
    expect(decide({ ...base, args: { saidBy: 'owner' }, ownerTurn: true }).kind).toBe('allow')
    expect(decide({ ...base, args: { saidBy: 'owner' } }).kind).toBe('allow')
  })

  it.each(['gnomon_start_job', 'gnomon_schedule_wakeup', 'gnomon_owner_answer'])('asks before %s in a notice turn', (toolName) => {
    expect(decide({ toolName, preset: 'danger-full-access', ownerTurn: false }).kind).toBe('ask')
    expect(decide({ toolName, preset: 'danger-full-access', ownerTurn: true }).kind).toBe('allow')
  })

  it('never loosens: a read-only deny stays a deny', () => {
    expect(decide({ toolName: 'gnomon_start_job', preset: 'read-only', ownerTurn: false }).kind).toBe('deny')
  })

  it('leaves the other internal writes alone', () => {
    expect(decide({ toolName: 'gnomon_propose', preset: 'danger-full-access', ownerTurn: false }).kind).toBe('allow')
  })
})

describe('callRecord (X2)', () => {
  it('names the deferred tool that went through gnomon_call, and never the arguments', () => {
    expect(callRecord({ name: 'gnomon_call', args: { name: 'gnomon_routines', args: { days: 7 } } }, 'ok')).toEqual({ tool: 'gnomon_call', server: null, action: 'gnomon_routines', inner: 'gnomon_routines', outcome: 'ok' })
    expect(callRecord({ name: 'mcp__obsidian__search_notes', args: { query: 'x' } }, 'refused', 'no')).toEqual({ tool: 'mcp__obsidian__search_notes', server: 'obsidian', action: 'search_notes', outcome: 'refused', reason: 'no' })
    expect(callRecord({ name: 'gnomon_call', args: {} }, 'failed')).toEqual({ tool: 'gnomon_call', server: null, action: 'gnomon_call', outcome: 'failed' })
    // W6 D6: two parallel calls of one tool in one step are two rows a reader can tell apart.
    const parallel = ['call_1', 'call_2'].map((callId) => callRecord({ name: 'gnomon_today_summary', callId, args: { date: 'x' } }, 'ok'))
    expect(parallel.map((r) => r.callId)).toEqual(['call_1', 'call_2'])
    expect(JSON.stringify(parallel[0])).not.toBe(JSON.stringify(parallel[1]))
  })
})

describe('W3: action:decided refolds to the same verdict', () => {
  const isRead = (integration, tool) => integration.reads.some((p) => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p))
  const integrations = [{ name: 'obsidian', reads: ['search*'] }]
  const calls = [
    ['bash', { command: 'ls ~/Projects/puzzlebox-studio' }],
    ['bash', { command: 'rm -rf ~/Projects/puzzlebox-studio' }],
    ['gnomon_run_shell', { command: 'git status' }],
    ['gnomon_run_shell', { command: 'rm -rf /' }],
    ['gnomon_assert', { saidBy: 'owner', claim: 'Mira Bakker leads BOX-484' }],
    ['gnomon_assert', { saidBy: 'me', claim: 'Mira Bakker leads BOX-484' }],
    ['gnomon_calendar_create', { title: 'BOX-484 review' }],
    ['gnomon_start_job', { subject: 'lantern notes' }],
    ['mcp__obsidian__search_notes', { query: 'BOX-484' }],
    ['mcp__obsidian__delete_vault_file', { path: 'Mira Bakker.md' }],
    ['mcp__elsewhere__anything', {}],
  ]
  const presets = [undefined, 'read-only', 'workspace-write', 'danger-full-access', 'custom']
  const actionsList = [config(), config({ outward: { default: 'ask', byTool: {} } }), config({ internal: { default: 'off', byTool: {} } })]

  it('for every call, preset, config, autonomy and turn: the logged inputs alone give the logged verdict, and the arguments are not in the row', () => {
    let n = 0
    for (const [toolName, args] of calls)
      for (const preset of presets)
        for (const actions of actionsList)
          for (const autonomy of [undefined, 'off', 'notice', 'act', 'earning'])
            for (const ownerTurn of [undefined, true, false]) {
              // As the pre-execute hook builds it.
              const inputs = { preset, approvalOverride: preset === 'custom' ? 'never' : undefined, actions, autonomy, ownerTurn, facts: callFacts({ toolName, args, integrations, isIntegrationRead: isRead }) }
              const live = decideAction({ toolName, args, preset, approvalOverride: inputs.approvalOverride, actions, resolveActionPolicy, integrations, isIntegrationRead: isRead, autonomy, ownerTurn })
              const row = JSON.parse(JSON.stringify(decisionRecord({ name: toolName, args }, inputs, live)))
              const refold = decideAction({ toolName: row.tool, resolveActionPolicy, ...row.inputs })
              expect({ kind: refold.kind, reason: refold.reason ?? null }).toEqual({ kind: row.verdict, reason: row.reason })
              for (const value of Object.values(args).filter((v) => v.length > 5)) expect(JSON.stringify(row)).not.toContain(value)
              n += 1
            }
    expect(n).toBe(calls.length * presets.length * actionsList.length * 5 * 3)
  })
})

describe('R11: neverRan — a refusal is not an action to verify', () => {
  const err = (text) => ({ isError: true, content: [{ type: 'text', text }] })
  it('the owner said no, stopped it, or dsh aborted it: never ran', () => {
    expect(neverRan(err('Error: the user rejected tool "mcp__notes__create_file"'))).toBe(true)
    expect(neverRan({ isError: true, value: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }] })).toBe(true)
    expect(neverRan(err('Error: the owner stopped this tool call while it was running.'))).toBe(true)
  })
  it('a real failure or a success ran', () => {
    expect(neverRan(err('Error: MCP error -32603: upstream'))).toBe(false)
    expect(neverRan({ isError: false, content: [{ type: 'text', text: 'the user rejected tool' }] })).toBe(false)
    expect(neverRan(null)).toBe(false)
  })
})
