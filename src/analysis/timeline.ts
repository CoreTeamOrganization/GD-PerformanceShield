/**
 * Timeline assembly and the statistics shared by every runtime analyzer.
 *
 * Telemetry arrives as two interleaved tiers (cheap RSS at ~1 Hz, full PSS at
 * ~0.2 Hz). Analyzers must not mix them: PSS and RSS answer different
 * questions, and a series that silently alternates between them produces
 * sawtooth artefacts that look exactly like the spikes we are hunting.
 *
 * So we expose them as two aligned series over one shared time base.
 */
import { readJsonlAll } from '../core/jsonl.js';
import type { LogEvent, MemorySample, TimelineEvent } from '../telemetry/types.js';

export interface SeriesPoint {
  t: number;
  elapsedMs: number;
  value: number;
}

export interface DeviceTimeline {
  serial: string;
  role: string;
  /** Full-fidelity PSS series (deep tier). The primary OOM metric. */
  pss: SeriesPoint[];
  /**
   * High-resolution RSS series, from the fast tier only.
   *
   * Deliberately excludes the deep tier's RSS even though those samples carry
   * one. The two are different measurements: the fast tier reads `VmRSS` from
   * `/proc/<pid>/status`, and the deep tier takes `TOTAL RSS` from
   * `dumpsys meminfo`, which counts graphics allocations the kernel does not
   * attribute to the process. On one handset they read 501 MB and 723 MB at the
   * same instant. Interleaved at 1 Hz and 0.2 Hz they would form a sawtooth and
   * put a 220 MB spike into the series every five seconds.
   */
  rss: SeriesPoint[];
  /** Device-wide available memory, sampled on the deep cadence. */
  deviceAvailable: SeriesPoint[];
  oomScoreAdj: SeriesPoint[];
  samples: MemorySample[];
  /** Whichever series has usable resolution - what analyzers should read. */
  primary: SeriesPoint[];
  primaryMetric: 'pss' | 'rss';
  durationMs: number;
}

export interface SessionTimeline {
  sessionId: string;
  startedAtEpochMs: number;
  devices: DeviceTimeline[];
  events: TimelineEvent[];
  logs: LogEvent[];
}

export interface LoadTimelineInput {
  sessionId: string;
  startedAtEpochMs: number;
  telemetryPaths: Array<{ serial: string; role: string; path: string }>;
  eventsPath: string;
  logPaths?: Array<{ serial: string; path: string }>;
}

export async function loadTimeline(input: LoadTimelineInput): Promise<SessionTimeline> {
  const devices: DeviceTimeline[] = [];

  for (const entry of input.telemetryPaths) {
    const samples = (await readJsonlAll<MemorySample>(entry.path)).sort((a, b) => a.t - b.t);
    devices.push(buildDeviceTimeline(entry.serial, entry.role, samples));
  }

  const events = (await readJsonlAll<TimelineEvent>(input.eventsPath)).sort((a, b) => a.t - b.t);

  const logs: LogEvent[] = [];
  for (const entry of input.logPaths ?? []) {
    logs.push(...(await readJsonlAll<LogEvent>(entry.path)));
  }
  logs.sort((a, b) => a.t - b.t);

  return {
    sessionId: input.sessionId,
    startedAtEpochMs: input.startedAtEpochMs,
    devices,
    events,
    logs,
  };
}

export function buildDeviceTimeline(
  serial: string,
  role: string,
  samples: MemorySample[],
): DeviceTimeline {
  const pss: SeriesPoint[] = [];
  const rss: SeriesPoint[] = [];
  const deviceAvailable: SeriesPoint[] = [];
  const oomScoreAdj: SeriesPoint[] = [];

  for (const s of samples) {
    const base = { t: s.t, elapsedMs: s.elapsedMs };
    if (s.pssBytes !== null && s.pssBytes !== undefined) pss.push({ ...base, value: s.pssBytes });
    if (s.tier === 'fast' && s.rssBytes !== null && s.rssBytes !== undefined) {
      rss.push({ ...base, value: s.rssBytes });
    }
    if (s.deviceAvailableBytes !== null && s.deviceAvailableBytes !== undefined) {
      deviceAvailable.push({ ...base, value: s.deviceAvailableBytes });
    }
    if (s.oomScoreAdj !== null && s.oomScoreAdj !== undefined) {
      oomScoreAdj.push({ ...base, value: s.oomScoreAdj });
    }
  }

  // Prefer PSS. Fall back to RSS only when PSS is too sparse to describe shape
  // (fewer than 5 points), which happens when dumpsys is throttled.
  const usePss = pss.length >= 5 || rss.length === 0;

  const last = samples[samples.length - 1];
  const first = samples[0];

  return {
    serial,
    role,
    pss,
    rss,
    deviceAvailable,
    oomScoreAdj,
    samples,
    primary: usePss ? pss : rss,
    primaryMetric: usePss ? 'pss' : 'rss',
    durationMs: last && first ? last.t - first.t : 0,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

export interface Regression {
  /** Bytes per millisecond. */
  slope: number;
  intercept: number;
  /** Coefficient of determination - how linear the trend actually is. */
  r2: number;
  /** Convenience: bytes per minute. */
  slopePerMinute: number;
  points: number;
}

/**
 * Ordinary least squares over (elapsedMs, value).
 *
 * r2 is reported alongside the slope because a slope without a fit quality is
 * misleading: sawtooth GC behaviour can produce a positive slope that is not a
 * leak. Detectors require both a slope threshold and a minimum r2.
 */
export function linearRegression(points: SeriesPoint[]): Regression {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.value ?? 0, r2: 0, slopePerMinute: 0, points: n };

  const xs = points.map((p) => p.elapsedMs);
  const ys = points.map((p) => p.value);
  const mx = mean(xs);
  const my = mean(ys);

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    num += dx * ((ys[i] ?? 0) - my);
    den += dx * dx;
  }

  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const y = ys[i] ?? 0;
    const predicted = slope * (xs[i] ?? 0) + intercept;
    ssTot += (y - my) ** 2;
    ssRes += (y - predicted) ** 2;
  }

  return {
    slope,
    intercept,
    r2: ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot),
    slopePerMinute: slope * 60_000,
    points: n,
  };
}

