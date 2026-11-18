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

## An agent that can click

Gnomon can press and type in your other apps through macOS Accessibility, once
you allow outward actions (off on a new install). The controls, in full in
[docs/screen-acting.md](docs/screen-acting.md):

- **Every screen step asks**, under Ask and Auto alike. Only when you set
  outward actions to Auto, a plain step (not typing, not a final) stops asking in
  one app after ten yeses in a row there (`actions.earnAfter`).
- **A final step always asks**, in every mode: send, pay, submit, delete,
  discard, post, update, overwrite, archive, leave, block, share, transfer,
  merge, approve or decline, and a Return on something no look can name. A
  blind final, a final with no app named, and a final with nobody to ask are
  refused. After a no, the same final is refused for the rest of the turn.
- **Private apps are never looked at or touched**: messaging, mail, Slack,
  Notes, Calendar, password managers, banking, health, and any you add. Nor
  System Settings, password fields, sign-in windows or secure input.
- **Your hands win.** A step waits while you type, and is refused if you keep
  typing.
- **Data leaving after a private read asks first**: a web call or shell call
  that carries something that looks like data, or goes to an unknown host.
- **Always refused**: inline scripts that hold an address, destructive shell
  commands, writing to Sundial's database from the shell, and any outward step
  in a background job.

## Threat model

**In scope. Sundial defends against:**

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
  is only partly solved; see *Known limits*. What is in place: background jobs
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

The full list of network calls, with what is sent, when, and the switch for
each, is in [docs/privacy.md](docs/privacy.md#what-can-leave-your-mac). In short:

- **With nothing configured:** a one-time download of the embedding model from
  Hugging Face (no data sent); a search of your open pull requests through your
  own `gh` login every five minutes, if `gh` is signed in; five lines of context
  added to each new Claude Code session, if you use Claude Code; and, in the
  packaged release app only, a daily update check that installs updates.
- **Once you set a model:** sanitized text from the record, what you type, and
  the text of any window Gnomon looks at go to that endpoint. A model on
  `127.0.0.1` keeps all of it on the Mac.
- **When you ask for it:** web searches and page reads, ntfy pushes, connected
  services, Claude Code or Copilot as a model, the hosted judge.

If you connect Sundial to another agent over MCP (for example Claude Code), what
that agent reads from your record goes on to *its* model provider.

**Redaction happens once, at ingest.** Before anything is written to the log,
secret-looking strings (passwords, bearer tokens, GitHub/OpenAI/AWS/Slack keys,
JWTs) are removed, URL query strings are dropped, file paths lose your user name,
e-mail addresses become a name or an alias, and apps you mark sensitive or hidden
are cleared. Every later reader (the model, the MCP server, the page) reads the
already-cleaned value.

**No telemetry.** The Sundial app sends no usage data, crash reports or
analytics. The harness it runs on (dsh) has an optional OpenTelemetry exporter
that would upload a conversation when you give feedback; both of Sundial's
launchers start it with `DSH_TELEMETRY_DISABLED=1`. The public demo web page
counts named events with GoatCounter, never text.

## macOS permissions

Each permission is granted to the **Sundial** app bundle, and you can refuse any of
them. The `/setup` page explains each one and shows its state.

| Permission | What it lets Sundial read |
|---|---|
| Accessibility | The front app and its window title; for Gnomon, an app's controls, and pressing and typing in them once you allow outward actions |
| Input Monitoring | Counts of key presses and clicks, and the time of the last one, never which keys |
| Calendars, Contacts | Event times, titles and attendee names |
| Screen Recording | Text inside pictures when Gnomon looks at a window, and the optional screen-text reader (off by default). Read on the Mac |
| Microphone, System Audio Recording | Hold to talk, and optional hearing (off by default); audio is transcribed on the Mac and never written to disk |
| Full Disk Access | Only if you add it (off by default): Messages senders and chats, and your Focus mode. Never message text |
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
- **No sandbox for screen acting.** Gnomon acts in your real apps, as you. The
  confirm is a gate, not isolation.
- **Final steps are recognised by control names in seven languages** (English,
  Dutch, German, French, Spanish, Portuguese, Italian) and by keys. A button in
  another language asks as an ordinary step, not as a final, and a button
  Gnomon has no word for never stops asking.
- **The text of a window Gnomon looks at goes to your chat model**, after the
  same cleaning as the record. Use a local model if that is not acceptable.
- **Embedding model download and pull request checks** happen by default.
  `install` asks about the first, and Settings has a switch for both, under
  What may leave this Mac (see [docs/privacy.md](docs/privacy.md)).

A full security, privacy and naming audit was done before v0; the findings
above started from it and are kept current with each release.
