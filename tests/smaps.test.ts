/**
 * Per-mapping memory tests.
 *
 * This is the layer that turns "Graphics grew 137 MB" into "the GPU driver's
 * allocations grew 137 MB", so the things worth asserting are that the grouping
 * adds up, that the Unity-facing names are right, and that a mapping the tool
 * cannot identify stays unidentified rather than being guessed at.
 */
import { describe, expect, it } from 'vitest';

import { classifyMapping, normalizeMappingName, parseMeminfo, parseSmaps } from '../src/telemetry/probes.js';

const MB = 1024 * 1024;

/** One smaps entry, in the layout the kernel actually emits. */
function entry(path: string, pssKb: number, privateDirtyKb = pssKb, privateCleanKb = 0): string {
  return [
    `7f8a000000-7f8a100000 rw-p 00000000 00:00 0    ${path}`,
    `Size:               ${pssKb} kB`,
    `Rss:                ${pssKb} kB`,
    `Pss:                ${pssKb} kB`,
    `Shared_Clean:          0 kB`,
    `Shared_Dirty:          0 kB`,
    `Private_Clean:      ${privateCleanKb} kB`,
    `Private_Dirty:      ${privateDirtyKb} kB`,
    `VmFlags: rd wr mr mw me ac`,
  ].join('\n');
}

describe('parseSmaps', () => {
  it('groups every region of one mapping into a single row', () => {
    // A library appears once per segment, and the allocator once per arena.
    const text = [
      entry('/data/app/~~aB3xQ==/com.game-1/lib/arm64/libil2cpp.so', 40_000),
      entry('/data/app/~~aB3xQ==/com.game-1/lib/arm64/libil2cpp.so', 20_000),
      entry('[anon:libc_malloc]', 10_000),
      entry('[anon:libc_malloc]', 10_000),
      entry('[anon:libc_malloc]', 10_000),
    ].join('\n');

    const rows = parseSmaps(text);
    const il2cpp = rows.find((r) => r.name === 'libil2cpp.so');
    const malloc = rows.find((r) => r.name === '[anon:libc_malloc]');

    expect(il2cpp?.pssBytes).toBe(60_000 * 1024);
    expect(il2cpp?.regions).toBe(2);
    expect(malloc?.pssBytes).toBe(30_000 * 1024);
    expect(malloc?.regions).toBe(3);
  });

  it('ranks by size, because the biggest holder is the question being asked', () => {
    const text = [
      entry('/dev/kgsl-3d0', 300_000),
      entry('/data/app/~~x==/com.game-1/lib/arm64/libunity.so', 30_000),
      entry('[anon:libc_malloc]', 120_000),
    ].join('\n');

    expect(parseSmaps(text).map((r) => r.name)).toEqual([
      '/dev/kgsl-3d',
      '[anon:libc_malloc]',
      'libunity.so',
    ]);
  });

  it('sums private dirty and clean separately from PSS', () => {
    // Shared library pages inflate PSS but are not freed with the process, so
    // the two numbers have to stay distinct.
    const text = entry('/data/app/~~x==/com.game-1/lib/arm64/libunity.so', 10_000, 2_000, 500);
    const [row] = parseSmaps(text);

    expect(row!.pssBytes).toBe(10_000 * 1024);
    expect(row!.privateBytes).toBe(2_500 * 1024);
  });

  it('keeps what it cut as one honest row rather than dropping it', () => {
    // A list that does not add up invites the wrong conclusion about where the
    // memory went, so the tail is summed rather than discarded.
    const text = Array.from({ length: 12 }, (_, i) => entry(`/lib/lib${i}.so`, (12 - i) * 1000)).join('\n');
    const rows = parseSmaps(text, { limit: 5 });

    expect(rows).toHaveLength(6);
    expect(rows[5]!.name).toBe('7 smaller mappings');
    expect(rows[5]!.regions).toBe(7);

    const totalKept = rows.reduce((sum, r) => sum + r.pssBytes, 0);
    const totalAll = parseSmaps(text, { limit: 99 }).reduce((sum, r) => sum + r.pssBytes, 0);
    expect(totalKept).toBe(totalAll);
  });

  it('returns nothing for output that is not smaps', () => {
    expect(parseSmaps('')).toEqual([]);
    expect(parseSmaps('Permission denied')).toEqual([]);
  });
});

describe('normalizeMappingName', () => {
  it('drops the random APK directory so one library is one row', () => {
    // The `~~aB3xQ==` segment is regenerated on every install; keeping it would
    // split the same library across runs.
    expect(normalizeMappingName('/data/app/~~aB3xQ==/com.game-1/lib/arm64/libunity.so')).toBe(
      'libunity.so',
    );
    expect(normalizeMappingName('/data/app/~~zZ9==/com.game-2/base.apk')).toBe('base.apk');
  });

  it('keeps device nodes whole but drops their unit number', () => {
    expect(normalizeMappingName('/dev/kgsl-3d0')).toBe('/dev/kgsl-3d');
    expect(normalizeMappingName('/dev/mali0')).toBe('/dev/mali');
  });

  it('keeps anonymous region names as they are', () => {
    expect(normalizeMappingName('[anon:libc_malloc]')).toBe('[anon:libc_malloc]');
    expect(normalizeMappingName('[stack]')).toBe('[stack]');
  });

  it('names an unnamed region rather than leaving it blank', () => {
    expect(normalizeMappingName('')).toBe('[anonymous]');
  });
});

