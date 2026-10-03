import { parseDecision } from '../shared/decision.js';
import { installSafeMovement, inventoryCounts } from './gameplay.js';
import { decisionMessages } from './decision-context.js';

// These commands can bypass world-observed navigation and caused repeated fall deaths
// during the first live Arena run. Keep strategic movement tied to normal skills that
// discover targets from loaded world state.
export const FORBIDDEN = new Set(['!newAction', '!setMode', '!goal', '!endGoal', '!restart', '!clearChat', '!stfu', '!startConversation', '!endConversation', '!digDown', '!goToCoordinates']);
export function parsePlan(raw, validate) {
    const clean = parseDecision(raw).text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const data = JSON.parse(clean);
    if (!data.current_goal || !data.decision_summary || !Array.isArray(data.plan) || data.plan.length > 8) throw new Error('Decision must include a goal, public summary and at most eight steps.');
    const plan = data.plan.map(entry => {
        const step = entry && typeof entry === 'object' && /^!\w+$/.test(entry.command) && Array.isArray(entry.args)
            ? entry.command + '(' + entry.args.map(arg => JSON.stringify(arg)).join(',') + ')' : entry;
        if (typeof step !== 'string' || step.length > 300 || !/^!\w+(?:\([^\n]*\))?$/.test(step)) throw new Error('Each plan step must be one Mindcraft command.');
        const parsed = validate(step);
        if (typeof parsed === 'string' || FORBIDDEN.has(parsed.commandName) || parsed.args?.some(a => typeof a === 'number' && !Number.isFinite(a))) throw new Error(typeof parsed === 'string' ? `${parsed} Rejected step: ${step}. Supply every required argument; string arguments require double quotes.` : 'Forbidden plan command.');
        if (parsed.commandName === '!stay' && (parsed.args[0] < 0 || parsed.args[0] > 120)) throw new Error('Stay must be bounded to 0–120 seconds.');
        return step;
    });
    return { goal: String(data.current_goal).slice(0, 160), summary: String(data.decision_summary).slice(0, 420), plan, message: typeof data.message === 'string' ? data.message.replace(/[\r\n]/g, ' ').slice(0, 180) : '' };
}
export function playerState(bot) {
    const p = bot.entity?.position;
    return { health: Number.isFinite(bot.health) ? bot.health : null, hunger: Number.isFinite(bot.food) ? bot.food : null, position: p && [p.x,p.y,p.z].every(Number.isFinite) ? { x:p.x,y:p.y,z:p.z } : null, velocity: bot.entity?.velocity ? { x:bot.entity.velocity.x,y:bot.entity.velocity.y,z:bot.entity.velocity.z } : null, dimension: bot.game?.dimension || null, inventory: bot.inventory?.items?.().map(i => ({ name: i.name, count: i.count })) || [], gamemode: bot.game?.gameMode ?? null, difficulty: bot.game?.difficulty ?? null, effects: bot.entity?.effects || {}, attributes: bot.entity?.attributes || {}, isOnGround: bot.entity?.onGround ?? null };
}

