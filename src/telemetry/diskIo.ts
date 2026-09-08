/**
 * Storage bandwidth and asset-loading stalls.
 *
 * The source is `/proc/<pid>/io`, which the kernel maintains per process:
 *
 *   rchar / wchar                bytes moved by read()/write(), cache included
 *   read_bytes / write_bytes     bytes that actually reached the block device
 *   syscr / syscw                how many calls it took
 *
 * The distinction between the two byte pairs is the whole value of this module.
 * `rchar` counts every read the game issued; `read_bytes` counts the ones the
 * page cache could not satisfy. A scene load that reads 400 MB with
 * `read_bytes` near zero was served from cache and cost almost nothing. The
 * same 400 MB with `read_bytes` at 400 MB went to flash, and that is where the
 * frame stalls come from. A tool that reported only one of them would call
 * those two cases identical.
 *
 * Access, and the honest limit: `/proc/<pid>/io` is readable by the process's
 * own uid or root. An adb shell is neither, so this works through `run-as` on a
 * debuggable build or `su` on a rooted device, exactly as the smaps probe does,
 * and reports itself unavailable on a release build on a stock handset rather
 * than failing the session.
 *
 * What this cannot do: attribute a read to a file. `/proc/<pid>/io` is totals
 * only, and Android has no per-file accounting an unprivileged observer can
 * reach. So the analysis correlates bandwidth against the frame timeline
 * instead - which is the question anyway, because "this stall was a disk read"
 * is actionable and "this stall read bundle_037" is only slightly more so.
 */
import type { AdbDevice } from '../devices/adb.js';
import type { Logger } from '../core/logger.js';

export interface DiskIoReading {
  /** Bytes per second issued by the app, cache hits included. */
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  /** Bytes per second that actually reached the flash. The expensive kind. */
  storageReadBytesPerSecond: number | null;
  storageWriteBytesPerSecond: number | null;
  /** Read and write calls per second - a proxy for how chatty the loading is. */
  readCallsPerSecond: number | null;
  writeCallsPerSecond: number | null;
  /** Cumulative totals, so a session total does not depend on every sample. */
  totalReadBytes: number;
  totalWriteBytes: number;
  totalStorageReadBytes: number;
  totalStorageWriteBytes: number;
}

/** Raw counters as the kernel reports them. */
export interface ProcIoCounters {
  rchar: number;
  wchar: number;
  syscr: number;
  syscw: number;
  readBytes: number;
  writeBytes: number;
}

export function parseProcIo(text: string): ProcIoCounters | null {
  const field = (name: string): number => {
    const raw = new RegExp(`^${name}:\\s*(\\d+)`, 'm').exec(text)?.[1];
    return raw === undefined ? NaN : Number(raw);
  };

  const counters: ProcIoCounters = {
    rchar: field('rchar'),
    wchar: field('wchar'),
    syscr: field('syscr'),
    syscw: field('syscw'),
    readBytes: field('read_bytes'),
    writeBytes: field('write_bytes'),
  };

  // rchar is the one field every kernel reports; without it there is nothing
  // here worth keeping. The others default to zero only when rchar was present,
  // so a truncated read is rejected rather than reported as no activity.
  if (!Number.isFinite(counters.rchar)) return null;
  for (const key of Object.keys(counters) as Array<keyof ProcIoCounters>) {
    if (!Number.isFinite(counters[key])) counters[key] = 0;
  }
  return counters;
}

/**
 * Samples disk I/O for one process.
 *
 * Stateful for the same reason every other counter probe here is: these are
 * cumulative, and a rate is a difference over the wall-clock gap between two
 * reads. The first sample establishes the baseline and reports null rates.
 */
export class DiskIoProbe {
  private accessor: 'direct' | 'run-as' | 'su' | null = null;
  private last: { counters: ProcIoCounters; at: number } | null = null;
  private baseline: ProcIoCounters | null = null;

  constructor(
    private readonly device: AdbDevice,
    private readonly packageName: string,
    private readonly logger?: Logger,
  ) {}

  /** How the file turned out to be readable, or null when it is not. */
  get access(): string | null {
    return this.accessor;
  }

  async prepare(pid: number): Promise<boolean> {
    const attempts: Array<['direct' | 'run-as' | 'su', string[]]> = [
      ['direct', ['cat', `/proc/${pid}/io`]],
      ['run-as', ['run-as', this.packageName, 'cat', `/proc/${pid}/io`]],
      ['su', ['su', '-c', `cat /proc/${pid}/io`]],
    ];

    for (const [accessor, argv] of attempts) {
      const res = await this.device.shell(argv, 10_000);
      if (res.code === 0 && /rchar:/i.test(res.stdout)) {
        this.accessor = accessor;
        this.logger?.debug('Disk I/O counters readable', { accessor });
        return true;
      }
    }

    this.logger?.info('Disk I/O counters are not readable on this device', {
      consequence:
        'Asset streaming and I/O-caused stutter cannot be measured. This needs a debuggable ' +
        'build (run-as) or a rooted device; a release build on a stock handset denies it.',
    });
    return false;
  }

