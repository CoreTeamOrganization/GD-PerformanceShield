/**
 * Step 11 - Repeated Flow Analysis, and the recovery metric from spec section 9.
 *
 * This is the analysis the spec calls the most important one: not "peak was
 * 950 MB", but "returning to the same screen costs +150 MB, then +310 MB, then
 * +470 MB". Peak alone is confounded by device budget and content size;
 * recovery delta across repeats is direct evidence of retention.
 *
 * Cycles are delimited by operator markers. We accept three delimitation
 * styles so the operator is not forced into one button-pressing discipline:
 *   1. explicit `flow_complete` markers,
 *   2. `gameplay_start` / `gameplay_end` pairs,
 *   3. repeated `baseline` markers.
 */
import { findingId } from '../core/ids.js';
import { MB, type Finding, type Severity } from '../core/types.js';
import type { DeviceInfo } from '../devices/deviceManager.js';
import type { TimelineEvent } from '../telemetry/types.js';
import { fmtMb } from './anomaly.js';
import {
  linearRegression,
  maxPoint,
  sliceSeries,
  stableValueAfter,
  stableValueBefore,
  type DeviceTimeline,
  type SessionTimeline,
} from './timeline.js';

export interface FlowCycle {
  index: number;
  label: string;
  startMs: number;
  endMs: number;
  /** Memory at the state the cycle started from. */
  startBytes: number | null;
  peakBytes: number | null;
  peakAtMs: number | null;
  /** Memory once the flow returned to the starting state. */
  recoveredBytes: number | null;
  /** recoveredBytes - startBytes. Positive means memory was retained. */
  recoveryDeltaBytes: number | null;
}

export interface DeviceFlowAnalysis {
  serial: string;
  role: string;
  model: string;
  metric: 'pss' | 'rss';
  cycles: FlowCycle[];
  /** Growth of the per-cycle starting baseline, in bytes per cycle. */
  baselineSlopeBytesPerCycle: number;
  baselineSlopeR2: number;
  /** Mean recovery delta across cycles. */
  meanRecoveryDeltaBytes: number | null;
  /** Cumulative retention from the first to the last cycle. */
  cumulativeRetentionBytes: number | null;
  /** How consistent the cycles are with each other (0..1). */
  repeatability: number | null;
  cycleCount: number;
}

export interface ScreenVisit {
  screen: string;
  openAtMs: number;
  closeAtMs: number | null;
  openBytes: number | null;
  peakBytes: number | null;
  closedBytes: number | null;
  /** Memory still held after the screen was closed. */
  retainedBytes: number | null;
  serial: string;
  role: string;
}

export interface FlowAnalysisResult {
  perDevice: DeviceFlowAnalysis[];
  screenVisits: ScreenVisit[];
  findings: Finding[];
}

export interface FlowAnalysisOptions {
  timeline: SessionTimeline;
  devices: DeviceInfo[];
  /** Retention above this after returning to the start state is reported. */
  retentionThresholdBytes?: number;
}

const DEFAULT_RETENTION_THRESHOLD = 30 * MB;

export function analyzeFlows(opts: FlowAnalysisOptions): FlowAnalysisResult {
  const threshold = opts.retentionThresholdBytes ?? DEFAULT_RETENTION_THRESHOLD;
  const perDevice: DeviceFlowAnalysis[] = [];
  const screenVisits: ScreenVisit[] = [];
  const findings: Finding[] = [];

  const boundaries = deriveCycleBoundaries(opts.timeline.events);

  for (const timeline of opts.timeline.devices) {
    const device = opts.devices.find((d) => d.serial === timeline.serial);
    const analysis = analyzeDeviceFlow(timeline, device?.model ?? 'unknown', boundaries);
    perDevice.push(analysis);

    const visits = analyzeScreenVisits(timeline, opts.timeline.events);
    screenVisits.push(...visits);

    findings.push(...cycleFindings(analysis, threshold, device));
    findings.push(...screenFindings(visits, threshold, analysis.role));
  }

  return { perDevice, screenVisits, findings };
}

