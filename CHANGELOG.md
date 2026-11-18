# Changelog

## 0.3.0 (unreleased)

Gnomon can now work in your other apps: it reads a window, points, guides you,
and, once you allow it, presses, types and saves, with a confirm before every
step that cannot be taken back. This release holds about 800 changes since
0.2.3.

### Before you upgrade
- The Swift helpers are rebuilt, so macOS forgets their permissions. Remove
  Sundial from each Privacy & Security pane, add it again, and restart
  ([docs/permissions.md](docs/permissions.md#rebuilding-changes-the-identity)).
- Accessibility now also lets Gnomon read, press and type in apps; Input
  Monitoring now also tells Gnomon when you are typing.
- Looking at a window is on by default and sends that window's cleaned text to
  your chat model (never a picture). Pressing and typing stay off until you set
  **Settings → Outward actions** to **Ask**.
- New switches that default on: `experiments.screenLook`, `screenMarks`,
  `screenGuide`, `screenAct`, `holdToTalk`, `quietSummon`, `voiceKnock`,
  `offerNow`. Set any of them to `false` to turn it off.

### Gnomon acts on your Mac
- Gnomon reads an app's window as a list of controls (`screen_look`), points at
  one (`screen_mark`), walks you through up to seven steps (`screen_guide`), and
  presses, types, saves, picks menu items, renames in Finder, drags, and steers
  Open and Save panels (`screen_act`). No screenshot goes to the model; text in
  pictures is read on the Mac.
- `screen_undo` puts back a value Gnomon replaced.
- "Pull it up": `gnomon_pull_up` finds a document in your recent windows or the
  record, opens it and rings it.
- Gnomon waits for a loading window, names a sheet someone left open and leaves
  it alone, reads a window's default and cancel buttons, and only calls a file
  saved when it changed on disk.
- `gnomon_await` waits for a job, an app, a window title, a file or a timer
  instead of sleeping.
- Each chat tracks one task and how it ended; a message sent mid-turn corrects
  the running task, and Stop ends a step or a hung model call.
- A screen task that ran clean becomes a route for that app, shown on the
  **Routes** card (with Drop) and offered the next time you ask for something
  similar. A route that ran clean three times on two days is offered as a
  skill; "run *name*" replays it, still asking.
- **Gnomon proposes**: one card for what Gnomon learned and wants to change (a
  fix to its own failed steps, a chore you repeat each morning, a rule idea).
  Nothing applies before you press **Keep**.
- Offers of help: when you stay in one window for a few minutes, Gnomon may ask
  your model once whether it can help there. The notice gate decides whether it
  is said, at most four a day (`experiments.offerNow`).

### Safety
- Every screen step asks. Every final step (send, pay, submit, delete, discard,
  post, update, overwrite, archive, leave, block, share, transfer, merge,
  approve or decline) asks in every mode, with the recipient, path or command
  in the question. A no stands for the rest of the turn; an unanswered ask is
  refused after five minutes.
- Final buttons are recognised in English, Dutch, German, French, Spanish,
  Portuguese and Italian. A button Gnomon has no word for never stops asking.
- Private apps (messaging, mail, Slack, Notes, Calendar, Reminders, password
  managers, banking, health, and the ones you add) are never looked at, opened
  or touched, by any path, under any language's app name.
- Your hands win: a step waits while you type, and is refused if you keep
  typing.
- After a private read, a web or shell call that could carry data off the Mac
  asks first (`web.knownHosts`).
- Inline scripts that hold an address are refused; a loop stops and asks you
  how to go on.
- With outward actions on **Auto**, a plain step stops asking in one app after
  ten yeses in a row there (`actions.earnAfter`); one no resets it. Finals and
  typing always ask.
- Every rule, and what Gnomon refuses: [docs/screen-acting.md](docs/screen-acting.md).

### Memory
- The conversation pass reads its whole window in paced chunks and files
  concrete, dated events, valid from the day they were said.
- `gnomon_semantic_search` takes a period, and says when an answer is what you
  told Gnomon.
- An **About you** card: what Gnomon believes about you, each belief with its
  source, Fix and Wrong.
- Gnomon learns your own apps and workspaces from window titles.
- Every open pull request you authored, from one search
  (`gnomon_pull_requests`).
- Meetings: declined ones are dropped, and only meetings you were in count as
  "met with".
- Page text for Firefox-family browsers over Accessibility
  (`browser.pageTextAx`, off by default).
- Witness pairs check that sensors which should agree do.
- The phone can post events through an ntfy inbox (`notifications.inbox`).

### Privacy
- Settings has a group, **What may leave this Mac**, with a switch for the
  search model download, Atlas mode's libraries and the pull request check.
- `install` asks before the search model download (about 90 MB from
  huggingface.co; Enter is yes) and keeps the answer as `memory.embeddings`.
  With `false` the model is never downloaded and search matches words only.
  The packaged app asks the same on `/setup` and downloads nothing until then.
- `sensors.githubPrs: false` stops the pull request check (no `gh` call).
  `install` says when it will run.
- `install` asks before each change to Claude Code: the report-only hooks, the
  SessionStart context hook (up to five record lines reach Anthropic per new
  session) and the gnomon-band mod link. Enter is yes.
- Yes to hearing no longer turns on `audio.autoMeetings`: whether a call opens
  hearing by itself is its own question, no by default.
- `atlas.libraries: false` stops Atlas mode's searches and downloads.
- `audio.whisperUrl` must be on this Mac: `doctor`, the config reader and the
  app's launcher all refuse any other host.
- Private apps and sites are editable in Settings, with suggestions.
- [docs/privacy.md](docs/privacy.md) lists every network call, including the
  ones made by default.

### Voice
- Hold to talk: hold the summon key and speak; a press while Gnomon speaks cuts
  in. Transcribed on the Mac by local Whisper (`node bin/sundial hearing`).
- Gnomon reads its reply aloud with Kokoro on the Mac (`voice.python`), or the
  system voice, and says each screen step before it takes it. A soft knock
  comes before a notice is said.

### App
- The slip: a thin panel over your apps on **⌥Space** (`overlay.hotkey`), with
  the step Gnomon is on, its question, a trace of its calls (⌥T), Stop, and the
  model picker.
- The packaged app checks for updates daily and asks before installing one;
  **Check for Updates Daily** in the menu turns the check off.
- Every Swift build targets macOS 14, and `doctor` checks for it.
- Models: providers speak OpenAI chat, OpenAI responses or Anthropic messages;
  an Anthropic preset on `/setup`. `llm.roles` lists sources per role, with
  fallback on a limit; Claude Code and GitHub Copilot can run the chat on your
  own login. A stalled chat call is sent again or moves to a backup route
  (`hedgeTo`), and the chat and the slip say so. Compaction runs after the
  turn, not inside it.
- MCP: Streamable HTTP on the loopback next to stdio (`sundial mcp --http`),
  MCP Apps cards, the prompts `brief`, `today` and `handoff`, live resources,
  and `gnomon_today`, `gnomon_open_ask` and `gnomon_owner_answer`.
  `sundial mcp-hosts` adds Sundial to VS Code, Cursor, Codex, Goose, Gemini CLI
  and Claude Desktop.
- Watch rules may emit an event, run as a flow, reach a tool behind an ask, and
  take a verdict per fire. Inlets let another system add declared events
  (`sundial ingest`, `gnomon_ingest`).
- Atlas mode draws anatomy and 3D objects from open libraries.

### Fixes
- A Stop pressed while Gnomon clicks is kept.
- Keys and typed text reach the process that holds the keyboard, so an Open or
  Save panel gets them.
- A model that must reason gets a second ask at low effort instead of failing.
- A model's thought printed as text never reaches you as an answer.
- A failed background job says why, and a learner's failed job is retried once.
- `env.example` no longer lists `SUNDIAL_PHONE_INGEST`, which nothing reads.

## 0.2.3 (2026-10-05)

### Added
- A coding-agent sensor: the on-disk transcripts of Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor and opencode become `agent:turn` events: each typed prompt, each final reply, each rejected or interrupted step. Never a tool's input or output; text capped at 2,000 characters and cleaned once like everything else. Switch: `privacy.agentTranscripts` (default on).
- `gnomon_agent_sessions`: one read tool for the fleet: each session's state, its turns, the files its hooks edited, commits on its branch and the dirty count; waiting-on-you first. Live sessions' history is backfilled.
- A promise can open from what you type to a coding agent: a promise said outright to a named person, or a deadline on the work ("push before standup") once its proof is visible.
- `llm.contextWindows` in `config.json`: a context window per model; compaction starts at 80% of it, and the context gauge measures against it.
- A website, with a demo in the browser: angelista-enterprise.github.io/sundial. The demo runs Sundial's own client on a made-up week; the chat uses Chrome's built-in model. A Feedback issue form, so a note left in the demo lands here with its label.

### Fixed
- Four sanitize gaps found in the live record: window titles get the secret and personal-data pass, a title URL with a port or localhost loses its query, a web URL in `documentPath` loses its query, and a one-time code after its keyword is removed.
- Copy and paste reach the web view: the app has an Edit menu, so ⌘C and ⌘V work.
- `sundial restart` waits for the old app process itself, not its pid file, so `open` no longer hits the dying instance.
- A chat is told each unchanged part of its brief once; later briefs send only what changed. 89 replayed chats: 4 → 2–3 compactions at 128k, 16–23% fewer uncached tokens.
- A forecaster feeds the noticing gate only at the scorecard's bar (skill ≥ 0.2, n ≥ 200).
- Reliability rows read what they claim: the breaker's longest closed run (not its failed probes), only outward calls that ran, and only the heartbeat stream, listing quiet streams instead of failing on them.

## 0.2.2 (2026-10-03)

### Fixed
- Thread titles and compaction on a reasoning model that cannot stop reasoning: the adapter asks once more without the flag instead of failing every call.
- The turn brief writes promise due times on the owner's clock, so a 09:30 standup no longer reads "07:30 UTC" in an answer.
- The chat reads every tool timestamp on the owner's clock.
- A fact the owner stated reads "you told me", never a sighting count; a noun predicate ("role") reads as a sentence.
- The composer says "Thinking…" first and asks "Taking too long?" only after twenty seconds; a walk waiting on Next or an open question is the owner's pause, not a slow turn.
- The board's tool strip fits the window at 1512 px.
- A compaction checkpoint no longer counts as the turn's opener, so the owner's own answer to a question does not stop for a second nod.
- A shell command asks first under the default preset.
- A focus span ends after ten quiet minutes instead of running overnight.
- A day summary knows leisure, and leisure is not focus.
- Tool arguments arrive as the model sends them: "2" for 2, a quoted list for a list.
- A judgement nobody can pay for says so instead of being dropped silently.
- gnomon_tickets no longer claims PR states it does not hold.
- Kanban: a promise reads as a person and a due date; a promise owed to the owner waits rather than sitting under Doing.
- A place the owner called leisure is not untracked time to file; no open moment means Away.
- One work agent is created at a time; a brief for a meeting that already started is refused with that reason.
- A host that stops resolving keeps its last good address, so a flaky DNS server does not count as three failed model calls.

### Added
- Later on the question seat: an open question can be set aside for now.
- Docs name dsh, what Gnomon does unasked, and every permission; a QA catalog of every card, route, tool and flow.

## 0.2.1 (2026-10-02)

### Fixed
- Background model calls keep up: a delayed call waits before it takes a route slot, so a replay or a busy day is no longer capped at about 20 calls a minute.
- A short network outage no longer drops queued model calls: a refused call waits once past the breaker, then runs.
- Moment classification reads a choice answered without its `probabilities` wrapper, which some models send; about half of those answers were dropped.
- A walk-through on the board called through the tool menu shows its Back and Next buttons instead of hanging for ten minutes.
- A board link may name a card with a space in its id, in any case.
- A promise heard as a deed ("send the deck") reads as one in the question, the line and the brief.

## 0.1.0 (unreleased)

The first public version. What changed from the private build:

### Added
- `sundial` command: `install`, `open`, `status`, `doctor`, `start`/`stop`/`restart`, `mcp`, `migrate`, `uninstall`.
- One-command install into `~/.sundial` (`SUNDIAL_HOME`), with its own dsh home, profile and LaunchAgent.
- `/setup` page: every macOS permission in plain words, with its live state; how to add a model.
- Start with your history (`/setup`): choose folders and days, see what would be read, then read your own commits (default 30 days) and past meetings (7 days) into the record at their real times. Nothing runs by itself; a second run adds only what is new.
- Sundial runs without a model: it records, and Today shows the day.
- `sundial install` asks (y/N) to add Sundial to Claude Code with `claude mcp add`; without a terminal it prints the command.
- Model settings on `/setup`: presets (Ollama on this Mac, OpenAI, OpenRouter, DeepSeek, any OpenAI-compatible address), a connection check that lists the provider's models, save, and restart. More providers can be added; each is a choice in the chat's model picker. Keys stay in `.env` and are never shown again.
- `sundial migrate` copies a pre-rename `~/.gnomon` install (never moves it).
- CI: typecheck, tests, secret scan, end-to-end install.

### Security
- Every web route requires dsh's session cookie and passes its Host/Origin/Sec-Fetch fence (CSRF and DNS rebinding).
- Background jobs cannot write to your services or run commands.
- Web pages Gnomon places on the board load only on click; Gnomon's web tools cannot reach this Mac or the local network.
- More sensor fields are sanitized at ingest; token-shaped secrets are redacted.
- The data folder is 0700 and every process runs under `umask 077`.
- No Camera permission request; dsh telemetry disabled.

### Changed
- The model route is `openai` (was `tensorx`, still accepted for old conversations); its model list comes from the provider's own `/models`. `sundial migrate` rewrites the saved default.
- Software renamed to **Sundial** (`@sundial/*`, `SUNDIAL_*`, `Sundial.app`, `dev.sundial.*`); the agent stays **Gnomon**.
- Opt-in by default: Mail/Messages capture, full page text, the phone ingest listener, the hosted judge.
- Experimental and off by default: forecasting, gate-feature logging and the network presence scan (`config.experiments`).
- A notice-opened turn cannot record a fact as the owner's words, and asks before starting a job, scheduling a wake-up or filing an answer.

### Removed
- The retired standalone daemon and its CLI, lab scripts, private plans and logs, the Telegram bridge.
