export function retryAfter(value, now = Date.now()) {
    if (!value) return 0;
    const seconds = Number(value);
    return Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Math.max(now, Date.parse(value) || now);
}
function resetAt(value, now) {
    if (!value) return now + 60000;
    if (/^\d+(\.\d+)?$/.test(value)) { const n = Number(value); return n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000; }
    let ms = 0; for (const match of value.matchAll(/([\d.]+)(ms|s|m|h)/g)) ms += Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]);
    return ms ? now + ms : retryAfter(value, now);
}
export function rateHints(headers, now = Date.now()) {
    let blockedUntil = retryAfter(headers.get('retry-after'), now);
    const windows = [];
    for (const unit of ['requests', 'tokens']) {
        for (const suffix of ['', '-minute', '-hour', '-day']) {
            const remaining = headers.get('x-ratelimit-remaining-' + unit + suffix);
            if (remaining !== null && Number.isFinite(Number(remaining))) {
                const until = resetAt(headers.get('x-ratelimit-reset-' + unit + suffix), now);
                windows.push({ id:unit+suffix, unit, remaining:Math.max(0, Number(remaining)), until });
                if (Number(remaining) <= 0) blockedUntil = Math.max(blockedUntil, until);
            }
        }
    }
    return { blockedUntil, windows };
}
export async function requestCloud(route, provider, key, messages, { signal, maxOutputTokens, json = false, fetchImpl = fetch } = {}) {
    const url = provider.api === 'gemini' ? `${provider.url}/models/${encodeURIComponent(route.model)}:generateContent` : `${provider.url}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', ...(provider.api === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }) };
    const body = provider.api === 'gemini' ? {
        systemInstruction: { parts: [{ text: messages.filter(m => m.role === 'system').map(m => m.content).join('\n') }] },
        contents: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens, temperature: 0.6 }
    } : { model: route.model, messages, stream: false, max_tokens: maxOutputTokens, temperature: 0.6 };
    if (provider.api === 'openai') {
        if (route.reasoningEffort) body.reasoning_effort = route.reasoningEffort;
        if (route.disableThinking === true) body.chat_template_kwargs = { enable_thinking:false };
        if (json && route.jsonMode === true) body.response_format = { type:'json_object' };
    }
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
    const hints = rateHints(response.headers);
    if (!response.ok) { const error = new Error(`Provider returned HTTP ${response.status}.`); error.status = response.status; error.hints = hints; await response.body?.cancel(); throw error; }
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason === 'length' || data.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new Error('Provider output was truncated; no partial plan will be executed. Reduce reasoning or plan length.');
    const text = provider.api === 'gemini' ? data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') : data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Provider returned no public text.');
    return { text, reportedModel: data.model || data.modelVersion || null, tokens: data.usage?.total_tokens ?? data.usageMetadata?.totalTokenCount ?? null, hints };
}
