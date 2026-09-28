// The action gate is the one place a wrong answer lets the assistant touch
// something it should not, so it is tested to the corners — every preset ×
// tool-class cell of the table, the bash destructive-deny, and that
// config.actions can tighten but never loosen.
import { describe, it, expect } from 'vitest'
import { decideAction, escalate, GNOMON_TOOLS, judgedAction, openedByOwner, parseMcpToolName, unverifiedNotice } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

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
  it('allows an ordinary bash command under every preset', () => {
    for (const preset of ['read-only', 'workspace-write', 'danger-full-access', undefined]) {
      expect(decide({ toolName: 'bash', args: { command: 'ls -la' }, preset })).toEqual({ kind: 'allow' })
    }
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
  it('J4.2: a failed verification is one self-report notice keyed by tool', () => {
    const n = unverifiedNotice('gnomon_run_shell', { command: 'npx vitest run' }, 0.12, '2026-09-22T10:00:00.000Z')
    expect(n).toMatchObject({ shape: 'self-report', kind: 'action-unverified', key: 'action-unverified:gnomon_run_shell', precision: 0.7 })
    expect(n.observation).toContain('npx vitest run')
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
