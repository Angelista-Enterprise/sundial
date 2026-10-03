# Security

Sundial records what you do on your Mac. That record is only worth having if it
stays yours. This page says what Sundial protects, from whom, what leaves the
machine, and how to report a problem.

## Report a vulnerability

Use GitHub's private reporting: the repository's **Security** tab → **Report a
vulnerability**. Please do not open a public issue for a security problem.

Say what you found, how to reproduce it, and which version (`git rev-parse HEAD`).
You will get an answer within 7 days. A fix for a confirmed issue ships before it
is discussed in public.

## What Sundial protects

| Asset | Where it lives |
|---|---|
| The event log, moments, the people/project graph, embeddings | `~/.sundial/sundial.db` (SQLite, mode 0600) |
| Your LLM key and other secrets | `~/.sundial/.env` (0600) |
| Screen text, window titles, sidecar state | `~/.sundial/.daemon/` (0700) |
| Conversations with Gnomon | `~/.sundial/dsh/` (0700) |
| The web client session | a signed, `HttpOnly`, `SameSite=Strict` cookie per browser |

The whole folder is created 0700 and every process runs under `umask 077`.
`SUNDIAL_HOME` moves it.

## Threat model

**In scope — Sundial defends against:**

- **Web pages in your browser.** Every route of the local web client checks the
  Host header, the Origin and `Sec-Fetch-Site`, and requires the session cookie.
  A page on another site cannot read your record, drive Gnomon, or change a
  setting (no CSRF, no DNS rebinding). Only the sign-in link that `sundial open`
  prints creates the cookie.
- **Other accounts on the same Mac.** Files are private to your user; the web
  client needs the cookie, which other accounts cannot read.
- **The network.** Everything binds to `127.0.0.1`. Nothing listens on the LAN.
  Reach it from your phone through Tailscale Serve, never by changing the bind.
- **Text Sundial reads that tries to give orders** (window titles, web pages,
  screen text, mail subjects, calendar invites). This is prompt injection, and it
  is only partly solved — see *Known limits*. What is in place: background jobs
  cannot write to your services or run commands; a web page Gnomon links on the
  board loads only when you click it; Gnomon's web tools cannot reach this Mac or
  your local network; under the default permission preset, every write Gnomon
  wants to make outside its own record, and every shell command, asks you first
  and shows its arguments. A background job cannot run a shell command at all.

**Out of scope:**

- Code already running as your user. It can read your files; so can Sundial's.
- A compromised LLM provider. Sanitized text you send to a provider is theirs to
  protect. Use a local model if that is not acceptable.
- Physical access to an unlocked Mac.

## What leaves the machine

Nothing, until you configure it. Then only:

| What | Where to | When |
|---|---|---|
| Sanitized text from your record: rollups of what you worked on, window titles, page excerpts, calendar titles | The model endpoint you set (`SUNDIAL_LLM_BASE_URL`, or a provider in `llm.providers`) | When Gnomon writes or answers. Point it at a local model (Ollama) and nothing leaves. Every call is listed in the Ledger. |
| What you type in the chat, and any image you attach, as you wrote it | The same endpoint | When you send a message. Only the record is cleaned at ingest; your own words are sent as they are. |
| Nothing else from the record | — | Embeddings are computed on this Mac; a remote embedding server is refused. |
| The embedding model weights (a download, no data sent) | Hugging Face | Once, the first time embeddings run |
| A notice's title and text (up to 1,200 characters), and titles of work Gnomon shelved | ntfy.sh (or the ntfy server you name) | Only if you configure `notifications.ntfy` |
| A request for the pull request of the branch you are on | GitHub, with your own `gh` login | Every 5 minutes, only if `gh` is installed and signed in and a repository is on a non-default branch |
| Tool calls to a service you connected | That service (for example your notes app's MCP server) | Only for services you list under `integrations` in `config.json` |
| Questions for the hosted judge | api.typesafe.ai | Only if you set `TYPESAFE_API_KEY` |
| Web searches and page reads | the search server and the site | When you ask, or when a background job researches something you have open (its brief asks for two searches and three pages at most). Every request is in the log as `web:search` / `web:fetch` |
| A request for the update feed (no data sent) | GitHub, this repository's releases | Once a day, only in the release app. A source install has no feed |
| A background job's prompt, and whatever Claude reads from your record over Sundial's read-only MCP server | Anthropic, through your own Claude Code login | Only if you set `hands.claude` in `config.json`. Every job is a row in the Ledger (purpose `hand`) |

If you connect Sundial to another agent over MCP (for example Claude Code), what
that agent reads from your record goes on to *its* model provider.

**Redaction happens once, at ingest.** Before anything is written to the log,
secret-looking strings (passwords, bearer tokens, GitHub/OpenAI/AWS/Slack keys,
JWTs) are removed, URL query strings are dropped, file paths lose your user name,
e-mail addresses become a name or an alias, and apps you mark sensitive or hidden
are cleared. Every later reader — the model, the MCP server, the page — reads the
already-cleaned value.

**No telemetry.** Sundial sends no usage data. The harness it runs on (dsh) has
an optional OpenTelemetry exporter; Sundial starts it with
`DSH_TELEMETRY_DISABLED=1`.

## macOS permissions

Each permission is granted to the **Sundial** app bundle, and you can refuse any of
them. The `/setup` page explains each one and shows its state.

| Permission | What it lets Sundial read |
|---|---|
| Accessibility | The front app and its window title |
| Input Monitoring | Counts of key presses and clicks per minute — never which keys |
| Calendars, Contacts | Event times, titles and attendee names |
| Screen Recording | Only for the optional screen-text reader (off by default) |
| Microphone, System Audio Recording | Only for optional hearing (off by default); audio is transcribed on the Mac and never written to disk |
| Full Disk Access | Only if you add it (off by default): Mail and Messages senders and subjects, and your Focus mode. Never message bodies |
| Notifications | Only if you turn banners on |
| Automation (browser) | The site and path of the front browser tab, never query strings. Private windows are skipped in Chrome, Brave, Edge and Vivaldi; Safari and Arc do not tell a private window apart, so their private tabs are read too |

The sidecars are ad-hoc signed. Rebuilding them changes their signature, so macOS
drops the grants and asks again.

## Known limits

- **Prompt injection is mitigated, not solved.** In a turn Gnomon opens itself
  (a notice), it cannot record a fact as your own words, and starting a job,
  setting a wake-up or filing an answer asks you first. Untrusted text can still
  steer what Gnomon writes as its own inference, which stays inside Sundial's
  record and can be overturned, but can be wrong.
- **Private windows** in Safari and Arc are read like any other (see the
  Automation row), and the window sensor records a private window's title.
- **Deleting a period** of the record has no command yet: `uninstall` deletes
  everything. Heard speech is pruned on `audio.retentionDays` when that is
  shorter than `retentionDays`.
- **A page read is a way out.** Gnomon reads web pages without asking, because a
  background job could not answer a prompt. Text that steers Gnomon could put
  something it read into the address of a page it fetches. Each fetch is in the
  log as `web:fetch`. To turn the web tools off, take `web-browser` out of
  `PLUGINS` in `bin/sundial` and run `sundial install` again.
- **DNS rebinding against Gnomon's web tools**: a public name that resolves to a
  private address is not caught by the fetch filter.
- **Person aliases** (`person-<hash>`) are an unsalted hash of an e-mail address
  and can be reversed with a list of candidate addresses.
- **Ad-hoc signing**: see above. A Developer ID signature is planned.

A full security, privacy and naming audit was done before v0; every finding above
is from it.
