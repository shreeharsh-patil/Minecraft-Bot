# Arena invariants
- Use Serena symbol overviews/search/references first; read necessary implementations only. Preserve quality/testing over token savings.
- Each bot owns independent context/history; observer state never enters other agents' prompts. Minecraft whispers carry explicit bot messages.
- Same survival base and blocked actions for all; insecure coding, cheat toggles and vision remain disabled. Bind arena to127.0.0.1; controls are fixed allowlist with Host/Origin/token checks.
- Telemetry is structured IPC, never console scraping. Drain raw child output; redact known secrets before JSONL persistence; never persist key values or expose them to browser.
- Mineflayer createBot returns before plugins are ready. Attach connection errors immediately, but install method wrappers at login when bot.chat/craft/etc exist.
- Public decisions are explicit <monitor> JSON in the primary model response; strip provider think blocks, keep command separate, never infer hidden reasoning or fake missing data.
- False skill outcomes must propagate through runAsAction wrappers for failure accounting. Interruption is distinct from failure. Pause also gates autonomous updates, new actions, chat and auto-eat.
- SSE backpressure is not disconnect: snapshots may exceed high-water mark. Bound pending writes, don't destroy healthy streams merely because write returns false.