# Privacy

Sundial records what you do on your Mac. This page lists what it records, where
the record lives, what is cleaned before anything is written, what can leave
the machine, and how to stop recording or delete it. For the threat model and
how to report a problem, see [SECURITY.md](../SECURITY.md).

## Where the record lives

Everything Sundial writes goes into one folder, `$SUNDIAL_HOME` (by default
`~/.sundial`). The installer creates it with mode 0700, and every Sundial
process runs under `umask 077`, so new files are readable only by you.

| What | Where |
|---|---|
| The event log, moments, people and projects, facts, embeddings, the model-call log | `sundial.db` (SQLite) |
| Model addresses and API keys | `.env` (0600) |
| Your settings | `config.json` (0600) |
| Current status files from the macOS helpers (front window, input counts, screen text when on) | `.daemon/` |
| Conversations with Gnomon | `dsh/` |
| Logs, including the one-time sign-in link | `logs/` |

Set `SUNDIAL_HOME` before `node bin/sundial install` to put the folder
somewhere else.

## What each sensor records

A sensor is one small reader that turns something on your Mac into events.
Several need a macOS permission; the `/setup` page shows each one and its
state. "On" means on once the permission it needs is granted. See
[permissions.md](permissions.md).

| Sensor | What it records | Default |
|---|---|---|
| Front window | App name, window title, and the open document's path when an editor exposes it | On (Accessibility) |
| Input activity | How many key presses, clicks, mouse moves and scrolls in each 10-second window | On (Input Monitoring) |
| Notifications | The unread badge count on each Dock icon | On |
| Focus mode | Which Focus is on (Do Not Disturb, Work, and so on) | On |
| Microphone and camera | Whether they are in use and by which apps. No sound or image | On |
| Sleep and wake | When the Mac slept and woke | On |
| Calendar | Event titles, times, attendees, organizer, calendar name | On (Calendars; Contacts to put names to attendees) |
| Browser tab | Site and path of the front tab, and its title, in Chrome, Brave, Edge, Vivaldi, Arc and Safari | On (Automation, asked on first use) |
| Git | Branch, last commit subject, changed-file count, ahead/behind, commit sizes, in repositories Sundial finds | On |
| Files and functions | Which files change inside those projects (build and dependency folders ignored), and the function names touched, read from git diffs | On |
| Shell | Commands you run. With the shell hook: also folder, exit code and duration. Without it: read from your shell history file while a terminal is in front | On (hook is opt-in) |
| Coding agent | The folder and branch of your Claude Code sessions. Only those two fields are read from its session files | On |
| Pull requests | For a repository on a non-default branch: PR number, title, state, review and check status, via `gh pr view` every 5 minutes | On if `gh` is installed and signed in |
| Network | A network fingerprint, gateway address, interface, and the Wi-Fi name when macOS reveals it | On |
| Power and audio devices | Battery or mains, charge level; names of connected headphones and speakers | On |
| Clipboard | Only the kind (link, code, text, file) and size of what you copied | Off: `clipboardEnabled` |
| Screen text | Text read off the focused window by on-device OCR | Off: `ocr.enabled` |
| Screen facts | Up to three short facts about the screen, from a vision model in your local Ollama | Off: `ocr.vision.enabled` |
| Page text | The visible text of the front browser tab | Off: `browser.pageText` |
| Mail | Sender, recipients and subject | Off: `privacy.mail` (and Full Disk Access) |
| Messages | Sender, chat name and time, never the text | Off: `privacy.messages` (and Full Disk Access) |
| Hearing | Transcripts of speech near the Mac and of the far side of a call (what the Mac plays), by a local Whisper server, while you press Listen | Off: `audio.enabled`; meetings and calls open it by themselves only with `audio.autoMeetings` |
| Devices nearby | A hashed id per device in the Mac's ARP table, on a network you consented to | Off: `experiments.presence` |
| Obsidian vault | Paths of notes that changed in the one vault you name | Off: `vault` |
| Gnomon's own web use | Each page Gnomon fetched or search it ran, and whether it worked | When Gnomon uses the web |

The shell hook is a line you add to `~/.zshrc` yourself; `install` prints it.

## What is not recorded

- **Which keys you press.** Input activity is counts only.
- **Notification contents.** Only badge numbers.
- **Clipboard contents.** Only kind and size, and only if you turn it on.
- **URL query strings.** The browser helper writes the site and path only.
- **Private browser windows in Chrome, Brave, Edge and Vivaldi.** The browser
  helper skips them. It cannot tell a private window in Safari or Arc, and the
  front-window sensor still sees the title of any window in front.
- **Page text, mail, screen text, sound.** Each stays off until you turn it on
  (table above). Mail message bodies and Messages text are never read. Audio
  from hearing is never written to disk; only the transcript is. The
  microphone helper is only started when `audio.enabled` is on.
- **Device hardware addresses.** Devices nearby are hashed before they are
  written.

## Cleaned once, when recorded

