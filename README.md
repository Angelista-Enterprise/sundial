# Sundial

**A local memory of your working day, and an assistant that can act on your Mac.**

Sundial is a local-first context engine for macOS. It watches what you work on
(the front window, git, your shell, the calendar, your coding agents' sessions)
and folds it into one SQLite file on your own disk. **Gnomon** is the assistant
inside it: it answers from what really happened, speaks first when it notices
something, and can work in your other apps, reading a window, pointing at a
button, pressing and typing, with a confirm before every final step. Your
record never leaves the Mac; only cleaned text goes to the model you choose,
and with a local model nothing leaves at all.

<!-- TODO(video): docs/media/hero.gif, 10 s cut of docs/media/hero.mp4. See docs/media/README.md.
![Gnomon fills a mail draft from the slip and asks before Send](docs/media/hero.gif) -->

## What it does

- **Keeps the record.** An append-only log of what happened, folded into
  moments, people, projects, promises and facts. A fact is replaced by a newer
  one, never erased, so "what did we believe on Tuesday" has an answer.
- **Knows where you are.** The current app, project, meeting and what you left
  open, for Gnomon and for any agent you connect over MCP.
- **Speaks first.** Notices (a meeting coming up, a promise due, a stretch with
  no project) are weighed against a bar you set before Gnomon says anything.
- **Looks and acts in your apps.** Through macOS Accessibility it reads an app
  as a list of controls, points, guides, and, once you allow it, presses, types
  and saves. Talk to it from the slip over any app (**⌥Space**), or hold the key
  and speak.
- **Asks before the step that matters.** Every send, delete, submit, overwrite,
  archive, leave, block, share, transfer, merge or approval asks, in every mode.
  Private apps (Messages, Mail, Slack, password managers, banking) are never
  looked at or touched. After a private read, a call that could carry data off
  the Mac asks first.
- **Is checked on our own test rig.** Every screen change runs on a rig that
  drives real apps with test data. Over 53 runs, 0 of 121 final steps ran
  without a confirm; a later run found one (a Return key on a Send button),
  fixed the same day and held since. These are our own counts on test apps,
  not a benchmark score ([docs/screen-acting.md](docs/screen-acting.md#how-it-is-tested)).
- **Learns what worked.** A screen task that ran clean becomes a route for that
  app; one that keeps working is offered as a skill. What Gnomon wants to change
  about itself waits on one card until you press **Keep**.

<!-- TODO(video): docs/media/confirm-final.png. See docs/media/README.md.
![The confirm for a final step: To:, the app, and Allow once or No](docs/media/confirm-final.png) -->

## What Gnomon never does

- Press, type or save in another app until you set **Outward actions** to
  **Ask** in Settings. Looking and pointing need no switch.
- Take a final step (send, pay, submit, delete, post, and the rest) without
  asking you, in any mode.
- Look at, open or touch a private app: messaging, mail, Slack, Notes,
  Calendar, Reminders, password managers, banking, health, and any you add.
- Act in System Settings, a password field, a sign-in window, or while macOS
  secure input is on.
- Act while your hands are on the keys.
- Send a screenshot to a model, or your record to anyone but the model you
  chose.

### Previous recording: the record (0.2.3)

https://github.com/user-attachments/assets/1c495afa-6e27-4635-9cbe-1b2b27628c97

*This earlier recording shows the 0.2.3 web client: the morning card, what is
owed before a client demo, a rule tested on the record, a typed correction
that becomes your fact, and the Ledger of every model call. Nothing in it is
real data. This predates the current client and will be replaced for 0.3.0.
The new videos will show screen approval, picking up a task from the record,
and asking from Claude Code.*

## Install

```bash
git clone https://github.com/Angelista-Enterprise/sundial.git && cd sundial
node bin/sundial install
node bin/sundial open
```

`install` checks your Mac, builds everything, writes `~/.sundial/`, puts
`Sundial.app` in Applications and starts it at login. `open` signs your browser
in and shows the setup page, which walks you through the permissions. The first
observations arrive within a minute. Step by step: [docs/getting-started.md](docs/getting-started.md).

### Requirements

- macOS 14 or newer (`node bin/sundial doctor` checks it). Apple silicon or
  Intel from source; the release zip is Apple silicon only.
- Node.js 22 or newer, and [pnpm](https://pnpm.io).
- Xcode Command Line Tools (`xcode-select --install`): the sensors are native
  Swift.
- macOS permissions, all granted to **Sundial** and each one optional:

| Permission | Why |
|---|---|
| Accessibility | Window titles; for Gnomon, reading an app's controls and pressing and typing in them |
| Input Monitoring | Counts of keys and clicks (never which keys), and your last key time, so Gnomon never acts while you type |
| Calendars, Contacts, Reminders | Your meetings and who is in them; a reminder only when you approve one |
| Screen Recording | Text inside pictures when Gnomon looks at a window, read on the Mac |
| Microphone | Hold to talk, and hearing if you turn it on; transcribed on the Mac |
| Automation | The site and path of the front browser tab |

Sundial's helpers are signed on your Mac, so macOS forgets a grant when a helper
is rebuilt; a release that changes them needs a re-grant. Details:
[docs/permissions.md](docs/permissions.md).

## Give Gnomon a model

Without a model Sundial still records and the Today screen still shows your
day. Gnomon's chat and summaries need one. Choose it on `/setup`, or write
`~/.sundial/.env`:

```bash
# On this Mac (Ollama here; MLX and LM Studio work the same): nothing leaves the Mac
SUNDIAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
SUNDIAL_LLM_MODEL=qwen3:8b
```

For a model on your own server, set its address instead
(`https://gpu-box.example.com/v1`). For a provider (OpenAI,
OpenRouter, DeepSeek, any OpenAI-compatible endpoint), set its address, a model
and `SUNDIAL_LLM_API_KEY`. Anthropic is added on `/setup` as a provider.

Then `node bin/sundial restart`. Add more providers on `/setup`, pick one per
conversation, and give a fast route a backup. Details: [docs/models.md](docs/models.md).

## Privacy

- **No telemetry.** The Sundial app sends no usage data, crash reports or
  analytics. The harness it runs on (dsh) has a telemetry exporter, and Sundial
  starts it with `DSH_TELEMETRY_DISABLED=1`. The public demo web page counts
  named events with GoatCounter, never text; the app counts nothing.
- **Your record stays on your Mac**, in `~/.sundial/sundial.db`, private to your
  user. No account, no cloud.
- **Only cleaned text goes to the model you set.** That includes the text of a
  window Gnomon looks at (never a screenshot). Point it at a model on this Mac
  and nothing leaves. Every call is listed in the Ledger.
- **Cleaned once, at ingest**: secrets, tokens, URL query strings, your user
  name in paths, and e-mail addresses are removed before anything is written.
- **Embeddings are computed on your Mac.**
- **Only your browser can reach it.** The web client listens on `127.0.0.1`
  and every route needs a signed session cookie. For your phone, use Tailscale
  Serve; never change the bind.
- **What still goes out by default**, with no model set: a one-time download of
  the embedding model from Hugging Face, if you say yes when `install` asks; a
  check of your open pull requests through your own `gh` login every five
  minutes, if `gh` is signed in (`sensors.githubPrs: false` turns it off); five
  lines of context for each new Claude Code session, if you say yes to that
  hook; and in the packaged release app only, a daily update check that asks
  before it installs anything (**Check for Updates Daily** in the menu turns it
  off). Offers of help and the text of a window Gnomon looks at go only to the
  model you set.

Every network call, and how to turn each off: [docs/privacy.md](docs/privacy.md).
The threat model: [SECURITY.md](SECURITY.md).

## Previous recording: ask it from Claude Code (0.2.3)

https://github.com/user-attachments/assets/a155502b-ebc6-4680-bb01-2e1d87177bec

*This earlier recording uses the 0.2.3 interface and will also be replaced for
0.3.0. The current screen workflow is described in
[Screen acting and its safety](docs/screen-acting.md).*

`install` offers to add Sundial to Claude Code. By hand:

```bash
claude mcp add sundial --scope user -e SUNDIAL_HOME="$HOME/.sundial" -- node "$PWD/packages/mcp/bin/sundial-mcp.js"
```

`node bin/sundial mcp-hosts` adds it to VS Code, Cursor, Codex, Goose, Gemini
CLI and Claude Desktop (`--remove` takes it out). A host gets read tools over
the record, a few writes that only carry your own words, MCP Apps cards where
the host draws them, and the prompts `brief`, `today` and `handoff`.
`sundial mcp --http` serves the same on `127.0.0.1:3090/mcp` behind a token.

## Commands

Run them from the repository folder as `node bin/sundial <command>`.

| | |
|---|---|
| `install` | check, build, write `~/.sundial`, start at login |
| `open` | sign this browser in and open Sundial |
| `status` / `doctor` | what is running / check prerequisites |
| `start` / `stop` / `restart` | the app (the sun in the menu bar) |
| `hearing` | set up local speech for hold to talk and hearing (about 575 MB) |
| `mcp` / `mcp-hosts` | the MCP server; add it to other agent hosts |
| `uninstall` | remove everything install wrote (a dry run until `--yes`) |

## How it works

```
sensors → clean once at ingest → append-only log (SQLite)
                                        │
                      one fold over a fixed list of rules → one state
                                        │
         effects (model calls, memory writes, embeddings), audited in one place
```

Signed Swift helpers read what macOS lets them see; Node never touches a
permission-gated API. Everything you see is derived from the log, so it can be
replayed. Sundial runs on [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh),
an open-source (MIT) agent harness, as a set of plugins; dsh does not pick your
model. More: [docs/architecture.md](docs/architecture.md).

## Status and limits

- **Early (0.3), one developer**, used daily on one Mac. Expect rough edges.
- **macOS only, one Mac.** No phone app, no sync.
- **Acting is off on a new install.** Turn on *Outward actions* in Settings to
  let Gnomon press and type ([docs/screen-acting.md](docs/screen-acting.md)).
- **No sandbox.** Gnomon acts in your real apps, as you. The confirm is a gate,
  not isolation, and prompt injection from a web page or a mail is limited, not
  solved.
- **As fast as your model.** A local model is slower than a fast hosted one.
- **Final buttons in seven languages.** English, Dutch, German, French, Spanish,
  Portuguese and Italian; a button in another language still asks as an
  ordinary step.
- **Ad-hoc signed.** A rebuilt helper needs its permissions granted again.

See [CHANGELOG.md](CHANGELOG.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
Uninstall with `node bin/sundial uninstall --yes`, then
`tccutil reset All dev.sundial.daemon`. Licence: [MIT](LICENSE).
