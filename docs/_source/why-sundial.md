# Why Sundial

This page explains what Sundial is trying to be and the rules it holds itself
to. Read it if you are deciding whether to trust Sundial with a record of your
working day, or whether to contribute to it.

## A context engine, not an activity logger

Sundial records what you work on: the app in front and its window title, git
commits, your calendar, shell commands, the browser tab, and, only if you turn
it on, the text on your screen. An activity logger would stop there and draw you
a chart of hours per app.

Sundial treats that record as raw material. It folds it into a knowledge base:
closed stretches of attention ("moments"), the projects they belong to, the
people you meet, and durable facts about all of them. Gnomon, the assistant
inside Sundial, reads that knowledge base and talks to you about it. The
question Sundial wants to answer is not "how long was I in the editor?" but
"what was I doing, with whom, and what did I leave unfinished?"

## Local-first is a posture, not a feature

Sundial watches almost everything you do on your Mac. That makes its privacy
stance the most important decision in the project, so it is a set of rules, not
a setting:

- **Nothing leaves the machine that did not have to.** The log, the knowledge
  base and the search vectors live in one SQLite file in `~/.sundial`. Until you
  configure a model, nothing of yours is sent anywhere (the only download is the
  local search model's files, once). After that, only sanitized text
  goes to the one endpoint you chose, and every model call is recorded so you
  can see it. Point Sundial at a local model and nothing leaves at all.
- **Embeddings stay local.** The vectors used for semantic search are computed
  on your Mac. An embedding server is accepted only on a loopback address; a
  remote one is ignored. There is no remote embedding path, by decision.
- **Loopback only.** Everything binds to `127.0.0.1`. Every web route checks the
  Host and Origin headers and needs a signed session cookie, so other web pages
  in your browser cannot read or drive it.
- **Remote access goes through Tailscale Serve.** If you want to reach Sundial
  from your phone, you proxy your tailnet to the loopback address. You never
  widen the bind for convenience.
- **Redaction happens once, at ingest.** Before an event is written, secret-looking
  strings, URL query strings, your user name in file paths and e-mail addresses
  are removed. Every later reader (the model, the MCP server, the web page) reads
  the already-cleaned value and never makes its own privacy decision.

The details, including exactly what can leave the machine, are in
[privacy.md](privacy.md) and the repository's `SECURITY.md`.

## The log is the truth

Every observation is appended to one table, the log. Nothing edits a row in it.
Everything you see (moments, projects, facts, notices) is derived from that log
by one **fold**: a function that reads the events one at a time, in order, and
updates a single state object.

The fold is a fixed list of small **rules**. A rule is a pure function: it takes
the current state and one event and returns a new state plus a list of
**effects** (descriptions of side effects, such as "write this row" or "ask the
model this"). Rules never touch the disk or the network themselves. One place,
the effect executor, performs every effect and records it.

This has practical consequences:

- There is no hidden side-state. If something is not in the log or derivable
  from it, it does not exist.
- The result is reproducible. Replaying the log gives the same state, which is
  how Sundial boots and how bugs get found.
- Every side effect has one audit trail, because there is only one place that
  performs side effects.

## Speak first, and be right

Gnomon's value is what it volunteers, not what it retrieves when asked. A screen
that only answers questions has failed. So rules watch for things worth
mentioning (something you usually do that has not happened today, a thread of
work that has gone quiet, a command that keeps failing) and propose them.

Speaking first has a cost: every interruption spends your attention and your
trust. One rule, the notice gate, is the only place that decides whether Gnomon
says anything. It weighs how much a candidate is worth against what saying it
costs, keeps a daily budget, and gets quieter about a kind of thing it has
already told you. Most candidates are held back or wait quietly in context;
only strong ones interrupt.

Your feedback teaches it. When you mark something as useful, not now, or wrong,
that verdict goes back into the log as an ordinary event. The gate and the
learning rules read it on the next fold, like anything else.

## Facts are never overwritten

Sundial's deepest memory is a small graph of entities (people, projects, tools,
topics) and facts about them. A new observation that contradicts a fact never
overwrites it. The old fact gets an end date and a pointer to the one that
replaced it, so "what was true before?" stays answerable.

Each fact also carries a belief: how sure Sundial is that it is still true. The
belief grows when the fact is observed again and slowly fades when it is not. A
correction you make yourself counts for more than a guess. The record never
changes; only the certainty moves.

## More capture ships off by default

Some capabilities capture much more than the baseline: screen text, ambient
audio transcription, mail and message subjects. Each is fully built and ships
switched off in code, as do native notifications and the experimental rules.
Only your own `config.json` turns one on. A fresh clone never captures more than
the baseline without you asking it to.

Privacy lists work the other way: the sensitive and hidden app lists and the
redaction patterns in your config are added to the built-in ones and can never
replace them.

## The laziest change that works

Sundial is small and intends to stay that way. A new capability is a new field
on the state object and a new rule in the fold, not a new subsystem with its own
timers and memory. No new dependency unless there is no other way. The fewest
lines and files that do the job.

## Who it is for today

- One person, on one Mac.
- A developer who is comfortable with a terminal: installing means cloning the
  repository, running a command, and granting macOS permissions by hand.
- Someone willing to accept rough edges. Sundial is at v0.

## What it is not

- **Not multi-user.** There are no accounts, no sharing, no team view.
- **Not a cloud service.** There is no server to sign up for. Your record exists
  only on your Mac.
- **No telemetry.** Sundial sends no usage data. The harness it runs on has an
  optional telemetry exporter, and Sundial starts it disabled.

To try it, start with [getting-started.md](getting-started.md). To see how it is
built, read [architecture.md](architecture.md).
