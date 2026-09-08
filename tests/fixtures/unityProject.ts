/**
 * Synthetic Unity project fixture.
 *
 * Contains one deliberate instance of each problem class the static rules look
 * for, so the tests assert on real detection rather than on mocks.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { unityManifest } from './axml.js';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';

function write(root: string, relPath: string, content: string | Buffer): string {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** Minimal valid PNG with the requested dimensions in its IHDR. */
export function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(6, 9); // colour type RGBA
  const ihdr = chunk('IHDR', ihdrData);

  const idat = chunk('IDAT', deflateRawSync(Buffer.alloc(16)));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c ^ 0xffffffff;
}

export interface FixtureProject {
  root: string;
  bigTextureGuid: string;
  musicGuid: string;
}

const BIG_TEXTURE_GUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MUSIC_GUID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SCENE_GUID = 'cccccccccccccccccccccccccccccccc';

export function createFixtureProject(root: string): FixtureProject {
  // ---- ProjectSettings ----------------------------------------------------
  write(root, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.20f1\n');

  write(
    root,
    'ProjectSettings/ProjectSettings.asset',
    `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!129 &1
PlayerSettings:
  companyName: Fixture Studio
  productName: Fixture Game
  applicationIdentifier:
    Android: com.fixture.game
  scriptingBackend:
    Android: 1
    Standalone: 1
`,
  );

  write(
    root,
    'ProjectSettings/EditorBuildSettings.asset',
    `%YAML 1.1
--- !u!1045 &1
EditorBuildSettings:
  m_Scenes:
  - enabled: 1
    path: Assets/Scenes/Main.unity
    guid: ${SCENE_GUID}
  - enabled: 1
    path: Assets/Scenes/Gameplay.unity
    guid: dddddddddddddddddddddddddddddddd
`,
  );

  write(root, 'Packages/manifest.json', JSON.stringify({
    dependencies: {
      'com.unity.addressables': '1.21.19',
      'com.unity.textmeshpro': '3.0.6',
    },
  }, null, 2));

  // ---- Textures -----------------------------------------------------------
  // 4096x4096, Read/Write enabled, compression off, mipmaps on, no Android
  // override: every texture rule should have something to say about this.
  write(root, 'Assets/Textures/hero_atlas.png', makePng(4096, 4096));
  write(
    root,
    'Assets/Textures/hero_atlas.png.meta',
    `fileFormatVersion: 2
guid: ${BIG_TEXTURE_GUID}
TextureImporter:
  isReadable: 1
  mipmaps:
    enableMipMap: 1
  maxTextureSize: 4096
  textureCompression: 0
  crunchedCompression: 0
  textureType: 0
  platformSettings:
  - serializedVersion: 3
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 4096
    textureFormat: -1
    textureCompression: 0
    crunchedCompression: 0
    overridden: 0
`,
  );

  // A well-configured texture: should NOT trigger the rules.
  write(root, 'Assets/Textures/ui_icon.png', makePng(256, 256));
  write(
    root,
    'Assets/Textures/ui_icon.png.meta',
    `fileFormatVersion: 2
guid: 11111111111111111111111111111111
TextureImporter:
  isReadable: 0
  mipmaps:
    enableMipMap: 0
  maxTextureSize: 256
  textureCompression: 1
  platformSettings:
  - serializedVersion: 3
    buildTarget: Android
    maxTextureSize: 256
    textureFormat: 50
    textureCompression: 1
    overridden: 1
`,
  );

  // ---- Audio --------------------------------------------------------------
  write(root, 'Assets/Audio/theme_music.ogg', Buffer.alloc(6 * 1024 * 1024, 1));
  write(
    root,
    'Assets/Audio/theme_music.ogg.meta',
    `fileFormatVersion: 2
guid: ${MUSIC_GUID}
AudioImporter:
  loadInBackground: 0
  preloadAudioData: 1
  defaultSettings:
    loadType: 0
    compressionFormat: 1
    quality: 0.7
`,
  );

  // ---- RenderTexture ------------------------------------------------------
  write(
    root,
    'Assets/Rendering/Reflection.renderTexture',
    `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!84 &8400000
RenderTexture:
  m_Name: Reflection
  m_Width: 2048
  m_Height: 2048
  m_AntiAliasing: 4
  m_DepthFormat: 2
  m_MipMap: 0
`,
  );
  write(root, 'Assets/Rendering/Reflection.renderTexture.meta', 'fileFormatVersion: 2\nguid: 22222222222222222222222222222222\n');

  // ---- Scenes -------------------------------------------------------------
  write(
    root,
    'Assets/Scenes/Main.unity',
    `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: Root
--- !u!23 &200
MeshRenderer:
  m_Materials:
  - {fileID: 2100000, guid: ${BIG_TEXTURE_GUID}, type: 2}
--- !u!83 &300
AudioSource:
  m_audioClip: {fileID: 8300000, guid: ${MUSIC_GUID}, type: 3}
`,
  );
  write(root, 'Assets/Scenes/Main.unity.meta', `fileFormatVersion: 2\nguid: ${SCENE_GUID}\n`);

  write(
    root,
    'Assets/Scenes/Gameplay.unity',
    `%YAML 1.1
--- !u!1 &100
GameObject:
  m_Name: GameplayRoot
`,
  );
  write(root, 'Assets/Scenes/Gameplay.unity.meta', 'fileFormatVersion: 2\nguid: dddddddddddddddddddddddddddddddd\n');

  // ---- Scripts ------------------------------------------------------------
  // Each rule has a positive case here, plus commented-out and string-literal
  // decoys that must NOT be matched.
  write(
    root,
    'Assets/Scripts/GameManager.cs',
    `using System.Collections.Generic;
using UnityEngine;
using UnityEngine.AddressableAssets;

public class GameManager : MonoBehaviour
{
    // Decoy: this commented call must not be reported.
    // Resources.LoadAll<Texture2D>("Decoy");
    private const string Hint = "call Resources.LoadAll to load everything";

    private static List<GameObject> spawnedObjects = new List<GameObject>();
    public Renderer targetRenderer;
    public GameObject bulletPrefab;

    void Awake()
    {
        DontDestroyOnLoad(gameObject);
        var all = Resources.LoadAll<Sprite>("Icons");
        Addressables.LoadAssetAsync<GameObject>("ShopPanel");
    }

    void OnEnable()
    {
        Application.lowMemory += HandleLowMemory;
        SceneLoader.OnLoaded += HandleLoaded;
    }

    void Update()
    {
        var bullet = Instantiate(bulletPrefab);
        spawnedObjects.Add(bullet);
        targetRenderer.material.color = Color.red;
    }

    void BuildOverlay()
    {
        var rt = RenderTexture.GetTemporary(1920, 1080);
        var scratch = new Texture2D(2048, 2048);
        var mesh = new Mesh();
    }

    void HandleLowMemory() { }
    void HandleLoaded() { }
}
`,
  );

  write(
    root,
    'Assets/Scripts/ShopScreen.cs',
    `using UnityEngine;
using UnityEngine.AddressableAssets;

public class ShopScreen : MonoBehaviour
{
    void Open()
    {
        Addressables.LoadAssetAsync<Texture2D>("ShopBanner");
        Addressables.InstantiateAsync("ShopItemGrid");
    }
}
`,
  );

  // A clean file: the rules must not report anything here.
  write(
    root,
    'Assets/Scripts/CleanBehaviour.cs',
    `using UnityEngine;

public class CleanBehaviour : MonoBehaviour
{
    void OnEnable() { SceneLoader.OnLoaded += Handle; }
    void OnDisable() { SceneLoader.OnLoaded -= Handle; }
    void Handle() { }
}
`,
  );

  return { root, bigTextureGuid: BIG_TEXTURE_GUID, musicGuid: MUSIC_GUID };
}

// ---------------------------------------------------------------------------
// Synthetic APK
// ---------------------------------------------------------------------------

/**
 * Build a minimal but structurally valid APK (a ZIP with a Unity-shaped
 * layout). Used to exercise the ZIP reader, Unity detection and ABI detection
 * without needing a real 100 MB game build in the repository.
 */
export function createFixtureApk(path: string): string {
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'AndroidManifest.xml', data: unityManifest() },
    { name: 'lib/arm64-v8a/libunity.so', data: Buffer.alloc(2048, 7) },
    { name: 'lib/arm64-v8a/libil2cpp.so', data: Buffer.alloc(4096, 8) },
    {
      name: 'assets/bin/Data/globalgamemanagers',
      data: Buffer.concat([Buffer.alloc(20), Buffer.from('2022.3.20f1\0', 'latin1'), Buffer.alloc(64)]),
    },
    { name: 'assets/bin/Data/level0', data: Buffer.alloc(1024, 3) },
    { name: 'classes.dex', data: Buffer.alloc(512, 4) },
  ];

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildZip(entries));
  return path;
}

/** Store-only ZIP writer - enough for the reader under test. */
function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const localBlock = Buffer.concat([local, nameBuf, entry.data]);
    locals.push(localBlock);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += localBlock.length;
  }

  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBlock, eocd]);
}
