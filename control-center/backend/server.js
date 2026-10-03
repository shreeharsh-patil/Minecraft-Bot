import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { ROOT, loadConfig, loadSlots, readSecrets } from './config.js';
import { createRedactor } from '../shared/security.js';
import { RunStore } from './run-store.js';
import { ProcessManager } from './process-manager.js';
import { checkMinecraft } from './minecraft.js';

export async function createArena({ root = ROOT, config = loadConfig(root), slots, autoStart = true, limit = 4, managerOptions = {} } = {}) {
    const secrets = readSecrets(root);
    slots ||= loadSlots(config, root, secrets);
    const redact = createRedactor(Object.values(secrets));
    const store = new RunStore(root, slots, redact);
    const { ProviderGateway } = await import('../brain/gateway.js');
    const { loadBrainConfig } = await import('../brain/config.js');
    const { RuntimeStore } = await import('./runtime-store.js');
    const { endurancePreflight } = await import('../brain/preflight.js');
    const gateway = config.endurance ? new ProviderGateway({ root, config: loadBrainConfig(root), keys: secrets, onEvent: (id, type, payload) => {
        store.event(id, type, payload);
        const child = manager.children.get(id); if (type === 'brain_state' && child?.connected) child.send({ kind: 'brain_state', payload });
    } }) : null;
    const manager = new ProcessManager({ root, config, slots, store, gateway, runtimeStore: gateway ? new RuntimeStore(root, redact) : null, ...managerOptions });
    let preflight = gateway ? { ready: false, rows: [], label: 'Preflight has not run.' } : null;
    let checking = false;
    const runPreflight = async selected => {
        if (checking) return false;
        checking = true;
        try {
            lan = await checkMinecraft(config.minecraft);
            preflight = await endurancePreflight({ gateway, slots: selected, minecraft: lan, root, report: rows => { preflight = { ready: false, rows, label: 'Checking cloud routes; shared pacing may take up to two minutes per route…' }; } });
            return preflight.ready;
        } finally { checking = false; }
    };
    const token = randomBytes(32).toString('hex');
    const clients = new Set(); let shuttingDown = false, lan = await checkMinecraft(config.minecraft);
    const state = () => ({ ...store.snapshot(), minecraft: lan, storageError: store.storageError || null, endurance: gateway ? { preflight, budget: gateway.snapshot(), allowPaidFallback: gateway.config.allowPaidFallback, sessionHours: gateway.config.quota.sessionHours } : null,
        experiment: shuttingDown ? 'Stopping' : Object.values(store.agents).some(a => a.status === 'online') ? 'Running' : Object.values(store.agents).some(a => a.status === 'paused') ? 'Paused' : 'Idle',
        diagnostics: { node: process.version, backend: 'Running', realtime: 'SSE', capabilityProfile: 'Shared survival skills; coding, cheat and vision disabled', files: Object.fromEntries(['keys.json', 'arena.config.json', 'node_modules/mineflayer/package.json', 'src/agent/agent.js'].map(file => [file, fs.existsSync(path.join(root, file))])) } });
    const broadcast = () => {
        const data = `event: snapshot\ndata: ${JSON.stringify(state())}\n\n`;
        // A false write result means backpressure, not a disconnected client.
        // Normal snapshots can exceed Node's high-water mark; allow them to drain.
        for (const client of clients) {
            if (client.writableLength > 256 * 1024) { clients.delete(client); client.destroy(); }
            else if (!client.writableNeedDrain) client.write(data);
        }
    };
    const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    async function body(req) {
        let value = '';
        for await (const chunk of req) { value += chunk; if (value.length > 4096) throw new Error('Request too large.'); }
        return JSON.parse(value || '{}');
    }
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
        const port = server.address()?.port;
        const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Local requests only.' });
        if (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`)) return json(res, 403, { error: 'Origin rejected.' });
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());
            if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { token });
            if (req.method === 'GET' && url.pathname === '/api/events') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
                res.write(`event: snapshot\ndata: ${JSON.stringify(state())}\n\n`);
                clients.add(res); req.on('close', () => clients.delete(res)); res.on('error', () => clients.delete(res)); return;
            }
            if (req.method === 'GET' && url.pathname === '/api/runs') {
                const directory = path.join(root, 'data/runs');
                const runs = fs.readdirSync(directory, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
                return json(res, 200, { runs });
            }
            const historyMatch = url.pathname.match(/^\/api\/runs\/([\w.-]+)\/(state|events)$/);
            if (req.method === 'GET' && historyMatch) {
                const [, run, kind] = historyMatch;
                if (run.includes('..')) return json(res, 400, { error: 'Invalid run.' });
                if (kind === 'state') {
                    if (run === store.id) return json(res, 200, state());
                    const snapshot = JSON.parse(await fs.promises.readFile(path.join(root, 'data/runs', run, 'stats.json'), 'utf8'));
                    return json(res, 200, snapshot);
                }
                if (run === store.id) await store.flush();
                const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
                const agent = url.searchParams.get('agent'); let count = 0; const events = []; let more = false;
                const input = fs.createReadStream(path.join(root, 'data/runs', run, 'events.jsonl'), { encoding: 'utf8' });
                const lines = readline.createInterface({ input, crlfDelay: Infinity });
                try { for await (const line of lines) {
                    if (!line) continue;
                    let event; try { event = JSON.parse(line); } catch { continue; }
                    if (agent && event.agent_id !== agent) continue;
                    if (count++ < offset) continue;
                    if (events.length === 200) { more = true; break; }
                    events.push(event);
                } } finally { lines.close(); input.destroy(); }
                return json(res, 200, { events, nextOffset: more ? offset + events.length : null });
            }
            if (req.method === 'POST') {
                if (req.headers['x-arena-token'] !== token) return json(res, 403, { error: 'Refresh the dashboard to restore your control session.' });
                if (url.pathname === '/api/shutdown') { json(res, 202, { ok: true }); setImmediate(() => close()); return; }
                if (url.pathname === '/api/control') {
                    if (shuttingDown) return json(res, 409, { error: 'Arena is shutting down.' });
                    const { agent, command } = await body(req);
                    if (!['start', 'stop', 'pause', 'resume', 'reconnect', 'emergency'].includes(command)) return json(res, 400, { error: 'Invalid control.' });
                    if (command === 'emergency') await manager.shutdown();
                    else if (agent === 'all') { if (command === 'start' && gateway && !await runPreflight(slots.filter(s => s.enabled).slice(0, limit))) return json(res, 409, { error: 'Preflight needs attention. Open Diagnostics.' }); await manager.all(command, limit); }
                    else if (slots.some(s => s.id === agent)) {
                        if (['start', 'reconnect'].includes(command) && limit < 4 && !slots.filter(s => s.enabled).slice(0, limit).some(s => s.id === agent)) return json(res, 400, { error: 'This launch is limited to the first selected agent(s). Use START_AI_ARENA.bat for the full experiment.' });
                        if (['start','reconnect'].includes(command) && gateway && !await runPreflight(slots.filter(s => s.id === agent))) return json(res, 409, { error: 'Preflight needs attention. Open Diagnostics.' });
                        await manager.control(agent, command);
                    }
                    else return json(res, 404, { error: 'Unknown agent.' });
                    return json(res, 200, { ok: true });
                }
            }
            const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
            if (req.method === 'GET' && files[url.pathname]) {
                const [file, type] = files[url.pathname];
                const data = await fs.promises.readFile(path.join(ROOT, 'control-center/frontend', file));
                res.writeHead(200, { 'Content-Type': type }); res.end(data); return;
            }
            json(res, 404, { error: 'Not found.' });
        } catch (error) { json(res, 400, { error: redact(error.code === 'ENOENT' ? 'Requested run or file is not available.' : error.message) }); }
    });
    // frontend is a sibling of backend; keep server independent of build tools.
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
    const livePort = server.address().port;
    const runtimeFile = path.join(root, 'data/arena-runtime.json');
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(runtimeFile, JSON.stringify({ port: livePort, token, pid: process.pid }));
    const updateTimer = setInterval(broadcast, 500);
    const lanTimer = setInterval(async () => { lan = await checkMinecraft(config.minecraft); }, 5000);
    let closePromise;
    function close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
            shuttingDown = true; clearInterval(updateTimer); clearInterval(lanTimer);
            await manager.shutdown(); gateway?.close(); await store.close();
            for (const client of clients) client.end(); clients.clear();
            await new Promise(resolve => server.close(resolve));
            try { const saved = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); if (saved.token === token) fs.unlinkSync(runtimeFile); } catch { /* already removed */ }
        })();
        return closePromise;
    }
    if (autoStart) {
        if (gateway) {
            // Return the listening dashboard immediately so preflight progress is visible.
            runPreflight(slots.filter(s => s.enabled).slice(0, limit)).then(ready => { if (ready && !shuttingDown) return manager.all('start', limit); }).catch(error => { preflight = { ready:false, rows:[], label:redact(error.message) }; });
        }
        else if (lan.available) await manager.all('start', limit);
    }
    return { server, store, manager, gateway, state, close, token, url: `http://127.0.0.1:${livePort}` };
}
