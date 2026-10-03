import { randomUUID } from 'node:crypto';
export class BrainClient {
    static prefix = 'gateway';
    constructor(model) {
        this.model_name = model; this.pending = new Map();
        process.on('message', message => {
            if (message.kind !== 'brain_response') return;
            const call = this.pending.get(message.id); if (!call) return;
            this.pending.delete(message.id);
            if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result);
        });
    }
    request(messages, priority = 4) {
        if (!process.connected) return Promise.reject(new Error('Brain gateway disconnected.'));
        if (this.pending.size) return Promise.reject(new Error('Decision already pending.'));
        const id = randomUUID();
        return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); process.send({ kind: 'brain_request', id, messages, priority }); });
    }
    async sendRequest(messages, prompt = '') { return (await this.request([{ role: 'system', content: prompt }, ...messages])).text; }
    cancel() { process.send?.({ kind: 'brain_cancel' }); for (const p of this.pending.values()) p.reject(new Error('Decision cancelled.')); this.pending.clear(); }
}
