/**
 * GPU utilisation, clock and graphics memory.
 *
 * Android has no public API for GPU load. What exists is vendor sysfs, and the
 * three families that cover essentially every Android handset are read here:
 *
 *   Adreno (Qualcomm)  /sys/class/kgsl/kgsl-3d0/gpubusy      busy + total ticks
 *                      /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage
 *                      /sys/class/kgsl/kgsl-3d0/gpuclk       Hz
 *   Mali (ARM)         /sys/class/misc/mali0/device/utilisation   0-255 or 0-100
 *                      /sys/devices/platform/*.mali/utilization
 *   devfreq (generic)  /sys/class/devfreq/<any *gpu* node>/cur_freq  Hz, clock only
 *
 * Two honest caveats, both stated in the report rather than hidden:
 *
 *  1. On most retail Android 12+ devices SELinux denies an adb shell read of
 *     these nodes. The probe then reports nothing at all rather than a zero -
 *     a zero would read as "the GPU was idle", which is the opposite of true.
 *  2. `gpubusy` is a pair of free-running tick counters, so a utilisation
 *     figure is a *difference between two reads*. The first sample of a session
 *     can only establish the baseline and deliberately reports null.
 *
 * Graphics memory is not read from here. Android already accounts it, and the
 * memory probes already collect it: `dumpsys meminfo` reports a Graphics
 * category and smaps names the driver mappings. Reading it twice from two
 * sources would just create two figures that disagree.
 */
import type { AdbDevice } from '../devices/adb.js';
import type { Logger } from '../core/logger.js';

/** Which vendor interface answered. Recorded so a reader can judge the figure. */
export type GpuSource = 'kgsl-percentage' | 'kgsl-busy' | 'mali' | 'devfreq';

export interface GpuReading {
  /** 0-100. Null on the first sample of a tick-counter source. */
  utilizationPercent: number | null;
  clockMhz: number | null;
  /** The ceiling this silicon allows, for reading the clock against. */
  maxClockMhz: number | null;
  source: GpuSource;
}

/** One acquisition strategy that was tried, and what came back. */
export interface GpuAttempt {
  strategy: string;
  ok: boolean;
  /** Phrased for an operator, because this is what gets shown when none works. */
  detail: string;
}

const KGSL = '/sys/class/kgsl/kgsl-3d0';

/**
 * Reads GPU load for one device.
 *
 * Stateful, because the Adreno tick counters only mean something as a
 * difference, and because the working strategy is resolved once at `prepare()`
 * rather than re-probed every second against a device that will keep refusing.
 */
export class GpuProbe {
  private source: GpuSource | null = null;
  private maxClockMhz: number | null = null;
  private lastBusy: { busy: number; total: number } | null = null;
  private readonly attempts: GpuAttempt[] = [];

  constructor(
    private readonly device: AdbDevice,
    private readonly logger?: Logger,
  ) {}

  /** Which strategies were tried, and what each one reported. */
  get diagnostics(): GpuAttempt[] {
    return this.attempts;
  }

