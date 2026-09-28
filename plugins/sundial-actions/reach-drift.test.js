import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isIntegrationRead } from '@sundial/helpers/sundial-config.js'
import { decideAction, GNOMON_TOOLS } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

// D-R4's drift test, in the shape the codebase can actually support.
//
// **What it is checking, and why it is not a live boot.** The hazard D-R4
// named is a mounted server quietly growing a tool: the `reads` globs are
// matched against a name, so a new `fetch_and_delete` would be classified a
// READ by `fetch*` and allowed at every preset, silently, with nothing on any
// surface changing. Catching that needs the server's real tool list, which
// needs a running MCP client — too much for a unit test and, worse, a test
// that passes when the server is merely down.
//
// So the manifest below is checked in: every tool `obsidian` advertised on
// 2026-09-22, with the verdict the gate gave it. The test replays each name
// through the SAME `isIntegrationRead` the gate calls and asserts the verdict
// is unchanged. That catches the half the repository owns — a `reads` glob
// edited, a preset ladder moved, a tool renamed in the manifest — which is
// every way this can drift from inside. The other half, a server adding a
// tool, is caught by `/gnomon/reach` itself: the card enumerates
// `ctx.tools.schemas()` live, so a new tool appears on it the moment it
// exists, with the gate's own verdict beside it.
//
// Regenerate with: curl -s localhost:3080/gnomon/reach | jq of `integrations`.

/** Every tool `obsidian` advertised on 2026-09-22, and whether the gate called it a read. */
const OBSIDIAN = {
  name: 'obsidian',
  reads: ['search*', 'get_*', 'list_*', 'read_*', 'fetch*'],
  tools: {
    fetch: true,
    get_active_file: true,
    get_server_info: true,
    get_vault_file: true,
    list_vault_files: true,
    search_vault: true,
    search_vault_simple: true,
    search_vault_smart: true,
    append_to_active_file: false,
    append_to_vault_file: false,
    create_vault_file: false,
    delete_active_file: false,
    delete_vault_file: false,
    execute_template: false,
    patch_active_file: false,
    patch_vault_file: false,
    show_file_in_obsidian: false,
    update_active_file: false,
  },
}

/**
 * The gate's verdict with NO owner overrides — the shipped ladder, so the test
 * measures the code rather than this machine's `config.actions`. (Which really
 * does tighten two tools here: `outward.all = "ask"` means Auto does not
 * loosen `run_shell`, and a test that read the live config would pass or fail
 * depending on whose laptop it ran on.)
 */
const NO_OVERRIDES = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} }, filesystemAllow: [] }

const verdict = (toolName, preset) =>
  decideAction({
    toolName,
    args: undefined,
    preset,
    actions: NO_OVERRIDES,
    resolveActionPolicy,
    integrations: [OBSIDIAN],
    isIntegrationRead,
  }).kind

describe('integration reach, against the checked-in manifest', () => {
  it('classifies every advertised tool the way it did on 2026-09-22', () => {
    // The glob list is five patterns over eighteen tools. Editing one to catch
    // a new read is a one-character change that can silently reclassify an
    // existing write, and nothing else in the repository would notice.
    for (const [tool, wasRead] of Object.entries(OBSIDIAN.tools)) {
      expect(isIntegrationRead(OBSIDIAN, tool), `${tool} changed side`).toBe(wasRead)
    }
  })

  it('keeps a read allowed at every preset and a write on the outward ladder', () => {
    // The ladder the Reach card draws, asserted against the gate rather than
    // against the card — if these move, the card moves with them and says so,
    // but the MOVE itself should never be silent.
    for (const [tool, wasRead] of Object.entries(OBSIDIAN.tools)) {
      const name = `mcp__obsidian__${tool}`
      if (wasRead) {
        expect(verdict(name, 'read-only'), `${tool} is a read`).toBe('allow')
        expect(verdict(name, 'danger-full-access')).toBe('allow')
      } else {
        expect(verdict(name, 'read-only'), `${tool} is a write`).toBe('deny')
        expect(verdict(name, 'workspace-write')).toBe('ask')
        expect(verdict(name, 'danger-full-access')).toBe('allow')
      }
    }
  })

  it('refuses to let a glob swallow a destructive tool', () => {
    // The hazard in one line. `delete_vault_file` is a write today; a glob
    // loosened to `*_file` or a careless `d*` would make it a read, allowed at
    // every preset, with no prompt and nothing on any surface changing colour.
    const loosened = { ...OBSIDIAN, reads: [...OBSIDIAN.reads, '*'] }
    expect(isIntegrationRead(loosened, 'delete_vault_file'), 'a catch-all glob makes a delete a read').toBe(true)
    expect(isIntegrationRead(OBSIDIAN, 'delete_vault_file'), 'which is exactly what this manifest is here to catch').toBe(false)
  })

  it('governs nothing on a server Gnomon did not mount', () => {
    // A tool from an unmounted server is not Gnomon's to gate, and the card
    // must not imply otherwise by drawing a verdict for it.
    expect(verdict('mcp__somethingelse__delete_everything', 'read-only')).toBe('allow')
  })
})

describe("Gnomon's own tools, against the registry", () => {
  it('gives every registered tool a kind the gate can rule on', () => {
    // A tool added to `tools.js` and not to `GNOMON_TOOLS` is not gated by
    // Gnomon at all — it falls through to "dsh governs it", which for a tool
    // that writes to the owner's record is the wrong default and is invisible.
    const registered = [...readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tools.js'), 'utf8').matchAll(/name:\s*'(gnomon_[a-z_]+)'/g)].map(([, n]) => n)
    expect(registered.length, 'tools.js must still declare its tools by name').toBeGreaterThan(5)
    for (const name of registered) {
      expect(GNOMON_TOOLS[name], `${name} is registered but not in GNOMON_TOOLS, so the gate does not rule on it`).toBeDefined()
    }
  })

  it('keeps every outward tool off the read-only preset', () => {
    // The one promise the preset ladder makes. An `internal` tool writes to
    // Gnomon's own record; an `outward` one reaches past this machine, and
    // read-only must refuse all of them.
    for (const [name, cap] of Object.entries(GNOMON_TOOLS)) {
      if (cap.kind !== 'outward') continue
      expect(verdict(name, 'read-only'), `${name} reaches outward`).toBe('deny')
    }
  })
})
