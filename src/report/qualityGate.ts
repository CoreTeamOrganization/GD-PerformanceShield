/**
 * CI/CD quality gate.
 *
 * A build pipeline cannot read a Markdown report. What it needs is a small,
 * stable JSON document and an exit code, and what a studio needs is for that
 * document to be boring: the same field names in the same places every run, so
 * a Jenkins job written once keeps working.
 *
 * Three design decisions, each of which exists because the alternative causes a
 * pipeline to be ignored:
 *
 *  1. A check that could not be measured is `skipped`, never `pass`. A gate that
 *     silently passes because the probe was unavailable teaches a team that
 *     green means nothing. Skipped checks are counted and named in the payload.
 *  2. Thresholds travel with the result. When a build fails, the payload says
 *     what the limit was, what was measured, and which device tier the limit
 *     came from - so the first question after a red build is answerable without
 *     opening the tool.
 *  3. The overall verdict is `pass`, `warn` or `fail`, and only `fail` is meant
 *     to stop a pipeline. `warn` exists so a team can adopt the gate without
 *     breaking their build on day one.
 *
 * The payload shape is versioned. A pipeline that pins `gateVersion` can be
 * trusted not to break when this file grows a field.
 */
import type { CpuSummary } from '../telemetry/cpuThreads.js';
import type { DiskIoSummary } from '../telemetry/diskIo.js';
import type { AudioSummary } from '../telemetry/audio.js';
import type { GpuSummary, RenderSummary } from '../telemetry/gpu.js';
import type { FpsSummary, ThermalSummary } from '../telemetry/deviceHealth.js';
import type { TierThresholds } from '../analysis/deviceTier.js';
import { MB } from '../core/types.js';

export const GATE_VERSION = 1;

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface GateCheck {
  /** Stable machine name, e.g. `fps.median`. Pipelines key on this. */
  id: string;
  /** What is being checked, for a build log a human reads. */
  label: string;
  status: CheckStatus;
  /** The measured figure, or null when it could not be measured. */
  value: number | null;
  /** The limit that was applied. */
  threshold: number | null;
  /** Which side of the threshold passes. */
  direction: 'at-least' | 'at-most';
  unit: string;
  /** One line for the build log, including why it was skipped when it was. */
  message: string;
}

export interface GateDeviceResult {
  serial: string;
  role: string;
  model: string;
  /** Which tier's thresholds were applied, and why. */
  tier: string;
  tierReason: string;
  status: CheckStatus;
  checks: GateCheck[];
}

export interface QualityGateResult {
  gateVersion: number;
  /** The only field a pipeline strictly needs. */
  status: 'pass' | 'warn' | 'fail';
  /** True when nothing failed. Convenience for a shell one-liner. */
  passed: boolean;
  /** Non-zero when the gate failed, for `process.exit`. */
  exitCode: 0 | 1;
  analysisId: string;
  gameName: string;
  packageName: string | null;
  versionName: string | null;
  commit: string | null;
  generatedAt: string;
  summary: {
    failed: number;
    warned: number;
    passed: number;
    skipped: number;
    /** Named so a build log can print the reason without walking the tree. */
    failedChecks: string[];
    skippedChecks: string[];
  };
  devices: GateDeviceResult[];
}

export interface GateDeviceInput {
  serial: string;
  role: string;
  model: string;
  thresholds: TierThresholds;
  peakBytes: number | null;
  processDeaths: number;
  fps: FpsSummary | null;
  thermal: ThermalSummary | null;
  gpu: GpuSummary | null;
  render: RenderSummary | null;
  cpu: CpuSummary | null;
  io: DiskIoSummary | null;
  audio: AudioSummary | null;
}

export interface BuildGateInput {
  analysisId: string;
  gameName: string;
  packageName: string | null;
  versionName: string | null;
  commit: string | null;
  devices: GateDeviceInput[];
  /**
   * Treat every failure as a warning.
   *
   * For a team adopting the gate: they get the report and the red checks
   * without a broken pipeline, and flip this off when they are ready.
   */
  warnOnly?: boolean;
}

