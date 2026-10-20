/**
 * Detects danger (lava, fire, hostile mobs, hazard blocks) and moves away from
 * it. Cancels promptly and reports rather than throwing.
 *
 * There is no `escape_danger` action type, so this is deliberately NOT a
 * registry `Skill`: it is the shared "get out of trouble" routine that the
 * follow and defend skills call on every tick, before they do anything else.
 */
import { HOSTILE_MOB_FAMILIES, MOVEMENT } from '../../config/constants.js';
import type { BlockRef, MinecraftFacade } from '../../types/facade.js';
import type { EntitySummary } from '../../types/world.js';
import type { SkillResult } from '../../types/skill.js';
import type { ExecutionContext } from '../../types/task.js';
import type { Vec3Like } from '../../types/world.js';
import { clamp, failedResult, navigateToPosition } from '../internal/helpers.js';

/** How close a hazard has to be before the escape reflex kicks in. */
export const ESCAPE_RADIUS = 3;
/** How far the bot tries to get away from the hazard. */
export const ESCAPE_DISTANCE = 6;

/**
 * Blocks the bot walks through on purpose, so they never trigger the escape.
 *
 * The pathfinder allows water ("it is not instant death and refusing it would
 * make the bot unable to cross rivers or swim to the player it is following"
 * - PATHING_HAZARDS). Fleeing from water would pull the bot out of every
 * river and beach it swims near.
 */
const CROSSABLE_BLOCKS: ReadonlySet<string> = new Set(['water', 'flowing_water']);

export interface EscapeDangerParams {
  /** How far to move away from the hazard. */
  distance?: number;
  /** How far to look for hazards. */
  radius?: number;
  /**
   * Only flee from hazard blocks, not from hostile mobs.
   *
   * The guard uses this: running away from the zombie it is supposed to fight
   * would be worse than the zombie.
   */
  hazardsOnly?: boolean;
}

export interface DangerReport {
  hazardousBlocks: BlockRef[];
  hostiles: EntitySummary[];
}

/**
 * Is this block one the bot has to get away from?
 *
 * The facade decides what is dangerous to stand on; water is the one thing
 * the bot crosses on purpose, so it never counts as danger.
 */
function isHazardBlock(facade: MinecraftFacade, block: BlockRef): boolean {
  if (CROSSABLE_BLOCKS.has(block.name)) return false;
  return facade.isDangerous(block.position) || block.name === 'lava' || block.name === 'fire';
}

/** Scans for hazards around the bot. Pure-ish: read-only facade calls. */
export function detectDanger(facade: MinecraftFacade, radius: number): DangerReport {
  const hazardousBlocks = facade.scanNearbyBlocks(radius).filter((block) => isHazardBlock(facade, block));
  const hostiles = facade
    .getNearbyEntities(radius)
    .filter((entity) => isHostile(entity));
  return { hazardousBlocks, hostiles };
}

export function isHostile(entity: EntitySummary): boolean {
  // A player is never a hostile mob, whatever their username looks like
  // ("Slime", "Guardian" and "ZombieHunter" are all valid player names).
  if (entity.type === 'player') return false;
  if (entity.type === 'hostile') return true;
  const name = entity.name.toLowerCase();
  if (name.startsWith('hostile_')) return true;
  for (const family of HOSTILE_MOB_FAMILIES) {
    // Exact mob id only: a substring test classified real players as mobs,
    // so the bot attacked them.
    if (name === family) return true;
  }
  return false;
}

/**
 * Is the bot standing in something that will hurt it?
 *
 * Only HAZARD BLOCKS count: a hostile mob is a reason to fight, not to run -
 * that is what the defend skill is for. The follow and defend tick loops
 * call this so the escape reflex is actually wired in.
 */
export function needsEscape(facade: MinecraftFacade, radius: number = ESCAPE_RADIUS): boolean {
  for (const block of facade.scanNearbyBlocks(radius)) {
    if (isHazardBlock(facade, block)) return true;
  }
  return false;
}

