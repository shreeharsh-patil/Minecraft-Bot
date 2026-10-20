/**
 * The bot must speak the version its server runs - and say so clearly when it
 * cannot. These tests pin the supported range and the error message.
 */
import { describe, expect, it } from 'vitest';
import {
  checkMinecraftVersion,
  isKnownVersion,
  supportedVersions,
  TESTED_VERSION,
} from '../../src/bot/versionSupport.js';

describe('minecraft version support', () => {
  it('supports the tested version (1.21.1)', () => {
    expect(TESTED_VERSION).toBe('1.21.1');
    const verdict = checkMinecraftVersion('1.21.1');
    expect(verdict.supported).toBe(true);
    expect(verdict.requested).toBe('1.21.1');
  });

  it('allows auto-detection (no version configured)', () => {
    const verdict = checkMinecraftVersion(undefined);
    expect(verdict.supported).toBe(true);
    expect(verdict.requested).toBeUndefined();
  });

  it('allows an empty version string (auto-detection)', () => {
    expect(checkMinecraftVersion('   ').supported).toBe(true);
  });

  it('refuses a version the client library cannot speak', () => {
    const verdict = checkMinecraftVersion('1.6.4');
    expect(verdict.supported).toBe(false);
    expect(verdict.reason).toContain('not supported');
    // The message must name the versions that do work.
    expect(verdict.reason).toContain('1.21.1');
  });

  it('refuses a version that does not exist', () => {
    const verdict = checkMinecraftVersion('9.9.9');
    expect(verdict.supported).toBe(false);
    expect(verdict.reason).toContain('9.9.9');
  });

  it('accepts a known pre-release build (the protocol data knows it)', () => {
    expect(checkMinecraftVersion('1.21.1-rc1').supported).toBe(true);
  });

  it('does not offer versions older than the client supports', () => {
    expect(supportedVersions()).not.toContain('1.6.4');
    expect(supportedVersions()).toContain('1.8.8');
  });

  it('accepts every version the library knows', () => {
    for (const version of supportedVersions()) {
      expect(checkMinecraftVersion(version).supported).toBe(true);
    }
  });

  it('knows 1.21.1 and rejects nonsense', () => {
    expect(isKnownVersion('1.21.1')).toBe(true);
    expect(isKnownVersion('not-a-version')).toBe(false);
  });

  it('reports a usable range', () => {
    const verdict = checkMinecraftVersion('1.21.1');
    expect(verdict.oldestSupported.length).toBeGreaterThan(0);
    expect(verdict.newestSupported.length).toBeGreaterThan(0);
  });
});
