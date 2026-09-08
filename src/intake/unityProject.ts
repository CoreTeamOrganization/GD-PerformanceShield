/**
 * Step 2 (part 2) - Unity project validation and discovery.
 *
 * The spec is explicit that `.meta` files and ProjectSettings must be present:
 * most OOM causes live in import settings, not in C#. This module verifies that
 * and produces the project map every later stage relies on.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { IntakeError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export interface UnityProjectInfo {
  root: string;
  valid: boolean;
  unityVersion: string | null;
  /** Scripting backend as configured in ProjectSettings (may differ from APK). */
  scriptingBackend: string | null;
  companyName: string | null;
  productName: string | null;
  bundleIdentifier: string | null;
  /** Scenes listed in Build Settings, in build order. */
  buildScenes: BuildScene[];
  packages: Record<string, string>;
  usesAddressables: boolean;
  addressableGroupFiles: string[];
  hasMetaFiles: boolean;
  metaFileCount: number;
  assetCount: number;
  /** Problems that degrade analysis quality but do not stop the run. */
  warnings: string[];
}

/** What the console needs to know about a folder the operator just chose. */
export interface UnityProjectProbe {
  valid: boolean;
  /** Why it is not usable, phrased for the operator. Null when valid. */
  reason: string | null;
  unityVersion: string | null;
  scriptingBackend: string | null;
  productName: string | null;
  /** Scenes enabled in Build Settings - the ones that actually ship. */
  sceneCount: number;
  usesAddressables: boolean;
  hasPackages: boolean;
}

export interface BuildScene {
  path: string;
  enabled: boolean;
  guid: string | null;
  index: number;
}

const REQUIRED_DIRS = ['Assets', 'ProjectSettings'];

export function validateUnityProject(root: string, logger?: Logger): UnityProjectInfo {
  const warnings: string[] = [];

  for (const dir of REQUIRED_DIRS) {
    if (!existsSync(join(root, dir))) {
      throw new IntakeError(`Not a Unity project: missing "${dir}/" in ${root}`, {
        hint:
          'The repository must contain the complete Unity project (Assets/, ProjectSettings/, ' +
          'Packages/, .meta files). Check whether the project lives in a subdirectory and pass it explicitly.',
      });
    }
  }

  if (!existsSync(join(root, 'Packages'))) {
    warnings.push('Packages/ is missing - package-level risks cannot be assessed.');
  }

  const unityVersion = readProjectVersion(root);
  const settings = readProjectSettings(root);
  const buildScenes = readBuildScenes(root);
  const packages = readPackages(root);
  const assetsDir = join(root, 'Assets');
  const { assetCount, metaFileCount } = countAssets(assetsDir);

  if (metaFileCount === 0) {
    warnings.push(
      '.meta files are absent - import settings (texture size, Read/Write, compression) cannot be ' +
        'analyzed. This removes the highest-value class of static OOM findings.',
    );
  }

  const addressableGroupFiles = findAddressableGroups(root);
  const usesAddressables =
    addressableGroupFiles.length > 0 || Object.keys(packages).some((p) => p.includes('addressables'));

  if (buildScenes.length === 0) {
    warnings.push('No scenes found in Build Settings - scene analysis will be limited.');
  }

  logger?.info('Unity project validated', {
    unityVersion: unityVersion ?? 'unknown',
    scenes: buildScenes.length,
    metaFiles: metaFileCount,
    addressables: usesAddressables,
  });

  return {
    root,
    valid: true,
    unityVersion,
    scriptingBackend: settings.scriptingBackend,
    companyName: settings.companyName,
    productName: settings.productName,
    bundleIdentifier: settings.bundleIdentifier,
    buildScenes,
    packages,
    usesAddressables,
    addressableGroupFiles,
    hasMetaFiles: metaFileCount > 0,
    metaFileCount,
    assetCount,
    warnings,
  };
}

/**
 * Is this folder a Unity project, and what is in it?
 *
 * Deliberately cheap: it stats a handful of paths and reads four small files.
 * `validateUnityProject` counts every asset and `.meta` file, which on a real
 * project is tens of thousands of stat calls - far too slow to run while the
 * operator is still typing a path into the console. This answers only the
 * question the console asks ("did they point at the right folder?") and throws
 * nothing, because a half-typed path is the normal case rather than an error.
 */