export class EscapeDangerSkill {
  /** Escape is a reflex, not a model action, so it has no action type. */
  public readonly conflictGroups: readonly string[] = ['movement'];

  constructor(private readonly facade: MinecraftFacade) {}

  /** Moves away from nearby danger. Resolves once the bot is clear (or gave up). */
  public async execute(params: EscapeDangerParams = {}, ctx: ExecutionContext): Promise<SkillResult> {
    const radius = clamp(params.radius ?? MOVEMENT.SCAN_RADIUS, 2, 16);
    // The same hop the follow and defend reflexes use.
    const escapeDistance = clamp(params.distance ?? ESCAPE_DISTANCE, 2, 24);

    if (ctx.signal.aborted) return { ok: false, detail: 'Cancelled before I moved.', count: 0 };

    const { hazardousBlocks, hostiles: allHostiles } = detectDanger(this.facade, radius);
    const hostiles = params.hazardsOnly === true ? [] : allHostiles;
    if (hazardousBlocks.length === 0 && hostiles.length === 0) {
      return { ok: true, detail: "Nothing dangerous nearby.", count: 0 };
    }

    const here = this.facade.getPosition();
    // A hazard block hurts more than a mob, so it pulls harder.
    const hazards: EscapeThreat[] = hazardousBlocks.map((b) => ({ position: b.position, weight: 2 }));
    const mobs: EscapeThreat[] = hostiles.map((e) => ({ position: e.position, weight: 1 }));

    // Run away along the summed vector pointing away from every threat.
    //
    // Units: every contribution is an INFLUENCE in 1/blocks (weight divided
    // by the distance), so a threat right next to the bot counts far more
    // than one across the room. The sum is a direction with a magnitude in
    // 1/blocks; it is normalised to a unit vector and only then scaled by
    // `escapeDistance` (blocks) to get the actual step.
    //
    // A sum can still point AT a threat: a mob right in front of the bot
    // pulls harder than the lava behind it, and the escape would walk the
    // bot straight through the lava. Hazards therefore have the last word -
    // the escape never moves towards one.
    const direction = planEscape(here, hazards, mobs);
    if (direction === null) {
      return failedResult('I cannot tell which way is safe.', 0);
    }

    const target: Vec3Like = {
      x: here.x + direction.x * escapeDistance,
      y: here.y,
      z: here.z + direction.z * escapeDistance,
    };

    const outcome = await navigateToPosition(this.facade, ctx, target, {
      description: 'Moving away from danger',
      // Escape moves are shorter hops; no need to hug the target exactly.
      arriveDistance: 2,
    });

    if (outcome.status === 'cancelled') {
      return { ok: false, detail: 'Cancelled while escaping.', count: 0 };
    }
    if (outcome.status === 'arrived') {
      const summary = describeThreats(hazardousBlocks, hostiles);
      return { ok: true, detail: `Moved away from ${summary}.`, count: hazards.length + mobs.length };
    }
    return failedResult(`I couldn't get away from ${describeThreats(hazardousBlocks, hostiles)}.`, 0);
  }
}

function describeThreats(blocks: readonly BlockRef[], hostiles: readonly EntitySummary[]): string {
  const parts: string[] = [];
  if (blocks.length > 0) parts.push('the hazard');
  if (hostiles.length > 0) {
    const names = [...new Set(hostiles.map((e) => e.name))].slice(0, 3);
    parts.push(names.join(', '));
  }
  return parts.length > 0 ? parts.join(' and ') : 'the danger';
}

/** A direction in the horizontal plane. */
interface EscapeVector {
  x: number;
  z: number;
}

/** Something the bot may want to run away from. */
interface EscapeThreat {
  /** Where the threat is. */
  position: Vec3Like;
  /** How hard it pulls: a hazard block hurts more than a mob. */
  weight: number;
}

/** How one threat pulls the bot away from it. */
interface ThreatPull {
  /** The unit direction that leads away from the threat. */
  away: EscapeVector;
  /** How far the threat is, in blocks. */
  distance: number;
  /** How hard the threat pulls, in 1/blocks. */
  influence: number;
}

