/**
 * Step 3 - APK Inspector.
 *
 * Extracts everything the spec asks for (package name, version, ABI, launcher
 * activity, manifest metadata) plus the Unity-specific signals that drive OOM
 * risk: scripting backend, engine version, 64-bit support, whether the build is
 * debuggable (which decides which telemetry probes we can use), and the size of
 * the shipped asset payload.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { ApkError } from '../core/errors.js';
import { run } from '../core/exec.js';
import type { Logger } from '../core/logger.js';
import { MB } from '../core/types.js';
import { attr, findElements, parseAndroidManifest, type ParsedManifest } from './axml.js';
import { withZip, type ZipEntry, type ZipReader } from './zip.js';

export type ScriptingBackend = 'IL2CPP' | 'Mono' | 'unknown';

export interface ApkInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdkVersion: number | null;
  targetSdkVersion: number | null;
  /** Launcher activity, fully qualified. Used to start the game. */
  launcherActivity: string | null;
  /** `package/activity` form ready for `am start -n`. */
  launchComponent: string | null;
  debuggable: boolean;
  /** true when android:extractNativeLibs is not disabled. */
  extractNativeLibs: boolean | null;
  largeHeap: boolean;
  hardwareAccelerated: boolean | null;
  abis: string[];
  is64BitOnly: boolean;
  has32Bit: boolean;
  permissions: string[];
  metaData: Record<string, string>;
  unity: UnityApkInfo;
  contents: ApkContentSummary;
  /** Non-fatal problems worth showing the operator. */
  warnings: string[];
}

export interface UnityApkInfo {
  isUnity: boolean;
  engineVersion: string | null;
  scriptingBackend: ScriptingBackend;
  /** Present when the build ships a split-application-binary OBB layout. */
  usesSplitBinary: boolean;
  hasAddressables: boolean;
  hasAssetBundles: boolean;
  /** Names of scenes shipped in the build, when readable from the data folder. */
  dataFolder: string | null;
  il2cppLibSizeBytes: number | null;
  assetPayloadBytes: number;
}

export interface ApkContentSummary {
  entryCount: number;
  totalUncompressedBytes: number;
  /** Largest shipped entries - a fast pointer at heavyweight content. */
  largestEntries: Array<{ name: string; uncompressedBytes: number }>;
  byTopLevelDir: Record<string, { count: number; uncompressedBytes: number }>;
}

export interface InspectApkOptions {
  apkPath: string;
  aapt2Path?: string | null;
  logger?: Logger;
}

export async function inspectApk(opts: InspectApkOptions): Promise<ApkInfo> {
  const { apkPath, aapt2Path, logger } = opts;
  if (!existsSync(apkPath)) throw new ApkError(`APK not found: ${apkPath}`);

  const info = withZip(apkPath, (zip) => inspectZip(apkPath, zip, logger));

  // aapt2, when available, is a useful cross-check on our own manifest parse.
  if (aapt2Path) {
    const crossCheck = await aapt2Badging(aapt2Path, apkPath, logger);
    if (crossCheck) reconcile(info, crossCheck, logger);
  }

  if (!info.packageName) {
    throw new ApkError('Could not determine the package name from the APK manifest.', {
      hint: 'The APK may be an App Bundle (.aab) or obfuscated in an unsupported way.',
    });
  }

  logger?.info('APK inspected', {
    package: info.packageName,
    version: info.versionName ?? 'unknown',
    abis: info.abis.join(',') || 'none',
    unity: info.unity.engineVersion ?? info.unity.isUnity,
    backend: info.unity.scriptingBackend,
  });

  return info;
}

