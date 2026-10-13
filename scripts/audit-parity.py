"""Inventory the retained upstream source without reading local credentials."""
from pathlib import Path
import subprocess, re, hashlib

root = Path(__file__).resolve().parents[1]
files = subprocess.check_output(['git', 'ls-files'], cwd=root, text=True).splitlines()
revision = subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
mapping = {
    'src/ai/': 'native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)',
    'src/bot/': 'native/src/minecraft/mod.rs (EcsRunner, authenticate, connect_with_config, session, run); game.rs (NativeGame); lifecycle.rs (Presence)',
    'src/chat/': 'native/src/chat.rs (Input, parse, HELP); native/src/minecraft/mod.rs (session); native/src/safety.rs (chat_reply)',
    'src/commands/': 'native/src/chat.rs (parse, HELP); native/src/minecraft/mod.rs (session)',
    'src/config/': 'native/src/config.rs (Config, ProviderConfig); native/src/safety.rs (FOODS, hostile, dangerous)',
    'src/executor/': 'native/src/actions.rs (Action::validate, parse_plan); native/src/executor.rs (Scheduler, Job, Work)',
    'src/safety/': 'native/src/safety.rs (Authorization, RateLimit, protected, region_protected, sensitive, redact); native/src/minecraft/game.rs (safe_break)',
    'src/skills/': 'native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs',
    'src/types/': 'native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)',
    'src/utils/': 'native/src/world.rs (delay); native/src/safety.rs (redact, chat_reply); native/src/minecraft/mod.rs (supervisor backoff, tracing filter)',
    'src/world/': 'native/src/world.rs (Snapshot, Point); native/src/minecraft/game.rs (NativeGame::snapshot, ScanCache)',
}
out = [f'# Retained source inventory\n\nBaseline commit: `{revision}`. Generated from every tracked original file. SHA-256 allows auditing that original content was retained. Module mappings describe implementation locations; they do not assert behavioral or live-server parity. See [migration gates](migration.md).\n']
for name in files:
    p=root/name
    data=subprocess.check_output(['git','show',f'{revision}:{name}'],cwd=root)
    target=next((v for k,v in mapping.items() if name.startswith(k)),None)
    if p.suffix=='.ts' and name.startswith('src/'):
        text=data.decode('utf-8-sig')
        declarations=re.findall(r'^export\s+(?:async\s+)?(?:abstract\s+)?(?:class|interface|type|function|const)\s+(\w+)',text,re.M)
        methods=re.findall(r'^\s{2}(?:public\s+|protected\s+|private\s+)?(?:async\s+)?(\w+)\([^\n]*\)[^\n]*\{',text,re.M)
        out += [f'## `{name}`\n\nRust: {target}\n\nPublic declarations: '+(', '.join(f'`{s}`' for s in declarations) or '(re-exports only)')+'.\n\nMethods/algorithms: '+(', '.join(f'`{s}`' for s in dict.fromkeys(methods) if s not in {'if','for','switch','catch','while','constructor'}) or '(module functions listed above)')+f'.\n\nSHA-256: `{hashlib.sha256(data).hexdigest()}`.\n']
    elif name.startswith('tests/'):
        text=data.decode('utf-8-sig')
        cases=re.findall(r'\b(?:it|test)\(\s*[\'\"]([^\'\"]+)',text)
        out += [f'## `{name}`\n\nRust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.\n\n'+('\n'.join('- '+c for c in cases) or 'Retained test support fixture.')+f'\n\nSHA-256: `{hashlib.sha256(data).hexdigest()}`.\n']
    else:
        out += [f'- `{name}` — SHA-256 `{hashlib.sha256(data).hexdigest()}`; retained original configuration/dependency/test tooling.\n']
(root/'docs').mkdir(exist_ok=True)
(root/'docs/source-inventory.md').write_text('\n'.join(out),encoding='utf-8')
print(f'Inventoried {len(files)} original tracked files at {revision}.')
