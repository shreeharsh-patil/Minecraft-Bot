/**
 * Build one of three whitelisted structures: wall, platform, simple_house.
 *
 * Safety rules:
 *  - the structure vocabulary is closed - arbitrary free-form building is not
 *    reachable from here, only these three shapes;
 *  - dimensions are clamped to sane caps, and the total block count is capped;
 *  - the material is checked up front so a missing-material run fails fast and
 *    clearly instead of placing half a house;
 *  - the loop honours `ctx.signal` between every block.
 */
import type { MinecraftFacade } from '../../types/facade.js';
import type { Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import type { BlockPos, Vec3Like } from '../../types/world.js';
import { distance3 } from '../../types/world.js';
import {
  clamp,
  describeError,
  failedResult,
  floorPos,
  guardedOp,
  isCancellation,
  navigateToPosition,
  normaliseBlockName,
  reportProgress,
} from '../internal/helpers.js';

export const STRUCTURE_TYPES = ['wall', 'platform', 'simple_house'] as const;
export type StructureType = (typeof STRUCTURE_TYPES)[number];

/** Hard cap on blocks placed by one build task. */
export const MAX_BUILD_BLOCKS = 256;

/** Per-structure dimension caps. */
const LIMITS = {
  wall: { length: 24, height: 12 },
  platform: { length: 16, width: 16 },
  simple_house: { size: 9, height: 6 },
} as const;

const REPLACEABLE: ReadonlySet<string> = new Set([
  'air',
  'water',
  'grass',
  'short_grass',
  'tall_grass',
  'snow',
  'fire',
  'torch',
]);

function isStructureType(value: string): value is StructureType {
  return (STRUCTURE_TYPES as readonly string[]).includes(value);
}

/** Reads a dimension with a default, clamped into the structure's cap. */
function dimension(dimensions: Record<string, number>, key: string, fallback: number, cap: number): number {
  const raw = dimensions[key];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return clamp(Math.floor(value), 1, cap);
}

/**
 * Expands a structure request into an ordered list of block positions.
 * Pure function - no facade calls, so it is trivially testable.
 */
export function planStructure(
  structure: StructureType,
  origin: BlockPos,
  dimensions: Record<string, number>,
): BlockPos[] {
  const positions: BlockPos[] = [];
  const push = (x: number, y: number, z: number): void => {
    positions.push({ x, y, z });
  };

  if (structure === 'wall') {
    const length = dimension(dimensions, 'length', 5, LIMITS.wall.length);
    const height = dimension(dimensions, 'height', 3, LIMITS.wall.height);
    for (let dx = 0; dx < length; dx += 1) {
      for (let dy = 0; dy < height; dy += 1) push(origin.x + dx, origin.y + dy, origin.z);
    }
    return positions;
  }

  if (structure === 'platform') {
    const length = dimension(dimensions, 'length', 4, LIMITS.platform.length);
    const width = dimension(dimensions, 'width', 4, LIMITS.platform.width);
    for (let dx = 0; dx < length; dx += 1) {
      for (let dz = 0; dz < width; dz += 1) push(origin.x + dx, origin.y, origin.z + dz);
    }
    return positions;
  }

  // simple_house: hollow box with a floor, four walls, a roof and a doorway.
  const size = dimension(dimensions, 'size', 5, LIMITS.simple_house.size);
  const height = dimension(dimensions, 'height', 4, LIMITS.simple_house.height);
  const roofY = origin.y + height;
  const doorX = origin.x + Math.floor(size / 2);

  for (let dx = 0; dx < size; dx += 1) {
    for (let dz = 0; dz < size; dz += 1) push(origin.x + dx, origin.y, origin.z + dz); // floor
  }
  for (let dy = 1; dy < height; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      for (let dz = 0; dz < size; dz += 1) {
        const edge = dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1;
        if (!edge) continue;
        const isDoorway = dx === doorX && dz === size - 1 && dy <= 2;
        if (isDoorway) continue;
        push(origin.x + dx, origin.y + dy, origin.z + dz);
      }
    }
  }
  for (let dx = 0; dx < size; dx += 1) {
    for (let dz = 0; dz < size; dz += 1) push(origin.x + dx, roofY, origin.z + dz); // roof
  }
  return positions;
}

export interface BuildStructureParams {
  structure: StructureType;
  position: Vec3Like;
  dimensions: Record<string, number>;
  material?: string;
}