  async sample(pid: number): Promise<DiskIoReading | null> {
    if (!this.accessor) return null;

    const path = `/proc/${pid}/io`;
    const argv =
      this.accessor === 'direct'
        ? ['cat', path]
        : this.accessor === 'run-as'
          ? ['run-as', this.packageName, 'cat', path]
          : ['su', '-c', `cat ${path}`];

    const res = await this.device.shell(argv, 10_000);
    if (res.code !== 0) return null;

    const counters = parseProcIo(res.stdout);
    if (!counters) return null;

    const now = Date.now();
    const previous = this.last;
    this.last = { counters, at: now };
    // Totals are reported relative to the first reading, so "read 380 MB this
    // session" is about the session rather than about however long the process
    // had been alive when we attached to it.
    this.baseline ??= counters;

    const rate = (current: number, before: number, ms: number): number | null => {
      const delta = current - before;
      // A process relaunch resets the counters. A negative delta is that, not
      // an I/O figure, and reporting it as one would print a negative bandwidth.
      if (delta < 0 || ms <= 0) return null;
      return Math.round(delta / (ms / 1000));
    };

    const elapsedMs = previous ? now - previous.at : 0;
    const base = this.baseline;

    return {
      readBytesPerSecond: previous ? rate(counters.rchar, previous.counters.rchar, elapsedMs) : null,
      writeBytesPerSecond: previous
        ? rate(counters.wchar, previous.counters.wchar, elapsedMs)
        : null,
      storageReadBytesPerSecond: previous
        ? rate(counters.readBytes, previous.counters.readBytes, elapsedMs)
        : null,
      storageWriteBytesPerSecond: previous
        ? rate(counters.writeBytes, previous.counters.writeBytes, elapsedMs)
        : null,
      readCallsPerSecond: previous ? rate(counters.syscr, previous.counters.syscr, elapsedMs) : null,
      writeCallsPerSecond: previous
        ? rate(counters.syscw, previous.counters.syscw, elapsedMs)
        : null,
      totalReadBytes: Math.max(0, counters.rchar - base.rchar),
      totalWriteBytes: Math.max(0, counters.wchar - base.wchar),
      totalStorageReadBytes: Math.max(0, counters.readBytes - base.readBytes),
      totalStorageWriteBytes: Math.max(0, counters.writeBytes - base.writeBytes),
    };
  }

  /** Reset the baseline after a process restart, so totals stay meaningful. */
  resetBaseline(): void {
    this.last = null;
    this.baseline = null;
  }
}

// ---------------------------------------------------------------------------
// Session-level summary
// ---------------------------------------------------------------------------

/** One window where the app was reading hard enough to be worth naming. */
export interface IoBurst {
  elapsedMs: number;
  readBytesPerSecond: number;
  storageReadBytesPerSecond: number | null;
  /** Nearest operator marker at or before the burst, if any. */
  nearestMarker: string | null;
  /** Frame rate in the same window, when it was measured. */
  fps: number | null;
  /** Janks counted in the same window. */
  janks: number | null;
}

export interface DiskIoSummary {
  totalReadBytes: number | null;
  totalWriteBytes: number | null;
  /** The part that reached the flash rather than the page cache. */
  totalStorageReadBytes: number | null;
  totalStorageWriteBytes: number | null;
  peakReadBytesPerSecond: number | null;
  peakStorageReadBytesPerSecond: number | null;
  averageReadBytesPerSecond: number | null;
  /** Share of the app's reads that the page cache served, 0-100. */
  cacheHitPercent: number | null;
  /** Windows where reads exceeded the burst threshold, biggest first. */
  bursts: IoBurst[];
  /**
   * How many of those bursts coincided with stutter.
   *
   * The one number this module exists to produce: reads that cost frames.
   */
  burstsWithStutter: number;
  /** Frame rate during bursts against frame rate outside them. */
  fpsDuringBursts: number | null;
  fpsOutsideBursts: number | null;
  sampleCount: number;
  unavailableReason: string | null;
}

/**
 * A read is a "burst" above 8 MB/s.
 *
 * Chosen against what a phone does at rest: a Unity game that is not loading
 * reads a few hundred kilobytes a second of shader cache and preference files,
 * and UFS flash sustains 500-1500 MB/s, so 8 MB/s is comfortably above idle and
 * well below the streaming rate of an actual bundle load. It is a threshold for
 * "something was loading", not a performance limit.
 */
export const IO_BURST_BYTES_PER_SECOND = 8 * 1024 * 1024;

export interface DiskIoSample {
  elapsedMs: number;
  reading: DiskIoReading;
}

