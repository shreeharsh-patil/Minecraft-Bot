// Conservative rolling windows. Reservations count even when a provider fails.
// The backend owns these ledgers so all workers share account-level limits.
export const WINDOWS = [['Minute', 60000], ['Hour', 3600000], ['Day', 86400000]];
export class RequestBudgetManager {
    constructor(limits, quota, saved = {}, now = Date.now) {
        this.limits = limits; this.quota = quota; this.now = now;
        this.startedAt = saved.startedAt ?? now(); this.records = saved.records || [];
        this.sessionRequests = saved.sessionRequests || 0; this.sessionTokens = saved.sessionTokens || 0;
        this.normalRequests = saved.normalRequests || 0; this.normalTokens = saved.normalTokens || 0;
        this.nextStart = saved.nextStart || 0; this.headerBlockUntil = saved.headerBlockUntil || 0;
        this.headerWindows = saved.headerWindows || [];
        this.refreshSession();
    }
    refreshSession() {
        const duration=this.quota.sessionHours*3600000, now=this.now();
        if(now-this.startedAt<duration) return;
        this.startedAt += Math.floor((now-this.startedAt)/duration)*duration;
        // Only the elapsed session allowance renews. Rolling account history,
        // rate-limit headers and cooldowns remain authoritative across sessions.
        const rows=this.records.filter(r=>r.at>=this.startedAt);
        this.sessionRequests=rows.reduce((n,r)=>n+r.requests,0);
        this.sessionTokens=rows.reduce((n,r)=>n+(r.usageTokens ?? r.tokens),0);
        this.normalRequests=rows.filter(r=>r.normal).reduce((n,r)=>n+r.requests,0);
        this.normalTokens=rows.filter(r=>r.normal).reduce((n,r)=>n+(r.usageTokens ?? r.tokens),0);
    }
    prune() { const cutoff = this.now() - 86400000; this.records = this.records.filter(r => r.at > cutoff); }
    inspect(tokens, priority = 4) {
        this.prune(); this.refreshSession(); const now = this.now(), normal = priority !== 1;
        const fraction = normal ? this.quota.normalBudgetPercent / 100 : 1;
        const reqCap = Math.floor(this.limits.sessionRequests * fraction), tokCap = Math.floor(this.limits.sessionTokens * fraction);
        const usedR = normal ? this.normalRequests : this.sessionRequests, usedT = normal ? this.normalTokens : this.sessionTokens;
        if (usedR + 1 > reqCap || usedT + tokens > tokCap || this.sessionRequests + 1 > this.limits.sessionRequests || this.sessionTokens + tokens > this.limits.sessionTokens) return { allowed: false, retryAt: Infinity, reason: 'Session budget exhausted; reserve is protected.' };
        let retryAt = Math.max(this.nextStart, this.headerBlockUntil);
        for (const window of this.headerWindows) {
            if (window.until > now && window.remaining < (window.unit === 'tokens' ? tokens : 1)) retryAt = Math.max(retryAt, window.until);
        }
        for (const [unit, duration] of WINDOWS) {
            const rows = this.records.filter(r => r.at > now - duration);
            for (const [metric, amount, field] of [['requests', 1, 'requests'], ['tokens', tokens, 'tokens']]) {
                const limit = Math.floor(this.limits[metric + 'Per' + unit] * fraction);
                if (amount > limit) return { allowed: false, retryAt: Infinity, reason: `Request exceeds ${metric}Per${unit} budget.` };
                const value=r=>field==='tokens' && unit!=='Minute' ? (r.usageTokens ?? r.tokens) : r[field];
                let used = rows.reduce((n, r) => n + value(r), 0);
                for (const row of rows) {
                    if (used + amount <= limit) break;
                    used -= value(row); retryAt = Math.max(retryAt, row.at + duration + 1);
                }
            }
        }
        if (normal && this.quota.paceAcrossSession !== false) {
            const duration = this.quota.sessionHours * 3600000;
            // Spread the normal pool across the full session, including token-heavy prompts.
            retryAt = Math.max(retryAt, this.startedAt + Math.max(this.normalRequests / reqCap, this.normalTokens / tokCap) * duration);
        }
        return { allowed: retryAt <= now, retryAt, reason: retryAt > now ? 'Waiting for safe request/token budget.' : 'Ready' };
    }
    reserve(tokens, priority = 4) {
        const permit = this.inspect(tokens, priority); if (!permit.allowed) return null;
        const row = { at: this.now(), requests: 1, tokens, normal: priority !== 1 };
        this.records.push(row); this.sessionRequests++; this.sessionTokens += tokens;
        for (const window of this.headerWindows) if (window.until > row.at) window.remaining = Math.max(0, window.remaining - (window.unit === 'tokens' ? tokens : 1));
        if (row.normal) { this.normalRequests++; this.normalTokens += tokens; }
        this.nextStart = row.at + Math.max(this.limits.minIntervalMs, 60000 / this.limits.requestsPerMinute);
        return row;
    }
    reconcile(row, actual) {
        // Preserve maximum-output reservations for minute throttling. Longer
        // windows and session pacing use measured usage when the provider reports it.
        // Failed/unmeasured calls retain the full estimate.
        if (Number.isFinite(actual) && actual >= 0) {
            const delta = actual - (row.usageTokens ?? row.tokens);
            row.usageTokens = actual; row.tokens = Math.max(row.tokens, actual);
            if (row.at >= this.startedAt) {
                this.sessionTokens += delta;
                if (row.normal) this.normalTokens += delta;
            }
        }
    }
    applyHints(hints = {}) {
        this.headerBlockUntil = Math.max(this.headerBlockUntil, hints.blockedUntil || 0);
        this.headerWindows = this.headerWindows.filter(w => w.until > this.now());
        for (const window of hints.windows || []) {
            const previous = this.headerWindows.find(w => w.id === window.id);
            if (previous) { previous.remaining = Math.min(previous.remaining, window.remaining); previous.until = Math.max(previous.until, window.until); }
            else this.headerWindows.push({ ...window });
        }
    }
    export() { this.prune(); return { startedAt: this.startedAt, records: this.records, sessionRequests: this.sessionRequests, sessionTokens: this.sessionTokens, normalRequests: this.normalRequests, normalTokens: this.normalTokens, nextStart: this.nextStart, headerBlockUntil: this.headerBlockUntil, headerWindows:this.headerWindows }; }
    snapshot() {
        this.prune(); this.refreshSession(); const normalCap = Math.floor(this.limits.sessionRequests * this.quota.normalBudgetPercent / 100);
        return { usedRequests: this.sessionRequests, remainingRequests: Math.max(0, this.limits.sessionRequests - this.sessionRequests), normalRemaining: Math.max(0, Math.min(normalCap - this.normalRequests, this.limits.sessionRequests - this.sessionRequests)), estimatedRemainingTokens: Math.max(0, this.limits.sessionTokens - this.sessionTokens), reserveRemaining: Math.max(0, this.limits.sessionRequests - normalCap - (this.sessionRequests - this.normalRequests)), rolling: Object.fromEntries(WINDOWS.map(([name, ms]) => [name.toLowerCase(), this.records.filter(r => r.at > this.now() - ms).reduce((a, r) => ({ requests: a.requests + 1, tokens: a.tokens + (name==='Minute' ? r.tokens : (r.usageTokens ?? r.tokens)) }), { requests: 0, tokens: 0 })])) };
    }
}
