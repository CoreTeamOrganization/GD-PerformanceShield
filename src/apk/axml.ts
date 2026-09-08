/**
 * Binary AndroidManifest.xml (AXML) parser.
 *
 * The manifest inside an APK is a compiled binary resource chunk, not text.
 * Parsing it directly means APK inspection needs no Android SDK on the machine
 * running the analysis - which matters because this tool is meant to run on
 * studio benches and CI boxes that may only have Node installed.
 *
 * Chunk format reference: AOSP frameworks/base/include/androidfw/ResourceTypes.h
 */

const CHUNK_STRING_POOL = 0x0001;
const CHUNK_XML_START_ELEMENT = 0x0102;
const CHUNK_XML_END_ELEMENT = 0x0103;

const UTF8_FLAG = 1 << 8;

// Typed value types we care about (Res_value::dataType).
const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

export interface AxmlAttribute {
  namespace: string | null;
  name: string;
  value: string | number | boolean | null;
  rawType: number;
}

export interface AxmlElement {
  name: string;
  attributes: AxmlAttribute[];
  children: AxmlElement[];
  parent: AxmlElement | null;
}

export interface ParsedManifest {
  root: AxmlElement;
  /** Every element in document order, for convenient querying. */
  all: AxmlElement[];
}

export function parseAndroidManifest(buffer: Buffer): ParsedManifest {
  if (buffer.length < 8) throw new Error('AndroidManifest.xml is truncated');

  const strings = readStringPool(buffer);
  const root: AxmlElement = { name: '#document', attributes: [], children: [], parent: null };
  const all: AxmlElement[] = [];
  let current = root;

  // Walk top-level chunks after the 8-byte file header.
  let pos = 8;
  while (pos + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(pos);
    const headerSize = buffer.readUInt16LE(pos + 2);
    const size = buffer.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > buffer.length) break;

    if (type === CHUNK_XML_START_ELEMENT) {
      const el = readStartElement(buffer, pos, headerSize, strings);
      el.parent = current;
      current.children.push(el);
      all.push(el);
      current = el;
    } else if (type === CHUNK_XML_END_ELEMENT) {
      current = current.parent ?? root;
    }

    pos += size;
  }

  return { root, all };
}

function readStartElement(
  buf: Buffer,
  chunkStart: number,
  headerSize: number,
  strings: string[],
): AxmlElement {
  // ResXMLTree_node header is followed by ResXMLTree_attrExt.
  const ext = chunkStart + headerSize;
  const nameIdx = buf.readUInt32LE(ext + 4);
  const attrStart = buf.readUInt16LE(ext + 8);
  const attrSize = buf.readUInt16LE(ext + 10);
  const attrCount = buf.readUInt16LE(ext + 12);

  const attributes: AxmlAttribute[] = [];
  for (let i = 0; i < attrCount; i++) {
    const a = ext + attrStart + i * attrSize;
    if (a + 20 > buf.length) break;
    const nsIdx = buf.readUInt32LE(a);
    const attrNameIdx = buf.readUInt32LE(a + 4);
    const rawValueIdx = buf.readUInt32LE(a + 8);
    const dataType = buf.readUInt8(a + 15);
    const data = buf.readUInt32LE(a + 16);

    attributes.push({
      namespace: str(strings, nsIdx),
      name: str(strings, attrNameIdx) ?? `attr_${attrNameIdx}`,
      value: decodeValue(dataType, data, rawValueIdx, strings),
      rawType: dataType,
    });
  }

  return {
    name: str(strings, nameIdx) ?? '#unknown',
    attributes,
    children: [],
    parent: null,
  };
}

function decodeValue(
  dataType: number,
  data: number,
  rawValueIdx: number,
  strings: string[],
): string | number | boolean | null {
  switch (dataType) {
    case TYPE_NULL:
      return null;
    case TYPE_STRING:
      return str(strings, rawValueIdx) ?? str(strings, data) ?? '';
    case TYPE_INT_BOOLEAN:
      return data !== 0;
    case TYPE_REFERENCE:
      return `@${data.toString(16)}`;
    case TYPE_FLOAT:
      return Buffer.from(Uint32Array.of(data).buffer).readFloatLE(0);
    case TYPE_INT_HEX:
      return data;
    case TYPE_INT_DEC:
      return data | 0;
    default:
      // Unknown/dimension types: prefer the raw string when the pool has one.
      return str(strings, rawValueIdx) ?? data;
  }
}

function str(strings: string[], index: number): string | null {
  if (index === 0xffffffff || index < 0 || index >= strings.length) return null;
  return strings[index] ?? null;
}

/** Read the first string pool chunk, which always follows the file header. */
function readStringPool(buf: Buffer): string[] {
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const type = buf.readUInt16LE(pos);
    const size = buf.readUInt32LE(pos + 4);
    if (size < 8) break;
    if (type === CHUNK_STRING_POOL) return parseStringPool(buf, pos);
    pos += size;
  }
  return [];
}

function parseStringPool(buf: Buffer, start: number): string[] {
  const stringCount = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;

  const offsetsStart = start + 28;
  const dataStart = start + stringsStart;
  const out: string[] = new Array(stringCount);

  for (let i = 0; i < stringCount; i++) {
    const offPos = offsetsStart + i * 4;
    if (offPos + 4 > buf.length) {
      out[i] = '';
      continue;
    }
    const at = dataStart + buf.readUInt32LE(offPos);
    out[i] = at < buf.length ? (isUtf8 ? readUtf8String(buf, at) : readUtf16String(buf, at)) : '';
  }
  return out;
}

/**
 * UTF-8 pool entries carry two lengths: character count then byte count, each
 * of which may be one or two bytes depending on the high-bit marker.
 */
function readUtf8String(buf: Buffer, at: number): string {
  let pos = at;
  const skip = readVarLen8(buf, pos);
  pos = skip.next;
  const byteLen = readVarLen8(buf, pos);
  pos = byteLen.next;
  return buf.subarray(pos, Math.min(pos + byteLen.value, buf.length)).toString('utf8');
}

function readVarLen8(buf: Buffer, pos: number): { value: number; next: number } {
  const first = buf.readUInt8(pos);
  if ((first & 0x80) !== 0) {
    return { value: ((first & 0x7f) << 8) | buf.readUInt8(pos + 1), next: pos + 2 };
  }
  return { value: first, next: pos + 1 };
}

function readUtf16String(buf: Buffer, at: number): string {
  let pos = at;
  let len = buf.readUInt16LE(pos);
  pos += 2;
  if ((len & 0x8000) !== 0) {
    len = ((len & 0x7fff) << 16) | buf.readUInt16LE(pos);
    pos += 2;
  }
  return buf.subarray(pos, Math.min(pos + len * 2, buf.length)).toString('utf16le');
}

// ---------------------------------------------------------------------------
// Query helpers used by the APK inspector
// ---------------------------------------------------------------------------

export function findElements(manifest: ParsedManifest, name: string): AxmlElement[] {
  return manifest.all.filter((e) => e.name === name);
}

export function attr(el: AxmlElement, name: string): string | null {
  const found = el.attributes.find((a) => a.name === name);
  if (!found || found.value === null) return null;
  return String(found.value);
}

export function attrNumber(el: AxmlElement, name: string): number | null {
  const found = el.attributes.find((a) => a.name === name);
  if (!found || typeof found.value !== 'number') return null;
  return found.value;
}
