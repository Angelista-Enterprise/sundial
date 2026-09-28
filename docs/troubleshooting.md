# Troubleshooting

When something does not work, find the symptom below. Each entry gives the
likely cause and the fix. Run every command from the repository folder.

## First, look

Two commands tell you most of what is wrong:

```bash
node bin/sundial doctor
```

```bash
node bin/sundial status
```

`doctor` checks the prerequisites (macOS, Node.js 22 or newer, pnpm, the Xcode
Command Line Tools, sqlite3). `status` shows:

- `home`: the data folder, and when it was installed.
- `app`: whether `Sundial.app` is running (`agent` for a `--no-app` install:
  whether the LaunchAgent `dev.sundial.agent` is loaded).
- `web`: the HTTP status of <http://127.0.0.1:3080>. **401 is normal here**:
  Sundial is up, and the check itself is not signed in. "no answer" means the
  web process is not running.
- `database`: how many observations there are, and when the last one came in.
- `launcher` and one line per sensor file: `ok`, `STALE` (the helper stopped
  writing), `MISSING` (it never wrote), or `absent` for sensors that are off or
  write only when something happens.

## Where the logs are

- `~/.sundial/logs/sundial.log`: the web process.
- `~/.sundial/logs/sidecars.log`: starting and stopping the Swift helpers.

```bash
tail -n 50 ~/.sundial/logs/sundial.log
```

`sundial.log` also holds the sign-in link. Remove any line with `token=` before
you share the log with anyone.

## The page says 401

**Cause:** this browser has no session cookie. That happens in a new browser,
or after you clear its cookies.

**Fix:** sign in again. It opens the sign-in link in your default browser.

```bash
node bin/sundial open
```

If `open` says there is no sign-in URL yet, Sundial is not running. Check
`status` and `sundial.log`.

## Nothing answers on port 3080, or port 3080 is in use

**Cause:** another program listens on 3080, so Sundial's web process cannot
start. See who holds it:

```bash
lsof -nP -iTCP:3080 -sTCP:LISTEN
```

**Fix:** stop that program, then restart Sundial. Or install Sundial on
another port. The install remembers it, so later commands such as `open` and
`status` find it without the variable:

```bash
SUNDIAL_WEB_PORT=3090 node bin/sundial install
```

## A permission says "Not granted" after you granted it

Work down this list and check `/setup` after each step.

1. **Restart.** macOS applies a new grant only to a freshly started helper.

   ```bash
   node bin/sundial restart
   ```

2. **Remove and re-add the entry.** In System Settings → Privacy & Security,
   select Sundial, click **−**, then add `/Applications/Sundial.app` again with
   **+** and **⌘⇧G**, and restart. This is the usual fix after a rebuild:
   the helpers are signed on your Mac, so a rebuilt helper is a new program to
   macOS and the old entry no longer applies.
3. **Reset and grant again.** Clear the service, restart, and grant it fresh.

   ```bash
   tccutil reset Accessibility dev.sundial.daemon
   ```

For Screen Recording, Calendars, Contacts, Microphone and Automation, the helper
asks for itself; a hand-added entry does not count. Reset the service and
accept the prompt when it appears. "Waiting for the sensor" means the helper has
not written its file yet; check the sensor lines in `status`.

Details for every permission: [permissions.md](permissions.md).

## App names show, but window titles are missing

**Cause:** the window helper reads the app in front without any permission,
but it needs Accessibility for the window title.

**Fix:** grant Accessibility to Sundial and restart. If it already shows as
granted, remove the entry and add it again (step 2 above).

## Nothing from the Mac is recorded at all

**Cause:** the Swift helpers are not running. `status` shows `launcher: not
running`, or every sensor line says `MISSING`. An install with `--no-sidecars`
never starts them.

**Fix:** restart, then read `sidecars.log`.

```bash
node bin/sundial restart
```

Do not start `Sundial.app` with `open -a` or from Finder; see
[permissions.md](permissions.md#never-start-sundialapp-with-open--a).

## Gnomon does not answer in the chat

**Cause:** no model is set yet. Sundial still records, and Today still shows
your day, but the chat and the written summaries need a model.

**Fix:** open <http://127.0.0.1:3080/setup>, choose a model under "A model for
Gnomon", and press **Restart Sundial**. See [models.md](models.md).

## Install fails

The installer stops at the step that failed and prints the command that failed.

- **Step 1:** fix each line marked `!!`, then run `install` again.
- **Step 2, "exists, is not empty, and was not made by this installer":**
  `~/.sundial` holds files from something else. Move that folder away, or
  install into another one with `SUNDIAL_HOME`.
- **Step 3:** `pnpm install` or the TypeScript build failed. The error is just
  above the `failed (exit …)` line.
- **Step 4, the Swift build:** usually the Command Line Tools are missing or
  out of date. Run `xcode-select --install`, or update them in System Settings →
  General → Software Update.
- **Step 4, `codesign`:** the build stops when a signature fails, on purpose:
  a helper that is not properly signed cannot hold a permission. Read the
  message `codesign` printed just above, fix that, and run `install` again.
- **Step 7, "the web client did not answer":** read `sundial.log`. On a slow
  first start, give it more time:

```bash
node bin/sundial install --timeout 300
```

## Restart or reinstall?

- **Restart** after you grant a permission, edit `config.json` or `.env`, or
  change a model. It restarts the web process and the helpers, and rebuilds
  nothing.

  ```bash
  node bin/sundial restart
  ```

- **Install again** after you pull new code, or when files in `~/.sundial` are
  broken. It rebuilds and rewrites the start script and LaunchAgent, and keeps
  your database, `config.json` and `.env`. If a Swift helper changed, macOS
  asks for its permissions again.

  ```bash
  node bin/sundial install
  ```

## Uninstall cleanly

First see what would be removed:

```bash
node bin/sundial uninstall
```

Then remove it:

```bash
node bin/sundial uninstall --yes
```

This stops Sundial, removes the LaunchAgent and deletes `~/.sundial`: the
database, config, `.env`, logs and the app bundles. It removes a folder only if
it holds the installer's marker for that folder. The repository folder is not
touched.

Three things stay, and you remove them yourself:

- The permission grants. Clear them with:

  ```bash
  tccutil reset All dev.sundial.daemon
  ```

  ```bash
  tccutil reset AppleEvents dev.sundial.browser-helper
  ```

- The shell hook line in `~/.zshrc` or `~/.bashrc`, if you added it.
- The Claude Code MCP entry, if you added it:

  ```bash
  claude mcp remove --scope user sundial
  ```