interface CycleBoundary {
  index: number;
  label: string;
  startMs: number;
  endMs: number;
}

/**
 * Turn operator markers into cycle windows.
 *
 * The order of preference matters: an explicit `flow_complete` is the
 * operator's clearest statement of intent, so it wins over inference.
 */
export function deriveCycleBoundaries(events: TimelineEvent[]): CycleBoundary[] {
  const operatorEvents = events.filter((e) => e.source !== 'system');

  const completes = operatorEvents.filter((e) => e.type === 'flow_complete');
  if (completes.length >= 1) {
    const boundaries: CycleBoundary[] = [];
    let startMs = operatorEvents[0]?.elapsedMs ?? 0;
    completes.forEach((complete, i) => {
      boundaries.push({
        index: i,
        label: `Cycle ${i + 1}`,
        startMs,
        endMs: complete.elapsedMs,
      });
      startMs = complete.elapsedMs;
    });
    return boundaries;
  }

  const starts = operatorEvents.filter((e) => e.type === 'gameplay_start');
  const ends = operatorEvents.filter((e) => e.type === 'gameplay_end');
  if (starts.length >= 1 && ends.length >= 1) {
    const boundaries: CycleBoundary[] = [];
    starts.forEach((start, i) => {
      const end = ends.find((e) => e.elapsedMs > start.elapsedMs);
      const nextStart = starts[i + 1];
      // A cycle runs from gameplay start until the *next* cycle begins, so the
      // return-to-menu recovery falls inside the cycle being measured.
      const endMs = nextStart?.elapsedMs ?? end?.elapsedMs ?? start.elapsedMs;
      if (endMs > start.elapsedMs) {
        boundaries.push({
          index: i,
          label: `Gameplay cycle ${i + 1}`,
          startMs: start.elapsedMs,
          endMs,
        });
      }
    });
    return boundaries;
  }

  const baselines = operatorEvents.filter((e) => e.type === 'baseline');
  if (baselines.length >= 2) {
    const boundaries: CycleBoundary[] = [];
    for (let i = 0; i < baselines.length - 1; i++) {
      const a = baselines[i];
      const b = baselines[i + 1];
      if (!a || !b) continue;
      boundaries.push({
        index: i,
        label: `Baseline-to-baseline ${i + 1}`,
        startMs: a.elapsedMs,
        endMs: b.elapsedMs,
      });
    }
    return boundaries;
  }

  return [];
}

function analyzeDeviceFlow(
  timeline: DeviceTimeline,
  model: string,
  boundaries: CycleBoundary[],
): DeviceFlowAnalysis {
  const series = timeline.primary;

  const cycles: FlowCycle[] = boundaries.map((b) => {
    const window = sliceSeries(series, b.startMs, b.endMs);
    const peak = maxPoint(window);
    // Directional windows: the cycle's starting level is what memory was
    // *before* the flow began, and the recovered level is what it settles to
    // *after* the flow ends. A centred window would blend the two and hide
    // exactly the retention this analysis exists to measure.
    const startBytes = stableValueBefore(series, b.startMs);
    const recoveredBytes = stableValueAfter(series, b.endMs);

    return {
      index: b.index,
      label: b.label,
      startMs: b.startMs,
      endMs: b.endMs,
      startBytes,
      peakBytes: peak?.value ?? null,
      peakAtMs: peak?.elapsedMs ?? null,
      recoveredBytes,
      recoveryDeltaBytes:
        startBytes !== null && recoveredBytes !== null ? recoveredBytes - startBytes : null,
    };
  });

  // Baseline slope across cycles: does each repeat start higher than the last?
  const baselinePoints = cycles
    .map((c, i) => ({ t: i, elapsedMs: i, value: c.startBytes ?? NaN }))
    .filter((p) => Number.isFinite(p.value));
  const baselineRegression = linearRegression(baselinePoints);

  const deltas = cycles
    .map((c) => c.recoveryDeltaBytes)
    .filter((d): d is number => d !== null);
  const meanRecoveryDeltaBytes =
    deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;

  const firstStart = cycles[0]?.startBytes ?? null;
  const lastRecovered = cycles[cycles.length - 1]?.recoveredBytes ?? null;
  const cumulativeRetentionBytes =
    firstStart !== null && lastRecovered !== null ? lastRecovered - firstStart : null;

  return {
    serial: timeline.serial,
    role: timeline.role,
    model,
    metric: timeline.primaryMetric,
    cycles,
    baselineSlopeBytesPerCycle: baselineRegression.slope,
    baselineSlopeR2: baselineRegression.r2,
    meanRecoveryDeltaBytes,
    cumulativeRetentionBytes,
    repeatability: computeRepeatability(cycles),
    cycleCount: cycles.length,
  };
}

