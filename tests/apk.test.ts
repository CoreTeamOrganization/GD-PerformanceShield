import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attr, findElements, parseAndroidManifest } from '../src/apk/axml.js';
import { inspectApk } from '../src/apk/inspector.js';
import { ZipReader } from '../src/apk/zip.js';
import { normalizeShareUrl } from '../src/intake/apkFetch.js';
import { unityManifest } from './fixtures/axml.js';
import { createFixtureApk } from './fixtures/unityProject.js';

let dir: string;
let apkPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'oom-apk-'));
  apkPath = createFixtureApk(join(dir, 'fixture.apk'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('binary AndroidManifest parsing', () => {
  it('reads package, version and SDK levels without aapt2', () => {
    const manifest = parseAndroidManifest(unityManifest('com.studio.racer'));
    const root = findElements(manifest, 'manifest')[0];
    expect(attr(root!, 'package')).toBe('com.studio.racer');
    expect(attr(root!, 'versionName')).toBe('1.4.2');
    expect(attr(root!, 'versionCode')).toBe('42');

    const usesSdk = findElements(manifest, 'uses-sdk')[0];
    expect(attr(usesSdk!, 'minSdkVersion')).toBe('24');
    expect(attr(usesSdk!, 'targetSdkVersion')).toBe('34');
  });

  it('preserves element nesting so intent filters can be resolved', () => {
    const manifest = parseAndroidManifest(unityManifest());
    const activity = findElements(manifest, 'activity')[0];
    expect(activity).toBeDefined();
    const filter = activity!.children.find((c) => c.name === 'intent-filter');
    expect(filter).toBeDefined();
    expect(filter!.children.map((c) => c.name)).toEqual(['action', 'category']);
  });

  it('collects meta-data and permissions', () => {
    const manifest = parseAndroidManifest(unityManifest());
    expect(findElements(manifest, 'uses-permission')).toHaveLength(1);
    expect(findElements(manifest, 'meta-data')).toHaveLength(1);
  });
});

describe('ZIP reader', () => {
  it('enumerates entries from the central directory', () => {
    const zip = new ZipReader(apkPath);
    try {
      const names = zip.entries().map((e) => e.name);
      expect(names).toContain('AndroidManifest.xml');
      expect(names).toContain('lib/arm64-v8a/libil2cpp.so');
      expect(names).toContain('assets/bin/Data/globalgamemanagers');
    } finally {
      zip.close();
    }
  });

  it('reads entry contents back correctly', () => {
    const zip = new ZipReader(apkPath);
    try {
      const data = zip.readFile('lib/arm64-v8a/libunity.so');
      expect(data).not.toBeNull();
      expect(data!.length).toBe(2048);
      expect(data![0]).toBe(7);
    } finally {
      zip.close();
    }
  });
});

describe('APK inspection', () => {
  it('extracts identity, ABIs and Unity build characteristics', async () => {
    const info = await inspectApk({ apkPath, aapt2Path: null });

    expect(info.packageName).toBe('com.fixture.game');
    expect(info.versionName).toBe('1.4.2');
    expect(info.versionCode).toBe(42);
    expect(info.minSdkVersion).toBe(24);
    expect(info.targetSdkVersion).toBe(34);
    expect(info.largeHeap).toBe(true);

    expect(info.abis).toEqual(['arm64-v8a']);
    expect(info.is64BitOnly).toBe(true);
    expect(info.has32Bit).toBe(false);

    expect(info.unity.isUnity).toBe(true);
    expect(info.unity.scriptingBackend).toBe('IL2CPP');
    expect(info.unity.engineVersion).toBe('2022.3.20f1');
    expect(info.unity.dataFolder).toBe('assets/bin/Data');
  });

  it('resolves the launcher activity into a launchable component', async () => {
    const info = await inspectApk({ apkPath, aapt2Path: null });
    expect(info.launcherActivity).toBe('com.unity3d.player.UnityPlayerActivity');
    expect(info.launchComponent).toBe('com.fixture.game/com.unity3d.player.UnityPlayerActivity');
  });

  it('summarises contents by top-level directory', async () => {
    const info = await inspectApk({ apkPath, aapt2Path: null });
    expect(info.contents.byTopLevelDir['lib']?.count).toBe(2);
    expect(info.contents.byTopLevelDir['assets']?.count).toBe(2);
    expect(info.contents.largestEntries[0]?.name).toBe('lib/arm64-v8a/libil2cpp.so');
  });
});

describe('share link normalisation', () => {
  it('turns a Google Drive share link into a direct download', () => {
    expect(normalizeShareUrl('https://drive.google.com/file/d/ABC123/view?usp=sharing')).toBe(
      'https://drive.google.com/uc?export=download&id=ABC123',
    );
  });

  it('turns a GitHub blob link into a raw link', () => {
    expect(normalizeShareUrl('https://github.com/o/r/blob/main/app.apk')).toBe(
      'https://github.com/o/r/raw/main/app.apk',
    );
  });

  it('leaves an ordinary URL alone', () => {
    expect(normalizeShareUrl('https://cdn.studio.com/build.apk')).toBe(
      'https://cdn.studio.com/build.apk',
    );
  });
});
