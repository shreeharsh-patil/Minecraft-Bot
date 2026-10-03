# Implementation and verification

Official mindcraft-bots/mindcraft develop baseline: `5f3acc8`. Existing dashboard, telemetry, controls, histories and worker architecture are retained. Endurance update: 16 September 2026; gameplay update: 21 September 2026.

## Changed-file map

| Files | Responsibility |
|---|---|
| brain/gateway.js, transport.js | Central cloud requests, authentication, abortable timeout, Retry-After/reset hints, circuit breakers, same-model failover, latency and usage |
| brain/budget.js | Shared provider request/token ledgers, rolling minute/hour/day limits, six-hour pacing, 80/20 normal/emergency split, persisted reservations |
| brain/config.js, root brain.config.example.json | Cloud-only route validation, exact identity, free-account/limit confirmation, paid fallback disabled |
| brain/client.js | Bounded worker IPC request/cancellation |
| brain/runtime.js | Persistent strategic plans, common skills, event-driven reassessment, valid spawn checks, safe hold, death/respawn, emergency priority |
| brain/decision-context.js | Normal-budget planning envelope, compact command instructions and pruning of old observations without changing persistent memory |
| brain/gameplay.js, tests/gameplay.test.js | Actual resource/recipe observations, safe exploration, inventory-based shelter construction, movement guards and gameplay regressions |
| brain/preflight.js | LAN/disk/account/key/route checks and minimal shared-budget probes |
| backend/runtime-store.js | Atomic runtime snapshots, secret redaction and identity protection |
| backend/process-manager.js | Gateway IPC and persistent restore on genuine disconnect/restart; API failures do not recycle workers |
| backend/run-store.js, server.js | Separate Minecraft/brain/execution state, diagnostic failures, budgets and asynchronous startup preflight |
| worker.js, telemetry/runtime.js | Existing Agent lifecycle integration, preserved shared modes, real player/action telemetry |
| frontend/app.js, style.css | Brain identity/state in recording cards, public plan queue, budget/preflight diagnostics, handled-error filtering |
| upgrade-cloud.js, setup.js, root config/profiles | Preserve existing setup while selecting four cloud brains; no local model fallback |
| src/models/prompter.js | Gateway client replaces strategic SDK calls; no embedding/example API calls in endurance mode |
| src/agent/agent.js, action_manager.js | Death ownership, bounded action cancellation and nonfatal runtime errors while Minecraft remains connected |
| patches/mineflayer+4.33.0.patch | Both old scalar and newer grouped velocity packets; preserves other existing upstream patches |
| tests/endurance.test.js, endurance.integration.test.js | Reliability regressions, quota simulation and real-worker protocol lifecycle/soak |
| TECH_GPT_README.md | Beginner instructions, account requirements, exact providers, operational limits |

Paths without a prefix are relative to control-center, except where noted. Existing first-delivery changes to command outcomes, optional lazy vision dependencies, package pins, launchers, dashboard security and SSE remain in place. Normal upstream startup does not select the endurance runtime.

## One-punch root cause

Existing run `2026-09-16T11-35-35-640Z_ef72e41d` recorded health 20 → 19 followed by a kick and worker exit; the pattern repeated. The Minecraft server log reported `Invalid move player packet received`. There was no corresponding death event. Thus the observed disappearance was a kick while alive.

The nested minecraft-data version used by minecraft-protocol decodes entity velocity into packet.velocity.{x,y,z}; Mineflayer 4.33's handler read packet.velocityX/Y/Z. Undefined components became NaN and generated invalid movement after knockback. The patch accepts either packet shape for initial entity spawn and later velocity packets. It does not change health, damage, gamemode, difficulty or respawn rules.

## Architecture and limits

MinecraftState, BrainState and ExecutionState are independent. Provider failures update the brain state and circuit, retaining the worker and pending decision. The runtime retains objective, public goal/summary, bounded memories/history, named places, plan/index, last action, death context and player snapshot. Legitimate death invalidates only physical continuation and requests recovery after verified respawn. Genuine network loss can restart the worker and restore the same identity.

All selected agents share each provider's governor. Attempts reserve budgets before transport and before any further request. Local normal/reserve caps, rolling windows, spacing, fair queues, provider concurrency, Retry-After and remaining-token headers are enforced. Critical danger cancels an obsolete pending normal request so emergency priority is not stuck behind it. Finite cooldowns recheck automatically; permanently unavailable routes stay connected in safe hold. No promise of external uptime, zero 429s, successful survival or uninterrupted six-hour reasoning is made.

API output is bounded and parsed as a public JSON plan. Private reasoning is removed. No extra model calls are used for observer summaries or routine memory compression. Common Mineflayer survival modes still operate while the strategic brain waits. Arbitrary host code and mode/reset commands remain blocked.

