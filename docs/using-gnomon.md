# Using Gnomon

Gnomon is the assistant inside Sundial. It reads the record Sundial keeps and
talks to you in the web client at `http://127.0.0.1:3080`. This page covers
the everyday surface: the board, the chat, how Gnomon speaks first, what it
asks your permission for, and how to reach the same record from Claude Code.

Chat and written summaries need a model; see [models.md](models.md). The board
and Today work without one.

## The board

The page is one board of cards. Each card answers one question: Today, the
day, what waits for you, the chat, and so on. You and Gnomon arrange the same
board through the same record, so every open tab shows the same layout.

A fresh board starts with three rows: **Today**, **Work** (where Gnomon puts
what it is working on) and **Kanban**.

- **Open a card:** press `/` or `⌘K` for Find. Type a card's name, or any words
  to search the record in Explore.
- **Move and size:** drag a card by its head, resize it from its grip, or use
  the keys below.
- **Remove:** `⌥W`, or select a card and press Delete. No card is pinned; a card
  you removed stays gone after a reload.
- **Scenes:** **Save** in the board's tool row stores the cards as a named
  scene, and **Load** brings one back. The same row has zoom, **Fit**,
  **Arrange** (re-tile the rows), **Note** (a free-text card) and **Clear**
  (asks twice).

The row at the bottom also sets *when* the board looks at: a span, or one day
on the ruler. Every card follows it.

| Keys | What they do |
|---|---|
| `⌥` + arrows (or `⌥H/J/K/L`) | Step focus to the next card |
| `⌥⇧` + arrows | Move the focused card, into the next row if needed |
| `⌥R` | Cycle the focused card's width |
| `⌥W` | Close the focused card |
| `⌥F` | Frame the focused card, or step back to the whole board |
| `⌥C` | Bring the chat to the front, from anywhere |
| `Esc` | Show the whole board |
| `⌘` + scroll | Zoom |

`⌥` keys go to the board when the message box is empty. With text in it, only
`⌥C` does.

## Today and the other cards

- **Today**: the day in one sentence, a live strip (app, project, how long this
  moment has run, focus, branch), what comes next, and how many things wait
  for you.
- **The day**: the sundial face (activity by hour, meetings, deep-work blocks),
  minutes and commits per project, what Gnomon saw, and every moment of the day.
- **Left for you**: finished work from background jobs, untracked time to file,
  suggestions, drafts to send, and Gnomon's open questions.
- **In play**: open commitments (branches and promises) and your goals.
- **Rhythm**: the last two weeks by hour, day by day, and what recurs.
- **Voice**: what Gnomon noticed, what it said or held back and why, and the
  questions it asked you.
- **Explore**: search, every person and project Gnomon holds facts about, and
  *Said*, what was heard near the Mac (only with hearing on).
- **Work**: the job Gnomon is running, its plan, and the wake-ups it has set.

## The chat

The chat is a card too. `⌥C` brings it to the front with the cursor in the
message box; pressing it again sends you back where you were. If the view
moves away while Gnomon is still answering, the chat floats over the board
until you bring it back.

- **Ask** by typing and pressing Enter. `⇧Enter` adds a line.
- **Attach** an image with the paper clip, or paste one.
- **Speak** with the microphone button. The recording goes to the local
  Whisper server that hearing uses and the text lands in the box for you to
  read before sending. Without that server, it shows an error instead.
- **Mention a thread** by typing `@` and part of its name. Gnomon gets a short
  snapshot of that thread as background.
- **Pick the model** for this conversation with the model button below the
  box.

The thread bar at the top of the chat opens the list of threads. **Gnomon** is
the pinned, ongoing conversation, the one it speaks into on its own. **New
session** starts a side thread. **Export** saves a conversation as JSON, and
**Compact** summarizes its earlier part to free up room.

**Repeating jobs.** Ask for work on a schedule in plain words: "every Monday at
9, write my standup", "weekdays at 17:30, list what I left open". Gnomon keeps
the job and runs it at that time. Each result lands under **Left for you**. It
takes days and one time of day, nothing finer. A run missed by more than six
hours (the Mac was asleep) is skipped, not run late. Say "stop the standup job"
to end one. You can keep ten.

Gnomon answers from the record through its `gnomon_*` tools. When it refers to
a card it links it, and it may place cards on the board, draw a figure or walk
you through something step by step (see Auto mode below).

## When Gnomon speaks first

Sundial keeps noticing things: a long stretch with no project, a meeting coming
up, a pattern across days. Each one is weighed against a bar before Gnomon says
anything. A strong one appears in the Gnomon conversation, marked **Gnomon,
unprompted**. A weaker one is not pushed to you; Gnomon has it in mind the
next time you talk. Gnomon may hold a notice for a better moment, the same notice
fades each time it repeats, and there is a daily limit on the quieter kind.

Each notice has three buttons. They go straight to the record, with no model
call:

| Button | What it tells Gnomon |
|---|---|
| **Useful** | Good catch. Recorded as confirmation; nothing else changes |
| **Not now** | Bad timing, not wrong. This notice gets quieter next time. The notice is removed |
| **Wrong** | The observation was false. Counted as an error Gnomon learns from |

**Reply** opens the Gnomon conversation so you can answer in words.

Sometimes Gnomon has a question for you. It sits above the message box as
**Gnomon asks**, in every thread. Press **Answer** and your next message is
recorded as the answer; press **not an answer** to talk about something else.

With `notifications.enabled` in `config.json`, strong notices also appear as
macOS banners. With `notifications.ntfy`, they go to that ntfy topic (see
[privacy.md](privacy.md)).

## Settings

Open **Settings** from Find. They live in the record, so every tab obeys them.

