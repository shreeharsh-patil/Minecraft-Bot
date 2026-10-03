import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { checkMinecraft } from './minecraft.js';

export class ProcessManager {
    constructor({ root, config, slots, store, gateway = null, runtimeStore = null, worker = path.join(root, 'control-center/worker.js'), probe = checkMinecraft }) {
        Object.assign(this, { root, config, slots, store, worker, probe, gateway, runtimeStore });
        this.children = new Map(); this.retries = new Map(); this.timers = new Map(); this.desired = new Map(); this.locks = new Map(); this.epochs = new Map();
    }
    control(id, command) {
        if (!['start', 'stop', 'pause', 'resume', 'reconnect'].includes(command)) return Promise.reject(new Error('Unknown control.'));
        const previous = this.locks.get(id) || Promise.resolve();
        const next = previous.catch(() => {}).then(async () => {
            if (command === 'stop') return this.stop(id);
            if (command === 'reconnect') { await this.stop(id); this.retries.set(id, 0); return this.start(id); }
            if (command === 'start') { this.retries.set(id, 0); return this.start(id); }
            const child = this.children.get(id);
            if (!child?.connected) return;
            this.desired.set(id, command === 'pause' ? 'paused' : 'running');
            child.send({ kind: 'control', command });
        });
        this.locks.set(id, next); return next;
    }
    async start(id, retry = false) {
        const slot = this.slots.find(s => s.id === id);
        if (!slot) throw new Error('Unknown agent.');
        if (this.children.has(id) || this.timers.has(id)) return;
        if (slot.error) { this.store.event(id, 'agent_status', { status: 'error', error: slot.error }); return; }
        if (!retry) this.desired.set(id, 'running');
        const epoch = this.epochs.get(id);
        const lan = await this.probe(this.config.minecraft);
        if (!this.desired.has(id) || this.epochs.get(id) !== epoch) return;
        if (!lan.available) {
            this.store.event(id, 'agent_status', { status: 'error', error: lan.message });
            if (retry) this.scheduleRetry(id); else this.desired.delete(id);
            return;
        }
        this.store.event(id, 'agent_status', { status: 'starting', error: null });
        let saved;
        try { saved = this.runtimeStore?.load(slot); } catch (error) { this.store.event(id, 'error', { message: error.message }); this.desired.delete(id); return; }
        if (saved?.observer) Object.assign(this.store.agents[id], saved.observer, { status: 'starting', onlineSince: null, action: null, events: [] });
        const child = fork(this.worker, [], { cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ARENA_WORKER: '1' } });
        this.children.set(id, child);
        // Raw upstream console output may contain provider request objects or reasoning.
        // Drain it without storing it; structured events are the authoritative logs.
        child.stdout?.resume(); child.stderr?.resume();
        const startup = setTimeout(() => { this.store.event(id, 'error', { message: 'Agent startup exceeded two minutes. Restarting this agent.' }); child.kill(); }, 120000);
        child.on('message', message => {
            if (message?.kind === 'brain_request' && this.gateway) {
                this.gateway.request(id, slot.brainId, message.messages, message.priority).then(result => { if (child.connected) child.send({ kind: 'brain_response', id: message.id, result }); }).catch(error => { if (child.connected) child.send({ kind: 'brain_response', id: message.id, error: error.message }); });
            }
            if (message?.kind === 'brain_cancel') this.gateway?.cancel(id);
            if (message?.kind === 'runtime_snapshot' && this.runtimeStore) {
                try { this.runtimeStore.save(id, message.snapshot, this.store.agents[id]); } catch { this.store.event(id, 'error', { message: 'Agent runtime snapshot could not be saved.' }); }
            }
            if (message?.kind === 'event' && typeof message.type === 'string' && message.type.length < 60) {
                if (['agent_connected', 'minecraft_login'].includes(message.type)) clearTimeout(startup);
                this.store.event(id, message.type, message.payload || {});
            }
        });
        child.on('error', error => this.store.event(id, 'error', { message: error.message }));
        const launchedAt = Date.now();
        child.once('exit', (code, signal) => {
            this.gateway?.cancel(id);
            clearTimeout(startup);
            this.children.delete(id);
            this.store.event(id, 'agent_disconnected', { code, signal });
            if (!this.desired.has(id)) return;
            if (Date.now() - launchedAt > 300000) this.retries.set(id, 0);
            this.scheduleRetry(id);
        });
        child.send({ kind: 'init', slot, minecraft: this.config.minecraft, paused: this.desired.get(id) === 'paused', loadMemory: !!this.gateway || retry, runtime: saved?.snapshot, brain: this.gateway?.config.brains[slot.brainId], brainSettings: this.gateway ? { maxDecisionIntervalMs: this.gateway.config.maxDecisionIntervalMs, maxInputBytes:this.gateway.inputBudget(slot.brainId) } : null, peers: this.slots.filter(s => !s.error).map(s => s.minecraftName) });
    }
    async stop(id) {
        this.epochs.set(id, (this.epochs.get(id) || 0) + 1);
        this.desired.delete(id); clearTimeout(this.timers.get(id)); this.timers.delete(id);
        const child = this.children.get(id);
        if (!child) { this.store.event(id, 'agent_status', { status: 'offline', phase: 'Stopped' }); return; }
        const exited = once(child, 'exit').catch(() => {});
        if (child.connected) child.send({ kind: 'control', command: 'stop' }, () => {});
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 12000);
        await exited; clearTimeout(timer);
    }
    scheduleRetry(id) {
        const attempt = (this.retries.get(id) || 0) + 1;
        this.retries.set(id, attempt);
        if (attempt > 5) { this.desired.delete(id); this.store.event(id, 'agent_status', { status: 'error', error: 'Stopped after five reconnect attempts. Check Diagnostics, then click Reconnect.' }); return; }
        const delayMs = Math.min(60000, 2000 * 2 ** (attempt - 1));
        this.store.event(id, 'agent_reconnecting', { attempt, delayMs });
        this.timers.set(id, setTimeout(() => { this.timers.delete(id); if (this.desired.has(id)) this.start(id, true).catch(e => this.store.event(id, 'error', { message: e.message })); }, delayMs));
    }
    async all(command, limit = 4) {
        const targets = command === 'start' ? this.slots.filter(s => s.enabled).slice(0, limit) : this.slots;
        await Promise.allSettled(targets.map(s => this.control(s.id, command)));
    }
    async shutdown() { await Promise.allSettled(this.slots.map(s => this.control(s.id, 'stop'))); }
}
