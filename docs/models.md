# Models

This page explains how Gnomon, the assistant inside Sundial, gets a language
model: where you set it, which model does which job, what leaves your Mac when
it runs, and what stays local no matter what you choose.

## Sundial works without a model

A model is optional. Without one, Sundial still records, folds the record into
moments, and the Today screen still shows your day. Two things need a model:

- **Chat.** Without a model, the chat says it has no model instead of
  answering.
- **Written text.** The one-line reading of each moment, the journal, notices
  written up in words, and the facts Gnomon extracts from a day.

You can add a model at any time. Nothing recorded before that point is lost.

## Choose Gnomon's model

Gnomon's own model is one OpenAI-compatible endpoint: any server that answers
`POST <address>/chat/completions` the way OpenAI's API does. Inside Sundial this
route is called `openai`, whatever service is behind it.

The easiest way is the `/setup` page (`http://127.0.0.1:3080/setup`). Under
the model section, press **Choose a model** and pick a preset:

| Preset | Address it fills in |
|---|---|
| Ollama on this Mac | `http://127.0.0.1:11434/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Anthropic | `https://api.anthropic.com` (Anthropic messages) |
| OpenRouter | `https://openrouter.ai/api/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| Other | empty: type any OpenAI-compatible address |

Then:

1. Paste an API key if the service needs one. A model on this Mac needs no key.
2. Press **Check**. Sundial asks the address for its model list (`GET
   <address>/models`) and offers those names in the Model field. If the
   provider lists none, type the model name yourself.
3. Press **Use this model**.
4. Press **Restart Sundial** when the page offers it (see
   [Restart after a change](#restart-after-a-change)).

The page never shows a saved key again. It only says whether one is set.

### Or edit the env file

The `/setup` page writes three lines to `$SUNDIAL_HOME/.env` (by default
`~/.sundial/.env`, mode 0600). You can write them yourself:

```bash
SUNDIAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
SUNDIAL_LLM_MODEL=qwen3:8b
SUNDIAL_LLM_API_KEY=
```

Set both the address and the model name. With only an address, the chat falls
back to a built-in model name your provider probably does not serve, and the
written summaries stay off. Leave `SUNDIAL_LLM_API_KEY` empty for a local
server. Then restart:

```bash
node bin/sundial restart
```

A variable already set in the environment of the Sundial process wins over the
same variable in `.env`.

### A local model with Ollama

With [Ollama](https://ollama.com) installed and running, pull a model:

```bash
ollama pull qwen3:8b
```

Then choose **Ollama on this Mac** on `/setup`, press **Check**, and pick the
model. Any other server on `127.0.0.1` works the same way. `/setup` recognizes
port 11434 as Ollama and 1234 as LM Studio.

### A local model with MLX or LM Studio

Any server on this Mac that speaks OpenAI chat completions works. With
[mlx-lm](https://github.com/ml-explore/mlx-lm), for example:

```bash
mlx_lm.server --model mlx-community/Qwen3-8B-4bit --port 8080
```

```bash
SUNDIAL_LLM_BASE_URL=http://127.0.0.1:8080/v1
SUNDIAL_LLM_MODEL=mlx-community/Qwen3-8B-4bit
```

LM Studio's server is `http://127.0.0.1:1234/v1`. A local model is private and
free, and slower and weaker than a large hosted one, most visibly when Gnomon
works on the screen.

### A model on your own server

To keep everything off third-party services without running the model on the
Mac, run an OpenAI-compatible server (Ollama, vLLM, llama.cpp's
`llama-server`) on a machine you control, and reach it over your own network.
Behind Tailscale or a VPN, for example:

```bash
SUNDIAL_LLM_BASE_URL=https://gpu-box.example.com/v1
SUNDIAL_LLM_MODEL=qwen3:32b
SUNDIAL_LLM_API_KEY=sk-made-up-0000
```

Sundial treats any address that is not `127.0.0.1`, `localhost` or `[::1]` as
remote: `/setup` and the Ledger show it as hosted, even when the machine is
yours.

## More providers, picked per conversation

You can add more providers beside Gnomon's own. Each becomes one more entry in
the chat's model picker (the model name below the message box), so you can
switch one conversation to a different model.

On `/setup`, once Gnomon's model is set, press **Add a provider** under *More
providers*. The form is the same, plus a name for the picker.

By hand, add them to `$SUNDIAL_HOME/config.json` under `llm.providers`:

```json
{
  "llm": {
    "providers": [
      { "id": "openrouter", "label": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1", "model": "some/model-name" }
    ]
  }
}
```

- `id`: a short lowercase slug (a letter first, then letters, digits or `-`).
  It may not be `openai`.
