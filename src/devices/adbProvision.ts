/**
 * Self-provisioning adb.
 *
 * The tool's operators are QA testers and producers, not Android developers -
 * "install platform-tools first" is a setup step half of them will fail, and
 * the packaged desktop app cannot even see a Homebrew install because a
 * Finder-launched process gets the minimal system PATH. So when no adb exists
 * anywhere on the machine, the tool fetches Google's own platform-tools
 * package and keeps a private copy.
 *
 * Downloading rather than bundling is deliberate: each machine pulls the
 * archive straight from dl.google.com, so the tool never redistributes
 * Google's binaries, and it always gets a current adb rather than whatever
 * was frozen into an installer a year ago. The URL is the official stable
 * "latest" alias that Android Studio's own tooling uses.
 *
 * The managed copy lives in the tool's own directory and never touches the
 * system: no PATH edits, no sudo, removable by deleting the folder.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ZipReader } from '../apk/zip.js';
import { managedAdbPath, managedToolsDir } from '../core/config.js';
import type { Logger } from '../core/logger.js';

const PLATFORM_KEY: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'darwin',
  win32: 'windows',
  linux: 'linux',
};

/** The official archive for this OS, or null on a platform Google doesn't ship. */
export function platformToolsUrl(platform: NodeJS.Platform = process.platform): string | null {
  const key = PLATFORM_KEY[platform];
  return key ? `https://dl.google.com/android/repository/platform-tools-latest-${key}.zip` : null;
}

/**
 * Make sure a managed adb exists, downloading it if it does not.
 *
 * Returns the path to the managed binary. Throws with a plain-language message
 * when the platform is unsupported or the download fails - the caller keeps
 * the manual-install hint as the fallback story.
 */
export async function ensureManagedAdb(logger?: Logger): Promise<string> {
  const target = managedAdbPath();
  if (existsSync(target)) return target;

  const url = platformToolsUrl();
  if (!url) {
    throw new Error(`No platform-tools package exists for ${process.platform}.`);
  }

  logger?.info('adb is not installed - fetching Android platform-tools', { url });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Downloading platform-tools failed: HTTP ${response.status} from dl.google.com`);
  }
  const archive = Buffer.from(await response.arrayBuffer());

  // Extract into a staging directory and rename into place at the end, so a
  // crash mid-extract can never leave a half-populated dir that existsSync
  // would then trust forever.
  const staging = join(tmpdir(), `gdps-platform-tools-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const archivePath = join(staging, 'platform-tools.zip');
  writeFileSync(archivePath, archive);

  const zip = new ZipReader(archivePath);
  try {
    for (const entry of zip.entries()) {
      if (entry.isDirectory) continue;
      // Zip entries are attacker-ish input in principle; refuse path escapes.
      const clean = entry.name.replace(/\\/g, '/');
      if (clean.includes('..')) continue;
      const dest = join(staging, clean);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, zip.readEntry(entry));
    }
  } finally {
    zip.close();
  }
  rmSync(archivePath, { force: true });

  const stagedAdb = join(staging, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  if (!existsSync(stagedAdb)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error('The downloaded platform-tools archive did not contain adb.');
  }
  if (process.platform !== 'win32') {
    // The zip reader does not preserve unix modes; adb and fastboot need +x.
    chmodSync(stagedAdb, 0o755);
    const fastboot = join(staging, 'platform-tools', 'fastboot');
    if (existsSync(fastboot)) chmodSync(fastboot, 0o755);
  }

  const finalDir = join(managedToolsDir(), 'platform-tools');
  mkdirSync(managedToolsDir(), { recursive: true });
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(join(staging, 'platform-tools'), finalDir);
  rmSync(staging, { recursive: true, force: true });

  logger?.info('platform-tools installed', { path: target });
  return target;
}
