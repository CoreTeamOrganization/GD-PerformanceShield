/**
 * Scene and prefab indexing.
 *
 * Answers "what does this scene pull into memory when it loads?" by collecting
 * the asset GUIDs each scene references and resolving them against the asset
 * index. That gives a per-scene memory estimate, which is what makes a level
 * load spike explainable rather than merely visible.
 *
 * Extraction is regex-based over the raw YAML text. Full document parsing of a
 * 40 MB scene is slow and unnecessary: references have a fixed shape
 * (`{fileID: N, guid: <32 hex>, type: N}`) and object headers are one line each.
 */
import { readFileSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';

import type { Logger } from '../core/logger.js';
import { MB } from '../core/types.js';
import { walk } from '../intake/unityProject.js';
import type { AssetIndex, AssetRecord } from './assetIndex.js';
import { UNITY_CLASS } from './unityYaml.js';

export interface SceneRecord {
  path: string;
  relPath: string;
  name: string;
  kind: 'scene' | 'prefab';
  fileSizeBytes: number;
  /** Whether the scene is in Build Settings, and its build index. */
  inBuild: boolean;
  buildIndex: number | null;
  enabledInBuild: boolean;
  objectCount: number;
  /** Object counts keyed by Unity class id. */
  classCounts: Record<number, number>;
  referencedGuids: string[];
  /** Assets resolved from `referencedGuids`. */
  referencedAssets: AssetRecord[];
  /** Sum of estimated runtime memory of the assets this scene references. */
  estimatedAssetBytes: number;
  /** True when the file was too large to scan and numbers are absent. */
  truncated: boolean;
}

export interface SceneIndex {
  scenes: SceneRecord[];
  prefabs: SceneRecord[];
  byPath: Map<string, SceneRecord>;
  scannedInMs: number;
}

export interface BuildSceneIndexOptions {
  projectRoot: string;
  assets: AssetIndex;
  /** Build Settings scenes, so we can flag which are actually shipped. */
  buildScenes: Array<{ path: string; enabled: boolean; index: number }>;
  logger?: Logger;
  maxFileBytes?: number;
  maxPrefabs?: number;
}

const GUID_RE = /guid:\s*([0-9a-f]{32})/g;
const OBJECT_HEADER_RE = /^---\s*!u!(\d+)\s*&\d+/gm;

export function buildSceneIndex(opts: BuildSceneIndexOptions): SceneIndex {
  const started = Date.now();
  const maxFileBytes = opts.maxFileBytes ?? 64 * MB;
  const maxPrefabs = opts.maxPrefabs ?? 4000;

  const scenes: SceneRecord[] = [];
  const prefabs: SceneRecord[] = [];
  const byPath = new Map<string, SceneRecord>();

  const buildLookup = new Map(
    opts.buildScenes.map((s) => [normalize(s.path), s]),
  );

  walk(opts.projectRoot, (filePath) => {
    const isScene = filePath.endsWith('.unity');
    const isPrefab = filePath.endsWith('.prefab');
    if (!isScene && !isPrefab) return;
    if (isPrefab && prefabs.length >= maxPrefabs) return;

    const relPath = normalize(relative(opts.projectRoot, filePath).split(sep).join('/'));
    const build = buildLookup.get(relPath);

    let fileSizeBytes = 0;
    try {
      fileSizeBytes = statSync(filePath).size;
    } catch {
      return;
    }

    const record: SceneRecord = {
      path: filePath,
      relPath,
      name: relPath.split('/').pop() ?? relPath,
      kind: isScene ? 'scene' : 'prefab',
      fileSizeBytes,
      inBuild: Boolean(build),
      buildIndex: build?.index ?? null,
      enabledInBuild: build?.enabled ?? false,
      objectCount: 0,
      classCounts: {},
      referencedGuids: [],
      referencedAssets: [],
      estimatedAssetBytes: 0,
      truncated: fileSizeBytes > maxFileBytes,
    };

    if (!record.truncated) {
      try {
        analyzeFile(readFileSync(filePath, 'utf8'), record, opts.assets);
      } catch {
        record.truncated = true;
      }
    }

    if (isScene) scenes.push(record);
    else prefabs.push(record);
    byPath.set(relPath, record);
  });

  const scannedInMs = Date.now() - started;
  opts.logger?.info('Scene index built', {
    scenes: scenes.length,
    prefabs: prefabs.length,
    ms: scannedInMs,
  });

  return { scenes, prefabs, byPath, scannedInMs };
}

function analyzeFile(text: string, record: SceneRecord, assets: AssetIndex): void {
  const classCounts: Record<number, number> = {};
  let objectCount = 0;

  OBJECT_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OBJECT_HEADER_RE.exec(text)) !== null) {
    const classId = Number(m[1]);
    classCounts[classId] = (classCounts[classId] ?? 0) + 1;
    objectCount++;
  }

  const guids = new Set<string>();
  GUID_RE.lastIndex = 0;
  while ((m = GUID_RE.exec(text)) !== null) {
    if (m[1]) guids.add(m[1]);
  }

  const referencedAssets: AssetRecord[] = [];
  let estimatedAssetBytes = 0;
  for (const guid of guids) {
    const asset = assets.byGuid.get(guid);
    if (!asset) continue;
    referencedAssets.push(asset);
    estimatedAssetBytes += asset.estimate?.bytes ?? 0;
  }

  record.objectCount = objectCount;
  record.classCounts = classCounts;
  record.referencedGuids = [...guids];
  record.referencedAssets = referencedAssets;
  record.estimatedAssetBytes = estimatedAssetBytes;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Convenience: how many objects of a given Unity class a scene contains. */
export function countOfClass(record: SceneRecord, classId: number): number {
  return record.classCounts[classId] ?? 0;
}

export { UNITY_CLASS };
