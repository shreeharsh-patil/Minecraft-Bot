import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDecision } from '../shared/decision.js';
import { createRedactor } from '../shared/security.js';
import { loadSlots, modelSpec, GOAL } from '../backend/config.js';
import { RunStore } from '../backend/run-store.js';
import { checkMinecraft } from '../backend/minecraft.js';
import { createArena } from '../backend/server.js';

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-arena-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const slot = id => ({ id, enabled: true, displayName: id, minecraftName: `BOT_${id}`, model: 'test-model', provider: 'ollama', profile: { name: `BOT_${id}`, model: { api: 'ollama', model: 'test-model' } }, objective: GOAL, error: null });
async function eventually(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 30)); } assert.fail('Condition did not become true'); }

test('public decision metadata is separated from executable commands and private reasoning', () => {
    const result = parseDecision('<think>private text</think><monitor>{"current_goal":"tools","decision_summary":"I need stone.","next_action":"mine"}</monitor>!collectBlocks("stone", 3)');
    assert.equal(result.text, '!collectBlocks("stone", 3)'); assert.equal(result.decision.current_goal, 'tools');
    assert.ok(!JSON.stringify(result).includes('private text'));
    assert.equal(parseDecision('<monitor>bad JSON</monitor>!stats').text, '!stats');
    assert.equal(parseDecision('<think>unfinished').text, '');
    assert.equal(parseDecision('!stats').decision, null);
});
test('provider resolution preserves explicit local endpoints and supported profile syntax', () => {
    assert.equal(modelSpec('gemini-flash-latest').api, 'google');
    assert.equal(modelSpec('deepseek-chat').api, 'deepseek');
    assert.equal(modelSpec('local/my-model').model, 'my-model');
    assert.equal(modelSpec({ api: 'vllm', model: 'custom', url: 'http://localhost:8000' }).url, 'http://localhost:8000');
    assert.throws(() => modelSpec('unknown-brain'));
});
test('profile errors fail independently; missing keys and duplicate usernames are friendly', t => {
    const root = temp(t);
    fs.writeFileSync(path.join(root, 'valid.json'), JSON.stringify({ name: 'LOCAL_BOT', model: { api: 'ollama', model: 'local-model' } }));
    fs.writeFileSync(path.join(root, 'bad.json'), '{bad');
    fs.writeFileSync(path.join(root, 'cloud.json'), JSON.stringify({ name: 'CLOUD_BOT', model: 'gemini-flash-latest' }));
    const slots = loadSlots({ agents: [
        { id: 'a', profilePath: 'valid.json' }, { id: 'b', profilePath: 'bad.json' }, { id: 'c', profilePath: 'cloud.json' }, { id: 'd', profilePath: 'valid.json' }
    ] }, root, {});
    assert.equal(slots[0].error, null); assert.ok(slots[1].error); assert.match(slots[2].error, /GEMINI_API_KEY is missing/); assert.match(slots[3].error, /unique/);
    assert.equal(loadSlots({ agents: [{ id: 'x', profilePath: '../outside.json' }] }, root, {})[0].error, 'Profile must be inside the project.');
});
test('state, action outcomes and run history remain isolated and secrets are redacted', async t => {
    const root = temp(t), store = new RunStore(root, [slot('one'), slot('two')], createRedactor(['test-super-secret']));
    store.event('one', 'health_changed', { health: 20 }); store.event('one', 'health_changed', { health: 14 });
    store.event('one', 'action_started', { id: 'a1', action: 'mine' });
    store.event('one', 'action_failed', { id: 'a1', durationMs: 100, message: 'key test-super-secret' });
    store.event('two', 'action_completed', { id: 'b1', durationMs: 200 });
    assert.equal(store.agents.one.stats.damageTaken, 6); assert.equal(store.agents.two.health, null);
    assert.equal(store.agents.one.stats.failedActions, 1); assert.equal(store.agents.two.stats.successfulActions, 1);
    assert.equal(store.agents.one.action, null); assert.equal(store.agents.one.stats.cost, null);
    await store.close();
    const logs = fs.readFileSync(path.join(store.directory, 'events.jsonl'), 'utf8');
    assert.ok(!logs.includes('test-super-secret')); assert.equal(logs.trim().split('\n').length, 5);
    assert.ok(fs.existsSync(path.join(store.directory, 'stats.json')));
});
test('missing Minecraft produces the required friendly message', async () => {
    const status = await checkMinecraft({ host: 'localhost', port: 1 }, 100);
    assert.equal(status.available, false); assert.equal(status.message, 'Minecraft LAN world not detected on localhost:1. Open your Minecraft world to LAN and try again.');
});
test('backend, static dashboard, SSE restore, security, four worker processes, controls and archives', async t => {
    const root = temp(t);
    const worker = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));
    const arena = await createArena({ root, config: { port: 0, minecraft: { host: 'localhost', port: 1 } }, slots: ['one', 'two', 'three', 'four'].map(slot), autoStart: false, managerOptions: { worker, probe: async () => ({ available: true }) } });
    t.after(() => arena.close());
    const request = (route, body, headers = {}) => fetch(arena.url + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Arena-Token': arena.token, ...headers }, body: JSON.stringify(body) } : { headers });
    assert.match(await (await request('/')).text(), /TECH GPT/);
    assert.equal((await request('/app.js')).status, 200);
    assert.equal((await request('/style.css')).status, 200);
    assert.equal((await request('/api/control', { agent: 'all', command: 'start' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/control', { agent: 'all', command: 'start' }, { 'X-Arena-Token': 'bad' })).status, 403);
    assert.equal((await request('/api/control', { agent: 'all', command: 'shell' })).status, 400);
    assert.equal((await request('/api/control', { agent: 'all', command: 'start' })).status, 200);
    await eventually(() => Object.values(arena.store.agents).every(a => a.health === 20));
    assert.equal(arena.manager.children.size, 4);
    const stream = await request('/api/events'); const reader = stream.body.getReader();
    const packet = new TextDecoder().decode((await reader.read()).value);
    assert.match(packet, /event: snapshot/); assert.match(packet, /TEST_FIXTURE/); await reader.cancel();
    await request('/api/control', { agent: 'one', command: 'pause' }); await eventually(() => arena.store.agents.one.status === 'paused');
    await request('/api/control', { agent: 'one', command: 'resume' }); await eventually(() => arena.store.agents.one.status === 'online');
    const oldPid = arena.manager.children.get('one').pid;
    await request('/api/control', { agent: 'one', command: 'reconnect' });
    await eventually(() => arena.manager.children.get('one')?.pid !== oldPid && arena.store.agents.one.status === 'online');
    await request('/api/control', { agent: 'all', command: 'emergency' });
    assert.equal(arena.manager.children.size, 0); assert.equal(arena.manager.timers.size, 0);
    await arena.store.flush();
    const history = await (await request(`/api/runs/${arena.store.id}/events?agent=one`)).json();
    assert.ok(history.events.length > 0); assert.ok(history.events.every(e => e.agent_id === 'one'));
    await arena.close();
    assert.ok(!fs.existsSync(path.join(root, 'data/arena-runtime.json')));
});
