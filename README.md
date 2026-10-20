# minecraft-ai-bot

**Native Rust migration:** a separate Java 1.21.4/protocol 769 executable now lives in `native/`. Build with `cargo build --release --locked`; configure it using `.env.native.example`. Read the [native guide](native/README.md), [migration acceptance gates](docs/migration.md), [tests](docs/testing.md), and [deployment constraints](docs/deployment.md). The original implementation below is retained. Full feature parity and live-server validation are **not yet verified**.

A Minecraft Java Edition companion bot for a small, owner-run server. It connects as a
normal client with [mineflayer](https://github.com/PrismarineJS/mineflayer), listens to
chat from a fixed allowlist of players, and turns their instructions into in-game actions.
Anything prefixed with `!` is handled deterministically in-process and never touches an
LLM; anything else is treated as natural language and sent to a multi-provider LLM
planner whose output is validated against a closed action allowlist before anything is
executed. The bot is explicitly **not** an AFK/keep-alive tool — see
[Aternos setup](#aternos-setup).

## Features

- Two-path chat handling: a deterministic `!` command parser (no AI, instant response)
  and a natural-language path that goes through the planner.
- Only usernames in `AUTHORIZED_PLAYERS` can issue instructions. Everyone else may talk,
  but their text is never treated as an instruction.
- Multi-provider AI with automatic fallback: Groq, Gemini, OpenAI and OpenRouter, each
  with its own key, model, latency tracking and circuit breaker.
- Closed action allowlist: the model can only emit one of 17 typed action shapes.
  Everything else is dropped before execution.
- Multi-step planning: one request produces a sequence of validated actions that the
  executor runs as a cancellable task.
- Task arbitration by conflict group (`movement`, `mining`, `building`, `inventory`,
  `combat`), so "follow me" and "mine 20 logs" cannot fight over the bot.
- Safety layer: per-action rate limiting, per-task mining/building ceilings, per-command
  rate limiting per player, prompt-injection sanitisation, secret redaction and
  anti-grief rules that protect player-built structures.
- Secret redaction in both logs and in-game chat replies (keys, tokens, filesystem paths
  and host addresses).
- Aternos safe mode: the bot disconnects itself when no authorized human has been online
  for `HUMAN_TIMEOUT_SECONDS`.
- Bounded exponential-backoff reconnect after connection loss, and immediate cancellation
  of all work on `!stop`, `SIGINT` or `SIGTERM`.

## Requirements

- **Node.js >= 20.11** (`engines` in `package.json`). Node 22 LTS is what the
  `Dockerfile` targets.
- A reachable **Minecraft Java Edition** server. `.env.example` ships an Aternos host as
  the example, but any Java Edition server the bot's account can join will work.
- **No AI provider API keys are required.** With `AI_LOCAL_PLANNER=true` (the default)
  the bot plans every request with its built-in algorithmic brain - pattern
  matching, fuzzy-matched word tolerance, number words and world-grounded
  targets. Optionally add keys (`GROQ_API_KEY`, `GEMINI_API_KEY`,
  `OPENAI_API_KEY` or `OPENROUTER_API_KEY`) for a smarter LLM planner; any
  detected key is used automatically and the rest is skipped.
- A Microsoft account that owns (or can join) the server, for `MC_AUTH=microsoft`.

## Installation

```bash
npm install
```

On Windows/PowerShell use `npm ci` for a clean, lockfile-exact install.

Create your environment file:

```bash
cp .env.example .env            # Linux/macOS
Copy-Item .env.example .env     # PowerShell
```

Then edit `.env`: set `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `AUTHORIZED_PLAYERS` and at
least one provider API key. `.env` is gitignored (`.gitignore` lists `.env` and
`.env.*`, with an explicit `!.env.example` exception), so it will never be committed.

**No API keys are hardcoded anywhere in this repository.** Every provider key, model
name, host and limit is read from the environment in `src/config/config.ts`. Startup
validates the whole environment and reports every problem at once.

## Aternos setup

The bot connects as a plain Minecraft client, so an Aternos server needs no plugins
or mods — only the `.env` values below. In the Aternos panel open **Options →
Server properties** (and **Settings**) to check each item:

| Aternos setting | What to put in `.env` |
| --- | --- |
| Address (`xyz.aternos.me`) | `MC_HOST=xyz.aternos.me`, keep `MC_PORT=25565` (the default port is what triggers the SRV lookup Aternos relies on) |
| `online-mode=true` (default) | `MC_AUTH=microsoft` with an account that owns the game |
| `online-mode=false` (cracked) | `MC_AUTH=offline` — startup logs a loud warning instead of failing, by design |
| Whitelist enabled | Add `MC_USERNAME` to the Aternos whitelist, otherwise the kick is fatal and never retried |
| Version / software (Vanilla, Paper, Fabric, Forge) | Leave `MC_VERSION=` empty — the bot auto-detects the version, so Aternos updates need no change |
| Max players = 1 with the bot already in | The bot is a normal player: it occupies a slot while connected |

Things to know about running on Aternos:

- **Start the server first.** Aternos servers sleep when empty; if the bot starts
  while the server is offline it retries with backoff (`MAX_RECONNECT_ATTEMPTS`,
  default 5) and then exits with a clear error rather than looping forever.
- **Restarts are retried, not fatal.** A vanilla `Server closed` /
  `multiplayer.disconnect.server_shutdown` kick triggers the same bounded
  reconnect loop, so the bot comes back after a routine Aternos restart. Only
  unrecoverable kicks — whitelist, ban, authentication, outdated version — stop it.
- **Aternos safe mode keeps you in control.** The bot never holds the server awake:
  with `DISCONNECT_WITHOUT_HUMANS=true` (default) it leaves after
  `HUMAN_TIMEOUT_SECONDS` (default 60) without an authorized player online.
- **Free servers are slow.** If startup logs show `waiting for spawn` timeouts,
  raise `MC_SPAWN_TIMEOUT_MS` (default 60000) to 90000–120000. The keep-alive
  check is already relaxed to 120 s to survive world-save lag spikes.
- **Bedrock is not supported.** Aternos Bedrock servers (port 19132) cannot be
  joined by this bot; the server must be a Java Edition Aternos instance.

## Deploy the bot on Render (bot in the cloud, server on Aternos)

Render hosts the **bot process**; your Aternos instance stays the game server.
The repo ships a [`render.yaml`](render.yaml) blueprint, so the whole deploy is
one click plus a few environment variables.

1. Push the repo to GitHub (already done) and open **Render → New → Blueprint**,
   pointing at `shreeharsh-patil/Minecraft-Bot`. Render reads `render.yaml`.
2. Fill in the `sync: false` variables Render asks for:

| Variable | Value | Notes |
| --- | --- | --- |
| `MC_HOST` | your Aternos address, e.g. `myserver.aternos.me` | the address from your Aternos panel |
| `MC_PORT` | `25565` | leave as is - the default port is what triggers the SRV lookup Aternos relies on |
| `MC_USERNAME` | your Microsoft account's gamertag | with `MC_AUTH=microsoft` the in-game name comes from the account |
| `MC_AUTH` | `microsoft` | use `offline` only for cracked servers |
| `AUTHORIZED_PLAYERS` | `shreeharsh` | comma separated; matching is case-insensitive |
| `AI_LOCAL_PLANNER` | `true` | already the default - no AI key needed |
| `LOG_FORMAT` | `json` | Render reads structured logs best this way |

3. Start your Aternos server before the first deploy. A sleeping Aternos
   instance refuses connections, and the bot's reconnect loop will keep retrying
   until the server is up.

### First login (Microsoft device code)

The bot signs in with a Microsoft account and there is no browser on the server,
so the **first** deploy asks for a device code:

1. Open the Render logs and look for the Microsoft sign-in URL plus a code.
2. Open that URL on any device (phone is fine), paste the code, sign in.
3. The token is cached in `MC_PROFILES_PATH` (`/opt/render/project/src/.minecraft-auth`).

Render's filesystem is ephemeral, so after a redeploy the bot asks for the code
again unless you attach a **Render Disk** mounted at that path (a paid add-on).
Without a disk this is a 30-second inconvenience, not a blocker.

### Free tier: keep the bot awake

Render's free tier suspends a web service that receives no traffic, and the bot
is a TCP client, not a web app - so the bot runs a tiny health endpoint
(`HEALTH_PORT`, defaulting to the port Render injects) that answers `200 ok`.
To stop the free tier from sleeping it, ping the service every ~10 minutes with
a free uptime service (UptimeRobot / cron-job.org) pointed at
`https://<your-service>.onrender.com/`.

For an always-on bot without pingers, use a paid **Background Worker** instead:
change `type: web` to `type: worker` in `render.yaml` and drop `healthCheckPath`.
A worker still needs `MC_HOST` and the rest of the variables above, but nothing
HTTP-related.

### Aternos notes for a cloud-hosted bot

- **Whitelist:** if your Aternos panel has the whitelist enabled, add the bot's
  gamertag to it, otherwise the join is rejected and treated as fatal.
- **Safe mode:** `DISCONNECT_WITHOUT_HUMANS=true` (default) makes the bot leave
  after 60 s without an authorized player online, so it never holds an Aternos
  server awake on its own. Keep it on.
- **Free servers are slow:** if the logs show `waiting for spawn` timeouts, raise
  `MC_SPAWN_TIMEOUT_MS` to `90000`-`120000`.

## AI configuration

### Works with zero API keys (default)

`AI_LOCAL_PLANNER=true` is the default, so the bot starts without any key and understands
plain chat like a person would:

```
follow me          | folluw me          (typo tolerated)
mine 20 logs       | mine twenty cobblestone | collect a few wood
bring me 10 wood   | come here          | protect me
hold the sword     | eat steak          | build a wall here
what can you do?   | where are you?     | how many oak logs do you have?
```

The algorithmic planner: normalises the text (drops politeness, expands contractions,
keeps number words like "twenty"), spots the verb, resolves quantities, then grounds the
target against live world state (block names standing nearby, inventory contents, player
names), emits the same closed-allowlist actions the LLM path produces, and answers
questions from its own static Minecraft knowledge plus live world/context data (status,
inventory, coordinates, time of day, nearby threats, how-to tips). It even has
self-preservation: a hurt bot snacks before it works, and a hostile three blocks away
gets attacked before anything else.

If an API key IS present, the bot uses it instead: providers then handle everything
above automatically. `AI_LOCAL_PLANNER=false` restores the old behaviour requiring a key.

The bot ships adapters for four providers:

| Provider | Endpoint | Default model |
| --- | --- | --- |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |

Set `AI_PROVIDER_PRIORITY` to control order. Providers without an API key are skipped
automatically. The router tracks latency, successes, failures, timeouts, 429s and
availability per provider, prefers the fastest healthy provider for normal requests, and
falls back down the list on failure. A provider that keeps failing trips a circuit breaker
and is dropped from the pool for `AI_CIRCUIT_COOLDOWN_MS` before being retried, so a dead
API never slows every request.

All keys come from environment variables only. Nothing is read from a file baked into the
image, and no key is ever written to a log or echoed into Minecraft chat.

## Security notes

- **Closed action allowlist.** The planner can only emit `move_to_player`,
  `move_to_position`, `follow_player`, `stop`, `mine_block`, `collect_resource`,
  `place_block`, `build_structure`, `equip_item`, `drop_item`, `deposit_items`,
  `withdraw_items`, `pickup_items`, `eat`, `attack_hostile`, `defend_player`,
  `look_at`, `wait` or `say`. Anything else is dropped and logged.
- **One validation funnel.** Every action - from the LLM planner, from the
  offline planner and from the `!` commands - is validated by the same
  validator before it reaches a skill. Invalid parameters are refused, not
  coerced into something plausible.
- **No arbitrary execution.** The model can never run JavaScript, shell commands or
  Minecraft server commands. It produces data; the executor decides what is allowed.
  A chat line starting with `/` is a server command, so it is rejected in both
  the validator and the chat reply gate.
- **Prompt-injection defence.** Player chat is sanitised, wrapped as untrusted data,
  stripped of injection markers, and requests for credentials, environment variables,
  files or shell access are refused outright. The allowlist means injected text cannot
  become executable even if the model is misled.
- **Authorization.** Only names in `AUTHORIZED_PLAYERS` can issue orders. Everyone else may
  talk nearby; their messages are never treated as instructions.
- **Rate limiting.** Per-player command limits and a global action ceiling prevent floods.
- **Secret redaction.** API keys, tokens and paths are redacted in logs and in every chat
  message the bot sends.
- **Anti-grief.** The bot refuses to break chests, crafting tables, farms, player-placed
  blocks and protected structure blocks, and will not tunnel through a player's build just
  because the requested block is inside it.
- **`.env` is never committed**, and Microsoft tokens stay in the profile directory.

## Architecture

```
src/
  index.ts            composition root: config -> connect -> wire -> lifecycle
  bot/                mineflayer connection, facade, events, reconnect, human presence
  chat/               chat listener, command parsing, response formatting
  commands/           deterministic local commands (help, status, inventory, remember)
  skills/             the only way anything happens in the world
    movement/ mining/ building/ inventory/ survival/ basic/ combat/
  ai/                 AIManager, AIRouter, planner, context builder, memory
    providers/        BaseProvider + one adapter per provider + ProviderPool
  executor/           action validation, task manager, action executor
  world/              compact world state with caching
  safety/             permissions, rate limits, anti-grief, injection guard
  config/             environment loading and validation
  utils/              logger, redaction, retry, cancellable sleep
  types/              shared contracts (actions, tasks, skills, facade, provider)
```

Layering is enforced by types: skills depend on a narrow `MinecraftFacade` interface rather
than mineflayer, so they are unit-testable without a server, and only
`bot/mineflayerFacade.ts` knows the mineflayer API.

## Testing

```bash
npm test
```

Covers command parsing, authorization, AI provider fallback and circuit breaking,
structured-action validation, prompt-injection protection, secret redaction, task
cancellation, rate limiting, anti-grief limits, configuration validation, and the movement,
mining, inventory, building and survival skills (run against an in-memory fake facade, so no
server is needed).

It also covers the two paths that are easy to break silently: the **chat payload format**
(mineflayer changed the shape of the `message` event - a wrong read makes the bot mute) and
the **end-to-end request path** from a chat line to a world action (`tests/integration`).

CI runs the whole gate on every push: `npm run typecheck`, `npm run lint`, `npm test` and
`npm run build` (`.github/workflows/typescript.yml`).

## Troubleshooting

**Configuration error on startup.** `buildConfig` prints every problem at once, for example
`MC_HOST is required (see .env.example)`. Fix the listed variables and restart.

**"No usable AI provider".** Only appears when `AI_LOCAL_PLANNER=false`: the provider named
in `AI_PROVIDER_PRIORITY` has no matching API key variable. Either set the key, drop that
provider from the priority list, or leave `AI_LOCAL_PLANNER=true` (the default) to run the
built-in offline planner instead - with no key at all the bot still starts and answers.

**Bot disconnects after a minute.** That is Aternos safe mode working. Raise
`HUMAN_TIMEOUT_SECONDS` if you idle longer than that, or set
`DISCONNECT_WITHOUT_HUMANS=false` for a server that is always on.

**Kicked on join.** Usually the account is not whitelisted, the username is already in use,
or the server is Java Edition and not Bedrock. Check `MC_USERNAME` and the server's
whitelist/online-mode settings.

**Connection errors or repeated reconnects.** `MAX_RECONNECT_ATTEMPTS` (default 5) bounds
retries with exponential backoff, so there is no infinite loop. Permanent failures such as
whitelist or authentication errors are never retried.

**429 rate limits.** The router counts 429s, trips that provider's circuit breaker and falls
back to the next healthy provider automatically. Add another provider to
`AI_PROVIDER_PRIORITY` to reduce the chance of running out of quota.

**AI requests seem slow.** Lower `AI_REQUEST_TIMEOUT_MS`, or set `AI_PLANNING_MODEL` so
multi-step planning uses a capable model while simple steps stay on a fast one.

**"not authorized".** The requesting player's exact Minecraft username is not in
`AUTHORIZED_PLAYERS`. Names are compared case-insensitively.

**Bot says it cannot work out a request.** The model returned something outside the
allowlist, or the plan was empty. The rejection reason is written to the log at `info` or
`debug`; set `LOG_LEVEL=debug` to see which actions were dropped and why.
