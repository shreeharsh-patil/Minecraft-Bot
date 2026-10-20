# Migration acceptance gates

Baseline: `shreeharsh-patil/Minecraft-Bot` at `e8a503aa878a1714a89936a098e2988be6ef71ac`. All original TypeScript source and tests are retained. The separate existing checkout and its uncommitted changes were untouched. [Full retained-file/public-declaration inventory](source-inventory.md) includes 93 original tracked files and test expectations.

This is **not a verified 100% migration or a production-ready release**. The native runtime and all 18 action routes are implemented, but the following acceptance gates remain. Completed code, passed offline tests and unrun live tests are deliberately distinguished.

## Action parity

| Existing action | Rust implementation | Verification / remaining gate |
|---|---|---|
| move_to_player | Skills::execute / navigate | Mock movement; real dynamic approach unrun |
| move_to_position | Skills::navigate / NativeGame::start_path | Mock arrival/stuck/cancel; live fixture ready |
| follow_player | Skills::follow | Dynamic replanning, distance band, unloaded entity, cancellation mocks |
| stop | Scheduler::stop / NativeGame::stop | Repeated stop, stop latch, planning cancellation, task cleanup |
| mine_block | Skills::gather / NativeGame::dig | Registry hardness, family/tier, speed/effects, long dig, cancellation, block-change mocks; live fixture ready |
| collect_resource | mining::resource / Skills::gather | Inventory-target semantics, block/drop distinction; real drop collection unrun |
| place_block | NativeGame::place | Occupied-space mock, ray/reach checks in code; live fixture ready |
| build_structure | actions::build_plan / Skills::execute | Wall/platform/house geometry, doorway, budget and occupied-space mocks |
| equip_item | NativeGame::equip / equip_slot | Mock inventory; missing 1.21.4 inventory packets regression; live fixture ready |
| drop_item | NativeGame::drop_items | Mock count and chest routing; server delta verification; live fixture ready |
| deposit_items | NativeGame::transfer | Mock count; explicit container access; live fixture ready |
| withdraw_items | NativeGame::transfer | Mock amount; conserved server deltas; live fixture ready |
| pickup_items | Skills::pickup | Unverified pickup fails/cancels; actual pickup timing unrun |
| eat | NativeGame::eat | Food preference, hunger mock; requires both hunger increase and consumption in live code |
| attack_hostile | Skills::combat / NativeGame::attack | Hostile-only mock; requires server damage confirmation; real mobs unrun |
| defend_player | Skills::follow with guard / combat | Authorized target, duration/cancellation mocks; real combat unrun |
| look_at | NativeGame::look | Mock dispatch; real rotation unrun |
| wait | world::delay | Immediate cancellation, duration bounds, worker exclusivity |

Every original command remains in `chat::HELP` and `chat::parse`. `!follow` additionally defaults to the requester. `!stay` now performs full stop. Malformed deterministic arguments return a local error instead of being sent to AI. The duplicate legacy `ACTION_TYPES` constant omitted `pickup_items` and `build_structure`; native code has one closed action enum.

## Framework validation

Current published Azalea documentation identifies `0.16.0+mc26.1`; current main describes Minecraft 26.2. Neither matches the repository's 1.21.4 baseline. Source inspected: [Azalea official repository](https://github.com/azalea-rs/azalea), [stable documentation](https://docs.rs/azalea/), [pinned source](https://github.com/azalea-rs/azalea/tree/4fb6b077464e14f816e4c4fe54ff648e8c3d0ede).

Parity fixes applied in this continuation: `AI_PROVIDER_PRIORITY` now normalises casing/whitespace and ignores unknown names (matching `config.test.ts`) while still refusing a list with no known provider; AI plan parsing extracts a balanced JSON envelope embedded in prose (matching `BaseProvider.extractJson`); `!follow <player> <distance>` drops a non-positive distance instead of trusting it.

The `0.11.0+mc1.21.4` release commit could not resolve its git dependency graph because an internal chat dependency still required 0.10. The selected later 1.21.4 commit fixes those manifests and builds against protocol 769. Cargo.lock records exact transitive versions and git hashes. Nightly-2025-03-01 builds on Windows GNU; Linux/Docker and ARM64 have separate gates.

Verified source APIs: StartClientOpts/Client::start_client, EcsRunner schedules, Account/azalea-auth, GotoEvent/RadiusGoal, Inventory/Menu/operation encodings, block interactions, attack events, tab list and packet events. The native code adds mining effects/enchantments, missing cursor/player inventory handling, server-confirmed clicks and signed-chat envelopes; their production server behavior requires live validation.

