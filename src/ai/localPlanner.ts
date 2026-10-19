/**
 * The algorithmic (zero-API) planner: a drop-in replacement for the LLM
 * `Planner` that needs no API keys at all.
 *
 * It reads the same `PlanRequest`, consults the same `CompactContext`, and
 * returns the same allowlist-validated `PlanResult`. Where the LLM planner
 * reasons with a model, this one reasons like a person reading a short chat
 * line: normalise -> drop noise -> spot the verb -> spot target/quantity ->
 * ground the target against world state -> emit allowlisted actions.
 *
 * Hard safety properties (same bar as the LLM path):
 *  - only `BotAction` shapes from the closed allowlist, parameters clamped;
 *  - never invents coordinates: only explicit numbers or context positions;
 *  - text answers are composed here from game data, bounded, and pass the
 *    validator's injection screen before ever reaching the facade;
 *  - unfinished vocabulary/state objects are never mutated (pure passes).
 *  - anything unclear becomes a helpful `say`, never a guessed action.
 */
import type { CompactContext } from './contextBuilder.js';
import {
  extractCount,
  findVocabEntries,
  matchPhrase,
  normalize,
  normalizeMinimal,
  splitClauses,
  similarity,
  tokenize,
  type VocabEntry,
} from './local/language.js';
import type { PlanRequest, PlanResult } from './planner.js';
import type { BotAction } from '../types/actions.js';
import { silentLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

export interface LocalPlannerOptions {
  logger?: Logger;
  /** Ceiling on actions per request, mirroring the LLM planner. */
  maxActions?: number;
}

/** Matches the LLM planner's per-plan ceiling. */
const DEFAULT_MAX_ACTIONS = 8;

/** Parameter clamps (kept in step with validator ceilings). */
const LIMITS = {
  count: 512,
  durationMs: 60_000,
  radius: 32,
} as const;

export const FOLLOW_DISTANCE = 3;
export const DEFEND_RADIUS = 8;
export const MINE_DEFAULT_COUNT = 16;

/** Trigger phrases. Order matters only for iteration cost, not for scores. */
const PHRASES: Readonly<Record<string, readonly string[]>> = {
  stop: ['stop', 'halt', 'cancel', 'abort', 'quit', 'cease', 'stand down', 'never mind', 'enough', 'stop it', 'back off'],
  follow: ['follow', 'follow me', 'come with me', 'stick with me', 'stay with me', 'escort', 'walk with me', 'keep up', 'come along', 'stay close'],
  defend: ['guard', 'guard me', 'protect', 'protect me', 'defend', 'defend me', 'shield me', 'watch my back', 'bodyguard', 'keep me safe'],
  attack: ['attack', 'kill', 'fight', 'strike', 'finish it', 'take it down'],
  mine: ['mine', 'dig', 'chop', 'collect', 'gather', 'harvest', 'farm'],
  mine_loose: ['get me', 'grab me', 'go get', 'fetch', 'bring'],
  eat: ['eat', 'feed yourself', 'grab a bite', 'snack'],
  equip: ['equip', 'hold', 'wield'],
  pickup: ['pick up', 'scoop', 'collect the drops', 'grab the drops', 'clean up'],
  deposit: ['deposit', 'stash', 'store'],
  withdraw: ['withdraw', 'take out', 'take it out', 'get out of', 'grab out of'],
  build: ['build', 'construct', 'make'],
  place: ['place', 'put down'],
  wait: ['wait', 'pause', 'hold on', 'hold still'],
  look: ['look', 'face', 'turn'],
  move: ['go', 'goto', 'walk', 'move', 'head', 'travel', 'run'],
};

/** Does <phrase> appear (typos tolerated, exact > fuzzy)? */
function phraseStrength(words: readonly string[], phrase: string): number {
  const match = matchPhrase(words, phrase);
  return match.matched ? match.strength : 0;
}

/** Sum of phrase strengths for an intent. */
function intentScore(words: readonly string[], name: keyof typeof PHRASES): number {
  let total = 0;
  for (const phrase of PHRASES[name] ?? []) {
    total = Math.max(total, phraseStrength(words, phrase));
  }
  return total;
}

function hasWord(words: readonly string[], ...candidates: string[]): boolean {
  return candidates.some((candidate) => words.includes(candidate));
}

export class LocalPlanner {
  private readonly logger: Logger;
  private readonly maxActions: number;

  constructor(options: LocalPlannerOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
  }

  /**
   * The entry point used by AIManager. Never throws for bad input: unclear or
   * unsafe requests resolve to a `say` action that explains what does work.
   */
  public plan(request: PlanRequest): Promise<PlanResult> {
    return Promise.resolve(this.computePlan(request));
  }

  private computePlan(request: PlanRequest): PlanResult {
    const started = Date.now();
    if (request.signal?.aborted) {
      return {
        actions: [],
        dropped: [{ reason: 'aborted-before-start', raw: null }],
        provider: null,
        latencyMs: 0,
        rawText: '',
      };
    }

    const intents: string[] = [];
    const actions: BotAction[] = [];
    const dropped: Array<{ reason: string; raw: unknown }> = [];
    const ctx = request.context;
    const requester = request.requester.slice(0, 16);

    // Human self-preservation: a hurt bot eats before it works, and something
    // breathing down its neck gets attacked first. Skipped entirely when the
    // request was "stop" or a pure chat answer.
    let pending: BotAction[] = [];

    // Split on the minimal normalisation so anything understood starts whole;
    // politeness is only stripped later for the verb engine.
    const lightClauses = splitClauses(normalizeMinimal(request.instruction));

    for (const light of lightClauses) {
      if (actions.length + pending.length >= this.maxActions) {
        dropped.push({ reason: 'max-actions-exceeded', raw: light });
        break;
      }

      // Questions & small talk answer first, on intact text.
      const answer = this.answerQuestion(light, ctx, requester);
      if (answer !== undefined) {
        intents.push('say');
        pending.push({ type: 'say', message: answer });
        continue;
      }

      const words = tokenize(normalize(light));
      const parsed = this.handleClause({ raw: light, words }, ctx, requester);
      if (parsed.intent === 'unknown' || parsed.intent === 'none') {
        if (parsed.actions.length > 0) pending.push(...parsed.actions);
        continue;
      }
      intents.push(parsed.intent);
      pending.push(...parsed.actions);
    }

    // Nothing understood anything: end conversationally instead of silently.
    if (pending.length === 0) {
      intents.push('say');
      pending.push({
        type: 'say',
        message:
          "I couldn't work out what that means. Try !help, or plain requests like " +
          "'mine 20 logs', 'follow me', 'bring me 10 logs', 'eat', or 'what can you do?'.",
      });
    } else {
      // Self-preservation precedes every task (a hurt bot snacks first, a
      // threatened bot defends first) but never rides on bare "stop"/chit-chat.
      const care = this.selfCareActions(ctx, pending);
      pending = [...care, ...pending];
    }

    for (const action of pending) {
      if (actions.length >= this.maxActions) {
        dropped.push({ reason: 'max-actions-exceeded', raw: action.type });
        break;
      }
      actions.push(this.bound(action));
    }

    return {
      actions,
      dropped,
      provider: null,
      latencyMs: Math.max(1, Date.now() - started),
      rawText: `local:${intents.join('+')}`,
    };
  }

  // --- per-clause understanding -------------------------------------------------

  private handleClause(
    clause: { raw: string; words: string[] },
    ctx: CompactContext,
    requester: string,
  ): { intent: string; actions: BotAction[] } {
    if (clause.words.length === 0) return { intent: 'none', actions: [] };
    const rawClause = clause.raw;

    // A clause may be one of two shapes: coordinates ("go to 100 64 -200")
    // or a verb phrase with a quantity ("mine 20 logs"). Coordinates are
    // detected first because count extraction would tear them apart.
    const clauseCoordinates = this.findCoordinates(clause.words);
    let count: number | undefined;
    let restWords = clause.words;
    if (clauseCoordinates === undefined) {
      const countExtraction = extractCount(rawClause);
      if (countExtraction) {
        count = countExtraction.count;
        restWords = tokenize(countExtraction.rest);
      }
    }
    const referredClause = { raw: rawClause, words: restWords, count };
    const words = restWords;

    // The answer path sees the fully intact clause (pronouns matter there).
    const answer = this.answerQuestion(rawClause, ctx, requester);
    if (answer !== undefined) return { intent: 'say', actions: [{ type: 'say', message: answer }] };

    const scores = new Map<string, number>();
    const addScore = (intent: string, amount: number): void => {
      if (amount <= 0) return;
      scores.set(intent, (scores.get(intent) ?? 0) + amount);
    };

    addScore('follow', intentScore(words, 'follow'));
    addScore('stop', intentScore(words, 'stop'));
    addScore('defend', intentScore(words, 'defend'));
    addScore('attack', intentScore(words, 'attack'));
    addScore('mine', intentScore(words, 'mine'));
    addScore('mine', intentScore(words, 'mine_loose'));
    addScore('eat', intentScore(words, 'eat'));
    if (hasWord(words, 'hungry')) addScore('eat', 0.6);
    addScore('equip', intentScore(words, 'equip'));
    addScore('pickup', intentScore(words, 'pickup'));
    addScore('deposit', intentScore(words, 'deposit'));
    addScore('withdraw', intentScore(words, 'withdraw'));
    addScore('build', intentScore(words, 'build'));
    addScore('place', intentScore(words, 'place'));
    addScore('wait', intentScore(words, 'wait'));
    addScore('look', intentScore(words, 'look'));
    addScore('goto', intentScore(words, 'move'));

    // A chest mention locks deposit/withdraw onto chest verbs.
    if (phraseStrength(words, 'chest') > 0) {
      if (scores.get('deposit') === undefined && scores.get('withdraw') === undefined) {
        if (hasWord(words, 'into', 'in')) addScore('deposit', 0.4);
        if (hasWord(words, 'from', 'out')) addScore('withdraw', 0.4);
      }
    }
    // Coordinates sometimes carry the movement intent by themselves.
    if (clauseCoordinates !== undefined) addScore('goto', 1.2);
    // "come to me" beats a bare 'go' score.
    if (hasWord(words, 'come') || phraseStrength(words, 'over here') > 0) addScore('come', 0.8);

    // The world target steers verb choice ("steak" -> eat, "zombie" -> attack).
    const target = this.resolveTarget(words, ctx);
    if (target) {
      if (target.entry.kind === 'block') {
        if (hasWord(words, 'give', 'drop', 'toss')) addScore('drop', 0.4);
        else addScore('mine', 0.35);
      } else if (target.entry.kind === 'item') {
        if (hasWord(words, 'give', 'drop', 'toss')) addScore('drop', 0.4);
        else addScore('equip', 0.45);
      } else if (target.entry.kind === 'food') {
        addScore(hasWord(words, 'give', 'drop', 'toss') ? 'drop' : 'eat', 0.5);
      } else {
        addScore('attack', 0.65);
      }
    }
    if (hasWord(words, 'give', 'drop', 'toss', 'throw')) addScore('drop', 0.8);
    if (phraseStrength(words, 'in chest') > 0 || phraseStrength(words, 'in the chest') > 0) addScore('deposit', 0.5);

    if (scores.size === 0) return { intent: 'unknown', actions: [] };

    // Top score wins; ties resolve by insertion order (declared priorities).
    let bestIntent = 'unknown';
    let bestScore = 0;
    for (const [intent, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intent;
      }
    }
    if (bestScore < 0.6) return { intent: 'unknown', actions: [{ type: 'say', message: this.unsureMessage(referredClause.raw) }] };

    switch (bestIntent) {
      case 'stop':
        return { intent: 'stop', actions: [{ type: 'stop' }] };
      case 'come': {
        return { intent: 'come', actions: [{ type: 'move_to_player', player: requester }] };
      }
      case 'goto':
        return this.buildGoto(referredClause.words, ctx, requester);
      case 'follow':
        return this.buildPlayerAction(referredClause.words, ctx, requester, 'follow');
      case 'defend':
        return this.buildPlayerAction(referredClause.words, ctx, requester, 'defend');
      case 'attack':
        return this.buildAttack(referredClause, ctx);
      case 'mine':
        return this.buildMine(referredClause, target, ctx, requester);
      case 'drop':
        return this.buildDrop(referredClause, ctx);
      case 'deposit':
        return { intent: 'deposit', actions: [{ type: 'deposit_items' }] };
      case 'withdraw':
        return this.buildWithdraw(referredClause);
      case 'pickup':
        return { intent: 'pickup', actions: [{ type: 'pickup_items', radius: 8 }] };
      case 'equip':
        return this.buildEquip(referredClause, ctx);
      case 'eat':
        return this.buildEat(referredClause, ctx);
      case 'build':
        return this.buildBuild(referredClause.words, ctx);
      case 'place':
        return this.buildPlace(referredClause.words, ctx);
      case 'look':
        return this.buildLook(referredClause.words, ctx);
      case 'wait':
        return this.buildWait(referredClause);
      default: {
        this.logger.debug('local planner: no intent', { clause: clause.raw });
        return { intent: 'unknown', actions: [{ type: 'say', message: this.unsureMessage(clause.raw) }] };
      }
    }
  }

  private unsureMessage(clause: string): string {
    const topic = clause.length === 0 ? 'that' : clause.replace(/_/g, ' ');
    return `I understood '${topic.slice(0, 60).trim()}' but not what to do. Try '!help' or something like 'follow me', 'mine 20 stone', 'equip sword'.`;
  }

  // --- movement / body -----------------------------------------------------------

  /** follow / defend share one player resolution. */
  private buildPlayerAction(
    words: readonly string[],
    ctx: CompactContext,
    requester: string,
    kind: 'follow' | 'defend',
  ): { intent: string; actions: BotAction[] } {
    // "follow me" or a bare verb means the requester; a recognised name means
    // that player. Anything else still defaults to the requester - the only
    // people who can call this are authorized, so they mean themselves.
    let player = requester;
    outer: for (const word of words) {
      if (word === 'me' || word === 'myself' || word === 'here' || word.length < 3) continue;
      for (const candidate of ctx.nearbyPlayers) {
        const lower = candidate.name.toLowerCase();
        if (lower === word || similarity(word, lower) >= 0.86) {
          player = candidate.name;
          break outer;
        }
      }
    }
    if (kind === 'follow') {
      return { intent: 'follow', actions: [{ type: 'follow_player', player, distance: FOLLOW_DISTANCE }] };
    }
    return { intent: 'defend', actions: [{ type: 'defend_player', player, radius: DEFEND_RADIUS }] };
  }

  private buildGoto(words: readonly string[], _ctx: CompactContext, requester: string): { intent: string; actions: BotAction[]} {
    const coordinates = this.findCoordinates(words);
    if (coordinates) {
      return { intent: 'goto', actions: [{ type: 'move_to_position', position: coordinates, maxDistance: 1.5 }] };
    }
    if (hasWord(words, 'me', 'here', 'myself')) {
      return { intent: 'come', actions: [{ type: 'move_to_player', player: requester }] };
    }
    return this.sayOnly("Give me coordinates, like 'go to 100 64 -200', or use '!remember home' then '!home'.");
  }

  private buildLook(words: readonly string[], ctx: CompactContext): { intent: string; actions: BotAction[] } {
    const coordinates = this.findCoordinates(words);
    if (coordinates) {
      return { intent: 'look', actions: [{ type: 'look_at', position: coordinates, durationMs: 2000 }] };
    }
    if (hasWord(words, 'around', 'camera', 'here')) {
      return { intent: 'look', actions: [{ type: 'look_at', position: this.anchor(ctx), durationMs: 3000 }] };
    }
    return this.sayOnly("Say 'look around', or give coordinates like 'look at 100 64 -200'.");
  }

  private buildWait(clause: { raw: string; words: string[]; count?: number }): { intent: string; actions: BotAction[] } {
    const unit = hasWord(clause.words, 'minutes', 'minute', 'min') ? 60 : 1;
    const seconds = clause.count !== undefined ? clause.count * unit : 3;
    const durationMs = Math.min(LIMITS.durationMs, Math.max(1_000, Math.round(seconds * 1000)));
    return { intent: 'wait', actions: [{ type: 'wait', durationMs }] };
  }

  // --- mining ----------------------------------------------------------------

  private buildMine(
    clause: { raw: string; words: string[]; count?: number },
    target: { entry: VocabEntry } | undefined,
    ctx: CompactContext,
    requester: string,
  ): { intent: string; actions: BotAction[] } {
    if (!target) return this.sayOnly('What should I mine or collect? Try "mine 20 stone" or "collect 5 wood".');
    if (target.entry.kind === 'hostile') return this.buildAttack(clause, ctx);
    if (target.entry.kind === 'food' || target.entry.kind === 'item') {
      return this.buildCollect(clause, target.entry, ctx);
    }
    const count = clampCount(clause.count ?? MINE_DEFAULT_COUNT);
    const grounded = this.groundBlock(target.entry.id, ctx);
    const actions: BotAction[] = [{ type: 'mine_block', blockName: grounded, count }];
    if (hasWord(clause.words, 'bring', 'deliver', 'carry')) {
      actions.push({ type: 'move_to_player', player: requester, maxDistance: 2 });
    }
    return { intent: 'mine', actions };
  }

  /** collect_resource handles "get me 20 iron ingots" style asks. */
  private buildCollect(
    clause: { raw: string; words: string[]; count?: number },
    entry: VocabEntry,
    ctx: CompactContext,
  ): { intent: string; actions: BotAction[] } {
    const count = clampCount(clause.count ?? MINE_DEFAULT_COUNT);
    const inventory = ctx.inventory.items.find((item) => item.name === entry.id);
    void inventory;
    return { intent: 'collect', actions: [{ type: 'collect_resource', resource: entry.id, count }] };
  }

  // --- inventory ----------------------------------------------------------------

  private buildDrop(clause: { raw: string; words: string[]; count?: number }, ctx: CompactContext): { intent: string; actions: BotAction[] } {
    const item = this.resolveItemName(clause, ctx);
    if (!item) return this.sayOnly('Drop what item?');
    const count = clause.count === undefined ? undefined : clampCount(clause.count, 2304);
    return {
      intent: 'drop',
      actions: [{ type: 'drop_item', item, where: 'floor', ...(count !== undefined ? { count } : {}) }],
    };
  }

  private buildWithdraw(clause: { raw: string; words: string[]; count?: number }): { intent: string; actions: BotAction[] } {
    if (matchPhrase(clause.words, 'chest').matched === false && !hasWord(clause.words, 'withdraw', 'take', 'get')) {
      return this.sayOnly('From where? Mention "from the chest".');
    }
    const hit = this.plainVocab(clause.words, ['item', 'block', 'food']);
    const count = clause.count === undefined ? undefined : clampCount(clause.count, 2304);
    return {
      intent: 'withdraw',
      actions: [
        { type: 'withdraw_items', ...(hit !== undefined ? { item: hit.entry.id } : {}), ...(count !== undefined ? { count } : {}) },
      ],
    };
  }

  private buildEquip(clause: { raw: string; words: string[]; count?: number }, ctx: CompactContext): { intent: string; actions: BotAction[] } {
    const item = this.resolveItemName(clause, ctx);
    if (!item) return this.sayOnly('Equip what? Mention the item, like "equip the sword".');
    return { intent: 'equip', actions: [{ type: 'equip_item', item }] };
  }

  private buildEat(clause: { raw: string; words: string[]; count?: number }, ctx: CompactContext): { intent: string; actions: BotAction[] } {
    const item = this.resolveItemName(clause, ctx);
    if (item) return { intent: 'eat', actions: [{ type: 'eat', item }] };
    return { intent: 'eat', actions: [{ type: 'eat' }] };
  }

  private buildAttack(clause: { raw: string; words: string[]; count?: number }, ctx: CompactContext): { intent: string; actions: BotAction[] } {
    const target = this.resolveTarget(clause.words, ctx);
    const named = target !== undefined && target.entry.kind === 'hostile' ? target.entry.id : undefined;
    if (named === undefined && ctx.nearbyHostiles.length === 0) {
      return { intent: 'attack', actions: [{ type: 'attack_hostile', radius: 16 }] };
    }
    const radius = clampRadius(16);
    return { intent: 'attack', actions: [{ type: 'attack_hostile', ...(named !== undefined ? { target: named } : {}), radius }] };
  }

  // --- building / placement ------------------------------------------------------

  private buildBuild(words: readonly string[], ctx: CompactContext): { intent: string; actions: BotAction[] } {
    let structure: 'wall' | 'platform' | 'simple_house' | undefined;
    if (phraseStrength(words, 'wall') > 0) structure = 'wall';
    else if (phraseStrength(words, 'house') > 0 || phraseStrength(words, 'shelter') > 0 || phraseStrength(words, 'hut') > 0) {
      structure = 'simple_house';
    } else if (phraseStrength(words, 'platform') > 0 || phraseStrength(words, 'floor') > 0 || phraseStrength(words, 'bridge') > 0) {
      structure = 'platform';
    }
    if (!structure) return this.sayOnly("I can build a wall, a platform, or a simple house - try 'build a wall here'.");

    const materialHit = this.plainVocab(words, ['block']);
    const material = materialHit?.entry.id;
    return {
      intent: 'build',
      actions: [{
        type: 'build_structure',
        structure,
        position: this.anchor(ctx),
        dimensions: structure === 'wall' ? { length: 8, height: 3 } : { size: 5 },
        ...(material !== undefined ? { material } : {}),
      }],
    };
  }

  private buildPlace(words: readonly string[], ctx: CompactContext): { intent: string; actions: BotAction[] } {
    const hit = this.plainVocab(words, ['block', 'item']);
    if (!hit) return this.sayOnly("Place what? For example 'place a torch here'.");
    return {
      intent: 'place',
      actions: [{ type: 'place_block', blockName: hit.entry.id, position: this.anchor(ctx) }],
    };
  }

  // --- questions & knowledge ("help others") --------------------------------------

  private sayOnly(message: string): { intent: string; actions: BotAction[] } {
    return { intent: 'say', actions: [{ type: 'say', message }] };
  }

  /**
   * Composes an answer purely from context + static knowledge.
   * Returns undefined when the clause is not a known question, so verbs win.
   */
  private answerQuestion(raw: string, ctx: CompactContext, requester: string): string | undefined {
    // QA must see intact text: "thanks" and "you" survive here.
    const normalized = normalizeMinimal(raw);

    if (/^(hi|hello|hey|yo|sup|howdy|good (morning|afternoon|evening|day))\b/.test(normalized)) {
      return this.pick(
        [
          `Hello ${requester}! Type !help for commands, or just ask - try 'mine 20 logs', 'follow me', 'build a wall', or 'what can you do?'.`,
          `Hey ${requester}. What do you need? Say 'what can you do?' for the full list.`,
        ],
        normalized,
      );
    }
    if (/^(thanks|thank you|ty|appreciate)/.test(normalized)) {
      return `You're welcome, ${requester}.`;
    }
    if (/\b(joke|funny|make me laugh)\b/.test(normalized)) return this.pick(JOKES, normalized);
    if (/\b(what can you do|what do you do|your abilities|your commands|list commands)\b/.test(normalized)) {
      return CAPABILITIES;
    }
    if (/\b(how are you|are you ok|are you okay|your health|your hp|are you hurt|are you hungry)\b/.test(normalized)) {
      const state = ctx.health.current / Math.max(1, ctx.health.max);
      const mood = state > 0.8 ? 'Doing fine' : state > 0.4 ? 'A bit beaten up' : 'Barely standing';
      const hungry = ctx.hunger.current <= 6 ? ' and rather peckish' : '';
      return `${mood}: ${Math.round(ctx.health.current)}/${ctx.health.max} HP, food ${ctx.hunger.current}/20${hungry}, in ${ctx.dimension}.`;
    }
    if (/\b(where are you|your position|your coordinates)\b/.test(normalized)) {
      const p = ctx.position;
      return `I'm in ${ctx.dimension} at x=${Math.round(p.x)}, y=${Math.round(p.y)}, z=${Math.round(p.z)}. Say 'come' and I'll join you.`;
    }
    if (/\b(what do you have|your inventory|what are you carrying|your items|what have you got)\b/.test(normalized)) {
      const items = ctx.inventory.items.slice(0, 6).map((entry) => `${entry.count}x ${entry.name.replace(/_/g, ' ')}`);
      if (items.length === 0) return 'Nothing at all - my inventory is empty.';
      return `Carrying ${items.join(', ')}${ctx.inventory.items.length > 6 ? ' and more' : ''}. In hand: ${ctx.inventory.held ?? 'nothing'}.`;
    }
    if (/\b(who is (online|here|around)|anyone (online|here))\b/.test(normalized)) {
      if (ctx.nearbyPlayers.length === 0) return 'No players near me right now.';
      const list = ctx.nearbyPlayers.slice(0, 5).map((p) => `${p.name} (${Math.round(p.distance)}m)`);
      return `Players nearby: ${list.join(', ')}.`;
    }
    if (/\b(what (time|day) is it|is it (night|day))\b/.test(normalized)) {
      const danger = ctx.timeOfDay === 'night'
        ? ' Watch out - mobs spawn in the dark. Say "guard me" and I will protect you.'
        : '';
      return `It is ${ctx.timeOfDay} in ${ctx.dimension}.${danger}`;
    }
    if (/\b(what do you see|what is nearby|what is around|what is here|what blocks)\b/.test(normalized)) {
      const blocks = ctx.nearbyBlocks.slice(0, 4).map((b) => `${b.name.replace(/_/g, ' ')} (${Math.round(b.distance)}m)`);
      const hostiles = ctx.nearbyHostiles.slice(0, 3).map((h) => h.name);
      if (blocks.length === 0 && hostiles.length === 0) return 'Not much - open terrain as far as I can tell.';
      return [
        'Nearby: ', blocks.join(', '),
        hostiles.length > 0 ? `. Heads up - I can see ${hostiles.join(', ')}!` : '.',
      ].join('');
    }
    if (/\bhow many\b/.test(normalized)) {
      // Search backward: "how many iron swords do you have" points at the last
      // mentioned noun, and real similarity keeps plurals ranking high.
      const hits = [...tokenize(normalized)].reverse()
        .map((word) => findVocabEntries(word)[0])
        .filter((hit): hit is NonNullable<typeof hit> => hit !== undefined && hit.strength >= 0.6);
      const wanted = hits.sort((a, b) => b.strength - a.strength)[0]?.entry;
      if (wanted) {
        const total = ctx.inventory.items
          .filter((item) => item.name === wanted.id || item.name.startsWith(`${wanted.id}_`))
          .reduce((sum, item) => sum + item.count, 0);
        return `I count ${total} ${wanted.id.replace(/_/g, ' ')} in my inventory.`;
      }
    }
    // Static survival school: the tips part of "help others".
    if (/^(how do i|how can i|how to|what is a|what are|tips? (for|about))/.test(normalized)) {
      return topicAnswer(normalized) ??
        'I know a bit about: diamonds, pickaxes, the first day, creepers, lava, food, endermen. Ask like "how do I get diamonds?".';
    }
    if (/\b(are you ai|are you a bot|are you real)\b/.test(normalized)) {
      return "I'm your algorithmic companion bot - all local logic, no cloud AI. And all the cooler for it.";
    }
    return undefined;
  }

  /** Deterministic rotation through a phrase pool: varied but reproducible. */
  private pick(options: readonly string[], seed: string): string {
    if (options.length === 0) return '';
    let value = 0;
    for (let index = 0; index < seed.length; index++) value = (value * 31 + seed.charCodeAt(index)) | 0;
    return options[Math.abs(value) % options.length] ?? options[0] ?? '';
  }

  // --- helpers: world grounding ---------------------------------------------------

  /** One self-preservation pass, purely additive and skippable. */
  private selfCareActions(ctx: CompactContext, pending: readonly BotAction[]): BotAction[] {
    if (pending.some((action) => action.type === 'stop') || pending.every((action) => action.type === 'say')) {
      return [];
    }
    const care: BotAction[] = [];
    const threat = ctx.nearbyHostiles.find((hostile) => hostile.distance <= 5);
    if (threat && !pending.some((action) => action.type === 'attack_hostile' || action.type === 'defend_player')) {
      const target = threat.name.slice(0, 32);
      care.push({ type: 'attack_hostile', target, radius: 6 });
    }
    if (ctx.health.current <= ctx.health.max * 0.4 && !pending.some((action) => action.type === 'eat') && ctx.hunger.current <= 6) {
      care.push({ type: 'eat' });
    }
    return care;
  }

  /**
   * Longest vocab match across the clause, two-word chunks first, then single
   * words. Falls back to verbatim world/inventory names ("spruce_log").
   * Returns a COPY the caller is free to refine; the shared vocabulary and
   * the context are never mutated.
   */
  private resolveTarget(words: readonly string[], ctx: CompactContext): { entry: VocabEntry } | undefined {
    for (let width = Math.min(3, words.length); width >= 1; width--) {
      for (let start = words.length - width; start >= 0; start--) {
        const chunk = words.slice(start, start + width).join(' ');
        const hit = findVocabEntries(chunk)[0];
        if (hit && hit.strength >= 0.65) {
          const entry = { ...hit.entry };
          if (entry.kind === 'block') entry.id = this.groundBlock(entry.id, ctx);
          return { entry };
        }
      }
    }
    const worldNames = [
      ...ctx.nearbyBlocks.map((block) => block.name),
      ...ctx.inventory.items.map((item) => item.name),
    ];
    for (const name of worldNames) {
      const index = words.findIndex((word) => similarity(word, name) >= 0.86);
      if (index >= 0) return { entry: { id: name, words: [name], kind: 'block' } };
    }
    return undefined;
  }

  /** "oak_log" defaults map onto the log species actually standing nearby. */
  private groundBlock(blockId: string, ctx: CompactContext): string {
    if (blockId === 'oak_log') {
      const nearbyLog = ctx.nearbyBlocks.find((block) => block.name.endsWith('_log'));
      if (nearbyLog) return nearbyLog.name;
    }
    return blockId;
  }

  /** Item id for an action, upgraded to exact inventory content when known. */
  private resolveItemName(
    clause: { raw: string; words: string[]; count?: number },
    ctx: CompactContext,
  ): string | undefined {
    const hit = this.resolveTarget(clause.words, ctx);
    if (hit) {
      if (hit.entry.kind === 'item' || hit.entry.kind === 'food' || hit.entry.kind === 'block') {
        if (hit.entry.words.some((word) => word === 'sword')) {
          const owned = ctx.inventory.items.find((item) => item.name.endsWith('sword'));
          if (owned) return owned.name;
        }
        return hit.entry.id;
      }
    }
    const inventoryName = ctx.inventory.items
      .map((item) => item.name)
      .find((name) => clause.words.some((word) => similarity(word, name) >= 0.86));
    return inventoryName;
  }

  /** Raw vocabulary hit without world grounding. */
  private plainVocab(
    words: readonly string[],
    kinds: readonly VocabEntry['kind'][],
  ): { entry: VocabEntry; strength: number } | undefined {
    for (let width = Math.min(2, words.length); width >= 1; width--) {
      for (let start = words.length - width; start >= 0; start--) {
        const chunk = words.slice(start, start + width).join(' ');
        const hit = findVocabEntries(chunk).find((candidate) => kinds.includes(candidate.entry.kind));
        if (hit) return { entry: hit.entry, strength: hit.strength };
      }
    }
    return undefined;
  }

  /** Finds a coordinate triple. Never invents coordinates. */
  private findCoordinates(words: readonly string[]): { x: number; y: number; z: number } | undefined {
    for (let index = 0; index + 2 < words.length; index++) {
      const [x, y, z] = [words[index] ?? '', words[index + 1] ?? '', words[index + 2] ?? ''].map((word) =>
        /^-?\d{1,7}$/.test(word) ? Number.parseInt(word, 10) : undefined,
      );
      if (x === undefined || y === undefined || z === undefined) continue;
      if (Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000 || Math.abs(y) > 2048) continue;
      return { x, y, z };
    }
    return undefined;
  }

  /** Anchor for place/look: the bot's own position from context. */
  private anchor(ctx: CompactContext): { x: number; y: number; z: number } {
    return { x: Math.round(ctx.position.x), y: Math.round(ctx.position.y), z: Math.round(ctx.position.z) };
  }

  // --- final safety binding -------------------------------------------------------

  /**
   * Last clamp before an action leaves the planner: counts/durations inside
   * limits, `say` text bounded and injection-screened.
   */
  private bound(action: BotAction): BotAction {
    if (action.type === 'say') {
      const message = action.message.length > 200 ? `${action.message.slice(0, 197)}...` : action.message;
      return { ...action, message };
    }
    if (action.type === 'wait') {
      return { ...action, durationMs: Math.min(LIMITS.durationMs, Math.max(1, Math.round(action.durationMs))) };
    }
    if (action.type === 'look_at') {
      const durationMs = action.durationMs === undefined ? undefined : Math.min(LIMITS.durationMs, Math.max(0, action.durationMs));
      return { ...action, ...(durationMs !== undefined ? { durationMs } : {}) };
    }
    return action;
  }
}

// --- tiny shared utilities -----------------------------------------------------------

function clampCount(value: number, max: number = LIMITS.count): number {
  return Math.max(1, Math.min(max, Math.round(value)));
}

function clampRadius(value: number): number {
  return Math.max(1, Math.min(LIMITS.radius, Math.round(value)));
}

function topicAnswer(normalized: string): string | undefined {
  for (const topic of TOPICS) {
    if (topic.keywords.some((keyword) => normalized.includes(keyword))) return topic.answer;
  }
  return undefined;
}

const JOKES: readonly string[] = [
  'Why did the creeper break up with the skeleton? Too much explosive drama.',
  'I told a block of stone a joke. It just took it for granite.',
  'I would tell you an obsidian joke, but you would never see through it.',
  'Skeletons never fight fair - they always get right to the arrow.',
];

const CAPABILITIES =
  'I can follow/come to you, mine or collect blocks, drop/stash/withdraw items, ' +
  'equip gear, eat, build walls or houses, defend you, fight mobs, and answer ' +
  'Minecraft questions - all offline. Try: mine 20 logs | bring me 10 wood | build a wall | what time is it?';

const TOPICS: ReadonlyArray<{ keywords: string[]; answer: string }> = [
  { keywords: ['diamond'], answer: 'Diamonds live around y -59 to -53. Bring an iron pickaxe, dig a staircase, and never mine straight down.' },
  { keywords: ['pickaxe'], answer: 'Three planks + two sticks makes a wooden pickaxe. Then stone, then iron. Skip nothing.' },
  { keywords: ['first day', 'beginner', 'start', 'survive'], answer: 'First day recipe: punch a tree, make tools, shelter before dusk, torches everywhere, food ready.' },
  { keywords: ['creeper'], answer: 'Creepers hiss at ~3 blocks and are scared of cats. Sprint hit knocks them back - keep moving.' },
  { keywords: ['lava'], answer: 'Never dig straight down; carry a water bucket. Where lava meets water, you get obsidian or stone.' },
  { keywords: ['food', 'eat', 'hungry', 'farm'], answer: 'Early game: bread, cooked meat or berries. Golden carrots are the best snack you can farm.' },
  { keywords: ['silence'], answer: '...' },
];