  /**
   * Resolve a working source once. Returns null when the device exposes none,
   * which is the common case on a locked-down retail build.
   */
  async prepare(): Promise<GpuSource | null> {
    // Preferred: the kernel has already done the arithmetic, so a single read
    // is a real instantaneous figure with no baseline needed.
    const percentage = await this.read(`${KGSL}/gpu_busy_percentage`);
    if (percentage !== null && /\d/.test(percentage)) {
      this.note('kgsl gpu_busy_percentage', true, `reads "${percentage.trim()}"`);
      this.source = 'kgsl-percentage';
    } else {
      this.note('kgsl gpu_busy_percentage', false, 'not present or not readable');
    }

    if (!this.source) {
      const busy = await this.read(`${KGSL}/gpubusy`);
      if (busy !== null && parseGpuBusy(busy)) {
        this.note('kgsl gpubusy', true, 'tick counters readable; needs two samples');
        this.source = 'kgsl-busy';
      } else {
        this.note('kgsl gpubusy', false, 'not present or not readable');
      }
    }

    if (!this.source) {
      const mali = await this.readFirst([
        '/sys/class/misc/mali0/device/utilisation',
        '/sys/class/misc/mali0/device/utilization',
        '/sys/devices/platform/*.mali/utilization',
      ]);
      if (mali !== null && /\d/.test(mali)) {
        this.note('mali utilisation', true, `reads "${mali.trim()}"`);
        this.source = 'mali';
      } else {
        this.note('mali utilisation', false, 'not present or not readable');
      }
    }

    if (!this.source) {
      // Last resort. A clock with no load figure still says something: a GPU
      // pinned at its maximum frequency for a whole session is not coasting.
      const freq = await this.readFirst([
        `${KGSL}/gpuclk`,
        `${KGSL}/devfreq/cur_freq`,
        '/sys/class/devfreq/*.gpu/cur_freq',
        '/sys/class/devfreq/*gpu*/cur_freq',
      ]);
      if (freq !== null && /\d/.test(freq)) {
        this.note('devfreq clock', true, 'clock only, no load figure');
        this.source = 'devfreq';
      } else {
        this.note('devfreq clock', false, 'not present or not readable');
      }
    }

    if (this.source) {
      this.maxClockMhz = await this.readMaxClock();
    } else {
      this.logger?.info('GPU load is not readable on this device', {
        consequence:
          'The report will say GPU utilisation was not measurable rather than assume it was idle. ' +
          'Draw calls and GPU frame time still come from the engine reporter, if the build carries it.',
      });
    }

    return this.source;
  }

  async sample(): Promise<GpuReading | null> {
    if (!this.source) return null;

    const clockMhz = await this.readClockMhz();

    if (this.source === 'kgsl-percentage') {
      const raw = await this.read(`${KGSL}/gpu_busy_percentage`);
      const value = raw === null ? null : Number(/(\d+(?:\.\d+)?)/.exec(raw)?.[1] ?? NaN);
      return {
        utilizationPercent: value !== null && Number.isFinite(value) ? clamp(value) : null,
        clockMhz,
        maxClockMhz: this.maxClockMhz,
        source: this.source,
      };
    }

    if (this.source === 'kgsl-busy') {
      const raw = await this.read(`${KGSL}/gpubusy`);
      const parsed = raw === null ? null : parseGpuBusy(raw);
      if (!parsed) return null;

      const previous = this.lastBusy;
      this.lastBusy = parsed;

      // Reading these clears them on some kernels and does not on others, so
      // the difference is taken when it is positive and the raw ratio used when
      // the counters plainly reset. Both readings are of the same window; only
      // the bookkeeping differs.
      let utilization: number | null = null;
      if (previous) {
        const busyDelta = parsed.busy - previous.busy;
        const totalDelta = parsed.total - previous.total;
        if (totalDelta > 0 && busyDelta >= 0) utilization = clamp((busyDelta / totalDelta) * 100);
        else if (parsed.total > 0) utilization = clamp((parsed.busy / parsed.total) * 100);
      }

      return {
        utilizationPercent: utilization,
        clockMhz,
        maxClockMhz: this.maxClockMhz,
        source: this.source,
      };
    }

    if (this.source === 'mali') {
      const raw = await this.readFirst([
        '/sys/class/misc/mali0/device/utilisation',
        '/sys/class/misc/mali0/device/utilization',
        '/sys/devices/platform/*.mali/utilization',
      ]);
      const value = raw === null ? null : Number(/(\d+)/.exec(raw)?.[1] ?? NaN);
      return {
        utilizationPercent: value !== null && Number.isFinite(value) ? maliToPercent(value) : null,
        clockMhz,
        maxClockMhz: this.maxClockMhz,
        source: this.source,
      };
    }

    // devfreq: clock only, and saying so is better than implying a load figure.
    return {
      utilizationPercent: null,
      clockMhz,
      maxClockMhz: this.maxClockMhz,
      source: 'devfreq',
    };
  }

  private async readClockMhz(): Promise<number | null> {
    const raw = await this.readFirst([
      `${KGSL}/gpuclk`,
      `${KGSL}/devfreq/cur_freq`,
      '/sys/class/misc/mali0/device/clock',
      '/sys/class/devfreq/*.gpu/cur_freq',
      '/sys/class/devfreq/*gpu*/cur_freq',
    ]);
    return raw === null ? null : hzToMhz(raw);
  }

