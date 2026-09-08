/**
 * Unity YAML parsing.
 *
 * Two dialects to deal with:
 *  - `.meta` files: ordinary YAML, parsed directly.
 *  - scenes/prefabs/assets: a multi-document stream where each document is
 *    tagged `--- !u!<classId> &<fileId>`. The `!u!` tags are not registered
 *    types, so a standard parser rejects them; we rewrite the tag line into a
 *    plain document separator and keep the class/file ids alongside.
 *
 * Unity also emits `stripped` documents and, in rare cases, duplicate keys.
 * Both are tolerated rather than treated as errors, because a single malformed
 * scene must not abort the analysis of a 3000-asset project.
 */
import { readFileSync } from 'node:fs';
import { parse, parseAllDocuments } from 'yaml';

/** Unity class ids we care about. */
export const UNITY_CLASS = {
  GameObject: 1,
  Transform: 4,
  Material: 21,
  MeshRenderer: 23,
  Texture2D: 28,
  RenderTexture: 84,
  MeshFilter: 33,
  Mesh: 43,
  AudioClip: 83,
  Animator: 95,
  MonoBehaviour: 114,
  ParticleSystem: 198,
  SpriteRenderer: 212,
  Sprite: 213,
  Canvas: 223,
  CanvasRenderer: 223,
  RectTransform: 224,
  LightmapSettings: 157,
  ReflectionProbe: 215,
  PrefabInstance: 1001,
} as const;

export interface UnityDocument {
  classId: number;
  fileId: string;
  /** Top-level type name, e.g. `Texture2D`. */
  typeName: string;
  body: Record<string, unknown>;
  stripped: boolean;
}

/** Parse a `.meta` file. Returns null when unparseable. */
export function parseMetaFile(path: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(path, 'utf8');
    return parseMetaText(text);
  } catch {
    return null;
  }
}

export function parseMetaText(text: string): Record<string, unknown> | null {
  try {
    // `logLevel: silent` stops the parser writing Unity's custom `!u!` tag
    // warnings to the console during a scan of thousands of assets.
    const parsed = parse(text, { uniqueKeys: false, strict: false, logLevel: 'silent' }) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse a Unity serialized-YAML file (scene, prefab, .asset).
 *
 * Files are read fully into memory; callers should skip files above a sane size
 * threshold, which `readUnityDocuments` enforces.
 */
export function readUnityDocuments(path: string, maxBytes = 24 * 1024 * 1024): UnityDocument[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  if (text.length > maxBytes) return [];
  return parseUnityDocuments(text);
}

export function parseUnityDocuments(text: string): UnityDocument[] {
  const headers: Array<{ classId: number; fileId: string; stripped: boolean }> = [];

  // Capture each `--- !u!28 &12345 stripped` header, then neutralise the tag so
  // the YAML parser sees a plain multi-document stream.
  const normalized = text.replace(
    /^---\s*!u!(\d+)\s*&(\d+)(\s+stripped)?\s*$/gm,
    (_match, classId: string, fileId: string, stripped?: string) => {
      headers.push({ classId: Number(classId), fileId, stripped: Boolean(stripped) });
      return '---';
    },
  );

  let documents: unknown[];
  try {
    documents = parseAllDocuments(normalized, {
      uniqueKeys: false,
      strict: false,
      logLevel: 'silent',
    }).map((d) =>
      d.toJS({ maxAliasCount: -1 }),
    );
  } catch {
    return [];
  }

  const out: UnityDocument[] = [];
  let headerIndex = 0;
  for (const doc of documents) {
    if (!isRecord(doc)) continue;
    const header = headers[headerIndex++];
    if (!header) continue;
    const typeName = Object.keys(doc)[0] ?? 'Unknown';
    const body = isRecord(doc[typeName]) ? (doc[typeName] as Record<string, unknown>) : {};
    out.push({
      classId: header.classId,
      fileId: header.fileId,
      typeName,
      body,
      stripped: header.stripped,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Safe accessors - Unity YAML is deeply nested and inconsistently versioned
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a nested value by dotted path, e.g. `mipmaps.enableMipMap`. */
export function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function getNumber(obj: unknown, path: string): number | null {
  const value = getPath(obj, path);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Unity writes booleans as 0/1 integers. */
export function getBool(obj: unknown, path: string): boolean | null {
  const value = getPath(obj, path);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return null;
}

export function getString(obj: unknown, path: string): string | null {
  const value = getPath(obj, path);
  return typeof value === 'string' ? value : null;
}

export function getArray(obj: unknown, path: string): unknown[] {
  const value = getPath(obj, path);
  return Array.isArray(value) ? value : [];
}
