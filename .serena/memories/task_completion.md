# Required verification
- `npm run lint:arena` for added modules.
- `npm run test:arena` covers config/key errors, secret redaction, event isolation/persistence, local HTTP/SSE security, four isolated fixtures and control lifecycle, actual ActionManager outcomes, and REAL worker with local Minecraft protocol + Ollama API fixtures.
- `npm run arena:check`: real Agent/dependency imports with renderers omitted.
- `git diff --check`; check syntax of changed upstream JS.
- For dependency changes run npm install --omit=optional and confirm all six upstream patches; keep lockfile.
- Browser QA: overview, agent details, comparison, diagnostics, archive controls, recording view at1920x1080 and smaller responsive viewport.
- Test Windows setup/start/stop preserving existing config/keys. No live-game or paid-provider claims without actual world/key validation.
- Local fixture success verifies protocol/engine integration, not survival outcomes in a real world. Production launchers cannot select fixture worker.