export function probeUnityProject(root: string): UnityProjectProbe {
  const blank: UnityProjectProbe = {
    valid: false,
    reason: null,
    unityVersion: null,
    scriptingBackend: null,
    productName: null,
    sceneCount: 0,
    usesAddressables: false,
    hasPackages: false,
  };

  if (!root.trim()) return blank;

  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    return { ...blank, reason: 'That folder does not exist.' };
  }
  if (!isDirectory) return { ...blank, reason: 'That is a file, not a folder.' };

  const missing = REQUIRED_DIRS.filter((dir) => !existsSync(join(root, dir)));
  if (missing.length > 0) {
    return {
      ...blank,
      reason:
        `Not a Unity project: no ${missing.map((d) => `${d}/`).join(' or ')}. ` +
        'Pick the folder that contains Assets/ and ProjectSettings/ - on many repositories ' +
        'the project sits in a subfolder.',
    };
  }

  const settings = readProjectSettings(root);
  const packages = readPackages(root);

  return {
    valid: true,
    reason: null,
    unityVersion: readProjectVersion(root),
    scriptingBackend: settings.scriptingBackend,
    productName: settings.productName,
    sceneCount: readBuildScenes(root).filter((scene) => scene.enabled).length,
    // The full validation also looks for group assets on disk; the package
    // dependency is enough to tell the operator Addressables are in play.
    usesAddressables: Object.keys(packages).some((name) => name.includes('addressables')),
    hasPackages: Object.keys(packages).length > 0,
  };
}

function readProjectVersion(root: string): string | null {
  const file = join(root, 'ProjectSettings', 'ProjectVersion.txt');
  if (!existsSync(file)) return null;
  const match = /m_EditorVersion:\s*(\S+)/.exec(readFileSync(file, 'utf8'));
  return match?.[1] ?? null;
}

interface ProjectSettingsSummary {
  scriptingBackend: string | null;
  companyName: string | null;
  productName: string | null;
  bundleIdentifier: string | null;
}

/**
 * ProjectSettings.asset is Unity YAML; we read it with targeted regexes rather
 * than a full YAML parse because the file uses editor-only tags and we only
 * need a handful of scalars.
 */
function readProjectSettings(root: string): ProjectSettingsSummary {
  const file = join(root, 'ProjectSettings', 'ProjectSettings.asset');
  const empty: ProjectSettingsSummary = {
    scriptingBackend: null,
    companyName: null,
    productName: null,
    bundleIdentifier: null,
  };
  if (!existsSync(file)) return empty;
  const text = readFileSync(file, 'utf8');

  // scriptingBackend is a map keyed by build target: `Android: 1` (1 = IL2CPP).
  const backendBlock = /scriptingBackend:\s*\n((?:\s+\w+:\s*\d+\n)+)/.exec(text);
  let scriptingBackend: string | null = null;
  if (backendBlock?.[1]) {
    const android = /Android:\s*(\d+)/.exec(backendBlock[1]);
    if (android?.[1]) scriptingBackend = android[1] === '1' ? 'IL2CPP' : 'Mono';
  }

  return {
    scriptingBackend,
    companyName: matchScalar(text, 'companyName'),
    productName: matchScalar(text, 'productName'),
    bundleIdentifier: /applicationIdentifier:[\s\S]*?Android:\s*(\S+)/.exec(text)?.[1]?.trim() ?? null,
  };
}

function matchScalar(text: string, key: string): string | null {
  const m = new RegExp(String.raw`^\s*${key}:\s*(.+)$`, 'm').exec(text);
  return m?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
}

/**
 * EditorBuildSettings.asset lists scenes as:
 *   - enabled: 1
 *     path: Assets/Scenes/Main.unity
 *     guid: 1234...
 */
export function readBuildScenes(root: string): BuildScene[] {
  const file = join(root, 'ProjectSettings', 'EditorBuildSettings.asset');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const scenes: BuildScene[] = [];
  const entryRe = /-\s+enabled:\s*(\d)\s*\n\s*path:\s*(.+?)\s*\n\s*guid:\s*([0-9a-fA-F]+)?/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = entryRe.exec(text)) !== null) {
    const path = match[2]?.trim();
    if (!path) continue;
    scenes.push({
      path,
      enabled: match[1] === '1',
      guid: match[3] ?? null,
      index: index++,
    });
  }
  return scenes;
}

function readPackages(root: string): Record<string, string> {
  const file = join(root, 'Packages', 'manifest.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return parsed.dependencies ?? {};
  } catch {
    return {};
  }
}

function findAddressableGroups(root: string): string[] {
  const dir = join(root, 'Assets', 'AddressableAssetsData');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  walk(
    dir,
    (file) => {
      if (file.endsWith('.asset')) out.push(relative(root, file).split(sep).join('/'));
    },
    3,
  );
  return out;
}

function countAssets(assetsDir: string): { assetCount: number; metaFileCount: number } {
  let assetCount = 0;
  let metaFileCount = 0;
  walk(assetsDir, (file) => {
    if (file.endsWith('.meta')) metaFileCount++;
    else assetCount++;
  });
  return { assetCount, metaFileCount };
}

/** Bounded-depth directory walk that skips the usual generated folders. */
export function walk(dir: string, onFile: (path: string) => void, maxDepth = 64, depth = 0): void {
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, onFile, maxDepth, depth + 1);
    else onFile(full);
  }
}

export const SKIP_DIRS = new Set([
  '.git',
  'Library',
  'Temp',
  'Obj',
  'obj',
  'Build',
  'Builds',
  'Logs',
  'UserSettings',
  'node_modules',
  '.vs',
  '.idea',
  '.gradle',
]);
