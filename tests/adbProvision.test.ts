/**
 * Self-provisioning adb: the paths and URLs, which are the parts that can be
 * pinned without a network. The download itself is exercised manually (and by
 * every first run on a clean machine).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, managedAdbPath, managedToolsDir, resetConfig } from '../src/core/config.js';
import { platformToolsUrl } from '../src/devices/adbProvision.js';

const SANDBOX = join(tmpdir(), `gdps-provision-test-${process.pid}`);

afterEach(() => {
  delete process.env['GDPS_TOOLS_DIR'];
  rmSync(SANDBOX, { recursive: true, force: true });
  resetConfig();
});

describe('platform-tools download URL', () => {
  it('maps each supported OS to the official dl.google.com archive', () => {
    expect(platformToolsUrl('darwin')).toBe(
      'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
    );
    expect(platformToolsUrl('win32')).toBe(
      'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
    );
    expect(platformToolsUrl('linux')).toBe(
      'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
    );
  });

  it('returns null on a platform Google does not ship', () => {
    expect(platformToolsUrl('freebsd')).toBeNull();
  });
});

describe('managed tools directory', () => {
  it('honours GDPS_TOOLS_DIR', () => {
    process.env['GDPS_TOOLS_DIR'] = SANDBOX;
    expect(managedToolsDir()).toBe(SANDBOX);
    expect(managedAdbPath().startsWith(SANDBOX)).toBe(true);
  });

  it('is preferred by the resolver over the bare-PATH fallback', () => {
    process.env['GDPS_TOOLS_DIR'] = SANDBOX;
    const adb = managedAdbPath();
    mkdirSync(join(SANDBOX, 'platform-tools'), { recursive: true });
    writeFileSync(adb, '#!/bin/sh\n');
    expect(existsSync(adb)).toBe(true);

    resetConfig();
    const resolved = loadConfig().adbPath;
    // On a machine with a real SDK or a Homebrew adb those legitimately win -
    // the pin here is only that a discovered binary beats trusting bare PATH,
    // and that the managed copy is found when nothing else exists.
    expect(resolved).not.toBe('adb');
    expect(existsSync(resolved)).toBe(true);
  });
});
