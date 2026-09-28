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

An entry that fails these checks is skipped. Keys never go in `config.json`.
Put each one in `.env` as `SUNDIAL_LLM_KEY_<ID>`, with the id in capitals and
any `-` turned into `_`:

```bash
SUNDIAL_LLM_KEY_OPENROUTER=your-key-here
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

Extra providers never write summaries or the journal. Every background purpose
runs on the one model in `.env`.

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
