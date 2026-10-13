# Validation and live test instructions

Normal Rust tests are offline and never join Aternos, contact AI providers, or accept a Minecraft EULA. `tests/java_integration.rs` is marked `#[ignore]`; normal `cargo test` compiles it and reports it as unrun.

Current test groups cover all 18 typed action shapes, every command, invalid coordinates/counts/actions, authorized UUIDs, rate windows, stop latching, bounded queues, task replacement, follow cancellation/replanning/unloaded entities, registry hardness, tool family/tier, efficiency/haste/fatigue/environment speed, long digs, block changes, tool break failures, occupied builds, inventory mock counts, missing cursor/player inventory packets, server-identity presence, multiple humans, disconnect classification, AI failover/invalid responses, redaction, memory persistence and repeated ECS shutdown.

The continuation adds complete vanilla item-property/registry checks, component overrides/removals, legacy memory conversion and CLI validation, neutral-mob damage attribution, UUID-pinned teammate defense, dangerous-mob metadata, a real ECS movement-guard regression, late callbacks/actions after teardown and cancelled container replies. A process-level test keeps stdin open and verifies that `quit` still terminates the bot, including after oversized input. **67 Rust tests pass**, with the real-server fixture still ignored.

The retained TypeScript suite passed 388 tests in 16 files. A fresh `npm ci --ignore-scripts` failed because `@types/mineflayer-pathfinder@^2.4.5` returned npm 404. Baseline tests used a junction to the already installed dependencies in the existing checkout; package.json/package-lock.json were left intact. That dependency problem does not affect the Rust runtime.

## Disposable Java test server

The owner requested leaving this ready rather than accepting the Minecraft EULA. No `eula=true` file was written or Java server started during this migration run.

1. Review [Minecraft's EULA](https://www.minecraft.net/eula).
2. If you agree, run `./scripts/local-server.ps1 -AcceptEula` with Java 21 installed. The script downloads the official 1.21.4 jar, verifies its Mojang manifest SHA-1, binds Minecraft to loopback, generates a temporary RCON password, and creates a disposable flat world under `.test-server/`.
3. Set `MC_TEST_DISPOSABLE=yes`, `MC_TEST_PORT=25575`, `MC_TEST_RCON_PORT=25576` and the generated `MC_TEST_RCON_PASSWORD` in a second terminal. Read the password from the private `.test-server/server.properties` file; do not share or commit it.
4. Run `cargo test --test java_integration -- --ignored --test-threads=1` in the second terminal. On this Windows GNU setup, use `cargo +nightly-2025-03-01-x86_64-pc-windows-gnu` with the GCC directory on PATH and the documented target directory.
5. Type `stop` into the Java server terminal after testing. Retain logs if a failure occurs. RCON credentials and the test world are ignored by Git.

The fixture sends setup commands only to its disposable loopback RCON server. Those controls do not exist in the production bot. It verifies native spawn, movement, mining block removal, equip/placement, dropping, deposit/withdraw count conservation and cancelling a long obsidian dig. Further real tests for following another player, combat, food, signed online chat, chunks, latency and all structure types are still required before parity acceptance.
