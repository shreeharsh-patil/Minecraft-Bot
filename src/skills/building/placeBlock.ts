/** Place a single block at an explicit position. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { PlaceParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import type { BlockPos } from '../../types/world.js';
import { distance3 } from '../../types/world.js';
import { AntiGriefRules } from '../../safety/antiGrief.js';
import {
  approachBlock,
  describeError,
  entityOccupiesCell,
  failedResult,
  floorPos,
  guardedOp,
  isCancellation,
  isDangerousBlock,
  navigateToPosition,
  neighbours,
  normaliseBlockName,
  formatPos,
} from '../internal/helpers.js';

/** Entity scan radius once the bot is standing next to the target cell. */
const CLOSE_SCAN_RADIUS = 8;

export class PlaceBlockSkill implements Skill<PlaceParams> {
  public readonly name: ActionType = 'place_block';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.BUILDING];

  constructor(
    private readonly facade: MinecraftFacade,
    private readonly rules: AntiGriefRules = new AntiGriefRules(),
  ) {}

  public async execute(params: PlaceParams, ctx: ExecutionContext): Promise<SkillResult> {
    const blockName = normaliseBlockName(params.blockName ?? '');
    if (blockName.length === 0) {
      return failedResult('I need to know which block to place.', 0);
    }
    const position = params.position;
    if (
      typeof position !== 'object' ||
      position === null ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return failedResult('That is not a valid place to build.', 0);
    }
    const target: BlockPos = floorPos(position);

    // Dangerous materials (tnt, cactus, lava, ...) are never placed: they
    // hurt the bot and everybody around it.
    if (isDangerousBlock(blockName)) {
      return failedResult(`I will not place ${blockName.replace(/_/g, ' ')} - it is too dangerous.`, 0);
    }

    if (this.facade.countItem(blockName) <= 0) {
      return failedResult(`I don't have any ${blockName.replace(/_/g, ' ')}.`, 0);
    }

    // The cell has to be free, replaceable and empty of anybody. The scan
    // has to reach the target: the facade reports the entities around the
    // bot, so a narrow scan never sees somebody standing in a cell the bot
    // has not walked over to yet.
    const blocked = this.checkCell(target, blockName, this.scanRadius(target));
    if (blocked !== null) {
      return blocked;
    }

    try {
      const arrival = await approachBlock(this.facade, ctx, target, 'Getting into place');
      if (arrival.status === 'cancelled') {
        return { ok: false, detail: 'Stopped before placing the block.', count: 0 };
      }
      if (arrival.status !== 'arrived') {
        return failedResult(`I can't reach ${formatPos(target)} to build there.`, 0);
      }

      // "Place a block here" points at the cell the bot is standing in, and
      // the entity scan never sees the bot itself: step aside before
      // building, or the block lands inside the bot.
      if (this.botStandsIn(target)) {
        const aside = await this.stepAside(ctx, target);
        if (aside === 'cancelled') {
          return { ok: false, detail: 'Stopped before placing the block.', count: 0 };
        }
        if (aside === 'blocked') {
          return failedResult('I am standing in that spot and cannot step aside.', 0);
        }
      }

      // Walking over takes seconds, so the cell may have changed in the
      // meantime: somebody stepped into it, or built there.
      const changed = this.checkCell(target, blockName, CLOSE_SCAN_RADIUS);
      if (changed !== null) {
        return changed;
      }

      const held = this.facade.heldItem();
      if (held !== blockName) {
        const equipped = await guardedOp(() => this.facade.equipItem(blockName), ctx, `Equipping ${blockName}`);
        if (equipped.status === 'cancelled') {
          return { ok: false, detail: 'Stopped before placing the block.', count: 0 };
        }
        if (equipped.status === 'error' || !equipped.value) {
          return failedResult(`I couldn't hold the ${blockName}.`, 0);
        }
      }

      const placed = await guardedOp(
        () => this.facade.placeBlock(target, blockName, params.face ?? 'auto'),
        ctx,
        `Placing ${blockName}`,
      );
      if (placed.status === 'cancelled') {
        return { ok: false, detail: 'Stopped while placing the block.', count: 0 };
      }
      if (placed.status === 'error') {
        return failedResult(placed.reason, 0);
      }
      if (!placed.value) {
        return failedResult(`I couldn't place the ${blockName} at ${formatPos(target)}.`, 0);
      }

      return { ok: true, detail: `Placed ${blockName} at ${formatPos(target)}.`, count: 1 };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: 'Stopped while placing the block.', count: 0 };
      }
      return failedResult(`Placing ${blockName} failed: ${describeError(error)}`, 0);
    }
  }

  /**
   * Is the target cell good to build in?
   *
   * Returns the result to report, or null when the cell may be built in.
   */
  private checkCell(target: BlockPos, blockName: string, radius: number): SkillResult | null {
    const existing = this.facade.getBlockAt(target);
    if (existing === blockName) {
      return { ok: true, detail: `There is already a ${blockName} there.`, count: 0 };
    }
    // Anti-grief: never overwrite what is already there.
    const place = this.rules.canPlaceBlock(target, existing);
    if (!place.allowed) {
      return failedResult(place.reason ?? `I can't build at ${formatPos(target)}.`, 0);
    }
    // A block materialised inside a player would trap (or suffocate) them.
    const occupant = entityOccupiesCell(this.facade, target, radius);
    if (occupant !== null) {
      return failedResult(`${occupant.name} is standing there - I won't build on top of them.`, 0);
    }
    return null;
  }

  /**
   * How far the entity scan has to reach to cover the target cell.
   *
   * The facade reports the entities around the bot, so a scan that is not
   * wide enough never sees somebody standing in the target cell.
   */
  private scanRadius(target: BlockPos): number {
    const reach = Math.ceil(distance3(this.facade.getPosition(), target)) + 1;
    return Math.max(CLOSE_SCAN_RADIUS, reach);
  }

  /**
   * Is the bot standing in this cell?
   *
   * The entity scan never sees the bot: the facade leaves the bot out of
   * its own entity list, so the cell the bot occupies has to be checked
   * separately.
   */
  private botStandsIn(cell: BlockPos): boolean {
    const here = floorPos(this.facade.getPosition());
    return here.x === cell.x && here.y === cell.y && here.z === cell.z;
  }

  /**
   * Steps off the cell the bot is standing in.
   *
   * A block materialised inside the bot would trap (or suffocate) it, so
   * the bot moves to a side neighbour first and the block lands in the cell
   * it just left.
   */
  private async stepAside(
    ctx: ExecutionContext,
    target: BlockPos,
  ): Promise<'aside' | 'cancelled' | 'blocked'> {
    for (const neighbour of neighbours(target)) {
      if (ctx.signal.aborted) return 'cancelled';
      // Only sideways steps: a step down would leave the bot directly under
      // the target, in the way of the block.
      if (neighbour.y !== target.y) continue;
      if (this.facade.isDangerous(neighbour)) continue;
      const moved = await navigateToPosition(this.facade, ctx, neighbour, {
        description: 'Stepping aside',
        arriveDistance: 0,
      });
      if (moved.status === 'cancelled') return 'cancelled';
      if (!this.botStandsIn(target)) return 'aside';
    }
    return this.botStandsIn(target) ? 'blocked' : 'aside';
  }
}

export function createPlaceBlockSkill(
  facade: MinecraftFacade,
  rules?: AntiGriefRules,
): PlaceBlockSkill {
  return new PlaceBlockSkill(facade, rules);
}
