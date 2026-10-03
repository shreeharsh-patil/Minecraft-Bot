import { randomUUID } from 'node:crypto';
import { MONITOR_PROMPT, parseDecision } from '../shared/decision.js';
import { publicError } from '../shared/security.js';

export function emit(type, payload = {}) {
    if (process.env.ARENA_WORKER !== '1' || !process.connected) return;
    process.send({ kind: 'event', type, payload }, () => {});
}

export function observePrompter(prompter) {
    if (process.env.ARENA_WORKER !== '1') return;
    if (prompter.agent?.arenaBrainClient) return; // Gateway owns abortable requests, telemetry and quotas.
    const spec = typeof prompter.profile.model === 'string' ? { model: prompter.profile.model } : prompter.profile.model;
    emit('identity', { provider: prompter.chat_model.constructor.prefix || spec.api, model: prompter.chat_model.model_name || spec.model });
    const seen = new Set();
    for (const model of [prompter.chat_model, prompter.code_model, prompter.vision_model, prompter.embedding_model]) {
        if (!model || seen.has(model)) continue;
        seen.add(model);
        if (!model.sendRequest) continue;
        const request = model.sendRequest.bind(model);
        model.sendRequest = async (...args) => {
            const id = randomUUID(), start = Date.now();
            emit('model_request_started', { id });
            const timeout = setTimeout(() => {
                emit('brain_state', { state: 'TEMPORARILY_UNAVAILABLE', reason: 'Legacy provider request is still pending. Minecraft remains connected.' });
            }, 90000);
            try {
                const response = await request(...args);
                if (typeof response !== 'string' || !response.trim()) throw new Error('Provider returned an empty or non-text response.');
                if (/^My brain disconnected|^Error:|^API request failed/i.test(response)) throw new Error('Provider request failed. Check model access, quota and endpoint in Diagnostics.');
                emit('model_response_received', { id, latencyMs: Date.now() - start });
                return response;
            } catch (error) { emit('error', { source: 'model', message: publicError(error) }); throw error; }
            finally { clearTimeout(timeout); }
        };
    }
}
export function monitoringPrompt(prompt) { return process.env.ARENA_WORKER === '1' ? prompt + MONITOR_PROMPT : prompt; }
let lastGoal = null;
export function monitoringResponse(response) {
    if (process.env.ARENA_WORKER !== '1') return response;
    const result = parseDecision(response);
    if (result.decision) {
        emit('decision_created', result.decision);
        if (lastGoal !== result.decision.current_goal) { lastGoal = result.decision.current_goal; emit('goal_changed', { goal: lastGoal }); }
    }
    else emit('monitor_warning', { message: result.error });
    return result.text;
}
export async function modelRetry(attempt) {
    if (process.env.ARENA_WORKER !== '1') return;
    const delayMs = Math.min(30000, 5000 * 2 ** attempt);
    emit('model_retry', { attempt: attempt + 1, delayMs });
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

export function observeBot(agent) {
    if (process.env.ARENA_WORKER !== '1') return;
    const bot = agent.bot;
    // createBot returns before plugins finish injecting after version detection.
    // Observe connection failures immediately; wrap plugin methods on login.
    for (const event of ['end', 'kicked', 'error']) bot.prependListener(event, reason => emit(event === 'error' ? 'error' : 'connection_event', { event, message: (typeof reason === 'object' && !reason?.message ? JSON.stringify(reason) : String(reason?.message || reason)).slice(0, 1500) }));
    agent.arenaRuntime?.bind(bot);
    bot.once('login', () => emit('minecraft_login', { state: 'VERIFYING_PLAYER_STATE' }));
    if (!bot.chat) {
        const ready = () => installBotObservers(agent);
        bot.once('login', ready);
        return () => bot.off('login', ready);
    }
    return installBotObservers(agent);
}

function installBotObservers(agent) {
    const bot = agent.bot;
    let previousPosition = null, previousDimension = null, lastHealth, lastHunger, inventoryKey, spawned = false;
    const uniqueItems = new Set();
    const removers = [];
    const on = (target, event, handler) => { target.on(event, handler); removers.push(() => target.off(event, handler)); };
    on(bot, 'spawn', () => { if (!agent.arenaRuntime) emit(spawned ? 'respawn' : 'agent_connected', { version: bot.version }); spawned = true; previousPosition = null; });
    on(bot, 'death', () => { previousPosition = null; if (!agent.arenaRuntime) emit('death'); });
    const sampleVitals = () => {
        if (Number.isFinite(bot.health) && bot.health !== lastHealth) { emit('health_changed', { health: bot.health }); lastHealth = bot.health; }
        if (Number.isFinite(bot.food) && bot.food !== lastHunger) { emit('hunger_changed', { hunger: bot.food }); lastHunger = bot.food; }
    };
    on(bot, 'health', sampleVitals);
    on(bot, 'chat', (from, message) => emit('chat_received', { from, message }));
    on(bot, 'whisper', (from, message) => emit('chat_received', { from, message, private: true }));
    on(bot, 'diggingCompleted', block => {
        emit('stat_increment', { stat: 'blocksMined', amount: 1 });
        emit('block_mined', { block: block?.name });
        if (agent.arenaAction) {
            const action = agent.arenaAction;
            if (!action.target || block?.name === action.target) action.mined++;
            emit('action_progress', { mined: action.mined, target: action.target, total: action.total });
        }
    });
    on(bot, 'path_update', result => {
        if (result.status === 'noPath' || result.status === 'timeout') emit('error', { source: 'pathfinder', message: `Pathfinding: ${result.status}` });
    });
    const originalChat = bot.chat.bind(bot);
    bot.chat = message => {
        if (agent.arenaPaused) return;
        // Survival arena never permits slash commands except player communication.
        if (message.startsWith('/') && !/^\/(?:msg|tell|w)\s/i.test(message)) { emit('error', { message: 'Blocked a non-chat Minecraft command in survival arena.' }); return; }
        emit('chat_sent', { message }); return originalChat(message);
    };
    for (const [method, stat] of [['placeBlock', 'blocksPlaced'], ['craft', 'itemsCrafted'], ['consume', 'foodConsumed']]) {
        if (typeof bot[method] !== 'function') continue;
        const original = bot[method].bind(bot);
        bot[method] = async (...args) => {
            if (agent.arenaPaused) throw new Error('Agent is paused.');
            const result = await original(...args);
            const amount = method === 'craft' ? (args[0]?.result?.count || 1) * (args[1] || 1) : 1;
            emit('stat_increment', { stat, amount });
            if (method === 'craft') emit('milestone', { message: 'Crafted items', amount, itemId: args[0]?.result?.id });
            return result;
        };
    }
    const execute = agent.actions._executeAction.bind(agent.actions);
    agent.actions._executeAction = async (label, fn, timeout) => {
        if (agent.arenaPaused) return { success: false, interrupted: true, message: 'Agent paused.' };
        const id = randomUUID(); let started, actionResult;
        const result = await execute(label, async () => {
            if (agent.arenaPaused) return false;
            const metadata = fn.arena;
            started = Date.now(); agent.arenaAction = { id, mined: 0, target: metadata?.command === 'collectBlocks' ? metadata.args[0] : null, total: metadata?.command === 'collectBlocks' ? metadata.args[1] : null };
            emit('action_started', { id, action: label.replace(/^action:/, ''), args: metadata?.args || [] });
            actionResult = await fn(); return actionResult;
        }, timeout > 0 ? timeout : 5);
        if (started) {
            const type = result.timedout ? 'action_failed' : result.interrupted ? 'action_interrupted' : result.success && actionResult !== false ? 'action_completed' : 'action_failed';
            agent.arenaLastOutcome = type;
            emit(type, { id, action: label.replace(/^action:/, ''), durationMs: Date.now() - started, message: result.message, timedout: !!result.timedout });
            if (agent.arenaAction?.id === id) agent.arenaAction = null;
        }
        return result;
    };
    const saveMemory = agent.history.summarizeMemories.bind(agent.history);
    agent.history.summarizeMemories = async (...args) => { const result = await saveMemory(...args); emit('memory_created', { summary: parseDecision(agent.history.memory || '').text }); return result; };
    const positionTimer = setInterval(() => {
        if (!spawned || !bot.entity?.position) return;
        const { x, y, z } = bot.entity.position;
        const position = { x, y, z };
        const distance = previousPosition && previousDimension === bot.game.dimension ? Math.hypot(x - previousPosition.x, y - previousPosition.y, z - previousPosition.z) : 0;
        // Large jumps are respawns/teleports, not travelled distance.
        emit('position_updated', { position, distance: distance < 20 ? distance : 0 });
        previousPosition = position; previousDimension = bot.game.dimension;
    }, 500);
    const sampleInventory = () => {
        const items = bot.inventory.items().map(({ name, count, slot }) => ({ name, count, slot }));
        for (const item of items) uniqueItems.add(item.name);
        const key = JSON.stringify(items);
        if (inventoryKey !== key) { inventoryKey = key; emit('inventory_changed', { items, uniqueItems: uniqueItems.size }); }
    };
    let inventoryTimer;
    if (bot.inventory?.on) on(bot.inventory, 'updateSlot', () => {
        clearTimeout(inventoryTimer); inventoryTimer = setTimeout(sampleInventory, 50);
    });
    const worldTimer = setInterval(() => {
        if (!spawned || !bot.entity?.position) return;
        sampleInventory();
        const nearby = Object.values(bot.entities).filter(e => e.id !== bot.entity.id && e.position && (e.type === 'mob' || e.type === 'player' || e.username))
            .map(e => ({ name: e.username || e.name || e.displayName || 'Entity', distance: +e.position.distanceTo(bot.entity.position).toFixed(1) }))
            .filter(e => e.distance <= 32).sort((a, b) => a.distance - b.distance).slice(0, 10);
        const blocks = bot.findBlocks?.({ matching: b => /(?:_log|_ore|crafting_table|furnace|chest)$/.test(b.name), maxDistance: 12, count: 6 }) || [];
        for (const p of blocks) { const block = bot.blockAt(p); if (block) nearby.push({ name: block.name, distance: +p.distanceTo(bot.entity.position).toFixed(1) }); }
        emit('world_updated', { dimension: bot.game?.dimension, time: { day: bot.time?.day ?? null, timeOfDay: bot.time?.timeOfDay ?? null }, armor: bot.inventory.slots.slice(5, 9).map(i => i ? { name: i.name, count: i.count } : null), nearby });
        sampleVitals();
    }, 2000);
    return () => { clearInterval(positionTimer); clearInterval(worldTimer); clearTimeout(inventoryTimer); removers.forEach(remove => remove()); };
}