/** Points whose elapsed time falls inside [fromMs, toMs]. */
export function sliceSeries(series: SeriesPoint[], fromMs: number, toMs: number): SeriesPoint[] {
  return series.filter((p) => p.elapsedMs >= fromMs && p.elapsedMs <= toMs);
}

export function maxPoint(series: SeriesPoint[]): SeriesPoint | null {
  if (series.length === 0) return null;
  return series.reduce((best, p) => (p.value > best.value ? p : best), series[0] as SeriesPoint);
}

export function minPoint(series: SeriesPoint[]): SeriesPoint | null {
  if (series.length === 0) return null;
  return series.reduce((best, p) => (p.value < best.value ? p : best), series[0] as SeriesPoint);
}

/** Value of the series at (or just before) a given elapsed time. */
export function valueAt(series: SeriesPoint[], elapsedMs: number): SeriesPoint | null {
  let best: SeriesPoint | null = null;
  for (const p of series) {
    if (p.elapsedMs <= elapsedMs) best = p;
    else break;
  }
  return best ?? series[0] ?? null;
}

/**
 * Stable value around a marker: the median of a window centred on it.
 *
 * A single sample at a marker is noisy - the operator presses the button while
 * a load is still settling. The median over a window is what "the memory at
 * this state" actually means.
 *
 * Use this only for states that are stable on both sides of the marker. For a
 * marker that sits on a *transition* - opening a screen, finishing a flow - a
 * centred window straddles the change and averages the before and after
 * together, which systematically hides retention. Use the directional variants
 * below for those.
 */
export function stableValueAround(
  series: SeriesPoint[],
  elapsedMs: number,
  windowMs = 4000,
): number | null {
  const window = series.filter((p) => Math.abs(p.elapsedMs - elapsedMs) <= windowMs);
  if (window.length === 0) return valueAt(series, elapsedMs)?.value ?? null;
  return median(window.map((p) => p.value));
}

/**
 * Memory just *before* a marker - what the state cost before whatever the
 * marker announces began. This is the correct reference point for "how much did
 * opening this screen add".
 */
export function stableValueBefore(
  series: SeriesPoint[],
  elapsedMs: number,
  windowMs = 5000,
): number | null {
  const window = series.filter(
    (p) => p.elapsedMs <= elapsedMs && p.elapsedMs >= elapsedMs - windowMs,
  );
  if (window.length === 0) return valueAt(series, elapsedMs)?.value ?? null;
  return median(window.map((p) => p.value));
}

/**
 * Memory *after* a marker, once it has had time to settle.
 *
 * `settleMs` skips the transition itself: closing a screen triggers destruction
 * and often a GC, and measuring during that window reports a number that is
 * neither the before nor the after.
 */
export function stableValueAfter(
  series: SeriesPoint[],
  elapsedMs: number,
  windowMs = 5000,
  settleMs = 2000,
): number | null {
  const from = elapsedMs + settleMs;
  const window = series.filter((p) => p.elapsedMs >= from && p.elapsedMs <= from + windowMs);
  if (window.length === 0) {
    // The session ended before the state could settle - fall back to the last
    // value we have rather than reporting nothing.
    const tail = series.filter((p) => p.elapsedMs >= elapsedMs);
    if (tail.length === 0) return valueAt(series, elapsedMs)?.value ?? null;
    return median(tail.map((p) => p.value));
  }
  return median(window.map((p) => p.value));
}