- `label`: the name in the picker. Optional; Sundial names known hosts itself.
- `baseUrl`: an `http` or `https` address with no user name or password in it.
- `model`: the default model on that provider.
- `protocol`: how the endpoint is spoken to. `openai-chat` (the default: OpenAI
  chat completions, which most services and Ollama speak), `anthropic-messages`
  (Anthropic, and gateways that speak it) or `openai-responses`. For
  `anthropic-messages` the `baseUrl` is the API root, `https://api.anthropic.com`,
  without `/v1`: the client adds `/v1/messages` itself. The Anthropic preset on
  `/setup` sets both. Always use an API key here; Sundial never signs in to a
  consumer plan.

An entry that fails these checks is skipped. Keys never go in `config.json`.
Put each one in `.env` as `SUNDIAL_LLM_KEY_<ID>`, with the id in capitals and
any `-` turned into `_`:

```bash
SUNDIAL_LLM_KEY_OPENROUTER=sk-or-made-up-0000
```

Conversations recorded before v0.2 may name the route `tensorx`. It still
works as a hidden alias of `openai`.

## Which model does what

| Job | Model |
|---|---|
| Chat, by default | Gnomon's own model (`openai`) |
| A chat you switched in the picker | The provider you picked, for that conversation only |
| Moment readings, the journal, fact extraction, notices, reflections | Always Gnomon's own model |
| Internal scoring questions ("judgements") | Gnomon's own model, unless you set up the hosted judge below |

A background purpose runs on the one model in `.env` unless `llm.use` or
`llm.roles` names a provider for it. A provider of any protocol works there:
an `openai-chat` one is called directly, the other two through the same routes
the chat uses.

## The chat on your own Claude Code or Copilot

The chat's model picker also lists **Claude Code** (when `claude` is installed)
and **GitHub Copilot**. Pick one and the conversation runs on your own
signed-in binary, on your own plan: Sundial starts it for each turn with
Gnomon's persona and the conversation so far, and it runs Sundial's read tools
itself over MCP. What it calls shows as thinking in the chat; writes queue for
you as they do from any agent. Two things to know: the thread's helper calls
(its title, its notes) follow the thread's route, so they run on the plan too;
and a Claude Code turn counts its own system prompt and tool schemas as input,
so the Ledger shows tens of thousands of prompt tokens per turn, as plan use,
not dollars. Approvals that ask you mid-turn come later; until then a runtime
gets read tools only.

## Sources in order

`llm.roles` lists, per kind of work, the sources to use in order. The first
answers; when it hits a limit (a 429, a spent quota, a 402) the call moves to
the next, and a source Sundial has paused after failing calls is skipped. Each
attempt is its own row in the Ledger, with its `source`, so you can see which
one answered. On `/setup`, under *Sources in order*, pick a first and a second
source per role; by hand:

```json
{
  "llm": {
    "roles": {
      "chat": ["anthropic-api:claude-sonnet-4-5", "openai"],
      "background": ["openai", "openrouter"],
      "judge": ["jev", "claude:sonnet"],
      "jobs": ["claude"]
    }
  }
}
```

An entry is a source id (`openai` for Gnomon's own model, a provider id,
`claude` for your own Claude Code, `copilot` for your own GitHub Copilot, `jev`
for the hosted judge) with an optional `:model`. `claude` and `copilot` are
vendor runtimes: Sundial starts your own signed-in binary (`claude -p`, the
Copilot CLI through its SDK) and never sees a credential; a job gets Sundial's
read tools over MCP and nothing else. `copilot` needs a GitHub account with a
Copilot plan: a plain GitHub login is refused with "not authorized to use this
Copilot feature". Set `llm.sources.claude.path` when `claude` is not on your
login shell's PATH. `chat` is the conversation (its first source is the chat's default);
`background` the summaries, facts and the journal; `judge` the quick scoring
questions; `jobs` the background jobs. A role with no list runs as before:
on `llm.use`, else the `.env` model. `chat`, `background` and `judge` apply at
once; `jobs` after a restart. Claude Code and Jev count against their own plans:
the Ledger lists them as plan use, not dollars.

## A backup route

A chat turn that stalls moves to another route by itself:

- A provider entry may name a backup with `hedgeTo` (`"openrouter"`, or
  `"openrouter:some/model"`). After that, the chat moves along `llm.roles.chat`.
- A call with no HTTP answer within `llm.connectMs` (default 7,000 ms, 2,000 to
  30,000) goes to the backup.
- `llm.hedgeAfterMs` (default 8,000): a call with no first token after this
  many ms is sent once more, and the first answer wins. `0` turns it off.
