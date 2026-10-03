# Use cases

What Sundial does today, shown on one made-up week, and where it is going.

Every video here runs on a demo record: a fictional engineer with two client
projects, a novel they write in the evenings and a game night with friends. The
people, repos and companies are invented. Nothing in it is real data. Each answer
on screen was checked against that record before the video was kept.

## The Thursday morning

<!-- VIDEO: morning.mp4 (the whole story, 3:25) -->

One session, before a 09:30 standup and a 10:30 client demo. Each part below is
one step of it.

### 1. The morning card, and a notice worth a tap

<!-- no separate clip: the opening of the morning video -->

You open the Mac at 09:05. Today already says what yesterday was in one line,
where you left off, and what is next. Nothing was typed by hand: it comes from
the windows, commits, shell and calendar of the day before.

A few minutes later a notice appears: before standup, here is what you owe the
people in that room. You tap **Useful**. Each tap (Useful, Not now, Wrong) is a
verdict on the record, and Gnomon learns from it which notices are worth the
interruption.

### 2. What do I still owe?

> "Before standup and the Lumen demo: which promises from this week are still
> open, and to whom?"

Gnomon lists the open promises, who each one is for, and where it was made.
Promises come from meetings, mail and your own words. A promise closes as kept
only on evidence that names what was promised, such as a commit or a sent mail.
Gnomon asks before it calls a promise broken.

### 3. A research brief, on the shelf with its sources

<!-- VIDEO: post-research.mp4 -->

> "Research OffscreenCanvas for the level-thumbnail export I owe Tom. Leave a
> short brief on the shelf, with sources."

Gnomon reads your record first, then does at most two web searches and reads at
most three pages. The brief lands on the shelf (**Left for you**), and every
claim names its source. You keep it, put it off, or mark it wrong.

### 4. Gnomon lays out the board and walks you through it

<!-- VIDEO: post-board.mp4 -->

> "Put Today, Left for you and In play side by side, and walk me through them."

The board is a page of cards. Gnomon places the cards itself and points at each
one while it talks. Every move it makes on the board is an event in the log, so
it knows what you were shown.

### 5. A rule, tested on your past before you keep it

<!-- VIDEO: post-keep.mp4 -->

> "Tell me when one of my PRs sits with a review comment unanswered for two
> hours of my active time. Test it on my record first."

Gnomon writes the rule, runs it over the last weeks of your record, and shows
each time it would have spoken. It asks before adopting it. Nothing new starts
watching you until you click **Adopt**.

### 6. Tell it when it is wrong

<!-- VIDEO: post-correct.mp4 -->

> "Who was on the release call with me on Tuesday?" Then: "Correction: Daan is
> the client's SRE lead. Just record it."

What Gnomon believes about people comes from meetings and mail, so it can be
wrong. A correction becomes a fact marked as **yours**, next to what was
inferred. Nothing is overwritten: the newer fact supersedes the old one, and both
keep their evidence.

### 7. What did this cost, and what left the Mac?

<!-- VIDEO: post-cost.mp4 -->

The Ledger lists every model call: its purpose, its model, its tokens and its
list price. The trust tab shows what was scrubbed at ingest (secrets, e-mail
addresses, your user name in paths), that embeddings are computed on this Mac,
and every sensor that ran. With a local model, the Ledger is all local too.

## The same week, asked from outside

<!-- VIDEO: agent.mp4 (0:46) -->

### 8. Your coding agent asks Sundial

> "Tell me the story of my week: the work, the novel, what I did for fun. Then
> list what I still owe people."

This is a real Claude Code run with only Sundial's read-only MCP tools. It calls
about a dozen of them (the week brief, open commitments, day summaries, semantic
search) and writes the story, with caveats about what the record cannot prove.
The same works for any MCP client. `sundial install` offers to add it to Claude
Code; the command is in the [README](../README.md).

The everyday version is smaller: a new agent session that starts with "where did
I leave off on this branch?" instead of you explaining it again.

### 9. Every answer opens down to the evidence

The release call Claude Code mentioned is a moment in the record. Open it and you
see how Gnomon read it, the words heard in the room, and one click further, the
raw capture behind the cleaned copy. Nothing is a summary you cannot open.

Hearing (meeting transcripts) is opt-in, off by default, and runs a local
whisper model.

## Where this is going

Sundial today is a record and an assistant that reads it. The direction is an
assistant that knows its owner, knows itself, and takes work off their hands,
without the record ever leaving their machine. Nothing below is built yet. The
order can change.

### Next: easier to install and keep

- **Signed builds.** Developer ID signing and notarisation, so an update keeps
  your macOS permissions instead of asking for them again.
- **Drag-to-grant.** A permissions panel where you drag Sundial into the list,
  and the setup page sees each grant arrive.
- **A Homebrew tap**, and later a `.dmg` that owns the install and updates itself.
- **Optional senses, documented.** Web search, hearing and screen text each get
  a setup guide, so they work on your Mac and not only on the developer's.

### Gnomon sees itself

Gnomon remembers what it said. Next, it should also know what you saw: which
cards were on the board, which lines it drew, which ones you never opened. With
that it can answer "what is on my screen", learn which of its surfaces are
useful, and, each night, check yesterday's claims against the record and correct
itself when one turned out wrong.

### Preparing, not reminding

For everything in the next 24 hours (a meeting, a deadline, a promise due, a
routine that usually starts at nine) Gnomon asks what you need in hand, and
leaves a packet on the shelf before the moment: the documents, the last thread
with that person, the open questions, a draft. Every open item gets a proposed
next step, and one tap closes it.

### A model of you, not only a record

The record knows what happened. Knowing *you* is more: your goals, routines,
preferences, people and constraints, each one a belief with its evidence and a
way to correct it. Also the *how*: the steps behind "prepare a release", learned
from the log and kept as a skill Gnomon can run or prepare for you. You can open
and edit all of it.

### Your history as the test suite

Every change to a rule, a prompt or a setting can be replayed over your own
history before it ships, showing exactly what would have been said differently.
A hosted assistant cannot do this: it does not have your complete record.
Autonomy works the same way. Each capability is off, asks first, or acts alone,
and it moves up only when its measured record earns it and you say yes.

### People, and more than one Mac

- **Companion to companion.** Two people's Gnomons exchange narrow facts each
  owner allowed ("is she free Thursday", "has he seen my message") over a
  private network, never through a server that sees both records.
- **Shared spaces.** A team, a family or a game group gets a companion over only
  what each member chose to share.
- **Packs for other lives.** Sensors, rules and cards for gamers (sessions,
  breaks, the squad), scientists (a lab notebook that writes itself), hobbyists
  (projects, parts, progress) and, with its own safety review first, kids.
  Packs also mean sensors beyond macOS.

If one of these is the reason you would use Sundial, or the reason you never
would, [open an issue](https://github.com/Angelista-Enterprise/sundial/issues).
