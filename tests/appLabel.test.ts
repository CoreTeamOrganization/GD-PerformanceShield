/**
 * Resource-table and app-label tests.
 *
 * The point of this code is turning `com.fcg.briderush.drawlines.drawtohome`
 * into "Wedding Rush Draw Puzzle", so these tests resolve a real resource id out
 * of a genuinely structured resources.arsc rather than a stub.
 */
import { describe, expect, it } from 'vitest';

import { parseResourceTable } from '../src/apk/arsc.js';
import {
  findEocd,
  isResourceReference,
  parseResourceReference,
  readCentralDirectory,
} from '../src/devices/appLabel.js';
import { buildArsc, resourceId } from './fixtures/arsc.js';

describe('resources.arsc parsing', () => {
  it('resolves an app name from its resource id', () => {
    const arsc = buildArsc({
      strings: ['Some Other String', 'Wedding Rush Draw Puzzle', 'Settings'],
      entries: new Map([[1, 1]]), // entry 1 -> string 1
    });

    const table = parseResourceTable(arsc);
    expect(table).not.toBeNull();
    expect(table!.resolveString(resourceId(0x7f, 0x11, 1))).toBe('Wedding Rush Draw Puzzle');
  });

  it('handles several entries in one type', () => {
    const arsc = buildArsc({
      strings: ['Granny Rush', 'Penguin Rush', 'Dye Rush'],
      entries: new Map([
        [0, 0],
        [3, 1],
        [7, 2],
      ]),
    });
    const table = parseResourceTable(arsc)!;
    expect(table.resolveString(resourceId(0x7f, 0x11, 0))).toBe('Granny Rush');
    expect(table.resolveString(resourceId(0x7f, 0x11, 3))).toBe('Penguin Rush');
    expect(table.resolveString(resourceId(0x7f, 0x11, 7))).toBe('Dye Rush');
  });

  it('reads a sparse entry index', () => {
    // Modern builds often emit sparse indexes to shrink the table.
    const arsc = buildArsc({
      strings: ['Sparse Name'],
      entries: new Map([[500, 0]]),
      sparse: true,
    });
    const table = parseResourceTable(arsc)!;
    expect(table.resolveString(resourceId(0x7f, 0x11, 500))).toBe('Sparse Name');
  });

  it('prefers the default configuration over a localised one', () => {
    // A localised chunk is emitted first; the default must still win, otherwise
    // an English build would show a French name.
    const arsc = buildArsc({
      strings: ['Nom Francais', 'English Name'],
      localeEntries: new Map([[1, 0]]),
      locale: 'fr',
      entries: new Map([[1, 1]]),
    });
    const table = parseResourceTable(arsc)!;
    expect(table.resolveString(resourceId(0x7f, 0x11, 1))).toBe('English Name');
  });

  it('returns null for an id that holds nothing', () => {
    const arsc = buildArsc({ strings: ['Only One'], entries: new Map([[0, 0]]) });
    const table = parseResourceTable(arsc)!;
    expect(table.resolveString(resourceId(0x7f, 0x11, 99))).toBeNull();
  });

  it('respects a non-default package id', () => {
    const arsc = buildArsc({
      strings: ['Shared Lib Name'],
      packageId: 0x02,
      entries: new Map([[4, 0]]),
    });
    const table = parseResourceTable(arsc)!;
    expect(table.resolveString(resourceId(0x02, 0x11, 4))).toBe('Shared Lib Name');
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(parseResourceTable(Buffer.alloc(4))).toBeNull();
    expect(parseResourceTable(Buffer.from('not a resource table'))).toBeNull();
    // A plausible header with a truncated body must not crash the app list.
    const truncated = Buffer.alloc(12);
    truncated.writeUInt16LE(0x0002, 0);
    truncated.writeUInt16LE(12, 2);
    truncated.writeUInt32LE(9999, 4);
    truncated.writeUInt32LE(1, 8);
    expect(parseResourceTable(truncated)).toBeNull();
  });
});