Budget ledgers and runtime snapshots persist separately. Restarting the backend does not erase usage. An elapsed session renews its allocation at its configured time boundary while rolling daily usage, provider headers and cooldowns remain intact. Successful requests reconcile hour/day/session token accounting with measured usage; minute throttling retains the conservative reservation. Failed or unmeasured calls retain estimates. Disk event history intentionally grows; in-memory event windows, queues and model context are bounded.

Gameplay plans now include actual nearby resources, craftable recipes, inventory, recent failures and nearby chat. Valid multistep plans finish without an arbitrary periodic replan; repeated identical failed steps are blocked until conditions change. Healthy empty plans trigger reassessment. All bots receive the same exploration and shelter tools, using ordinary pathfinding, inventory and block placement. Optional automatic hunting, item pickup and elbow-room movement are disabled; eating, defense and evasion remain active. Arena movement profiles limit drops to one block and disable parkour/towers; directly underfoot mining is rejected. These restrictions reduce avoidable falls, but do not guarantee survival.

Preflight distinguishes Minecraft startup from immediate brain availability. Typed budget/queue deferrals, request timeout and temporary 429/502/503/504 responses allow a configured bot to join with a deferred cloud check. Real requests still obey gateway budgets. Missing credentials, paid/unapproved routes and permanent 401/403/404/410 failures remain blocked. This prevents quota pacing from unnecessarily disconnecting a healthy bot during a gameplay update.

## Original endurance verification (16 September)

- Complete final suite: **31 passed, 0 failed**, including all original tests, reliability cases and the worker lifecycle/soak. Total runner duration approximately 51 seconds. Dedicated ESLint and changed upstream JavaScript syntax checks passed.
- Node 25.5.0 on this PC; Mineflayer requires Node >=22.
- Mindcraft import smoke check passed (`node control-center/check.js`).
- All six patch-package patches reapplied successfully, including the updated Mineflayer patch.
- Original nine tests retained and passing. They cover metadata/privacy, profile validation, state isolation, local HTTP/SSE/control security, archives, ActionManager outcomes, real-worker boot/skills/pause/stop and model telemetry.
- New reliability tests cover success; 429/Retry-After; timeouts; 503/circuits; exact-model failover and wrong-model rejection; all routes unavailable then recovery; shared three-agent provider scheduling; normal/emergency reserves; six-hour fake-time RPM/RPH/RPD/TPM/TPH/TPD/session compliance; persisted budgets; free/paid gates; plan restrictions; death memory/objective retention; secret-redacted snapshot restore; duplicate/cancelled requests; low remaining-token headers; quiet recording feed with intact developer errors; critical-event priority.
- The real Mindcraft/Mineflayer worker integration uses an isolated Minecraft 1.21.6 protocol fixture and injected cloud transport. It verifies valid spawn health; one nonfatal hit with finite velocity; unchanged PID/connection through 429, 503 and timeout; recovery; actual protocol death/respawn in the same PID; genuine connection loss/reconnect with saved objective/history; and a 15-second stability segment after recovery. The latest lifecycle/soak portion took approximately 43 seconds. It checks bounded pending requests, event windows and snapshot size, stable PID and no duplicate-call storm.
- The protocol fixture is not a playable Minecraft world. It does not validate world geometry, long-term survival, every skill, provider account access or real-world death behavior. It is a short soak, not evidence proving absence of long-term memory leaks.
- Browser QA of production localhost state verified cloud preflight, provider budgets, separate brain/model display and Recording mode. No fabricated gameplay or test provider data is displayed in production.
- Minecraft localhost:55916 was unavailable during final verification. No cloud requests were made with the user's key because free-access/limit confirmation is pending. Earlier user-run server/telemetry evidence was used to diagnose the kick.

## Gameplay verification (21 September)

- All **52 tests pass** with `node --test --test-concurrency=1 control-center/tests/*.test.js`; dedicated ESLint passes. The default parallel run initially passed 48 tests and hit engine-loading timeouts in both worker fixtures; both fixtures passed independently and then in the full serial run (about 68 seconds). Final coverage includes budget-deferred startup without a cloud call, and continued rejection of invalid credentials/permanent provider failures.
- Gameplay regressions cover observed resources/recipes, structured plans, crafting-step continuation, failure memory, empty-plan recovery, chat, short-drop movement, underfoot mining, supported shelter layout/placement/interruption, provider output options, truncation rejection, session renewal and measured token accounting.
- Shelter construction is verified with simulated bot inventory and placement, not yet a completed live Minecraft build. Live play on 21 September verified Gemini completed a five-step spruce collection/crafting plan, with a crafting table, sticks and wooden pickaxe present in its inventory. Public chat reached the other bots. An additional explicit wood-recipe hint addresses generic `planks` requests observed from GPT; all 40 focused gameplay/endurance tests and lint passed after that change. Long-term survival remains unverified.

## Idle-stall correction (22 September)

