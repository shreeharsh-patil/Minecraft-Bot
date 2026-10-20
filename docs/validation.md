# Verification record — 2026-10-13

Repository baseline: `e8a503aa878a1714a89936a098e2988be6ef71ac`. Work remains local in `D:\AI CRAFT'S\Minecraft-Bot`; the original TypeScript source, tests, package files and original environment example are unchanged. README has a migration notice and .gitignore covers Rust output. Native files are added alongside the original.

## Passed

- Rust formatting: `cargo fmt --all -- --check`.
- Rust linting: `cargo clippy --workspace --all-targets --locked -- -D warnings`.
- Rust tests: **67 passed**, one real-server fixture ignored by explicit owner preference.
- Windows release executable: `cargo build --release --locked`, opt-level 3, thin LTO, one codegen unit, abort panics, stripped symbols.
- Executable smoke checks: `--help` and `--check-config` with no AI keys configured.
- Original TypeScript suite: **388 passed in 16 files**, using the previously installed dependency tree. A fresh npm install failed at that baseline on the retained unavailable @types package; that devDependency has since been removed and `npm ci` resolves cleanly. See [testing](testing.md).
- Original-source preservation and whitespace diff checks.
- Missing native inventory packets, stale cleanup after disconnect, valid cleanup event non-replay and RSA chat-signature integrity regressions.
- All 1,385 Mojang item defaults checked against pinned protocol IDs; component override/removal and worn-tool regressions.
- Offline legacy memory import, source/destination preservation, native-v2 compatibility, bounded and scrubbed context, and configuration-free CLI conversion.
- Server damage attribution for neutral threats, UUID-pinned teammate protection, dangerous-mob metadata/retreat, actual ECS movement guard, late gameplay reads/actions after teardown and cancelled container replies.
- A real child-process test verifies that `quit` terminates while stdin remains open, including after oversized input. The waiting-process smoke test exposed Tokio's uncancellable stdin reader; it was replaced with the dedicated input-thread pattern described in [Tokio's pinned stdin documentation](https://docs.rs/tokio/1.43.0/tokio/io/fn.stdin.html).

Rust commands here used the explicit `nightly-2025-03-01-x86_64-pc-windows-gnu` override, GCC on PATH, and `CARGO_TARGET_DIR=D:\minecraft-rust-build` because GNU response files mishandle the workspace apostrophe. Cargo.lock records the patched dependencies described in the [dependency review](dependency-review.md).

## Not run / acceptance still open

No Minecraft server was started and no EULA was accepted. The owner selected leaving live tests ready. No Aternos address/version/authentication details were supplied. Microsoft device login, live AI API calls, real survival/combat, all-feature gameplay parity, Linux/Docker, ARM64 and identical active performance comparisons are unverified.

The Docker engine did not respond locally. CI workflows are supplied but have not run on GitHub. Source inventory maps contracts/modules; it is not evidence that all 388 legacy assertions have equivalent Rust coverage. Traversal, live gameplay and upstream dependency gates are explicitly listed in [migration acceptance](migration.md).

The native runtime is 100% Rust; the overall feature migration is **not yet verified complete or production-ready**. Do not delete the original implementation.

The earlier Windows artifact was 18196480 bytes, SHA-256 `611b313906f68e252a71ab62ecb78aa747a282248054ffbc4daf802bb8bf9974`. The continuation rebuild supersedes it; the final size/checksum is recorded below and in `artifacts/build-info.json`. The executable has no Node/Mineflayer runtime dependency.

Mojang's checksummed jar was run only with its data-generator entry point to obtain item reports. It did not start a Minecraft server, accept the EULA or write `eula=true`. This supplies authoritative registry/property facts, not evidence of live gameplay.

The pre-console-fix continuation artifact was 18,334,720 bytes, SHA-256 `37e27abff8daa57c84c65479498c64a924c55f4b4d3719386620fe7be9ab76bd`. It is superseded by the final rebuilt artifact recorded below. The original TypeScript source, package files, environment example and tests remain unchanged; its earlier 388-test result was retained, without a redundant rerun.

Final continuation Windows executable: **18,324,480 bytes**, SHA-256 `176e212a13998103233b21a5e0fbe4bc0822175b97cd6595606e6dd0cc5634a6`. Formatting, strict Clippy, all 67 Rust tests and the locked release build passed after the console fix. Release `--help`, `--check-config` and clean console shutdown passed. In the final waiting-process observation, `quit` terminated with exit code 0 in 10.16 ms while the stdin pipe remained open. No companion process was left running.

## Legacy-assertion translation continuation (2026-10-13, later session)

The open "388 assertions not translated one-for-one" gate was worked directly:

- New `tests/legacy_parity.rs` (19 tests) translates the assertion suites that previously had no direct native counterpart: `tests/commands/commandParser.test.ts`, `tests/config/config.test.ts`, `tests/safety/promptInjection.test.ts`, `tests/ai/providerFallback.test.ts`, `tests/ai/structuredActions.test.ts`, `tests/safety/limitsAndGrief.test.ts`, and the memory-persistence assertions from `structuredActions.test.ts`. Skill-level and core regressions remain in `tests/native_skills.rs` / `tests/native_core.rs`.
- Three real parity gaps found by that translation were fixed in native code, not papered over in tests:
  1. `AI_PROVIDER_PRIORITY` now normalises casing/whitespace and ignores unknown names (legacy `buildConfig` semantics) while still refusing a list that names no known provider.
  2. AI plan parsing (`actions::parse_plan`) now extracts a balanced JSON envelope embedded in prose, matching the legacy `extractJson` behaviour; everything outside the envelope is ignored and still passes the closed allowlist.
  3. `!follow <player> <distance>` drops a non-positive distance instead of trusting it (legacy `toAction` semantics).
- Where native behaviour is deliberately tighter than the TypeScript version, tests assert the documented native semantics: malformed deterministic arguments fail locally instead of falling through to AI, plans over eight actions are refused rather than truncated, `DISCONNECT_WITHOUT_HUMANS=false` is rejected, and `!follow` without a name defaults to the requester.
- CI after the change: `cargo fmt --all -- --check` passed; `cargo clippy --workspace --all-targets --locked -- -D warnings` passed; `cargo test --workspace --locked` passed with **86 tests** (67 prior + 19 new) plus the one ignored live-server fixture; `cargo build --release --locked` passed.
- New final Windows executable: **18,328,576 bytes**, SHA-256 `090a2973bdf6fc4904b53796bf258ae78ba38c204b5c093ab588a469b246abd3`. Release `--help` smoke check passed (exit 0).
- Still not run in this session: live Minecraft server gameplay, Microsoft device login, real AI provider calls, Linux/Docker/ARM64 builds, and identical active TypeScript-vs-Rust benchmarks. The migration acceptance gates in [migration.md](migration.md) that depend on those remain open. The original TypeScript implementation is retained.
