# Importing retained TypeScript memory

The original bot persisted JSON version 1. The native runtime uses version 3 and still reads native version-2 files. The offline converter preserves named locations, fractional coordinates, display names, creation timestamps, resolved/unresolved state, preferences and their update timestamps, useful coordinates, and remembered player names.

```powershell
.\artifacts\minecraft-companion.exe --import-memory .\legacy-memory.json --memory-output .\native-memory.json --memory-dimension minecraft:overworld
```

Choose the dimension where those legacy locations were recorded. The old file did not contain dimension information; the converter requires an explicit namespaced identifier. For records from multiple dimensions, prepare separate copies with the relevant records before converting. Unresolved locations remain unusable until confirmed with `!remember`. Names are normalized case-insensitively.

The source is read-only. The destination must not exist and its parent directory must exist. The converter validates the complete input before writing, syncs a private temporary file, and publishes it with an atomic link that cannot replace another file. A filesystem without hard-link support returns an error instead of using a destructive fallback. After successful import, set the native `MEMORY_FILE` to the new file.

No server address, account authentication, AI configuration or network connection is required. Remembered `trustedPlayers` are preserved as memory only: `AUTHORIZED_PLAYERS` and optional `AUTHORIZED_UUIDS` continue to control permissions. Preferences enter AI context as bounded, untrusted gameplay data with credential-shaped text scrubbed.

Files larger than 256 KiB, unknown fields/versions, malformed or out-of-bounds coordinates, conflicting normalized keys, inconsistent preference keys and excessive entries are refused without changing either file. Limits are 128 entries per collection, 64 characters for a location label and 512 bytes for a preference value. Native persistence is atomic; corrupt or legacy files configured directly as native memory are left untouched.

Tests cover complete legacy import and native reload, source preservation, existing/same-path refusal, invalid data, native schema compatibility, unresolved and cross-dimension rejection, bounded context, redaction and running the CLI without bot configuration.
