import fs from 'node:fs';
import path from 'node:path';
export class RuntimeStore {
    constructor(root, redact) { this.directory = path.join(root, 'data/runtime'); this.redact = redact; fs.mkdirSync(this.directory, { recursive: true }); }
    file(id) { if (!/^[a-z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid runtime ID.'); return path.join(this.directory, id + '.json'); }
    load(slot) {
        try {
            const saved = JSON.parse(fs.readFileSync(this.file(slot.id), 'utf8'));
            if (saved.snapshot.minecraftName !== slot.minecraftName || saved.snapshot.model !== slot.model) throw new Error('Saved identity differs from configured model/name. Archive this runtime explicitly before starting a new experiment.');
            return saved;
        } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    save(id, snapshot, observer) {
        const file = this.file(id), data = this.redact(JSON.stringify({ snapshot, observer: { ...observer, events: [] } }));
        fs.writeFileSync(file + '.tmp', data); fs.renameSync(file + '.tmp', file);
    }
}
