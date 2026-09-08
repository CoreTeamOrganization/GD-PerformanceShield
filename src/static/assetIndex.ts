/**
 * Step 9 - Asset Analysis.
 *
 * Builds an index of every asset in the project together with its import
 * settings and an estimate of its runtime memory cost.
 *
 * On estimates: the exact GPU footprint depends on the format Unity actually
 * picks at build time for the target, which we cannot know from the project
 * alone when the importer is set to Automatic. Estimates are therefore labelled
 * with the assumption used, and rules that fire on them carry a confidence
 * below 1.0. An estimate that is honest about its uncertainty is far more
 * useful to a studio than a precise-looking number that is quietly wrong.
 */
import { statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';

import type { Logger } from '../core/logger.js';
import { MB } from '../core/types.js';
import { walk } from '../intake/unityProject.js';
import { isImageFile, readImageDimensions, type ImageDimensions } from './imageInfo.js';
import { getBool, getNumber, getPath, getString, isRecord, parseMetaFile } from './unityYaml.js';

export type AssetKind =
  | 'texture'
  | 'sprite_atlas'
  | 'model'
  | 'audio'
  | 'render_texture'
  | 'scene'
  | 'prefab'
  | 'material'
  | 'shader'
  | 'script'
  | 'animation'
  | 'font'
  | 'video'
  | 'lightmap'
  | 'other';

export interface TextureImportSettings {
  maxTextureSize: number | null;
  androidMaxTextureSize: number | null;
  /** Effective max size for the Android build. */
  effectiveMaxSize: number | null;
  isReadable: boolean;
  generateMipMaps: boolean;
  npotScale: number | null;
  textureCompression: number | null;
  androidTextureFormat: number | null;
  crunchedCompression: boolean;
  textureType: number | null;
  streamingMipmaps: boolean;
  hasAndroidOverride: boolean;
}

export interface AudioImportSettings {
  /** 0 = Decompress On Load, 1 = Compressed In Memory, 2 = Streaming. */
  loadType: number | null;
  compressionFormat: number | null;
  preloadAudioData: boolean;
  loadInBackground: boolean;
  forceToMono: boolean;
  quality: number | null;
}

export interface ModelImportSettings {
  isReadable: boolean;
  meshCompression: number | null;
  optimizeMesh: boolean;
  importBlendShapes: boolean;
  importAnimation: boolean;
}

export interface MemoryEstimate {
  bytes: number;
  /** Plain-language statement of what the number assumes. */
  assumption: string;
  confidence: number;
}

export interface AssetRecord {
  path: string;
  relPath: string;
  name: string;
  ext: string;
  kind: AssetKind;
  fileSizeBytes: number;
  guid: string | null;
  dimensions?: ImageDimensions;
  texture?: TextureImportSettings;
  audio?: AudioImportSettings;
  model?: ModelImportSettings;
  estimate?: MemoryEstimate;
}

export interface AssetIndex {
  assets: AssetRecord[];
  byKind: Record<AssetKind, AssetRecord[]>;
  byGuid: Map<string, AssetRecord>;
  totals: {
    assetCount: number;
    fileBytes: number;
    estimatedTextureBytes: number;
    estimatedAudioBytes: number;
  };
  /** Assets whose .meta could not be read - reduces confidence downstream. */
  unparsedMetaCount: number;
  /** Editor-only assets excluded because they never reach a player build. */
  editorOnlyExcluded: number;
  scannedInMs: number;
}

const EXT_KIND: Array<[RegExp, AssetKind]> = [
  [/\.(png|jpg|jpeg|tga|psd|bmp|gif|tif|tiff|exr|webp)$/i, 'texture'],
  [/\.spriteatlas(v2)?$/i, 'sprite_atlas'],
  [/\.(fbx|obj|dae|blend|3ds|max|ma|mb)$/i, 'model'],
  [/\.(wav|mp3|ogg|aiff|aif|m4a|flac)$/i, 'audio'],
  [/\.rendertexture$/i, 'render_texture'],
  [/\.unity$/i, 'scene'],
  [/\.prefab$/i, 'prefab'],
  [/\.mat$/i, 'material'],
  [/\.(shader|shadergraph|compute)$/i, 'shader'],
  [/\.cs$/i, 'script'],
  [/\.(anim|controller|overridecontroller)$/i, 'animation'],
  [/\.(ttf|otf|fontsettings)$/i, 'font'],
  [/\.(mp4|mov|webm|avi|m4v)$/i, 'video'],
  [/lightmap.*\.(exr|png)$/i, 'lightmap'],
];

/**
 * Unity excludes these folders from player builds, so nothing inside them can
 * occupy memory at runtime. Matching the code index, they are left out entirely
 * rather than reported and then discounted.
 */
const NOT_SHIPPED_PATH = /(^|\/)(Editor|Editor Default Resources|Gizmos)(\/|$)/i;

export function classifyAsset(path: string): AssetKind {
  const name = basename(path);
  if (/lightmap/i.test(name) && /\.(exr|png)$/i.test(name)) return 'lightmap';
  for (const [re, kind] of EXT_KIND) {
    if (re.test(name)) return kind;
  }
  return 'other';
}

export interface BuildIndexOptions {
  projectRoot: string;
  logger?: Logger;
  /** Skip reading dimensions for files above this size to keep scans fast. */
  maxImageBytes?: number;
}

export function buildAssetIndex(opts: BuildIndexOptions): AssetIndex {
  const started = Date.now();
  const { projectRoot, logger } = opts;
  const assetsDir = join(projectRoot, 'Assets');

  const assets: AssetRecord[] = [];
  const byGuid = new Map<string, AssetRecord>();
  let unparsedMetaCount = 0;

  let editorOnlyExcluded = 0;

  walk(assetsDir, (filePath) => {
    if (filePath.endsWith('.meta')) return;

    const relForCheck = relative(projectRoot, filePath).split(sep).join('/');
    if (NOT_SHIPPED_PATH.test(relForCheck)) {
      editorOnlyExcluded++;
      return;
    }

    const kind = classifyAsset(filePath);
    let fileSizeBytes = 0;
    try {
      fileSizeBytes = statSync(filePath).size;
    } catch {
      return;
    }

    const metaPath = `${filePath}.meta`;
    const meta = parseMetaFile(metaPath);
    if (!meta) unparsedMetaCount++;

    const record: AssetRecord = {
      path: filePath,
      relPath: relative(projectRoot, filePath).split(sep).join('/'),
      name: basename(filePath),
      ext: extname(filePath).toLowerCase(),
      kind,
      fileSizeBytes,
      guid: meta ? (getString(meta, 'guid') ?? null) : null,
    };

    if (kind === 'texture' || kind === 'lightmap') {
      if (isImageFile(filePath) && fileSizeBytes <= (opts.maxImageBytes ?? 256 * MB)) {
        const dims = readImageDimensions(filePath);
        if (dims) record.dimensions = dims;
      }
      if (meta) record.texture = readTextureSettings(meta);
      record.estimate = estimateTextureMemory(record);
    } else if (kind === 'audio') {
      if (meta) record.audio = readAudioSettings(meta);
      record.estimate = estimateAudioMemory(record);
    } else if (kind === 'model') {
      if (meta) record.model = readModelSettings(meta);
    }

    assets.push(record);
    if (record.guid) byGuid.set(record.guid, record);
  });

  const byKind = groupByKind(assets);
  const totals = {
    assetCount: assets.length,
    fileBytes: assets.reduce((acc, a) => acc + a.fileSizeBytes, 0),
    estimatedTextureBytes: sumEstimates(byKind.texture) + sumEstimates(byKind.lightmap),
    estimatedAudioBytes: sumEstimates(byKind.audio),
  };

  const scannedInMs = Date.now() - started;
  logger?.info('Asset index built', {
    assets: assets.length,
    textures: byKind.texture.length,
    editorOnlyExcluded,
    estimatedTextureMB: Math.round(totals.estimatedTextureBytes / MB),
    ms: scannedInMs,
  });

  return { assets, byKind, byGuid, totals, unparsedMetaCount, editorOnlyExcluded, scannedInMs };
}

function sumEstimates(records: AssetRecord[] | undefined): number {
  return (records ?? []).reduce((acc, r) => acc + (r.estimate?.bytes ?? 0), 0);
}

function groupByKind(assets: AssetRecord[]): Record<AssetKind, AssetRecord[]> {
  const empty: Record<AssetKind, AssetRecord[]> = {
    texture: [],
    sprite_atlas: [],
    model: [],
    audio: [],
    render_texture: [],
    scene: [],
    prefab: [],
    material: [],
    shader: [],
    script: [],
    animation: [],
    font: [],
    video: [],
    lightmap: [],
    other: [],
  };
  for (const asset of assets) empty[asset.kind].push(asset);
  return empty;
}

// ---------------------------------------------------------------------------
// Import settings
// ---------------------------------------------------------------------------

function readTextureSettings(meta: Record<string, unknown>): TextureImportSettings {
  const importer = getPath(meta, 'TextureImporter');
  const platformSettings = getPath(importer, 'platformSettings');
  const android = Array.isArray(platformSettings)
    ? platformSettings.find((p) => isRecord(p) && p['buildTarget'] === 'Android')
    : undefined;

  const defaultMax = getNumber(importer, 'maxTextureSize');
  const androidMax = android ? getNumber(android, 'maxTextureSize') : null;

  return {
    maxTextureSize: defaultMax,
    androidMaxTextureSize: androidMax,
    effectiveMaxSize: androidMax ?? defaultMax,
    isReadable: getBool(importer, 'isReadable') ?? false,
    generateMipMaps: getBool(importer, 'mipmaps.enableMipMap') ?? false,
    npotScale: getNumber(importer, 'npotScale'),
    textureCompression: android
      ? getNumber(android, 'textureCompression')
      : getNumber(importer, 'textureCompression'),
    androidTextureFormat: android ? getNumber(android, 'textureFormat') : null,
    crunchedCompression: android
      ? (getBool(android, 'crunchedCompression') ?? false)
      : (getBool(importer, 'crunchedCompression') ?? false),
    textureType: getNumber(importer, 'textureType'),
    streamingMipmaps: getBool(importer, 'streamingMipmaps') ?? false,
    hasAndroidOverride: Boolean(android && getBool(android, 'overridden')),
  };
}

function readAudioSettings(meta: Record<string, unknown>): AudioImportSettings {
  const importer = getPath(meta, 'AudioImporter');
  const defaultSettings = getPath(importer, 'defaultSettings');
  return {
    loadType: getNumber(defaultSettings, 'loadType'),
    compressionFormat: getNumber(defaultSettings, 'compressionFormat'),
    preloadAudioData:
      getBool(defaultSettings, 'preloadAudioData') ?? getBool(importer, 'preloadAudioData') ?? false,
    loadInBackground: getBool(importer, 'loadInBackground') ?? false,
    forceToMono: getBool(importer, 'forceToMono') ?? false,
    quality: getNumber(defaultSettings, 'quality'),
  };
}

function readModelSettings(meta: Record<string, unknown>): ModelImportSettings {
  const importer = getPath(meta, 'ModelImporter');
  return {
    isReadable: getBool(importer, 'isReadable') ?? false,
    meshCompression: getNumber(importer, 'meshCompression'),
    optimizeMesh: getBool(importer, 'optimizeMeshForGPU') ?? getBool(importer, 'optimizeMesh') ?? false,
    importBlendShapes: getBool(importer, 'importBlendShapes') ?? false,
    importAnimation: getBool(importer, 'importAnimation') ?? false,
  };
}

// ---------------------------------------------------------------------------
// Memory estimation
// ---------------------------------------------------------------------------

/** TextureImporterFormat enum value -> bits per pixel. */
const FORMAT_BPP: Record<number, { bpp: number; name: string }> = {
  1: { bpp: 8, name: 'Alpha8' },
  3: { bpp: 24, name: 'RGB24' },
  4: { bpp: 32, name: 'RGBA32' },
  5: { bpp: 32, name: 'ARGB32' },
  7: { bpp: 16, name: 'RGB16' },
  10: { bpp: 4, name: 'DXT1' },
  12: { bpp: 8, name: 'DXT5' },
  13: { bpp: 16, name: 'RGBA16' },
  34: { bpp: 4, name: 'ETC_RGB4' },
  45: { bpp: 4, name: 'ETC2_RGB4' },
  46: { bpp: 4, name: 'ETC2_RGB4_PUNCHTHROUGH_ALPHA' },
  47: { bpp: 8, name: 'ETC2_RGBA8' },
  48: { bpp: 8, name: 'ASTC_4x4' },
  49: { bpp: 5.12, name: 'ASTC_5x5' },
  50: { bpp: 3.56, name: 'ASTC_6x6' },
  51: { bpp: 2, name: 'ASTC_8x8' },
  52: { bpp: 1.28, name: 'ASTC_10x10' },
  53: { bpp: 0.89, name: 'ASTC_12x12' },
};

/** Mipmaps add a third again on top of the base level. */
const MIPMAP_MULTIPLIER = 4 / 3;

export function estimateTextureMemory(record: AssetRecord): MemoryEstimate | undefined {
  const dims = record.dimensions;
  if (!dims) return undefined;

  const settings = record.texture;
  const maxSize = settings?.effectiveMaxSize ?? 2048;

  // Unity scales down so the longest edge fits maxTextureSize, preserving ratio.
  const scale = Math.min(1, maxSize / Math.max(dims.width, dims.height));
  const width = Math.max(1, Math.round(dims.width * scale));
  const height = Math.max(1, Math.round(dims.height * scale));

  const { bpp, name, confidence } = resolveBpp(settings);
  const mipMultiplier = settings?.generateMipMaps ? MIPMAP_MULTIPLIER : 1;
  const bytes = Math.round((width * height * bpp * mipMultiplier) / 8);

  const scaleNote =
    scale < 1
      ? `source ${dims.width}x${dims.height} downscaled to ${width}x${height} by maxTextureSize ${maxSize}`
      : `${width}x${height}`;

  return {
    bytes,
    assumption: `${scaleNote}, ${name} (${bpp} bpp)${settings?.generateMipMaps ? ' with mipmaps' : ''}`,
    confidence,
  };
}

/**
 * Resolve bits-per-pixel from the importer settings.
 *
 * `Automatic` is the common case and genuinely ambiguous - Unity picks per
 * platform capability at build time - so we assume the usual Android outcome
 * and lower the confidence accordingly.
 */
function resolveBpp(settings: TextureImportSettings | undefined): {
  bpp: number;
  name: string;
  confidence: number;
} {
  const format = settings?.androidTextureFormat;
  if (format !== null && format !== undefined && format >= 0) {
    const known = FORMAT_BPP[format];
    if (known) return { ...known, confidence: 0.9 };
  }

  // textureCompression: 0 = Uncompressed, 1 = Normal Quality, 2 = High Quality.
  if (settings?.textureCompression === 0) {
    return { bpp: 32, name: 'uncompressed RGBA32 (compression disabled)', confidence: 0.85 };
  }

  return {
    bpp: 8,
    name: 'assumed ASTC 4x4 / ETC2 RGBA8',
    confidence: 0.55,
  };
}

/**
 * Audio memory.
 *
 * Decompress On Load is the setting that hurts: the clip is expanded to 16-bit
 * PCM in RAM. Compressed In Memory keeps the encoded bytes; Streaming keeps
 * only a small buffer.
 */
export function estimateAudioMemory(record: AssetRecord): MemoryEstimate | undefined {
  const settings = record.audio;
  if (!settings) {
    return {
      bytes: record.fileSizeBytes,
      assumption: 'import settings unavailable; assumed the encoded file size',
      confidence: 0.3,
    };
  }

  switch (settings.loadType) {
    case 0: {
      // Decompressed to PCM. Compressed sources expand substantially; a 10x
      // factor is the usual order of magnitude for Vorbis at default quality.
      const expansion = settings.compressionFormat === 0 ? 1 : 10;
      return {
        bytes: record.fileSizeBytes * expansion,
        assumption:
          settings.compressionFormat === 0
            ? 'Decompress On Load, already PCM'
            : 'Decompress On Load, assumed ~10x expansion to 16-bit PCM',
        confidence: settings.compressionFormat === 0 ? 0.8 : 0.5,
      };
    }
    case 1:
      return {
        bytes: record.fileSizeBytes,
        assumption: 'Compressed In Memory; encoded bytes stay resident',
        confidence: 0.8,
      };
    case 2:
      return {
        bytes: Math.min(record.fileSizeBytes, 256 * 1024),
        assumption: 'Streaming; only a decode buffer is resident',
        confidence: 0.75,
      };
    default:
      return {
        bytes: record.fileSizeBytes,
        assumption: 'load type unknown; assumed the encoded file size',
        confidence: 0.4,
      };
  }
}

export const AUDIO_LOAD_TYPE_NAMES: Record<number, string> = {
  0: 'Decompress On Load',
  1: 'Compressed In Memory',
  2: 'Streaming',
};