- **Auto mode**: how much Gnomon does unasked.
  - **Off**: answers when asked. Says nothing on its own, leaves the board
    alone, and stops for your yes before any command or outward change.
  - **Notice**: may speak first when a notice clears the bar. Still leaves the
    board alone and still asks before running anything.
  - **Act** (default): may also place cards, walk you through something, and
    run commands and actions on its own, within the permission chip below.
- **How much is worth saying**: Chattier, As judged, Quieter, Much quieter.
  This moves the same bar notices are weighed against.
- **Walk steps**: whether a step-by-step walk advances by itself.
- Paper (light or dark), card blur, motion, and a bench that raises sample
  notices so you can see how they look.
- **Permissions**: every macOS permission with its live state (granted, not
  granted, off), an **Open settings** button for each one that is not granted,
  and **Full setup** for the whole setup page. Inside the Sundial app the
  button opens System Settings directly.

## Approvals

Next to the model button, the **Ask / Auto** chip sets what this conversation
may do without asking:

- **Ask**: Gnomon stops for your yes before anything reaches past its own
  record.
- **Auto**: it does not stop. Destructive commands (`rm -rf`, `sudo`, `dd`, a
  `curl` piped into a shell, a force push) are still refused, whatever the chip
  says.

When Gnomon needs your yes, a card appears inside the answer, never as a pop-up:
**Gnomon wants to**, the tool, the exact command or arguments, and why it
asks. Press **Allow once** or **No**. An unanswered question is refused.

What asks under **Ask**:

- Running a shell command, writing to your calendar, and acting on a web page.
  These tools are off until you turn them on in `config.json`:

  ```json
  { "actions": { "outward": { "run_shell": "auto", "calendar_create": "ask", "web_act": "ask" } } }
  ```

  `"auto"` lets the chip decide. `"ask"` asks every time, even under Auto. This
  block can only make Gnomon stricter than the chip, never looser.

- Any write to a service you connected under `integrations` in `config.json`.
  Reads you list for that service never ask.

What never asks: reading the record, and writing to Gnomon's own record
(facts, proposals, drafts, reminders, jobs). Those are recorded and can be
overturned.

Two more rules hold whatever the chip says:

- **In a turn a notice opened** (text from outside, like a calendar title, may
  be in it), Gnomon may not record a fact as your word, and starting a job,
  setting a wake-up or filing an answer as yours asks first.
- **Background jobs** run without anyone to ask, so they cannot write outside
  the record at all.

Below **Act**, commands and outward writes always ask.

## Facts you tell it

Gnomon keeps facts about people, projects, tools, topics, your goals, and you.
Where a fact came from decides its weight:

- **You said it.** When you state or correct something in the chat, Gnomon
  records it with you as the source. It replaces a conflicting belief at once and the old
  one stays in the timeline.
- **Gnomon worked it out.** Its own inferences are recorded as its
  observations. They become belief only if they recur, and they never override
  what you said.

You can also correct facts directly. Open a person or project (from Explore or
any name) and press **Fix** to say what is true instead, or **Wrong** to
retract a fact. On an answered question in **Voice**, **Route it →** keeps
part of your answer as a fact.

## The Engine room

The **Engine room** card shows how Gnomon itself is doing, in tabs:

- **Cost** (the Ledger): every model call by purpose and model, failures,
  latency, tokens, calls that ran on this Mac, the day's use against each
  purpose's limit, and an estimate at list price, never a bill.
- **Trust**: how much Sundial saw and understood, which sensors are reporting,
  what was scrubbed, and the audit of held beliefs.
- **Calibration**: how good its forecasts have been.
- **Lab**: what it is testing about itself.
- **Reach**: every tool, which were used, and what each permission setting
  allows.
- **Trace**: every effect, with the event that caused it.

## The record in Claude Code

`sundial mcp` runs a read-only MCP server over stdio. MCP (Model Context
Protocol) lets an agent such as Claude Code call tools. This server reads the
same database the running Sundial writes, and every tool it offers is a read.

`node bin/sundial install` offers to add it to Claude Code at the end. To add
it yourself, from the repository folder:

```bash
claude mcp add sundial --scope user -e SUNDIAL_HOME="$HOME/.sundial" -- node "$PWD/packages/mcp/bin/sundial-mcp.js"
```

If your data folder is not `~/.sundial`, change the `SUNDIAL_HOME` value. To run
the server by hand:

```bash
node bin/sundial mcp
```

What Claude Code reads through it goes to Claude Code's own model provider.
The tools:

| Tool | Answers |
|---|---|
| `gnomon_current_context` | Where you are now: front window, open moment, what is next, what is open on this project |
| `gnomon_today_summary` | A day's shape: minutes per project, meetings, breaks, focus, sessions |
| `gnomon_moment_detail` | Everything about one moment, by id |
| `gnomon_recent_activity` | The latest raw events |
| `gnomon_signals` | Raw events for one day, filtered by type, time and words |
| `gnomon_code_activity` | Files edited, functions touched, commits and branches for a day |
| `gnomon_project_status` | Recent moments on one project |
| `gnomon_open_commitments` | Open threads of work, by branch |
| `gnomon_routines` | Habitual sequences of apps, and the usual next step |
| `gnomon_goals` | Your goals and where each stands |
| `gnomon_people` | Everyone you have met with |
| `gnomon_entity_history` | The fact timeline of one person, project, tool or topic |
| `gnomon_semantic_search` | Moments, entries and facts related to a phrase |
| `gnomon_anomalies` | The day's unusual patterns |
| `gnomon_board_traffic` | What happens on the board, and how much is Gnomon's doing |
| `gnomon_llm_ledger` | Gnomon's model calls and their estimated cost |
| `gnomon_compose_figure` | A figure's data (a day, a trend, a fact chain), computed from the record |

Try asking Claude Code what you worked on this week.
