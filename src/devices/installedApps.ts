/**
 * Enumerate the apps installed on a device, so an operator can pick the game
 * from a list instead of hunting for its APK.
 *
 * This is the normal way to start a live analysis: the build under test is
 * usually already on the device, and everything the profiling phase needs -
 * package name and launch component - can be read from the device itself. The
 * APK file only adds build-configuration detail, and can be pulled later if
 * wanted.
 *
 * Cost model: one `pm list packages` call plus one `dumpsys package packages`
 * call for the whole list, rather than a call per app. On a device with 150 apps
 * the per-app approach takes tens of seconds; this takes a couple.
 *
 * The parsers are exported separately from the adb calls so they can be tested
 * against captured output without a device attached.
 */
import type { AdbDevice } from './adb.js';
import { DeviceError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export interface InstalledApp {
  packageName: string;
  /** On-device path to base.apk, when `pm list packages -f` reported one. */
  apkPath: string | null;
  versionName: string | null;
  versionCode: number | null;
  /**
   * Human-readable name, only when the manifest stored it as a literal.
   * Most apps use a string resource, which needs resources.arsc to resolve -
   * so this is frequently null and the UI falls back to the package name.
   */
  label: string | null;
  primaryAbi: string | null;
  minSdk: number | null;
  targetSdk: number | null;
  debuggable: boolean;
  isSystem: boolean;
  firstInstallTime: string | null;
  lastUpdateTime: string | null;
  /** Filled in on demand - see `resolveLaunchComponent`. */
  launchComponent?: string | null;
}

export interface ListAppsOptions {
  /** Include system apps. Off by default: the game under test is never one. */
  includeSystem?: boolean;
  logger?: Logger;
}

export async function listInstalledApps(
  device: AdbDevice,
  opts: ListAppsOptions = {},
): Promise<InstalledApp[]> {
  const { logger } = opts;

  // `-3` restricts to third-party packages, which is what an operator wants.
  // `-f` appends the APK path, which we need to offer an optional APK pull.
  const listArgs = ['pm', 'list', 'packages', '-f', ...(opts.includeSystem ? [] : ['-3'])];

  // `shell()` rather than `shellOut()` deliberately: adb reports a missing or
  // unauthorized device on stderr while leaving stdout empty, so reading stdout
  // alone would turn a connection failure into "no apps installed" - a wrong
  // answer that reads like a real one.
  const result = await device.shell(listArgs, 60_000);
  const adbFailed =
    result.code !== 0 || /error:|not found|unauthorized|device offline/i.test(result.stderr);

  if (adbFailed) {
    throw new DeviceError(
      `Could not list installed apps on ${device.serial}: ${result.stderr.trim() || `adb exited ${result.code}`}`,
      {
        hint:
          'Check the device is connected and authorized. Verify with: ' +
          `adb -s ${device.serial} shell pm list packages`,
      },
    );
  }

  const packages = parsePackageList(result.stdout);
  if (packages.length === 0) return [];

  // One bulk dump for metadata. If it fails or cannot be parsed we still return
  // the package names, which is enough to run an analysis.
  let details = new Map<string, PackageDetail>();
  try {
    const dump = await device.shellOut(['dumpsys', 'package', 'packages'], 120_000);
    details = parsePackageDump(dump);
  } catch (err) {
    logger?.warn('Could not read package details; listing names only', {
      serial: device.serial,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const apps: InstalledApp[] = packages.map((p) => {
    const d = details.get(p.packageName);
    return {
      packageName: p.packageName,
      apkPath: p.apkPath,
      versionName: d?.versionName ?? null,
      versionCode: d?.versionCode ?? null,
      label: d?.label ?? null,
      primaryAbi: d?.primaryAbi ?? null,
      minSdk: d?.minSdk ?? null,
      targetSdk: d?.targetSdk ?? null,
      debuggable: d?.debuggable ?? false,
      isSystem: d?.isSystem ?? false,
      firstInstallTime: d?.firstInstallTime ?? null,
      lastUpdateTime: d?.lastUpdateTime ?? null,
    };
  });

  // Most recently updated first: the build just pushed for testing is the one
  // the operator is almost always looking for.
  apps.sort((a, b) => (b.lastUpdateTime ?? '').localeCompare(a.lastUpdateTime ?? ''));

  logger?.info('Installed apps listed', {
    serial: device.serial,
    apps: apps.length,
    withDetails: apps.filter((a) => a.versionName !== null).length,
  });

  return apps;
}

/**
 * Resolve the activity to launch for a package.
 *
 * Asked per app rather than for the whole list, because it is only needed once
 * the operator has chosen one.
 */
/**
 * The version of an app as installed, read from the device.
 *
 * Needed because a run that profiles an installed app has no APK to inspect, and
 * without a version two sessions of different builds are indistinguishable in
 * the report - which is exactly what a comparison needs to tell apart.
 */
export async function readInstalledVersion(
  device: AdbDevice,
  packageName: string,
): Promise<string | null> {
  const res = await device.shell(['dumpsys', 'package', packageName], 20_000);
  if (res.code !== 0) return null;

  const version = /versionName=(\S+)/.exec(res.stdout)?.[1];
  return version && version !== 'null' ? version : null;
}

export async function resolveLaunchComponent(
  device: AdbDevice,
  packageName: string,
): Promise<string | null> {
  // `resolve-activity --brief` prints the component on its own line and is the
  // most direct route. It does not exist on older devices, hence the fallback.
  const brief = await device
    .shellOut(
      [
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-c',
        'android.intent.category.LAUNCHER',
        packageName,
      ],
      20_000,
    )
    .catch(() => '');

  const fromBrief = parseResolveActivity(brief, packageName);
  if (fromBrief) return fromBrief;

  // Fallback: read the launcher activity out of the intent-filter dump.
  const dump = await device
    .shellOut(['dumpsys', 'package', packageName], 30_000)
    .catch(() => '');
  return parseLauncherFromDump(dump, packageName);
}

/**
 * Whether the running process has the Unity engine loaded.
 *
 * Checked after launch rather than from the APK: `/proc/<pid>/maps` names every
 * shared library the process actually mapped, so `libunity.so` being present is
 * direct evidence, and it costs one cheap read instead of pulling a 500 MB file.
 */
export async function isUnityProcess(device: AdbDevice, pid: number): Promise<boolean | null> {
  const maps = await device.shellOut(['cat', `/proc/${pid}/maps`], 15_000).catch(() => null);
  if (maps === null || maps.trim() === '') return null; // unreadable, not "no"
  return /libunity\.so/i.test(maps);
}

// ---------------------------------------------------------------------------
// Parsers - pure, so they can be tested against captured output
// ---------------------------------------------------------------------------

export interface ListedPackage {
  packageName: string;
  apkPath: string | null;
}

/**
 * Parse `pm list packages -f -3`.
 *
 * Lines look like:
 *   package:/data/app/~~AbC==/com.studio.game-XyZ==/base.apk=com.studio.game
 *
 * The package name is after the *last* `=`, because the APK path itself contains
 * `=` characters in the modern randomised directory names.
 */
export function parsePackageList(output: string): ListedPackage[] {
  const apps: ListedPackage[] = [];

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('package:')) continue;

    const body = line.slice('package:'.length);
    const split = body.lastIndexOf('=');

    if (split === -1) {
      // `pm list packages` without -f: just the package name.
      if (body) apps.push({ packageName: body, apkPath: null });
      continue;
    }

    const apkPath = body.slice(0, split);
    const packageName = body.slice(split + 1);
    if (packageName) {
      apps.push({ packageName, apkPath: apkPath || null });
    }
  }

  return apps;
}

export interface PackageDetail {
  versionName: string | null;
  versionCode: number | null;
  label: string | null;
  primaryAbi: string | null;
  minSdk: number | null;
  targetSdk: number | null;
  debuggable: boolean;
  isSystem: boolean;
  firstInstallTime: string | null;
  lastUpdateTime: string | null;
}

/**
 * Parse `dumpsys package packages` into per-package detail.
 *
 * The format is stable in shape but varies across Android versions in which
 * fields appear and how they are spelled, so every field is optional and parsed
 * independently. A package whose block is unrecognisable still yields its name.
 */
export function parsePackageDump(output: string): Map<string, PackageDetail> {
  const result = new Map<string, PackageDetail>();

  // Split on the `Package [name] (hash):` headers that begin each block.
  const header = /^\s*Package \[([^\]]+)\][^\n]*:\s*$/gm;
  const starts: Array<{ name: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = header.exec(output)) !== null) {
    starts.push({ name: m[1]!, index: m.index + m[0].length });
  }

  starts.forEach((start, i) => {
    const block = output.slice(start.index, starts[i + 1]?.index ?? output.length);
    result.set(start.name, parsePackageBlock(block));
  });

  return result;
}