/**
 * How similar the cycles are to each other, as 1 - (stddev / mean) of peak
 * memory. Low repeatability means the test itself was inconsistent and the
 * recovery numbers deserve less confidence.
 */
function computeRepeatability(cycles: FlowCycle[]): number | null {
  const peaks = cycles.map((c) => c.peakBytes).filter((p): p is number => p !== null);
  if (peaks.length < 2) return null;
  const mean = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  if (mean === 0) return null;
  const sd = Math.sqrt(peaks.reduce((acc, p) => acc + (p - mean) ** 2, 0) / peaks.length);
  return Math.max(0, Math.min(1, 1 - sd / mean));
}

/**
 * Pair screen-open markers with the next `screen_close`, and measure what was
 * still held afterwards. This is the mechanism behind the Shop example in spec
 * section 12.
 */
export function analyzeScreenVisits(
  timeline: DeviceTimeline,
  events: TimelineEvent[],
): ScreenVisit[] {
  const series = timeline.primary;
  const visits: ScreenVisit[] = [];
  const screenOpenTypes = new Set(['shop', 'inventory', 'settings', 'main_menu', 'custom']);

  const operatorEvents = events.filter((e) => e.source !== 'system');

  for (let i = 0; i < operatorEvents.length; i++) {
    const open = operatorEvents[i];
    if (!open || !screenOpenTypes.has(open.type)) continue;

    const close = operatorEvents
      .slice(i + 1)
      .find((e) => e.type === 'screen_close' || screenOpenTypes.has(e.type));
    if (!close) continue;

    // Only a genuine close tells us whether memory was released; moving
    // straight to another screen tells us nothing about release.
    const isRealClose = close.type === 'screen_close';
    const openBytes = stableValueBefore(series, open.elapsedMs);
    const window = sliceSeries(series, open.elapsedMs, close.elapsedMs);
    const peak = maxPoint(window);
    const closedBytes = isRealClose ? stableValueAfter(series, close.elapsedMs) : null;

    visits.push({
      screen: open.label,
      openAtMs: open.elapsedMs,
      closeAtMs: isRealClose ? close.elapsedMs : null,
      openBytes,
      peakBytes: peak?.value ?? null,
      closedBytes,
      retainedBytes: openBytes !== null && closedBytes !== null ? closedBytes - openBytes : null,
      serial: timeline.serial,
      role: timeline.role,
    });
  }

  return visits;
}

