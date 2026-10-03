import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { publicSlot } from './config.js';

export class RunStore extends EventEmitter {
    constructor(root, slots, redact = String) {
        super();
        this.redact = redact;
        this.id = new Date().toISOString().replace(/[:.]/g, '-') + '_' + randomUUID().slice(0, 8);
        this.startedAt = new Date().toISOString();
        this.directory = path.join(root, 'data', 'runs', this.id);
        fs.mkdirSync(this.directory, { recursive: true });
        this.agents = Object.fromEntries(slots.map(slot => [slot.id, {
            ...publicSlot(slot), status: slot.error ? 'error' : 'offline', phase: 'Waiting', health: null, hunger: null,
            position: null, dimension: null, time: null, inventory: null, armor: null, nearby: [], goal: null,
            plan: null, action: null, previousAction: null, progress: null, actionQueue: null,
            stats: { distance: 0, blocksMined: 0, blocksPlaced: 0, itemsCrafted: 0, damageTaken: 0, deaths: 0, foodConsumed: 0, uniqueItems: 0, modelRequests: 0, successfulActions: 0, failedActions: 0, interruptedActions: 0, retries: 0, actionDurationMs: 0, averageActionMs: null, apiLatencyMs: null, tokens: null, cost: null, mobsDefeated: null },
            events: [], onlineSince: null, runtimeMs: 0
        }]));
        this.feed = []; this.sequence = 0; this.pending = []; this.writing = Promise.resolve(); this.closed = false; this.uniqueItems = new Map();
        fs.writeFileSync(path.join(this.directory, 'events.jsonl'), '');
        fs.writeFileSync(path.join(this.directory, 'run.json'), JSON.stringify({ id: this.id, startedAt: this.startedAt, agents: slots.map(publicSlot), source: 'live-mindcraft' }, null, 2));
        this.flushTimer = setInterval(() => this.flush(), 1000).unref();
        this.checkpointTimer = setInterval(() => this.checkpoint(), 15000).unref();
    }
    event(agent_id, type, payload = {}) {
        if (this.closed) return;
        const agent = this.agents[agent_id];
        if (!agent && agent_id !== 'system') return;
        const event = JSON.parse(this.redact(JSON.stringify({ sequence: ++this.sequence, timestamp: new Date().toISOString(), agent_id, type, payload })));
        if (agent) this.reduce(agent, event);
        this.pending.push(JSON.stringify(event) + '\n');
        if (this.pending.length >= 100) this.flush();
        if (!['position_updated', 'world_updated', 'inventory_changed', 'action_progress', 'runtime_updated', 'runtime_state'].includes(type)) {
            this.feed.push(event); if (this.feed.length > 120) this.feed.shift();
            if (agent) { agent.events.push(event); if (agent.events.length > 60) agent.events.shift(); }
        }
        this.emit('event', event);
        return event;
    }
    reduce(a, { type, payload: p, timestamp }) {
        const s = a.stats;
        if (type === 'runtime_state') { Object.assign(a, p); a.plan = p.summary || a.plan; a.goal = p.goal || a.goal; a.actionQueue = p.plan; }
        if (type === 'brain_state') { a.brainState = p.state; a.brainDetail = p; if (p.provider && p.state === 'READY') a.provider = p.provider; }
        if (type === 'player_preflight') a.playerPreflight = p;
        if (type === 'provider_failure') { a.lastProviderFailure = { ...p, timestamp }; s.retries++; }
        if (type === 'agent_status') { a.status = p.status; a.phase = p.phase || p.status; if (p.error !== undefined) a.error = p.error; }
        if (type === 'agent_connected') { a.status = 'online'; a.minecraftState = 'CONNECTED'; a.phase = 'Observing'; a.error = null; a.onlineSince ||= timestamp; a.version = p.version; }
        if (type === 'respawn') { a.status = 'online'; a.minecraftState = 'CONNECTED'; a.phase = 'Recovery'; }
        if (type === 'agent_disconnected') { if (a.onlineSince) a.runtimeMs += Date.now() - Date.parse(a.onlineSince); a.onlineSince = null; a.status = 'offline'; a.phase = 'Disconnected'; a.action = null; a.progress = null; }
        if (type === 'agent_reconnecting') { a.status = 'reconnecting'; a.phase = `Retry in ${p.delayMs / 1000}s`; s.retries++; }
        if (type === 'identity') { a.model = p.model; a.provider = p.provider; }
        if (type === 'decision_created') { a.goal = p.current_goal; a.plan = p.decision_summary; a.nextAction = p.next_action; }
        if (type === 'goal_changed') a.goal = p.goal;
        if (type === 'autonomy_stopped') { a.phase = 'Autonomy stopped'; a.error = p.message; }
        if (type === 'health_changed') { if (a.health !== null && p.health < a.health) s.damageTaken += a.health - p.health; a.health = p.health; }
        if (type === 'hunger_changed') a.hunger = p.hunger;
        if (type === 'position_updated') { a.position = p.position; s.distance += p.distance || 0; }
        if (type === 'world_updated') Object.assign(a, { dimension: p.dimension, time: p.time, nearby: p.nearby, armor: p.armor });
        if (type === 'inventory_changed') {
            a.inventory = p.items;
            const names = this.uniqueItems.get(a.id) || new Set();
            for (const item of p.items) names.add(item.name);
            this.uniqueItems.set(a.id, names); s.uniqueItems = names.size;
        }
        if (type === 'death') { s.deaths++; a.minecraftState = 'RESPAWNING'; a.phase = 'Respawning'; a.lastDeath = p; a.position = null; a.action = null; }
        if (type === 'stat_increment' && ['blocksMined', 'blocksPlaced', 'itemsCrafted', 'foodConsumed'].includes(p.stat)) s[p.stat] += p.amount;
        if (type === 'model_request_started') { s.modelRequests++; if (a.status === 'online') a.phase = 'Thinking'; }
        if (type === 'model_response_received') { s.apiLatencyMs = p.latencyMs; if (p.provider) a.provider = p.provider; if (p.model) a.model = p.model; if (Number.isFinite(p.tokens)) s.tokens = (s.tokens || 0) + p.tokens; if (a.status === 'online') a.phase = a.action ? 'Acting' : 'Deciding'; }
        if (type === 'model_retry') { s.retries++; a.phase = `Model retry in ${p.delayMs / 1000}s`; }
        if (type === 'action_started') { a.action = p; a.progress = null; a.phase = 'Acting'; }
        if (type === 'action_progress') a.progress = p;
        if (['action_completed', 'action_failed', 'action_interrupted'].includes(type)) {
            if (type === 'action_completed') s.successfulActions++;
            else if (type === 'action_failed') s.failedActions++;
            else s.interruptedActions++;
            if (type !== 'action_interrupted') { s.actionDurationMs += p.durationMs || 0; s.averageActionMs = s.actionDurationMs / (s.successfulActions + s.failedActions); }
            a.previousAction = { ...p, outcome: type }; if (a.action?.id === p.id) { a.action = null; a.progress = null; }
            if (a.status === 'online') a.phase = 'Observing';
        }
        if (type === 'error') a.error = p.message;
    }
    snapshot() { return { runId: this.id, startedAt: this.startedAt, agents: this.agents, feed: this.feed }; }
    flush() {
        if (!this.pending.length) return this.writing;
        const data = this.pending.join(''); this.pending = [];
        this.writing = this.writing.then(() => fs.promises.appendFile(path.join(this.directory, 'events.jsonl'), data)).catch(error => { this.storageError = error.message; this.emit('storage-error', error); });
        return this.writing;
    }
    checkpoint() {
        try { fs.writeFileSync(path.join(this.directory, 'stats.json'), JSON.stringify(this.snapshot(), null, 2)); }
        catch (error) { this.storageError = error.message; this.emit('storage-error', error); }
    }
    async close() { clearInterval(this.flushTimer); clearInterval(this.checkpointTimer); await this.flush(); this.checkpoint(); this.closed = true; }
}