function inspectZip(apkPath: string, zip: ZipReader, logger?: Logger): ApkInfo {
  const warnings: string[] = [];
  const entries = zip.entries();

  let manifest: ParsedManifest | null = null;
  try {
    const raw = zip.readFile('AndroidManifest.xml');
    if (raw) manifest = parseAndroidManifest(raw);
  } catch (err) {
    warnings.push(
      `Binary manifest parse failed (${err instanceof Error ? err.message : String(err)}); ` +
        'falling back to aapt2 if available.',
    );
  }

  const manifestInfo = manifest ? readManifest(manifest) : emptyManifestInfo();
  const abis = detectAbis(entries);
  const unity = detectUnity(zip, entries);
  const contents = summarizeContents(entries);

  if (unity.isUnity && abis.length > 0 && !abis.includes('arm64-v8a')) {
    warnings.push(
      'No arm64-v8a native library: the game runs in 32-bit mode where the per-process address ' +
        'space is capped near 3-4 GB and OOM risk is materially higher.',
    );
  }
  if (!unity.isUnity) {
    warnings.push('This APK does not look like a Unity build; Unity-specific analysis will be limited.');
  }

  const launchComponent =
    manifestInfo.packageName && manifestInfo.launcherActivity
      ? `${manifestInfo.packageName}/${manifestInfo.launcherActivity}`
      : null;

  const size = entries.reduce((acc, e) => acc + e.compressedSize, 0);

  return {
    path: apkPath,
    fileName: basename(apkPath),
    sizeBytes: size,
    ...manifestInfo,
    launchComponent,
    abis,
    is64BitOnly: abis.length > 0 && abis.every((a) => a.includes('64')),
    has32Bit: abis.some((a) => a === 'armeabi-v7a' || a === 'x86'),
    unity,
    contents,
    warnings,
  };
}

interface ManifestInfo {
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdkVersion: number | null;
  targetSdkVersion: number | null;
  launcherActivity: string | null;
  debuggable: boolean;
  extractNativeLibs: boolean | null;
  largeHeap: boolean;
  hardwareAccelerated: boolean | null;
  permissions: string[];
  metaData: Record<string, string>;
}

function emptyManifestInfo(): ManifestInfo {
  return {
    packageName: null,
    versionName: null,
    versionCode: null,
    minSdkVersion: null,
    targetSdkVersion: null,
    launcherActivity: null,
    debuggable: false,
    extractNativeLibs: null,
    largeHeap: false,
    hardwareAccelerated: null,
    permissions: [],
    metaData: {},
  };
}

function readManifest(manifest: ParsedManifest): ManifestInfo {
  const manifestEl = findElements(manifest, 'manifest')[0];
  const application = findElements(manifest, 'application')[0];

  const packageName = manifestEl ? attr(manifestEl, 'package') : null;
  const versionName = manifestEl ? attr(manifestEl, 'versionName') : null;
  const versionCodeRaw = manifestEl ? attr(manifestEl, 'versionCode') : null;

  const usesSdk = findElements(manifest, 'uses-sdk')[0];
  const minSdk = usesSdk ? attr(usesSdk, 'minSdkVersion') : null;
  const targetSdk = usesSdk ? attr(usesSdk, 'targetSdkVersion') : null;

  const permissions = findElements(manifest, 'uses-permission')
    .map((el) => attr(el, 'name'))
    .filter((n): n is string => Boolean(n));

  const metaData: Record<string, string> = {};
  for (const el of findElements(manifest, 'meta-data')) {
    const name = attr(el, 'name');
    const value = attr(el, 'value') ?? attr(el, 'resource');
    if (name) metaData[name] = value ?? '';
  }

  return {
    packageName,
    versionName,
    versionCode: versionCodeRaw !== null ? Number(versionCodeRaw) || null : null,
    minSdkVersion: minSdk !== null ? Number(minSdk) || null : null,
    targetSdkVersion: targetSdk !== null ? Number(targetSdk) || null : null,
    launcherActivity: findLauncherActivity(manifest, packageName),
    debuggable: application ? attr(application, 'debuggable') === 'true' : false,
    extractNativeLibs: application ? parseBool(attr(application, 'extractNativeLibs')) : null,
    largeHeap: application ? attr(application, 'largeHeap') === 'true' : false,
    hardwareAccelerated: application ? parseBool(attr(application, 'hardwareAccelerated')) : null,
    permissions,
    metaData,
  };
}

function parseBool(value: string | null): boolean | null {
  if (value === null) return null;
  return value === 'true';
}

/**
 * The launcher is the activity whose intent-filter has both
 * action.MAIN and category.LAUNCHER. We walk the tree rather than guessing
 * `com.unity3d.player.UnityPlayerActivity`, because many studios subclass it.
 */
