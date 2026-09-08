/**
 * Source image dimensions, read straight from file headers.
 *
 * Runtime texture memory depends on the *source* resolution clamped by the
 * importer's maxTextureSize - so without dimensions the highest-value static
 * rule (oversized textures) cannot produce a number. We read only the header
 * bytes rather than pulling in an image library, which keeps the tool
 * dependency-free and makes scanning thousands of assets fast.
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { extname } from 'node:path';

export interface ImageDimensions {
  width: number;
  height: number;
  format: string;
  /** Bits per pixel of the *source* file, where meaningful. */
  sourceChannels?: number;
}

const SUPPORTED = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.tga',
  '.bmp',
  '.gif',
  '.psd',
  '.tif',
  '.tiff',
  '.exr',
  '.webp',
]);

export function isImageFile(path: string): boolean {
  return SUPPORTED.has(extname(path).toLowerCase());
}

export function readImageDimensions(path: string): ImageDimensions | null {
  const ext = extname(path).toLowerCase();
  if (!SUPPORTED.has(ext)) return null;

  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size < 16) return null;
    fd = openSync(path, 'r');
    const head = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, head, 0, head.length, 0);

    switch (ext) {
      case '.png':
        return readPng(head);
      case '.jpg':
      case '.jpeg':
        return readJpeg(fd, size);
      case '.tga':
        return readTga(head);
      case '.bmp':
        return readBmp(head);
      case '.gif':
        return readGif(head);
      case '.psd':
        return readPsd(head);
      case '.tif':
      case '.tiff':
        return readTiff(head);
      case '.webp':
        return readWebp(head);
      default:
        return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readPng(buf: Buffer): ImageDimensions | null {
  // 8-byte signature, then the IHDR chunk: length(4) type(4) width(4) height(4)
  if (buf.length < 33) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const bitDepth = buf.readUInt8(24);
  const colorType = buf.readUInt8(25);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    format: 'PNG',
    sourceChannels: pngChannels(colorType) * bitDepth,
  };
}

function pngChannels(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // greyscale
    case 2:
      return 3; // RGB
    case 3:
      return 1; // palette
    case 4:
      return 2; // greyscale + alpha
    case 6:
      return 4; // RGBA
    default:
      return 4;
  }
}

/**
 * JPEG requires walking the marker chain to the SOFn frame header, which may
 * sit past the first 4 KB when the file carries a large EXIF/ICC block.
 */
function readJpeg(fd: number, fileSize: number): ImageDimensions | null {
  const chunk = Buffer.alloc(Math.min(fileSize, 512 * 1024));
  readSync(fd, chunk, 0, chunk.length, 0);
  if (chunk.readUInt16BE(0) !== 0xffd8) return null;

  let pos = 2;
  while (pos + 9 < chunk.length) {
    if (chunk.readUInt8(pos) !== 0xff) {
      pos++;
      continue;
    }
    const marker = chunk.readUInt8(pos + 1);
    // SOF0..SOF15, excluding DHT(c4), JPG(c8) and DAC(cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        width: chunk.readUInt16BE(pos + 7),
        height: chunk.readUInt16BE(pos + 5),
        format: 'JPEG',
        sourceChannels: chunk.readUInt8(pos + 9) * 8,
      };
    }
    const length = chunk.readUInt16BE(pos + 2);
    if (length < 2) break;
    pos += 2 + length;
  }
  return null;
}

function readTga(buf: Buffer): ImageDimensions | null {
  if (buf.length < 18) return null;
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  if (width === 0 || height === 0) return null;
  return { width, height, format: 'TGA', sourceChannels: buf.readUInt8(16) };
}

function readBmp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30 || buf.subarray(0, 2).toString('latin1') !== 'BM') return null;
  return {
    width: Math.abs(buf.readInt32LE(18)),
    height: Math.abs(buf.readInt32LE(22)),
    format: 'BMP',
    sourceChannels: buf.readUInt16LE(28),
  };
}

function readGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10 || buf.subarray(0, 3).toString('latin1') !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'GIF' };
}

function readPsd(buf: Buffer): ImageDimensions | null {
  if (buf.length < 26 || buf.subarray(0, 4).toString('latin1') !== '8BPS') return null;
  return {
    width: buf.readUInt32BE(18),
    height: buf.readUInt32BE(14),
    format: 'PSD',
    sourceChannels: buf.readUInt16BE(12) * buf.readUInt16BE(22),
  };
}

function readTiff(buf: Buffer): ImageDimensions | null {
  if (buf.length < 8) return null;
  const le = buf.subarray(0, 2).toString('latin1') === 'II';
  const be = buf.subarray(0, 2).toString('latin1') === 'MM';
  if (!le && !be) return null;

  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const ifdOffset = u32(4);
  if (ifdOffset + 2 > buf.length) return null;
  const count = u16(ifdOffset);

  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > buf.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  return width && height ? { width, height, format: 'TIFF' } : null;
}

function readWebp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') return null;
  if (buf.subarray(8, 12).toString('latin1') !== 'WEBP') return null;

  const chunkType = buf.subarray(12, 16).toString('latin1');
  if (chunkType === 'VP8X') {
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
      format: 'WEBP',
    };
  }
  if (chunkType === 'VP8 ') {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
      format: 'WEBP',
    };
  }
  if (chunkType === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      format: 'WEBP',
    };
  }
  return null;
}
