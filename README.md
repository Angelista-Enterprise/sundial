# Sundial

**A local memory of your work, for you and your coding agent.**

Sundial is a macOS daemon. It watches what you work on (the focused window, git,
your shell, the calendar, your coding agent's sessions, notes in an Obsidian vault
and, if you opt in, mail subjects) and folds it into one SQLite file on your own disk.

**Gnomon is the assistant inside it.** It answers from what really happened, and
speaks first when it notices something. An MCP server lets Claude Code or any other
agent ask the same questions.

https://github.com/user-attachments/assets/1c495afa-6e27-4635-9cbe-1b2b27628c97

*One Thursday morning on a made-up week: the morning card, what is still owed before
a client demo, a research brief with its sources, a rule tested on the record before
you keep it, a typed correction that becomes your fact, and the Ledger of every model
call. Nothing in it is real data.*

## Quickstart

```bash
git clone https://github.com/Angelista-Enterprise/sundial.git && cd sundial
node bin/sundial install
node bin/sundial open
```

`install` checks your Mac, builds everything, writes `~/.sundial/`, and starts
Sundial at login. `open` signs your browser in and shows the setup page, which
walks you through the macOS permissions. The first observations arrive within a
minute. Measured on a clean clone: about 30 seconds with warm caches; plan on a
few minutes for the first dependency download.

Gnomon needs a model to talk. Without one, Sundial still records and the Today
screen still shows your day. Choose one on the `/setup` page (Ollama on this Mac,
OpenAI, OpenRouter, DeepSeek or any OpenAI-compatible address), or add one line
pair to `~/.sundial/.env`:

```bash
# local, nothing leaves your Mac (Ollama)
SUNDIAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
SUNDIAL_LLM_MODEL=qwen3:8b
```

Any OpenAI-compatible endpoint works (set `SUNDIAL_LLM_API_KEY` for a hosted one).
Then `node bin/sundial restart`. More providers can be added on `/setup`; you
pick one per conversation in the chat's model picker.

## Ask it from Claude Code

https://github.com/user-attachments/assets/a155502b-ebc6-4680-bb01-2e1d87177bec

*The same made-up week, asked from outside: Claude Code, with only Sundial's
read-only MCP tools, tells the story of the week and what is still owed. Then the
release call it mentioned, opened down to the raw capture.*

`sundial install` asks to add Sundial to Claude Code at the end. To do it by hand:

```bash
claude mcp add sundial --scope user -e SUNDIAL_HOME="$HOME/.sundial" -- node "$PWD/packages/mcp/bin/sundial-mcp.js"
```

Any other MCP client works the same way: the server is `sundial mcp`, over stdio.

## The privacy promise

- **Your record stays on your Mac.** One SQLite file, `~/.sundial/sundial.db`,
  private to your user (0600). No account, no cloud, no telemetry. (The release
  app checks this repository's update feed once a day; a source install does not.)
- **Nothing leaves until you choose a model.** Then only sanitized text goes to
  the endpoint *you* set — point it at a local model and nothing leaves at all.
  Every model call is listed in the Ledger.
- **Redaction happens once, at ingest**: passwords, tokens and API keys, URL
  query strings, your user name in paths, and e-mail addresses are removed before
  anything is written.
- **Embeddings are computed on your Mac.**
- **Only your browser can reach it.** The web client binds to `127.0.0.1` and
  every route needs a signed session cookie; other sites cannot read or drive it.

Details, the threat model, and what exactly can leave: [SECURITY.md](SECURITY.md).

## Requirements

- macOS 14 or newer. From source: Apple silicon or Intel. The release zip: Apple silicon only.
- Node.js 22+ and [pnpm](https://pnpm.io)
- Xcode Command Line Tools (`xcode-select --install`) — the sensors are native Swift
- Optional: [Ollama](https://ollama.com) for a local model

## Commands

Run them from the repo folder as `node bin/sundial <command>` (or `./bin/sundial`).
To type just `sundial`, add `alias sundial="node /path/to/sundial/bin/sundial"` to `~/.zshrc` (your clone's real path).

| | |
|---|---|
| `sundial install` | check, build, write `~/.sundial`, start at login |
| `sundial open` | sign this browser in and open Sundial |
| `sundial status` | what is installed and running |
| `sundial doctor` | check prerequisites |
| `sundial start` / `stop` / `restart` | the app (the sun in the menu bar) |
| `sundial mcp` | a read-only MCP server over stdio, for Claude Code and other agents |
| `sundial uninstall` | remove everything install wrote (a dry run until you add `--yes`) |

`SUNDIAL_HOME` moves the data folder; `SUNDIAL_WEB_PORT` (3080) and
`SUNDIAL_PHONE_PORT` (8767) move the ports.

## How it works

```
sensors → sanitize at ingest → append-only log (SQLite)
                                      │
                    one fold over a fixed list of rules → one state
                                      │
             effects (model calls, memory writes, embeddings), audited in one place
```

Swift helpers read what macOS lets them see. The long-running ones (front window,
input counts, notification badges, focus mode, screen text) write small JSON files
that the Node process reads; the calendar and browser helpers run on demand. Only
these signed helpers touch the permission-gated APIs, never Node itself. The log is the truth: everything
you see is derived from it, so it can be replayed.

**Built on dsh.** Sundial runs inside [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh),
an open-source (MIT) agent harness that DeepSeek publishes on npm. dsh gives the chat its
sessions, tool calls, approvals and model routing; Sundial is a set of dsh plugins
(`plugins/sundial-*`). dsh does not choose your model: Gnomon talks only to the endpoint
you set, and dsh's optional telemetry exporter is switched off (`DSH_TELEMETRY_DISABLED=1`).
The pinned version is a release candidate (`0.1.5-rc.1`).

**What Gnomon may do without asking.** Read the record, write to its own record, search
the web and read pages. A shell command asks you first under the default preset and is
refused in background jobs; anything that writes to your services asks first. The
**Auto** chip lifts the asks for one conversation. Details: [SECURITY.md](SECURITY.md).

## Uninstall

```bash
node bin/sundial uninstall --yes
```

It removes `~/.sundial` and its LaunchAgent, and only if that folder carries the
installer's marker. To also clear macOS's permission grants:
`tccutil reset All dev.sundial.daemon`.

## Documentation

Everything else is in [docs/](docs/README.md): permissions, models, privacy,
using Gnomon, troubleshooting, why Sundial is built this way, the architecture,
and how to develop on it.

## Status

v0. One developer, used daily on one machine, now installable on yours. Expect
rough edges; see [CHANGELOG.md](CHANGELOG.md) and
[CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
