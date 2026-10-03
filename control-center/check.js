import { setSettings } from '../src/agent/settings.js';
import defaults from '../settings.js';
setSettings(defaults);
try {
    await import('../src/agent/agent.js');
    console.log('Mindcraft agent and native dependency imports: OK');
} catch (error) { console.error('Mindcraft dependency check failed:', error.message); process.exitCode = 1; }
