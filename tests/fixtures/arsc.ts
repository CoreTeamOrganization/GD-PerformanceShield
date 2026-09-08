/**
 * Builds a real `resources.arsc` chunk stream.
 *
 * The parser's whole value is resolving an app's display name from a resource
 * id, so the fixture emits genuine chunk structures — table header, global
 * string pool, package, type spec and type chunks with a dense entry index —
 * rather than a stub the parser might accidentally accept.
 *
 * Layout per AOSP androidfw/ResourceTypes.h.
 */

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const UTF8_FLAG = 1 << 8;
const TYPE_STRING = 0x03;
const TYPE_FLAG_SPARSE = 0x01;

export interface ArscOptions {
  /** Strings placed in the table's global pool, in order. */
  strings: string[];
  packageId?: number;
  packageName?: string;
  typeId?: number;
  /** entry index -> index into `strings`. */
  entries: Map<number, number>;
  /** Emit the entry index as a sparse id/offset table. */
  sparse?: boolean;
  /** Emit a non-default configuration (a locale), which must lose to default. */
  locale?: string;
  /** Extra type chunk carrying different values, emitted before the default. */
  localeEntries?: Map<number, number>;
}

/** UTF-8 pool entry: char length, byte length, bytes, NUL. */
function utf8Entry(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([
    Buffer.from([Math.min(value.length, 0x7f), Math.min(bytes.length, 0x7f)]),
    bytes,
    Buffer.from([0]),
  ]);
}

function stringPool(strings: string[]): Buffer {
  const encoded = strings.map(utf8Entry);
  const offsets = Buffer.alloc(strings.length * 4);
  let running = 0;
  encoded.forEach((buf, i) => {
    offsets.writeUInt32LE(running, i * 4);
    running += buf.length;
  });

  const data = Buffer.concat(encoded);
  const padding = Buffer.alloc((4 - (data.length % 4)) % 4);

  const headerSize = 28;
  const size = headerSize + offsets.length + data.length + padding.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(size, 4);
  header.writeUInt32LE(strings.length, 8);
  header.writeUInt32LE(0, 12); // styleCount
  header.writeUInt32LE(UTF8_FLAG, 16);
  header.writeUInt32LE(headerSize + offsets.length, 20); // stringsStart
  header.writeUInt32LE(0, 24); // stylesStart

  return Buffer.concat([header, offsets, data, padding]);
}

/** One Res_value: size(2) res0(1) dataType(1) data(4). */
function resValue(stringIndex: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(8, 0);
  buf.writeUInt8(0, 2);
  buf.writeUInt8(TYPE_STRING, 3);
  buf.writeUInt32LE(stringIndex, 4);
  return buf;
}

/** ResTable_entry (8 bytes) followed by its value. */
function entryBlock(keyIndex: number, stringIndex: number): Buffer {
  const entry = Buffer.alloc(8);
  entry.writeUInt16LE(8, 0); // entry header size
  entry.writeUInt16LE(0, 2); // flags: simple value, not complex
  entry.writeUInt32LE(keyIndex, 4); // key string index (unused by the parser)
  return Buffer.concat([entry, resValue(stringIndex)]);
}

