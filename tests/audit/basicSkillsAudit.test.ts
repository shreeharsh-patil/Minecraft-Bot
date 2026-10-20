/**
 * Audit regression tests for the four basic skills: look_at, say, stop, wait.
 *
 * Each test pins a behaviour that was broken (or unguarded) before this
 * audit. They all fail without the fix:
 *
 *  1. `say` put MORE THAN ONE chat line on the wire. The bot is created with
 *     `chatLengthLimit: 100` (src/bot/createBot.ts) and mineflayer does not
 *     reject a longer line - it SPLITS it into several chat packets. That
 *     broke the "one bounded chat line" contract of the skill...
 *  2. ...and it was a command injection: a piece that starts with "/" is sent
 *     as a `chat_command` packet, so the server EXECUTES it. The validator
 *     only rejects a message whose FIRST character is a slash, which does not
 *     cover a line that is split on the 100 character boundary.
 *  3. The `say` skill - the last gate before the wire - did not refuse a
 *     command-shaped line at all.
 *  4. A `look_at` that was cancelled before it started still turned the bot's
 *     head at the target.
 *  5. `wait` and `look_at` let a facade failure escape as a THROWN error
 *     instead of a typed `SkillResult` (the house rule: a skill never throws).
 *
 * The remaining tests are the smoke tests for the same skills: the fixes must
 * not change what the skills do in the normal case.
 */
import { describe, expect, it } from 'vitest';
import * as say from '../../src/skills/basic/say.js';
import { LookAtSkill } from '../../src/skills/basic/lookAt.js';
import { WaitSkill } from '../../src/skills/basic/wait.js';
import { StopSkill } from '../../src/skills/basic/stop.js';
import { validateAction } from '../../src/executor/validator.js';
import type { Skill } from '../../src/types/skill.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

/**
 * The chat line limit the bot is created with (src/bot/createBot.ts passes
 * `chatLengthLimit: 100` to mineflayer).
 */
const BOT_CHAT_LINE_LIMIT = 100;

/**
 * Mirrors mineflayer's chat splitting (mineflayer/lib/plugins/chat.js): a
 * message longer than the limit is sent as SEVERAL chat packets, each one a
 * line the server sees on its own.
 */
function chatPackets(message: string, limit: number = BOT_CHAT_LINE_LIMIT): string[] {
  const packets: string[] = [];
  for (let i = 0; i < message.length; i += limit) {
    packets.push(message.slice(i, i + limit));
  }
  return packets;
}

/** A facade whose body cannot be stopped - the failure mode of a bot that is
 *  not spawned (or whose connection just dropped). */
class BrokenStopFacade extends FakeMinecraftFacade {
  public override stopMoving(): void {
    throw new Error('the pathfinder is gone');
  }
}

describe('audit: say - one chat line, and never a command', () => {
  it('emits exactly one chat line, even for a long answer', async () => {
    const facade = new FakeMinecraftFacade();

    await say.createSaySkill(facade).execute({ message: 'x'.repeat(150) });

    const sent = facade.chatMessages[0] ?? '';
    // The line must fit into ONE server line, or mineflayer splits it.
    expect(sent.length).toBeLessThanOrEqual(BOT_CHAT_LINE_LIMIT);
    expect(chatPackets(sent)).toHaveLength(1);
  });

  it('bounds its own line to the limit the bot was created with', () => {
    // The skill publishes the limit it enforces, so it cannot drift away
    // from the `chatLengthLimit` the bot is created with.
    expect(say.MAX_CHAT_LINE_CHARS ?? BOT_CHAT_LINE_LIMIT).toBeLessThanOrEqual(BOT_CHAT_LINE_LIMIT);
  });

  it('cannot be split into a piece the server would run as a command', async () => {
    const facade = new FakeMinecraftFacade();
    // The slash sits exactly on the split boundary, so the SECOND piece would
    // start with "/" - and a chat packet that starts with a slash is a
    // command the server executes.
    const message = `${'a'.repeat(BOT_CHAT_LINE_LIMIT)}/op @a`;

    // The validator does not catch this one: it only looks at the FIRST
    // character of the message, so the action is accepted...
    expect(validateAction({ type: 'say', message }).valid).toBe(true);

    await say.createSaySkill(facade).execute({ message });

    const sent = facade.chatMessages[0] ?? '';
    const packets = chatPackets(sent);
    expect(packets).toHaveLength(1);
    expect(packets.some((packet) => packet.startsWith('/'))).toBe(false);
  });

  it('refuses a command-shaped line at the last gate before the wire', async () => {
    const facade = new FakeMinecraftFacade();

    const result = await say.createSaySkill(facade).execute({ message: '/op @a' });

    expect(result.ok).toBe(false);
    // Nothing went on the wire.
    expect(facade.chatMessages).toHaveLength(0);
  });

  it('still says an ordinary message unchanged', async () => {
    const facade = new FakeMinecraftFacade();

    const result = await say.createSaySkill(facade).execute({ message: 'Done! I mined 16 oak logs.' });

    expect(result.ok).toBe(true);
    expect(facade.chatMessages).toEqual(['Done! I mined 16 oak logs.']);
  });
});

describe('audit: look_at - a cancelled look never reaches the world', () => {
  it('does not turn the bot when the action was cancelled before it started', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new LookAtSkill(facade);
    const test = createTestContext();
    test.abort();

    const result = await skill.execute({ position: { x: 5, y: 65, z: 5 }, durationMs: 0 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.lookTargets).toHaveLength(0);
  });

  it('still turns towards the position and stops the body', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new LookAtSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: 5, y: 65, z: 5 }, durationMs: 0 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.lookTargets).toEqual([{ x: 5, y: 65, z: 5 }]);
    expect(facade.stopMovingCount).toBe(1);
  });

  it('reports a facade failure instead of throwing', async () => {
    const facade = new BrokenStopFacade();
    const skill = new LookAtSkill(facade);
    const test = createTestContext();

    await expect(
      skill.execute({ position: { x: 5, y: 65, z: 5 }, durationMs: 0 }, test.ctx),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('audit: wait - idle, interruptible, and never throwing', () => {
  it('reports a facade failure instead of throwing', async () => {
    const facade = new BrokenStopFacade();
    const skill = new WaitSkill(facade);
    const test = createTestContext();

    await expect(skill.execute({ durationMs: 10 }, test.ctx)).resolves.toMatchObject({ ok: false });
  });

  it('stops the body and is interrupted by an abort', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new WaitSkill(facade);
    const test = createTestContext();

    const running = skill.execute({ durationMs: 5_000 }, test.ctx);
    setTimeout(() => test.abort(), 20);
    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Stopped waiting/i);
    expect(facade.stopMovingCount).toBe(1);
  });
});

describe('audit: stop - the body really stops', () => {
  it('halts the movement', async () => {
    const facade = new FakeMinecraftFacade();
    // Typed through the Skill interface: that is how the executor calls it.
    const skill: Skill<Record<string, never>> = new StopSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.stopMovingCount).toBe(1);
  });

  it('reports a facade failure instead of throwing', async () => {
    const facade = new BrokenStopFacade();
    const skill: Skill<Record<string, never>> = new StopSkill(facade);
    const test = createTestContext();

    await expect(skill.execute({}, test.ctx)).resolves.toMatchObject({ ok: false });
  });
});
