# macOS permissions

macOS asks before any app may see your windows, your input or your calendar.
This page lists every permission Sundial may ask for: what it lets Sundial see,
which helper uses it, whether you need it, and how to grant or reset it.

None of them is needed to start. Without any, Sundial still records your git
activity, and the app in front (without its window title). Gnomon needs
Accessibility to look at or act in your apps ([screen-acting.md](screen-acting.md)).

## How Sundial's helpers work

Node.js cannot hold these permissions reliably, so Sundial reads macOS through
small Swift programs called helpers. They live in `/Applications/Sundial.app`,
share one identity (`dev.sundial.daemon`), and write small files to
`~/.sundial/.daemon/` that Sundial reads.

A launcher inside `Sundial.app` starts the helpers. It first re-runs itself so
that macOS treats it as responsible for itself, and not the Node process or
login script that started it (see
[Disclaim.swift](../apps/daemon/src/daemon/macos-daemon-launcher/Disclaim.swift)).
The helpers inherit that. So the grant that counts is the one you give to
**Sundial**, not to your terminal or to Node.

## The permissions

| Permission | What it lets Sundial see | Helper | Needed? | How it is granted |
|---|---|---|---|---|
| Accessibility | The title of the front window and the badge counts on Dock icons. For Gnomon: reading an app's controls, pointing at them, and, once you allow outward actions, pressing and typing in them. | window helper, notification helper, Sundial app | Recommended; needed for screen looks and acts | You add Sundial.app |
| Input Monitoring | How many keys, clicks and scrolls happen, to tell working from away, and when your last real key press or click was, so Gnomon never acts while your hands are on the keys. Never which keys. | input helper | Recommended; needed for the hand check before a screen step | You add Sundial.app |
| Calendars | Times, titles and attendees of your events. | calendar helper | Recommended | The helper asks |
| Reminders | Adding a reminder, only when you approve one. | calendar helper | Optional | The helper asks |
| Contacts | Names for calendar attendees that arrive as bare addresses. | calendar helper | Optional | The helper asks |
| Automation | The address and title of the active browser tab. | browser helper | Optional | The helper asks, once per browser |
| Screen Recording | Text inside pictures when Gnomon looks at a window, read on this Mac by Apple Vision. The optional screen-text reader. | Sundial app, screen-text helper | Optional; without it a look still reads every control | Sundial asks; the screen-text helper asks for itself |
| Microphone | What you say while you hold the summon key. Speech around you, if you turn hearing on. Transcribed on this Mac. | Sundial app, audio helper | Only for hold to talk or hearing | macOS asks |
| System Audio Recording | The other side of a call: what the Mac plays, transcribed on this Mac. | audio helper | Only if you turn on hearing | macOS asks the first time hearing wakes |
| Notifications | Gnomon's notices as macOS banners. | launcher | Only if you turn it on | The launcher asks |
| Full Disk Access | Messages senders and chats (off by default), and your Focus mode. | see below | Optional, off | You add it |
| Location Services | Nothing. Sundial never asks where you are. | none | No | Not needed |

## Grant a permission by hand

For Accessibility and Input Monitoring (and Full Disk Access, if you want it),
you add Sundial yourself:

1. Open **System Settings → Privacy & Security** and the pane for the
   permission. The **Open settings** link on the `/setup` page goes straight there.
2. Click **+** below the list.
3. Press **⌘⇧G**, paste `/Applications/Sundial.app`, and press Return.
4. Choose **Sundial** and click **Open**. Switch it on.
5. Restart Sundial:

```bash
node bin/sundial restart
```

macOS applies a new grant only to a freshly started helper. The `/setup` page
shows the new state shortly after the restart.

## Permissions a helper asks for itself

For the others, macOS shows a prompt the moment a helper first needs the
permission. Click **Allow**. Adding `Sundial.app` by hand does not work for
these: macOS matches the grant to the program that asked.

- **Calendars and Contacts.** The calendar helper runs when Sundial reads your
  calendar, or when you press **Find** under "Start with your history". It waits
  20 seconds for an answer; if you answer later, the next read picks it up.
  Contacts is only used to put a name to an attendee. If you refuse, attendees
  without a name are stored as an anonymous id. The helper also adds an event
  when Gnomon's calendar tool asks it to; that tool follows the approval
  setting of your conversation (see [using-gnomon.md](using-gnomon.md)).
