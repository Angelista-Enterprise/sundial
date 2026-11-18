# Configuration reference

Sundial reads two files in `$SUNDIAL_HOME` (default `~/.sundial`):

- `config.json`: settings. Every field is optional; a missing file is valid.
- `.env`: model addresses and keys. Never put a key in `config.json`.

Both are read at start. Restart after a change: `node bin/sundial restart`.
The Settings card and `/setup` write the same files.

The resolver is `packages/helpers/src/sundial-config.ts`. A value of the wrong
type is ignored and the default is used. Lists of apps, patterns and hosts in
`privacy` only add to the built-in lists; they never remove from them.

## `.env`

| Variable | Meaning |
|---|---|
| `SUNDIAL_LLM_BASE_URL` | Gnomon's own model: an OpenAI-compatible address. Unset: no model |
| `SUNDIAL_LLM_MODEL` | The model name at that address |
| `SUNDIAL_LLM_API_KEY` | Its key. Empty for a model on this Mac |
| `SUNDIAL_LLM_KEY_<ID>` | The key of the provider with that `id` in `llm.providers` (capitals, `-` as `_`) |
| `SUNDIAL_EMBEDDING_BASE_URL` | An embeddings server on `127.0.0.1`, `localhost` or `[::1]`. Any other address is ignored |
| `SUNDIAL_LOCAL_EMBEDDING_MODEL` | The in-process embedding model. Default `Xenova/all-MiniLM-L6-v2` |
| `TYPESAFE_API_KEY` | Sends judge questions to api.typesafe.ai (Jev). Unset: they go to your own model |
| `SUNDIAL_SYSTEMONE_BACKEND` | `off` turns the judge questions off |

Set for the install, and remembered by it: `SUNDIAL_HOME`, `SUNDIAL_WEB_PORT`
(3080), `SUNDIAL_PHONE_PORT` (8767), `SUNDIAL_CHROME_PORT` (9223).
`DATABASE_URL` overrides the database path.

## Example

```json
{
  "ownerAliases": ["Mira Bakker", "mira"],
  "ownerEmails": ["mira@example.com"],
  "timezone": "Europe/Amsterdam",
  "projectRules": [{ "pathContains": "~/Projects/puzzlebox", "project": "puzzlebox-studio" }],
  "privacy": { "sensitiveApps": ["Banking Pro"], "hiddenApps": ["Private Diary"] },
  "actions": { "outward": { "all": "ask" } },
  "llm": {
    "providers": [{ "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "model": "some/model" }],
    "roles": { "chat": ["openai", "openrouter"] }
  }
}
```

## You and your days

| Field | Type | Default | Meaning |
|---|---|---|---|
| `ownerAliases` | string[] | `[]` | Every name you appear under in your own calendar's attendee lists, so you are not recorded as meeting yourself. Case-insensitive |
| `ownerEmails` | string[] | `[]` | Your own addresses, for "send it to me" (the screen shows every address as `[email]`) |
| `timezone` | IANA zone | the Mac's zone | The zone your days are counted in |
| `workdays` | number[] | `[1,2,3,4,5]` | Days you work, 0 = Sunday. A morning packet is made on these only |
| `choreDays` | 2 to 14 | `3` | Distinct days in four weeks before a repeated chore earns an offer |
| `appNotes` | string[] | `[]` | Lines about your apps, put in Gnomon's brief as written |

## Projects, people and places

| Field | Type | Default | Meaning |
|---|---|---|---|
| `projectRules` | object[] | `[]` | Ordered rules; the first match names the project. Fields: `titleContains`, `meetingContains`, `urlContains`, `pathContains`, `gitBranch`, `processIs`, `project`, `confidence` (`certain` or `weak`). All present fields must match |
| `projectAliases` | object | `{}` | Variant to canonical project name, e.g. `{"PB-Games": "puzzlebox-studio"}` |
| `personAliases` | object | `{}` | Variant to canonical person name. Changes what a person answers to; never rewrites facts |
| `orgByPath` | object | `{}` | Path prefix to organization. Longest prefix wins |
| `sharedPlaces` | string[] | `[]` | Hosts (`meet.google.com`) and apps (`app:Slack`) that are work but no single project |
| `locationLabels` | object | `{}` | Network fingerprint to a place name such as `office` |
| `leisureRules` | object | built-in | `browserProfiles`, `domainOverrides`, `processes`, `excluded`. Classes: `work`, `personal-work`, `personal`, `ambient`, `unknown`. Merged over the built-in lists |
| `vault` | path | unset | An Obsidian vault to watch (paths only) and write the journal into |

## `privacy`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `redactionTier` | 1, 2, 3 | `2` | How hard paths and URLs are rewritten. See [privacy.md](privacy.md#cleaned-once-when-recorded) |
| `sensitiveApps` | string[] | `[]` | More apps whose content becomes `[private]`. Gnomon never looks at or acts in them |
| `hiddenApps` | string[] | `[]` | Apps whose name and content become `[hidden]` |
| `shellRedactPatterns` | string[] | `[]` | More secret patterns (regular expressions) |
| `privateHosts` | string[] | `[]` | More web hosts whose page text is never kept |
| `agentTranscripts` | boolean | `true` | Read coding agents' prompts and final replies |
| `claudeContext` | boolean | `true` | Add five lines of context to each new Claude Code session |
| `messages` | boolean | `false` | Read Messages senders and chats (never text). Needs Full Disk Access |

