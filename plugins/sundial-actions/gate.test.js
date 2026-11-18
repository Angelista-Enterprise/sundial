// The action gate is the one place a wrong answer lets the assistant touch
// something it should not, so it is tested to the corners — every preset ×
// tool-class cell of the table, the bash destructive-deny, and that
// config.actions can tighten but never loosen.
import { describe, it, expect } from 'vitest'
import { callFacts, callRecord, decideAction, decisionRecord, escalate, GNOMON_TOOLS, judgedAction, mailLine, mailOf, neverRan, openedByOwner, outwardCall, parseMcpToolName, finalOf, privateApp, reachRefusal, shellWrite, unverifiedNotice } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { autonomyOf } from './index.js'

// A resolved actions config, defaults matching @sundial/helpers (internal auto,
// outward off). Most tests pass a permissive-internal config so the PRESET is
// what drives the verdict; the override tests deliberately tighten.
function config(over = {}) {
  return {
    internal: { default: 'auto', byTool: {}, ...over.internal },
    outward: { default: 'auto', byTool: {}, ...over.outward },
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
    testMode: over.testMode,
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
    expect(decide({ toolName: 'bash', args: { command: 'npm test' }, preset: 'read-only' }).kind).toBe('deny')
    expect(decide({ toolName: 'bash', args: { command: 'npm test' }, preset: 'workspace-write' }).kind).toBe('ask')
    expect(decide({ toolName: 'bash', args: { command: 'npm test' }, preset: 'custom' }).kind).toBe('ask')
    expect(decide({ toolName: 'bash', args: { command: 'npm test' }, preset: 'danger-full-access' })).toEqual({ kind: 'allow' })
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
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'workspace-write' }).kind).toBe('ask')
  })
})

describe('gnomon_run_shell maps from the preset AND blocks destructive commands', () => {
  it('read-only DENIES run_shell', () => {
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'read-only' }).kind).toBe('deny')
  })
  it('workspace-write ASKS for a benign run_shell', () => {
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'workspace-write' }).kind).toBe('ask')
  })
  it('danger-full-access ALLOWS a benign run_shell', () => {
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'danger-full-access' })).toEqual({ kind: 'allow' })
  })
  it('DENIES a destructive run_shell regardless of preset — even danger-full-access', () => {
    for (const preset of ['read-only', 'workspace-write', 'danger-full-access', undefined]) {
      const d = decide({ toolName: 'gnomon_run_shell', args: { command: 'sudo rm -rf /' }, preset })
      expect(d.kind, `run_shell destructive under ${preset}`).toBe('deny')
      expect(d.reason).toMatch(/destructive/i)
    }
  })
  // Set 4 R1, slow-job (runs 167, 186, 194, 204 T01): the prompt line was ignored one run in four; the gate holds it.
  it('refuses an inline python or node script with a web or app address, in every preset, bash too', () => {
    const scripts = [
      `python3 -c "import urllib.parse; print('obsidian://new?vault=Notes&name=' + urllib.parse.quote('Gnomon job'))"`,
      `python3 - <<'EOF'\nimport webbrowser\nwebbrowser.open("https://example.org/lookup")\nEOF`,
      `node -e "fetch('https://example.org').then((r) => r.text()).then(console.log)"`,
      `U=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "a b"); open "obsidian://new?name=$U"`,
      'echo https://example.org | python3',
    ]
    for (const command of scripts) for (const toolName of ['gnomon_run_shell', 'bash']) for (const preset of ['workspace-write', 'danger-full-access']) {
      const d = decide({ toolName, args: { command }, preset })
      expect(d.kind, `${toolName} ${preset} ${command}`).toBe('deny')
      expect(d.reason).toMatch(/use web_fetch, or write the file with cat and open a plain URL/)
    }
    expect(callFacts({ toolName: 'gnomon_run_shell', args: { command: scripts[0] } }).inlineAddress).toBe(true)
  })
  it('a script with no address, a plain URL open, and a heredoc note with a link in it still run', () => {
    for (const command of ['python3 -c "print(6 * 7)"', 'open "obsidian://open?vault=Notes"', `cat > "Gnomon job.md" <<'EOF'\nhttps://example.org\nEOF`, 'python3 tally.py https://example.org', 'node -e "[1].map((x) => x)"']) {
      expect(decide({ toolName: 'gnomon_run_shell', args: { command }, preset: 'danger-full-access' }).kind, command).toBe('allow')
      expect(callFacts({ toolName: 'gnomon_run_shell', args: { command } }).inlineAddress).toBeUndefined()
    }
  })
  // Fable review H2: the fence was walked around by a path, a module and joined flags.
  it('an interpreter by path, python3 -m webbrowser, joined flags, an address as the script\'s argument: refused', () => {
    for (const command of [
      `/usr/bin/python3 -c "import webbrowser; webbrowser.open('https://example.org')"`,
      `/opt/homebrew/bin/node -e "fetch('https://example.org')"`,
      `python3 -m webbrowser 'obsidian://open?vault=Notes'`,
      `python3 -Ic "import webbrowser; webbrowser.open('https://example.org')"`,
      `python3 -c 'import sys, webbrowser; webbrowser.open(sys.argv[1])' https://example.org`,
      `python3 -c 'print("https://example.org")' | xargs open`,
    ]) expect(decide({ toolName: 'gnomon_run_shell', args: { command }, preset: 'danger-full-access' }).kind, command).toBe('deny')
  })
  // Fable review M5: the address was looked for over the whole command.
  it('an address outside the script (another command, a comment) is not the script\'s: it runs', () => {
    for (const command of [
      `python3 -c 'print(6*7)' && open https://example.org`,
      `git clone https://example.org/r.git && node -e 'console.log(1)'`,
      `python3 -c 'print(1)' # see https://docs.python.org`,
      `python3 - <<'EOF'\nprint(6 * 7)\nEOF\nopen https://example.org`,
    ]) {
      expect(decide({ toolName: 'gnomon_run_shell', args: { command }, preset: 'danger-full-access' }).kind, command).toBe('allow')
      expect(callFacts({ toolName: 'gnomon_run_shell', args: { command } }).inlineAddress).toBeUndefined()
    }
  })
})