function cycleFindings(
  analysis: DeviceFlowAnalysis,
  threshold: number,
  device: DeviceInfo | undefined,
): Finding[] {
  const findings: Finding[] = [];
  if (analysis.cycleCount === 0) return findings;

  const mean = analysis.meanRecoveryDeltaBytes;
  const cumulative = analysis.cumulativeRetentionBytes;

  if (mean !== null && mean > threshold) {
    const perCycle = analysis.baselineSlopeBytesPerCycle;
    const severity: Severity =
      mean > 200 * MB ? 'critical' : mean > 100 * MB ? 'high' : mean > 50 * MB ? 'medium' : 'low';

    const cycleLines = analysis.cycles
      .filter((c) => c.recoveryDeltaBytes !== null)
      .map(
        (c) =>
          `${c.label}: start ${fmtOrDash(c.startBytes)}, peak ${fmtOrDash(c.peakBytes)}, ` +
          `returned ${fmtOrDash(c.recoveredBytes)} (delta ${signed(c.recoveryDeltaBytes)})`,
      );

    findings.push({
      ruleId: 'LIVE.RECOVERY_FAILURE',
      id: findingId('LIVE.RECOVERY_FAILURE', analysis.serial),
      source: 'live',
      title: `Memory is not released after each cycle on Device ${analysis.role} (+${fmtMb(mean)} per repeat)`,
      description:
        `Across ${analysis.cycleCount} repeats of the same flow, returning to the starting state left an ` +
        `average of ${fmtMb(mean)} still allocated` +
        (cumulative !== null ? `, and ${fmtMb(cumulative)} in total by the final repeat` : '') +
        '. Memory that is never given back after returning to the same screen is retained, not merely ' +
        'in use - each repeat starts the next one closer to the limit.',
      severity,
      confidence: analysis.cycleCount >= 3 ? 0.9 : 0.7,
      recommendation:
        'Audit what the flow allocates and what releases it. Common causes: Addressables handles never ' +
        'released, event subscriptions kept alive by a persistent object, instantiated material ' +
        'instances, and cached UI or level objects that are recreated rather than reused.',
      evidence: [
        {
          kind: 'timeline',
          summary: `Per-cycle recovery on ${analysis.model}`,
          data: {
            cycles: analysis.cycles,
            meanRecoveryDeltaBytes: mean,
            baselineSlopeBytesPerCycle: perCycle,
            baselineSlopeR2: analysis.baselineSlopeR2,
            metric: analysis.metric,
          },
          excerpt: cycleLines.join('\n'),
        },
        ...(device
          ? [
              {
                kind: 'note' as const,
                summary: `Device: ${device.manufacturer} ${device.model}, ${(device.totalRamBytes / (1024 * MB)).toFixed(1)} GB RAM`,
              },
            ]
          : []),
      ],
      estimatedBytes: cumulative ?? mean,
      subject: 'repeated flow retention',
      tags: ['retention', 'recovery', `device:${analysis.role}`],
    });
  }

  // A rising per-cycle *starting* baseline is the clearest leak signature there
  // is, and it is worth reporting separately from the average delta.
  if (
    analysis.cycleCount >= 3 &&
    analysis.baselineSlopeBytesPerCycle > threshold &&
    analysis.baselineSlopeR2 > 0.7
  ) {
    findings.push({
      ruleId: 'LIVE.BASELINE_CLIMB',
      id: findingId('LIVE.BASELINE_CLIMB', analysis.serial),
      source: 'live',
      title: `Each repeat starts ${fmtMb(analysis.baselineSlopeBytesPerCycle)} higher than the last (Device ${analysis.role})`,
      description:
        `The starting memory of each cycle rose consistently by about ` +
        `${fmtMb(analysis.baselineSlopeBytesPerCycle)} per repeat (fit R2 = ${analysis.baselineSlopeR2.toFixed(2)}). ` +
        'A baseline that climbs monotonically will eventually cross the device limit no matter how modest ' +
        'the peak of any single cycle is.',
      severity: 'critical',
      confidence: 0.92,
      recommendation:
        'Extend the repeat count until the baseline stops rising or the app dies, then compare a memory ' +
        'snapshot from cycle 1 against the last cycle to identify the object types that accumulate.',
      evidence: [
        {
          kind: 'metric',
          summary: `Baseline slope ${fmtMb(analysis.baselineSlopeBytesPerCycle)}/cycle over ${analysis.cycleCount} cycles`,
          data: {
            slopeBytesPerCycle: analysis.baselineSlopeBytesPerCycle,
            r2: analysis.baselineSlopeR2,
            startBytes: analysis.cycles.map((c) => c.startBytes),
          },
        },
      ],
      estimatedBytes: analysis.baselineSlopeBytesPerCycle * analysis.cycleCount,
      subject: 'baseline climb',
      tags: ['retention', 'leak', `device:${analysis.role}`],
    });
  }

  return findings;
}