function findLauncherActivity(manifest: ParsedManifest, packageName: string | null): string | null {
  const activities = [
    ...findElements(manifest, 'activity'),
    ...findElements(manifest, 'activity-alias'),
  ];

  for (const activity of activities) {
    for (const filter of activity.children.filter((c) => c.name === 'intent-filter')) {
      const hasMain = filter.children.some(
        (c) => c.name === 'action' && attr(c, 'name') === 'android.intent.action.MAIN',
      );
      const hasLauncher = filter.children.some(
        (c) => c.name === 'category' && attr(c, 'name') === 'android.intent.category.LAUNCHER',
      );
      if (hasMain && hasLauncher) {
        const name = attr(activity, 'name');
        if (name) return qualify(name, packageName);
      }
    }
  }
  return null;
}

function qualify(activityName: string, packageName: string | null): string {
  if (activityName.startsWith('.')) return `${packageName ?? ''}${activityName}`;
  if (!activityName.includes('.') && packageName) return `${packageName}.${activityName}`;
  return activityName;
}

function detectAbis(entries: ZipEntry[]): string[] {
  const abis = new Set<string>();
  for (const entry of entries) {
    const match = /^lib\/([^/]+)\//.exec(entry.name);
    if (match?.[1]) abis.add(match[1]);
  }
  return [...abis].sort();
}

function detectUnity(zip: ZipReader, entries: ZipEntry[]): UnityApkInfo {
  const names = entries.map((e) => e.name);
  const hasUnityLib = names.some((n) => /lib\/[^/]+\/libunity\.so$/.test(n));
  const hasDataFolder = names.some((n) => n.startsWith('assets/bin/Data/'));
  const isUnity = hasUnityLib || hasDataFolder;

  const il2cppEntry = entries.find((e) => /lib\/[^/]+\/libil2cpp\.so$/.test(e.name));
  const hasMono = names.some((n) => /lib\/[^/]+\/libmono.*\.so$/.test(n)) ||
    names.some((n) => n.startsWith('assets/bin/Data/Managed/') && n.endsWith('.dll'));

  let scriptingBackend: ScriptingBackend = 'unknown';
  if (il2cppEntry) scriptingBackend = 'IL2CPP';
  else if (hasMono) scriptingBackend = 'Mono';

  const assetPayloadBytes = entries
    .filter((e) => e.name.startsWith('assets/'))
    .reduce((acc, e) => acc + e.uncompressedSize, 0);

  return {
    isUnity,
    engineVersion: readEngineVersion(zip, names),
    scriptingBackend,
    usesSplitBinary: names.some((n) => n.includes('main.obb') || n.includes('assets/bin/Data/split')),
    hasAddressables: names.some((n) => n.includes('aa/') || n.includes('catalog') ),
    hasAssetBundles: names.some((n) => /assets\/.*\.(bundle|unity3d)$/i.test(n)),
    dataFolder: hasDataFolder ? 'assets/bin/Data' : null,
    il2cppLibSizeBytes: il2cppEntry?.uncompressedSize ?? null,
    assetPayloadBytes,
  };
}

/**
 * Unity stamps the engine version into `assets/bin/Data/globalgamemanagers`
 * (and into the `data.unity3d` container for newer layouts). Both start with a
 * readable version string near the head of the file, so a bounded scan is
 * enough - we deliberately avoid a full serialized-file parser here.
 */