  private async readMaxClock(): Promise<number | null> {
    const raw = await this.readFirst([
      `${KGSL}/max_gpuclk`,
      `${KGSL}/devfreq/max_freq`,
      '/sys/class/devfreq/*.gpu/max_freq',
      '/sys/class/devfreq/*gpu*/max_freq',
    ]);
    return raw === null ? null : hzToMhz(raw);
  }

  private async read(path: string): Promise<string | null> {
    const res = await this.device.shell(['cat', path], 10_000);
    if (res.code !== 0) return null;
    const out = res.stdout.trim();
    // A denied read prints to stderr on some shells and to stdout on others.
    if (out.length === 0 || /permission denied|no such file/i.test(out)) return null;
    return out;
  }

  /**
   * First readable path out of a list, in one round trip.
   *
   * A per-path `cat` would be five adb calls per sample against a device that
   * will answer only one of them, and the glob entries cannot be resolved
   * locally at all - only the device shell knows what `*.mali` expands to.
   */
  private async readFirst(paths: string[]): Promise<string | null> {
    const script = paths
      .map((p) => `for f in ${p}; do [ -r "$f" ] && cat "$f" && exit 0; done`)
      .join('; ');
    const res = await this.device.script(`${script}; exit 1`, 12_000);
    if (res.code !== 0) return null;
    const out = res.stdout.trim();
    return out.length > 0 && !/permission denied|no such file/i.test(out) ? out : null;
  }

  private note(strategy: string, ok: boolean, detail: string): void {
    this.attempts.push({ strategy, ok, detail });
  }
}

/** `gpubusy` is two integers on one line: busy ticks, then total ticks. */
export function parseGpuBusy(text: string): { busy: number; total: number } | null {
  const parts = text.trim().split(/\s+/).map(Number);
  const [busy, total] = parts;
  if (busy === undefined || total === undefined) return null;
  if (!Number.isFinite(busy) || !Number.isFinite(total) || total < 0 || busy < 0) return null;
  return { busy, total };
}

/**
 * Mali reports utilisation as 0-255 on some kernels and 0-100 on others, with
 * nothing in the node to say which. Values above 100 can only be the 0-255
 * scale, and below that the two agree closely enough that guessing wrong costs
 * a few percent rather than the meaning of the figure.
 */
function maliToPercent(value: number): number {
  return value > 100 ? clamp((value / 255) * 100) : clamp(value);
}

