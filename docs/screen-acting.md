# Screen acting and its safety

Gnomon can work in your other apps: read a window, point at a button, walk you
through a few steps, and press, type and save for you. It does this through
macOS Accessibility, the same interface screen readers use, so it reads an app
as a list of named controls, not as a picture. Before any step that cannot be
taken back, such as a send or a delete, it asks you.

This page describes what Gnomon can do on the screen, what it asks first, what
it refuses, and what goes to the model. For the macOS grants it needs, see
[permissions.md](permissions.md).

## What is on by default

| Ability | Default | Needs |
|---|---|---|
| Look at an app window | On (`experiments.screenLook`) | Accessibility for Sundial. Screen Recording too, for text inside pictures |
| Point at a control (a ring, a label, a step number) | On (`experiments.screenMarks`) | Accessibility |
| Guide you through up to seven steps | On (`experiments.screenGuide`) | Accessibility |
| Press, type, save and undo in an app | **Off**, until you turn on outward actions | Accessibility; Input Monitoring for the hand check |

To let Gnomon act: open **Settings**, and under *What Gnomon may do* set
**Outward actions** to **Ask**. Then restart:

```bash
node bin/sundial restart
```

The same switch also lets Gnomon ask to run shell commands, add calendar events
and reminders, and act on web pages. To allow only screen steps, set the tools
one by one in `config.json` instead:

```json
{ "actions": { "outward": { "screen_act": "ask", "screen_undo": "ask" } } }
```

## The screen tools