describe('custom / unknown / missing preset falls back to the approval policy', () => {
  it.each(INTERNAL_TOOLS)('approval never → ALLOW for internal %s (a job must be able to report back)', (toolName) => {
    expect(decide({ toolName, args: { command: 'npm test' }, preset: 'custom', approvalOverride: 'never' })).toEqual({ kind: 'allow' })
    expect(decide({ toolName, args: { command: 'npm test' }, preset: undefined, approvalOverride: 'never' })).toEqual({ kind: 'allow' })
  })
  it.each(['gnomon_run_shell', 'gnomon_calendar_create', 'web_act'])('approval never → DENY for outward %s (nobody can approve inside a job)', (toolName) => {
    expect(decide({ toolName, args: { command: 'npm test' }, preset: 'custom', approvalOverride: 'never' }).kind).toBe('deny')
    expect(decide({ toolName, args: { command: 'npm test' }, preset: undefined, approvalOverride: 'never' }).kind).toBe('deny')
  })
  it.each([...INTERNAL_TOOLS, 'gnomon_run_shell'])('approval ask (or absent) → ASK for %s', (toolName) => {
    expect(decide({ toolName, args: { command: 'npm test' }, preset: 'custom', approvalOverride: 'ask' }).kind).toBe('ask')
    expect(decide({ toolName, args: { command: 'npm test' }, preset: 'my-weird-preset', approvalOverride: undefined }).kind).toBe('ask')
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
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'danger-full-access', actions }).kind).toBe('deny')
  })

  it("an off tool's refusal names the config file this install reads, wherever SUNDIAL_HOME is", () => {
    const home = process.env.SUNDIAL_HOME
    process.env.SUNDIAL_HOME = '/tmp/sundial-elsewhere'
    try {
      const actions = config({ outward: { default: 'auto', byTool: { run_shell: 'off' } } })
      const d = decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'danger-full-access', actions })
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
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'read-only', actions }).kind).toBe('deny')
  })

  it('CANNOT loosen: workspace-write stays ASK for an outward tool even when config says auto', () => {
    const actions = config({ outward: { default: 'auto', byTool: {} } })
    expect(decide({ toolName: 'gnomon_run_shell', args: { command: 'npm test' }, preset: 'workspace-write', actions }).kind).toBe('ask')
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
    expect(decide({ toolName: 'bash', args: { command: 'npm test' }, preset: 'danger-full-access', actions })).toEqual({ kind: 'allow' })
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
    // dsh 0.2 stamps the checkpoint with its own kind.
    const checkpointV4 = msg({ kind: 'compact-checkpoint', compactionId: 'c2' })
    expect(openedByOwner([owner, checkpointV4])).toBe(true)
    expect(openedByOwner([wake, checkpointV4])).toBe(false)
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

describe("a watch rule's reach names only a tool this gate governs (observatory §3)", () => {
  const rule = (tool) => ({ do: [{ reach: { tool, brief: 'b' } }] })
  it("takes Gnomon's own tools and a mounted integration's, and refuses the rest", () => {
    expect(reachRefusal(rule('gnomon_calendar_create'))).toBeNull()
    expect(reachRefusal(rule('mcp__github__create_release'), [{ name: 'github' }])).toBeNull()
    expect(reachRefusal(rule('mcp__github__create_release'), [])).toContain('not a tool the action gate knows')
    expect(reachRefusal(rule('gnomon_nope'))).toContain('gnomon_nope')
    expect(reachRefusal({ do: [{ ask: { question: 'q' } }] })).toBeNull()
    expect(reachRefusal({})).toBeNull()
  })
  it('pause and resume a rule are the owner\'s, like adopting one', () => {
    expect(GNOMON_TOOLS.gnomon_pause_rule).toEqual({ kind: 'internal', tool: 'pause_rule', ownerTurnOnly: true })
    expect(GNOMON_TOOLS.gnomon_resume_rule).toEqual({ kind: 'internal', tool: 'resume_rule', ownerTurnOnly: true })
  })
})

describe('a send asks first, a blind Send is refused, test mode still asks (2026-11-12, 2026-11-14)', () => {
  const MAIL = `osascript -e 'tell application "Microsoft Outlook"' -e 'set m to make new outgoing message with properties {subject:"Lunch", content:"See you at noon", visible:false}' -e 'tell m to make new to recipient at end of to recipients with properties {address:"mira@example.com"}' -e 'tell m to make new cc recipient at end of cc recipients with properties {address:"jon@example.com"}' -e 'send m' -e 'end tell'`
  const SENDMAIL = `printf 'Subject: Hi\n\nSee you' | sendmail mira@example.com`
  const shell = (command, over = {}) => decide({ toolName: 'gnomon_run_shell', args: { command }, preset: 'danger-full-access', ...over })
  const BLIND_KEYS = { app: 'Mail', steps: [{ action: 'key', value: 'cmd+n' }, { action: 'type', value: 'mira@example.com' }, { action: 'key', value: 'cmd+shift+d' }] }

  it('reads what a Mail script sends: to, cc, subject, body', () => {
    expect(mailOf(MAIL)).toEqual({ app: 'Microsoft Outlook', to: ['mira@example.com'], cc: ['jon@example.com'], bcc: [], subject: 'Lunch', body: 'See you at noon' })
    expect(mailLine(MAIL)).toBe('To: mira@example.com · Cc: jon@example.com · Subject: "Lunch" · Body: "See you at noon"')
    expect(mailOf(`osascript -e "tell application \\"Microsoft Outlook\\" to send m"`)?.app).toBe('Microsoft Outlook')
    expect(mailOf(`mail -s "Hi there" mira@example.com < note.txt`)).toMatchObject({ to: ['mira@example.com'], subject: 'Hi there' })
    expect(mailOf(SENDMAIL)).toMatchObject({ to: ['mira@example.com'] })
    // A draft (no send), a send in another app, and a plain command are not mail sends.
    expect(mailOf(`osascript -e 'tell application "Mail" to make new outgoing message with properties {subject:"Lunch", visible:true}'`)).toBeNull()
    expect(mailOf(`osascript -e 'tell application "Pages" to send m'`)).toBeNull()
    expect(mailOf('ls ~/Mail')).toBeNull()
    // Review 2026-11-15: a script send from a private app (Mail, Messages) is a send, and blind.
    expect(mailOf(MAIL.replace('Microsoft Outlook', 'Mail'))).toMatchObject({ app: 'Mail', blind: true })
    expect(mailOf(`osascript -e 'tell application "Messages" to send "hi" to buddy "+31600000000"'`)).toMatchObject({ app: 'Messages', blind: true })
  })

  it('a Mail script asks under every preset that would run it', () => {
    expect(shell(MAIL)).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/sends a mail/) })
    expect(shell(MAIL, { preset: 'workspace-write' }).kind).toBe('ask')
    expect(shell(SENDMAIL).kind).toBe('ask')
    expect(decide({ toolName: 'bash', args: { command: MAIL }, preset: 'danger-full-access' }).kind).toBe('ask')
    expect(shell(MAIL, { preset: 'read-only' }).kind).toBe('deny')
    expect(shell('echo hi').kind).toBe('allow')
  })

  it('where nobody can be asked (approvals never) a send is refused with what to do, in test mode too (2026-11-14)', () => {
    for (const testMode of [false, true]) {
      expect(shell(MAIL, { approvalOverride: 'never', testMode })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/approvals are off/) })
      expect(shell(SENDMAIL, { approvalOverride: 'never', testMode }).kind).toBe('deny')
    }
  })

  it('a blind Send in a private app is refused in every mode, and says to take the direct path', () => {
    for (const testMode of [false, true]) {
      expect(decide({ toolName: 'screen_act', args: BLIND_KEYS, preset: 'danger-full-access', testMode })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/blind Send.*show the owner the mail/i) })
      expect(decide({ toolName: 'screen_act', args: { app: 'Mail', role: 'button', label: 'Send' }, testMode }).kind).toBe('deny')
      expect(decide({ toolName: 'screen_act', args: { target: { app: 'Messages', label: 'Send' } }, testMode }).kind).toBe('deny')
    }
    // Typing in Mail is not a send, but it is blind: refused too (below).
    expect(decide({ toolName: 'screen_act', args: { app: 'Mail', action: 'type', value: 'Lunch' } })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/typing in a private app/) })
  })

  it('a Send in webmail asks as a send, in test mode too', () => {
    const gmail = { app: 'Google Chrome', steps: [{ role: 'text field', label: 'To', action: 'set-value', value: 'mira@example.com' }, { role: 'button', label: 'Send' }] }
    expect(decide({ toolName: 'screen_act', args: gmail })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/sends a mail or a message/) })
    expect(decide({ toolName: 'screen_act', args: gmail, preset: 'danger-full-access', testMode: true })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/sends a mail or a message/) })
    expect(finalOf('screen_act', { app: 'Safari', action: 'key', value: 'cmd+Enter' })).toMatchObject({ kind: 'send', via: 'screen', blind: false })
    expect(finalOf('screen_act', { app: 'Pages', action: 'key', value: 'cmd+enter' })).toBeNull()
    expect(finalOf('screen_act', { app: 'Safari', action: 'pick-menu', value: 'Send Message' })).toMatchObject({ kind: 'send', via: 'screen', blind: false })
    expect(finalOf('screen_act', { app: 'Safari', ref: 'e2@0001', action: 'pick', value: 'send later' })).toMatchObject({ kind: 'send', via: 'screen', blind: false })
    // Review 2026-11-15: a set-value by ref types its value unless the plan reads the ref as a pop-up, whose item it then picks.
    for (const step of [{ ref: 'e2@0001', value: 'Send now' }, { target: { ref: 'e2@0001' }, action: 'set-value', value: 'Send' }]) {
      expect(finalOf('screen_act', { app: 'Safari', ...step })).toBeNull()
      expect(finalOf('screen_act', { app: 'Safari', ...step }, undefined, [{ verb: 'set-value', app: 'Safari', thing: { role: 'pop up button', name: 'Schedule' }, command: { value: 'Send now' } }])).toMatchObject({ kind: 'send', via: 'screen', blind: false })
      expect(finalOf('screen_act', { app: 'Safari', ...step }, undefined, [{ verb: 'set-value', app: 'Safari', thing: { role: 'text field', name: 'Note' }, command: { value: 'Delete the old ones' } }])).toBeNull()
    }
    expect(finalOf('screen_act', { app: 'Safari', role: 'text field', label: 'Subject', value: 'Send me the notes' })).toBeNull()
    expect(decide({ toolName: 'web_act', args: { page: 'p1', ref: 4, action: 'click', because: 'Press Send' }, preset: 'danger-full-access' }).kind).toBe('ask')
    expect(decide({ toolName: 'web_act', args: { page: 'p1', ref: 4, action: 'click', because: 'Open the inbox' }, preset: 'danger-full-access' }).kind).toBe('allow')
  })

  it('the facts on the record name the send, never its content', () => {
    expect(callFacts({ toolName: 'gnomon_run_shell', args: { command: MAIL } }).final).toEqual({ kind: 'send', via: 'shell', blind: false })
    expect(callFacts({ toolName: 'screen_act', args: BLIND_KEYS }).final).toEqual({ kind: 'send', via: 'screen', blind: true })
    expect(callFacts({ toolName: 'gnomon_claim', args: {} }).final).toBeNull()
  })
})

