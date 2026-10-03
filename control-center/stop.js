import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './backend/config.js';
try {
    const { port, token } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/arena-runtime.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'X-Arena-Token': token }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Shutdown request was rejected.');
    console.log('Graceful shutdown requested. Agents will disconnect and logs will be saved.');
} catch (error) { console.log(error.code === 'ENOENT' ? 'AI Arena is not running.' : 'Could not contact Arena. It may already be stopped. ' + error.message); }
