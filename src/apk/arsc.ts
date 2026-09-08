/**
 * Minimal `resources.arsc` reader - just enough to resolve one string resource.
 *
 * Why this exists: an app's real name ("Wedding Rush Draw Puzzle") is almost
 * never a literal in the manifest. `android:label` is a resource reference, and
 * Android's own `dumpsys` reports it unresolved. Without reading the resource
 * table the app list can only show package ids, which is useless for finding a
 * game among fifty installed apps.
 *
 * Deliberately not a general resource-table implementation. It walks the type
 * chunks looking for one resource id and returns its string value, preferring
 * the default (no-locale) configuration. Everything it does not need - styles,
 * complex map entries, sparse encodings beyond the flag, other value types - is
 * skipped rather than modelled.
 *
 * Format per AOSP androidfw/ResourceTypes.h.
 */

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const UTF8_FLAG = 1 << 8;

/** Entry flag: the entry is a complex map (a style/array), not a simple value. */
const ENTRY_FLAG_COMPLEX = 0x0001;
/** Type flag: the entry index is a sparse id/offset table rather than dense. */
const TYPE_FLAG_SPARSE = 0x01;

const TYPE_STRING = 0x03;

export interface ResourceTable {
  /** Resolve a resource id (e.g. 0x7f110001) to its string value. */
  resolveString(resourceId: number): string | null;
}

/**
 * Parse a resource table.
 *
 * Returns null rather than throwing on anything unexpected: a label is a nicety,
 * and an unusual APK must not break the app list.
 */
export function parseResourceTable(buffer: Buffer): ResourceTable | null {
  try {
    return parseTable(buffer);
  } catch {
    return null;
  }
}

function parseTable(buffer: Buffer): ResourceTable | null {
  if (buffer.length < 12) return null;
  if (buffer.readUInt16LE(0) !== RES_TABLE_TYPE) return null;

  const headerSize = buffer.readUInt16LE(2);
  const packageCount = buffer.readUInt32LE(8);

  let offset = headerSize;

  // The table's own string pool holds every string value in the file.
  let globalStrings: string[] = [];
  const packages: ParsedPackage[] = [];

  while (offset + 8 <= buffer.length && packages.length <= packageCount) {
    const type = buffer.readUInt16LE(offset);
    const size = buffer.readUInt32LE(offset + 4);
    if (size <= 0 || offset + size > buffer.length) break;

    if (type === RES_STRING_POOL_TYPE && globalStrings.length === 0) {
      globalStrings = readStringPool(buffer, offset);
    } else if (type === RES_TABLE_PACKAGE_TYPE) {
      const pkg = readPackage(buffer, offset, size);
      if (pkg) packages.push(pkg);
    }

    offset += size;
  }

  if (packages.length === 0 || globalStrings.length === 0) return null;

  return {
    resolveString(resourceId: number): string | null {
      const packageId = (resourceId >>> 24) & 0xff;
      const typeId = (resourceId >>> 16) & 0xff;
      const entryIndex = resourceId & 0xffff;

      const pkg = packages.find((p) => p.id === packageId) ?? packages[0];
      if (!pkg) return null;

      // Several type chunks can describe the same type, one per configuration.
      // The default configuration is tried first, then any other.
      const candidates = pkg.types.filter((t) => t.id === typeId);
      const ordered = [
        ...candidates.filter((t) => t.isDefaultConfig),
        ...candidates.filter((t) => !t.isDefaultConfig),
      ];

      for (const type of ordered) {
        const stringIndex = type.entries.get(entryIndex);
        if (stringIndex === undefined) continue;
        const value = globalStrings[stringIndex];
        if (value) return value;
      }
      return null;
    },
  };
}

interface ParsedType {
  id: number;
  isDefaultConfig: boolean;
  /** entry index -> index into the global string pool */
  entries: Map<number, number>;
}

interface ParsedPackage {
  id: number;
  types: ParsedType[];
}

function readPackage(buffer: Buffer, start: number, size: number): ParsedPackage | null {
  const headerSize = buffer.readUInt16LE(start + 2);
  const id = buffer.readUInt32LE(start + 8);

  const pkg: ParsedPackage = { id: id & 0xff, types: [] };
  const end = start + size;

  let offset = start + headerSize;
  while (offset + 8 <= end) {
    const type = buffer.readUInt16LE(offset);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkSize <= 0 || offset + chunkSize > end) break;

    if (type === RES_TABLE_TYPE_TYPE) {
      const parsed = readType(buffer, offset, chunkSize);
      if (parsed) pkg.types.push(parsed);
    }
    // RES_TABLE_TYPE_SPEC_TYPE and the two string pools inside a package
    // (type names, key names) are not needed to resolve a value.
    else if (type !== RES_TABLE_TYPE_SPEC_TYPE && type !== RES_STRING_POOL_TYPE) {
      // Unknown chunk - skipping by size keeps the walk aligned.
    }

    offset += chunkSize;
  }

  return pkg;
}

