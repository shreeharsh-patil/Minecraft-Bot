// Explicit upgrade utility; preserves keys and backs up prior slot configuration.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './backend/config.js';
const file = path.join(ROOT, 'arena.config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!config.endurance) fs.copyFileSync(file, file + '.pre-endurance.bak', fs.constants.COPYFILE_EXCL);
config.endurance = true;
for (const slot of config.agents) {
    if (slot.id === 'local') { slot.id = 'nemotron'; slot.displayName = 'NEMOTRON'; slot.enabled = false; }
    if (['gemini','deepseek','gpt','nemotron'].includes(slot.id)) { slot.brain = slot.id; slot.profilePath = `profiles/arena/cloud-${slot.id}.json`; }
}
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
const brainFile = path.join(ROOT, 'brain.config.json');
if (!fs.existsSync(brainFile)) fs.copyFileSync(path.join(ROOT, 'brain.config.example.json'), brainFile);
const keyFile = path.join(ROOT, 'keys.json');
if (fs.existsSync(keyFile)) {
    const keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    for (const key of ['GEMINI_API_KEY','NVIDIA_API_KEY','CEREBRAS_API_KEY','GROQ_API_KEY']) keys[key] ??= '';
    fs.writeFileSync(keyFile, JSON.stringify(keys, null, 2) + '\n');
}
console.log('Cloud endurance configuration installed. Existing API key values preserved. Account limits and free access still require confirmation.');