describe('resource references', () => {
  it('recognises the bare-hex form the AXML parser actually emits', () => {
    // The exact form seen leaking into the app list as a name.
    expect(isResourceReference('@7f120028')).toBe(true);
    expect(parseResourceReference('@7f120028')).toBe(0x7f120028);
    expect(isResourceReference('@7f12005d')).toBe(true);
    expect(parseResourceReference('@7f12005d')).toBe(0x7f12005d);
  });

  it('does not mistake a numeric app name for a reference', () => {
    // A game really can be called this.
    expect(isResourceReference('2048')).toBe(false);
    expect(isResourceReference('1010')).toBe(false);
    // But a real resource id is far larger.
    expect(isResourceReference('2131886081')).toBe(true);
  });

  it('tells a reference apart from a literal name', () => {
    expect(isResourceReference('@0x7f110001')).toBe(true);
    expect(isResourceReference('0x7f110001')).toBe(true);
    expect(isResourceReference('2131886081')).toBe(true);
    expect(isResourceReference('Wedding Rush Draw Puzzle')).toBe(false);
    expect(isResourceReference('My Game 2')).toBe(false);
    // All-hex words are real app names, and have no @ or 0x marker.
    expect(isResourceReference('Face')).toBe(false);
    expect(isResourceReference('Decade')).toBe(false);
    expect(isResourceReference('abba')).toBe(false);
  });

  it('parses both hex and decimal forms', () => {
    expect(parseResourceReference('@0x7f110001')).toBe(0x7f110001);
    expect(parseResourceReference('0x7f110001')).toBe(0x7f110001);
    expect(parseResourceReference('2131886081')).toBe(2131886081);
    expect(parseResourceReference('nonsense')).toBeNull();
  });
});

describe('partial ZIP reading', () => {
  it('finds the end-of-central-directory record behind a comment', () => {
    const eocd = Buffer.alloc(22 + 5);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(7, 10); // entry count
    eocd.writeUInt32LE(1234, 12); // directory size
    eocd.writeUInt32LE(5678, 16); // directory offset
    eocd.writeUInt16LE(5, 20); // comment length
    eocd.write('hello', 22);

    const tail = Buffer.concat([Buffer.alloc(400, 0xab), eocd]);
    const found = findEocd(tail);
    expect(found).toEqual({ entryCount: 7, directorySize: 1234, directoryOffset: 5678 });
  });

  it('returns null when there is no record', () => {
    expect(findEocd(Buffer.alloc(200, 0x11))).toBeNull();
  });

  it('reads central-directory entries by name', () => {
    const entry = (name: string, method: number, compressed: number, offset: number) => {
      const nameBuf = Buffer.from(name, 'utf8');
      const buf = Buffer.alloc(46 + nameBuf.length);
      buf.writeUInt32LE(0x02014b50, 0);
      buf.writeUInt16LE(method, 10);
      buf.writeUInt32LE(compressed, 20);
      buf.writeUInt32LE(compressed * 2, 24);
      buf.writeUInt16LE(nameBuf.length, 28);
      buf.writeUInt32LE(offset, 42);
      nameBuf.copy(buf, 46);
      return buf;
    };

    const central = Buffer.concat([
      entry('AndroidManifest.xml', 8, 4096, 100),
      // resources.arsc must be stored, since Android mmaps it.
      entry('resources.arsc', 0, 65536, 9000),
      entry('classes.dex', 8, 500000, 80000),
    ]);

    const entries = readCentralDirectory(central, 3);
    expect([...entries.keys()]).toEqual([
      'AndroidManifest.xml',
      'resources.arsc',
      'classes.dex',
    ]);
    expect(entries.get('resources.arsc')).toMatchObject({
      compressionMethod: 0,
      compressedSize: 65536,
      localHeaderOffset: 9000,
    });
  });

  it('stops cleanly on a truncated directory', () => {
    expect(readCentralDirectory(Buffer.alloc(10), 5).size).toBe(0);
  });
});
