# Commands (project root)
- `npm install --omit=optional --no-audit --no-fund`: headless dependencies + six upstream patches.
- `npm run arena`: normal local arena; `npm run arena:test-agent`: first enabled slot only.
- `node control-center/start.js --no-agents --no-open`: dashboard inspection without starting bots/opening browser.
- `node control-center/start.js --agents=2`: limit selected startup slots.
- `node control-center/stop.js`: authenticated shutdown using ignored data/arena-runtime.json; never kill unrelated node processes.
- Windows user entrypoints: SETUP.bat, START_AI_ARENA.bat, START_TEST.bat, STOP_AI_ARENA.bat.
- PowerShell path: `Set-Location -LiteralPath "I:\AI CRAFT'S\mindcraft"` (space and apostrophe).
- `serena memories check`: reference sanity check if CLI is available.