describe('classifyMapping', () => {
  it('tells the engine apart from the game’s own code', () => {
    // The distinction a developer needs first: Unity's cost versus theirs.
    expect(classifyMapping('libunity.so')).toBe('unity-engine');
    expect(classifyMapping('libil2cpp.so')).toBe('game-code');
    expect(classifyMapping('libmonobdwgc-2.0.so')).toBe('game-code');
  });

  it('recognises GPU memory whatever the vendor calls it', () => {
    expect(classifyMapping('/dev/kgsl-3d')).toBe('graphics');
    expect(classifyMapping('/dev/mali')).toBe('graphics');
    expect(classifyMapping('/dmabuf')).toBe('graphics');
  });

  it('recognises where Unity content is actually read from', () => {
    expect(classifyMapping('base.apk')).toBe('app-package');
    expect(classifyMapping('main.1.obb')).toBe('app-package');
  });

  it('recognises the native allocator, where leaks accumulate', () => {
    expect(classifyMapping('[anon:libc_malloc]')).toBe('native-alloc');
    expect(classifyMapping('[anon:scudo:primary]')).toBe('native-alloc');
  });

  it('leaves an unrecognised mapping unidentified instead of guessing', () => {
    expect(classifyMapping('[anon:.bss]')).toBe('other');
    expect(classifyMapping('some-random-file')).toBe('other');
  });
});

describe('parseMeminfo private columns', () => {
  it('reads private dirty + clean alongside PSS', () => {
    // App Summary categories are sums of *private* memory, so a per-category
    // breakdown built from the PSS column would not add up to the number above it.
    const text = [
      'Applications Memory Usage (in Kilobytes):',
      '',
      '                   Pss  Private  Private  SwapPss      Rss',
      '                 Total    Dirty    Clean    Dirty    Total',
      '                ------   ------   ------   ------   ------',
      '  Native Heap   204800   204800        0        0   210000',
      '  Dalvik Heap    30000    28000      500        0    31000',
      '     .so mmap   120000    12000    40000        0   180000',
      '      Gfx dev   307200   307200        0        0   307200',
      '        TOTAL   700000   560000    40500        0   740000',
      '',
      ' App Summary',
      '                       Pss(KB)',
      '                        ------',
      '           Java Heap:    28500',
      '         Native Heap:   204800',
      '                Code:    52000',
      '            Graphics:   307200',
      '           TOTAL PSS:   700000',
    ].join('\n');

    const reading = parseMeminfo(text);

    expect(reading.breakdown?.gfxDev).toBe(307_200 * 1024);
    expect(reading.breakdownPrivate?.gfxDev).toBe(307_200 * 1024);

    // The one that matters: .so mmap has 120 MB of PSS but only 52 MB private,
    // and 52 MB is what the Code summary reports.
    expect(reading.breakdown?.soMmap).toBe(120_000 * 1024);
    expect(reading.breakdownPrivate?.soMmap).toBe(52_000 * 1024);
    expect(reading.summary?.code).toBe(52_000 * 1024);

    expect(reading.breakdownPrivate?.dalvikHeap).toBe(28_500 * 1024);
    expect(reading.summary?.javaHeap).toBe(28_500 * 1024);
  });

  it('still parses layouts with no Rss column', () => {
    // Older builds emit fewer columns; Private Dirty and Private Clean stay at
    // the same indexes, which is the whole reason we key off them.
    const text = [
      '                   Pss  Private  Private   Heap     Heap     Heap',
      '                 Total    Dirty    Clean   Size    Alloc     Free',
      '  Native Heap    51200    51200        0  60000    50000    10000',
      '      Gfx dev   102400   102400        0      0        0        0',
    ].join('\n');

    const reading = parseMeminfo(text);
    expect(reading.breakdownPrivate?.nativeHeap).toBe(51_200 * 1024);
    expect(reading.breakdownPrivate?.gfxDev).toBe(102_400 * 1024);
  });
});

describe('the numbers stay consistent', () => {
  it('graphics sub-rows add up to the graphics summary', () => {
    // The promise the drill-down makes: open a category and the rows inside it
    // account for it. Gfx dev + EGL + GL is exactly how Android computes it.
    const text = [
      '                   Pss  Private  Private  SwapPss      Rss',
      '  Native Heap    51200    51200        0        0    51200',
      '      Gfx dev   307200   307200        0        0   307200',
      '   EGL mtrack    81920    81920        0        0    81920',
      '    GL mtrack    20480    20480        0        0    20480',
      '',
      ' App Summary',
      '            Graphics:   409600',
    ].join('\n');

    const r = parseMeminfo(text);
    const p = r.breakdownPrivate!;
    const graphicsRows = (p.gfxDev ?? 0) + (p.eglMtrack ?? 0) + (p.glMtrack ?? 0);

    expect(graphicsRows).toBe(r.summary!.graphics);
    expect(graphicsRows).toBe(400 * MB);
  });
});
