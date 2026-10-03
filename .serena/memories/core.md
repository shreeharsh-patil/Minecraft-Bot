# Mindcraft + TECH GPT Arena
- Repository root is `I:\AI CRAFT'S\mindcraft`, nested under the original empty workspace. Official upstream develop checkout starts at commit 5f3acc8.
- Preserve the upstream engine. `main.js --profiles ...` launches upstream MindServer/AgentProcess; `control-center/start.js` instead supervises isolated copies of the same Agent through IPC.
- Arena bootstrap sets shared settings BEFORE importing engine modules; import Agent, proxy and conversation sequentially (concurrent dynamic entry points can deadlock the cyclic module graph).
- `control-center/IMPLEMENTATION.md` maps upstream lifecycle, prompts, actions and histories plus modified integration files.
- Consult `mem:tech_stack` before dependency changes; patched upstream package versions and optional renderers require care.
- Consult `mem:conventions` for observability/security invariants; `mem:suggested_commands` for launch commands; `mem:task_completion` for verification requirements.
- Apply memory authoring conventions from `mem:memory_maintenance`.