/**
 * Deterministic command handlers.
 *
 * These run with zero AI involvement. Each returns a short, deterministic
 * reply. Unknown/unsupported requests are reported plainly rather than guessed.
 */
import type { ActionType, BotAction } from '../types/actions.js';
import type { MinecraftFacade } from '../types/facade.js';
import type { TaskManager } from '../executor/actionQueue.js';
import type { AuthorizationService } from '../safety/permissions.js';
import type { MemoryStore } from '../types/memory.js';
import type { ChatResponder } from '../chat/responses.js';
import { formatHelp, formatInventory, formatStatus } from '../chat/responses.js';
import { parseLocationName } from '../chat/commandParser.js';
import { distance3 } from '../types/world.js';
import type { Logger } from '../utils/logger.js';

export interface LocalCommandDeps {
  facade: MinecraftFacade;
  tasks: TaskManager;
  auth: AuthorizationService;
  memory: MemoryStore;
  responder: ChatResponder;
  prefix: string;
  providerStats: () => number;
  /** Runs a validated action through the shared executor, as `!come` does. */
  runAction: (owner: string, action: BotAction) => Promise<void>;
  logger: Logger;
}

export class LocalCommands {
  private readonly deps: LocalCommandDeps;

  constructor(deps: LocalCommandDeps) {
    this.deps = deps;
  }

  async handle(owner: string, name: string, args: string[]): Promise<void> {
    const { responder } = this.deps;
    switch (name) {
      case 'help': {
        // Sent as several bounded lines so the whole list always arrives.
        for (const line of formatHelp(this.deps.prefix)) {
          await responder.send(owner, line);
        }
        return;
      }

      case 'status':
        await this.status(owner);
        return;

      case 'inventory':
        await this.inventory(owner);
        return;

      case 'remember': {
        const label = parseLocationName(args[0]);
        if (!label) {
          await responder.send(owner, 'Usage: remember <name>, e.g. remember home');
          return;
        }
        const position = this.deps.facade.getPosition();
        this.deps.memory.rememberLocation(label, position);
        await this.deps.memory.persist().catch(() => undefined);
        await responder.send(
          owner,
          `Remembered "${label}" at ${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}.`,
        );
        return;
      }

      case 'home': {
        // Navigate to a remembered location.
        const location = this.deps.memory.recallLocation('home');
        if (!location) {
          await responder.send(owner, 'I have not been told a home yet. Say "remember this place as home".');
          return;
        }
        await responder.send(owner, `Heading to home (${Math.round(location.position.x)}, ${Math.round(location.position.y)}, ${Math.round(location.position.z)}).`);
        // Actually walk there, through the same executor every other action uses.
        await this.deps.runAction(owner, {
          type: 'move_to_position',
          position: location.position,
        });
        return;
      }

      default:
        await responder.send(owner, `Unknown command: ${name}. Try ${this.deps.prefix}help`);
    }
  }

  private async status(owner: string): Promise<void> {
    const { facade, tasks, responder } = this.deps;
    const health = facade.getHealth();
    const food = facade.getHunger();
    await responder.send(
      owner,
      formatStatus({
        username: facade.username,
        health: health.current,
        maxHealth: health.max,
        food: food.current,
        dimension: facade.dimension,
        position: facade.getPosition(),
        activeTasks: tasks.list(),
        providerCount: this.deps.providerStats(),
      }),
    );
  }

  private async inventory(owner: string): Promise<void> {
    const { facade, responder } = this.deps;
    const items = facade.getInventory().map((i) => ({ name: i.item, count: i.count, slot: i.slot }));
    await responder.send(owner, formatInventory(items, facade.heldItem()));
  }

  /** Distance helper used by follow/come replies. */
  distanceTo(owner: string): number | null {
    const player = this.deps.facade.getNearestPlayer(owner);
    return player ? distance3(this.deps.facade.getPosition(), player.position) : null;
  }
}

export type { ActionType };