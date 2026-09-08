/**
 * Builds a real binary AndroidManifest.xml (AXML) chunk stream.
 *
 * The APK inspector's whole value depends on parsing this format correctly
 * without the Android SDK, so the test fixture emits genuine chunk structures -
 * string pool, start/end elements, typed attribute values - rather than a stub
 * the parser could accidentally accept.
 *
 * Layout per AOSP androidfw/ResourceTypes.h.
 */

const CHUNK_XML_FILE = 0x0003;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_START_ELEMENT = 0x0102;
const CHUNK_END_ELEMENT = 0x0103;
const UTF8_FLAG = 1 << 8;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_BOOLEAN = 0x12;

export interface AxmlAttr {
  name: string;
  value: string | number | boolean;
}

export interface AxmlNode {
  name: string;
  attrs?: AxmlAttr[];
  children?: AxmlNode[];
}

class StringPool {
  private readonly strings: string[] = [];
  private readonly index = new Map<string, number>();

  add(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const id = this.strings.length;
    this.strings.push(value);
    this.index.set(value, id);
    return id;
  }

  build(): Buffer {
    const encoded = this.strings.map(encodeUtf8Entry);
    const offsets = Buffer.alloc(this.strings.length * 4);
    let running = 0;
    encoded.forEach((buf, i) => {
      offsets.writeUInt32LE(running, i * 4);
      running += buf.length;
    });

    const data = Buffer.concat(encoded);
    // Chunks must be 4-byte aligned.
    const padding = Buffer.alloc((4 - (data.length % 4)) % 4);

    const headerSize = 28;
    const size = headerSize + offsets.length + data.length + padding.length;
    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(CHUNK_STRING_POOL, 0);
    header.writeUInt16LE(headerSize, 2);
    header.writeUInt32LE(size, 4);
    header.writeUInt32LE(this.strings.length, 8);
    header.writeUInt32LE(0, 12); // styleCount
    header.writeUInt32LE(UTF8_FLAG, 16);
    header.writeUInt32LE(headerSize + offsets.length, 20); // stringsStart
    header.writeUInt32LE(0, 24); // stylesStart

    return Buffer.concat([header, offsets, data, padding]);
  }
}

/** UTF-8 pool entry: char length, byte length, bytes, NUL terminator. */
function encodeUtf8Entry(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([
    Buffer.from([Math.min(value.length, 0x7f), Math.min(bytes.length, 0x7f)]),
    bytes,
    Buffer.from([0]),
  ]);
}

export function buildAxml(root: AxmlNode): Buffer {
  const pool = new StringPool();

  // Intern every string first so indices are stable when the chunks are built.
  const intern = (node: AxmlNode): void => {
    pool.add(node.name);
    for (const attr of node.attrs ?? []) {
      pool.add(attr.name);
      if (typeof attr.value === 'string') pool.add(attr.value);
    }
    for (const child of node.children ?? []) intern(child);
  };
  intern(root);

  const poolChunk = pool.build();
  const body: Buffer[] = [];

  const emit = (node: AxmlNode): void => {
    body.push(startElement(pool, node));
    for (const child of node.children ?? []) emit(child);
    body.push(endElement(pool, node));
  };
  emit(root);

  const bodyBuf = Buffer.concat(body);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(CHUNK_XML_FILE, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + poolChunk.length + bodyBuf.length, 4);

  return Buffer.concat([header, poolChunk, bodyBuf]);
}