Live GPT diagnostics showed `Request exceeds tokensPerMinute budget` with no retry time. The UTF-8 input reservation plus output allowance exceeded the normal 80% minute cap, while emergency priority could fit the same request. This explained why damage sometimes appeared to wake it. Worker initialization now supplies the normal input allowance; public planning context is compacted to that envelope while preserving current player inventory/health and the latest failure. The gateway rejects any remaining oversized request before queueing it indefinitely.

The user selected more active play within free limits. `quota.paceAcrossSession: false` removes only the six-hour spreading delay. Rolling windows, minimum spacing, daily/session caps, the emergency reserve, provider cooldowns and paid-route restrictions remain enforced. Existing installations retain endurance pacing unless this boolean is explicitly false.

Regression coverage includes consecutive plans without damage/chat, large multibyte history within an 8K TPM normal budget, immediate oversized-request rejection, and active pacing retaining minute/daily/reserve caps.

Validation: all **56 tests passed** with serial test-file execution (about 72 seconds); dedicated ESLint passed. `git diff --check` still reports whitespace in pre-existing Mineflayer patch context lines, which this change does not modify.

Live verification after restart: Gemini, GPT and Nemotron connected on port 55916. GPT's first normal planning request reserved 5,796 tokens (below its 6,400 normal cap). It gathered logs and crafted planks, automatically replanned after the 55-block shelter prerequisite failed, then crafted to 58 planks in the next plan. Its next shelter attempt truthfully failed because no supported 5x5 site was found. This verifies ordinary continuation and failure reassessment, not successful live shelter construction. Minute budgets and provider outages can still pause requests.

## Mandatory case coverage

22 September follow-up: repeated idle reports were separately traced to Gemini's normal daily cap, NVIDIA 503s, and missing craft prerequisites. With explicit user approval, the Gemini and Nemotron slots now temporarily select the existing GPT brain; original configs/runtime snapshots are archived in `data/model-switch-20260922-152650`. The dashboard names and actual model are explicit. No unapproved model substitutions or paid routes were added. Groq's extra local request/hour throttles were relaxed (12 RPM, 5-second spacing, 500 RPH and 200K TPH); the 8K TPM, 200K TPD, 500 RPD and existing session allocations remain shared and enforced, below the user-confirmed account request limits.

Shared crafting prerequisites execute inside the normal ActionManager with bounded resource gathering and interrupt checks. Placement tries at most four supported, unoccupied targets and verifies the block exists. The original upstream skill implementation is retained for unsupported recipes. Per-server verified route caching avoids spending a probe for every player on the same model and still performs key/free-route checks. Permanent authentication/model failures invalidate the cached proof.

Follow-up validation: all 64 tests passed with serial test-file execution, including the real-worker lifecycle, seven crafting/placement cases and shared preflight caching. Dedicated ESLint and `npm run arena:check` passed. The lifecycle test allows 60 seconds for initial cold Windows worker startup; its gameplay and recovery deadlines are unchanged.

Cases 1–8: gateway success/errors/Retry-After/same-model failover/recovery plus real-worker lifecycle test. Cases 9–11: shared scheduling, six-hour simulation and reserve assertions. Cases 12–16: death/respawn/reconnect integration and runtime memory/objective tests. Case 17: security/redaction/transport tests. Case 18: actual frontend feed rendering regression. Case 19: provider diagnostic events remain in the store. Case 20: configuration and returned-model identity checks.

## Remaining external setup

The user confirmed Google/Groq free access and NVIDIA free access without visible limits. NVIDIA uses explicitly permitted conservative local caps, not a claim of verified account limits. GPT-OSS uses Groq; deprecated NVIDIA and paid Cerebras GPT routes remain disabled. The user approved DeepSeek V4 Flash (`deepseek-v4-flash-0731`) on NVIDIA in place of unavailable V3.2. Gemini and Nemotron now use the approved temporary GPT profiles described above; their original profiles are retained. Paid fallback remains disabled. Provider timeouts and account quotas can still pause planning. A running Minecraft world opened to LAN is required for live gameplay.

On 21 September the approved DeepSeek endpoint returned HTTP 410 and authenticated NVIDIA model discovery no longer listed it. DeepSeek remains offline; no model substitution was made. Gemini, GPT and Nemotron can connect independently.

22 September live follow-up: all three configured GPT players joined LAN port 55916. GPT gathered logs, crafted planks and sticks, then automatically gathered the additional logs and prepared a crafting table for a wooden pickaxe; placement truthfully failed on its terrain. The Gemini slot received a real GPT plan after waiting in the shared queue, gathered wood, crafted planks/table/sticks, placed its table and successfully crafted a wooden pickaxe without user damage or prompts. Successful live shelter construction is not yet verified. Normal API requests are spaced roughly a minute apart by the conservative 8K TPM budget, so three players can still wait several minutes for decisions. No world, health, inventory or quota state was reset.
