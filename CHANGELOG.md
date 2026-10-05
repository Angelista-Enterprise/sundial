# Changelog

## 0.2.3 — 2026-10-05

### Added
- A coding-agent sensor: the on-disk transcripts of Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor and opencode become `agent:turn` events — each typed prompt, each final reply, each rejected or interrupted step. Never a tool's input or output; text capped at 2,000 characters and cleaned once like everything else. Switch: `privacy.agentTranscripts` (default on).
- `gnomon_agent_sessions`: one read tool for the fleet — each session's state, its turns, the files its hooks edited, commits on its branch and the dirty count; waiting-on-you first. Live sessions' history is backfilled.
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

## 0.2.2 — 2026-10-03

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

## 0.2.1 — 2026-10-02

### Fixed
- Background model calls keep up: a delayed call waits before it takes a route slot, so a replay or a busy day is no longer capped at about 20 calls a minute.
- A short network outage no longer drops queued model calls: a refused call waits once past the breaker, then runs.
- Moment classification reads a choice answered without its `probabilities` wrapper, which some models send; about half of those answers were dropped.
- A walk-through on the board called through the tool menu shows its Back and Next buttons instead of hanging for ten minutes.
- A board link may name a card with a space in its id, in any case.
- A promise heard as a deed ("send the deck") reads as one in the question, the line and the brief.

## 0.1.0 — unreleased

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