- **Automation.** The browser helper is its own small app,
  `~/.sundial/SundialBrowserHelper.app` (`dev.sundial.browser-helper`). macOS
  asks once for each browser: Safari, Chrome, Chrome Canary, Brave, Edge,
  Vivaldi and Arc. It keeps the site and path, never a query string, and skips
  private windows. The grants appear under **Privacy & Security → Automation →
  Sundial Browser Helper**.
- **Screen Recording.** Two things use it. The Sundial app uses it to read
  text inside pictures when Gnomon looks at a window; without it the look still
  works and says it had no grant. The screen-text reader uses it too, and is
  off: the launcher starts that helper only when `config.json` has
  `"ocr": { "enabled": true }`, and the helper then asks for itself. An entry
  for Sundial.app that you added by hand does not cover that helper.
- **Microphone.** The Sundial app asks the first time you hold the summon key
  to talk. The audio helper asks only if you turn hearing on (`"audio":
  { "enabled": true }`). Audio is transcribed on this Mac and never written to
  disk. Both need the local speech model: `node bin/sundial hearing`.
- **System Audio Recording.** While hearing is on, the audio helper also
  transcribes what the Mac plays, so a call's transcript has both sides, labelled
  as the call or the room. macOS asks the first time. If you refuse, hearing
  carries on with the microphone alone.
- **Notifications.** Off unless `config.json` has
  `"notifications": { "enabled": true }`. Then the launcher asks to show
  banners. Change it later in **System Settings → Notifications → Sundial**.

If you clicked **Don't Allow**, switch the entry on in the matching pane, or
reset it (below) so the helper asks again.

## Full Disk Access

The setup page says to skip this, and you can. Two things use it: Messages
capture (senders and chats, never text), which is off unless `config.json` has
`"privacy": { "messages": true }`, and reading which Focus mode is on. Without
it, Sundial may not see your Focus mode.

## Location Services

Not needed. Sundial never asks for your location. Without it, macOS hides Wi-Fi
network names, so you name your places yourself in `config.json`
(`locationLabels`).

## Rebuilding changes the identity

Sundial signs its helpers on your Mac with an ad-hoc signature: a signature
without a developer certificate. macOS then recognises a helper by a hash of
its exact code. When a helper is rebuilt, for example when `install` runs after
you pull new code, the hash changes and macOS treats it as a new program. The
entry in System Settings can still look switched on while it no longer applies.

When that happens, re-grant:

1. In **System Settings → Privacy & Security**, open each pane where Sundial is
   listed (Accessibility, Input Monitoring, Screen Recording, and Full Disk
   Access if you added it).
2. Select **Sundial** and remove it with **−**.
3. Add `/Applications/Sundial.app` again with **+** and switch it on.
4. Restart Sundial: `node bin/sundial restart`.
5. Accept the prompts that helpers raise for themselves (Calendars, Screen
   Recording for the screen-text reader, Microphone, Automation).

Pulling new code and running `install` rebuilds the helpers only when their
source changed. A release that changes them says so. A Developer ID signature,
which would keep grants across updates, is planned.

The packaged release app checks for an update once a day and asks before it
installs one. Each update it installs is a new identity to macOS until the app
is signed with a Developer ID, so answer Install when you have time to grant
the permissions again.

## Sundial.app is the app macOS starts

`Sundial.app` is a real app: macOS starts it at login (it is in **System
Settings → General → Login Items**), and opening it from Applications (Launchpad, Spotlight, Finder) or a
double-click starts it too. Because macOS starts it, the permissions belong to
the app, and Full Disk Access reaches everything it runs, Mail and Messages
included. That never worked for the older LaunchAgent install
(`install --no-app`), which starts the launcher directly.

To start or stop only the helpers of a LaunchAgent install, use:

```bash
node apps/harness/bin/sundial-sidecars.js start
```

```bash
node apps/harness/bin/sundial-sidecars.js stop
```

## Reset permissions

`tccutil` clears what macOS remembers about an app. This resets every
permission for Sundial's helpers:

```bash
tccutil reset All dev.sundial.daemon
```

Or reset one service, for example Accessibility:

```bash
tccutil reset Accessibility dev.sundial.daemon
```

Other service names: `ListenEvent` (Input Monitoring), `ScreenCapture`,
`Calendar`, `AddressBook` (Contacts), `Microphone`, `AudioCapture` (System
Audio Recording), `SystemPolicyAllFiles`
(Full Disk Access). The browser helper has its own identity:

```bash
tccutil reset AppleEvents dev.sundial.browser-helper
```

After a reset, restart Sundial and grant again:

```bash
node bin/sundial restart
```

Still stuck? See [troubleshooting.md](troubleshooting.md).