## Sensors

| Field | Type | Default | Meaning |
|---|---|---|---|
| `browser.pageText` | boolean | `false` | Visible text of the front tab (Chromium browsers, Safari) |
| `browser.pageTextAx` | boolean | `false` | The same for Firefox-family browsers, over Accessibility |
| `clipboardEnabled` | boolean | `false` | Kind and size of what you copy |
| `atlas.libraries` | boolean | `true` | Atlas mode searches Wikimedia Commons, Poly Pizza, Smithsonian 3D and BodyParts3D with your search words and downloads what it picks. `false`: no search and no download. A switch in Settings, under What may leave this Mac; applies at once |
| `sensors.githubPrs` | boolean | `true` | Your open pull requests, asked of GitHub every five minutes with your own `gh` login, when `gh` is signed in. `false`: no `gh` call. A switch in Settings, under What may leave this Mac; applies after a restart |
| `ocr.enabled` | boolean | `false` | The screen-text reader |
| `ocr.retentionDays` | number | `14` | Days screen text is kept |
| `ocr.fullIntervalMs`, `ocr.cursorIntervalMs`, `ocr.cursorRegionPx` | number | `5000`, `1500`, `480` | Capture cadence and region |
| `ocr.slowApps`, `ocr.slowIntervalMs` | string[], number | `["claude"]`, `60000` | Apps read at most once per interval |
| `ocr.vision.enabled`, `.model`, `.intervalMs` | | `false`, `gemma4:e4b-mlx`, `60000` | Up to three facts per frame from a vision model in your local Ollama |
| `ocr.jev.text`, `ocr.jev.frames`, `ocr.jev.framesPerHour` | | `false`, `false`, `12` | Send screen lines or frames to Jev. Each is its own consent |
| `audio.enabled` | boolean | `false` | Hearing, while you press Listen |
| `audio.autoMeetings` | boolean | `false` | Calls open the microphone by themselves. `node bin/sundial hearing` asks about it on its own, after the hearing question |
| `audio.languages` | string[] | `[]` | Languages to keep (`"english"`, `"dutch"`). Empty keeps all |
| `audio.retentionDays` | number | `14` | Days heard speech is kept |
| `audio.whisperUrl` | URL | `http://127.0.0.1:8771/inference` | The local transcriber. Only `127.0.0.1`, `localhost` or `[::1]`: any other host is refused (`doctor` fails, and the default is used) |
| `audio.modelPath`, `audio.vadModelPath` | path | in `$SUNDIAL_HOME/models/` | Whisper and VAD model files |
| `audio.silenceFlushMs`, `audio.maxUtteranceMs` | number | `900`, `25000` | Where one utterance ends |

## Retention and memory

