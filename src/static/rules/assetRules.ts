/**
 * Static rules 1, 2, 3 and 11 from Step 8, plus closely-related asset checks.
 *
 * These are the highest-value rules in the tool: import settings are where most
 * Unity mobile OOM problems are actually created, and they are invisible in C#.
 */
import { findingId } from '../../core/ids.js';
import { MB, type Evidence, type Finding, type Severity } from '../../core/types.js';
import { AUDIO_LOAD_TYPE_NAMES, type AssetRecord } from '../assetIndex.js';
import { getBool, getNumber, readUnityDocuments } from '../unityYaml.js';
import { weakestDeviceRam, type StaticRule, type StaticRuleContext } from '../ruleEngine.js';

const fmt = (bytes: number): string =>
  bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(2)} GB` : `${(bytes / MB).toFixed(1)} MB`;

/** Rule 1 - textures whose runtime footprint is large. */
export const oversizedTextureRule: StaticRule = {
  id: 'UNITY.TEXTURE.OVERSIZED',
  title: 'Oversized textures',
  category: 'import_setting',
  rationale:
    'A texture occupies its decoded size in memory for as long as anything references it. A single ' +
    '4096x4096 uncompressed texture costs 64 MB - more than the entire budget some low-end devices ' +
    'have left for the game after the OS and the engine.',
  run(ctx: StaticRuleContext): Finding[] {
    const ram = weakestDeviceRam(ctx);
    // Relative to the weakest device when we know it, otherwise a fixed floor.
    const singleTextureLimit = ram ? Math.max(8 * MB, ram * 0.01) : 12 * MB;

    const heavy = ctx.assets.byKind.texture
      .filter((a) => (a.estimate?.bytes ?? 0) >= singleTextureLimit)
      .sort((a, b) => (b.estimate?.bytes ?? 0) - (a.estimate?.bytes ?? 0));

    if (heavy.length === 0) return [];

    const findings: Finding[] = [];

    // One finding per genuinely large texture, capped so the report stays
    // readable; the rest are summarised in a single aggregate finding.
    const individual = heavy.slice(0, 15);
    for (const asset of individual) {
      const bytes = asset.estimate?.bytes ?? 0;
      const dims = asset.dimensions;
      const severity: Severity = bytes > 48 * MB ? 'critical' : bytes > 24 * MB ? 'high' : 'medium';

      findings.push({
        ruleId: 'UNITY.TEXTURE.OVERSIZED',
        id: findingId('UNITY.TEXTURE.OVERSIZED', asset.relPath),
        source: 'static',
        title: `Texture "${asset.name}" costs about ${fmt(bytes)} in memory`,
        description:
          `${asset.relPath} is imported at up to ${asset.texture?.effectiveMaxSize ?? 'the default'} px` +
          (dims ? ` from a ${dims.width}x${dims.height} source` : '') +
          `, giving an estimated runtime cost of ${fmt(bytes)}. ${asset.estimate?.assumption ?? ''}`,
        severity,
        confidence: asset.estimate?.confidence ?? 0.6,
        recommendation:
          `Lower Max Size for the Android platform (halving it quarters the memory), confirm compression ` +
          `is enabled, and disable mipmaps if this texture is only ever shown at a fixed size in UI.`,
        evidence: [
          {
            kind: 'asset',
            summary: `${asset.relPath}`,
            path: asset.relPath,
            data: {
              sourceWidth: dims?.width,
              sourceHeight: dims?.height,
              maxTextureSize: asset.texture?.effectiveMaxSize,
              mipmaps: asset.texture?.generateMipMaps,
              androidOverride: asset.texture?.hasAndroidOverride,
              estimatedBytes: bytes,
              fileSizeBytes: asset.fileSizeBytes,
            },
          },
          {
            kind: 'setting',
            summary: asset.estimate?.assumption ?? 'format assumption unavailable',
          },
        ],
        estimatedBytes: bytes,
        subject: asset.relPath,
        tags: ['texture', 'import', 'memory'],
      });
    }

    if (heavy.length > individual.length) {
      const rest = heavy.slice(individual.length);
      const restBytes = rest.reduce((acc, a) => acc + (a.estimate?.bytes ?? 0), 0);
      findings.push({
        ruleId: 'UNITY.TEXTURE.OVERSIZED_GROUP',
        id: findingId('UNITY.TEXTURE.OVERSIZED_GROUP', 'aggregate'),
        source: 'static',
        title: `${rest.length} further large textures totalling about ${fmt(restBytes)}`,
        description:
          `Beyond the individually listed textures, ${rest.length} more each exceed ` +
          `${fmt(singleTextureLimit)} of estimated runtime memory, ${fmt(restBytes)} in total.`,
        severity: restBytes > 300 * MB ? 'high' : 'medium',
        confidence: 0.6,
        recommendation:
          'Apply an Android platform override with a lower Max Size across these folders rather than ' +
          'per-asset. A project-wide preset is usually the fastest large win.',
        evidence: rest.slice(0, 30).map((a) => ({
          kind: 'asset' as const,
          summary: `${a.relPath} - ${fmt(a.estimate?.bytes ?? 0)}`,
          path: a.relPath,
          data: { estimatedBytes: a.estimate?.bytes },
        })),
        estimatedBytes: restBytes,
        subject: 'texture budget',
        tags: ['texture', 'import', 'aggregate'],
      });
    }

    return findings;
  },
};

/** Rule 2 - Read/Write Enabled doubles a texture's cost. */
export const readWriteEnabledRule: StaticRule = {
  id: 'UNITY.TEXTURE.READ_WRITE_ENABLED',
  title: 'Read/Write Enabled textures and meshes',
  category: 'import_setting',
  rationale:
    'Read/Write Enabled keeps a second, uncompressed copy in CPU memory in addition to the GPU copy. ' +
    'It is needed only when scripts call GetPixels/GetTriangles at runtime, and is very often left on ' +
    'by accident.',
  run(ctx: StaticRuleContext): Finding[] {
    const textures = ctx.assets.byKind.texture.filter((a) => a.texture?.isReadable);
    const models = ctx.assets.byKind.model.filter((a) => a.model?.isReadable);
    if (textures.length === 0 && models.length === 0) return [];

    const findings: Finding[] = [];

    if (textures.length > 0) {
      // The CPU copy is uncompressed RGBA32, so it is usually larger than the
      // GPU copy we already estimated.
      const extraBytes = textures.reduce((acc, a) => acc + cpuCopyBytes(a), 0);
      findings.push({
        ruleId: 'UNITY.TEXTURE.READ_WRITE_ENABLED',
        id: findingId('UNITY.TEXTURE.READ_WRITE_ENABLED', 'textures'),
        source: 'static',
        title: `${textures.length} texture(s) have Read/Write Enabled, costing roughly ${fmt(extraBytes)} extra`,
        description:
          `Read/Write Enabled keeps an uncompressed CPU-side copy alongside the GPU copy. Across ` +
          `${textures.length} textures this adds an estimated ${fmt(extraBytes)} of resident memory that ` +
          'is pure overhead unless a script actually reads the pixels.',
        severity: extraBytes > 100 * MB ? 'critical' : extraBytes > 30 * MB ? 'high' : 'medium',
        confidence: 0.85,
        recommendation:
          'Turn Read/Write Enabled off for every texture that is not read by script at runtime. If a ' +
          'script needs pixel data, read it once at build time or use AsyncGPUReadback instead.',
        evidence: textures.slice(0, 25).map((a) => ({
          kind: 'setting' as const,
          summary: `${a.relPath} - Read/Write Enabled, +${fmt(cpuCopyBytes(a))} CPU copy`,
          path: a.relPath,
          data: {
            estimatedCpuCopyBytes: cpuCopyBytes(a),
            width: a.dimensions?.width,
            height: a.dimensions?.height,
          },
        })),
        estimatedBytes: extraBytes,
        subject: 'read/write textures',
        tags: ['texture', 'import', 'readwrite'],
      });
    }

    if (models.length > 0) {
      findings.push({
        ruleId: 'UNITY.MESH.READ_WRITE_ENABLED',
        id: findingId('UNITY.MESH.READ_WRITE_ENABLED', 'models'),
        source: 'static',
        title: `${models.length} model(s) have Read/Write Enabled`,
        description:
          'Read/Write Enabled on a model keeps the mesh data in CPU memory after it has been uploaded ' +
          'to the GPU, doubling its cost. It is required only for runtime mesh reads, collider baking ' +
          'from script, or CPU skinning.',
        severity: models.length > 20 ? 'high' : 'medium',
        confidence: 0.8,
        recommendation:
          'Disable Read/Write Enabled on models that are only rendered. Keep it only where a script ' +
          'reads vertices or a MeshCollider is created at runtime.',
        evidence: models.slice(0, 25).map((a) => ({
          kind: 'setting' as const,
          summary: `${a.relPath} - Read/Write Enabled`,
          path: a.relPath,
          data: { fileSizeBytes: a.fileSizeBytes },
        })),
        subject: 'read/write meshes',
        tags: ['mesh', 'import', 'readwrite'],
      });
    }

    return findings;
  },
};

function cpuCopyBytes(asset: AssetRecord): number {
  const dims = asset.dimensions;
  const maxSize = asset.texture?.effectiveMaxSize ?? 2048;
  if (!dims) return asset.estimate?.bytes ?? 0;
  const scale = Math.min(1, maxSize / Math.max(dims.width, dims.height));
  const w = Math.max(1, Math.round(dims.width * scale));
  const h = Math.max(1, Math.round(dims.height * scale));
  return w * h * 4; // RGBA32 CPU copy
}

/** Rule 3 - large RenderTextures declared as assets. */
export const largeRenderTextureRule: StaticRule = {
  id: 'UNITY.RENDER_TEXTURE.LARGE',
  title: 'Large RenderTextures',
  category: 'asset',
  rationale:
    'RenderTextures are allocated at full resolution the moment they are created and stay resident. ' +
    'With depth buffers and anti-aliasing a single full-screen RT can cost tens of megabytes, and they ' +
    'are frequently created per-camera or per-effect.',
  run(ctx: StaticRuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const asset of ctx.assets.byKind.render_texture) {
      const meta = readRenderTextureAsset(asset.path);
      const width = getNumber(meta, 'RenderTexture.m_Width') ?? getNumber(meta, 'm_Width');
      const height = getNumber(meta, 'RenderTexture.m_Height') ?? getNumber(meta, 'm_Height');
      const depth = getNumber(meta, 'RenderTexture.m_DepthFormat') ?? getNumber(meta, 'm_DepthFormat') ?? 0;
      const antiAliasing =
        getNumber(meta, 'RenderTexture.m_AntiAliasing') ?? getNumber(meta, 'm_AntiAliasing') ?? 1;
      const mipMap = getBool(meta, 'RenderTexture.m_MipMap') ?? false;

      if (!width || !height) continue;

      // 4 bytes/px colour, plus depth, times MSAA samples.
      const samples = Math.max(1, antiAliasing);
      const depthBytesPerPixel = depth > 0 ? 4 : 0;
      const bytes = Math.round(
        width * height * (4 + depthBytesPerPixel) * samples * (mipMap ? 4 / 3 : 1),
      );

      if (bytes < 8 * MB) continue;

      findings.push({
        ruleId: 'UNITY.RENDER_TEXTURE.LARGE',
        id: findingId('UNITY.RENDER_TEXTURE.LARGE', asset.relPath),
        source: 'static',
        title: `RenderTexture "${asset.name}" costs about ${fmt(bytes)}`,
        description:
          `${asset.relPath} is ${width}x${height}` +
          (samples > 1 ? ` with ${samples}x MSAA` : '') +
          (depth > 0 ? ' and a depth buffer' : '') +
          `, an estimated ${fmt(bytes)} held for as long as the asset is referenced.`,
        severity: bytes > 32 * MB ? 'high' : 'medium',
        confidence: 0.8,
        recommendation:
          'Render at a reduced resolution (half-resolution is usually indistinguishable for blur, ' +
          'reflection and minimap targets), drop MSAA on offscreen targets, and release the target when ' +
          'the effect using it is not active.',
        evidence: [
          {
            kind: 'asset',
            summary: `${asset.relPath} - ${width}x${height}, MSAA ${samples}, depth ${depth > 0 ? 'yes' : 'no'}`,
            path: asset.relPath,
            data: { width, height, antiAliasing: samples, depthFormat: depth, estimatedBytes: bytes },
          },
        ],
        estimatedBytes: bytes,
        subject: asset.relPath,
        tags: ['rendertexture', 'gpu'],
      });
    }

    return findings;
  },
};

function readRenderTextureAsset(path: string): Record<string, unknown> | null {
  // .renderTexture files are Unity YAML documents, not .meta files.
  const docs = readUnityDocuments(path);
  const rt = docs.find((d) => d.typeName === 'RenderTexture');
  return rt ? { RenderTexture: rt.body } : null;
}

/** Rule 11 - audio clips decompressed into RAM. */
export const riskyAudioLoadingRule: StaticRule = {
  id: 'UNITY.AUDIO.DECOMPRESS_ON_LOAD',
  title: 'Risky audio loading settings',
  category: 'import_setting',
  rationale:
    'Decompress On Load expands a clip to 16-bit PCM in RAM - roughly ten times its compressed size for ' +
    'Vorbis. Applied to music or long ambience tracks it is one of the largest single wins available in ' +
    'a mobile memory budget.',
  run(ctx: StaticRuleContext): Finding[] {
    const risky = ctx.assets.byKind.audio.filter((a) => {
      if (!a.audio) return false;
      const isDecompressOnLoad = a.audio.loadType === 0;
      const isLargeFile = a.fileSizeBytes > 512 * 1024;
      return isDecompressOnLoad && isLargeFile;
    });

    const preloaded = ctx.assets.byKind.audio.filter(
      (a) => a.audio?.preloadAudioData && a.fileSizeBytes > 2 * MB,
    );

    const findings: Finding[] = [];

    if (risky.length > 0) {
      const bytes = risky.reduce((acc, a) => acc + (a.estimate?.bytes ?? 0), 0);
      findings.push({
        ruleId: 'UNITY.AUDIO.DECOMPRESS_ON_LOAD',
        id: findingId('UNITY.AUDIO.DECOMPRESS_ON_LOAD', 'clips'),
        source: 'static',
        title: `${risky.length} large audio clip(s) use Decompress On Load (about ${fmt(bytes)})`,
        description:
          `These clips are expanded to uncompressed PCM in memory when loaded, costing an estimated ` +
          `${fmt(bytes)} in total. Decompress On Load is appropriate only for very short, frequently ` +
          'triggered sounds where decode latency matters.',
        severity: bytes > 100 * MB ? 'critical' : bytes > 40 * MB ? 'high' : 'medium',
        confidence: 0.75,
        recommendation:
          'Set music and ambience clips to Streaming, and anything above roughly 200 KB to Compressed ' +
          'In Memory. Reserve Decompress On Load for short one-shot effects.',
        evidence: risky.slice(0, 25).map((a) => ({
          kind: 'setting' as const,
          summary:
            `${a.relPath} - ${AUDIO_LOAD_TYPE_NAMES[a.audio?.loadType ?? -1] ?? 'unknown'}, ` +
            `file ${fmt(a.fileSizeBytes)}, estimated ${fmt(a.estimate?.bytes ?? 0)}`,
          path: a.relPath,
          data: {
            loadType: a.audio?.loadType,
            fileSizeBytes: a.fileSizeBytes,
            estimatedBytes: a.estimate?.bytes,
          },
        })),
        estimatedBytes: bytes,
        subject: 'audio loading',
        tags: ['audio', 'import'],
      });
    }

    if (preloaded.length > 0) {
      findings.push({
        ruleId: 'UNITY.AUDIO.PRELOAD',
        id: findingId('UNITY.AUDIO.PRELOAD', 'preload'),
        source: 'static',
        title: `${preloaded.length} large audio clip(s) have Preload Audio Data enabled`,
        description:
          'Preload Audio Data loads the clip as soon as the scene containing it loads, whether or not it ' +
          'is ever played. On large clips this inflates the load-time peak, which is exactly when memory ' +
          'is tightest.',
        severity: 'medium',
        confidence: 0.7,
        recommendation:
          'Disable Preload Audio Data on large clips and load them on demand, or move them to ' +
          'Addressables so their lifetime is explicit.',
        evidence: preloaded.slice(0, 20).map((a) => ({
          kind: 'setting' as const,
          summary: `${a.relPath} - preloadAudioData enabled, ${fmt(a.fileSizeBytes)}`,
          path: a.relPath,
        })),
        subject: 'audio preload',
        tags: ['audio', 'import', 'preload'],
      });
    }

    return findings;
  },
};

/** Uncompressed textures - a distinct, very common cause of a bloated budget. */
export const uncompressedTextureRule: StaticRule = {
  id: 'UNITY.TEXTURE.UNCOMPRESSED',
  title: 'Uncompressed textures on Android',
  category: 'import_setting',
  rationale:
    'An uncompressed texture costs 32 bits per pixel against 8 or fewer for ASTC/ETC2 - a four-fold or ' +
    'greater difference applied across an entire texture set.',
  run(ctx: StaticRuleContext): Finding[] {
    const uncompressed = ctx.assets.byKind.texture.filter(
      (a) => a.texture?.textureCompression === 0 && (a.estimate?.bytes ?? 0) > 2 * MB,
    );
    if (uncompressed.length === 0) return [];

    const bytes = uncompressed.reduce((acc, a) => acc + (a.estimate?.bytes ?? 0), 0);
    const potentialSaving = bytes * 0.75; // 32 bpp -> 8 bpp

    return [
      {
        ruleId: 'UNITY.TEXTURE.UNCOMPRESSED',
        id: findingId('UNITY.TEXTURE.UNCOMPRESSED', 'group'),
        source: 'static',
        title: `${uncompressed.length} texture(s) ship uncompressed (about ${fmt(bytes)})`,
        description:
          `These textures have compression disabled, costing an estimated ${fmt(bytes)}. Compressing ` +
          `them with ASTC or ETC2 would recover roughly ${fmt(potentialSaving)}.`,
        severity: potentialSaving > 100 * MB ? 'critical' : potentialSaving > 30 * MB ? 'high' : 'medium',
        confidence: 0.8,
        recommendation:
          'Enable compression in the Android platform override. ASTC 6x6 is a good default for most ' +
          'content; use 4x4 only where quality visibly suffers.',
        evidence: uncompressed.slice(0, 25).map((a) => ({
          kind: 'setting' as const,
          summary: `${a.relPath} - compression disabled, ${fmt(a.estimate?.bytes ?? 0)}`,
          path: a.relPath,
          data: { estimatedBytes: a.estimate?.bytes },
        })),
        estimatedBytes: potentialSaving,
        subject: 'texture compression',
        tags: ['texture', 'import', 'compression'],
      },
    ];
  },
};

/** Missing Android platform overrides - the setting most often forgotten. */
export const missingAndroidOverrideRule: StaticRule = {
  id: 'UNITY.TEXTURE.NO_ANDROID_OVERRIDE',
  title: 'Textures without an Android platform override',
  category: 'import_setting',
  rationale:
    'Without an Android override, textures import at the desktop default - typically 2048 px and a ' +
    'format chosen for desktop GPUs. The result is a mobile build carrying desktop-sized textures.',
  run(ctx: StaticRuleContext): Finding[] {
    const candidates = ctx.assets.byKind.texture.filter(
      (a) => !a.texture?.hasAndroidOverride && (a.estimate?.bytes ?? 0) > 4 * MB,
    );
    if (candidates.length < 5) return [];

    const bytes = candidates.reduce((acc, a) => acc + (a.estimate?.bytes ?? 0), 0);

    return [
      {
        ruleId: 'UNITY.TEXTURE.NO_ANDROID_OVERRIDE',
        id: findingId('UNITY.TEXTURE.NO_ANDROID_OVERRIDE', 'group'),
        source: 'static',
        title: `${candidates.length} large texture(s) have no Android platform override`,
        description:
          `These textures fall back to the default platform settings, together costing an estimated ` +
          `${fmt(bytes)}. Android-specific size and format limits are not being applied to them.`,
        severity: bytes > 200 * MB ? 'high' : 'medium',
        confidence: 0.7,
        recommendation:
          'Add an Android override with an appropriate Max Size and ASTC/ETC2 compression. Applying it ' +
          'at folder level via a preset is faster than editing assets individually.',
        evidence: candidates.slice(0, 25).map((a) => ({
          kind: 'setting' as const,
          summary: `${a.relPath} - no Android override, ${fmt(a.estimate?.bytes ?? 0)}`,
          path: a.relPath,
        })),
        estimatedBytes: bytes * 0.5,
        subject: 'android overrides',
        tags: ['texture', 'import', 'android'],
      },
    ];
  },
};

/** Scene-level budget: which scenes pull the most content on load. */
export const heavySceneRule: StaticRule = {
  id: 'UNITY.SCENE.HEAVY',
  title: 'Scenes with a large referenced-asset footprint',
  category: 'scene',
  rationale:
    'Everything a scene references is loaded as the scene loads. A scene whose referenced assets exceed ' +
    'the device budget will spike at load time regardless of how efficient the gameplay code is.',
  run(ctx: StaticRuleContext): Finding[] {
    const ram = weakestDeviceRam(ctx);
    const limit = ram ? ram * 0.15 : 250 * MB;

    const heavy = ctx.scenes.scenes
      .filter((s) => s.estimatedAssetBytes >= limit)
      .sort((a, b) => b.estimatedAssetBytes - a.estimatedAssetBytes)
      .slice(0, 10);

    return heavy.map((scene) => {
      const topAssets = [...scene.referencedAssets]
        .sort((a, b) => (b.estimate?.bytes ?? 0) - (a.estimate?.bytes ?? 0))
        .slice(0, 10);

      const evidence: Evidence[] = [
        {
          kind: 'file',
          summary: `${scene.relPath} references ${scene.referencedAssets.length} indexed assets, about ${fmt(scene.estimatedAssetBytes)}`,
          path: scene.relPath,
          data: {
            objectCount: scene.objectCount,
            inBuild: scene.inBuild,
            buildIndex: scene.buildIndex,
            estimatedAssetBytes: scene.estimatedAssetBytes,
          },
        },
        ...topAssets.map((a) => ({
          kind: 'asset' as const,
          summary: `${a.relPath} - ${fmt(a.estimate?.bytes ?? 0)}`,
          path: a.relPath,
        })),
      ];

      return {
        ruleId: 'UNITY.SCENE.HEAVY',
        id: findingId('UNITY.SCENE.HEAVY', scene.relPath),
        source: 'static' as const,
        title: `Scene "${scene.name}" loads about ${fmt(scene.estimatedAssetBytes)} of assets`,
        description:
          `${scene.relPath} directly references assets with an estimated combined runtime cost of ` +
          `${fmt(scene.estimatedAssetBytes)} across ${scene.objectCount} objects. ` +
          (scene.inBuild
            ? `It is scene index ${scene.buildIndex} in Build Settings.`
            : 'It is not in Build Settings, so it is likely loaded additively or via Addressables.'),
        severity: ram && scene.estimatedAssetBytes > ram * 0.3 ? 'high' : 'medium',
        confidence: 0.6,
        recommendation:
          'Split the scene so that only what the player can currently see is loaded, or move optional ' +
          'content behind Addressables so it can be released. Check whether every referenced variant is ' +
          'actually needed at load time.',
        evidence,
        estimatedBytes: scene.estimatedAssetBytes,
        subject: scene.relPath,
        tags: ['scene', 'load'],
      };
    });
  },
};

export const ASSET_RULES: StaticRule[] = [
  oversizedTextureRule,
  readWriteEnabledRule,
  largeRenderTextureRule,
  riskyAudioLoadingRule,
  uncompressedTextureRule,
  missingAndroidOverrideRule,
  heavySceneRule,
];
