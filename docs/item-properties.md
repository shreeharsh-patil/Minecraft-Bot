# Vanilla item properties for Minecraft Java 1.21.4

The native runtime embeds the default stack limit and maximum durability for every one of the **1,385 registered items**. Values come from Mojang's own report. Per-stack `max_stack_size`, `max_damage`, `damage` and `unbreakable` overrides take precedence, including explicit component removals. Empty slots have no stack capacity.

This fixes incorrect stacking assumptions for potions, boats, minecarts, saddles, enchanted books, cakes, stews and bundles. Unbreakable equipment still uses its actual default stack limit. Worn tools are excluded from mining using their server-reported damage and the correct vanilla durability.

## Provenance and reproduction

The official [Mojang version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json) identifies the [Java 1.21.4 server jar](https://piston-data.mojang.com/v1/objects/4707d00eb834b446575d89a61a11b5d548d8c001/server.jar), SHA-1 `4707d00eb834b446575d89a61a11b5d548d8c001`. Its checksum was verified before running the data generator on 2026-10-13. Mojang describes default item components in the generated report in its [component-system release notes](https://feedback.minecraft.net/hc/en-us/articles/24531969592077-Minecraft-Java-Edition-Snapshot-24w09a).

```sh
java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --reports --output generated-reports
python scripts/generate-item-properties.py generated-reports/reports
cargo fmt --all
cargo test --test native_items --locked
```

This entry point generates reports only. It does not launch a world, accept the EULA, create `eula=true`, bind a gameplay server, or connect the bot. Java and Python are development tools; the executable uses a compiled Rust table and needs neither runtime.

| Original report | SHA-256 |
|---|---|
| items.json | a2c232e6d125d78bb3a31f6c4eb66e794a9317e8b6ab485b968ee047d84666e0 |
| registries.json | bc4fc2dd0868dfc9e7960c8f94037088113803f0052de1b677aab3962ea58ae2 |

`native/data/items-1.21.4.json` contains the extracted property facts. `native/src/item_defaults.rs` is generated in protocol-ID order. Tests match each report name against the pinned Azalea registry ID and verify every limit and durability, then exercise real component wire encodings for overrides/removals.

Custom tool rules, datapack tags, food effects and arbitrary item components still need broader protocol and gameplay validation. This table does not claim complete support for every custom component.
