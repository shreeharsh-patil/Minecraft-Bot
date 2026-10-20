/**
 * The version check is the bot's first line of defence: it refuses a version
 * the client library cannot speak BEFORE a socket is opened, so the operator
 * gets a helpful message instead of minecraft-protocol's "unsupported
 * protocol version".
 *
 * These tests pin that behaviour against the *installed* client library:
 * minecraft-data announces releases long before the client can speak them,
 * and a check built on the announcement alone accepts versions the client
 * refuses.
 */
import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import mineflayer from 'mineflayer';
import {
  checkMinecraftVersion,
  isKnownVersion,
  supportedVersions,
} from '../../src/bot/versionSupport.js';

type IndexedData = ReturnType<typeof minecraftData>;

/** The protocol-version metadata minecraft-data publishes for every release. */
const known = minecraftData.versionsByMinecraftVersion.pc;

/**
 * `minecraft-data` returns null for releases it ships no protocol data for -
 * those are the releases the client cannot speak.
 */
function data(version: string): IndexedData | null {
  const lookup = minecraftData as unknown as (v: string) => IndexedData | null;
  return lookup(version);
}

describe('version support follows the client library', () => {
  it('refuses a release the client library cannot speak', () => {
    // The classic trap: minecraft-data announces a release, but the client
    // refuses it ("unsupported protocol version") before a socket is opened.
    const announced = minecraftData.versions.pc
      .slice(0, 40)
      .map((entry) => entry.minecraftVersion);
    const withoutData = announced.filter((version) => data(version) === null);
    expect(withoutData.length).toBeGreaterThan(0);

    for (const version of withoutData) {
      const verdict = checkMinecraftVersion(version);
      expect(verdict.supported, `${version} must be refused`).toBe(false);
      expect(verdict.reason).toContain(version);
    }
  });

  it('refuses a release that is newer than the newest supported one', () => {
    const oldest = data(mineflayer.oldestSupportedVersion);
    const newest = data(mineflayer.latestSupportedVersion);
    expect(oldest).not.toBeNull();
    expect(newest).not.toBeNull();

    const newer = minecraftData.versions.pc
      .map((entry) => entry.minecraftVersion)
      .filter((version) => {
        const entry = known[version];
        if (entry === undefined || entry.dataVersion === undefined) return false;
        if (entry.dataVersion < (known[mineflayer.oldestSupportedVersion]?.dataVersion ?? 0)) {
          return false;
        }
        return entry.dataVersion > (known[mineflayer.latestSupportedVersion]?.dataVersion ?? 0);
      });
    expect(newer.length).toBeGreaterThan(0);

    for (const version of newer) {
      const resolved = data(version);
      // The client speaks a newer release only when it uses the very same
      // protocol as the newest one it supports (26.1.1 is protocol 775).
      const sameProtocol = resolved !== null && resolved.version.version === newest?.version.version;
      if (sameProtocol) {
        expect(checkMinecraftVersion(version).supported, `${version} must be accepted`).toBe(true);
      } else {
        expect(checkMinecraftVersion(version).supported, `${version} must be refused`).toBe(false);
      }
    }
  });

  it('never lists a release the client library cannot speak', () => {
    const oldest = data(mineflayer.oldestSupportedVersion);
    const newest = data(mineflayer.latestSupportedVersion);
    expect(oldest).not.toBeNull();
    expect(newest).not.toBeNull();

    for (const version of supportedVersions()) {
      const resolved = data(version);
      // The protocol data must exist - minecraft-protocol refuses releases
      // it has no data for.
      expect(resolved, `${version} must have protocol data`).not.toBeNull();
      if (resolved === null) continue;
      // And it must be inside the range the client library accepts.
      expect(resolved.version['<'](mineflayer.oldestSupportedVersion)).toBe(false);
      if (resolved.version['>'](mineflayer.latestSupportedVersion)) {
        expect(resolved.version.version).toBe(newest?.version.version);
      }
    }
  });

  it('reports the range the client library supports, not the newest announcement', () => {
    const verdict = checkMinecraftVersion('1.21.1');
    expect(verdict.newestSupported).toBe(mineflayer.latestSupportedVersion);
    expect(verdict.oldestSupported).toBe(mineflayer.oldestSupportedVersion);
  });

  it('still accepts the versions the client library speaks', () => {
    expect(checkMinecraftVersion('1.21.1').supported).toBe(true);
    expect(checkMinecraftVersion(mineflayer.latestSupportedVersion).supported).toBe(true);
    expect(checkMinecraftVersion(mineflayer.oldestSupportedVersion).supported).toBe(true);
    // A pre-release that speaks the protocol of its release is still usable.
    expect(checkMinecraftVersion('1.21.1-rc1').supported).toBe(true);
    expect(isKnownVersion('1.21.1')).toBe(true);
  });

  it('keeps refusing releases outside the client range', () => {
    expect(checkMinecraftVersion('1.6.4').supported).toBe(false);
    expect(checkMinecraftVersion('9.9.9').supported).toBe(false);
    expect(supportedVersions()).not.toContain('1.6.4');
    expect(supportedVersions()).toContain('1.8.8');
  });
});
