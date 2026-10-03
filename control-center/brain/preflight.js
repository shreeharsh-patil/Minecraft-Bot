import fs from 'node:fs';
import path from 'node:path';
import { routeProblem } from './config.js';
export async function endurancePreflight({ gateway, slots, minecraft, root, report = () => {} }) {
    const rows = [{ name: 'Minecraft', ready: minecraft.available, detail: minecraft.message }];
    try {
        const file = path.join(root, 'data', 'preflight-write.tmp'); fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'write check'); fs.unlinkSync(file); rows.push({ name: 'Agent persistence / telemetry', ready: true });
    } catch { rows.push({ name: 'Agent persistence / telemetry', ready: false, detail: 'Log directory is not writable.' }); }
    const readyAgents = [];
    for (const slot of slots) {
        if (slot.error) { rows.push({ name: slot.displayName, ready: false, detail: slot.error }); continue; }
        const brain = gateway.config.brains[slot.brainId]; let anyReady = false;
        for (const route of brain.routes) {
            const problem = routeProblem(gateway.config, route, gateway.keys);
            if (problem) { rows.push({ name: `${slot.displayName} / ${route.provider}`, ready: false, skipped: !route.enabled, detail: problem }); continue; }
            if (!minecraft.available) { rows.push({ name: `${slot.displayName} / ${route.provider}`, ready: false, detail: 'Open Minecraft LAN first; no cloud probe was sent.' }); continue; }
            if(gateway.verifiedRoutes?.has(`${route.provider}/${route.model}`)) {
                rows.push({name:`${slot.displayName} / ${route.provider}`,ready:true,detail:'Cloud route already verified in this server session; no extra probe charged.'});anyReady=true;continue;
            }
            report(rows);
            try {
                await gateway.request(slot.id, slot.brainId, [{ role: 'user', content: 'Reply OK.' }], 4, { preflight: true, onlyProvider: route.provider });
                rows.push({ name: `${slot.displayName} / ${route.provider}`, ready: true, detail: gateway.config.providers[route.provider].limitsConfirmed ? 'Account limits configured.' : 'Account limits unverified; operator-authorized local caps enforced.' }); anyReady = true;
            } catch (error) {
                // A configured bot can join Minecraft while the gateway waits. This
                // grants no API permit and never accepts missing keys or paid routes.
                const deferred = ['BRAIN_PENDING','BRAIN_DEFERRED'].includes(error.code) || [429,502,503,504].includes(error.status) || error.name === 'AbortError';
                rows.push({ name: `${slot.displayName} / ${route.provider}`, ready: deferred, waiting: deferred, detail: deferred ? `Minecraft may connect; brain waiting: ${error.message}` : error.message });
                if (deferred) anyReady = true;
            }
        }
        if (anyReady) readyAgents.push(slot.id);
    }
    const ready = minecraft.available && rows[1]?.ready && readyAgents.length === slots.length && slots.length > 0;
    return { checkedAt: Date.now(), ready, readyAgents, rows, label: ready ? (rows.some(r=>r.waiting) ? 'Minecraft startup ready; some cloud checks are deferred. Brain requests still obey all budgets.' : 'Preflight passed — configured budgets enforced; external uptime is not guaranteed.') : 'Setup / provider checks need attention. See the rows below.' };
}