function screenFindings(visits: ScreenVisit[], threshold: number, role: string): Finding[] {
  // Group repeated visits to the same screen: one finding per screen, not one
  // per visit, with the repeats as supporting evidence.
  const byScreen = new Map<string, ScreenVisit[]>();
  for (const visit of visits) {
    if (visit.retainedBytes === null) continue;
    const list = byScreen.get(visit.screen) ?? [];
    list.push(visit);
    byScreen.set(visit.screen, list);
  }

  const findings: Finding[] = [];
  for (const [screen, screenVisits] of byScreen) {
    const retained = screenVisits.map((v) => v.retainedBytes ?? 0);
    const meanRetained = retained.reduce((a, b) => a + b, 0) / retained.length;
    if (meanRetained <= threshold) continue;

    // Only visits where both ends were actually read: a null peak defaulted to
    // zero made this "cost about -450.0 MB" - a peak that was never sampled is
    // not a peak of zero.
    const costs = screenVisits
      .filter((v) => v.peakBytes != null && v.openBytes != null)
      .map((v) => v.peakBytes! - v.openBytes!);
    const peakCost = costs.length > 0 ? Math.max(...costs) : null;

    findings.push({
      ruleId: 'LIVE.SCREEN_RETENTION',
      id: findingId('LIVE.SCREEN_RETENTION', `${role}:${screen}`),
      source: 'live',
      title: `"${screen}" keeps ${fmtMb(meanRetained)} after being closed (Device ${role})`,
      description:
        (peakCost !== null && peakCost > 0
          ? `Opening "${screen}" cost about ${fmtMb(peakCost)}, and ${fmtMb(meanRetained)} of that was still `
          : `"${screen}" left memory ${fmtMb(meanRetained)} higher than before it opened, still `) +
        `held after it was closed` +
        (screenVisits.length > 1 ? `, consistently across ${screenVisits.length} visits` : '') +
        '. Closing a screen should return it to roughly the memory level it started from.',
      severity: meanRetained > 150 * MB ? 'high' : meanRetained > 60 * MB ? 'medium' : 'low',
      confidence: screenVisits.length > 1 ? 0.85 : 0.7,
      recommendation:
        `Check how "${screen}" loads and unloads its content. If it uses Addressables, verify every ` +
        'handle is released when the screen closes; if it instantiates UI, verify the objects are ' +
        'destroyed rather than deactivated; if it shows item icons, verify the atlas is unloaded.',
      evidence: screenVisits.slice(0, 5).map((v) => ({
        kind: 'timeline' as const,
        summary:
          `Visit at ${(v.openAtMs / 1000).toFixed(0)}s: opened at ${fmtOrDash(v.openBytes)}, ` +
          `peaked ${fmtOrDash(v.peakBytes)}, after close ${fmtOrDash(v.closedBytes)} ` +
          `(retained ${signed(v.retainedBytes)})`,
        data: { ...v },
      })),
      estimatedBytes: meanRetained,
      subject: screen,
      tags: ['retention', 'screen', `device:${role}`, `screen:${screen.toLowerCase()}`],
    });
  }

  return findings;
}

function fmtOrDash(bytes: number | null): string {
  return bytes === null ? '-' : fmtMb(bytes);
}

function signed(bytes: number | null): string {
  if (bytes === null) return '-';
  return `${bytes >= 0 ? '+' : ''}${fmtMb(bytes)}`;
}
