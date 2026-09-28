# Changelog

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
