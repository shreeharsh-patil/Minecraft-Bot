export const MONITOR_PROMPT = `\nFor the public experiment monitor, prefix your normal response with exactly one <monitor>{"current_goal":"short intermediate goal","decision_summary":"one or two public sentences explaining the next decision","next_action":"short action label"}</monitor>. This is intentional public metadata, never private reasoning. After </monitor> emit your normal Mindcraft !command(args) or conversational response. Keep commands OUT of the metadata. Do not change the command syntax. Do not include hidden reasoning.`;

export function parseDecision(raw) {
    if (typeof raw !== 'string') throw new Error('Model returned a non-text response.');
    // Only consume explicitly public metadata after any provider reasoning block.
    const publicText = raw.includes('</think>') ? raw.slice(raw.lastIndexOf('</think>') + 8) : raw;
    if (publicText.includes('<think>')) return { text: '', decision: null, error: 'Incomplete provider reasoning block.' };
    const match = publicText.match(/<monitor>([\s\S]*?)<\/monitor>/);
    if (!match) return { text: publicText.replace(/<monitor>[\s\S]*/, '').trim(), decision: null, error: 'No public decision summary supplied.' };
    const text = publicText.replace(match[0], '').trim();
    try {
        const data = JSON.parse(match[1]);
        const decision = {};
        for (const key of ['current_goal', 'decision_summary', 'next_action']) {
            if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error('Missing monitoring field.');
            decision[key] = data[key].slice(0, key === 'decision_summary' ? 420 : 160);
        }
        return { text, decision };
    } catch { return { text, decision: null, error: 'Malformed public decision summary.' }; }
}
