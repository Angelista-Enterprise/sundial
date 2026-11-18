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
| Input activity | How many key presses, clicks, mouse moves and scrolls in each 10-second window, and the time of your last key press and click (so Gnomon never acts while your hands are on the keys) | On (Input Monitoring) |
| Notifications | The unread badge count on each Dock icon | On |
| Focus mode | Which Focus is on (Do Not Disturb, Work, and so on) | On |
| Microphone and camera | Whether they are in use and by which apps. No sound or image | On |
| Sleep and wake | When the Mac slept and woke | On |
| Calendar | Event titles, times, attendees, organizer, calendar name | On (Calendars; Contacts to put names to attendees) |
| Browser tab | Site and path of the front tab, and its title, in Chrome, Brave, Edge, Vivaldi, Arc and Safari | On (Automation, asked on first use) |
| Git | Branch, last commit subject, changed-file count, ahead/behind, commit sizes, in repositories Sundial finds | On |
| Files and functions | Which files change inside those projects (build and dependency folders ignored), and the function names touched, read from git diffs | On |
| Shell | Commands you run. With the shell hook: also folder, exit code and duration. Without it: read from your shell history file while a terminal is in front | On (hook is opt-in) |
| Coding agent | From your Claude Code sessions: the folder and branch; the state of each live session (working, waiting, tool, question, plan, failed), its title, cost and pull request, the last prompt (200 characters) and the last finished reply (400 characters). From the Claude Code hook, if installed: the event name, folder, tool name and the edited file's path, never the prompt, the message or a tool's input. From agent transcripts (Claude Code, Codex, Gemini, Copilot, Cursor): each prompt and reply as text, 2,000 characters each, with tool input and output and thinking left out. All text passes the same redaction as every other field | On; transcripts off with `privacy.agentTranscripts: false` |
| Pull requests | Every open pull request you authored on GitHub (one search), and the pull request of each local repository on a non-default branch: number, title, branches, size, state, review and check status. Read with your own `gh` login every 5 minutes | On if `gh` is installed and signed in; off with `sensors.githubPrs: false` |
| Network | A network fingerprint, gateway address, interface, and the Wi-Fi name when macOS reveals it | On |
| Power and audio devices | Battery or mains, charge level; names of connected headphones and speakers | On |
| Clipboard | Only the kind (link, code, text, file) and size of what you copied | Off: `clipboardEnabled` |
| Screen text | Text read off the focused window by on-device OCR | Off: `ocr.enabled` |
| Screen facts | Up to three short facts about the screen, from a vision model in your local Ollama | Off: `ocr.vision.enabled` |
| Page text | The visible text of the front browser tab | Off: `browser.pageText` (Chromium and Safari), `browser.pageTextAx` (Firefox-family browsers) |
| Screen look | When Gnomon looks at an app during a conversation: that window's controls, labels, field values and visible text, as a text list. Text inside pictures is read by Apple Vision on this Mac (needs Screen Recording). No screenshot is kept or sent. Never a private app (below), never a password field | On: `experiments.screenLook`. See [screen-acting.md](screen-acting.md) |
| Screen acts | Each step Gnomon took in another app (press, type, save), whether you allowed it, and what came of it. The values it typed are cleaned like any other text | Off until you allow outward actions. See [screen-acting.md](screen-acting.md) |
| Hearing | Transcripts of speech near the Mac and of the far side of a call (what the Mac plays), by a local Whisper server, while you press Listen | Off: `audio.enabled`. Calls open it by themselves only with `audio.autoMeetings`. Yes to hearing (in `install` or `node bin/sundial hearing`) sets only `audio.enabled`; a second question asks about calls, and its answer is no unless you type `y` (`--auto-meetings` says yes) |
| Hold to talk | What you say while you hold the summon key, transcribed by the same local Whisper server and sent as your chat message. The audio is not kept | On: `experiments.holdToTalk`; needs the local Whisper server (`node bin/sundial hearing`) |
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
- **Screenshots.** A look is text. Only if you set `experiments.windowCapture`
  (off) does the app keep a picture of a window that has no readable controls:
  the newest three, on this Mac, readable only by you, never sent.

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
  Slack, Discord, Mail, Zoom, FaceTime, Notes, Calendar, Reminders, password
  managers (Passwords, Keychain Access, 1Password, Bitwarden, KeePassXC,
  LastPass, Dashlane, Proton Pass, Enpass, Strongbox, Keeper, NordPass), the
  system password dialog and the lock screen, banking, Venmo, PayPal, Health
  and MyFitnessPal, the window title, URL, paths, screen text and other free
  text become `[private]`. The app name and the time stay. Add your own with
  `privacy.sensitiveApps`. Gnomon never looks at or acts in these apps
  ([screen-acting.md](screen-acting.md#private-apps)).
- **Web mail.** The page text of `outlook.office.com` and `mail.proton.me` is
  never kept. Add hosts with `privacy.privateHosts`.
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

**No telemetry.** The Sundial app sends no usage data, no crash reports and no
analytics. The harness it runs on (dsh) has an optional telemetry exporter;
both of Sundial's launchers (`start.sh` and `Sundial.app`) start it with
`DSH_TELEMETRY_DISABLED=1`. The public demo page on GitHub Pages is a separate
website, not the app: it counts named events with GoatCounter, never any text.

This is every network call Sundial makes. "Default" means a fresh install with
an empty `config.json` and no model.

### On a fresh install, before you configure anything

| What | Where to | When | How to stop it |
|---|---|---|---|
| A download of the embedding model `all-MiniLM-L6-v2` (about 90 MB). No text from your record is sent; the request shows your IP address | Hugging Face | Once, the first time a moment closes and is embedded, if you said yes when `install` asked (Enter is yes; without a terminal it is on), or on the setup page of the packaged release app, which downloads nothing until you answer. Retried after a failure | Answer no, install with `--no-embeddings`, turn off **Search model download** in Settings (What may leave this Mac; applies at once), or set `memory.embeddings: false`. Then nothing is downloaded and search matches words only. Embeddings themselves always run on this Mac |
| A search for every open pull request you authored, and `gh pr view` in each local repository on a non-default branch, with your own `gh` login | GitHub | Every 5 minutes | Only if `gh` is installed and signed in; `install` says so when it finds `gh`. Turn off **GitHub pull requests** in Settings (What may leave this Mac) and restart, set `sensors.githubPrs: false`, or sign `gh` out |
| Up to five lines from your record (project, open ticket, promises, last failure) added to each new Claude Code session | Anthropic, through your own Claude Code | Only when you start a Claude Code session, and only if you said yes when `install` asked to add this hook to `~/.claude/settings.json` (Enter is yes; without a terminal it is added) | `privacy.claudeContext: false`, `node bin/sundial claude-context --remove`, or install with `--no-claude-context` |
| A check of the update feed (no data from your record), then, only after you say Install, the update itself | GitHub, this repository's releases | Daily, only in the packaged release app, which asks before it installs an update. A source install (`bin/sundial install`) has no feed | Uncheck **Check for Updates Daily** in the Sundial menu. Skip This Version or Remind Me Later in the update window declines one update |
| Packages for the build | The npm registry | During `install` from source | Not needed after install |

### Only after you set something up or ask for it

| What | Where to | When |
|---|---|---|
| Sanitized text from the record, what you type in the chat, images you attach, and the text of any app window Gnomon looks at | The model endpoint you chose (`SUNDIAL_LLM_BASE_URL`, `llm.providers`) | When Gnomon writes or answers. A model on `127.0.0.1` keeps it all on this Mac. See [models.md](models.md) |
| The app and window title of a window you have stayed in for two minutes, the apps and titles before it (up to ten minutes back), and the last failed shell command, all as cleaned at ingest, with the question whether Gnomon can offer help there. Never a private app or private site | The same model endpoint | At most once every ten minutes, only with a model set. `experiments.offerNow: false` stops it |
| A request for the model list (your key, no record) | The same endpoint | When the model picker or **Check** on `/setup` asks |
| Each moment's judge questions (the fields listed below) | api.typesafe.ai | Only if `TYPESAFE_API_KEY` is set. Setting the key alone makes it the judge for every moment |
| A background job's prompt, and what Claude reads from the record over `sundial mcp` | Anthropic, through your own Claude Code login | Only if `llm.roles` names `claude` (the older `hands.claude` still reads) |
| Prompts and record reads | GitHub Copilot, through your own login | Only if `llm.roles` names `copilot` |
| Search words | Your own SearXNG (default `http://127.0.0.1:8888`), which then asks public search engines | When Gnomon searches the web |
| Page loads, in a headless Chrome that keeps its own cookies in `~/.sundial/.daemon/chrome-headless` | The site, and every third-party resource the page loads | When Gnomon reads a page. Addresses on this Mac and your local network are refused. After a private read, a call that could carry data out asks first ([screen-acting.md](screen-acting.md#data-leaving-after-a-private-read)) |
| Search words from your question, and the files they name | Wikimedia Commons, Poly Pizza, Smithsonian 3D, BodyParts3D | When Gnomon draws a figure in Atlas mode (a 3D model or an anatomical plate). Files are kept in `.daemon/nodus-assets/`. **Atlas libraries** off in Settings (What may leave this Mac; applies at once), or `atlas.libraries: false`, stops every search and fetch |
| A notice's title and text (up to 1,200 characters) | The ntfy URL you set | Only if `notifications.ntfy` is set |
| A poll for new phone events | The ntfy inbox URL you set | Only if `notifications.inbox` is set |
| Tool calls and their arguments | The service | Only for services you list under `integrations` |
| What an MCP client reads | That client's own model provider | Only if you connect Claude Code or another agent with `sundial mcp` |
| A download of the Kokoro voice (no data sent) | Hugging Face | Only if you set `voice.python` |
| A download of whisper-cpp and two speech models (about 575 MB) | Homebrew and Hugging Face | Only when you say yes to hearing |
| Whatever an app sends after Gnomon presses a button in it, an event Gnomon added to your calendar, a reminder | That app's or account's own servers | Only for actions you allowed ([screen-acting.md](screen-acting.md)) |

Audio is transcribed on this Mac by the Whisper server at `audio.whisperUrl`
(default `http://127.0.0.1:8771`). It must be on this Mac (`127.0.0.1`,
`localhost` or `[::1]`): `doctor`, and so `install`, refuse any other host, and
the config reader and the app's audio launcher both use the default instead.

**What the moment judge sees.** Each moment is scored by a judge: Jev at
api.typesafe.ai when `TYPESAFE_API_KEY` is set, otherwise your text model
(named on `/setup`; it is hosted unless it runs on this Mac). Both receive the
same fields, already cleaned: the app, project, window titles, shell commands,
branch, meeting title and attendee count, and, when their sensors are on,
`page_text` (the tab's own words), `mail_subjects_recent`, `screen_facts`,
`heard_aloud` (speech heard near the Mac), notes edited today, and your open
goals and heard promises.

## Who can reach the web client

The web client listens on `127.0.0.1:3080` only; nothing listens on your
network. Every route checks the `Host` header, the `Origin` and
`Sec-Fetch-Site`, and requires a signed session cookie. A web page on another
site cannot read your record or drive Gnomon. The cookie is created only by the
sign-in link that `node bin/sundial open` opens. That link is written to the
log inside the 0700 data folder, so other accounts on the Mac cannot read it.

Nothing listens for a phone's sensors. When `notifications.verdictUrl` is set, a loopback listener on
`127.0.0.1:8767` takes the signed verdicts the ntfy buttons post back; reach it
from the phone through Tailscale Serve, never a LAN bind.

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

In `$SUNDIAL_HOME/config.json` unless marked `.env`. Restart after a change, except `memory.embeddings` and `atlas.libraries`, which apply at once. Settings has a switch for those two and `sensors.githubPrs`, under What may leave this Mac.

| Setting | Default | What it does |
|---|---|---|
| `privacy.redactionTier` | `2` | How hard paths and URLs are rewritten (above) |
| `privacy.sensitiveApps` | `[]` | More apps whose content becomes `[private]` |
| `privacy.hiddenApps` | `[]` | Apps whose name and content become `[hidden]` |
| `privacy.shellRedactPatterns` | `[]` | More secret patterns (regular expressions) |
| `privacy.messages` | `false` | Messages senders and chats |
| `browser.pageText` | `false` | Text of the front browser tab |
| `ocr.enabled` | `false` | Screen text |
| `ocr.vision.enabled` | `false` | Screen facts from a local vision model (needs `ocr.enabled`) |
| `ocr.retentionDays` | `14` | Days screen text is kept |
| `audio.enabled` | `false` | Hearing, while you press Listen |
| `audio.autoMeetings` | `false` | Calls (another app using the microphone) open hearing by themselves. Nobody else in the call is told. Its own question, never implied by yes to hearing |
| `audio.retentionDays` | `14` | Days heard speech is kept |
| `clipboardEnabled` | `false` | Clipboard kind and size |
| `browser.pageTextAx` | `false` | Page text of Firefox-family browsers, over Accessibility |
| `experiments.screenLook` | `true` | Gnomon may read an app window's text when it looks |
| `experiments.offerNow` | `true` | A window you stay in asks your model once whether to offer help |
| `privacy.claudeContext` | `true` | Five lines of context at the start of each Claude Code session |
| `memory.embeddings` | `true`, or your answer to `install` or `/setup` (the packaged app writes `"ask"` until then) | The search model download from Hugging Face. `false` or `"ask"`: never downloaded, search matches words |
| `sensors.githubPrs` | `true` | The pull request check through your `gh` login. `false`: no `gh` call |
| `atlas.libraries` | `true` | Atlas mode's searches and downloads from Wikimedia Commons, Poly Pizza, Smithsonian 3D and BodyParts3D. `false`: none, so Atlas finds nothing to draw |
| `vault` | unset | The Obsidian vault to watch |
| `retentionDays` | `180` | Days everything else is kept |
| `notifications.enabled` | `false` | macOS banners for notices |
| `notifications.ntfy` | unset | Push notices to an ntfy URL |
| `TYPESAFE_API_KEY` (`.env`) | unset | The hosted judge |

`node bin/sundial install --no-sidecars` installs without the macOS helpers,
so none of the permission-gated sensors run.
