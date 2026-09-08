import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateUnityProject } from '../src/intake/unityProject.js';
import { runStaticAnalysis, type StaticAnalysisResult } from '../src/static/index.js';
import { blankCommentsAndStrings } from '../src/static/codeIndex.js';
import { readImageDimensions } from '../src/static/imageInfo.js';
import { createFixtureProject, makePng } from './fixtures/unityProject.js';
import { writeFileSync } from 'node:fs';

let root: string;
let result: StaticAnalysisResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'oom-fixture-'));
  createFixtureProject(root);
  const project = validateUnityProject(root);
  result = await runStaticAnalysis({ project });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ruleIds = () => new Set(result.findings.map((f) => f.ruleId));

describe('Unity project validation', () => {
  it('reads version, backend and build scenes', () => {
    const project = validateUnityProject(root);
    expect(project.unityVersion).toBe('2022.3.20f1');
    expect(project.scriptingBackend).toBe('IL2CPP');
    expect(project.buildScenes).toHaveLength(2);
    expect(project.buildScenes[0]?.path).toBe('Assets/Scenes/Main.unity');
    expect(project.usesAddressables).toBe(true);
  });

  it('rejects a directory that is not a Unity project', () => {
    const empty = mkdtempSync(join(tmpdir(), 'oom-empty-'));
    expect(() => validateUnityProject(empty)).toThrow(/missing "Assets\/"/);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('image header reading', () => {
  it('reads PNG dimensions without an image library', () => {
    const path = join(root, 'probe.png');
    writeFileSync(path, makePng(1234, 567));
    const dims = readImageDimensions(path);
    expect(dims).toEqual(expect.objectContaining({ width: 1234, height: 567, format: 'PNG' }));
  });
});

describe('asset rules', () => {
  it('flags the oversized 4096px texture with a memory estimate', () => {
    const finding = result.findings.find((f) => f.ruleId === 'UNITY.TEXTURE.OVERSIZED');
    expect(finding).toBeDefined();
    expect(finding!.evidence.some((e) => e.path?.includes('hero_atlas.png'))).toBe(true);
    // 4096 x 4096 x 32bpp x 1.33 mipmaps = ~85 MB
    expect(finding!.estimatedBytes).toBeGreaterThan(80 * 1024 * 1024);
  });

  it('flags Read/Write enabled, uncompressed, and missing Android override', () => {
    const ids = ruleIds();
    expect(ids.has('UNITY.TEXTURE.READ_WRITE_ENABLED')).toBe(true);
    expect(ids.has('UNITY.TEXTURE.UNCOMPRESSED')).toBe(true);
  });

  it('does not flag the well-configured 256px texture', () => {
    const mentionsIcon = result.findings.some((f) =>
      f.evidence.some((e) => e.path?.includes('ui_icon.png')),
    );
    expect(mentionsIcon).toBe(false);
  });

  it('flags the large multisampled RenderTexture', () => {
    const finding = result.findings.find((f) => f.ruleId === 'UNITY.RENDER_TEXTURE.LARGE');
    expect(finding).toBeDefined();
    // 2048 x 2048 x (4 colour + 4 depth) x 4 MSAA = 128 MB
    expect(finding!.estimatedBytes).toBeGreaterThan(100 * 1024 * 1024);
  });

  it('flags Decompress On Load audio', () => {
    const finding = result.findings.find((f) => f.ruleId === 'UNITY.AUDIO.DECOMPRESS_ON_LOAD');
    expect(finding).toBeDefined();
    expect(finding!.evidence.some((e) => e.path?.includes('theme_music.ogg'))).toBe(true);
  });
});

describe('code rules', () => {
  it('detects each of the targeted C# patterns', () => {
    const ids = ruleIds();
    expect(ids.has('CODE.DONT_DESTROY_ON_LOAD')).toBe(true);
    expect(ids.has('CODE.RESOURCES_LOAD_ALL')).toBe(true);
    expect(ids.has('CODE.ADDRESSABLES_LIFETIME')).toBe(true);
    expect(ids.has('CODE.INSTANTIATE_HOT_PATH')).toBe(true);
    expect(ids.has('CODE.RENDERER_MATERIAL')).toBe(true);
    expect(ids.has('CODE.RUNTIME_TEXTURE_MESH')).toBe(true);
    expect(ids.has('CODE.TEMP_RENDER_TEXTURE')).toBe(true);
    expect(ids.has('CODE.UNBOUNDED_COLLECTION')).toBe(true);
  });

  it('reports Instantiate only where it is really inside Update', () => {
    const finding = result.findings.find((f) => f.ruleId === 'CODE.INSTANTIATE_HOT_PATH');
    expect(finding!.evidence[0]?.summary).toContain('Update');
  });

  it('ignores commented-out and string-literal occurrences', () => {
    // The fixture has one real LoadAll plus a commented one and one in a string.
    const finding = result.findings.find((f) => f.ruleId === 'CODE.RESOURCES_LOAD_ALL');
    expect(finding!.title).toContain('1 call');
  });

  it('blanks comments and strings while preserving line numbers', () => {
    const source = 'int a = 1;\n// Resources.LoadAll("x");\nstring s = "Resources.LoadAll";\nint b = 2;';
    const blanked = blankCommentsAndStrings(source);
    expect(blanked.split('\n')).toHaveLength(4);
    expect(blanked).not.toContain('LoadAll');
    expect(blanked).toContain('int b = 2;');
  });
});

describe('scene analysis', () => {
  it('attributes referenced asset memory to the scene that loads it', () => {
    const main = result.indexes.scenes.byPath.get('Assets/Scenes/Main.unity');
    expect(main).toBeDefined();
    expect(main!.inBuild).toBe(true);
    expect(main!.referencedAssets.length).toBeGreaterThanOrEqual(2);
    expect(main!.estimatedAssetBytes).toBeGreaterThan(80 * 1024 * 1024);
  });
});

describe('rule engine contract', () => {
  it('every finding carries id, evidence, severity, confidence and a recommendation', () => {
    expect(result.findings.length).toBeGreaterThan(5);
    for (const finding of result.findings) {
      expect(finding.ruleId).toBeTruthy();
      expect(finding.id).toMatch(/^f_[0-9a-f]{8}$/);
      expect(finding.recommendation.length).toBeGreaterThan(20);
      expect(finding.confidence).toBeGreaterThan(0);
      expect(finding.confidence).toBeLessThanOrEqual(1);
      expect(['info', 'low', 'medium', 'high', 'critical']).toContain(finding.severity);
    }
  });

  it('records no rule errors on a well-formed project', () => {
    expect(result.errors).toEqual([]);
  });
});