describe('typing in a private app is refused in every mode (live test 3, 2026-11-12)', () => {
  const act = (args, over = {}) => decide({ toolName: 'screen_act', args, preset: 'danger-full-access', ...over })
  const TYPED = { app: 'Mail', steps: [{ action: 'key', value: 'cmd+n' }, { action: 'type', value: 'mira@example.com' }, { action: 'key', value: 'tab' }, { action: 'type', value: 'Lunch' }] }

  it('a mail typed blind in Mail is refused, normal mode and test mode, and says to take the direct path or ask the owner', () => {
    for (const testMode of [false, true]) {
      for (const approvalOverride of [undefined, 'never']) {
        expect(act(TYPED, { testMode, approvalOverride })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/private app.*ask the owner to type it/i) })
      }
      expect(act({ app: 'Mail', role: 'text field', label: 'Subject', value: 'Lunch' }, { testMode }).kind).toBe('deny')
      expect(act({ app: 'Mail', action: 'key', value: 'a' }, { testMode }).kind).toBe('deny')
      expect(act({ app: 'Mail', action: 'key', value: 'cmd+v' }, { testMode }).kind).toBe('deny')
      expect(act({ app: 'Mail', action: 'key', value: 'return' }, { testMode }).kind).toBe('deny')
      expect(act({ target: { app: 'Mail' }, action: 'type', value: 'Hi' }, { testMode }).kind).toBe('deny')
      // Run 69 T06: an empty steps is one act, judged as one.
      for (const steps of ['', '[]', []]) expect(act({ app: 'Mail', action: 'type', value: 'Hi', steps }, { testMode }).kind).toBe('deny')
      expect(act({ app: 'Mail', role: 'text area', label: 'Body', action: 'select', line: 2 }, { testMode }).kind).toBe('deny')
    }
  })

  it('in a private app, open, raise and keys that only open or switch are refused too (2026-11-14), and the reason names no app', () => {
    for (const args of [
      { app: 'Mail' },
      { app: 'Mail', window: 'New Message', action: 'raise' },
      { app: 'Mail', steps: [{ action: 'key', value: 'cmd+n' }, { action: 'key', value: 'Shift+Cmd+N' }, { action: 'key', value: 'escape' }, { action: 'key', value: 'cmd+tab' }, { action: 'key', value: 'tab' }, { action: 'key', value: 'down' }] },
    ]) {
      const decision = act(args)
      expect(decision).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/private app/) })
      expect(decision.reason).not.toMatch(/mail/i)
    }
  })

  it('2026-11-17: a private app by its name in any language (Notes, Notities, Agenda) is refused; a longer name holding it is not', () => {
    for (const app of ['Notes', 'Notities', 'agenda', 'Kalender', 'Herinneringen', 'Nachrichten']) {
      expect(privateApp(app), app).toBe(true)
      expect(act({ app, role: 'button', label: 'Bold' }).kind, app).toBe('deny')
    }
    for (const app of ['Notes Plus', 'Agenda Pro', 'Notesnook']) expect(privateApp(app), app).toBe(false)
  })

  it('typing in Pages (not private) asks as every screen act does', () => {
    for (const testMode of [false, true]) {
      expect(act({ app: 'Pages', steps: [{ action: 'key', value: 'cmd+n' }, { action: 'type', value: 'Lunch with Mira' }, { action: 'key', value: 'return' }] }, { testMode }).kind).toBe('ask')
    }
  })

  it('a typing step with no app is resolved from the last look; unresolved, or a refused look, it is refused', () => {
    const facts = (args, lookApp) => callFacts({ toolName: 'screen_act', args, lookApp })
    const ref = { ref: 'e7@a3f1', action: 'type', value: 'Lunch' }
    expect(facts(ref, 'Pages').typing).toBeNull()
    expect(facts(ref, 'Mail').typing).toBe('private')
    expect(facts(ref, undefined).typing).toBe('unnamed')
    expect(facts({ steps: [{ ref: 'e7@a3f1', action: 'press' }, { action: 'type', value: 'Hi' }] }, 'Pages').typing).toBe('unnamed')
    expect(facts({ action: 'key', value: 'escape' }, undefined).typing).toBeNull()
    // A key named as a thing is pressed as that key, so it is judged as one: no app is unnamed, Mail is private, escape moves.
    expect(facts({ role: 'key', label: 'return' }, undefined).typing).toBe('unnamed')
    expect(facts({ steps: [{ role: 'key', label: 'return' }] }, undefined).typing).toBe('unnamed')
    expect(facts({ app: 'Mail', target: { role: 'key', label: 'return' } }, undefined).typing).toBe('private')
    expect(facts({ role: 'key', label: 'escape' }, undefined).typing).toBeNull()
    expect(finalOf('screen_act', { app: 'Safari', role: 'key', label: 'cmd+Enter' })).toMatchObject({ kind: 'send', via: 'screen', blind: false })
    for (const testMode of [false, true]) {
      expect(decideAction({ toolName: 'screen_act', args: ref, preset: 'danger-full-access', actions: config(), resolveActionPolicy, testMode, facts: facts(ref, undefined) })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/typing with no app named/) })
      expect(decideAction({ toolName: 'screen_act', args: ref, preset: 'danger-full-access', actions: config(), resolveActionPolicy, testMode, facts: facts(ref, 'Pages') }).kind).toBe('ask')
    }
  })

  it('only screen_act types blind', () => {
    expect(callFacts({ toolName: 'web_act', args: { action: 'type', text: 'Hi' } }).typing).toBeNull()
    expect(callFacts({ toolName: 'gnomon_claim', args: {} }).typing).toBeNull()
  })
})