export function buildQualityGate(input: BuildGateInput): QualityGateResult {
  const devices = input.devices.map((device) => buildDeviceResult(device));

  const all = devices.flatMap((d) => d.checks);
  const failed = all.filter((c) => c.status === 'fail');
  const warned = all.filter((c) => c.status === 'warn');
  const skipped = all.filter((c) => c.status === 'skipped');
  const passed = all.filter((c) => c.status === 'pass');

  const status: QualityGateResult['status'] =
    failed.length > 0 && !input.warnOnly
      ? 'fail'
      : failed.length > 0 || warned.length > 0
        ? 'warn'
        : 'pass';

  return {
    gateVersion: GATE_VERSION,
    status,
    passed: status !== 'fail',
    exitCode: status === 'fail' ? 1 : 0,
    analysisId: input.analysisId,
    gameName: input.gameName,
    packageName: input.packageName,
    versionName: input.versionName,
    commit: input.commit,
    generatedAt: new Date().toISOString(),
    summary: {
      failed: failed.length,
      warned: warned.length,
      passed: passed.length,
      skipped: skipped.length,
      failedChecks: failed.map((c) => c.id),
      skippedChecks: skipped.map((c) => c.id),
    },
    devices,
  };
}

function buildDeviceResult(device: GateDeviceInput): GateDeviceResult {
  const t = device.thresholds;
  const checks: GateCheck[] = [];

  // A kill is a hard fail with no threshold to argue about: the process was
  // gone. It leads the list because everything else is secondary to it.
  checks.push({
    id: 'stability.process_deaths',
    label: 'Process survived the session',
    status: device.processDeaths > 0 ? 'fail' : 'pass',
    value: device.processDeaths,
    threshold: 0,
    direction: 'at-most',
    unit: 'deaths',
    message:
      device.processDeaths > 0
        ? `The process died ${device.processDeaths} time(s). On Android this is the low-memory ` +
          'killer choosing this process.'
        : 'The process stayed alive for the whole session.',
  });

  checks.push(
    atMost({
      id: 'memory.peak',
      label: 'Peak memory',
      value: device.peakBytes,
      threshold: t.maxPeakBytes,
      unit: 'bytes',
      format: (v) => `${Math.round(v / MB)} MB`,
      skipReason: 'No memory samples were taken on this device.',
    }),
  );

  checks.push(
    atLeast({
      id: 'fps.median',
      label: 'Median frame rate',
      value: device.fps?.medianFps ?? null,
      threshold: t.minMedianFps,
      unit: 'fps',
      skipReason: 'Frame rate could not be measured on this device.',
    }),
    atLeast({
      id: 'fps.low1',
      label: 'Worst 1% frame rate',
      value: device.fps?.low1PercentFps ?? null,
      threshold: t.minLow1PercentFps,
      unit: 'fps',
      skipReason: 'Per-frame times were not available, so the worst 1% is unknown.',
    }),
    atMost({
      id: 'fps.janks_per_minute',
      label: 'Stutter rate',
      value: device.fps?.janksPerMinute ?? null,
      threshold: t.maxJanksPerMinute,
      unit: 'janks/min',
      skipReason: 'Per-frame times were not available, so stutter could not be counted.',
    }),
  );

  checks.push(
    atMost({
      id: 'thermal.rise',
      label: 'Temperature rise',
      value: device.thermal?.riseC ?? null,
      threshold: t.maxThermalRiseC,
      unit: '°C',
      skipReason: 'No temperature readings were available.',
    }),
  );

  checks.push(
    atMost({
      id: 'render.draw_calls',
      label: 'Draw calls per frame',
      value: device.render?.averageDrawCalls ?? null,
      threshold: t.maxDrawCalls,
      unit: 'calls',
      skipReason:
        'Draw calls come from the Unity reporter component, which was not present in this build.',
    }),
    atMost({
      id: 'render.triangles',
      label: 'Triangles per frame',
      value: device.render?.averageTriangles ?? null,
      threshold: t.maxTriangles,
      unit: 'triangles',
      skipReason:
        'Triangle counts come from the Unity reporter component, which was not present in this build.',
    }),
  );

  checks.push(
    atMost({
      id: 'audio.underruns_per_minute',
      label: 'Audio dropouts',
      value: device.audio?.underrunsPerMinute ?? null,
      threshold: t.maxUnderrunsPerMinute,
      unit: 'underruns/min',
      skipReason: 'The audio mixer did not report underrun counters on this device.',
    }),
  );

  // Storage is gated on the correlation rather than on bandwidth. Reading a lot
  // is not a defect; reading in a way that drops frames is.
  checks.push({
    id: 'storage.stalling_reads',
    label: 'Reads that cost frames',
    status:
      device.io === null || device.io.sampleCount === 0
        ? 'skipped'
        : device.io.burstsWithStutter === 0
          ? 'pass'
          : device.io.burstsWithStutter >= 3
            ? 'fail'
            : 'warn',
    value: device.io?.burstsWithStutter ?? null,
    threshold: 0,
    direction: 'at-most',
    unit: 'bursts',
    message:
      device.io === null || device.io.sampleCount === 0
        ? 'Disk I/O counters were not readable, which needs a debuggable build or a rooted device.'
        : device.io.burstsWithStutter === 0
          ? 'No heavy read coincided with dropped frames.'
          : `${device.io.burstsWithStutter} heavy read(s) landed in a window that also dropped frames.`,
  });

  // The device's own status is the worst of its checks. Skipped does not count
  // against it, but it is reported so nobody reads a green gate as full coverage.
  const worst: CheckStatus = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : checks.every((c) => c.status === 'skipped')
        ? 'skipped'
        : 'pass';

  return {
    serial: device.serial,
    role: device.role,
    model: device.model,
    tier: t.label,
    tierReason: t.reason,
    status: worst,
    checks,
  };
}