| Field | Type | Default | Meaning |
|---|---|---|---|
| `retentionDays` | number | `180` | Days events, moments and model calls are kept |
| `decayFactor` | 0 to 1 | `0.95` | How fast memory scores fade each day |
| `refutationEnabled` | boolean | `true` | The skeptic that checks whether held facts still hold |
| `memory.embeddings` | boolean or `"ask"` | `true` (`install` asks and writes your answer; the packaged app's first run writes `"ask"` and `/setup` asks) | The search model (`all-MiniLM-L6-v2`, about 90 MB from huggingface.co, downloaded once). `false` or `"ask"`: it is never downloaded or loaded, and search matches words only. A switch in Settings, under What may leave this Mac; applies at once |
| `pollIntervalMs` | number | `1000` | How often the sensors are polled, in ms (minimum 200) |

## `llm`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `providers` | object[] | `[]` | More model routes: `id`, `baseUrl`, `model`, optional `label`, `protocol` (`openai-chat`, `anthropic-messages`, `openai-responses`), `hedgeTo`, `body` (extra request fields). See [models.md](models.md) |
| `roles` | object | `{}` | Sources in order per role: `chat`, `background`, `judge`, `jobs`. Entries: `openai`, a provider id, `claude`, `copilot`, `jev`, each with an optional `:model` |
| `use` | object | `{}` | Provider per background purpose (`default`, `intent`, `journal`…) |
| `sources` | object | `{}` | `claude` or `copilot` runtimes; `path` when the binary is not on your PATH |
| `contextWindows` | object | `{}` | Context window per model id |
| `compactAt` | number | built-in | Prompt tokens at which a chat is compacted after its turn |
| `compactKeepFront` | boolean | `false` | Keep the chat's start and append the summary behind it |
| `connectMs` | 2000 to 30000 | `7000` | No HTTP answer in this time: go to the backup |
| `hedgeAfterMs` | number | `8000` | No first token in this time: send once more. `0` is off |
| `stallMs` | number | `20000` | Silent stream before any text: send once more. `0` is off |
| `chatReasoning` | `off`, `low`, `medium`, `high` | model default | Reasoning effort of a chat turn |

`budgets` (object, default `{}`) sets a daily call limit per purpose, e.g.
`{"intent": 3000}`. The defaults are in [models.md](models.md#daily-limits-per-purpose).

## `actions`: what Gnomon may do

A policy is `off` (the tool is not loaded), `ask`, or `auto` (the chat's Ask /
Auto chip decides). This block can only make Gnomon stricter than the chip.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `actions.internal` | policy or map | `auto` | Writes to Gnomon's own record |
| `actions.outward` | policy or map | `off` | Everything that reaches outside: `run_shell`, `calendar_create`, `reminder_create`, `web_act`, `screen_act`, `screen_undo`. A map takes `all` plus per-tool keys |
| `actions.earnAfter` | 1 to 100 | `10` | Yeses in a row before plain screen steps of one kind in one app stop asking, when the tool's policy is `auto`. Never typing or final steps |

See [screen-acting.md](screen-acting.md).

## `experiments`

| Field | Default | Meaning |
|---|---|---|
| `screenLook` | `true` | Gnomon may read an app window |
| `screenMarks` | `true` | Gnomon may point at a control |
| `screenGuide` | `true` | Gnomon may guide you step by step |
| `screenAct` | `true` | Gnomon may act, once `actions.outward` allows `screen_act` |
| `screenActUnasked` | `false` | Plain screen steps run without asking. Finals still ask |
| `screenFast` | `false` | A step named by intent is picked by code, else by Jev (labels only, never values) |
| `screenFastRoutes` | `false` | Match a learned route to your words and replay it. Sends your words to Jev |
| `screenStage` | `false` | Place the windows Gnomon works in side by side, and put them back after |
| `maskOldLooks` | `false` | Shorten old screen looks in the chat history to one line |
| `screenPanelKeys` | `false` | Steer Save and Open panels by keys instead of clicks |
| `windowCapture` | `false` | Keep a picture of a window that has no readable controls (newest three, on this Mac, never sent) |
| `holdToTalk` | `true` | Hold the summon key and speak |
| `quietSummon` | `true` | The slip comes up without taking the keyboard |
| `voiceKnock` | `true` | A soft sound before Gnomon says a notice aloud |
| `stuckSigns` | `true` | Two signs of being stuck make one notice |
| `offerNow` | `true` | A window held a few minutes asks the model once for one offer of help; the notice gate decides if it is said |
| `witnessPairs` | `true` | Check that sensors that should agree do |
| `forecasting`, `gateFeatures`, `ownerStateInGateCost`, `presence` | `false` | Research switches |

## `overlay` and `voice`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `overlay.enabled` | boolean | `true` | The slip over your apps |
| `overlay.hotkey` | string | `option+space` | The summon key, e.g. `cmd+shift+g` |
| `voice.engine` | `kokoro`, `system` | `kokoro` | Gnomon's voice. Falls back to the system voice |
| `voice.name` | string | unset | A voice of that engine |
| `voice.python` | path | unset | A Python with mlx-audio and Kokoro. Unset: the system voice speaks |

## `web`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `web.knownHosts` | string[] | Wikipedia, Wikimedia, Wiktionary, GitHub, Stack Overflow, developer.apple.com, MDN, npm, nodejs.org, python.org | Hosts a web call may reach after a private read without asking, when it carries no data. Replaces the list |

## `notifications`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | macOS banners for strong notices |
| `ntfy` | URL | unset | Push notices to this ntfy topic |
| `verdictUrl` | URL | unset | Your Tailscale Serve address for the :8767 listener; adds Useful / Not now / Wrong buttons to a push |
| `inbox` | URL | unset | An ntfy topic the phone posts events to |
| `pushAtMac` | boolean | `true` | Also push while you are at the Mac |

## `jobs`: the night shift

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Run jobs you ask for on your own Claude Code while you are away, each in its own worktree, never pushed |
| `maxJobsPerNight`, `maxMinutes` | number | `2`, `90` | Limits |
| `maxUsdPerJob`, `maxUsdPerNight` | number | `2`, `5` | Spend limits, from Claude's own cost record |

## `integrations`

A list of your own MCP servers. Their tools appear to Gnomon as
`mcp__<name>__<tool>`. Each call is an outward write that asks, unless its name
is in `reads`.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | 1 to 32 letters, digits, `_` or `-` |
| `enabled` | boolean | Default `true` |
| `transport` | `stdio`, `streamable-http` | |
| `command`, `args`, `env`, `cwd` | | For `stdio` |
| `url`, `headers` | | For `streamable-http` |
| `reads` | string[] | Tool names or `prefix*` globs that only read |
| `toolCallTimeoutMs` | number | Default 30,000 |

Values of `env` and `headers` written as `$NAME` or `${NAME}` are read from
`.env`. An integration whose secret is missing is skipped.

```json
{ "integrations": [{ "name": "notes", "transport": "streamable-http", "url": "http://127.0.0.1:27124/mcp", "headers": { "Authorization": "Bearer ${NOTES_TOKEN}" }, "reads": ["search*", "read*"] }] }
```