describe('the review holes: what else sends, and what a send records (2026-11-12)', () => {
  const full = (command, over = {}) => decide({ toolName: 'gnomon_run_shell', args: { command }, preset: 'danger-full-access', ...over })

  it.each([
    'osascript /tmp/send.scpt',
    'osascript -l JavaScript x.js',
    'osascript - < x.scpt',
    'shortcuts run "Send Mail"',
    'automator ~/flows/send.workflow',
    'msmtp mira@example.com < note.txt',
    'mutt -- mira@example.com < note.txt',
    'neomutt -s "Hi" mira@example.com < note.txt',
    'ssmtp mira@example.com < note.txt',
    'swaks --to mira@example.com --server smtp.example.com',
  ])('%s asks under full access', (command) => {
    expect(mailOf(command)).not.toBeNull()
    expect(full(command).kind).toBe('ask')
  })

  it('an inline script that sends nothing, and a plain read, still run', () => {
    expect(full(`osascript -e 'tell application "Finder" to get name of front window'`).kind).toBe('allow')
    expect(full(`osascript <<'EOF'\ntell application "Pages" to get name of every document\nEOF`).kind).toBe('allow')
    expect(full('mutt -v').kind).toBe('allow')
  })

  it('2026-11-17: a script that addresses a private app (AppleScript or JXA, by name, bundle id or a localized name) is refused like opening it', () => {
    for (const command of [
      `osascript <<'EOF'\ntell application "Notes" to get name of every note\nEOF`,
      `osascript -e 'tell application "Notities" to get name of every note'`,
      `osascript -e "tell application \\"Agenda\\" to get name of every calendar"`,
      `osascript -e 'tell application id "com.apple.Notes" to count notes'`,
      `osascript -e 'tell app "Messages" to get name of every chat'`,
      `osascript -e 'get name of every note of application "Notes"'`,
      `osascript -l JavaScript -e 'Application("Notes").notes.name()'`,
      `osascript -l JavaScript -e "Application('com.apple.iCal').calendars.name()"`,
      `echo 'tell application "Herinneringen" to get name of every reminder' | osascript`,
      `osascript -e 'tell application "Mail" to count messages of inbox'`,
      'open -a Notities',
      'open -b com.apple.Notes',
    ]) {
      const decision = full(command)
      expect(decision, command).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/private app/) })
    }
  })

  it('a script that only mentions a private app in a string, or no script at all, still runs', () => {
    for (const command of [`osascript -e 'display dialog "Open the Notes app yourself"'`, `osascript -e 'tell application "Finder" to get name of front window'`, `echo 'tell application "Notes"' > draft.txt`, 'grep -r Notes docs/'])
      expect(full(command).kind, command).toBe('allow')
  })

  it('a send key by System Events is a blind Send, refused in every mode', () => {
    const keys = `osascript -e 'tell application "Mail" to activate' -e 'tell application "System Events" to keystroke "d" using {command down, shift down}'`
    for (const testMode of [false, true]) expect(full(keys, { testMode })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/blind Send/) })
    expect(full(`osascript -e 'tell application "System Events" to key code 36 using command down'`).kind).toBe('deny')
    expect(full(`osascript -e 'tell application "System Events" to keystroke "f" using {command down}'`).kind).toBe('allow')
  })

  it('the -s subject is read only from a mail tool, never from curl', () => {
    expect(mailOf('curl -s --url smtps://smtp.example.com --mail-rcpt mira@example.com -T mail.txt')).toMatchObject({ subject: null, to: ['mira@example.com'] })
    expect(mailOf('mutt -s "Hi there" mira@example.com < note.txt')).toMatchObject({ subject: 'Hi there' })
  })

  it('a screen Send with no app named is refused in every mode', () => {
    for (const testMode of [false, true]) {
      expect(decide({ toolName: 'screen_act', args: { action: 'key', value: 'cmd+shift+d' }, testMode })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/no app named/) })
      expect(decide({ toolName: 'screen_act', args: { steps: [{ action: 'type', value: 'Hi' }, { role: 'button', label: 'Send' }] }, testMode }).kind).toBe('deny')
    }
  })

  it("a web_act send is read from the element the ref names in the page's last reading, and from text sent with Enter", () => {
    const page = { p1: [{ ref: 4, role: 'button', name: 'Send' }, { ref: 5, role: 'textbox', name: 'Search mail' }, { ref: 6, role: 'textbox', name: 'Message' }] }
    const webElement = (id, ref) => page[id]?.find((e) => e.ref === ref) ?? null
    const facts = (args) => callFacts({ toolName: 'web_act', args: { page: 'p1', because: 'Next step', ...args }, webElement })
    expect(facts({ action: 'click', ref: 4 }).final).toEqual({ kind: 'send', via: 'web', blind: false })
    expect(facts({ action: 'type', ref: 6, text: 'See you at noon', submit: true }).final).toEqual({ kind: 'send', via: 'web', blind: false })
    expect(facts({ action: 'type', ref: 5, text: 'invoice', submit: true }).final).toBeNull()
    expect(facts({ action: 'type', ref: 6, text: 'See you' }).final).toBeNull()
    expect(facts({ action: 'click', ref: 9 }).final).toBeNull()
    expect(decideAction({ toolName: 'web_act', args: { page: 'p1', ref: 4, action: 'click', because: 'Next step' }, preset: 'danger-full-access', actions: config(), resolveActionPolicy, facts: facts({ action: 'click', ref: 4 }) }).kind).toBe('ask')
  })
})

describe('a find step that names Send (review, 2026-11-12)', () => {
  it('counts as a send, so it asks like a Send button does', async () => {
    expect(finalOf('screen_act', { app: 'Zen', steps: [{ find: 'Send button', action: 'press' }] })).toBeTruthy()
  })
})