Every event goes through one cleaning pass before it is written. Everything
that reads the record later (the model, the MCP server, the web client) reads
the cleaned value.

- **Secrets.** Strings that look like `password=…`, `token=…`, `api key: …`,
  `Bearer …`, `--password …`, an `Authorization:` header, `curl -u user:pass`,
  and GitHub, OpenAI (`sk-…`), AWS (`AKIA…`), Slack (`xox…`) and JWT tokens
  become `[REDACTED]`. This covers commands, titles, commit lines, page text,
  mail subjects, screen text and heard speech.
- **Personal data in that same text.** E-mail addresses become `[email]`, phone
  numbers `[phone]`, card numbers `[card]`, IBANs `[iban]`, a BSN next to the
  word "BSN" `[bsn]`, private-key blocks `[private-key]`, and the user name and
  password in `scheme://user:pass@host` become `[credentials]`. Card numbers,
  IBANs and BSNs are only removed when their checksum is valid, so an order
  number or a row id stays.
- **URLs.** Query strings and fragments are dropped; a user name and password
  in a git remote are removed.
- **Paths.** `/Users/<you>/…` becomes `~/…`.
- **E-mail addresses** in attendees, organizers, senders and recipients become a
  name taken from the address, or an alias like `person-1a2b3c4d5e`. A phone
  number sender becomes `phone`.
- **Sensitive apps.** For WhatsApp, Messages, Telegram, Signal, Messenger,
  Slack, Discord, Mail, Zoom, FaceTime, password managers (Passwords, Keychain
  Access, 1Password, Bitwarden, KeePassXC, LastPass, Dashlane), the system
  password dialog and the lock screen, banking, Venmo, PayPal, Health and
  MyFitnessPal, the window title, URL, paths, screen text and other free text
  become `[private]`. The app name and the time stay. Add your own with
  `privacy.sensitiveApps`.
- **Hidden apps.** For apps in `privacy.hiddenApps`, the app name and every
  title, text, path and URL become `[hidden]`. The time is still counted.
- **Screen text is not read at all** from a sensitive or hidden app, or while
  any password field has the keyboard (macOS secure input). Screen text from an
  app on the strict list is deleted at the next daily prune, whatever its age.

App names are matched case-insensitively against part of the process name, so
`bank` matches any app with "bank" in its name. Screen text is matched on the
app's bundle id as well, which does not change with the system language. The lists in `config.json` only
add to the built-in ones; they cannot remove anything.

`privacy.redactionTier` sets how hard paths and URLs are rewritten:

| Tier | Paths and URLs | Sensitive apps |
|---|---|---|
| 1 | Passed through whole, query strings included | Only password managers, finance, health, plus yours |
| 2 (default) | `~` for your home folder; query strings dropped | The full list above |
| 3 | URLs cut to the site; deep paths shortened | The full list, plus apps whose names look sensitive (bank, wallet, password, medical, dating, tax and similar), remembered from then on |

Secret patterns apply at every tier. The Trust tab of the Engine room card
shows what was scrubbed in the last 24 hours.

## How long it is kept

Once a day, at the day boundary, Sundial deletes events, moments and
model-call rows older than `retentionDays` (default 180). Screen text and
screen facts go sooner, after `ocr.retentionDays` (default 14). Heard speech
goes after `audio.retentionDays` (default 14).

Some things are kept until you remove them: people, projects and facts in
memory, the journal and other written entries, and your conversations.

## What can leave your Mac

Nothing, until you configure it. Then only:

| What | Where to | When |
|---|---|---|
| Sanitized text from the record, plus what you type in the chat and images you attach | The model endpoint you chose | When Gnomon writes or answers. A model on `127.0.0.1` keeps it all local. See [models.md](models.md) |
| The embedding model's weights (a download; no text is sent) | Hugging Face | Once, the first time embeddings run |
| A notice's title and text, and titles of finished work | The ntfy URL you set | Only if `notifications.ntfy` is set |
| A `gh pr view` request, with your own `gh` login | GitHub | Only if `gh` is installed and signed in, for repositories on a non-default branch |
| Web pages Gnomon fetches | The site | When Gnomon fetches a page. Web search goes to your own SearXNG on `127.0.0.1` |
| Internal scoring questions | api.typesafe.ai | Only if `TYPESAFE_API_KEY` is set |
| Tool calls to your own services | The service | Only for services you list under `integrations` in `config.json` |
| A background job's prompt, and what Claude reads from the record over `sundial mcp` | Anthropic, through your own Claude Code login | Only if `hands.claude` is set in `config.json` |
| Whatever an MCP client reads | That client's own model provider | Only if you connect Claude Code or another agent with `sundial mcp` (see [using-gnomon.md](using-gnomon.md)) |

