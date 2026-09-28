# Development

This page explains how to build, test and run Sundial from a checkout without
touching your own install, and the rules every change follows. Read
[architecture.md](architecture.md) first if you have not seen the code before.

## Prerequisites

- macOS 14 or newer. The sensors are native Swift, so Sundial does not run
  elsewhere.
- Node.js 22 or newer.
- [pnpm](https://pnpm.io). CI uses pnpm 10.
- Xcode Command Line Tools, for `swiftc`: `xcode-select --install`.
- `sqlite3`, which ships with macOS.

`node bin/sundial doctor` checks all of these and prints a fix for anything
missing.

## Repository layout

| Path | What is there |
|---|---|
| `packages/` | The TypeScript core: kernel, rules, sensors, database, memory, model transport, MCP server |
| `plugins/` | The dsh plugins that run it, including the web client in `plugins/sundial-theme/shell/` |
| `apps/harness/` | The pinned dsh dependency and the sidecar lifecycle script |
| `apps/daemon/` | Swift sidecar sources and the scripts that build `Sundial.app` |
| `bin/sundial` | The CLI. Plain Node, no dependencies, runs before anything is built |
| `test/` | The CLI tests and the end-to-end install script |

## Install dependencies

This is a pnpm workspace with a pnpm lockfile. Never run `npm install` here.

```bash
pnpm install
```

## Build

dsh loads the packages from their built `dist/` folders, not from source. Build
after any change to a package that another package or a plugin imports:

```bash
npx tsc -b tsconfig.json
```

A green editor typecheck is not enough. If the harness fails to boot with an
error such as `does not provide an export named X`, a `dist/` folder is stale:
build again.

Plugins are plain JavaScript and need no build.

## Test

Run the whole suite:

```bash
npx vitest run
```

Run one file:

```bash
npx vitest run packages/rules/src/notice-gate.test.ts
```

[../vitest.config.ts](../vitest.config.ts) gives every run its own empty
`SUNDIAL_HOME` and `DSH_HOME` in a temporary folder, so a test cannot read or
write a real install even if it forgets to stub something.

## Change the web client

The web client in `plugins/sundial-theme/shell/` is plain ES modules served as
files. There is no bundler. After editing a file there, reload the browser.

A change on the host side (a plugin's `index.js`, `shell/server.js`, a package)
needs a build if it touched a package, then a restart of the install you are
running:

```bash
node bin/sundial restart
```

## Run a test install

A test install uses its own data folder, LaunchAgent label and ports, so it never
shares anything with your real one. Every path the CLI touches comes from these
variables:

| Variable | Default | Test value |
|---|---|---|
| `SUNDIAL_HOME` | `~/.sundial` | `~/.sundial-test` |
| `SUNDIAL_LABEL` | `dev.sundial.agent` | `dev.sundial.test` |
| `SUNDIAL_WEB_PORT` | `3080` | `3180` |
| `SUNDIAL_PHONE_PORT` | `8767` | `8867` |
| `SUNDIAL_CHROME_PORT` | `9223` | `9323` |

`--no-sidecars` still builds the Swift helpers but never starts them, so no macOS
permission prompt appears. Install with all of them set:

```bash
SUNDIAL_HOME=$HOME/.sundial-test SUNDIAL_LABEL=dev.sundial.test SUNDIAL_WEB_PORT=3180 SUNDIAL_PHONE_PORT=8867 SUNDIAL_CHROME_PORT=9323 node bin/sundial install --no-sidecars
```

Later commands for that install need only `SUNDIAL_HOME`: the install records
its label and ports in `$SUNDIAL_HOME/.sundial-install.json`, and `open`,
`status`, `restart` and `uninstall` read them from there. For example, to remove
it (without `--yes` it only prints what it would delete):

```bash
SUNDIAL_HOME=$HOME/.sundial-test node bin/sundial uninstall --yes
```

Other install flags: `--no-launchagent` (write `start.sh` but do not register it
with launchd), `--skip-build`, `--no-open`, and `--no-mcp` (do not offer to add
the MCP server to Claude Code). Logs are in
`$SUNDIAL_HOME/logs/`.

The end-to-end script does all of this in one go: install, check the auth fence
and that signals arrive, then uninstall. It uses the test values above, so it
removes `~/.sundial-test` when it finishes.

```bash
zsh test/e2e-install.sh
```

With `E2E_NO_LAUNCHD=1` it runs `start.sh` directly instead of through launchd,
which is how CI runs it.

## Rebuild the Swift sidecars

The build scripts write into `/Applications/Sundial.app` for the real install and into `$SUNDIAL_HOME/Sundial.app` for a test or `--no-app` install (`SUNDIAL_APP_PATH` overrides both). Set `SUNDIAL_HOME` when
you run them, or they rebuild your real install:

```bash
SUNDIAL_HOME=$HOME/.sundial-test pnpm sidecars:build
```

The helpers are ad hoc signed, so a rebuilt helper has a new identity and macOS
treats it as a new app. After rebuilding the helpers of an install that uses them,
grant the permissions again (see [permissions.md](permissions.md)) and restart.

## Never run dsh without DSH_HOME

Sundial's install keeps its own dsh folder at `$SUNDIAL_HOME/dsh`, and its start
script sets `DSH_HOME` to it. Running `dsh` by hand from a checkout without
`DSH_HOME` set, even `dsh --help`, re-points the module links under `~/.dsh`,
which can break another dsh setup on the same Mac. Always set it first.

## Continuous integration

[../.github/workflows/ci.yml](../.github/workflows/ci.yml) runs three jobs:

- **test** (macOS): `pnpm install --frozen-lockfile`, `npx tsc -b tsconfig.json`,
  `npx vitest run`.
- **secrets** (Linux): gitleaks over the tree and the full history.
- **e2e-install** (macOS, after `test`): `E2E_NO_LAUNCHD=1 zsh test/e2e-install.sh`.

Run the first and last locally before you open a pull request.

## Conventions

- **Sundial is the software, Gnomon is the agent.** Name software things
  `sundial-*` and `SUNDIAL_*` (the app, CLI, install, data folder). Keep
  `gnomon_*` for the agent's own tools, voice, chat and notices.
- **A new capability is a new `KernelState` field and a new rule in
  `RULE_MANIFEST`.** Never a module with its own mutable state. If you are about
  to add a module-level variable, timer or set to remember "have we done X yet",
  that memory belongs on `KernelState`.
- **Rules are pure.** A rule takes `(state, event)` and returns
  `{ state, effects }`. No disk, network or timers inside a rule, and no reading
  the clock: use the event's timestamp.
- **Side effects happen only in the effect executor**
  ([../packages/harness-runtime/src/runtime.ts](../packages/harness-runtime/src/runtime.ts)).
- **Redaction happens only at ingest.** A new sensor field that can hold free
  text, a path, a URL or an address gets a line in
  [../packages/helpers/src/sanitize-at-ingest.ts](../packages/helpers/src/sanitize-at-ingest.ts)
  and a test in `sanitize-at-ingest.test.ts`. A read path never redacts again. If
  you reach for a redaction function in a read path, the value should already
  have been safe.
- **Every web route goes through `registerRoute` / `guard()`** in
  `plugins/sundial-theme/shell/`. `guard.test.js` fails otherwise. An in-process
  caller adds `internalHeaders()`.
- **Nothing binds beyond loopback.** Remote access goes through Tailscale Serve.
- **Embeddings stay local.** Do not add a remote embedding path.
- **Capture that costs privacy ships off by default**, behind a `config.json`
  switch, fully built.
- **Laziest change that works.** The fewest lines and files. No new dependency
  unless there is no other way.
- **Every fix comes with a test** that fails without it.

## Commit messages

Use the conventional style the history already follows:

```
type(scope): what is true after this change
```

- `type` is one of `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`.
- `scope` is the area touched, such as `install`, `sidecars`, `shell`, `llm`,
  `config`, `security` or `build`. It is optional.
- The summary is lowercase, in plain words, and says what the change makes true,
  for example `fix(install): a restart restarts the sensor helpers`.

## Pull requests

One change per pull request, with a test when behaviour changes. Say what you
ran. Report security problems privately as described in `SECURITY.md`, not in
the issue tracker.
