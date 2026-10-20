/**
 * Build one of three whitelisted structures: wall, platform, simple_house.
 *
 * Safety rules:
 *  - the structure vocabulary is closed - arbitrary free-form building is not
 *    reachable from here, only these three shapes;
 *  - dimensions are clamped to sane caps, and the total block count is capped;
 *  - the material is checked up front so a missing-material run fails fast and
 *    clearly instead of placing half a house;
 *  - dangerous materials (tnt, cactus, ...) are never placed;
 *  - a cell that is occupied, or that somebody is standing in, is skipped
 *    rather than overwritten;
 *  - the loop honours `ctx.signal` between every block.
 */
import type { MinecraftFacade } from '../../types/facade.js';
import type { Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import type { BlockPos, Vec3Like } from '../../types/world.js';
import { distance3 } from '../../types/world.js';
import { AntiGriefRules } from '../../safety/antiGrief.js';
import {
  clamp,
  describeError,
  entityOccupiesCell,
  failedResult,
  floorPos,
  guardedOp,
  isCancellation,
  isDangerousBlock,
  navigateToPosition,
  normaliseBlockName,
  reportProgress,
} from '../internal/helpers.js';

export const STRUCTURE_TYPES = ['wall', 'platform', 'simple_house'] as const;
export type StructureType = (typeof STRUCTURE_TYPES)[number];

/** Hard cap on blocks placed by one build task. */
export const MAX_BUILD_BLOCKS = 256;

/** How many placement failures in a row mean the run is stuck. */
const MAX_CONSECUTIVE_FAILURES = 8;

/** Per-structure dimension caps. */
const LIMITS = {
  wall: { length: 24, height: 12 },
  platform: { length: 16, width: 16 },
  simple_house: { size: 9, height: 6 },
} as const;

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
  // The doorway is the middle cell of the far wall. It is an offset from the
  // origin, not an absolute coordinate: comparing it with the absolute x
  // sealed every house that was not built at x = 0.
  const doorIndex = Math.floor(size / 2);

  for (let dx = 0; dx < size; dx += 1) {
    for (let dz = 0; dz < size; dz += 1) push(origin.x + dx, origin.y, origin.z + dz); // floor
  }
  for (let dy = 1; dy < height; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      for (let dz = 0; dz < size; dz += 1) {
        const edge = dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1;
        if (!edge) continue;
        const isDoorway = dx === doorIndex && dz === size - 1 && dy <= 2;
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

/**
 * Shrinks the request until the whole structure fits inside the block cap.
 *
 * Cutting the plan short instead would leave a house without a roof, so the
 * dimensions give way instead and the finished shape stays intact.
 */
function planWithinBudget(
  structure: StructureType,
  origin: BlockPos,
  dimensions: Record<string, number>,
  planned: BlockPos[],
): BlockPos[] {
  if (planned.length <= MAX_BUILD_BLOCKS) return planned;

  if (structure === 'wall') {
    const height = dimension(dimensions, 'height', 3, LIMITS.wall.height);
    // Give up length first: a wall keeps the height that was asked for.
    const length = Math.min(
      dimension(dimensions, 'length', 5, LIMITS.wall.length),
      Math.max(1, Math.floor(MAX_BUILD_BLOCKS / height)),
    );
    return planStructure(structure, origin, { length, height });
  }

  if (structure === 'platform') {
    const width = dimension(dimensions, 'width', 4, LIMITS.platform.width);
    const length = Math.min(
      dimension(dimensions, 'length', 4, LIMITS.platform.length),
      Math.max(1, Math.floor(MAX_BUILD_BLOCKS / width)),
    );
    return planStructure(structure, origin, { length, width });
  }

  // simple_house: give up the footprint first, so the house keeps its height.
  const height = dimension(dimensions, 'height', 4, LIMITS.simple_house.height);
  const size = dimension(dimensions, 'size', 5, LIMITS.simple_house.size);
  for (let smaller = size; smaller >= 2; smaller -= 1) {
    const plan = planStructure(structure, origin, { size: smaller, height });
    if (plan.length <= MAX_BUILD_BLOCKS) return plan;
  }
  // A one cell wide house is always well inside the cap.
  return planStructure(structure, origin, { size: Math.min(size, 2), height: 2 });
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

  constructor(
    private readonly facade: MinecraftFacade,
    private readonly rules: AntiGriefRules = new AntiGriefRules(),
  ) {}

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

    // Dangerous materials (tnt, cactus, lava, ...) are never placed.
    if (isDangerousBlock(material)) {
      return failedResult(`I will not build with ${material.replace(/_/g, ' ')} - it is too dangerous.`, 0);
    }

    const dimensions = params.dimensions ?? {};
    const planned = planStructure(structure, origin, dimensions);
    const plan = planWithinBudget(structure, origin, dimensions, planned);

    if (plan.length < planned.length) {
      ctx.say(`Clamping the build to ${MAX_BUILD_BLOCKS} blocks.`);
    }

    // Fail fast and clearly when the materials are not there. Cells that
    // already hold the material need none, so they are not counted.
    const alreadyThere = plan.filter((target) => this.facade.getBlockAt(target) === material).length;
    const needed = plan.length - alreadyThere;
    const available = this.facade.countItem(material);
    if (available < needed) {
      return failedResult(
        `I need ${needed} ${material.replace(/_/g, ' ')} but I only have ${available}.`,
        0,
        needed,
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
      /** Cells that already held the material - nothing to do there. */
      let existing = 0;
      /** Cells that could not be built in: something else is in the way. */
      let blocked = 0;
      /** Cells the bot tried to build in, but the placement failed. */
      let failed = 0;
      /** Consecutive placement failures, so a stuck run gives up. */
      let consecutiveFailures = 0;
      for (const target of plan) {
        if (ctx.signal.aborted) {
          return {
            ok: false,
            detail: `Stopped after ${placed} blocks.`,
            count: placed,
            remaining: Math.max(0, plan.length - placed),
          };
        }

        const skipped = this.skipCell(target, material);
        if (skipped === 'existing') {
          existing += 1;
          continue;
        }
        if (skipped === 'blocked') {
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
          consecutiveFailures = 0;
          reportProgress(ctx, placed, plan.length, `Built ${placed}/${plan.length}`);
        } else {
          consecutiveFailures += 1;
          failed += 1;
          // The cell could not be built in; keep going, but a run that cannot
          // place anything gives up instead of hammering every cell.
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        }
      }

      const skipped = existing + blocked;
      const summary =
        `${structure.replace('_', ' ')}: placed ${placed} of ${plan.length} ${material}` +
        (skipped > 0 ? `, skipped ${skipped}` : '') +
        (failed > 0 ? `, failed ${failed}` : '');
      if (placed + existing >= plan.length) {
        return { ok: true, detail: `Finished. ${summary}.`, count: placed };
      }
      // Say what actually went wrong: a cell that was in the way and a cell
      // the bot could not place are different problems.
      const reason =
        failed > 0
          ? `I could not place ${failed} of the blocks.`
          : 'Something was already in the way.';
      return {
        ok: false,
        detail: `${summary}. ${reason}`,
        count: placed,
        remaining: Math.max(0, plan.length - placed - existing),
      };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: 'Stopped while building.', count: 0, remaining: plan.length };
      }
      return failedResult(`Building failed: ${describeError(error)}`, 0, plan.length);
    }
  }

  /**
   * Decides what to do with one cell of the structure.
   *
   * `existing` - the material is already there, nothing to do.
   * `blocked`  - something else is in the way, or somebody is standing there.
   * `build`    - the cell can be built in.
   */
  private skipCell(target: BlockPos, material: string): 'existing' | 'blocked' | 'build' {
    const current = this.facade.getBlockAt(target);
    if (current === material) return 'existing';
    // Anti-grief: never overwrite what is already there.
    if (!this.rules.canPlaceBlock(target, current).allowed) return 'blocked';
    // A block materialised inside a player would trap (or suffocate) them.
    if (entityOccupiesCell(this.facade, target) !== null) return 'blocked';
    return 'build';
  }
}

export function createBuildStructureSkill(
  facade: MinecraftFacade,
  rules?: AntiGriefRules,
): BuildStructureSkill {
  return new BuildStructureSkill(facade, rules);
}
