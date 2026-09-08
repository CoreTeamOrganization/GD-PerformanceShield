/**
 * Minimal ZIP central-directory reader.
 *
 * An APK is a ZIP. We read the central directory rather than shelling out to
 * `unzip`/`aapt2` so APK inspection works on any machine with only Node
 * installed, and so we can list every entry (lib/, assets/bin/Data/, ...) for
 * the Unity-specific detection the spec needs.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  crc32: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_COMMENT = 0xffff;

export class ZipReader {
  private fd: number;
  private readonly fileSize: number;
  private entriesCache: ZipEntry[] | null = null;

  constructor(readonly path: string) {
    this.fileSize = statSync(path).size;
    this.fd = openSync(path, 'r');
  }

  close(): void {
    if (this.fd >= 0) {
      closeSync(this.fd);
      this.fd = -1;
    }
  }

  private read(length: number, position: number): Buffer {
    const clamped = Math.max(0, Math.min(length, this.fileSize - position));
    const buf = Buffer.alloc(clamped);
    if (clamped > 0) readSync(this.fd, buf, 0, clamped, position);
    return buf;
  }

  /** All central-directory entries, parsed once and cached. */
  entries(): ZipEntry[] {
    if (this.entriesCache) return this.entriesCache;
    const { offset, count } = this.locateCentralDirectory();
    const cd = this.read(this.fileSize - offset, offset);
    const entries: ZipEntry[] = [];
    let pos = 0;

    for (let i = 0; i < count && pos + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(pos) !== CENTRAL_SIGNATURE) break;
      const compressionMethod = cd.readUInt16LE(pos + 10);
      const crc32 = cd.readUInt32LE(pos + 16);
      let compressedSize = cd.readUInt32LE(pos + 20);
      let uncompressedSize = cd.readUInt32LE(pos + 24);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      let localHeaderOffset = cd.readUInt32LE(pos + 42);
      const name = cd.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
      const extra = cd.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);

      // ZIP64: sizes of 0xffffffff are placeholders held in the extra field.
      if (
        uncompressedSize === 0xffffffff ||
        compressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        const z64 = findZip64Extra(extra);
        if (z64) {
          let o = 0;
          if (uncompressedSize === 0xffffffff && o + 8 <= z64.length) {
            uncompressedSize = Number(z64.readBigUInt64LE(o));
            o += 8;
          }
          if (compressedSize === 0xffffffff && o + 8 <= z64.length) {
            compressedSize = Number(z64.readBigUInt64LE(o));
            o += 8;
          }
          if (localHeaderOffset === 0xffffffff && o + 8 <= z64.length) {
            localHeaderOffset = Number(z64.readBigUInt64LE(o));
          }
        }
      }

      entries.push({
        name,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        crc32,
        localHeaderOffset,
        isDirectory: name.endsWith('/'),
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }

    this.entriesCache = entries;
    return entries;
  }

  find(name: string): ZipEntry | undefined {
    return this.entries().find((e) => e.name === name);
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  /** Read and decompress one entry. Returns null when it is absent. */
  readFile(name: string): Buffer | null {
    const entry = this.find(name);
    if (!entry) return null;
    return this.readEntry(entry);
  }

  readEntry(entry: ZipEntry): Buffer {
    // The local header repeats the name/extra with possibly different lengths,
    // so we must re-read it to find where the payload actually begins.
    const header = this.read(30, entry.localHeaderOffset);
    if (header.length < 30) throw new Error(`Truncated local header for ${entry.name}`);
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const raw = this.read(entry.compressedSize, dataOffset);

    if (entry.compressionMethod === 0) return raw;
    if (entry.compressionMethod === 8) return inflateRawSync(raw);
    throw new Error(`Unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
  }

  private locateCentralDirectory(): { offset: number; count: number } {
    const searchLen = Math.min(this.fileSize, MAX_COMMENT + 22);
    const tail = this.read(searchLen, this.fileSize - searchLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`Not a ZIP archive (no end-of-central-directory): ${this.path}`);

    let count = tail.readUInt16LE(eocd + 10);
    let offset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || offset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator >= 0 && tail.readUInt32LE(locator) === EOCD64_LOCATOR_SIGNATURE) {
        const eocd64Offset = Number(tail.readBigUInt64LE(locator + 8));
        const eocd64 = this.read(56, eocd64Offset);
        if (eocd64.length >= 56 && eocd64.readUInt32LE(0) === EOCD64_SIGNATURE) {
          count = Number(eocd64.readBigUInt64LE(32));
          offset = Number(eocd64.readBigUInt64LE(48));
        }
      }
    }

    return { offset, count };
  }
}

function findZip64Extra(extra: Buffer): Buffer | null {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    if (id === 0x0001) return extra.subarray(pos + 4, pos + 4 + size);
    pos += 4 + size;
  }
  return null;
}

/** Open a zip, run `fn`, always close the descriptor. */
export function withZip<T>(path: string, fn: (zip: ZipReader) => T): T {
  const zip = new ZipReader(path);
  try {
    return fn(zip);
  } finally {
    zip.close();
  }
}
