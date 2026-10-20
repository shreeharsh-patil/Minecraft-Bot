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
import mineflayer from 'mineflayer';

/** The version this bot is built and tested against. */
export const TESTED_VERSION = '1.21.1';

/**
 * The oldest version mineflayer can actually speak. The protocol data knows
 * much older releases (1.0 and even the 12w snapshots), but the client
 * library only supports 1.8.8 and newer.
 */
const OLDEST_SUPPORTED_VERSION = mineflayer.oldestSupportedVersion;

/**
 * The newest version the client library speaks. The protocol data runs ahead
 * of the client: a release is announced - and lands in minecraft-data - long
 * before the client can speak it, so the upper bound comes from the client
 * library and not from the data.
 */
const NEWEST_SUPPORTED_VERSION = mineflayer.latestSupportedVersion;

/**
 * Protocol numbers are small (775 for the newest release). minecraft-data
 * marks a release that has no protocol of its own yet with a placeholder
 * above 2^30, so anything above this bound is a placeholder and not a
 * protocol number.
 */
const MAX_PROTOCOL_NUMBER = 1_000_000;

/** Every release minecraft-data knows, keyed by its version string. */
const knownVersions = minecraftData.versionsByMinecraftVersion.pc;

/** The protocol numbers the client library speaks. */
const clientProtocols = new Set(
  mineflayer.testedVersions
    .map((version) => knownVersions[version]?.version)
    .filter((protocol): protocol is number => protocol !== undefined),
);

/** Release order of the client's oldest supported version. */
const oldestDataVersion = knownVersions[OLDEST_SUPPORTED_VERSION]?.dataVersion ?? 0;

/** Release order of the client's newest supported version. */
const newestDataVersion = knownVersions[NEWEST_SUPPORTED_VERSION]?.dataVersion ?? 0;

/** Protocol number of the client's newest supported version (775 for 26.1). */
const newestProtocol = knownVersions[NEWEST_SUPPORTED_VERSION]?.version;

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
 * The protocol a release speaks, or undefined when the release has no
 * protocol of its own.
 *
 * A snapshot or pre-release speaks the protocol of the release it belongs to
 * (1.21.1-rc1 speaks the 1.21 protocol); a release that never got one - the
 * newest announcements - has none at all.
 */
function protocolOf(version: string): number | undefined {
  let current = version;
  for (let depth = 0; depth < 8; depth += 1) {
    const entry = knownVersions[current];
    if (entry === undefined) return undefined;
    const protocol = entry.version;
    if (protocol !== undefined && protocol <= MAX_PROTOCOL_NUMBER) return protocol;
    const major = entry.majorVersion;
    // A release that points at itself has no protocol of its own.
    if (major === undefined || major === current) return undefined;
    current = major;
  }
  return undefined;
}

/**
 * True when the client library can speak this release.
 *
 * The client refuses releases older than its oldest supported one and
 * releases newer than its newest one - unless the newer release speaks the
 * very same protocol (26.1.1 is protocol 775, like 26.1).
 */
function canSpeak(version: string): boolean {
  const entry = knownVersions[version];
  if (entry === undefined) return false;
  const protocol = protocolOf(version);
  if (protocol === undefined) return false;
  if (!clientProtocols.has(protocol)) return false;
  const dataVersion = entry.dataVersion ?? 0;
  if (dataVersion < oldestDataVersion) return false;
  if (dataVersion > newestDataVersion && protocol !== newestProtocol) return false;
  return true;
}

/**
 * Every version the client library can speak, newest first.
 *
 * `minecraft-data` lists releases far older than the client library supports
 * - and far newer, because a release is announced before the client can speak
 * it. Asking for 1.6.4 - or for a release that only the announcement mentions
 * - must be refused with a clear message instead of failing later inside the
 * handshake.
 */
export function supportedVersions(): string[] {
  return minecraftData.versions.pc
    .map((entry) => entry.minecraftVersion)
    .filter((version) => canSpeak(version));
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
  const newestSupported = NEWEST_SUPPORTED_VERSION;
  const oldestSupported = OLDEST_SUPPORTED_VERSION;

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