## Open functionality / policy differences

- [ ] Owner confirms target Aternos Minecraft version, server address and authentication mode. Only 1.21.4 is compiled; no protocol auto-adaptation.
- [ ] Run real Java gameplay tests and expand them to every action, survival emergencies, latency, chunks, server disconnects and online-mode signed chat. The owner declined EULA acceptance during this run; no test server was started.
- [ ] Swimming, safe underwater routing, door-opening pathfinding and bridge placement are not implemented. Current safe movement supports ground walking/sprinting/jumping/elevation, avoids water/lava and bounds falls. It fails/holds when unsupported traversal is required. No claim of complete aquatic or bridge survival capability.
- [x] Neutral spiders/endermen and selected other neutral mobs become defensive targets only after a server damage event against the bot or an authorized teammate, including UUID pins. Tracking expires after 30 seconds and clears on despawn/respawn; player entities remain excluded. Wardens/bosses, angry-enderman metadata and active-creaking metadata trigger conservative avoidance/retreat. Destination and movement guards prevent dangerous approaches while allowing escape from inside a danger zone. Real combat/evasion remains in the live-test gate; route guards may hold when no safe route is found.
- [ ] Runtime custom datapack tool rules, enchantment effects and changed server tags are not fully supported. Vanilla 1.21.4 registry behavior is the supported physics baseline.
- [x] Default stack limits and durability for all 1,385 vanilla items come from Mojang's checksum-verified 1.21.4 reports. Stack component overrides and removals are tested. Custom component/tool/datapack behavior remains separately gated. See [item provenance](item-properties.md).
- [x] An offline native CLI imports all durable legacy memory fields into a separate new version-3 file, preserving fractional positions, metadata, preferences, useful coordinates and remembered trust. It requires the owner to supply the legacy dimension and never overwrites source/destination. Native version-2 files still load. See [memory import](memory-import.md).
- [x] Native fast/planning tiers now rank healthy providers by measured EMA latency, planning-capable provider/model preference, and configured tie order. Statistics are exposed through Manager::reports; request concurrency uses bounded rejection rather than the legacy unbounded FIFO wait queue.
- [x] The legacy assertion suites now have direct native translations in `tests/legacy_parity.rs` (19 tests): deterministic command parsing (`commandParser.test.ts`), configuration validation and provider selection (`config.test.ts`), prompt-injection and secret redaction (`promptInjection.test.ts`), provider fallback/circuit/ranking and structured-action validation (`providerFallback.test.ts`, `structuredActions.test.ts`), action limits and anti-grief categories (`limitsAndGrief.test.ts`), and memory bounds/persistence. Where behaviour intentionally differs from the TypeScript version the test asserts the documented native semantics: malformed deterministic arguments fail locally instead of falling to AI, plans over eight actions are refused rather than truncated, `DISCONNECT_WITHOUT_HUMANS=false` is rejected, and `!follow` without a name defaults to the requester. Skill-level assertions remain covered by `tests/native_skills.rs` and `tests/native_core.rs`; live-server assertions remain in the live-test gate below.
- [x] Tests cover late snapshots/actions after ECS teardown and cancelled/unsolicited container replies. Native inventory opening waits for server content, avoids required-component helper panics, and refuses a second open request while an earlier reply is pending. A missing reply may require a manual rejoin; no automatic reconnect was introduced.
- [x] Console shutdown no longer depends on another stdin line or EOF. A bounded dedicated input reader and a process-level regression cover `quit` while its stdin pipe stays open. Release shutdown was also measured successfully.
- [ ] Identical active TypeScript/Rust benchmarks, ARM64 hardware verification and Microsoft live-auth tests remain unrun.
- [ ] Close the remaining upstream resolver/crypto security gates described in the [dependency review](dependency-review.md). A successful compile is not a clean security audit.

Aternos safety deliberately tightens legacy behavior: `DISCONNECT_WITHOUT_HUMANS=false` is rejected, automatic reconnect is rejected for `.aternos.me`, self is excluded, and tab-list identity is distinct from spatial visibility. The bot has no Aternos website automation, restart mechanism or fabricated player activity. Published policy prohibits automatic reconnects and fake players used to prolong shutdown. [Aternos terms §5](https://aternos.gmbh/en/aternos/terms).

Do not remove the original implementation or announce feature parity until all required gates above are closed and evidence is attached.