function readEngineVersion(zip: ZipReader, names: string[]): string | null {
  const candidates = [
    'assets/bin/Data/globalgamemanagers',
    'assets/bin/Data/data.unity3d',
    'assets/bin/Data/unity default resources',
  ].filter((n) => names.includes(n));

  for (const candidate of candidates) {
    try {
      const buf = zip.readFile(candidate);
      if (!buf) continue;
      const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
      const match = /(\d+\.\d+\.\d+[abfp]\d+)/.exec(head);
      if (match?.[1]) return match[1];
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function summarizeContents(entries: ZipEntry[]): ApkContentSummary {
  const byTopLevelDir: Record<string, { count: number; uncompressedBytes: number }> = {};
  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    totalUncompressedBytes += entry.uncompressedSize;
    const top = entry.name.includes('/') ? entry.name.split('/')[0] ?? '/' : '/';
    const bucket = (byTopLevelDir[top] ??= { count: 0, uncompressedBytes: 0 });
    bucket.count++;
    bucket.uncompressedBytes += entry.uncompressedSize;
  }

  const largestEntries = entries
    .filter((e) => !e.isDirectory)
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)
    .slice(0, 25)
    .map((e) => ({ name: e.name, uncompressedBytes: e.uncompressedSize }));

  return {
    entryCount: entries.filter((e) => !e.isDirectory).length,
    totalUncompressedBytes,
    largestEntries,
    byTopLevelDir,
  };
}

// ---------------------------------------------------------------------------
// Optional aapt2 cross-check
// ---------------------------------------------------------------------------

interface BadgingInfo {
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  launcherActivity?: string;
  minSdk?: number;
  targetSdk?: number;
}

async function aapt2Badging(
  aapt2Path: string,
  apkPath: string,
  logger?: Logger,
): Promise<BadgingInfo | null> {
  try {
    const res = await run(aapt2Path, ['dump', 'badging', apkPath], { timeoutMs: 60_000 });
    if (res.code !== 0) return null;
    const out = res.stdout;
    const pkg = /package: name='([^']+)'(?:.*?versionCode='(\d+)')?(?:.*?versionName='([^']*)')?/.exec(out);
    return {
      packageName: pkg?.[1],
      versionCode: pkg?.[2] ? Number(pkg[2]) : undefined,
      versionName: pkg?.[3],
      launcherActivity: /launchable-activity: name='([^']+)'/.exec(out)?.[1],
      minSdk: numberOrUndefined(/sdkVersion:'(\d+)'/.exec(out)?.[1]),
      targetSdk: numberOrUndefined(/targetSdkVersion:'(\d+)'/.exec(out)?.[1]),
    };
  } catch (err) {
    logger?.debug('aapt2 cross-check unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function numberOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Fill gaps from aapt2 and warn when the two sources disagree.
 *
 * Empty values are treated as absent. aapt2 reports `versionName=''` for any
 * attribute whose resource id it cannot resolve, and letting that overwrite a
 * value our own manifest parser read correctly would lose real information.
 */
function reconcile(info: ApkInfo, badging: BadgingInfo, logger?: Logger): void {
  const check = <K extends keyof ApkInfo>(key: K, value: ApkInfo[K] | undefined, label: string) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    if (info[key] === null || info[key] === undefined) {
      info[key] = value;
    } else if (info[key] !== value) {
      const message = `aapt2 reports ${label}="${String(value)}" but the manifest parser read "${String(info[key])}"; using aapt2.`;
      info.warnings.push(message);
      logger?.warn(message);
      info[key] = value;
    }
  };

  check('packageName', badging.packageName as ApkInfo['packageName'], 'package');
  check('versionName', badging.versionName as ApkInfo['versionName'], 'versionName');
  check('versionCode', badging.versionCode as ApkInfo['versionCode'], 'versionCode');
  check('minSdkVersion', badging.minSdk as ApkInfo['minSdkVersion'], 'minSdkVersion');
  check('targetSdkVersion', badging.targetSdk as ApkInfo['targetSdkVersion'], 'targetSdkVersion');

  if (badging.launcherActivity) {
    const qualified = qualify(badging.launcherActivity, info.packageName);
    info.launcherActivity = qualified;
    info.launchComponent = info.packageName ? `${info.packageName}/${qualified}` : qualified;
  }
}

/** Human-friendly one-liner for the console and report header. */
export function describeApk(info: ApkInfo): string {
  const size = (info.sizeBytes / MB).toFixed(1);
  const unity = info.unity.engineVersion ? `Unity ${info.unity.engineVersion}` : 'Unity (version unknown)';
  return `${info.packageName} v${info.versionName ?? '?'} (${size} MB, ${unity}, ${info.unity.scriptingBackend}, ${info.abis.join('/') || 'no native libs'})`;
}