- `llm.stallMs` (default 20,000): a stream that goes silent this long is cut.
  When nothing but blank text or reasoning came, it is sent once more, to the
  backup route when there is one. A second silence, a silence after real text,
  or 90 s in all ends the turn with "The model did not answer; try again in a
  minute." `0` turns both off. Raise it for a provider that thinks in long
  bursts.
- A call with no word for 8 s says so on its turn and in the slip ("The model
  is slow, waiting… (12 s)"), and names the backup once it is tried.

```json
{
  "llm": {
    "providers": [
      { "id": "fast", "baseUrl": "https://api.example-fast.ai/v1", "model": "flash-model", "hedgeTo": "local" },
      { "id": "local", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3:8b" }
    ],
    "roles": { "chat": ["fast", "local"] },
    "connectMs": 7000
  }
}
```

Each attempt is its own row in the Ledger, and the chat and the slip say when a
turn moved to its backup.

## Restart after a change

Sundial reads the model settings when it starts. After any change, on `/setup`
or by hand, restart it. The **Restart Sundial** button on `/setup` restarts it
for you, under the app or its LaunchAgent; otherwise the page shows the command
to run instead:

```bash
node bin/sundial restart
```

## What leaves your Mac

- **Only to the address you set.** Sundial sends model requests to Gnomon's
  endpoint and, for a switched conversation, to that provider. No other model
  service is contacted.
- **Text from your record is sanitized.** Window titles, commands, calendar
  titles and everything else were cleaned once, when they were recorded (see
  [privacy.md](privacy.md)). What you type in the chat, and images you attach,
  are sent as you wrote them.
- **Screen looks are text.** When Gnomon looks at an app, the window's
  controls and visible text, cleaned the same way, go to the chat model. No
  screenshot is sent, so no vision model is needed
  ([screen-acting.md](screen-acting.md#what-the-model-sees)).
- **A local model means nothing leaves.** With Ollama or another server on
  `127.0.0.1`, no request leaves the machine. `/setup` says which case you are
  in next to the model.
- **Every call is listed.** The Ledger (the *Cost* tab of the Engine room card)
  shows each call: purpose, model, tokens, latency, failures, how many ran on
  this Mac, and an estimate at list price. The estimate is never a bill.
  Calls are kept as long as the rest of the record (`retentionDays`, 180 days
  by default), including their prompt and response text.

## Daily limits per purpose

Every background purpose has a daily call limit. It is a guard against a
runaway loop, not a cost control, and the defaults sit well above normal use:

| Purpose | Calls per day |
|---|---|
| `intent` (reading each moment) | 2000 |
| `companion` (writing up a notice) | 500 |
| `extract` (facts from the day) | 300 |
| `journal` | 300 |
| `transcript` (tidying heard speech) | 200 |
| `offer` (one offer of help for what you are doing now) | 120 |
| `reflect` | 30 |
| `refute` (the nightly check of held beliefs) | 30 |
| `goal` | 12 |
| `ask` (chat) | no limit |

A purpose that hits its limit stops for the rest of the day. The Ledger shows
the day's use against each limit. To change one, add a `budgets` block to
`config.json`; only a known purpose with a positive number takes effect:

```json
{ "budgets": { "intent": 3000, "ask": 500 } }
```

## Embeddings stay on your Mac

Embeddings are the number vectors Sundial uses to find related moments and
facts by meaning. They are always computed locally, over already-sanitized
text. In order of preference:

1. An embeddings server you run yourself, if `SUNDIAL_EMBEDDING_BASE_URL` points
   at `127.0.0.1`, `localhost` or `[::1]`. An address anywhere else is ignored
   with a log line, and the next option runs instead.
2. A small sentence-transformer model (`all-MiniLM-L6-v2`) running inside
   Sundial. Its weights download once from Hugging Face the first time
   embeddings run; no text is sent.
3. A simple word-hashing vector, if that model cannot load (for example on a
   first run with no network).

There is no setting that sends text to a remote embedding service.

## The hosted judge (optional)

Some internal questions Gnomon asks about its own state can go to a hosted
judge service at `api.typesafe.ai`, but only if you set `TYPESAFE_API_KEY` in
`.env`. Without that key, which is the default, they go to Gnomon's own model
and nothing is sent to that service. Set `SUNDIAL_SYSTEMONE_BACKEND=off` in
`.env` to turn these questions off entirely.

## When something is wrong

- *The chat says there is no model:* `SUNDIAL_LLM_BASE_URL` is not set, or
  Sundial has not been restarted since.
- *Check fails with "The provider refused the key":* the key is wrong or has no
  access to that endpoint.
- *Answers arrive but the journal and moment readings stay empty:*
  `SUNDIAL_LLM_MODEL` is probably missing.

More in [troubleshooting.md](troubleshooting.md).
