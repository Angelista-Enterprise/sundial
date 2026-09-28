# Getting started

This page takes you from a clean Mac to a running Sundial: what you need, how to
install it, how to sign in, and what to do on the setup page. It also lists the
day-to-day commands and where your data lives.

Sundial is the software: it records what you work on and keeps that record on
your Mac. Gnomon is the assistant inside Sundial that reads the record and talks
to you.

## What you need

- A Mac. Sundial runs on macOS only, because its sensors are native Swift programs.
- Node.js 22 or newer (`brew install node`, or <https://nodejs.org>).
- pnpm (`brew install pnpm`, or `npm install -g pnpm`).
- The Xcode Command Line Tools, which bring `swiftc` and `git`
  (`xcode-select --install`).
- `sqlite3`, which ships with macOS.
- Optional: a model for Gnomon, for example [Ollama](https://ollama.com) on the
  same Mac. See [models.md](models.md).

To check all of this without installing anything, clone the repository (next
section) and run:

```bash
node bin/sundial doctor
```

Each line says `ok` or `!!`, with the fix under every `!!`.

## Install

Clone the repository and run the installer from its folder:

```bash
git clone https://github.com/Angelista-Enterprise/sundial.git
```

```bash
cd sundial
```

```bash
node bin/sundial install
```

The installer prints seven steps:

1. **Checking what this Mac needs.** The same checks as `doctor`. It stops if one fails.
2. **Claiming the data folder.** It creates `~/.sundial` (private to your user)
   and writes a marker file in it. It refuses a folder that already holds files
   it did not make.
3. **Installing dependencies and building.** `pnpm install` and the TypeScript
   build. This takes a few minutes the first time.
4. **Building the macOS sensors.** It compiles the Swift helpers and puts them in
   `/Applications/Sundial.app`, signed on this Mac. See [permissions.md](permissions.md)
   for why the signature matters.
5. **Writing config, the web profile and the start script.** An empty
   `config.json`, a `.env` file for model settings, the shell hook, and
   `start.sh`. It never overwrites a `config.json` or `.env` that already exists.
6. **Starting the Sundial app.** `/Applications/Sundial.app` starts, shows a sun
   in the menu bar, and adds itself to **Login Items** so it starts when you log
   in. An older install's LaunchAgent (`dev.sundial.agent`) is removed.
7. **Waiting for http://127.0.0.1:3080.** It waits up to two minutes for the
   web client to answer.

At the end it prints the shell hook line, offers to add Sundial to Claude Code,
and opens your browser.

### Install options

| Option | What it does |
|---|---|
| `--no-open` | Do not open the browser at the end. |
| `--no-sidecars` | Build the Swift helpers but never start them. No permission prompt appears, and no window, input, calendar or browser data is recorded. |
| `--no-launchagent` | Stop after step 5 and start nothing. You start Sundial by hand from Applications, or with `open /Applications/Sundial.app`. |
| `--no-app` | Run Sundial from a LaunchAgent instead of the app, as before. Full Disk Access does not reach it then. |
| `--no-login-item` | Do not add the app to Login Items. |
| `--no-mcp` | Do not ask about Claude Code; print the command instead. |
| `--skip-build` | Skip steps 3 and 4. Only useful when you already built this checkout. |
| `--timeout <seconds>` | How long step 7 waits (default 120). |

For example:

```bash
node bin/sundial install --no-open
```

## Sign in

The web client runs at <http://127.0.0.1:3080> and answers only your own browser.
Every page needs a session cookie. To get one, run:

```bash
node bin/sundial open
```

It opens a sign-in link in your default browser. The link gives that
browser its cookie and then shows the setup page. Run `open` again for a
different browser, or whenever a page says 401.

There is no global `sundial` command. From the repository folder, every command
is `node bin/sundial <command>` (or `./bin/sundial <command>`). If you want to type `sundial` instead, add an
alias. Run this once from the repository folder:

```bash
echo "alias sundial='node $PWD/bin/sundial'" >> ~/.zshrc
```

Open a new terminal window for the alias to work.

## The setup page

The first time a browser opens Sundial, it goes to `/setup`. You can come back
to <http://127.0.0.1:3080/setup> at any time. Nothing on it is needed to start.

**The record.** How many observations Sundial has recorded so far. The first
ones arrive within a minute of the sensors starting.

**What macOS lets it see.** One row per permission, with its live state
(Granted, Not granted, Off, or Waiting for the sensor) and an **Open settings**
link. The page shows the path to add (`/Applications/Sundial.app`) with a Copy
button. After you grant something, restart Sundial:

```bash
node bin/sundial restart
```

Every permission is explained in [permissions.md](permissions.md).

**Start with your history.** A new record is empty. Sundial can read what
already happened on this Mac, once, when you ask:

- **Folders with your code**, one per line. It looks up to three folders deep
  for git repositories and reads only commits made with that repository's git
  e-mail. It suggests folders such as `~/Projects` or `~/code` if they exist.
- **Commits from the last N days** (default 30) and **meetings from the last N
  days** (default 7), up to 90 each. Meetings need the Calendar permission.
- **Find** only counts. It lists the repositories and how many commits and
  meetings it would read, and writes nothing.
- **Read** writes them into the record at the time they really happened.
  Running it again adds only what is new.

**A model for Gnomon.** Without a model, Sundial still records and the Today
screen still shows your day. Gnomon's chat and its written summaries need one.

## Add a model

On the setup page, press **Choose a model**. Pick a preset (Ollama on this Mac,
OpenAI, OpenRouter, DeepSeek) or **Other** for any OpenAI-compatible address.
Paste an API key if the provider needs one, press **Check** to list its models,
pick one, and press **Use this model**. Then press **Restart Sundial**.

The key is written to `~/.sundial/.env` and is never shown again. A model on
this Mac needs no key, and nothing leaves the Mac. Under **More providers** you
can add others and choose between them per conversation in the chat's model
picker. Details, and how to set it by editing `.env`: [models.md](models.md).

## Shell history (optional)

Sundial can record the commands you run, with their folder, exit code and
duration. The installer writes a hook for this and prints a line like the one
below. Add it to `~/.zshrc` (or `~/.bashrc`):

```bash
[ -f "$HOME/.sundial/shell-hook.zsh" ] && source "$HOME/.sundial/shell-hook.zsh"
```

The hook appends one line per command to a file in `~/.sundial/.daemon/`.
Without it, Sundial falls back to your shell history file, which has no folder,
exit code or duration.

## Use Sundial from Claude Code (optional)

Sundial has an MCP server. MCP (Model Context Protocol) lets an agent such as
Claude Code call tools. Sundial's tools only read your record; none of them
write.

If the `claude` command is installed, `install` asks at the end whether to add
Sundial (y/N). It changes your Claude Code settings only when you answer `y`.
To add it yourself later, run this from the repository folder:

```bash
claude mcp add sundial --scope user -e SUNDIAL_HOME="$HOME/.sundial" -- "$(command -v node)" "$PWD/packages/mcp/bin/sundial-mcp.js"
```

Restart Claude Code afterwards. `node bin/sundial mcp` runs the same server by
hand, over stdio.

## Everyday commands

| Command | What it does |
|---|---|
| `node bin/sundial status` | What is installed and running: the data folder, the app, the web client, the database, and each sensor file. |
| `node bin/sundial doctor` | Check the prerequisites only. |
| `node bin/sundial open` | Sign this browser in and open Sundial. |
| `node bin/sundial start` | Start the app. |
| `node bin/sundial stop` | Quit the app, with its sensor helpers. It starts again at your next login. The menu bar's **Quit Sundial** does the same. |
| `node bin/sundial restart` | Restart the web process and the sensor helpers. |
| `node bin/sundial uninstall` | Show what would be removed. Add `--yes` to remove it. |

After you pull new code, run `node bin/sundial install` again. It keeps your
data, `config.json` and `.env`.

To remove Sundial, see [Uninstall cleanly](troubleshooting.md#uninstall-cleanly).

## Where your data lives

Everything Sundial writes goes into one folder, `$SUNDIAL_HOME`, which defaults
to `~/.sundial`. It is readable only by your user.

| Path | What it is |
|---|---|
| `sundial.db` | The record: one SQLite file. |
| `config.json` | Your settings. Every field is optional; see [../config.example.json](../config.example.json). |
| `.env` | Model addresses and API keys. |
| `logs/` | `sundial.log` and `sidecars.log`. |
| `.daemon/` | Small files the sensor helpers write and Sundial reads. |
| `Sundial.app`, `SundialBrowserHelper.app` | The app (menu bar, window, the helpers it runs) and the browser helper. |
| `app.env` | What the app runs: paths and ports, written by install. |
| `dsh/` | Settings and conversations of dsh, the agent host Sundial runs on. |
| `start.sh`, `shell-hook.zsh` | What a LaunchAgent install (`--no-app`) runs, and the shell hook. |

To use another folder or port, set `SUNDIAL_HOME` or `SUNDIAL_WEB_PORT` for the
install. Later commands need only `SUNDIAL_HOME`: the install remembers its
label and ports.

## Coming from the old name

Early users ran this software under an older name, with data in `~/.gnomon`.
`node bin/sundial migrate` copies that install into `~/.sundial` (it never moves
or changes the old folder); then run `install`.

## Next

Read [permissions.md](permissions.md) to decide what Sundial may see,
[using-gnomon.md](using-gnomon.md) to start talking to Gnomon, and
[troubleshooting.md](troubleshooting.md) when something does not work.