export class AgentRuntime {
    constructor(agent, initial, emit, commands) {
        this.agent = agent; this.initial = initial; this.emit = emit; this.commands = commands;
        this.data = { schema: 1, agentId: initial.slot.id, minecraftName: initial.slot.minecraftName, model: initial.brain.model, objective: initial.slot.objective, goal: '', summary: '', plan: [], planIndex: 0, memories: [], events: [], discoveries: [], deaths: 0, lastDecision: null, lastResponse: null, previousAction: null, ...initial.runtime };
        this.ready = false; this.dead = false; this.busy = false; this.closed = false; this.requested = 4; this.lastRequest = 0; this.epoch = 0; this.lastCritical = 0;
        this.data.failures ||= []; this.data.recentChat ||= []; this.data.visited ||= [];
        this.lastChat = 0; this.nextDecisionAt = 0;
        this.data.currentAction = null; this.data.executionState = 'WAITING_FOR_DECISION'; this.data.minecraftState = 'SPAWNING'; this.data.brainState = 'READY';
        // A previous physical step is never replayed after reconnect. Keep its
        // strategic memory, but discard the action queue because the world and
        // player position may have changed while the worker was offline.
        if (initial.runtime) {
            this.data.plan = [];
            this.data.planIndex = 0;
            this.data.planInvalid = true;
            this.data.summary = 'Saved movement plan discarded; awaiting a safe reassessment.';
            this.note('Minecraft reconnect: saved physical plan discarded before reassessment.');
        }
    }
    note(text) { this.data.events.push({ at: Date.now(), text: String(text).slice(0, 350) }); this.data.events = this.data.events.slice(-16); }
    save() {
        const a = this.agent;
        this.data.player = playerState(a.bot || {}); this.data.updatedAt = Date.now();
        this.data.history = { memory: a.history?.memory || '', turns: (a.history?.turns || []).slice(-12) };
        this.data.places = a.memory_bank?.getJson() || this.data.places || {};
        if (process.connected) process.send({ kind: 'runtime_snapshot', snapshot: this.data });
        this.emit('runtime_state', { minecraftState: this.data.minecraftState, brainState: this.data.brainState, executionState: this.data.executionState, objective: this.data.objective, goal: this.data.goal, summary: this.data.summary, plan: this.data.plan, planIndex: this.data.planIndex, planInvalid: !!this.data.planInvalid, lastDecision: this.data.lastDecision, previousAction: this.data.previousAction, deaths: this.data.deaths, death: this.data.lastDeath });
    }
    bind(bot) {
        this.bot = bot;
        installSafeMovement(bot);
        if (this.initial.runtime?.history) { this.agent.history.memory = this.data.history.memory; this.agent.history.turns = this.data.history.turns; }
        if (this.data.places) this.agent.memory_bank.loadJson(this.data.places);
        this.agent.history.summarizeMemories = async turns => {
            // No auxiliary model call. Preserve explicit strategic memory separately.
            const important = turns.filter(t => t.role !== 'assistant').map(t => String(t.content).slice(0, 200));
            this.data.memories = [...this.data.memories, ...important].slice(-24);
            this.agent.history.memory = this.data.memories.join('\n').slice(-4000); this.save();
        };
        bot.on('spawn', () => { this.ready = false; this.spawned = true; this.data.minecraftState = 'VERIFYING_PLAYER_STATE'; this.verify(); });
        bot.on('health', () => {
            this.verify();
            const critical = bot.health > 0 && (bot.health <= 6 || bot.food <= 5);
            if (critical && Date.now() - this.lastCritical > 60000) { this.lastCritical = Date.now(); this.trigger(1, 'Critical health or hunger: reassess safety.', true); }
        });
        bot.on('death', () => this.onDeath());
        bot.on('messagestr', (text, _, json) => { if (json?.translate?.startsWith('death') && text.startsWith(this.agent.name) && this.data.lastDeath) { this.data.lastDeath.cause = text.slice(0, 300); this.save(); } });
        bot.on('end', () => { this.ready = false; this.data.minecraftState = 'DISCONNECTED'; this.save(); });
        this.timer = setInterval(() => { this.verify(); this.tick().catch(e => this.failure(e)); }, 1000); this.timer.unref();
        this.snapshotTimer = setInterval(() => this.save(), 5000); this.snapshotTimer.unref();
    }
    verify() {
        if (this.ready) return;
        if (!this.spawned || !this.started || !Number.isFinite(this.bot.health) || this.bot.health <= 0 || !Number.isFinite(this.bot.food) || !playerState(this.bot).position) { this.stableSince = null; return; }
        if (!this.stableSince) { this.stableSince = Date.now(); return; }
        if (Date.now() - this.stableSince < 500) return;
        const respawn = this.dead; this.dead = false; this.ready = true; this.data.minecraftState = 'CONNECTED';
        this.emit(respawn ? 'respawn' : 'agent_connected', { version: this.bot.version, player: playerState(this.bot) });
        this.emit('player_preflight', playerState(this.bot));
        this.trigger(respawn ? 1 : 4, respawn ? 'Respawn complete. Reassess recovery using death location and prior inventory.' : 'Player state verified.', false);
    }
    start() {
        this.started = true;
        // Optional idle collection/hunting used to dominate every pause between
        // plan steps. Leave food, evasion, defense and unstuck reactions enabled.
        for (const [name,on] of [['hunting',false],['item_collecting',false],['elbow_room',false],['cowardice',true]]) {
            if (this.bot?.modes?.exists(name)) this.bot.modes.setOn(name,on);
        }
        this.verify();
    }
    trigger(priority, reason, interrupt = false) {
        this.requested = Math.min(this.requested || 5, priority); this.note(reason);
        if (interrupt) { this.epoch++; this.data.planInvalid = true; this.stopPhysical(); this.agent.arenaBrainClient?.cancel(); }
        this.save();
    }
    stopPhysical() {
        this.agent.actions?.cancelResume();
        try { this.agent.requestInterrupt(); this.bot.clearControlStates(); } catch (error) { this.note('Action cancellation: ' + error.message); }
    }
    onDeath() {
        if (this.dead) return;
        this.dead = true; this.ready = false; this.spawned = false; this.stableSince = 0; this.epoch++;
        this.data.lastDeath = { at: Date.now(), ...playerState(this.bot), inventory: this.data.player?.inventory || playerState(this.bot).inventory };
        this.data.deaths++; this.data.minecraftState = 'RESPAWNING'; this.data.planInvalid = true; this.data.currentAction = null;
        this.agent.arenaBrainClient?.cancel();
        this.stopPhysical(); this.emit('death', this.data.lastDeath); this.note('Died; retain memories/objective and choose recovery after respawn.'); this.requested = 1; this.save();
        // Mineflayer normally auto-respawns. Only request if still dead after its handler.
        setTimeout(() => { if (this.dead && this.bot.health <= 0 && !this.closed) this.bot.respawn(); }, 1500).unref();
    }
    async message(source, text) {
        text=String(text).slice(0,350);
        if (source === this.agent.name || /^(Picking up item!|Fighting |I'm stuck!|I'm free\.)/.test(text)) return;
        if (source !== 'system') {
            const last=this.data.recentChat.at(-1);
            if(last?.source===source && last.text===text && Date.now()-last.at<30000) return;
            this.data.recentChat=[...this.data.recentChat,{source,text,at:Date.now()}].slice(-5);
        }
        this.note(`${source}: ${text}`); await this.agent.history.add(source, text);
        this.trigger(4, 'Consider the message while continuing useful work.');
    }
    context() {
        const p = playerState(this.bot);
        const world = this.commands.observe?.(this.bot) || {};
        return { identity:this.agent.name, objective:this.data.objective.slice(0,220),goal:this.data.goal,
            player:{health:p.health,hunger:p.hunger,position:p.position,inventory:inventoryCounts(this.bot)},world,
            shelter:this.data.shelter,visited:this.data.visited.slice(-4),chat:this.data.recentChat.slice(-3),
            memory:this.data.memories.slice(-3),events:this.data.events.slice(-3).map(e=>e.text.slice(0,200)),
            failures:this.data.failures.slice(-3).map(({command,reason})=>({command,reason})),previousAction:this.data.previousAction };
    }
    async tick() {
        if (this.closed || !this.ready || this.busy || this.agent.arenaPaused || this.agent.actions.executing) return;
        const maxInterval = this.initial.brainSettings.maxDecisionIntervalMs || 600000;
        const remaining = !this.data.planInvalid && this.data.planIndex < this.data.plan.length;
        if (remaining && this.requested !== 1) return this.step();
        if (Date.now() < this.nextDecisionAt && this.requested !== 1) return;
        if (!this.requested && Date.now() - this.lastRequest < maxInterval) return;
        if (Date.now() - this.lastRequest < 10000) return;
        this.busy = true; const epoch = this.epoch; this.lastRequest = Date.now();
        const priority = this.requested || 5; this.requested = null;
        this.data.executionState = 'SAFE_HOLD'; this.save();
        try {
            const messages=decisionMessages(this.context(),this.commands.catalog,this.initial.brainSettings.maxInputBytes ?? 4608);
            const result = await this.agent.arenaBrainClient.request(messages, priority);
            if (this.closed || this.agent.arenaPaused || epoch !== this.epoch || !this.ready) { this.requested = this.dead ? 1 : 2; return; }
            const decision = parsePlan(result.text, this.commands.parseCommandMessage);
            if (!decision.plan.length && this.bot.health > 6 && this.bot.food > 5) throw new Error('Choose useful progression or exploration; full health is not a reason to stop.');
            const previousGoal=this.data.goal;
            Object.assign(this.data, { goal:decision.goal,summary:decision.summary,plan:decision.plan,planIndex:0,planInvalid:false,lastDecision:Date.now(),lastResponse:decision.summary,provider:result.provider,executionState:decision.plan.length ? 'EXECUTING_PLAN' : 'SAFE_HOLD' });
            this.note('Decision: ' + decision.summary);
            this.emit('decision_created', { current_goal:decision.goal,decision_summary:decision.summary,next_action:decision.plan[0] || 'Wait',plan:decision.plan });
            this.nextDecisionAt=decision.plan.length ? 0 : Date.now()+30000;
            if (!decision.plan.length) this.requested=4;
            const publicMessage=decision.message || (previousGoal!==decision.goal && this.initial.peers?.some(n=>n!==this.agent.name && this.bot.players?.[n]?.entity) ? `I'm working on: ${decision.goal}.` : '');
            if (publicMessage && !publicMessage.startsWith('/') && Date.now()-this.lastChat>=60000) { this.bot.chat(publicMessage); this.lastChat=Date.now(); }
            await this.agent.history.add(this.agent.name, JSON.stringify(decision));
        } catch (error) { this.note('Decision unavailable: ' + error.message); this.requested = Math.min(this.requested || 5, 2); this.data.executionState = 'SAFE_HOLD'; }
        finally { this.busy = false; this.save(); }
    }
    async step() {
        this.busy = true; const step = this.data.plan[this.data.planIndex], epoch = this.epoch;
        this.data.currentAction = step; this.data.executionState = 'EXECUTING_PLAN'; this.save();
        try {
            const p=this.bot.entity?.position;
            const fingerprint=JSON.stringify([inventoryCounts(this.bot),p && [Math.floor(p.x/4),Math.floor(p.y/4),Math.floor(p.z/4)]]);
            if (this.data.failures.some(f=>f.command===step && f.inventory===fingerprint && Date.now()-f.at<120000)) {
                this.data.planInvalid=true; this.trigger(2,'Do not repeat the same failed action with unchanged inventory; explore or change the prerequisite.'); return;
            }
            this.agent.arenaLastOutcome = null;
            const result = await this.commands.executeCommand(this.agent, step);
            if (epoch !== this.epoch || !this.ready) return;
            this.data.previousAction = { command:step,result:String(result ?? this.agent.arenaLastOutcome ?? 'Completed').slice(0,300),at:Date.now() };
            if (this.agent.arenaLastOutcome === 'action_failed' || result === false) {
                this.data.failures=[...this.data.failures,{command:step,inventory:fingerprint,reason:String(result).slice(0,160),at:Date.now()}].slice(-6);
                this.data.planInvalid = true; this.trigger(2, 'Plan step failed: ' + step);
            }
            else if (this.agent.arenaLastOutcome === 'action_interrupted') { this.data.planInvalid = true; this.trigger(2, 'Plan interrupted; reassess.'); }
            else { this.data.planIndex++; if (this.data.planIndex === this.data.plan.length) this.trigger(3, 'Plan completed.'); }
        } catch (error) { this.data.planInvalid = true; this.trigger(2, 'Action failed: ' + error.message); }
        finally { this.data.currentAction = null; this.busy = false; this.save(); }
    }
    failure(error) { this.note(error.message); this.data.executionState = 'SAFE_HOLD'; this.save(); }
    pause() { this.agent.arenaPaused = true; this.epoch++; this.stopPhysical(); this.data.executionState = 'PAUSED'; this.agent.arenaBrainClient.cancel(); this.save(); }
    resume() { this.agent.arenaPaused = false; this.data.planInvalid = true; this.trigger(2, 'Operator resumed; check saved plan against current world.'); }
    close() { this.closed = true; clearInterval(this.timer); clearInterval(this.snapshotTimer); this.agent.arenaBrainClient.cancel(); this.save(); }
}
