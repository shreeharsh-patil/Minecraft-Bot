import fs from 'node:fs';
import path from 'node:path';
export function loadBrainConfig(root) {
    const file = path.join(root, 'brain.config.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
export function validateBrainConfig(config) {
    if (!config || config.version !== 1) throw new Error('Run SETUP.bat to create brain.config.json.');
    const q = config.quota;
    if (q?.paceAcrossSession !== undefined && typeof q.paceAcrossSession !== 'boolean') throw new Error('paceAcrossSession must be true or false.');
    if (!(q?.sessionHours >= 1 && q.sessionHours <= 24 && q.normalBudgetPercent > 0 && q.normalBudgetPercent < 100 && q.emergencyReservePercent === 100 - q.normalBudgetPercent)) throw new Error('Invalid session hours or normal/emergency quota split.');
    for (const [id, p] of Object.entries(config.providers || {})) {
        const url = new URL(p.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || !['openai', 'gemini'].includes(p.api)) throw new Error(`Provider ${id} needs a credential-free HTTPS cloud endpoint.`);
        if (!/^[A-Z][A-Z0-9_]+_KEY$/.test(p.keyEnv || '')) throw new Error(`Invalid key name for ${id}.`);
        for (const field of ['requestsPerMinute', 'requestsPerHour', 'requestsPerDay', 'tokensPerMinute', 'tokensPerHour', 'tokensPerDay', 'sessionRequests', 'sessionTokens', 'minIntervalMs']) if (!Number.isFinite(p.limits?.[field]) || p.limits[field] <= 0) throw new Error(`Set ${id}.limits.${field} from your account limits.`);
        if (!(p.maxConcurrency >= 1 && p.maxConcurrency <= 4 && Number.isInteger(p.maxConcurrency))) throw new Error(`Invalid concurrency for ${id}.`);
    }
    for (const [id, brain] of Object.entries(config.brains || {})) {
        if (!brain.model || !Array.isArray(brain.routes) || !brain.routes.length) throw new Error(`No model/routes configured for ${id}.`);
        for (const route of brain.routes) {
            if (route.reasoningEffort !== undefined && !['low','medium','high'].includes(route.reasoningEffort)) throw new Error('Invalid reasoning effort.');
            for (const option of ['jsonMode','disableThinking']) if (route[option] !== undefined && typeof route[option] !== 'boolean') throw new Error(`Invalid ${option} option.`);
            if (!config.providers[route.provider] || route.brain !== brain.model || !route.model) throw new Error(`Model substitution rejected for ${id}. Every route must use the same brain.`);
            // Canonical identity and provider aliases are explicit and locked for a session.
            if (route.model.split('/').at(-1) !== brain.model.split('/').at(-1)) throw new Error(`Unverified model alias for ${id}: ${route.model}.`);
        }
    }
    if (!(config.maxOutputTokens >= 128 && config.maxOutputTokens <= 4096 && config.timeoutMs >= 1000 && config.timeoutMs <= 120000)) throw new Error('Invalid output or timeout bound.');
    return config;
}
export function routeProblem(config, route, keys) {
    const p = config.providers[route.provider];
    if (!route.enabled) return route.note || 'Route disabled.';
    if (!p.freeAccessConfirmed && !config.allowPaidFallback) return 'Confirm this account uses a free-only route before enabling calls.';
    if (p.paid && !config.allowPaidFallback) return 'Paid routes are disabled.';
    if (!p.limitsConfirmed && p.allowUnverifiedLimits !== true) return 'Account request/token limits need confirmation in brain.config.json.';
    if (!keys[p.keyEnv]) return `${p.keyEnv} is missing.`;
    return null;
}