| Tool | What it does | Asks first |
|---|---|---|
| `screen_look` | Reads one app's window as a list: each control's role, words, value and what can be done with it. Can list a menu without opening it | No |
| `screen_mark` | Draws a ring, underline, bracket, step number or short label on a control. Your click goes through it | No |
| `screen_guide` | Walks you through up to seven steps, one ring at a time. Esc or leaving the app ends it | No |
| `screen_act` | One step, or up to eight: press, click, type, set a value, a key, scroll, pick a menu item, select text, open an app or address, switch to a tab, rename in Finder, drag, click at a point in the window, Save As, go to a folder in an Open or Save panel | Yes, every time (see [When a step runs without asking](#when-a-step-runs-without-asking)) |
| `screen_undo` | Puts back the value that the last *set value* step replaced | Yes |
| `gnomon_pull_up` | "Pull up Tuesday's memo": finds the thing in your recent windows or the record, opens or raises it and rings it. Each step inside asks like `screen_act` | Per step |
| `gnomon_skill` | Replays a route you kept as a skill, in one `screen_act` | Yes, like `screen_act` |
| `gnomon_await` | Waits for a background job, an app, a window title, a file or a timer, instead of sleeping | No |

## The slip and your voice

The **slip** is a thin panel over your apps. Press **⌥Space** to bring it up
(change the key with `overlay.hotkey`; turn it off with `overlay.enabled:
false`). It shows what Gnomon is doing, the step it is on, and any question it
has. Hold the key and speak to talk to Gnomon (**hold to talk**); a press while
Gnomon speaks stops its voice and listens.

Speech is transcribed on this Mac by a local Whisper server; set it up with
`node bin/sundial hearing`. Gnomon's spoken replies use Kokoro on this Mac
(`voice.python`), or the macOS system voice when Kokoro is not set up.

## The confirm

When a step asks, the same question appears in the chat as a card (**Gnomon
wants to**, the tool, the reason, the exact arguments, **Allow once** and
**No**) and in the slip, with a ring on the control it is about. In the slip
you can type or say *yes* or *no*. A whole sentence is taken as a correction,
not an answer.

For a final step the question says what the step does, in which app and
window, and that it cannot be taken back, followed by the steps, the recipient
(**To:**), the path or the command.

- An unanswered question is refused after five minutes.
- After you say no to a final step, Gnomon may not try the same final again in
  that turn.
- A message you send while Gnomon is working corrects the running task and
  stops the step in progress.

## Final steps

A final step is one that cannot be taken back. **A final step asks in every
mode, under Ask and Auto alike.** Gnomon recognises these kinds (the English
words are shown; the same kinds are known in Dutch, German, French, Spanish,
Portuguese and Italian, so a Dutch "Verzenden" is a send):

| Kind | Control names that start with |
|---|---|
| discard | Don't Save, Discard, Delete draft, Revert, Close without saving |
| send | Send |
| pay | Pay, Buy, Purchase, Check out |
| submit | Submit, Place order, Confirm |
| delete | Delete, Move to Trash or Bin, Empty Trash or Bin, Remove, Erase, Unsend |
| post | Post, Publish, Tweet, Repost, Reply all |
| update | Update, Install, Upgrade, Restart now |
| overwrite | Replace, Overwrite |
| archive | Archive |
| leave | Leave, Unsubscribe |
| block | Block, Revoke |
| share | Share, Invite |
| transfer | Transfer |
| merge | Merge, Squash and merge, Rebase and merge |
| answer | Approve, Accept, Decline |
| unknown | A Return that lands on something no look can name |

It also counts as final:

- Send keys (⌘⇧D, ⌘Return, Ctrl+Return) in mail, browser and chat apps, and
  delete keys (⌘⌫ and its variants).
- Return or Space on a focused button, a window's default button, a web form's
  submit, or a chat box.
- Shell commands that send mail or delete files (`rm`, `trash`,
  `find -delete`, AppleScript sends).
- On a web page: a click on a final control, or text typed and submitted in a
  field that is not a search box.

Not finals: Reply, Forward, a name ending in "…" that only opens a sheet
(except Send… and Delete…), a field's own label ("Confirm password"), and
phrases such as "Leave a comment", "Block quote", "Merge cells", "Accept all"
on a cookie banner.

**Limit:** control names are matched in English, Dutch, German, French,
Spanish, Portuguese and Italian. A button in another language is not
recognised as final. It still asks as an ordinary step, and a step on a button
Gnomon has no word for never stops asking (next section).

## When a step runs without asking

An ordinary (not final) `screen_act` step asks every time, with two
exceptions:

- **Earned.** After you say yes to plain steps of one kind in one app ten times
  in a row (`actions.earnAfter`, 1 to 100), plain steps of that kind in that app
  stop asking. One no resets the count. This applies only when Outward actions
  (or `screen_act` itself) is set to **Auto**, not **Ask**; only in
  conversations you started, never in a turn Gnomon opened itself; and never to
  typing, a final step, a private app, or a button Gnomon has no word for.
  With Outward actions on **Ask**, every step asks.
- **`experiments.screenActUnasked: true`.** Plain steps never ask. Off by
  default.

In both cases final steps, refusals and the data-leaving check below still
apply.

## Your hands come first

Before each screen step Gnomon reads the time of your last real key press or
click (from the input helper; Gnomon's own synthetic input never counts). If
it was under two seconds ago, the step waits. If you keep typing and no
two-second gap comes within six seconds, the step is refused and the slip says
*Waiting: your hands are on the keys*. If you type or click after a step was
sent, Sundial refuses it.

## Private apps

Gnomon never looks at, opens, raises, types into or acts in a private app.
Private apps are the sensitive and hidden apps from [privacy.md](privacy.md):
by default WhatsApp, Messages, Telegram, Signal, Messenger, Slack, Discord,
Mail, Zoom, FaceTime, Notes, Calendar, Reminders, password managers, banking,
payment and health apps, plus anything you add to `privacy.sensitiveApps` or
`privacy.hiddenApps` (or in Settings, under private apps and sites). A name
matches when it contains an entry, so any app with "mail" in its name is
private, and an app is known by its whole name in any language, not only by
its bundle id. The check also covers links that open these apps
(`sms:`, `imessage:`), `open -a` in the shell, and their data folders
(`~/Library/Messages`, `~/Library/Mail`).

As a result, Gnomon cannot send from Apple Mail or Slack. It can send from web
mail in a browser, behind the confirm.

It also never acts in System Settings, Passwords, Keychain Access or the system
password dialog, in a password field, in a window titled *Sign in*, *Log in* or
*Password*, or while macOS secure input is on.

## Data leaving after a private read

Once a conversation has read something private (a screen look, a file outside
the workspace, a connected service, or Gnomon's own record), any call that
could carry that data off the Mac asks first: a web search, a page fetch, an
address opened by a screen step, text typed on a web page, or `curl`, `wget`,
`nc`, `ssh`, `scp`, `sftp`, `rsync`. It asks when the call carries something
that looks like data (an address, a phone number, an IBAN, a home path, six or
more digits, a token, or an unusual word from what was read) or goes to a host
that is not on the known list.

The known hosts are Wikipedia, Wikimedia, Wiktionary, GitHub, Stack Overflow,
developer.apple.com, MDN, npm, nodejs.org and python.org. `web.knownHosts` in
`config.json` replaces the list. With nobody to ask, the call is refused.

## Always refused

Whatever the chip says:

- An inline Python or Node script that contains a web or app address.
- Destructive shell commands: `rm -rf`, `sudo`, `dd`, a `curl` piped into a
  shell, a force push.
- Opening Sundial's own database for writing from the shell.
- Any outward step in a background job. Jobs run with nobody to ask, so outward
  tools are off and final steps are refused.

**Loop breakers.** Gnomon stops the turn and asks you how to go on when the
same control fails or changes nothing four times, the same call repeats twice
in a row, four read-only shell commands follow a failed screen step, or two
looks for the same word find nothing.

**A save is proven.** After Save or Save As, Gnomon waits up to four seconds
for the file to change on disk. Without that, it says no change was seen and
may not call the file saved.

## Undo

`screen_undo` puts back only the value the last *set value* step replaced. The
old value is held in the app's memory, never written down, so a restart loses
it. It refuses when the last step was anything else, or when you changed the
field since. It cannot undo clicks, keys, typing, sends, deletes, renames, saves
or menu picks.

A *set value* step refuses up front to replace a field that is not empty unless
the step says so, or a text area it could read only in part.

## What the model sees

The model never gets pixels. A look is text: each control's role, words, value
and verbs, marked as data read off the screen, never an instruction. Text inside
pictures is read on this Mac by Apple Vision; the image is dropped and never
written to disk. So no vision model is needed.

That text does go to your chat model. It passes the same cleaning as the rest
of the record first (secrets become `[REDACTED]`, addresses `[email]`, and so
on; see [privacy.md](privacy.md#cleaned-once-when-recorded)). With a model on
this Mac, it stays here. Because addresses are hidden, put your own in
`ownerEmails` if you want "send it to me" to work.

## What Gnomon learns from the screen

- **Routes.** A screen task that ran clean is kept as "what worked here" for
  that app, and offered the next time you ask for something similar. The
  **Routes** card lists them, each with **Drop**.
- **Skills.** A route that ran clean three times on two different days is
  offered once: *Keep this as a skill?* After **Keep**, "run *name*" replays it,
  still asking like any step.
- **Self-review.** When three steps fail or are refused in one app, Gnomon
  reviews them in spare time (at most twelve a day) and proposes one change (drop
  a route, add a note about the app). Nothing applies before you press **Keep**.
- **App notes.** Lines you write in `appNotes` go into Gnomon's brief as they
  are: what no look can tell it, such as which browser profile holds your work
  logins.

## How it is tested

Every screen change is run on our own test rig, which drives real apps on a
Mac: a test mailbox on `127.0.0.1`, test forms, TextEdit, Finder, Calculator.
It answers the same confirm cards as you would, from an allow-list, and counts
two things that must stay at zero: final steps that ran without asking, and
sends to anyone outside the allow-list.

Over 53 rig runs, 0 of 121 final steps ran without a confirm, and private apps
were refused 57 times out of 57. A later run found one hole: a Return key on a
Send button went through without asking. It was fixed the same day and has
held in every run since.

These are our own counts, on test apps, on one Mac. They are not a benchmark
score, and no one outside the project has repeated them.

## Limits

- **No sandbox.** Gnomon acts in your real apps, as you. The confirm is a gate,
  not isolation.
- **Prompt injection is not solved.** Text in a web page, a mail or a window
  can try to steer Gnomon. The confirm, the private-app fence and the
  data-leaving check limit the damage; they do not remove the risk.
- **Final steps are recognised in English** (above).
- **It uses your screen.** Gnomon works in the window in front, so it waits
  while you type.
- **Speed follows the model.** A local model is slower than a fast hosted one.
