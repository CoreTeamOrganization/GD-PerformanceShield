/**
 * Static analysis orchestrator (Steps 8 + 9).
 *
 * Builds the three indexes once, runs every registered rule against them, and
 * returns a result that is both the report input and the correlation input.
 */
import type { ApkInfo } from '../apk/inspector.js';
import type { Logger } from '../core/logger.js';
import type { Finding } from '../core/types.js';
import type { DeviceInfo } from '../devices/deviceManager.js';
import type { UnityProjectInfo } from '../intake/unityProject.js';
import { buildAssetIndex, type AssetIndex } from './assetIndex.js';
import { buildCodeIndex, type CodeIndex } from './codeIndex.js';
import { RuleEngine, type StaticRule, type StaticRuleContext } from './ruleEngine.js';
import { ASSET_RULES } from './rules/assetRules.js';
import { BUILD_RULES } from './rules/buildRules.js';
import { CODE_RULES } from './rules/codeRules.js';
import { buildSceneIndex, type SceneIndex } from './sceneIndex.js';

export * from './ruleEngine.js';
export { buildAssetIndex } from './assetIndex.js';
export { buildCodeIndex } from './codeIndex.js';
export { buildSceneIndex } from './sceneIndex.js';

/** The default rule set. Ordering only affects report grouping, not results. */
export const DEFAULT_RULES: StaticRule[] = [...ASSET_RULES, ...CODE_RULES, ...BUILD_RULES];

export interface StaticAnalysisOptions {
  project: UnityProjectInfo;
  apk?: ApkInfo | null;
  devices?: DeviceInfo[];
  logger?: Logger;
  rules?: StaticRule[];
}

export interface StaticAnalysisResult {
  findings: Finding[];
  /** Compact summaries safe to serialize into the report. */
  summary: StaticSummary;
  errors: Array<{ ruleId: string; error: string }>;
  ranRules: string[];
  durationMs: number;
  /** Full indexes, kept in memory for the correlation stage. */
  indexes: {
    assets: AssetIndex;
    code: CodeIndex;
    scenes: SceneIndex;
  };
}

export interface StaticSummary {
  unityVersion: string | null;
  scriptingBackend: string | null;
  assetCount: number;
  scriptFileCount: number;
  sceneCount: number;
  buildSceneCount: number;
  prefabCount: number;
  textureCount: number;
  audioCount: number;
  estimatedTextureBytes: number;
  estimatedAudioBytes: number;
  usesAddressables: boolean;
  metaFilesPresent: boolean;
  unparsedMetaCount: number;
  heaviestScenes: Array<{ path: string; estimatedBytes: number; objectCount: number }>;
  largestTextures: Array<{ path: string; estimatedBytes: number; dimensions: string | null }>;
  /** Caveats that limit how much the static results can be trusted. */
  limitations: string[];
}

export async function runStaticAnalysis(
  opts: StaticAnalysisOptions,
): Promise<StaticAnalysisResult> {
  const { project, logger } = opts;
  const started = Date.now();

  logger?.info('Static analysis started', { root: project.root });

  const assets = buildAssetIndex({ projectRoot: project.root, logger });
  const code = buildCodeIndex({ projectRoot: project.root, logger });
  const scenes = buildSceneIndex({
    projectRoot: project.root,
    assets,
    buildScenes: project.buildScenes.map((s) => ({
      path: s.path,
      enabled: s.enabled,
      index: s.index,
    })),
    logger,
  });

  const ctx: StaticRuleContext = {
    project,
    assets,
    code,
    scenes,
    apk: opts.apk ?? null,
    devices: opts.devices ?? [],
    logger,
  };

  const engine = new RuleEngine().register(...(opts.rules ?? DEFAULT_RULES));
  const result = engine.run(ctx);

  const summary = buildSummary(project, assets, code, scenes);

  logger?.info('Static analysis complete', {
    findings: result.findings.length,
    rules: result.ranRules.length,
    errors: result.errors.length,
    ms: Date.now() - started,
  });

  return {
    findings: result.findings,
    summary,
    errors: result.errors,
    ranRules: result.ranRules,
    durationMs: Date.now() - started,
    indexes: { assets, code, scenes },
  };
}

function buildSummary(
  project: UnityProjectInfo,
  assets: AssetIndex,
  code: CodeIndex,
  scenes: SceneIndex,
): StaticSummary {
  const limitations: string[] = [...project.warnings];

  if (assets.unparsedMetaCount > 0) {
    limitations.push(
      `${assets.unparsedMetaCount} asset(s) had unreadable .meta files; their import settings were not analyzed.`,
    );
  }
  if (code.skipped > 0) {
    limitations.push(
      `${code.skipped} C# file(s) were skipped (generated code, or above the size limit).`,
    );
  }
  if (code.editorOnlyExcluded > 0 || assets.editorOnlyExcluded > 0) {
    limitations.push(
      `${code.editorOnlyExcluded} editor-only script(s) and ${assets.editorOnlyExcluded} editor-only asset(s) ` +
        'were excluded. Unity does not ship the contents of Editor folders in a player build, so they ' +
        'cannot affect runtime memory.',
    );
  }
  const thirdPartyFiles = code.files.filter((f) => f.thirdParty).length;
  if (thirdPartyFiles > 0) {
    limitations.push(
      `${thirdPartyFiles} of the scanned C# files belong to vendored SDKs. They are analyzed because ` +
        'third-party runtime code can leak, but fixing them usually means updating or reconfiguring the ' +
        'SDK rather than changing your own code.',
    );
  }
  const truncatedScenes = [...scenes.scenes, ...scenes.prefabs].filter((s) => s.truncated).length;
  if (truncatedScenes > 0) {
    limitations.push(`${truncatedScenes} scene/prefab file(s) were too large to scan.`);
  }
  limitations.push(
    'Texture and audio memory figures are estimates derived from import settings; where the importer ' +
      'is set to Automatic the exact runtime format is decided at build time and the estimate assumes ' +
      'the usual Android outcome.',
  );

  const heaviestScenes = [...scenes.scenes]
    .sort((a, b) => b.estimatedAssetBytes - a.estimatedAssetBytes)
    .slice(0, 10)
    .map((s) => ({
      path: s.relPath,
      estimatedBytes: s.estimatedAssetBytes,
      objectCount: s.objectCount,
    }));

  const largestTextures = [...assets.byKind.texture]
    .sort((a, b) => (b.estimate?.bytes ?? 0) - (a.estimate?.bytes ?? 0))
    .slice(0, 15)
    .map((a) => ({
      path: a.relPath,
      estimatedBytes: a.estimate?.bytes ?? 0,
      dimensions: a.dimensions ? `${a.dimensions.width}x${a.dimensions.height}` : null,
    }));

  return {
    unityVersion: project.unityVersion,
    scriptingBackend: project.scriptingBackend,
    assetCount: assets.totals.assetCount,
    scriptFileCount: code.files.length,
    sceneCount: scenes.scenes.length,
    buildSceneCount: project.buildScenes.filter((s) => s.enabled).length,
    prefabCount: scenes.prefabs.length,
    textureCount: assets.byKind.texture.length,
    audioCount: assets.byKind.audio.length,
    estimatedTextureBytes: assets.totals.estimatedTextureBytes,
    estimatedAudioBytes: assets.totals.estimatedAudioBytes,
    usesAddressables: project.usesAddressables,
    metaFilesPresent: project.hasMetaFiles,
    unparsedMetaCount: assets.unparsedMetaCount,
    heaviestScenes,
    largestTextures,
    limitations,
  };
}
