import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedactor } from '../shared/security.js';
import { loadBrainConfig, validateBrainConfig } from '../brain/config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const GOAL = 'You are an autonomous Minecraft agent. Survive, explore, gather resources, improve your capabilities and progress through Minecraft as far as you can. Decide your own intermediate objectives. Do not wait for a human to give you routine instructions.';
export const PROVIDERS = { openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', deepseek: 'DEEPSEEK_API_KEY', xai: 'XAI_API_KEY', groq: 'GROQCLOUD_API_KEY', mistral: 'MISTRAL_API_KEY', qwen: 'QWEN_API_KEY', replicate: 'REPLICATE_API_KEY', huggingface: 'HUGGINGFACE_API_KEY', novita: 'NOVITA_API_KEY', openrouter: 'OPENROUTER_API_KEY', glhf: 'GHLF_API_KEY', hyperbolic: 'HYPERBOLIC_API_KEY', cerebras: 'CEREBRAS_API_KEY', mercury: 'MERCURY_API_KEY', azure: 'AZURE_OPENAI_API_KEY', ollama: null, vllm: null, lmstudio: null };
export function modelSpec(value) {
    const spec = typeof value === 'string' ? { model: value } : { ...value };
    if (typeof spec.model !== 'string' || !spec.model.trim()) throw new Error('Profile needs a model name.');
    if (spec.api === 'local' || spec.model.startsWith('local/')) { spec.api = 'ollama'; spec.model = spec.model.replace(/^local\//, 'ollama/'); }
    spec.api ||= Object.keys(PROVIDERS).find(p => spec.model === p || spec.model.startsWith(p + '/'));
    spec.api ||= [['gpt', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['claude', 'anthropic'], ['gemini', 'google'], ['grok', 'xai'], ['mistral', 'mistral'], ['deepseek', 'deepseek'], ['qwen', 'qwen']].find(([prefix]) => spec.model.includes(prefix))?.[1];
    if (!(spec.api in PROVIDERS)) throw new Error('Unknown model provider. Set model.api in the Mindcraft profile.');
    spec.model = spec.model.replace(new RegExp('^' + spec.api + '/'), '');
    return spec;
}
export function readSecrets(root = ROOT) {
    let keys = {};
    const file = path.join(root, 'keys.json');
    if (fs.existsSync(file)) {
        try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch { throw new Error('keys.json is invalid JSON. Fix the key configuration and restart.'); }
    }
    const configured = Object.fromEntries(Object.entries(keys).filter(([, value]) => typeof value === 'string' && value.length));
    return Object.fromEntries(Object.entries({ ...process.env, ...configured }).filter(([k]) => /KEY|TOKEN|SECRET|PASSWORD/.test(k)));
}
export function loadConfig(root = ROOT) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'arena.config.json'), 'utf8'));
    if (!Array.isArray(config.agents) || config.agents.length < 1 || config.agents.length > 4) throw new Error('Configure between one and four agent slots.');
    config.port ??= 8790;
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Dashboard port must be between 1024 and 65535.');
    config.minecraft = { host: 'localhost', port: 55916, version: 'auto', ...config.minecraft };
    if (!['localhost', '127.0.0.1', '::1'].includes(config.minecraft.host)) throw new Error('Arena Minecraft host must be local.');
    if (!Number.isInteger(config.minecraft.port) || config.minecraft.port < 1 || config.minecraft.port > 65535) throw new Error('Invalid Minecraft port.');
    const ids = new Set();
    for (const slot of config.agents) {
        if (!/^[a-z0-9_-]{1,32}$/.test(slot.id) || ids.has(slot.id)) throw new Error('Agent IDs must be unique lowercase letters, digits, hyphens or underscores.');
        ids.add(slot.id);
    }
    return config;
}
export function loadSlots(config, root = ROOT, keys = readSecrets(root)) {
    const brains = config.endurance ? validateBrainConfig(loadBrainConfig(root)) : null;
    const names = new Set();
    const redact = createRedactor(Object.values(keys));
    return config.agents.map(slot => {
        const result = { id: slot.id, enabled: !!slot.enabled, displayName: String(slot.displayName || slot.id).slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(slot.color) ? slot.color : '#8a9ba8', profilePath: slot.profilePath, objective: String(slot.goal || config.goal || GOAL), error: null };
        try {
            if (typeof slot.profilePath !== 'string') throw new Error('Choose a profile path.');
            const file = path.resolve(root, slot.profilePath);
            if (!file.startsWith(root + path.sep)) throw new Error('Profile must be inside the project.');
            const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!/^[A-Za-z0-9_]{3,16}$/.test(profile.name)) throw new Error('Minecraft name must contain 3–16 letters, digits or underscores.');
            if (names.has(profile.name.toLowerCase())) throw new Error('Minecraft names must be unique across slots.');
            names.add(profile.name.toLowerCase());
            const model = modelSpec(profile.model);
            Object.assign(result, { minecraftName: profile.name, model: model.model, provider: model.api });
            if (brains) {
                const brainId = slot.brain || slot.id, brain = brains.brains[brainId];
                if (!brain) throw new Error('Configure a cloud brain for this slot in brain.config.json.');
                result.brainId = brainId; result.model = brain.model; result.provider = 'Not connected';
            }
            for (const value of [profile.model, profile.embedding, profile.code_model, profile.vision_model].filter(Boolean)) {
                const spec = modelSpec(value);
                if (/"(?:api[_-]?key|authorization|password|secret|access[_-]?token)"\s*:/i.test(JSON.stringify(spec))) throw new Error('Put API keys in keys.json or environment variables, not inside model profiles.');
                if (spec.url) {
                    const endpoint = new URL(spec.url);
                    if (endpoint.username || endpoint.password || [...endpoint.searchParams.keys()].some(k => /key|token|secret/i.test(k))) throw new Error('Do not put credentials in model endpoint URLs. Use keys.json.');
                }
                const key = PROVIDERS[spec.api];
                if (!brains && key && !(keys[key] || process.env[key] || (spec.api === 'azure' && keys.OPENAI_API_KEY))) throw new Error(`${result.displayName} cannot start: ${key} is missing.`);
            }
            // Pass only supported profile fields; secrets belong exclusively in keys.json/environment.
            result.profile = Object.fromEntries(['name', 'model', 'embedding', 'code_model', 'vision_model', 'cooldown', 'max_tokens'].filter(k => profile[k] !== undefined).map(k => [k, profile[k]]));
        } catch (error) { result.error = redact(error.code === 'ENOENT' ? 'Profile file not found: ' + slot.profilePath : error.message); }
        return result;
    });
}
export function publicSlot(slot) { const safe = { ...slot }; delete safe.profile; return safe; }
