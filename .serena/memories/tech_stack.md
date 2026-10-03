# Stack constraints
- JavaScript ES modules, Node, npm, Mineflayer. Arena backend uses built-in HTTP, SSE, IPC and buffered JSONL; frontend is plain HTML/CSS/JS, no bundler.
- Mineflayer 4.33.0 requires Node >=22 despite upstream README's older Node18/20 advice. Node25.5.0 headless imports and integration fixtures passed locally; recommend22 LTS.
- Exact versions target existing patch-package patches: minecraft-data3.97.0, Mineflayer4.33.0, pathfinder2.4.5, pvp1.3.2, viewer1.33.0, protodef1.19.0.
- prismarine-registry overrides minecraft-data to3.116.0: newer prismarine-chunk compares26.1, which root patched3.97 lacks. Retain the override or reverify joins.
- Canvas and node-canvas-webgl are optional; setup omits them. Vision/browser viewer modules lazy-load renderers. Arena always disables vision/coding.
- Keep package-lock.json versioned to stabilize tested transitive dependency versions.