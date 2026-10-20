/**
 * Audit of the facade contract and the world value types.
 *
 * These two files are the contract every other module is written against:
 * `src/types/facade.ts` says what the bot may ask the world, and
 * `src/types/world.ts` holds the shapes the answers come back in. A defect
 * here is not a local bug - it is a wrong promise that every consumer
 * silently believes.
 *
 * Covered:
 *  1. `distance3` is the number every "is it close?" test relies on. It must
 *     never be NaN: `NaN > maxDistance` is false, so a NaN distance slips
 *     through every radius filter and the point is reported as if it were
 *     next door.
 *  2. `roundPos` builds the snapshot the model reads, so it must always
 *     produce numbers - an absurd number of decimals used to turn every
 *     coordinate into NaN.
 *  3. A position is a snapshot: it travels together with the distance that
 *     was measured to it, so it must not be mutable in place.
 *  4. The contract documents what it does. A doc that inverts the meaning of
 *     a method is a defect of its own: `isDangerous` answers "keep away",
 *     not "is it safe".
 *
 * The type-level expectations (3 and part of 4) are enforced by `tsc`: the
 * `@ts-expect-error` directives fail the type check when the types regress.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { distance3, roundPos } from '../../src/types/world.js';
import type { Vec3Like } from '../../src/types/world.js';
import type { MinecraftFacade } from '../../src/types/facade.js';
// Imported from the contract module on purpose: the contract is written in
// these types, so it has to hand them out as well.
import type { Vec3Like as ContractVec3Like } from '../../src/types/facade.js';

const FACADE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/types/facade.ts', import.meta.url)),
  'utf8',
);

/** The doc comment that sits directly above a member of the contract. */
function contractDoc(member: string): string {
  const lines = FACADE_SOURCE.split('\n');
  const at = lines.findIndex((line) => line.includes(member));
  if (at < 0) throw new Error(`"${member}" is not part of the facade contract`);
  const doc: string[] = [];
  for (let i = at - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('*') && !line.startsWith('/*')) break;
    doc.unshift(line);
  }
  return doc.join(' ');
}

describe('distance3 - the number every "is it close?" test relies on', () => {
  it('measures the straight line in blocks, across all three axes', () => {
    expect(distance3({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
    expect(distance3({ x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: 3 })).toBe(5);
    expect(distance3({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 })).toBe(5);
    // The vertical axis counts too: a mob three blocks up is not next door.
    expect(distance3({ x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 })).toBe(3);
  });

  it('is zero for the same point and symmetric for a swap', () => {
    expect(distance3({ x: 4, y: 8, z: 15 }, { x: 4, y: 8, z: 15 })).toBe(0);
    expect(distance3({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(
      distance3({ x: 3, y: 4, z: 0 }, { x: 0, y: 0, z: 0 }),
    );
  });

  it('never returns NaN, whatever the coordinates are', () => {
    const broken = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const value of broken) {
      expect(Number.isNaN(distance3({ x: value, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }))).toBe(false);
      expect(Number.isNaN(distance3({ x: 0, y: value, z: 0 }, { x: 0, y: 0, z: 0 }))).toBe(false);
      expect(Number.isNaN(distance3({ x: 0, y: 0, z: value }, { x: 0, y: 0, z: 0 }))).toBe(false);
      expect(Number.isNaN(distance3({ x: 0, y: 0, z: 0 }, { x: value, y: 0, z: 0 }))).toBe(false);
    }
  });

  it('treats an unknown position as infinitely far, so a radius filter rejects it', () => {
    const unknown = distance3({ x: Number.NaN, y: 64, z: 0 }, { x: 0, y: 64, z: 0 });
    expect(unknown).toBe(Number.POSITIVE_INFINITY);
    // The facade keeps a point only when `distance > maxDistance` is FALSE,
    // so a NaN distance used to slip through and the point was reported as
    // "nearby", with a NaN distance in the snapshot.
    expect(unknown > 8).toBe(true);
  });
});

describe('roundPos - the snapshot the model reads', () => {
  it('rounds to one decimal by default', () => {
    expect(roundPos({ x: 64.44, y: 64.46, z: 1.06 })).toEqual({ x: 64.4, y: 64.5, z: 1.1 });
  });

  it('honours a sane number of decimals', () => {
    expect(roundPos({ x: 64.4444, y: 64.4666, z: 1.0666 }, 3)).toEqual({
      x: 64.444,
      y: 64.467,
      z: 1.067,
    });
    expect(roundPos({ x: 64.44, y: 64.46, z: 1.06 }, 0)).toEqual({ x: 64, y: 64, z: 1 });
  });

  it('never returns NaN, whatever the number of decimals is', () => {
    // `10 ** 400` overflows to Infinity and `10 ** -400` underflows to zero:
    // dividing by either turned every coordinate into NaN, which serialised
    // as null in the JSON the model is given.
    for (const decimals of [400, -400, 1000, Number.NaN, 2.5]) {
      const rounded = roundPos({ x: 1.5, y: 2.5, z: 3.5 }, decimals);
      expect(Number.isNaN(rounded.x)).toBe(false);
      expect(Number.isNaN(rounded.y)).toBe(false);
      expect(Number.isNaN(rounded.z)).toBe(false);
    }
  });

  it('does not mutate the position it rounds', () => {
    const position = { x: 1.234, y: 5.678, z: 9.1011 };
    const rounded = roundPos(position);
    expect(position).toEqual({ x: 1.234, y: 5.678, z: 9.1011 });
    expect(rounded).not.toBe(position);
  });
});

describe('a position is a snapshot and must not be mutable in place', () => {
  it('refuses to change a coordinate', () => {
    const position: Vec3Like = { x: 1, y: 2, z: 3 };
    const mutate = (): void => {
      // @ts-expect-error - the coordinates are readonly: a position travels
      // with the distance measured to it, and mutating it would make the two
      // disagree (the bot would think a mob is next door).
      position.x = 99;
    };
    expect(typeof mutate).toBe('function');
    // The compile error above is the regression: `tsc` fails when the
    // coordinates are mutable again.
  });
});

describe('the facade contract', () => {
  it('hands out the world value types it is written in', () => {
    const position: ContractVec3Like = { x: 1, y: 2, z: 3 };
    expect(position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('declares the dimension accessor the world source asks for', () => {
    // The AI layer asks the world for the dimension through a method, so the
    // contract has to declare it: an implementation that is used as a world
    // source (the mineflayer facade is) has to provide it.
    type HasGetDimension = 'getDimension' extends keyof MinecraftFacade ? true : false;
    const declared: HasGetDimension = true;
    expect(declared).toBe(true);
  });

  it('describes isDangerous as dangerous, not as safe', () => {
    const doc = contractDoc('isDangerous(position: BlockPos)');
    expect(doc).toMatch(/danger/i);
    // The doc used to ask "Is this block safe to stand on / break?" for a
    // method that answers "keep away from it" - the opposite of the truth.
    expect(doc).not.toMatch(/safe/i);
  });

  it('describes maxNodes as a search ceiling, not as a vertical skip', () => {
    const doc = contractDoc('maxNodes?: number;');
    expect(doc).toMatch(/node/i);
    // "Skip this many blocks vertically" is not what a node count does, and
    // it sent the next implementer looking for a step-height feature.
    expect(doc).not.toMatch(/vertical/i);
  });
});