function readType(buffer: Buffer, start: number, size: number): ParsedType | null {
  const headerSize = buffer.readUInt16LE(start + 2);
  const id = buffer.readUInt8(start + 8);
  const flags = buffer.readUInt8(start + 9);
  const entryCount = buffer.readUInt32LE(start + 12);
  const entriesStart = buffer.readUInt32LE(start + 16);

  if (id === 0 || entryCount === 0) return null;

  // The config block follows the fixed header. A default configuration is all
  // zero bytes; anything else is locale- or density-specific.
  const configStart = start + 20;
  const configSize = configStart + 4 <= buffer.length ? buffer.readUInt32LE(configStart) : 0;
  let isDefaultConfig = true;
  if (configSize > 4 && configStart + configSize <= buffer.length) {
    for (let i = configStart + 4; i < configStart + configSize; i++) {
      if (buffer[i] !== 0) {
        isDefaultConfig = false;
        break;
      }
    }
  }

  const entries = new Map<number, number>();
  const sparse = (flags & TYPE_FLAG_SPARSE) !== 0;
  const indexStart = start + headerSize;
  const dataStart = start + entriesStart;

  for (let i = 0; i < entryCount; i++) {
    let entryIndex = i;
    let entryOffset: number;

    if (sparse) {
      // Sparse: each slot is a 16-bit id and a 16-bit offset in 4-byte units.
      const at = indexStart + i * 4;
      if (at + 4 > buffer.length) break;
      entryIndex = buffer.readUInt16LE(at);
      entryOffset = buffer.readUInt16LE(at + 2) * 4;
    } else {
      const at = indexStart + i * 4;
      if (at + 4 > buffer.length) break;
      entryOffset = buffer.readUInt32LE(at);
      if (entryOffset === 0xffffffff) continue; // no entry at this index
    }

    const entryAt = dataStart + entryOffset;
    if (entryAt + 8 > start + size || entryAt + 8 > buffer.length) continue;

    const entryFlags = buffer.readUInt16LE(entryAt + 2);
    if ((entryFlags & ENTRY_FLAG_COMPLEX) !== 0) continue; // a style, not a value

    // Res_value follows the entry header: size(2) res0(1) dataType(1) data(4)
    const valueAt = entryAt + 8;
    if (valueAt + 8 > buffer.length) continue;

    const dataType = buffer.readUInt8(valueAt + 3);
    if (dataType !== TYPE_STRING) continue;

    entries.set(entryIndex, buffer.readUInt32LE(valueAt + 4));
  }

  return { id, isDefaultConfig, entries };
}

/**
 * Read a RES_STRING_POOL chunk.
 *
 * Shared shape with the manifest's pool, but kept local so the two parsers stay
 * independent - the pools differ in which encoding they use in practice.
 */
function readStringPool(buffer: Buffer, start: number): string[] {
  const stringCount = buffer.readUInt32LE(start + 8);
  const flags = buffer.readUInt32LE(start + 16);
  const stringsStart = buffer.readUInt32LE(start + 20);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;

  const offsetsAt = start + 28;
  const dataAt = start + stringsStart;
  const out: string[] = [];

  for (let i = 0; i < stringCount; i++) {
    const offsetPos = offsetsAt + i * 4;
    if (offsetPos + 4 > buffer.length) break;

    const at = dataAt + buffer.readUInt32LE(offsetPos);
    if (at >= buffer.length) {
      out.push('');
      continue;
    }
    out.push(isUtf8 ? readUtf8String(buffer, at) : readUtf16String(buffer, at));
  }

  return out;
}

function readUtf8String(buffer: Buffer, at: number): string {
  let p = at;
  // Character length, then byte length; either may use a two-byte form.
  if ((buffer[p]! & 0x80) !== 0) p += 2;
  else p += 1;

  let byteLength = buffer[p]!;
  if ((byteLength & 0x80) !== 0) {
    byteLength = ((byteLength & 0x7f) << 8) | buffer[p + 1]!;
    p += 2;
  } else {
    p += 1;
  }

  return buffer.subarray(p, Math.min(p + byteLength, buffer.length)).toString('utf8');
}

function readUtf16String(buffer: Buffer, at: number): string {
  let p = at;
  let length = buffer.readUInt16LE(p);
  if ((length & 0x8000) !== 0) {
    length = ((length & 0x7fff) << 16) | buffer.readUInt16LE(p + 2);
    p += 4;
  } else {
    p += 2;
  }

  return buffer.subarray(p, Math.min(p + length * 2, buffer.length)).toString('utf16le');
}
