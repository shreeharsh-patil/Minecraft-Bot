import { emit } from './telemetry/runtime.js';
import { publicError } from './shared/security.js';
import { BrainClient } from './brain/client.js';
import { AgentRuntime, FORBIDDEN } from './brain/runtime.js';
import { createGameplayCommands } from './brain/gameplay.js';

let agent, initial, stopping = false, ready = false, controlQueue = Promise.resolve();
async function stop() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(0), 10000);
    try {
        if (agent) {
            agent.arenaRuntime?.close();
            agent.arenaPaused = true; agent.shut_up = true;
            agent.actions?.cancelResume();
            if (agent.bot) { agent.requestInterrupt(); agent.bot.clearControlStates(); }
            await agent.self_prompter?.stop();
            agent.history?.save();
            agent._disconnectHandled = true; // planned quit must not trigger upstream crash exit
            agent.bot?.quit('Arena stopped');
        }
    } catch (error) { emit('error', { message: publicError(error) }); }
    clearTimeout(deadline); setTimeout(() => process.exit(0), 100);
}
async function control(command) {
    if (command === 'stop') return stop();
    if (!agent) { if (initial) initial.paused = command === 'pause'; return; }
    if (command === 'pause') {
        agent.arenaRuntime?.pause();
        agent.arenaPaused = true; agent.shut_up = true;
        agent.actions?.cancelResume();
        if (agent.bot) { agent.requestInterrupt(); agent.bot.clearControlStates(); agent.bot.autoEat?.disable?.(); }
        await agent.self_prompter?.pause();
        emit('agent_status', { status: 'paused', phase: 'Paused' });
    } else if (command === 'resume') {
        agent.arenaPaused = false; agent.shut_up = false;
        if (ready) { agent.bot.autoEat?.enable?.(); if (agent.arenaRuntime) agent.arenaRuntime.resume(); else agent.self_prompter.start(initial.slot.objective); }
        emit('agent_status', { status: ready ? 'online' : 'starting', phase: ready ? 'Observing' : 'Starting' });
    }
}
async function initialize(message) {
    initial = message;
    emit('startup_progress', { message: 'Loading Mindcraft engine.' });
    // Set shared settings before dynamically importing the engine: mcdata captures
    // Minecraft version at module initialization.
    const { setSettings } = await import('../src/agent/settings.js');
    const { default: defaults } = await import('../settings.js');
    setSettings({ ...defaults, profile: message.slot.profile, host: message.minecraft.host === 'localhost' ? '127.0.0.1' : message.minecraft.host, port: message.minecraft.port, minecraft_version: message.minecraft.version,
        base_profile: 'survival', allow_insecure_coding: false, allow_vision: false, render_bot_view: false, speak: false, log_all_prompts: false, load_memory: message.loadMemory,
        blocked_actions: [...new Set([...defaults.blocked_actions, '!newAction', '!setMode', '!endGoal', ...(message.brain ? FORBIDDEN : [])])], init_message: null, arena: true });
    // These modules share a circular graph. Importing all three as independent
    // dynamic entry points can deadlock evaluation around provider discovery.
    const { Agent } = await import('../src/agent/agent.js');
    const { serverProxy } = await import('../src/agent/mindserver_proxy.js');
    const { default: convo } = await import('../src/agent/conversation.js');
    emit('startup_progress', { message: 'Initializing agent profile and Minecraft connection.' });
    agent = new Agent(); agent.arenaPaused = !!message.paused;
    if (message.brain) {
        const commands = await import('../src/agent/commands/index.js');
        const { actionsList } = await import('../src/agent/commands/actions.js');
        const skills = await import('../src/agent/library/skills.js');
        const { default: pf } = await import('mineflayer-pathfinder');
        agent.arenaBrainClient = new BrainClient(message.brain.model);
        agent.arenaRuntime = new AgentRuntime(agent, message, emit, createGameplayCommands(commands, actionsList, skills, pf));
    }
    // Adapter for Mindcraft's communication interface. No agent receives observer
    // state, other profiles or private memories. Bot messages travel in Minecraft.
    serverProxy.agent = agent; serverProxy.name = message.slot.minecraftName; serverProxy.connected = true;
    serverProxy.agents = message.peers.map(name => ({ name, in_game: false }));
    serverProxy.socket = { emit(type, target, data) {
        if (type === 'chat-message' && agent.bot && !agent.arenaPaused) agent.bot.whisper(target, String(data.message).slice(0, 220));
        if (type === 'shutdown') emit('error', { message: 'Agent attempted global shutdown; use the observer dashboard controls.' });
    } };
    const handle = agent.handleMessage.bind(agent);
    agent.handleMessage = async (...args) => agent.arenaPaused || stopping ? false : agent.arenaRuntime ? agent.arenaRuntime.message(...args) : handle(...args);
    const update = agent.update.bind(agent);
    agent.update = async (...args) => {
        if (agent.arenaPaused || stopping) return;
        if (agent.arenaRuntime) { if (agent.arenaRuntime.ready) { try { await agent.bot.modes.update(); } catch (e) { agent.arenaRuntime.failure(e); } } return; }
        return update(...args);
    };
    const events = agent.startEvents.bind(agent);
    agent.startEvents = () => {
        events(); ready = true;
        // Upstream suppresses public chat when multiple agents are present. Arena
        // needs the actual in-world conversation, not a private observer channel.
        agent.bot.on('chat', (from, text) => {
            if (!agent.arenaRuntime || from === agent.name || agent.arenaPaused) return;
            if (serverProxy.getNumOtherAgents() > 0 || message.peers.includes(from)) {
                agent.arenaRuntime.message(from, text).catch(error => agent.arenaRuntime.failure(error));
            }
        });
        agent.bot.on('whisper', (from, text) => {
            if (message.peers.includes(from) && from !== agent.name && !agent.arenaPaused) {
                if (agent.arenaRuntime) agent.arenaRuntime.message(from, text).catch(error => agent.arenaRuntime.failure(error));
                else convo.receiveFromBot(from, { message: text, start: !convo.inConversation(from), end: text.includes('!endConversation') }).catch(error => emit('error', { message: publicError(error) }));
            }
        });
        let reportedStopped = false;
        setInterval(() => {
            const peers = message.peers.map(name => ({ name, in_game: !!agent.bot.players[name] }));
            serverProxy.agents = peers; convo.updateAgents(peers);
            const stopped = !agent.arenaRuntime && !agent.arenaPaused && agent.self_prompter.isStopped();
            if (stopped && !reportedStopped) emit('autonomy_stopped', { message: 'Mindcraft stopped autonomous prompting after repeated invalid responses. Resume to retry.' });
            reportedStopped = stopped;
        }, 5000).unref();
        if (agent.arenaRuntime) agent.arenaRuntime.start();
        else if (!agent.arenaPaused) agent.self_prompter.start(message.slot.objective);
        else control('pause').catch(error => emit('error', { message: publicError(error) }));
    };
    await agent.start(message.loadMemory, null, 0);
}
process.on('message', message => {
    if (message.kind === 'brain_state' && agent?.arenaRuntime) { agent.arenaRuntime.data.brainState = message.payload.state; if (message.payload.provider) agent.arenaRuntime.data.provider = message.payload.provider; }
    if (message.kind === 'init' && !initial) initialize(message).catch(error => { emit('error', { message: publicError(error) }); setTimeout(() => process.exit(1), 100); });
    if (message.kind === 'control') controlQueue = controlQueue.then(() => control(message.command)).catch(error => emit('error', { message: publicError(error) }));
});
process.on('disconnect', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('uncaughtException', error => { console.error(error.stack); emit('error', { message: publicError(error) }); if (agent?.arenaRuntime) { agent.arenaRuntime.pause(); agent.arenaRuntime.failure(error); } else setTimeout(() => process.exit(1), 100); });
process.on('unhandledRejection', error => { emit('error', { message: publicError(error) }); if (agent?.arenaRuntime) { agent.arenaRuntime.trigger(2, publicError(error), true); } else setTimeout(() => process.exit(1), 100); });
