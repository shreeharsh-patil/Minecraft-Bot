/**
 * Detects danger (lava, fire, hostile mobs, hazard blocks) and moves away from
 * it. Cancels promptly and reports rather than throwing.
 *
 * There is no `escape_danger` action type, so this is deliberately NOT a
 * registry `Skill`: it is the shared "get out of trouble" routine that the
 * follow and defend skills call on every tick, and that the executor can
 * reach as a safety reflex.
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

export interface EscapeDangerParams {
  /** How far to move away from the hazard. */
  distance?: number;
  /** How far to look for hazards. */
  radius?: number;
}

export interface DangerReport {
  hazardousBlocks: BlockRef[];
  hostiles: EntitySummary[];
}

/** Scans for hazards around the bot. Pure-ish: read-only facade calls. */
export function detectDanger(facade: MinecraftFacade, radius: number): DangerReport {
  const hazardousBlocks = facade
    .scanNearbyBlocks(radius)
    .filter((block) => facade.isDangerous(block.position) || block.name === 'lava' || block.name === 'fire');
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
    if (facade.isDangerous(block.position)) return true;
    if (block.name === 'lava' || block.name === 'fire') return true;
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
    const escapeDistance = clamp(params.distance ?? 8, 2, 24);

    if (ctx.signal.aborted) return { ok: false, detail: 'Cancelled before I moved.', count: 0 };

    const { hazardousBlocks, hostiles } = detectDanger(this.facade, radius);
    if (hazardousBlocks.length === 0 && hostiles.length === 0) {
      return { ok: true, detail: "Nothing dangerous nearby.", count: 0 };
    }

    const here = this.facade.getPosition();
    const threats = [
      // A hazard block hurts more than a mob, so it pulls harder.
      ...hazardousBlocks.map((b) => ({ position: b.position, weight: 2 })),
      ...hostiles.map((e) => ({ position: e.position, weight: 1 })),
    ];

    // Run away along the summed vector pointing away from every threat.
    //
    // Units: every contribution is an INFLUENCE in 1/blocks (weight divided
    // by the distance), so a threat right next to the bot counts far more
    // than one across the room. The sum is a direction with a magnitude in
    // 1/blocks; it is normalised to a unit vector and only then scaled by
    // `escapeDistance` (blocks) to get the actual step.
    let ax = 0;
    let az = 0;
    for (const threat of threats) {
      const dx = here.x - threat.position.x;
      const dz = here.z - threat.position.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.01) {
        // Directly on top of it: pick an arbitrary but deterministic direction.
        // The influence is the closest one possible (weight / 1 block).
        ax += threat.weight;
        continue;
      }
      const influence = threat.weight / Math.max(length, 1);
      ax += (dx / length) * influence;
      az += (dz / length) * influence;
    }

    const magnitude = Math.hypot(ax, az);
    if (magnitude < 0.01) {
      return failedResult('I cannot tell which way is safe.', 0);
    }

    const target: Vec3Like = {
      x: here.x + (ax / magnitude) * escapeDistance,
      y: here.y,
      z: here.z + (az / magnitude) * escapeDistance,
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
      return { ok: true, detail: `Moved away from ${summary}.`, count: threats.length };
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

export function createEscapeDangerSkill(facade: MinecraftFacade): EscapeDangerSkill {
  return new EscapeDangerSkill(facade);
}