// Local protocol fixtures only. This test uses the REAL Arena worker and REAL
// Mineflayer but does not create or connect to a playable Minecraft world.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import mc from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { ROOT } from '../backend/config.js';

test('real worker joins protocol fixture, observes state, makes public decision, runs skill and stops', { timeout: 45000 }, async t => {
    const events = [], errors = [];
    const api = http.createServer(async (req, res) => {
        for await (const chunk of req) { void chunk; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url.includes('embedding') ? { embedding: [0.1, 0.2, 0.3] } : { message: { content: '<monitor>{"current_goal":"Wait safely","decision_summary":"I will stay here briefly to check the connection.","next_action":"stay"}</monitor>!stay(1)' } }));
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => api.close(resolve)));
    const server = mc.createServer({ host: '127.0.0.1', port: 0, version: '1.21.6', 'online-mode': false, motd: 'ARENA DEVELOPMENT FIXTURE' });
    server.on('error', error => errors.push(error.message));
    await once(server, 'listening');
    t.after(() => server.close());
    const data = minecraftData('1.21.6');
    server.on('playerJoin', client => {
        client.on('error', error => errors.push(error.message));
        client.write('login', { ...data.loginPacket, entityId: client.id, isHardcore: false, gameMode: 0, previousGameMode: 0, hashedSeed: [0, 0], maxPlayers: 4, viewDistance: 2, reducedDebugInfo: false, enableRespawnScreen: true, isDebug: false, isFlat: true, enforceSecureChat: false });
        client.write('position', { teleportId: 1, x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} });
        client.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
        client.write('update_time', { age: 24000n, time: 1000n, tickDayTime: true });
    });
    const name = 'ARENA_TEST_' + String(process.pid).slice(-5);
    const botDirectory = path.join(ROOT, 'bots', name);
    assert.ok(!fs.existsSync(botDirectory), 'test bot must not overwrite existing memory');
    t.after(() => fs.rmSync(botDirectory, { recursive: true, force: true }));
    const child = fork(path.join(ROOT, 'control-center/worker.js'), [], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ARENA_WORKER: '1' } });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-6000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-6000); });
    child.on('message', message => { if (message.kind === 'event') events.push(message); });
    t.after(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } });
    const url = `http://127.0.0.1:${api.address().port}`;
    child.send({ kind: 'init', slot: { minecraftName: name, objective: 'Stay safely for this local integration test.', profile: { name, model: { api: 'ollama', model: 'test-chat', url }, embedding: { api: 'ollama', model: 'test-embedding', url }, cooldown: 100 } }, minecraft: { host: '127.0.0.1', port: server.socketServer.address().port, version: '1.21.6' }, peers: [name], loadMemory: false, paused: false });
    const until = async predicate => {
        const deadline = Date.now() + 25000;
        while (!predicate() && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 100));
        assert.ok(predicate(), JSON.stringify({ events: events.slice(-12), errors, output }));
    };
    await until(() => events.some(e => e.type === 'action_completed' && e.payload.action === 'stay'));
    for (const type of ['agent_connected', 'health_changed', 'hunger_changed', 'position_updated', 'inventory_changed', 'decision_created', 'model_request_started', 'model_response_received', 'action_started']) assert.ok(events.some(e => e.type === type), `Missing ${type}`);
    child.send({ kind: 'control', command: 'pause' });
    await until(() => events.some(e => e.type === 'agent_status' && e.payload.status === 'paused'));
    const count = events.filter(e => e.type === 'action_started').length;
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(events.filter(e => e.type === 'action_started').length, count);
    child.send({ kind: 'control', command: 'resume' });
    await until(() => events.filter(e => e.type === 'action_started').length > count);
    const exited = once(child, 'exit'); child.send({ kind: 'control', command: 'stop' }); await exited;
    assert.equal(child.exitCode, 0);
});
