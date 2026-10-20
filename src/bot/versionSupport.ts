/**
 * Minecraft version support.
 *
 * The bot talks the vanilla protocol, so it works against a Vanilla server and
 * against a Fabric server alike (Fabric only changes the server side; the wire
 * format is the same). What DOES matter is the protocol version: mineflayer can
 * only speak the versions its data files know.
 *
 * A wrong `MC_VERSION` otherwise fails deep inside the protocol handshake with
 * an error that says nothing useful ("wrong version", "unsupported protocol"),
 * so the version is checked here, before a socket is opened, and the message
 * names the versions that do work.
 */
import minecraftData from 'minecraft-data';

/** The version this bot is built and tested against. */
export const TESTED_VERSION = '1.21.1';

/**
 * The oldest version mineflayer can actually speak. The protocol data knows
 * much older releases (1.0 and even the 12w snapshots), but the client
 * library only supports 1.8.8 and newer.
 */
const OLDEST_SUPPORTED_VERSION = '1.8.8';

export interface VersionVerdict {
  /** True when the client library can speak this version. */
  supported: boolean;
  /** The version that was asked for (undefined = auto-detect). */
  requested?: string;
  /** The newest version the client library supports. */
  newestSupported: string;
  /** The oldest version the client library supports. */
  oldestSupported: string;
  /** Why it was refused (only when `supported` is false). */
  reason?: string;
}

/**
 * Every version the installed protocol data can speak, newest first.
 *
 * `minecraft-data` lists releases far older than the client library supports,
 * so the list is cut at 1.8.8: asking for 1.6.4 must be refused with a clear
 * message instead of failing later inside the handshake.
 */
export function supportedVersions(): string[] {
  const all = minecraftData.versions.pc.map((entry) => entry.minecraftVersion);
  const oldestIndex = all.indexOf(OLDEST_SUPPORTED_VERSION);
  if (oldestIndex === -1) return all;
  // The list is newest-first, so everything up to (and including) 1.8.8 is
  // supported and everything after it is too old.
  return all.slice(0, oldestIndex + 1);
}

/**
 * Checks a requested version against the client library.
 *
 * An empty/undefined request means "auto-detect", which is always allowed:
 * the server announces its protocol version and mineflayer picks the matching
 * data file.
 */
export function checkMinecraftVersion(requested?: string): VersionVerdict {
  const versions = supportedVersions();
  const newestSupported = versions[0] ?? TESTED_VERSION;
  const oldestSupported = versions[versions.length - 1] ?? OLDEST_SUPPORTED_VERSION;

  if (requested === undefined || requested.trim().length === 0) {
    return { supported: true, newestSupported, oldestSupported };
  }

  const wanted = requested.trim();
  if (versions.includes(wanted)) {
    return { supported: true, requested: wanted, newestSupported, oldestSupported };
  }

  return {
    supported: false,
    requested: wanted,
    newestSupported,
    oldestSupported,
    reason:
      `Minecraft ${wanted} is not supported by this client. ` +
      `Supported: ${oldestSupported} to ${newestSupported} (tested: ${TESTED_VERSION}). ` +
      `Leave MC_VERSION empty to auto-detect the server's version.`,
  };
}

/**
 * True when the client library can speak the version the server announces.
 * Used after a handshake failure to turn a cryptic error into a real one.
 */
export function isKnownVersion(version: string): boolean {
  return supportedVersions().includes(version);
}