function parsePackageBlock(block: string): PackageDetail {
  const str = (re: RegExp): string | null => {
    const found = re.exec(block);
    return found?.[1]?.trim() || null;
  };
  const num = (re: RegExp): number | null => {
    const raw = str(re);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };

  // `flags=[ ... ]` and `pkgFlags=[ ... ]` are both used depending on version.
  const flags = `${str(/\bflags=\[([^\]]*)\]/) ?? ''} ${str(/\bpkgFlags=\[([^\]]*)\]/) ?? ''}`;

  const label = str(/\bnonLocalizedLabel=(.+)/);

  return {
    versionName: str(/\bversionName=(\S+)/),
    versionCode: num(/\bversionCode=(\d+)/),
    // "null" is dumpsys's way of saying the label is a string resource.
    label: label && label !== 'null' ? label : null,
    primaryAbi: str(/\bprimaryCpuAbi=(\S+)/) === 'null' ? null : str(/\bprimaryCpuAbi=(\S+)/),
    minSdk: num(/\bminSdk=(\d+)/),
    targetSdk: num(/\btargetSdk=(\d+)/),
    debuggable: /\bDEBUGGABLE\b/.test(flags),
    isSystem: /\bSYSTEM\b/.test(flags),
    firstInstallTime: str(/\bfirstInstallTime=(.+)/),
    lastUpdateTime: str(/\blastUpdateTime=(.+)/),
  };
}