function hzToMhz(text: string): number | null {
  const value = Number(/(\d+)/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(value) || value <= 0) return null;
  // These nodes report Hz on Adreno and kHz on some devfreq drivers. Anything
  // above a gigahertz-scale number is Hz; a phone GPU does not run at 900 GHz.
  if (value > 10_000_000) return Math.round(value / 1_000_000);
  if (value > 10_000) return Math.round(value / 1000);
  return Math.round(value);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

// ---------------------------------------------------------------------------
// Session-level summary
// ---------------------------------------------------------------------------

import type { EngineRender } from './engineProfile.js';

export interface GpuSummary {
  /** Null when no source on this device would answer. */
  averageUtilizationPercent: number | null;
  peakUtilizationPercent: number | null;
  /** Share of samples above 90%, where the GPU is the thing setting the pace. */
  saturatedSamplePercent: number | null;
  averageClockMhz: number | null;
  peakClockMhz: number | null;
  maxClockMhz: number | null;
  /** Share of samples at or within 5% of the ceiling. */
  clockPinnedPercent: number | null;
  source: GpuSource | null;
  sampleCount: number;
  /** Why a utilisation figure is absent, when it is. */
  unavailableReason: string | null;
}

/** Engine-reported rendering work over the session. */
export interface RenderSummary {
  averageDrawCalls: number | null;
  peakDrawCalls: number | null;
  averageBatches: number | null;
  averageSetPassCalls: number | null;
  peakSetPassCalls: number | null;
  averageTriangles: number | null;
  peakTriangles: number | null;
  averageVertices: number | null;
  peakVertices: number | null;
  /** Bound texture memory, which is the part of VRAM the game controls. */
  peakUsedTextureBytes: number | null;
  peakRenderTextureBytes: number | null;
  peakUsedTextureCount: number | null;
  /** Frame time split by where it was spent, in milliseconds. */
  averageMainThreadMs: number | null;
  peakMainThreadMs: number | null;
  averageRenderThreadMs: number | null;
  peakRenderThreadMs: number | null;
  averageGpuFrameMs: number | null;
  peakGpuFrameMs: number | null;
  sampleCount: number;
  /** Counters this engine version did not expose, by name. */
  unavailable: string[];
}

export function summarizeGpu(
  readings: GpuReading[],
  unavailableReason: string | null,
): GpuSummary {
  const utilization = readings
    .map((r) => r.utilizationPercent)
    .filter((v): v is number => v !== null);
  const clocks = readings.map((r) => r.clockMhz).filter((v): v is number => v !== null);
  const maxClock = readings.find((r) => r.maxClockMhz !== null)?.maxClockMhz ?? null;

  // "Pinned" means within 5% of the ceiling. A GPU that never leaves its top
  // bin is being asked for everything it has, which is worth saying even on a
  // device that will not report a load percentage.
  const pinned =
    maxClock !== null && clocks.length > 0
      ? round1((clocks.filter((c) => c >= maxClock * 0.95).length / clocks.length) * 100)
      : null;

  return {
    averageUtilizationPercent: utilization.length ? round1(mean(utilization)) : null,
    peakUtilizationPercent: utilization.length ? round1(Math.max(...utilization)) : null,
    saturatedSamplePercent: utilization.length
      ? round1((utilization.filter((u) => u >= 90).length / utilization.length) * 100)
      : null,
    averageClockMhz: clocks.length ? Math.round(mean(clocks)) : null,
    peakClockMhz: clocks.length ? Math.max(...clocks) : null,
    maxClockMhz: maxClock,
    clockPinnedPercent: pinned,
    source: readings[0]?.source ?? null,
    sampleCount: readings.length,
    unavailableReason: utilization.length > 0 ? null : unavailableReason,
  };
}

export function summarizeRender(readings: readonly EngineRender[]): RenderSummary {
  const pick = (field: keyof EngineRender): number[] =>
    readings.map((r) => r[field]).filter((v): v is number => typeof v === 'number');

  const avg = (field: keyof EngineRender): number | null => {
    const values = pick(field);
    return values.length ? Math.round(mean(values)) : null;
  };
  const avg1 = (field: keyof EngineRender): number | null => {
    const values = pick(field);
    return values.length ? round1(mean(values)) : null;
  };
  const peak = (field: keyof EngineRender): number | null => {
    const values = pick(field);
    return values.length ? Math.max(...values) : null;
  };
  const peak1 = (field: keyof EngineRender): number | null => {
    const values = pick(field);
    return values.length ? round1(Math.max(...values)) : null;
  };

  // Union across readings: a counter can be unavailable from the first frame,
  // and the list is what turns "no draw calls reported" into something a
  // developer can act on.
  const unavailable = [...new Set(readings.flatMap((r) => r.unavailable ?? []))];

  return {
    averageDrawCalls: avg('drawCalls'),
    peakDrawCalls: peak('drawCalls'),
    averageBatches: avg('batches'),
    averageSetPassCalls: avg('setPassCalls'),
    peakSetPassCalls: peak('setPassCalls'),
    averageTriangles: avg('triangles'),
    peakTriangles: peak('triangles'),
    averageVertices: avg('vertices'),
    peakVertices: peak('vertices'),
    peakUsedTextureBytes: peak('usedTextureBytes'),
    peakRenderTextureBytes: peak('renderTextureBytes'),
    peakUsedTextureCount: peak('usedTextureCount'),
    averageMainThreadMs: avg1('mainThreadMs'),
    peakMainThreadMs: peak1('mainThreadMs'),
    averageRenderThreadMs: avg1('renderThreadMs'),
    peakRenderThreadMs: peak1('renderThreadMs'),
    averageGpuFrameMs: avg1('gpuFrameMs'),
    peakGpuFrameMs: peak1('gpuFrameMs'),
    sampleCount: readings.length,
    unavailable,
  };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