**What the moment judge sees.** Each moment is scored by a judge: Jev at
api.typesafe.ai when `TYPESAFE_API_KEY` is set, otherwise your text model
(named on `/setup`; it is hosted unless it runs on this Mac). Both receive the
same fields, already cleaned: the app, project, window titles, shell commands,
branch, meeting title and attendee count, and, when their sensors are on,
`page_text` (the tab's own words), `mail_subjects_recent`, `screen_facts`,
`heard_aloud` (speech heard near the Mac), notes edited today, and your open
goals and heard promises.

Sundial sends no usage data. The harness it runs on (dsh) has an optional
telemetry exporter, and Sundial starts it with `DSH_TELEMETRY_DISABLED=1`.

## Who can reach the web client

The web client listens on `127.0.0.1:3080` only; nothing listens on your
network. Every route checks the `Host` header, the `Origin` and
`Sec-Fetch-Site`, and requires a signed session cookie. A web page on another
site cannot read your record or drive Gnomon. The cookie is created only by the
sign-in link that `node bin/sundial open` opens. That link is written to the
log inside the 0700 data folder, so other accounts on the Mac cannot read it.

The phone ingest listener (`127.0.0.1:8767`) is off unless you set
`SUNDIAL_PHONE_INGEST=1` in `.env`. It requires the token in
`$SUNDIAL_HOME/.daemon/api-token`. To reach Sundial from your phone, use
Tailscale Serve rather than changing the bind address.

## See what was recorded

- **The day** card: what Gnomon saw, the apps, commands and moments.
- **Explore**: search the record and your conversations; *Said* shows what was
  heard.
- **Engine room**: *Trust* shows which sensors report and what was scrubbed;
  *Cost* (the Ledger) lists every model call.
- The database itself, read-only:

```bash
sqlite3 -readonly ~/.sundial/sundial.db "select signal_type, event_type, count(*) from signals group by 1, 2 order by 3 desc;"
```

`node bin/sundial status` also prints how many events there are and when the
last one arrived.

## Stop, delete, uninstall

**Stop recording for now:**

```bash
node bin/sundial stop
```

This stops the process that writes the database and the macOS helpers, so
nothing new is recorded. If you added the shell hook, it keeps appending commands to
`.daemon/shell-events.jsonl` until you remove the line from `~/.zshrc`.
`node bin/sundial start` starts everything again.

**Turn one sensor off:** revoke its permission in System Settings → Privacy &
Security, or flip its switch below, then run `node bin/sundial restart`.

**Delete pieces:**

- A fact: open the person or project, and press **Wrong** next to the fact.
- A conversation: in the chat card's thread list, **Select**, then **Delete**.
- Older history: lower `retentionDays`, restart, and the next daily pass
  deletes everything older.

There is no command yet that deletes a chosen date range.

**Remove everything:**

```bash
node bin/sundial uninstall
```

This is a dry run that lists what would go. Add `--yes` to delete
`$SUNDIAL_HOME` and the LaunchAgent. It refuses a folder that lacks the
installer's marker file. Then clear the macOS permission grants, remove the
shell hook line from `~/.zshrc` if you added it, and remove the Claude Code
entry if you added one:

```bash
tccutil reset All dev.sundial.daemon
```

```bash
claude mcp remove --scope user sundial
```

## The switches

In `$SUNDIAL_HOME/config.json` unless marked `.env`. Restart after a change.

| Setting | Default | What it does |
|---|---|---|
| `privacy.redactionTier` | `2` | How hard paths and URLs are rewritten (above) |
| `privacy.sensitiveApps` | `[]` | More apps whose content becomes `[private]` |
| `privacy.hiddenApps` | `[]` | Apps whose name and content become `[hidden]` |
| `privacy.shellRedactPatterns` | `[]` | More secret patterns (regular expressions) |
| `privacy.mail` | `false` | Mail senders, recipients and subjects |
| `privacy.messages` | `false` | Messages senders and chats |
| `browser.pageText` | `false` | Text of the front browser tab |
| `ocr.enabled` | `false` | Screen text |
| `ocr.vision.enabled` | `false` | Screen facts from a local vision model (needs `ocr.enabled`) |
| `ocr.retentionDays` | `14` | Days screen text is kept |
| `audio.enabled` | `false` | Hearing, while you press Listen |
| `audio.autoMeetings` | `false` | Meetings with attendees and calls open the microphone by themselves. Nobody else in the meeting is told |
| `audio.retentionDays` | `14` | Days heard speech is kept |
| `clipboardEnabled` | `false` | Clipboard kind and size |
| `experiments.presence` | `false` | Devices nearby |
| `vault` | unset | The Obsidian vault to watch |
| `retentionDays` | `180` | Days everything else is kept |
| `notifications.enabled` | `false` | macOS banners for notices |
| `notifications.ntfy` | unset | Push notices to an ntfy URL |
| `SUNDIAL_PHONE_INGEST` (`.env`) | unset | The phone listener |
| `TYPESAFE_API_KEY` (`.env`) | unset | The hosted judge |

`node bin/sundial install --no-sidecars` installs without the macOS helpers,
so none of the permission-gated sensors run.
