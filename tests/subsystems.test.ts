/**
 * GPU, CPU threading, storage and audio: acquisition and reduction.
 *
 * What is being protected here is mostly one property, in five places: a figure
 * that could not be measured must come back as null and never as zero. A zero
 * GPU utilisation reads as "the GPU was idle", a zero read rate reads as
 * "nothing loaded", and a zero underrun count reads as "the audio was clean" -
 * each of which is the opposite of not knowing. Every counter these probes read
 * is also cumulative, so the second property under test is that a rate is a
 * difference between two reads and that the first read reports nothing.
 *
 * The parsers get real device output rather than invented output wherever the
 * format has a trap in it: /proc/<pid>/stat's comm field can contain spaces and
 * parentheses, and splitting it on whitespace silently shifts every later field
 * by one - which is the classic way to report a thread's CPU time as its
 * scheduling policy.
 */
import { describe, expect, it } from 'vitest';

import {
  parseEngineAudioLine,
  parseEngineRenderLine,
  EngineProfileTracker,
} from '../src/telemetry/engineProfile.js';
import { parseGpuBusy, summarizeGpu, summarizeRender, type GpuReading } from '../src/telemetry/gpu.js';
import {
  classifyClusters,
  classifyThread,
  parseCpuCurFreq,
  parseProcStat,
  parseProcessJiffies,
  parseThreadStats,
  summarizeCpu,
  type CpuReading,
} from '../src/telemetry/cpuThreads.js';
import { parseProcIo, summarizeDiskIo, type DiskIoReading } from '../src/telemetry/diskIo.js';
import { parseAudioFlinger, rateAudio, summarizeAudio } from '../src/telemetry/audio.js';

const MB = 1024 * 1024;

/**
 * A `/proc/<pid>/stat` line with the fields under test placed by number.
 *
 * Built rather than pasted because the field positions are the whole point.
 * `proc(5)` numbers them from 1 with `pid` first and `comm` second, so
 * `utime` is field 14, `stime` is 15 and `processor` - the core the thread last
 * ran on - is field 39. A hand-typed line with two zeros too few silently moves
 * `processor` and the test would pass against a parser reading the wrong column.
 */
