/**
 * Detects danger (lava, fire, hostile mobs, hazard blocks) and moves away from
 * it. Cancels promptly and reports rather than throwing.
 *
 * There is no `escape_danger` action type, so this is deliberately NOT a
 * registry `Skill`: it is the shared "get out of trouble" routine that follow
 * and defend call, available to the executor as a safety reflex.
 */
import { HOSTILE_MOB_FAMILIES, MOVEMENT } from '../../config/constants.js';
import type { BlockRef, MinecraftFacade } from '../../types/facade.js';
import type { EntitySummary } from '../../types/world.js';
import type { SkillResult } from '../../types/skill.js';
import type { ExecutionContext } from '../../types/task.js';
import type { Vec3Like } from '../../types/world.js';
import { clamp, failedResult, navigateToPosition } from '../internal/helpers.js';

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
  if (entity.type === 'hostile') return true;
  const name = entity.name.toLowerCase();
  if (name.startsWith('hostile_')) return true;
  for (const family of HOSTILE_MOB_FAMILIES) {
    if (name === family || name.includes(family)) return true;
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
      ...hazardousBlocks.map((b) => ({ position: b.position, weight: 2 })),
      ...hostiles.map((e) => ({ position: e.position, weight: 1 })),
    ];

    // Run away along the summed vector pointing away from every threat.
    let ax = 0;
    let az = 0;
    for (const threat of threats) {
      const dx = here.x - threat.position.x;
      const dz = here.z - threat.position.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.01) {
        // Directly on top of it: pick an arbitrary but deterministic direction.
        ax += escapeDistance;
        continue;
      }
      ax += (dx / length) * threat.weight;
      az += (dz / length) * threat.weight;
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