/**
 * How a single threat pulls the bot away from it.
 *
 * The influence is the weight divided by the distance, so it is in 1/blocks:
 * a threat right next to the bot counts far more than one across the room.
 */
function pullFrom(here: Vec3Like, threat: EscapeThreat): ThreatPull {
  const dx = here.x - threat.position.x;
  const dz = here.z - threat.position.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.01) {
    // Directly on top of it: pick an arbitrary but deterministic direction.
    // The influence is the closest one possible (weight / 1 block).
    return { away: { x: 1, z: 0 }, distance: 0, influence: threat.weight };
  }
  return {
    away: { x: dx / length, z: dz / length },
    distance: length,
    influence: threat.weight / Math.max(length, 1),
  };
}

/** Sums the pulls of every threat into one vector. */
function sumPulls(pulls: readonly ThreatPull[]): EscapeVector {
  let ax = 0;
  let az = 0;
  for (const pull of pulls) {
    ax += pull.away.x * pull.influence;
    az += pull.away.z * pull.influence;
  }
  return { x: ax, z: az };
}

/** Turns a vector into a unit vector, or null when it has no direction. */
function unit(vector: EscapeVector): EscapeVector | null {
  const magnitude = Math.hypot(vector.x, vector.z);
  if (magnitude < 0.01) return null;
  return { x: vector.x / magnitude, z: vector.z / magnitude };
}

/**
 * How well a direction gets the bot away from every hazard.
 *
 * The worst hazard decides: a direction that dodges one pool and walks into
 * the other scores badly.
 */
function hazardMargin(direction: EscapeVector, pulls: readonly ThreatPull[]): number {
  let worst = Number.POSITIVE_INFINITY;
  for (const pull of pulls) {
    worst = Math.min(worst, direction.x * pull.away.x + direction.z * pull.away.z);
  }
  return worst;
}

/**
 * The way out when the hazards pull in opposite directions.
 *
 * Sideways is the only way out: it does not come closer to either pool.
 */
function sidewaysEscape(pulls: readonly ThreatPull[]): EscapeVector | null {
  let nearest: ThreatPull | null = null;
  for (const pull of pulls) {
    if (nearest === null || pull.distance < nearest.distance) nearest = pull;
  }
  if (nearest === null) return null;
  // A quarter turn away from the way out of the nearest hazard.
  return { x: -nearest.away.z, z: nearest.away.x };
}

/**
 * Picks the direction the bot should run to get away from the danger.
 *
 * The summed pull decides, so the bot leaves the whole crowd at once. The
 * hazards have the last word though: when that sum would move the bot
 * towards one of them, the hazards alone pick the way out, and when they
 * pull in opposite directions the bot runs sideways.
 *
 * Returns null when there is no direction at all.
 */
function planEscape(
  here: Vec3Like,
  hazards: readonly EscapeThreat[],
  mobs: readonly EscapeThreat[],
): EscapeVector | null {
  const hazardPulls = hazards.map((threat) => pullFrom(here, threat));
  const mobPulls = mobs.map((threat) => pullFrom(here, threat));

  const everyone = unit(sumPulls([...hazardPulls, ...mobPulls]));
  const hazardsOnly = unit(sumPulls(hazardPulls));
  const sideways = sidewaysEscape(hazardPulls);

  if (hazardPulls.length === 0) {
    // Only mobs: they pull the bot away on their own.
    return everyone;
  }

  // The first direction that leads away from every hazard wins.
  const candidates = [everyone, hazardsOnly, sideways];
  let best: EscapeVector | null = null;
  let bestMargin = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const margin = hazardMargin(candidate, hazardPulls);
    if (margin >= 0) return candidate;
    if (margin > bestMargin) {
      bestMargin = margin;
      best = candidate;
    }
  }
  // Nothing leads away from every hazard: take the least bad way out.
  return best;
}

export function createEscapeDangerSkill(facade: MinecraftFacade): EscapeDangerSkill {
  return new EscapeDangerSkill(facade);
}