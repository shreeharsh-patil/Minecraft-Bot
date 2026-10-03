const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? 'N/A').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const words = value => String(value ?? 'Waiting…').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
const fmt = value => value === null || value === undefined ? 'N/A' : typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : value;
const duration = ms => { const s = Math.floor(Math.max(0, ms) / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
let live, state, token, filter = 'all', recording = false, archive = null, historyRows = [], nextOffset = 0, historyAgent = null, loadedPage = '', source;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; setTimeout(() => $('#toast').hidden = true, 5000); }
const controls = (id, paused) => ['start', 'stop', paused ? 'resume' : 'pause', 'reconnect'].map(command => `<button data-agent="${esc(id)}" data-command="${command}">${words(command)}</button>`).join('');
const badge = a => `<span class="badge ${esc(a.status)}">${esc(a.status)}</span>`;
function card(a, detail = false) {
    const pos = a.position ? ['x', 'y', 'z'].map(k => `${k.toUpperCase()} ${a.position[k].toFixed(1)}`).join(' · ') : 'Position unavailable';
    const waiting=a.brainDetail?.reason && a.brainState!=='READY' ? `${a.brainDetail.reason}${a.brainDetail.retryAt ? ` Next check: ${new Date(a.brainDetail.retryAt).toLocaleTimeString()}.` : ' Check Diagnostics.'}` : '';
    const vitals = [['Health', a.health], ['Hunger', a.hunger]].map(([label, value]) => `<div class="vital"><span>${label}<b>${esc(fmt(value))}${value == null ? '' : ' / 20'}</b></span><meter min="0" max="20" value="${value ?? 0}"></meter></div>`).join('');
    return `<article class="card ${detail ? 'detail-card' : ''}" style="--agent-color:${esc(a.color)}"><div class="card-inner"><div class="card-title"><a class="identity" href="#agent/${esc(a.id)}"><span class="avatar">${esc(a.displayName.slice(0, 1))}</span><h3>${esc(a.displayName)}</h3></a>${badge(a)}</div><div class="model">${esc(a.provider || 'Provider unknown')} / ${esc(a.model || 'Model unknown')}<br>Minecraft · ${esc(a.minecraftName || 'Not configured')}</div>${a.brainId ? `<div class="brain-line"><span class="label">Brain · ${esc(words(a.brainState || 'NOT STARTED'))}</span><small>${esc(a.model)} · ${esc(a.provider)}</small><small>${esc(words(a.executionState || 'WAITING FOR DECISION'))}</small>${waiting ? `<small>${esc(waiting)}</small>` : ''}<small>${esc(a.stats.modelRequests)} requests · ${esc(fmt(a.stats.apiLatencyMs))} ms · Last decision ${a.lastDecision ? new Date(a.lastDecision).toLocaleTimeString() : 'pending'}</small></div>` : ''}<span class="label">Current goal</span><p class="goal">${esc(a.goal || 'Waiting for first decision')}</p><div class="plan"><span class="label">Decision summary</span><p>${esc(a.plan || 'The agent’s public plan will appear here when it responds.')}</p></div><span class="label action-label">${a.action ? 'Current action' : 'Agent state'}</span><div class="action">${a.action ? '↳ ' + esc(words(a.action.action)) : esc(a.phase || 'Waiting')}</div><div class="progress">${a.progress ? esc(a.progress.mined !== undefined ? `${a.progress.mined}${a.progress.total ? ' / ' + a.progress.total : ''} blocks mined${a.progress.target ? ' · ' + words(a.progress.target) : ''}` : JSON.stringify(a.progress)) : a.action ? 'In progress' : '—'}</div><div class="vitals">${vitals}</div><div class="coords">${esc(pos)}<br>${esc(words(a.dimension || 'World unknown'))}<br>Day ${esc(a.time?.day ?? 'N/A')} · ${esc(a.time?.timeOfDay ?? 'N/A')} ticks</div>${a.error ? `<p class="error-text">${esc(a.error)}</p>` : ''}</div>${!archive ? `<div class="card-controls">${controls(a.id, a.status === 'paused')}<a href="#agent/${esc(a.id)}" class="muted">Details ↗</a></div>` : ''}</article>`;
}
function eventText(e) {
    const p = e.payload;
    return p.message || p.summary || p.decision_summary || (p.state ? `${words(p.state)} · ${p.reason || p.provider || ''}` : '') || (p.action ? `${words(e.type)} · ${words(p.action)}` : p.goal || words(e.type));
}
function feed(events, filtered = true) {
    let rows = events.slice().reverse();
    if (recording) rows = rows.filter(e => !['provider_failure', 'brain_state', 'model_retry'].includes(e.type));
    if (filtered) rows = rows.filter(e => filter === 'all' || e.agent_id === filter || filter === 'errors' && /error|failed|failure|warning/.test(e.type) || filter === 'milestones' && /milestone|death|connected|goal_changed/.test(e.type));
    return rows.length ? rows.map(e => `<div class="feed-row ${/error|failed/.test(e.type) ? 'error-row' : ''}"><time>${esc(new Date(e.timestamp).toLocaleTimeString([], { hour12: false }))}</time><span class="who" style="color:${esc(state.agents[e.agent_id]?.color || '#9fb0a6')}">${esc(state.agents[e.agent_id]?.displayName || 'SYSTEM')}</span><span class="event-message">${esc(eventText(e))}</span></div>`).join('') : '<div class="empty">No events yet. Real activity will appear as agents connect and act.</div>';
}
function feedPanel() {
    const filters = [['all', 'All activity'], ...Object.values(state.agents).map(a => [a.id, a.displayName]), ['errors', 'Errors'], ['milestones', 'Milestones']];
    return `<div class="section-head"><h2>Activity stream <small>REAL TIME</small></h2><span class="muted">Public decisions & world events</span></div><section class="feed-panel"><div class="feed-toolbar">${filters.map(([id, label]) => `<button class="filter ${filter === id ? 'selected' : ''}" data-filter="${id}">${esc(label)}</button>`).join('')}</div><div class="feed" id="feed">${feed(state.feed || [])}</div></section>`;
}
const stats = { distance: 'Distance travelled (blocks)', blocksMined: 'Blocks mined', blocksPlaced: 'Blocks placed', itemsCrafted: 'Items crafted', damageTaken: 'Damage taken', deaths: 'Deaths', foodConsumed: 'Food consumed', uniqueItems: 'Unique items obtained', modelRequests: 'Model adapter requests', successfulActions: 'Successful actions', failedActions: 'Failed actions', interruptedActions: 'Interrupted actions', retries: 'Retries', averageActionMs: 'Average action (ms)', apiLatencyMs: 'Latest API latency (ms)', tokens: 'Tokens', cost: 'Estimated API cost', mobsDefeated: 'Mobs defeated' };
function overview() { return `<div class="section-head"><h2>Agent overview <small>${Object.keys(state.agents).length} PROFILE SLOTS</small></h2>${!archive ? `<div class="controls"><button class="primary" data-command="start" data-agent="all">▶ Start all</button><button data-command="pause" data-agent="all">Ⅱ Pause all</button><button data-command="resume" data-agent="all">▷ Resume all</button><button data-command="stop" data-agent="all">■ Stop all</button></div>` : ''}</div><div class="grid">${Object.values(state.agents).map(a => card(a)).join('')}</div>${feedPanel()}`; }
function compare() {
    const agents = Object.values(state.agents);
    const rankings = [['distance', 'Farthest travelled'], ['blocksMined', 'Most blocks mined'], ['itemsCrafted', 'Most items crafted'], ['uniqueItems', 'Most unique items']].map(([key, label]) => {
        const measured = agents.filter(a => Number.isFinite(a.stats[key]) && a.stats[key] > 0).sort((a, b) => b.stats[key] - a.stats[key]);
        let rank = 0, previous;
        return `<section class="panel"><h3>${label}</h3>${measured.length ? measured.map((a, index) => {
            if (a.stats[key] !== previous) rank = index + 1;
            previous = a.stats[key];
            return `<p><strong>#${rank}</strong> ${esc(a.displayName)} <span class="muted">· ${esc(fmt(a.stats[key]))}</span></p>`;
        }).join('') : '<p class="muted">Waiting for measured activity.</p>'}</section>`;
    }).join('');
    return `<div class="section-head"><h2>Measured performance</h2><span class="muted">Raw statistics · No intelligence score</span></div><div class="details-grid">${rankings}</div><div class="panel table-wrap"><table><thead><tr><th>Measurement</th>${agents.map(a => `<th style="color:${esc(a.color)}">${esc(a.displayName)}</th>`).join('')}</tr></thead><tbody>${[['health', 'Health'], ['hunger', 'Hunger'], ...Object.entries(stats)].map(([key, label]) => `<tr><td>${label}</td>${agents.map(a => `<td>${esc(fmt(a[key] ?? a.stats[key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="muted">Rankings use positive observed totals; equal totals share a rank. Distance excludes teleport jumps. Unavailable provider usage and unverified kill attribution stay N/A.</p>`;
}
function detail(id) {
    const a = state.agents[id]; if (!a) return '<p>Agent not found.</p>';
    return `<div class="section-head"><h2><a href="#overview">←</a> ${esc(a.displayName)} / Agent detail</h2>${badge(a)}</div><div class="details-grid">${card(a, true)}<section class="panel"><h3>Experiment objective</h3><p>${esc(a.objective)}</p><h3>Previous action</h3><p>${a.previousAction ? esc(words(a.previousAction.command || a.previousAction.action) + ' · ' + words(a.previousAction.result || a.previousAction.outcome)) : 'N/A'}</p><h3>Nearby world</h3><div class="kv">${a.nearby?.map(e => `<span>${esc(words(e.name))}</span><b>${esc(e.distance)} blocks</b>`).join('') || '<span>Waiting for world observation…</span>'}</div><h3>Armor</h3><p>${a.armor ? a.armor.map(i => esc(i?.name || 'Empty')).join(' · ') : 'N/A'}</p><h3>Action queue</h3><p>${Array.isArray(a.actionQueue) ? a.actionQueue.map((step, i) => `${i === a.planIndex ? '→ ' : ''}${i + 1}. ${esc(step)}`).join('<br>') || 'Waiting for a strategic plan.' : esc(a.actionQueue || 'N/A — Mindcraft chooses actions sequentially.')}<br>${a.planInvalid ? 'Plan needs reassessment after interruption.' : ''}</p></section></div><div class="details-grid"><section class="panel"><h3>Inventory</h3><div class="inventory">${a.inventory?.map(i => `<div class="item"><b>${i.count}</b>${esc(words(i.name))}</div>`).join('') || '<p class="muted">No inventory observed.</p>'}</div></section><section class="panel"><h3>Statistics</h3><div class="kv"><span>Connected runtime</span><b>${duration(a.runtimeMs + (!archive && a.onlineSince ? Date.now() - Date.parse(a.onlineSince) : 0))}</b>${Object.entries(stats).map(([k, label]) => `<span>${label}</span><b>${esc(fmt(a.stats[k]))}</b>`).join('')}</div></section></div><section class="panel"><h3>Recent timeline · Decisions, messages, memory & errors</h3><div class="feed">${feed(a.events || [], false)}</div></section><div class="section-head"><h2>Complete saved timeline</h2><button id="load-timeline">${nextOffset === null ? 'All events loaded' : 'Load next 200 events'}</button></div><section class="panel"><div class="feed">${feed(historyRows, false)}</div></section>`;
}
function diagnostics() {
    const d = live.diagnostics, e = live.endurance;
    const checks = e ? `<section class="panel"><h3>Cloud preflight</h3><p>${esc(e.preflight?.label || 'Not checked')}</p><div class="kv">${(e.preflight?.rows || []).map(r => `<span>${esc(r.name)}</span><b class="${r.ready ? '' : 'muted'}">${r.ready ? 'Ready' : r.skipped ? 'Disabled' : 'Needs attention'}</b>${r.detail ? `<small class="check-detail">${esc(r.detail)}</small>` : ''}`).join('')}</div></section>` : '';
    const budgets = e ? `<section class="panel"><h3>Shared cloud budgets · ${esc(e.sessionHours)} hour session</h3><p>Paid fallback: ${e.allowPaidFallback ? 'Enabled in configuration' : 'Disabled'} · Pending decisions: ${esc(e.budget.queueLength)}</p><p class="muted">80% supports normal planning; 20% is protected for critical survival. Counts include failed attempts and conservative token reservations. All agents using a provider share these limits.</p><div class="details-grid">${Object.entries(e.budget.providers).map(([id,b]) => `<section><h3>${esc(id)}</h3><div class="kv"><span>Requests used / remaining</span><b>${b.usedRequests} / ${b.remainingRequests}</b><span>Normal / emergency remaining</span><b>${b.normalRemaining} / ${b.reserveRemaining}</b><span>Estimated tokens remaining</span><b>${b.estimatedRemainingTokens}</b><span>Active requests / failures</span><b>${b.health.active} / ${b.health.failures}</b><span>Provider cooldown</span><b>${b.health.openUntil > Date.now() ? new Date(b.health.openUntil).toLocaleTimeString() : 'None'}</b>${Object.entries(b.rolling).map(([window,v]) => `<span>Last ${esc(window)} requests / tokens</span><b>${v.requests} / ${v.tokens}</b>`).join('')}</div></section>`).join('')}</div></section>` : '';
    return `<div class="section-head"><h2>System diagnostics</h2><span class="badge online">LOCAL DASHBOARD</span></div>${checks}${budgets}<div class="details-grid"><section class="panel"><h3>Environment</h3><div class="kv"><span>Minecraft LAN port</span><b>${live.minecraft.available ? 'Detected' : 'Not found'}</b><span>Backend</span><b>${esc(d.backend)}</b><span>Realtime connection</span><b>${source?.readyState === 1 ? 'SSE connected' : 'Reconnecting'}</b><span>Node</span><b>${esc(d.node)}</b>${Object.entries(d.files).map(([file, ok]) => `<span>${esc(file)}</span><b>${ok ? 'OK' : 'Missing'}</b>`).join('')}</div><p class="muted">${esc(d.capabilityProfile)}</p><p class="muted">An Online agent has completed its Minecraft player checks. Brain availability is shown separately.</p></section><section class="panel"><h3>Brains and providers</h3>${Object.values(live.agents).map(a => `<p><b style="color:${esc(a.color)}">${esc(a.displayName)}</b> · ${a.enabled ? 'Enabled' : 'Disabled'}<br><small>${esc(a.model)} / ${esc(a.provider)}<br>${esc(words(a.brainState || 'Not started'))}</small><br><span class="muted">${esc(a.brainDetail?.reason || a.error || '')}</span></p>`).join('')}</section></div><section class="panel"><h3>Setup help</h3><p>API keys go in <b>keys.json</b>. Choose agents in <b>arena.config.json</b>. Cloud routes and your account’s free usage limits go in <b>brain.config.json</b>. The supplied numbers are local safety caps, not a promise of free access. See <b>TECH_GPT_README.md</b> for the steps, then restart Arena after changing configuration.</p><p>API failures preserve the Minecraft connection, goal, memory and pending plan. A real Minecraft disconnect reconnects using the saved runtime. No API key values are sent to this dashboard.</p></section>`;
}
async function historyPage() {
    const data = await fetch('/api/runs').then(r => r.json());
    if (location.hash !== '#history') return;
    $('#content').innerHTML = `<div class="section-head"><h2>Experiment runs</h2><button id="return-live">Return to live run</button></div><section class="panel"><p class="muted">Saved runs are read-only. Choose one, then use Overview, Comparison or an agent’s timeline.</p>${data.runs.map(run => `<button class="run-button" data-run="${esc(run)}">◷ ${esc(run)} ${run === live.runId ? ' · CURRENT' : ''}</button>`).join('')}</section>`;
}
let renderedContent = null;
function render() {
    if (!live) return; state = archive || live;
    const agents = Object.values(state.agents), online = agents.filter(a => ['online', 'paused'].includes(a.status));
    const world = online.find(a => a.dimension);
    $('#worldbar').innerHTML = `<div><span class="label">Minecraft LAN</span><strong>${archive ? 'SAVED RUN' : live.minecraft.available ? '<span class="dot"></span>PORT DETECTED' : '○ NOT DETECTED'}</strong></div><div><span class="label">Experiment</span><strong>${archive ? 'Archive · Read only' : live.experiment}</strong></div><div><span class="label">Elapsed</span><strong>${archive ? 'Saved session' : duration(Date.now() - Date.parse(state.startedAt))}</strong></div><div><span class="label">Agents online</span><strong>${online.length} / ${agents.filter(a => a.enabled).length}</strong></div><div><span class="label">World / Day</span><strong>${esc(words(world?.dimension || 'Unknown'))} / ${esc(world?.time?.day ?? 'N/A')}</strong></div>`;
    $('#notice').hidden = !archive && live.minecraft.available && !live.storageError;
    $('#notice').textContent = archive ? `Viewing saved run ${archive.runId}. Administrative controls are disabled. Return to live through Run history.` : live.storageError ? 'Telemetry storage error: ' + live.storageError : live.minecraft.message;
    $('#run-label').textContent = 'RUN ' + state.runId;
    const page = location.hash.slice(1) || 'overview';
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.hash === '#' + page));
    document.querySelectorAll('header [data-command]').forEach(b => b.disabled = !!archive);
    if (page !== loadedPage) { historyRows = []; nextOffset = 0; historyAgent = null; loadedPage = page; }
    const scroll = $('#content .feed')?.scrollTop || 0;
    if (page === 'history') { renderedContent = null; if (!$('#return-live')) historyPage(); return; }
    const content = page === 'compare' ? compare() : page === 'diagnostics' ? diagnostics() : page.startsWith('agent/') ? detail(page.split('/')[1]) : overview();
    if (content !== renderedContent) { $('#content').innerHTML = content; renderedContent = content; }
    if ($('#content .feed')) $('#content .feed').scrollTop = scroll;
}
document.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
        if (button.dataset.command) {
            if (archive) return;
            button.disabled = true;
            const res = await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Arena-Token': token }, body: JSON.stringify({ command: button.dataset.command, agent: button.dataset.agent }) });
            const data = await res.json(); if (!res.ok) throw new Error(data.error); toast('Control applied. Agent state updates live.');
        }
        if (button.dataset.filter) { filter = button.dataset.filter; render(); }
        if (button.id === 'recording') { recording = !recording; document.body.classList.toggle('recording', recording); button.textContent = recording ? '◎ Developer mode' : '◎ Recording mode'; filter = recording ? 'milestones' : 'all'; render(); }
        if (button.dataset.run) { const res = await fetch(`/api/runs/${encodeURIComponent(button.dataset.run)}/state`); const data = await res.json(); if (!res.ok) throw new Error(data.error); archive = data; location.hash = '#overview'; render(); }
        if (button.id === 'return-live') { archive = null; location.hash = '#overview'; render(); }
        if (button.id === 'load-timeline' && nextOffset !== null) {
            historyAgent = location.hash.split('/')[1];
            const res = await fetch(`/api/runs/${encodeURIComponent(state.runId)}/events?agent=${encodeURIComponent(historyAgent)}&offset=${nextOffset}`);
            const data = await res.json(); if (!res.ok) throw new Error(data.error);
            historyRows.push(...data.events); nextOffset = data.nextOffset; render();
        }
    } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
window.addEventListener('hashchange', render);
async function session() { token = (await fetch('/api/session').then(r => r.json())).token; }
await session();
source = new EventSource('/api/events');
source.addEventListener('snapshot', event => { live = JSON.parse(event.data); render(); });
source.onopen = () => { $('#transport').textContent = '● Live connection'; $('#transport').className = 'badge online'; session().catch(() => {}); };
source.onerror = () => { $('#transport').textContent = 'Reconnecting…'; $('#transport').className = 'badge reconnecting'; };