interface CheckSpec {
  id: string;
  label: string;
  value: number | null;
  threshold: number;
  unit: string;
  format?: (value: number) => string;
  skipReason: string;
}

/**
 * A margin of 10% either side of a threshold is a warning rather than a
 * failure.
 *
 * Measurement noise is real: two runs of the same build on the same phone
 * differ by a few percent, and a gate that flips red on that is a gate a team
 * turns off. The warning band makes a marginal build visible without stopping
 * it.
 */
const WARN_MARGIN = 0.1;

function atLeast(spec: CheckSpec): GateCheck {
  const format = spec.format ?? ((v: number) => `${v} ${spec.unit}`);
  if (spec.value === null) {
    return {
      ...base(spec, 'at-least'),
      status: 'skipped',
      value: null,
      message: spec.skipReason,
    };
  }

  const status: CheckStatus =
    spec.value >= spec.threshold
      ? 'pass'
      : spec.value >= spec.threshold * (1 - WARN_MARGIN)
        ? 'warn'
        : 'fail';

  return {
    ...base(spec, 'at-least'),
    status,
    value: spec.value,
    message:
      status === 'pass'
        ? `${format(spec.value)}, at or above the ${format(spec.threshold)} required.`
        : `${format(spec.value)}, below the ${format(spec.threshold)} required.`,
  };
}

function atMost(spec: CheckSpec): GateCheck {
  const format = spec.format ?? ((v: number) => `${v} ${spec.unit}`);
  if (spec.value === null) {
    return {
      ...base(spec, 'at-most'),
      status: 'skipped',
      value: null,
      message: spec.skipReason,
    };
  }

  const status: CheckStatus =
    spec.value <= spec.threshold
      ? 'pass'
      : spec.value <= spec.threshold * (1 + WARN_MARGIN)
        ? 'warn'
        : 'fail';

  return {
    ...base(spec, 'at-most'),
    status,
    value: spec.value,
    message:
      status === 'pass'
        ? `${format(spec.value)}, within the ${format(spec.threshold)} allowed.`
        : `${format(spec.value)}, over the ${format(spec.threshold)} allowed.`,
  };
}

function base(spec: CheckSpec, direction: GateCheck['direction']): Omit<GateCheck, 'status' | 'value' | 'message'> {
  return {
    id: spec.id,
    label: spec.label,
    threshold: spec.threshold,
    direction,
    unit: spec.unit,
  };
}