export class BuildStructureSkill implements Skill<BuildStructureParams> {
  public readonly name: ActionType = 'build_structure';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.BUILDING];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: BuildStructureParams, ctx: ExecutionContext): Promise<SkillResult> {
    const structure = params.structure;
    if (!isStructureType(structure)) {
      return failedResult(
        `I can only build ${STRUCTURE_TYPES.join(', ')}.`,
        0,
      );
    }
    if (
      typeof params.position !== 'object' ||
      params.position === null ||
      !Number.isFinite(params.position.x) ||
      !Number.isFinite(params.position.y) ||
      !Number.isFinite(params.position.z)
    ) {
      return failedResult('That is not a valid place to build.', 0);
    }

    const origin = floorPos(params.position);
    const material = normaliseBlockName(params.material ?? 'cobblestone');
    const dimensions = params.dimensions ?? {};
    const planned = planStructure(structure, origin, dimensions);
    const plan = planned.slice(0, MAX_BUILD_BLOCKS);

    if (plan.length < planned.length) {
      ctx.say(`Clamping the build to ${MAX_BUILD_BLOCKS} blocks.`);
    }

    // Fail fast and clearly when the materials are not there.
    const available = this.facade.countItem(material);
    if (available < plan.length) {
      return failedResult(
        `I need ${plan.length} ${material.replace(/_/g, ' ')} but I only have ${available}.`,
        0,
        plan.length,
      );
    }

    try {
      const arrival = await navigateToPosition(this.facade, ctx, origin, {
        description: 'Walking to the build site',
      });
      if (arrival.status === 'cancelled') {
        return { ok: false, detail: 'Stopped before building.', count: 0, remaining: plan.length };
      }
      if (arrival.status !== 'arrived') {
        return failedResult(`I can't reach the build site: ${arrival.reason}`, 0, plan.length);
      }

      const held = this.facade.heldItem();
      if (held !== material) {
        const equipped = await guardedOp(() => this.facade.equipItem(material), ctx, `Equipping ${material}`);
        if (equipped.status === 'cancelled') {
          return { ok: false, detail: 'Stopped before building.', count: 0, remaining: plan.length };
        }
        if (equipped.status === 'error' || !equipped.value) {
          return failedResult(`I couldn't hold the ${material}.`, 0, plan.length);
        }
      }

      let placed = 0;
      let blocked = 0;
      for (const target of plan) {
        if (ctx.signal.aborted) {
          return {
            ok: false,
            detail: `Stopped after ${placed} blocks.`,
            count: placed,
            remaining: Math.max(0, plan.length - placed),
          };
        }

        const existing = this.facade.getBlockAt(target);
        if (existing === material) {
          placed += 1;
          continue;
        }
        if (existing !== null && !REPLACEABLE.has(existing)) {
          blocked += 1;
          continue;
        }

        // Stay within reach: walk closer when the target drifts away.
        const here = this.facade.getPosition();
        if (distance3(here, target) > 4) {
          const moved = await navigateToPosition(this.facade, ctx, target, {
            description: 'Moving along the build site',
          });
          if (moved.status === 'cancelled') {
            return {
              ok: false,
              detail: `Stopped after ${placed} blocks.`,
              count: placed,
              remaining: Math.max(0, plan.length - placed),
            };
          }
        }

        const result = await guardedOp(
          () => this.facade.placeBlock(target, material, 'auto'),
          ctx,
          `Placing ${material}`,
        );
        if (result.status === 'cancelled') {
          return {
            ok: false,
            detail: `Stopped after ${placed} blocks.`,
            count: placed,
            remaining: Math.max(0, plan.length - placed),
          };
        }
        if (result.status === 'ok' && result.value) {
          placed += 1;
          blocked = 0;
          reportProgress(ctx, placed, plan.length, `Built ${placed}/${plan.length}`);
        } else {
          blocked += 1;
          // Something is in the way we cannot clear; keep going and report.
          if (blocked > plan.length) break;
        }
      }

      const summary = `${structure.replace('_', ' ')}: placed ${placed} of ${plan.length} ${material}`;
      if (placed >= plan.length) {
        return { ok: true, detail: `Finished. ${summary}.`, count: placed };
      }
      return {
        ok: false,
        detail: `${summary}. Something was already in the way.`,
        count: placed,
        remaining: Math.max(0, plan.length - placed),
      };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: 'Stopped while building.', count: 0, remaining: plan.length };
      }
      return failedResult(`Building failed: ${describeError(error)}`, 0, plan.length);
    }
  }
}

export function createBuildStructureSkill(facade: MinecraftFacade): BuildStructureSkill {
  return new BuildStructureSkill(facade);
}