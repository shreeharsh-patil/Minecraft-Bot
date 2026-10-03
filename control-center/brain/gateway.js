import fs from 'node:fs';
import path from 'node:path';
import { RequestBudgetManager } from './budget.js';
import { requestCloud } from './transport.js';
import { routeProblem, validateBrainConfig } from './config.js';

export class ProviderGateway {
    inputBudget(brainId, priority = 4, onlyProvider) {
        const fraction=priority===1 ? 1 : this.config.quota.normalBudgetPercent/100;
        const routes=this.config.brains[brainId]?.routes || [];
        const caps=routes.filter(r=>(!onlyProvider || r.provider===onlyProvider) && !routeProblem(this.config,r,this.keys)).map(r=>{
            const limits=this.config.providers[r.provider].limits;
            return Math.min(...['tokensPerMinute','tokensPerHour','tokensPerDay','sessionTokens'].map(k=>Math.floor(limits[k]*fraction)));
        });
        return caps.length ? Math.max(0,Math.max(...caps)-this.config.maxOutputTokens-256) : null;
    }
    constructor({ root, config, keys, onEvent = () => {}, transport = requestCloud, now = Date.now, random = Math.random, persist = true }) {
        this.config = validateBrainConfig(config); Object.assign(this, { keys, onEvent, transport, now, random, persist });
        this.file = path.join(root, 'data/provider-ledger.json'); this.queue = []; this.active = new Map(); this.health = {}; this.lastServed = {}; this.closed = false; this.verifiedRoutes=new Set();
        let saved = {}; try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Provider ledger cannot be read; refusing to reset quotas.'); }
        this.budgets = Object.fromEntries(Object.entries(config.providers).map(([id, p]) => [id, new RequestBudgetManager(p.limits, config.quota, saved[id], now)]));
        this.timer = setInterval(() => this.pump(), 250); this.timer.unref();
    }
    save() {
        if (!this.persist) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(Object.fromEntries(Object.entries(this.budgets).map(([id, b]) => [id, b.export()]))));
        fs.renameSync(this.file + '.tmp', this.file);
    }
    request(agentId, brainId, messages, priority = 4, options = {}) {
        if (this.closed) return Promise.reject(new Error('Gateway stopped.'));
        if (!this.config.brains[brainId]) return Promise.reject(new Error('Brain is not configured.'));
        if (this.queue.some(j => j.agentId === agentId) || this.active.has(agentId)) return Promise.reject(Object.assign(new Error('One pending brain request per agent is allowed.'), {code:'BRAIN_PENDING'}));
        if (this.queue.length >= 16) return Promise.reject(new Error('Brain queue is full.'));
        const bounded = messages.map(m => ({ role: ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'user', content: String(m.content) }));
        if (Buffer.byteLength(JSON.stringify(bounded)) > 100000) return Promise.reject(new Error('Model context exceeds the bounded request size.'));
        // UTF-8 bytes are a conservative upper bound for common cloud tokenizers.
        // Reasoning models need room for internal tokens before a public probe reply.
        // Reserve the same bounded allowance as a normal decision.
        const maxOutputTokens = this.config.maxOutputTokens;
        const tokens = Buffer.byteLength(JSON.stringify(bounded)) + maxOutputTokens + 256;
        const inputLimit=this.inputBudget(brainId,priority,options.onlyProvider);
        if(inputLimit !== null && tokens-maxOutputTokens-256>inputLimit) return Promise.reject(new Error('Planning request exceeds the normal API input allowance; compact context before retrying.'));
        return new Promise((resolve, reject) => {
            this.queue.push({ agentId, brainId, messages: bounded, tokens, maxOutputTokens, priority: Math.min(5, Math.max(1, Number(priority) || 4)), created: this.now(), resolve, reject, onlyProvider: options.onlyProvider, preflight: !!options.preflight, status: '' });
            this.pump();
        });
    }
    status(job, state, extra = {}) {
        const key = JSON.stringify([state, extra.provider, extra.reason]);
        if (job.status !== key) { job.status = key; this.onEvent(job.agentId, 'brain_state', { state, since: this.now(), ...extra }); }
    }
    pump() {
        if (this.closed || this.pumping) return; this.pumping = true;
        try {
            this.queue.sort((a, b) => (a.priority - Math.floor((this.now() - a.created) / 120000)) - (b.priority - Math.floor((this.now() - b.created) / 120000)) || (this.lastServed[a.agentId] || 0) - (this.lastServed[b.agentId] || 0) || a.created - b.created);
            for (const job of [...this.queue]) {
                const brain = this.config.brains[job.brainId]; let selected, wait = Infinity, reason = 'No approved same-model cloud route is available.';
                for (const route of brain.routes) {
                    if (job.onlyProvider && route.provider !== job.onlyProvider) continue;
                    const problem = routeProblem(this.config, route, this.keys); if (problem) { reason = problem; continue; }
                    const h = this.health[route.provider] ||= { failures: 0, openUntil: 0, active: 0 };
                    if (h.openUntil > this.now()) { wait = Math.min(wait, h.openUntil); reason = 'Provider circuit is cooling down.'; continue; }
                    if (h.active >= this.config.providers[route.provider].maxConcurrency) { wait = Math.min(wait, this.now() + 1000); reason = 'Shared provider queue.'; continue; }
                    const permit = this.budgets[route.provider].inspect(job.tokens, job.priority);
                    if (!permit.allowed) { wait = Math.min(wait, permit.retryAt); reason = permit.reason; continue; }
                    selected = route; break;
                }
                if (!selected) {
                    const unavailable = reason.includes('circuit') || !Number.isFinite(wait);
                    this.status(job, unavailable ? (this.now() - job.created > 30000 ? 'TEMPORARILY_UNAVAILABLE' : 'COOLDOWN') : 'WAITING_FOR_BUDGET', { reason, retryAt: Number.isFinite(wait) ? wait : null });
                    // Probes obey the same limits and may wait for normal shared pacing.
                    if (job.preflight && (!Number.isFinite(wait) || wait - job.created > 120000 || this.now() - job.created > 120000)) {
                        this.queue.splice(this.queue.indexOf(job), 1);
                        job.reject(Object.assign(new Error(reason), {code:Number.isFinite(wait) && !reason.includes('circuit') ? 'BRAIN_DEFERRED' : 'BRAIN_UNAVAILABLE',retryAt:Number.isFinite(wait) ? wait : null}));
                    }
                    continue;
                }
                const reservation = this.budgets[selected.provider].reserve(job.tokens, job.priority);
                if (!reservation) continue;
                try { this.save(); } catch { this.queue.splice(this.queue.indexOf(job), 1); job.reject(new Error('Cannot persist provider budget; request was not sent.')); continue; }
                this.queue.splice(this.queue.indexOf(job), 1); this.lastServed[job.agentId] = this.now();
                this.execute(job, selected, reservation);
            }
        } finally { this.pumping = false; }
    }
    async execute(job, route, reservation) {
        const provider = this.config.providers[route.provider], health = this.health[route.provider], controller = new AbortController();
        health.active++; this.active.set(job.agentId, { job, controller });
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs), started = this.now();
        this.status(job, 'READY', { provider: route.provider, reason: 'Request in progress.' });
        this.onEvent(job.agentId, 'model_request_started', { provider: route.provider, model: this.config.brains[job.brainId].model });
        try {
            const result = await this.transport(route, provider, this.keys[provider.keyEnv], job.messages, { signal: controller.signal, maxOutputTokens: job.maxOutputTokens, json: !job.preflight });
            if (job.cancelled || this.closed) return;
            const reported = result.reportedModel?.split('/').at(-1);
            if (reported && reported !== route.model.split('/').at(-1) && !(route.responseAliases || []).includes(result.reportedModel)) throw new Error('Provider returned an unapproved model identity. Response rejected.');
            health.failures = 0; health.openUntil = 0;
            this.verifiedRoutes.add(`${route.provider}/${route.model}`);
            this.budgets[route.provider].applyHints(result.hints);
            this.budgets[route.provider].reconcile(reservation, result.tokens); this.save();
            this.onEvent(job.agentId, 'model_response_received', { latencyMs: this.now() - started, provider: route.provider, model: this.config.brains[job.brainId].model, tokens: result.tokens });
            this.status(job, 'READY', { provider: route.provider });
            job.resolve({ text: result.text, provider: route.provider, model: this.config.brains[job.brainId].model });
        } catch (error) {
            if (job.cancelled || this.closed) return;
            if([401,403,404,410].includes(error.status) || /model identity/.test(error.message)) this.verifiedRoutes.delete(`${route.provider}/${route.model}`);
            health.failures++;
            this.budgets[route.provider].applyHints(error.hints);
            const backoff = Math.min(300000, 5000 * 2 ** Math.min(health.failures - 1, 6)) * (1 + this.random() * 0.2);
            health.openUntil = Math.max(this.now() + backoff, error.hints?.blockedUntil || 0);
            if ([401, 403, 404].includes(error.status) || /model identity/.test(error.message)) health.openUntil = this.now() + 1800000;
            this.budgets[route.provider].headerBlockUntil = Math.max(this.budgets[route.provider].headerBlockUntil, health.openUntil);
            try { this.save(); } catch { health.openUntil = Infinity; }
            this.onEvent(job.agentId, 'provider_failure', { provider: route.provider, status: error.status || (controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_OR_RESPONSE'), retryAt: Number.isFinite(health.openUntil) ? health.openUntil : null, message: controller.signal.aborted ? 'Provider request timed out; Minecraft remains connected.' : error.message });
            this.status(job, 'FAILING_OVER', { provider: route.provider });
            if (job.preflight) job.reject(error); else this.queue.push(job);
        } finally { clearTimeout(timeout); health.active--; this.active.delete(job.agentId); this.pump(); }
    }
    cancel(agentId) {
        for (const job of this.queue.filter(j => j.agentId === agentId)) { job.cancelled = true; job.reject(new Error('Request cancelled.')); }
        this.queue = this.queue.filter(j => j.agentId !== agentId);
        const active = this.active.get(agentId); if (active) { active.job.cancelled = true; active.controller.abort(); active.job.reject(new Error('Request cancelled.')); }
    }
    snapshot() { return { queueLength: this.queue.length, providers: Object.fromEntries(Object.entries(this.budgets).map(([id, b]) => [id, { ...b.snapshot(), health: this.health[id] || { active: 0, failures: 0, openUntil: 0 } }])) }; }
    close() { this.closed = true; clearInterval(this.timer); for (const id of new Set([...this.queue.map(j => j.agentId), ...this.active.keys()])) this.cancel(id); this.save(); }
}
