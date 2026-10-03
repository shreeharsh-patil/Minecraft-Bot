export function createRedactor(values = []) {
    const secrets = values.filter(v => typeof v === 'string' && v.length > 3).sort((a, b) => b.length - a.length);
    return function redact(value) {
        let text = typeof value === 'string' ? value : JSON.stringify(value);
        for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
        return text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
    };
}

export function publicError(error) {
    const code = error?.status ?? error?.code;
    if (code === 429) return 'Provider rate limited this agent. Retrying with backoff.';
    if (code === 401 || code === 403) return 'Provider rejected authentication. Check the configured API key and model access.';
    return String(error?.message ?? error).slice(0, 600);
}
