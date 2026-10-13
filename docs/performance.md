# Performance observations

Measurements were taken on the owner's Windows machine. These are observations of a specific build, not invented improvements over TypeScript.

| Measurement | Actual result | Scope |
|---|---|---|
| Disconnected WAITING RSS | 8,355,840 bytes (7.97 MiB), constant over 15 samples | Windows release executable, no server/AI traffic |
| WAITING CPU | 0.000 observed process CPU seconds over 15.181 seconds | Windows timer resolution; means below measurable CPU activity, not a mathematical guarantee of zero CPU |
| Configuration-only startup | Mean 11.05 ms, min 9.78 ms, max 19.42 ms over 10 invocations | Warm local launch plus config validation; excludes Minecraft spawn and Microsoft login |
| Binary size during measurement | 18,438,656 bytes initially; subsequent native refinements can change the final artifact | Release opt-level=3, thin LTO, one codegen unit, abort panics, stripped symbols |
| Connected idle / active RSS, CPU | Unmeasured | Requires controlled gameplay |
| Follow latency / pathfinding time | Unmeasured | Requires identical server/terrain/player workload |
| Mining / AI overhead | Unmeasured | Requires real server/API response workload |

Raw waiting samples: [JSON](benchmark-waiting-windows.json). Startup samples: [JSON](benchmark-startup-windows.json). The sampled waiting executable SHA-256 was `67307771195425abb3fa4d0142a2a177d32438cf42928291ee1171d73f920806`; it precedes the final code refinements. No conclusion about Rust-versus-TypeScript gameplay performance follows from these disconnected measurements.

## Continuation release observation

The final executable `176e212a13998103233b21a5e0fbe4bc0822175b97cd6595606e6dd0cc5634a6` was sampled after the memory, item, threat and shutdown fixes. It waited offline with no AI keys configured or server traffic:

| Measurement | Actual result |
|---|---|
| WAITING RSS | 7,151,616 bytes (6.82 MiB), constant across 15 samples |
| WAITING CPU | 0.000 observed process CPU seconds over 15.125 seconds; below Windows timer resolution |
| Console quit | Exit code 0 in 10.16 ms with redirected stdin still open |
| Executable size | 18,324,480 bytes |

[Final raw samples](benchmark-waiting-continuation-windows.json) include the executable hash, observed shutdown time and exit code. The [pre-console-fix sample](benchmark-waiting-pre-console-fix-windows.json) used the preceding build and exposed a hanging quit; that process was terminated after the timeout. It is retained as diagnostic evidence. RSS differs between runs and these isolated observations are not a controlled performance comparison or connected-gameplay measurement.

## Identical workload comparison to run after live validation

Use the same disposable Java 1.21.4 world/seed, server settings, render distance, host, bot inventory, task instructions, authorized player route, network delay and AI stub response timings for each implementation. Run only one companion at a time. Warm up each for 30 seconds, record connected idle for 60 seconds, then follow the same route, mine the same reconstructed blocks, perform the same inventory transfer and request the same AI plan.

Use `scripts/measure-process.ps1 -ProcessId <pid> -Seconds 60 -Output benchmark-results/<implementation>-<workload>.json` for process RSS/private memory and CPU on Windows. Record external timestamps for manual activation to verified spawn, player waypoint movement to bot response, path request to arrival, dig completion to server block removal, and provider response to validated dispatch. Repeat three times and report distributions, not only best cases. On Linux use `/usr/bin/time -v`, `pidstat` and equivalent workload event timestamps.

Active comparative measurements were not run because no EULA-approved local server or target Aternos details were available. The TypeScript suite's dependency-install problem and the retained runtime's lack of an equivalent offline waiting supervisor also prevent treating startup/idle numbers as a fair comparison.