function statLine(
  tid: number,
  comm: string,
  at: { utime: number; stime: number; processor: number },
): string {
  // Fields 3 to 44. Index i here is field i + 3.
  const fields = new Array<number | string>(42).fill(0);
  fields[0] = 'S'; // 3: state
  fields[11] = at.utime; // 14
  fields[12] = at.stime; // 15
  fields[36] = at.processor; // 39
  return `${tid} (${comm}) ${fields.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Engine channels
// ---------------------------------------------------------------------------

describe('the engine render and audio channels', () => {
  it('reads a render line, with the stage times that settle CPU against GPU', () => {
    const line =
      'I/Unity   ( 9042): OOMI/GFX {"ms":74320,"dc":2140,"batch":274,"sp":231,"tri":688000,' +
      '"vert":502000,"texB":431915008,"main":9.4,"render":6.1,"gpu":13.8}';

    const reading = parseEngineRenderLine(line);
    expect(reading).not.toBeNull();
    expect(reading!.drawCalls).toBe(2140);
    expect(reading!.batches).toBe(274);
    expect(reading!.setPassCalls).toBe(231);
    expect(reading!.triangles).toBe(688_000);
    expect(reading!.usedTextureBytes).toBe(431_915_008);
    expect(reading!.mainThreadMs).toBe(9.4);
    expect(reading!.renderThreadMs).toBe(6.1);
    expect(reading!.gpuFrameMs).toBe(13.8);
  });

  it('reads an audio line', () => {
    const reading = parseEngineAudioLine(
      'OOMI/SND {"ms":74320,"playing":24,"voices":28,"cpu":9.6,"dsp":2.8,"clips":62}',
    );
    expect(reading).not.toBeNull();
    expect(reading!.playingSources).toBe(24);
    expect(reading!.audioVoices).toBe(28);
    expect(reading!.totalCpuPercent).toBe(9.6);
    expect(reading!.dspCpuPercent).toBe(2.8);
  });

  it('rejects anything that is not one of its own lines, so it can be fed every log line', () => {
    for (const line of [
      'I/Unity   ( 9042): Loading scene Level3',
      'OOMI/GFX not json',
      'OOMI/GFX {"ms":1}', // a timestamp with no counter says nothing
      'OOMI/GFX {broken',
      'OOMI/MEM {"tex":123}', // the memory channel belongs to the other parser
    ]) {
      expect(parseEngineRenderLine(line)).toBeNull();
    }
  });

  it('names the counters this engine version could not supply', () => {
    const reading = parseEngineRenderLine(
      'OOMI/GFX {"ms":1,"dc":40,"na":["GPU Frame Time","Shadow Casters Count"]}',
    );
    expect(reading!.unavailable).toEqual(['GPU Frame Time', 'Shadow Casters Count']);
  });

  it('keeps every reading, not only the latest, so a peak between ticks is not lost', () => {
    const tracker = new EngineProfileTracker();

    expect(tracker.ingest('OOMI/GFX {"ms":1000,"dc":300}')).toBe(true);
    expect(tracker.ingest('OOMI/GFX {"ms":2000,"dc":2140}')).toBe(true);
    expect(tracker.ingest('OOMI/GFX {"ms":3000,"dc":310}')).toBe(true);
    expect(tracker.ingest('I/ActivityManager: something else')).toBe(false);

    // The sampler would only ever have seen 310. The peak is the figure that
    // matters, and it is only in the history.
    expect(tracker.currentRender()!.drawCalls).toBe(310);
    expect(summarizeRender(tracker.renderReadings).peakDrawCalls).toBe(2140);
  });
});

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

describe('GPU load', () => {
  it('reads the Adreno tick counters', () => {
    expect(parseGpuBusy('  1442334 6210991\n')).toEqual({ busy: 1_442_334, total: 6_210_991 });
    expect(parseGpuBusy('not numbers')).toBeNull();
    expect(parseGpuBusy('1442334')).toBeNull();
  });

  it('reports nothing rather than zero when no interface answered', () => {
    const summary = summarizeGpu([], 'No GPU load interface answered on this device.');

    expect(summary.averageUtilizationPercent).toBeNull();
    expect(summary.peakUtilizationPercent).toBeNull();
    expect(summary.saturatedSamplePercent).toBeNull();
    // The reason is the only part of "not measured" a reader can act on.
    expect(summary.unavailableReason).toContain('No GPU load interface');
  });

  it('summarises load, and counts how much of the session was saturated', () => {
    const readings: GpuReading[] = [
      // The first sample of a tick-counter source has no baseline to difference
      // against, so it carries no utilisation. It must not be averaged in as 0.
      { utilizationPercent: null, clockMhz: 600, maxClockMhz: 940, source: 'kgsl-busy' },
      { utilizationPercent: 60, clockMhz: 700, maxClockMhz: 940, source: 'kgsl-busy' },
      { utilizationPercent: 94, clockMhz: 940, maxClockMhz: 940, source: 'kgsl-busy' },
      { utilizationPercent: 96, clockMhz: 930, maxClockMhz: 940, source: 'kgsl-busy' },
    ];

    const summary = summarizeGpu(readings, null);
    expect(summary.averageUtilizationPercent).toBe(83.3);
    expect(summary.peakUtilizationPercent).toBe(96);
    // Two of the three utilisation samples were above 90%.
    expect(summary.saturatedSamplePercent).toBe(66.7);
    // Two of four clock samples were within 5% of the 940 MHz ceiling.
    expect(summary.clockPinnedPercent).toBe(50);
    expect(summary.source).toBe('kgsl-busy');
  });

  it('says the engine reporter was absent rather than reporting no draw calls', () => {
    const summary = summarizeRender([]);
    expect(summary.averageDrawCalls).toBeNull();
    expect(summary.averageGpuFrameMs).toBeNull();
    expect(summary.sampleCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

describe('CPU cores and threads', () => {
  it('reads per-core jiffies, counting iowait as idle', () => {
    const cores = parseProcStat(
      [
        'cpu  1000 20 300 8000 100 5 5 0 0 0',
        'cpu0 100 0 50 800 50 0 0 0 0 0',
        'cpu1 200 0 60 700 0 0 0 0 0 0',
        'intr 12345',
      ].join('\n'),
    );

    expect(cores.size).toBe(2);
    // cpu0: total 1000, idle 800 + iowait 50 = 850, so busy is 150. A core
    // waiting on flash is not executing anything, and counting iowait as busy
    // would make a disk stall look like a CPU bottleneck.
    expect(cores.get(0)).toEqual({ busy: 150, total: 1000 });
    expect(cores.get(1)).toEqual({ busy: 260, total: 960 });
  });

  it('finds utime and stime past a comm field containing spaces and brackets', () => {
    // The trap: `Job.Worker 0` contains a space, and some thread names contain
    // parentheses. Splitting the line on whitespace shifts every later field.
    const line =
      '9051 (Job.Worker 0) S 1 9042 0 0 -1 1077936192 400 0 0 0 ' +
      '815 233 0 0 20 0 84 0 5512 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 6';

    expect(parseProcessJiffies(line)).toEqual({ busy: 815 + 233 });
  });

  it('reads every thread in one concatenated /proc read, with the core each ran on', () => {
    const text = [
      statLine(9042, 'UnityMain', { utime: 6240, stime: 1810, processor: 7 }),
      statLine(9070, 'UnityGfxDeviceW', { utime: 3890, stime: 640, processor: 6 }),
      '',
    ].join('\n');

    const threads = parseThreadStats(text);
    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({ tid: 9042, name: 'UnityMain', busy: 8050, lastCpu: 7 });
    expect(threads[1]!.name).toBe('UnityGfxDeviceW');
    expect(threads[1]!.lastCpu).toBe(6);
  });

  it('leaves an offline core out of the frequency map rather than recording it as 0 MHz', () => {
    // A core that is hotplugged out prints nothing. Recording that as zero
    // would put a parked big core into the average as though it were idling.
    const freqs = parseCpuCurFreq(['0:1440000', '1:', '2:2400000'].join('\n'));
    expect([...freqs.keys()]).toEqual([0, 2]);
  });

  it('finds clusters from the frequencies cores share as their ceiling', () => {
    // The 2+6 arrangement: two distinct ceilings, so little and big.
    const twoCluster = classifyClusters(
      new Map([
        [0, 2_000_000],
        [1, 2_000_000],
        [6, 2_400_000],
        [7, 2_400_000],
      ]),
    );
    expect(twoCluster.get(0)).toBe('little');
    expect(twoCluster.get(7)).toBe('big');

    // The 1+3+4 arrangement most current phones use: everything between the
    // extremes is mid.
    const threeCluster = classifyClusters(
      new Map([
        [0, 1_800_000],
        [4, 2_400_000],
        [7, 3_200_000],
      ]),
    );
    expect(threeCluster.get(0)).toBe('little');
    expect(threeCluster.get(4)).toBe('mid');
    expect(threeCluster.get(7)).toBe('big');

    // One ceiling means a uniform SoC. Calling all of it "big" would be a claim
    // about hardware that is not there.
    const uniform = classifyClusters(
      new Map([
        [0, 2_000_000],
        [1, 2_000_000],
      ]),
    );
    expect([...uniform.values()]).toEqual(['uniform', 'uniform']);
  });

  it('names the three threads that decide a frame, truncation included', () => {
    // The kernel truncates comm to 15 characters, which is why the render
    // thread is `UnityGfxDeviceW` and not `UnityGfxDeviceWorker`.
    expect(classifyThread('UnityMain')).toBe('main');
    expect(classifyThread('UnityGfxDeviceW')).toBe('render');
    expect(classifyThread('Job.Worker 3')).toBe('worker');
    expect(classifyThread('FMOD stream th')).toBe('audio');
    expect(classifyThread('Binder:9042_4')).toBe('other');
  });

  it('reduces per-thread readings to one row per thread, keyed on name', () => {
    const reading = (main: number, render: number): CpuReading => ({
      appCpuPercentOfCore: main + render,
      appCpuPercentOfDevice: (main + render) / 8,
      systemCpuPercentOfDevice: 40,
      otherCpuPercentOfDevice: 12,
      cores: [
        { cpu: 0, cluster: 'little', usagePercent: 30, freqMhz: 1400, maxFreqMhz: 2000, offline: false },
        { cpu: 7, cluster: 'big', usagePercent: 80, freqMhz: 2380, maxFreqMhz: 2400, offline: false },
      ],
      threads: [
        { tid: 1, name: 'UnityMain', role: 'main', cpuPercent: main, lastCpu: 7, lastCluster: 'big' },
        { tid: 2, name: 'UnityGfxDeviceW', role: 'render', cpuPercent: render, lastCpu: 7, lastCluster: 'big' },
      ],
      threadCount: 84,
    });

    const summary = summarizeCpu([reading(60, 30), reading(96, 40)], null);

    expect(summary.mainThread!.name).toBe('UnityMain');
    expect(summary.mainThread!.averageCpuPercent).toBe(78);
    expect(summary.mainThread!.peakCpuPercent).toBe(96);
    // One of two samples was above 85% of a core.
    expect(summary.mainThread!.saturatedSamplePercent).toBe(50);
    expect(summary.mainThread!.dominantCluster).toBe('big');
    expect(summary.renderThread!.name).toBe('UnityGfxDeviceW');

    // Background load is kept apart from the game's own: they are different
    // problems with the same symptom.
    expect(summary.averageOtherCpuPercentOfDevice).toBe(12);
    expect(summary.clusters.map((c) => c.cluster)).toEqual(['big', 'little']);
  });

  it('reports nothing rather than an idle device when /proc was not readable', () => {
    const summary = summarizeCpu([], 'Per-core CPU load was not readable.');
    expect(summary.averageAppCpuPercentOfCore).toBeNull();
    expect(summary.mainThread).toBeNull();
    expect(summary.unavailableReason).toContain('not readable');
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('storage bandwidth and stalls', () => {
  it('reads both byte pairs, because the difference between them is the point', () => {
    const counters = parseProcIo(
      [
        'rchar: 633339904',
        'wchar: 18874368',
        'syscr: 41208',
        'syscw: 2104',
        'read_bytes: 224395264',
        'write_bytes: 6291456',
        'cancelled_write_bytes: 0',
      ].join('\n'),
    );

    expect(counters).not.toBeNull();
    // rchar is every read the game issued; read_bytes is the part the page
    // cache could not serve. A tool reporting only one would call a cached
    // 600 MB load and an uncached one identical.
    expect(counters!.rchar).toBe(633_339_904);
    expect(counters!.readBytes).toBe(224_395_264);
    expect(counters!.syscr).toBe(41_208);
  });

  it('rejects a read with no rchar rather than reporting it as no activity', () => {
    expect(parseProcIo('syscr: 4\nsyscw: 2')).toBeNull();
  });

  it('measures the frame-rate cost of heavy reads instead of just their size', () => {
    const reading = (
      rate: number | null,
      storage: number | null,
      totalRead: number,
      totalStorage: number,
    ): DiskIoReading => ({
      readBytesPerSecond: rate,
      writeBytesPerSecond: 0,
      storageReadBytesPerSecond: storage,
      storageWriteBytesPerSecond: 0,
      readCallsPerSecond: 100,
      writeCallsPerSecond: 0,
      totalReadBytes: totalRead,
      totalWriteBytes: 0,
      totalStorageReadBytes: totalStorage,
      totalStorageWriteBytes: 0,
    });

    const summary = summarizeDiskIo(
      [
        // First sample: no baseline yet, so no rate. It must not count as idle.
        { elapsedMs: 0, reading: reading(null, null, 0, 0) },
        { elapsedMs: 5000, reading: reading(1 * MB, 0, 20 * MB, 2 * MB) },
        { elapsedMs: 76_000, reading: reading(96 * MB, 61 * MB, 600 * MB, 214 * MB) },
      ],
      [
        { elapsedMs: 5000, fps: 60, janks: 0 },
        { elapsedMs: 75_000, fps: 18, janks: 4 },
        { elapsedMs: 150_000, fps: 59, janks: 0 },
      ],
      [{ elapsedMs: 60_000, label: 'Riot starts' }],
      null,
    );

    expect(summary.bursts).toHaveLength(1);
    expect(summary.bursts[0]!.nearestMarker).toBe('Riot starts');
    expect(summary.bursts[0]!.janks).toBe(4);
    // The figure this module exists to produce: a read that cost frames.
    expect(summary.burstsWithStutter).toBe(1);
    expect(summary.fpsDuringBursts).toBe(18);
    expect(summary.fpsOutsideBursts).toBe(59.5);
    // Cache hit rate from the totals, not from a mean of per-sample ratios.
    expect(summary.cacheHitPercent).toBe(64.3);
    expect(summary.peakReadBytesPerSecond).toBe(96 * MB);
  });

  it('says why storage was not measurable rather than reporting no reads', () => {
    const summary = summarizeDiskIo([], [], [], 'Disk I/O counters were not readable.');
    expect(summary.totalReadBytes).toBeNull();
    expect(summary.burstsWithStutter).toBe(0);
    expect(summary.unavailableReason).toContain('not readable');
  });
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

describe('the audio subsystem', () => {
  it('sums tracks and underruns across every output thread', () => {
    const dump = [
      'Output thread 0xb400007 type 0 (MIXER):',
      '  sampleRate=48000, frameCount=960',
      '  4 Tracks of which 2 are active',
      '  FastMixer command=MIX writeSequence=41208 underruns=3',
      'Output thread 0xb400009 type 2 (DUPLICATING):',
      '  2 Tracks of which 1 is active',
    ].join('\n');

    const reading = parseAudioFlinger(dump);
    expect(reading).not.toBeNull();
    // A phone has several output threads and the game's audio can be on any of
    // them, so the counts are sums rather than whichever came first.
    expect(reading!.totalTracks).toBe(6);
    expect(reading!.activeTracks).toBe(3);
    expect(reading!.underrunCount).toBe(3);
    expect(reading!.sampleRateHz).toBe(48_000);
    expect(reading!.bufferFrames).toBe(960);
  });

  it('returns nothing for a dump carrying none of the counters it reads', () => {
    expect(parseAudioFlinger('AudioFlinger dump\nnothing useful here')).toBeNull();
  });

  it('counts underruns as a difference, because the counter is lifetime-of-boot', () => {
    const summary = summarizeAudio(
      [
        // The audio server has been running since the phone booted. Its raw
        // total says nothing about this game.
        { elapsedMs: 0, reading: { totalTracks: 4, activeTracks: 2, underrunCount: 1041, sampleRateHz: 48_000, bufferFrames: 960 } },
        { elapsedMs: 120_000, reading: { totalTracks: 6, activeTracks: 5, underrunCount: 1044, sampleRateHz: 48_000, bufferFrames: 960 } },
      ],
      [{ playingSources: 24, audioVoices: 28, totalCpuPercent: 9.6, dspCpuPercent: 2.8 }],
      120_000,
      null,
    );

    expect(summary.underrunsDuringSession).toBe(3);
    expect(summary.underrunsPerMinute).toBe(1.5);
    expect(summary.peakActiveTracks).toBe(5);
    expect(summary.peakPlayingSources).toBe(24);
    expect(summary.peakAudioCpuPercent).toBe(9.6);
    // 960 frames at 48 kHz is the 20 ms deadline an underrun missed.
    expect(summary.bufferMs).toBe(20);
    expect(summary.verdict).toBe('occasional-dropouts');
  });

  it('grades dropouts by rate, so one click in twenty minutes is not a failure', () => {
    expect(rateAudio(0)).toBe('clean');
    expect(rateAudio(0.05)).toBe('occasional-dropouts');
    expect(rateAudio(12)).toBe('starved');
    // Unmeasured is its own verdict and never 'clean'.
    expect(rateAudio(null)).toBe('unknown');
  });

  it('does not claim clean audio when the mixer reported no counters', () => {
    const summary = summarizeAudio([], [], 60_000, 'The mixer did not report underruns.');
    expect(summary.underrunsDuringSession).toBeNull();
    expect(summary.verdict).toBe('unknown');
    expect(summary.unavailableReason).toContain('did not report');
  });
});