export interface FrameWindow {
  elapsedMs: number;
  fps: number;
  janks: number;
}

export function summarizeDiskIo(
  samples: DiskIoSample[],
  frames: FrameWindow[],
  markers: Array<{ elapsedMs: number; label: string }>,
  unavailableReason: string | null,
): DiskIoSummary {
  if (samples.length === 0) {
    return {
      totalReadBytes: null,
      totalWriteBytes: null,
      totalStorageReadBytes: null,
      totalStorageWriteBytes: null,
      peakReadBytesPerSecond: null,
      peakStorageReadBytesPerSecond: null,
      averageReadBytesPerSecond: null,
      cacheHitPercent: null,
      bursts: [],
      burstsWithStutter: 0,
      fpsDuringBursts: null,
      fpsOutsideBursts: null,
      sampleCount: 0,
      unavailableReason,
    };
  }

  const last = samples[samples.length - 1]!.reading;
  const readRates = samples
    .map((s) => s.reading.readBytesPerSecond)
    .filter((v): v is number => v !== null);
  const storageRates = samples
    .map((s) => s.reading.storageReadBytesPerSecond)
    .filter((v): v is number => v !== null);

  // Cache hit rate from the totals rather than averaged per-sample rates: a
  // mean of ratios is not the ratio of the means, and the totals are exact.
  const cacheHit =
    last.totalReadBytes > 0
      ? round1(
          Math.max(
            0,
            Math.min(100, ((last.totalReadBytes - last.totalStorageReadBytes) / last.totalReadBytes) * 100),
          ),
        )
      : null;

  const bursts: IoBurst[] = [];
  for (const sample of samples) {
    const rate = sample.reading.readBytesPerSecond;
    if (rate === null || rate < IO_BURST_BYTES_PER_SECOND) continue;
    const window = nearestFrameWindow(frames, sample.elapsedMs);
    bursts.push({
      elapsedMs: sample.elapsedMs,
      readBytesPerSecond: rate,
      storageReadBytesPerSecond: sample.reading.storageReadBytesPerSecond,
      nearestMarker: nearestMarkerLabel(markers, sample.elapsedMs),
      fps: window?.fps ?? null,
      janks: window?.janks ?? null,
    });
  }
  bursts.sort((a, b) => b.readBytesPerSecond - a.readBytesPerSecond);

  // Frame rate inside bursts against outside them. This is the comparison that
  // turns "the game read 400 MB" into "the reads cost 22 fps".
  const burstMs = new Set(bursts.map((b) => b.elapsedMs));
  const inside: number[] = [];
  const outside: number[] = [];
  for (const frame of frames) {
    const near = [...burstMs].some((ms) => Math.abs(ms - frame.elapsedMs) <= 2500);
    (near ? inside : outside).push(frame.fps);
  }

  return {
    totalReadBytes: last.totalReadBytes,
    totalWriteBytes: last.totalWriteBytes,
    totalStorageReadBytes: last.totalStorageReadBytes,
    totalStorageWriteBytes: last.totalStorageWriteBytes,
    peakReadBytesPerSecond: readRates.length ? Math.max(...readRates) : null,
    peakStorageReadBytesPerSecond: storageRates.length ? Math.max(...storageRates) : null,
    averageReadBytesPerSecond: readRates.length ? Math.round(mean(readRates)) : null,
    cacheHitPercent: cacheHit,
    bursts: bursts.slice(0, 8),
    burstsWithStutter: bursts.filter((b) => (b.janks ?? 0) > 0).length,
    fpsDuringBursts: inside.length ? round1(mean(inside)) : null,
    fpsOutsideBursts: outside.length ? round1(mean(outside)) : null,
    sampleCount: samples.length,
    unavailableReason: null,
  };
}

/** The frame window closest to a moment, within two and a half seconds. */
function nearestFrameWindow(frames: FrameWindow[], elapsedMs: number): FrameWindow | null {
  let best: FrameWindow | null = null;
  let bestGap = Infinity;
  for (const frame of frames) {
    const gap = Math.abs(frame.elapsedMs - elapsedMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = frame;
    }
  }
  return bestGap <= 2500 ? best : null;
}

/**
 * The last marker the operator pressed at or before a moment.
 *
 * Scans the whole list rather than stopping at the first marker past the
 * moment: nothing in the type guarantees the markers arrive in order, and a
 * loop that assumed they did would silently name the wrong screen the first
 * time a caller passed them unsorted.
 */
function nearestMarkerLabel(
  markers: Array<{ elapsedMs: number; label: string }>,
  elapsedMs: number,
): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const marker of markers) {
    if (marker.elapsedMs <= elapsedMs && marker.elapsedMs > bestMs) {
      bestMs = marker.elapsedMs;
      best = marker.label;
    }
  }
  return best;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