function startElement(pool: StringPool, node: AxmlNode): Buffer {
  const attrs = node.attrs ?? [];
  const headerSize = 16;
  const extSize = 20;
  const attrSize = 20;
  const size = headerSize + extSize + attrs.length * attrSize;

  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(CHUNK_START_ELEMENT, 0);
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(size, 4);
  buf.writeUInt32LE(1, 8); // lineNumber
  buf.writeUInt32LE(0xffffffff, 12); // comment

  const ext = headerSize;
  buf.writeUInt32LE(0xffffffff, ext); // namespace
  buf.writeUInt32LE(pool.add(node.name), ext + 4);
  buf.writeUInt16LE(extSize, ext + 8); // attributeStart
  buf.writeUInt16LE(attrSize, ext + 10);
  buf.writeUInt16LE(attrs.length, ext + 12);
  buf.writeUInt16LE(0, ext + 14); // idIndex
  buf.writeUInt16LE(0, ext + 16); // classIndex
  buf.writeUInt16LE(0, ext + 18); // styleIndex

  attrs.forEach((attr, i) => {
    const at = ext + extSize + i * attrSize;
    buf.writeUInt32LE(0xffffffff, at); // namespace
    buf.writeUInt32LE(pool.add(attr.name), at + 4);

    if (typeof attr.value === 'string') {
      buf.writeUInt32LE(pool.add(attr.value), at + 8); // rawValue
      buf.writeUInt16LE(8, at + 12); // typed value size
      buf.writeUInt8(0, at + 14); // res0
      buf.writeUInt8(TYPE_STRING, at + 15);
      buf.writeUInt32LE(pool.add(attr.value), at + 16);
    } else if (typeof attr.value === 'boolean') {
      buf.writeUInt32LE(0xffffffff, at + 8);
      buf.writeUInt16LE(8, at + 12);
      buf.writeUInt8(0, at + 14);
      buf.writeUInt8(TYPE_INT_BOOLEAN, at + 15);
      buf.writeUInt32LE(attr.value ? 0xffffffff : 0, at + 16);
    } else {
      buf.writeUInt32LE(0xffffffff, at + 8);
      buf.writeUInt16LE(8, at + 12);
      buf.writeUInt8(0, at + 14);
      buf.writeUInt8(TYPE_INT_DEC, at + 15);
      buf.writeUInt32LE(attr.value, at + 16);
    }
  });

  return buf;
}

function endElement(pool: StringPool, node: AxmlNode): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt16LE(CHUNK_END_ELEMENT, 0);
  buf.writeUInt16LE(16, 2);
  buf.writeUInt32LE(24, 4);
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(0xffffffff, 12);
  buf.writeUInt32LE(0xffffffff, 16); // namespace
  buf.writeUInt32LE(pool.add(node.name), 20);
  return buf;
}

/** A realistic Unity game manifest. */
export function unityManifest(packageName = 'com.fixture.game'): Buffer {
  return buildAxml({
    name: 'manifest',
    attrs: [
      { name: 'package', value: packageName },
      { name: 'versionCode', value: 42 },
      { name: 'versionName', value: '1.4.2' },
    ],
    children: [
      {
        name: 'uses-sdk',
        attrs: [
          { name: 'minSdkVersion', value: 24 },
          { name: 'targetSdkVersion', value: 34 },
        ],
      },
      { name: 'uses-permission', attrs: [{ name: 'name', value: 'android.permission.INTERNET' }] },
      {
        name: 'application',
        attrs: [
          { name: 'label', value: 'Fixture Game' },
          { name: 'largeHeap', value: 'true' },
          { name: 'debuggable', value: 'false' },
        ],
        children: [
          {
            name: 'activity',
            attrs: [{ name: 'name', value: 'com.unity3d.player.UnityPlayerActivity' }],
            children: [
              {
                name: 'intent-filter',
                children: [
                  { name: 'action', attrs: [{ name: 'name', value: 'android.intent.action.MAIN' }] },
                  {
                    name: 'category',
                    attrs: [{ name: 'name', value: 'android.intent.category.LAUNCHER' }],
                  },
                ],
              },
            ],
          },
          {
            name: 'meta-data',
            attrs: [
              { name: 'name', value: 'unity.splash-mode' },
              { name: 'value', value: '0' },
            ],
          },
        ],
      },
    ],
  });
}