function typeChunk(opts: {
  typeId: number;
  entries: Map<number, number>;
  entryCount: number;
  sparse: boolean;
  locale?: string;
}): Buffer {
  const { typeId, entries, entryCount, sparse } = opts;

  // ResTable_config: size prefix then the body. All-zero body = default config.
  const configSize = 56;
  const config = Buffer.alloc(configSize);
  config.writeUInt32LE(configSize, 0);
  if (opts.locale) {
    // Any non-zero byte in the body makes it a non-default configuration.
    config.write(opts.locale.slice(0, 2), 8, 'latin1');
  }

  const headerSize = 20 + configSize;

  const indexed = [...entries.entries()].sort((a, b) => a[0] - b[0]);

  const blocks: Buffer[] = [];
  const offsetByEntry = new Map<number, number>();
  let running = 0;
  for (const [entryIndex, stringIndex] of indexed) {
    offsetByEntry.set(entryIndex, running);
    const block = entryBlock(0, stringIndex);
    blocks.push(block);
    running += block.length;
  }
  const data = Buffer.concat(blocks);

  let index: Buffer;
  if (sparse) {
    index = Buffer.alloc(indexed.length * 4);
    indexed.forEach(([entryIndex], i) => {
      index.writeUInt16LE(entryIndex, i * 4);
      index.writeUInt16LE(offsetByEntry.get(entryIndex)! / 4, i * 4 + 2);
    });
  } else {
    index = Buffer.alloc(entryCount * 4);
    for (let i = 0; i < entryCount; i++) {
      const offset = offsetByEntry.get(i);
      index.writeUInt32LE(offset === undefined ? 0xffffffff : offset, i * 4);
    }
  }

  const size = headerSize + index.length + data.length;
  const header = Buffer.alloc(20);
  header.writeUInt16LE(RES_TABLE_TYPE_TYPE, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(size, 4);
  header.writeUInt8(typeId, 8);
  header.writeUInt8(sparse ? TYPE_FLAG_SPARSE : 0, 9);
  header.writeUInt16LE(0, 10); // reserved
  header.writeUInt32LE(sparse ? indexed.length : entryCount, 12);
  header.writeUInt32LE(headerSize + index.length, 16); // entriesStart

  return Buffer.concat([header, config, index, data]);
}

function typeSpecChunk(typeId: number, entryCount: number): Buffer {
  const headerSize = 16;
  const size = headerSize + entryCount * 4;
  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(RES_TABLE_TYPE_SPEC_TYPE, 0);
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(size, 4);
  buf.writeUInt8(typeId, 8);
  buf.writeUInt32LE(entryCount, 12);
  return buf;
}

export function buildArsc(opts: ArscOptions): Buffer {
  const packageId = opts.packageId ?? 0x7f;
  const typeId = opts.typeId ?? 0x11;
  const entryCount = Math.max(...[...opts.entries.keys()], 0) + 1;

  const globalPool = stringPool(opts.strings);

  // Package chunk: header, then its own type-name and key-name pools, then the
  // type spec and type chunks.
  const typeNames = stringPool(['string']);
  const keyNames = stringPool(['app_name']);

  const chunks: Buffer[] = [typeNames, keyNames, typeSpecChunk(typeId, entryCount)];

  // A locale-specific chunk first, so a correct parser still prefers default.
  if (opts.localeEntries) {
    chunks.push(
      typeChunk({
        typeId,
        entries: opts.localeEntries,
        entryCount,
        sparse: false,
        locale: opts.locale ?? 'fr',
      }),
    );
  }

  chunks.push(
    typeChunk({ typeId, entries: opts.entries, entryCount, sparse: Boolean(opts.sparse) }),
  );

  const body = Buffer.concat(chunks);

  const pkgHeaderSize = 288;
  const pkgHeader = Buffer.alloc(pkgHeaderSize);
  pkgHeader.writeUInt16LE(RES_TABLE_PACKAGE_TYPE, 0);
  pkgHeader.writeUInt16LE(pkgHeaderSize, 2);
  pkgHeader.writeUInt32LE(pkgHeaderSize + body.length, 4);
  pkgHeader.writeUInt32LE(packageId, 8);
  // Package name: 128 UTF-16 code units at offset 12.
  pkgHeader.write(opts.packageName ?? 'com.example', 12, 'utf16le');
  pkgHeader.writeUInt32LE(pkgHeaderSize, 268); // typeStrings offset
  pkgHeader.writeUInt32LE(pkgHeaderSize + typeNames.length, 276); // keyStrings offset

  const pkg = Buffer.concat([pkgHeader, body]);

  const tableHeaderSize = 12;
  const tableHeader = Buffer.alloc(tableHeaderSize);
  tableHeader.writeUInt16LE(RES_TABLE_TYPE, 0);
  tableHeader.writeUInt16LE(tableHeaderSize, 2);
  tableHeader.writeUInt32LE(tableHeaderSize + globalPool.length + pkg.length, 4);
  tableHeader.writeUInt32LE(1, 8); // packageCount

  return Buffer.concat([tableHeader, globalPool, pkg]);
}

/** Compose a resource id from its parts. */
export function resourceId(packageId: number, typeId: number, entryIndex: number): number {
  return ((packageId & 0xff) << 24) | ((typeId & 0xff) << 16) | (entryIndex & 0xffff);
}
