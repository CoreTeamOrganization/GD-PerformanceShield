/**
 * Operator console asset loading.
 *
 * The console has to work in three situations, and where its files live differs
 * in each:
 *
 *   dev   (`tsx src/cli`)   -> src/ui/ on disk
 *   built (`node dist/cli`) -> dist/ui/ on disk
 *   exe   (single binary)   -> embedded in the executable as SEA assets
 *
 * This module hides that difference so the server just asks for a file by name.
 * Assets are read once and cached: in the exe they are already in memory, and on
 * disk they are static for the life of the process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../core/env.js';

/** Files that make up the console. Also the manifest the exe build embeds. */
export const UI_FILES = ['index.html', 'app.js', 'naming.js', 'chart.js', 'styles.css'] as const;
export type UiFile = (typeof UI_FILES)[number];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export interface UiAsset {
  body: Buffer;
  contentType: string;
}

const cache = new Map<string, UiAsset>();

/**
 * `node:sea` exists only on Node 20.12+/21.7+, and `getRawAsset` throws when the
 * process is not a single executable - so both are probed defensively rather
 * than assumed.
 */
interface SeaModule {
  isSea(): boolean;
  getRawAsset(key: string): ArrayBuffer;
}

let seaModule: SeaModule | null | undefined;

/**
 * Resolve `node:sea` in a way that survives being bundled to CommonJS.
 *
 * `process.getBuiltinModule` is tried first because it works identically in ESM
 * and CJS. `createRequire(import.meta.url)` is the fallback for Node versions
 * without it (< 22.3), and is only reachable from a genuine ESM runtime -
 * esbuild empties `import.meta.url` in a CJS bundle, which is exactly the case
 * the first branch already covers.
 */
function sea(): SeaModule | null {
  if (seaModule !== undefined) return seaModule;
  seaModule = null;

  const getBuiltinModule = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;

  if (typeof getBuiltinModule === 'function') {
    try {
      seaModule = getBuiltinModule('node:sea') as SeaModule;
      return seaModule;
    } catch {
      /* fall through */
    }
  }

  try {
    const url = import.meta.url;
    if (url) seaModule = createRequire(url)('node:sea') as SeaModule;
  } catch {
    seaModule = null;
  }
  return seaModule;
}

export function isPackagedExecutable(): boolean {
  try {
    return sea()?.isSea() ?? false;
  } catch {
    return false;
  }
}

/**
 * Locate the on-disk UI directory.
 *
 * Returns null when running as an executable (assets are embedded instead), and
 * also when bundled to CommonJS, where `import.meta.url` is empty and there is
 * no module directory to resolve against.
 */
export function resolveUiDir(): string | null {
  if (isPackagedExecutable()) return null;

  // The desktop app ships the console inside its resources and points here,
  // because the module path inside an asar archive tells us nothing useful.
  const override = env('UI_DIR');
  if (override && existsSync(join(override, 'index.html'))) return override;

  const moduleUrl = import.meta.url;
  if (!moduleUrl) return null;

  let here: string;
  try {
    here = dirname(fileURLToPath(moduleUrl));
  } catch {
    return null;
  }

  const candidates = [
    join(here, '..', 'ui'), // dist/server -> dist/ui
    join(here, '..', '..', 'src', 'ui'), // dist/server -> src/ui (dev build in-tree)
  ];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
}

export function readUiAsset(name: string): UiAsset | null {
  const cached = cache.get(name);
  if (cached) return cached;

  if (!(UI_FILES as readonly string[]).includes(name)) return null;

  const body = readEmbedded(name) ?? readFromDisk(name);
  if (!body) return null;

  const extension = name.slice(name.lastIndexOf('.'));
  const asset: UiAsset = {
    body,
    contentType: MIME[extension] ?? 'application/octet-stream',
  };
  cache.set(name, asset);
  return asset;
}

function readEmbedded(name: string): Buffer | null {
  const module = sea();
  if (!module?.isSea()) return null;
  try {
    return Buffer.from(module.getRawAsset(name));
  } catch {
    // An asset missing from the blob is a build error, not a runtime condition;
    // fall through so the caller reports a clear 404 rather than crashing.
    return null;
  }
}

function readFromDisk(name: string): Buffer | null {
  const dir = resolveUiDir();
  if (!dir) return null;
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** True when the console can actually be served. */
export function uiAvailable(): boolean {
  return readUiAsset('index.html') !== null;
}