/**
 * Parse `cmd package resolve-activity --brief`.
 *
 * Output is a short block whose last non-empty line is the component:
 *   priority=0 preferredOrder=0 ...
 *   com.studio.game/com.unity3d.player.UnityPlayerActivity
 */
export function parseResolveActivity(output: string, packageName: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines.reverse()) {
    if (line.startsWith(`${packageName}/`)) return normalizeComponent(line, packageName);
  }
  return null;
}

/**
 * Pull the launcher activity out of a `dumpsys package <pkg>` intent-filter
 * section, for devices without `cmd package resolve-activity`.
 */
export function parseLauncherFromDump(output: string, packageName: string): string | null {
  // Activity blocks look like:  <hash> com.studio.game/.MainActivity filter <hash>
  const re = new RegExp(`${escapeRegExp(packageName)}/[\\w$.]+`, 'g');
  const seen = output.match(re);
  if (!seen) return null;

  // Prefer a component that appears near a LAUNCHER category mention.
  const launcherIndex = output.indexOf('android.intent.category.LAUNCHER');
  if (launcherIndex !== -1) {
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of new Set(seen)) {
      const at = output.indexOf(candidate);
      const distance = Math.abs(launcherIndex - at);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    if (best) return normalizeComponent(best, packageName);
  }

  return normalizeComponent(seen[0]!, packageName);
}

/** Expand the `pkg/.Activity` shorthand into a fully qualified component. */
function normalizeComponent(component: string, packageName: string): string {
  const [, activity] = component.split('/');
  if (!activity) return component;
  return activity.startsWith('.')
    ? `${packageName}/${packageName}${activity}`
    : `${packageName}/${activity}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
