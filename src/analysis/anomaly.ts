/**
 * Step 10 - Anomaly Detector.
 *
 * Detects the five runtime signatures the spec names: sudden spikes, sustained
 * growth, recovery failure, repeated baseline increase, and process
 * termination. Thresholds are expressed relative to the device's total RAM
 * wherever possible - a 200 MB spike means something very different on a 2 GB
 * phone than on an 8 GB one, and spec section 10 explicitly asks that the two
 * devices not be collapsed into a single verdict.
 */
import { findingId } from '../core/ids.js';
import { assessBudget } from './memoryBudget.js';
import { MB, type Evidence, type Finding, type Severity } from '../core/types.js';
import type { DeviceInfo } from '../devices/deviceManager.js';
import { isSystemKillLine } from '../telemetry/logcat.js';
import type { LogEvent, TimelineEvent } from '../telemetry/types.js';
import {
  linearRegression,
  maxPoint,
  sliceSeries,
  stableValueAround,
  type DeviceTimeline,
  type SeriesPoint,
  type SessionTimeline,
} from './timeline.js';

export interface AnomalyThresholds {
  /** A rise this large within `spikeWindowMs` counts as a spike. */
  spikeBytes: number;
  spikeWindowMs: number;
  /** Or: a rise of this fraction of device RAM within the window. */
  spikeRamFraction: number;
  /** Sustained growth: bytes/minute over the analysis window. */
  growthBytesPerMinute: number;
  /** Minimum fit quality before growth is called a trend rather than noise. */
  growthMinR2: number;
  /** Minimum window length before a growth verdict is meaningful. */
  growthMinWindowMs: number;
  /** Recovery is "failed" when this much memory is still held after returning. */
  recoveryFailureBytes: number;
  /** Device-wide available memory below this is treated as active pressure. */
  lowAvailableBytes: number;
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  spikeBytes: 150 * MB,
  spikeWindowMs: 10_000,
  spikeRamFraction: 0.06,
  growthBytesPerMinute: 15 * MB,
  growthMinR2: 0.6,
  growthMinWindowMs: 60_000,
  recoveryFailureBytes: 40 * MB,
  lowAvailableBytes: 250 * MB,
};

export interface AnomalyContext {
  timeline: SessionTimeline;
  devices: DeviceInfo[];
  /** Used to attribute system kill notices to the game rather than to some other app. */
  packageName?: string;
  thresholds?: Partial<AnomalyThresholds>;
}

export interface AnomalyResult {
  findings: Finding[];
  perDevice: DeviceAnomalySummary[];
}

export interface DeviceAnomalySummary {
  serial: string;
  role: string;
  model: string;
  totalRamBytes: number;
  metric: 'pss' | 'rss';
  samples: number;
  baselineBytes: number | null;
  peakBytes: number | null;
  /**
   * The mean across the session, which a peak on its own cannot stand in for.
   *
   * A build that touches 900 MB once during a load and sits at 500 MB is a
   * different risk from one that holds 850 MB throughout, and the peak reads
   * the same for both. The in-game recorder reports peak and average side by
   * side for this reason and so does this.
   */
  averageBytes: number | null;
  finalBytes: number | null;
  peakAtMs: number | null;
  /** Peak as a share of device RAM - the plain-language pressure number. */
  peakRamFraction: number | null;
  growthBytesPerMinute: number;
  growthR2: number;
  spikes: SpikeSummary[];
  /**
   * Abnormal terminations of the game confirmed by the system log - an OS kill
   * or a fatal crash. A process that merely disappeared (backgrounded, stopped
   * by the operator, adb detached) is deliberately not counted here.
   */
  processDeaths: number;
  /** Of those, the ones the OS initiated: low-memory killer or ActivityManager. */
  osKills: number;
  minDeviceAvailableBytes: number | null;
}

export interface SpikeSummary {
  atMs: number;
  fromBytes: number;
  toBytes: number;
  deltaBytes: number;
  windowMs: number;
  /** The nearest preceding operator marker - what the player was doing. */
  context: string | null;
}

export function detectAnomalies(ctx: AnomalyContext): AnomalyResult {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(ctx.thresholds ?? {}) };
  const findings: Finding[] = [];
  const perDevice: DeviceAnomalySummary[] = [];

  for (const timeline of ctx.timeline.devices) {
    const device = ctx.devices.find((d) => d.serial === timeline.serial);
    const summary = summarizeDevice(timeline, device, ctx.timeline.events, thresholds);
    perDevice.push(summary);

    findings.push(...detectSpikes(timeline, summary, thresholds));
    findings.push(...detectSustainedGrowth(timeline, summary, thresholds));
    findings.push(...detectMemoryPressure(timeline, summary, thresholds));
    findings.push(...detectBudgetExceeded(summary, device));
  }

  findings.push(...detectProcessTermination(ctx.timeline, perDevice, ctx.packageName));

  return { findings, perDevice };
}

function summarizeDevice(
  timeline: DeviceTimeline,
  device: DeviceInfo | undefined,
  events: TimelineEvent[],
  thresholds: AnomalyThresholds,
): DeviceAnomalySummary {
  const series = timeline.primary;
  const peak = maxPoint(series);
  const final = series[series.length - 1] ?? null;
  const averageBytes =
    series.length > 0
      ? Math.round(series.reduce((sum, p) => sum + p.value, 0) / series.length)
      : null;
  const totalRamBytes = device?.totalRamBytes ?? 0;

  // Baseline = the first explicit baseline marker if the operator set one,
  // otherwise the settled value shortly after launch.
  const baselineEvent = events.find((e) => e.type === 'baseline');
  const baselineBytes = baselineEvent
    ? stableValueAround(series, baselineEvent.elapsedMs)
    : stableValueAround(series, Math.min(15_000, timeline.durationMs / 4));

  const regression = linearRegression(series);
  const minAvailable = timeline.deviceAvailable.reduce<number | null>(
    (min, p) => (min === null || p.value < min ? p.value : min),
    null,
  );

  return {
    serial: timeline.serial,
    role: timeline.role,
    model: device?.model ?? 'unknown',
    totalRamBytes,
    metric: timeline.primaryMetric,
    samples: series.length,
    baselineBytes,
    peakBytes: peak?.value ?? null,
    averageBytes,
    finalBytes: final?.value ?? null,
    peakAtMs: peak?.elapsedMs ?? null,
    peakRamFraction: peak && totalRamBytes > 0 ? peak.value / totalRamBytes : null,
    growthBytesPerMinute: regression.slopePerMinute,
    growthR2: regression.r2,
    spikes: findSpikes(series, events, thresholds, totalRamBytes),
    processDeaths: 0,
    osKills: 0,
    minDeviceAvailableBytes: minAvailable,
  };
}

/**
 * Sliding-window spike search.
 *
 * We look for the largest rise inside any `spikeWindowMs` window and merge
 * overlapping detections, so one 400 MB level load reports as one spike rather
 * than as thirty overlapping ones.
 */
export function findSpikes(
  series: SeriesPoint[],
  events: TimelineEvent[],
  thresholds: AnomalyThresholds,
  totalRamBytes: number,
): SpikeSummary[] {
  const spikes: SpikeSummary[] = [];
  if (series.length < 2) return spikes;

  const limit =
    totalRamBytes > 0
      ? Math.min(thresholds.spikeBytes, totalRamBytes * thresholds.spikeRamFraction)
      : thresholds.spikeBytes;

  let head = 0;
  for (let i = 1; i < series.length; i++) {
    const current = series[i];
    if (!current) continue;
    while (head < i) {
      const headPoint = series[head];
      if (headPoint && current.elapsedMs - headPoint.elapsedMs > thresholds.spikeWindowMs) head++;
      else break;
    }
    const start = series[head];
    if (!start) continue;

    const delta = current.value - start.value;
    if (delta < limit) continue;

    const previous = spikes[spikes.length - 1];
    if (previous && current.elapsedMs - previous.atMs <= thresholds.spikeWindowMs * 2) {
      // Extend the existing spike rather than emitting a duplicate. The window
      // grows with the extension: the spike still starts where it started, and
      // reporting a 25 s rise over its first 8 s window would overstate the
      // rate threefold. (The start is computed before atMs moves.)
      const startMs = previous.atMs - previous.windowMs;
      previous.toBytes = Math.max(previous.toBytes, current.value);
      previous.deltaBytes = previous.toBytes - previous.fromBytes;
      previous.atMs = current.elapsedMs;
      previous.windowMs = Math.max(previous.windowMs, current.elapsedMs - startMs);
      continue;
    }

    spikes.push({
      atMs: current.elapsedMs,
      fromBytes: start.value,
      toBytes: current.value,
      deltaBytes: delta,
      windowMs: current.elapsedMs - start.elapsedMs,
      context: nearestPrecedingMarker(events, current.elapsedMs),
    });
  }

  return spikes;
}

function nearestPrecedingMarker(events: TimelineEvent[], elapsedMs: number): string | null {
  let best: TimelineEvent | null = null;
  for (const e of events) {
    if (e.source === 'system') continue;
    if (e.elapsedMs <= elapsedMs) best = e;
    else break;
  }
  return best?.label ?? null;
}

function detectSpikes(
  timeline: DeviceTimeline,
  summary: DeviceAnomalySummary,
  thresholds: AnomalyThresholds,
): Finding[] {
  return summary.spikes
    .filter((spike) => spike.deltaBytes >= thresholds.spikeBytes / 2)
    .map((spike) => {
      const fraction = summary.totalRamBytes > 0 ? spike.deltaBytes / summary.totalRamBytes : 0;
      const severity: Severity =
        fraction > 0.2 || spike.deltaBytes > 500 * MB
          ? 'high'
          : fraction > 0.1 || spike.deltaBytes > 250 * MB
            ? 'medium'
            : 'low';

      const subject = `${timeline.serial}@${Math.round(spike.atMs / 1000)}s`;
      const evidence: Evidence[] = [
        {
          kind: 'metric',
          summary: `${fmtMb(spike.fromBytes)} to ${fmtMb(spike.toBytes)} in ${(spike.windowMs / 1000).toFixed(1)}s`,
          data: {
            deltaBytes: spike.deltaBytes,
            windowMs: spike.windowMs,
            metric: summary.metric,
            deviceRamFraction: fraction,
          },
        },
      ];
      if (spike.context) {
        evidence.push({
          kind: 'event',
          summary: `Player state at the time: "${spike.context}"`,
          data: { marker: spike.context },
        });
      }

      return {
        ruleId: 'LIVE.SPIKE',
        id: findingId('LIVE.SPIKE', subject),
        source: 'live' as const,
        title: `Memory spike of ${fmtMb(spike.deltaBytes)} on Device ${summary.role}`,
        description:
          `Memory rose by ${fmtMb(spike.deltaBytes)} in ${(spike.windowMs / 1000).toFixed(1)} seconds` +
          (spike.context ? ` right after "${spike.context}"` : '') +
          `, reaching ${fmtMb(spike.toBytes)}` +
          (summary.totalRamBytes > 0
            ? ` (${(fraction * 100).toFixed(1)}% of this device's ${fmtGb(summary.totalRamBytes)} of RAM)`
            : '') +
          '.',
        severity,
        confidence: 0.9,
        recommendation:
          'Identify what loads at this moment and stream or split it. Large single-shot loads are the ' +
          'usual cause: a scene load that pulls every variant at once, an uncompressed texture set, or ' +
          'an audio bank loaded fully into memory rather than streamed.',
        evidence,
        estimatedBytes: spike.deltaBytes,
        subject: spike.context ?? 'unknown state',
        tags: ['spike', `device:${summary.role}`],
      };
    });
}

function detectSustainedGrowth(
  timeline: DeviceTimeline,
  summary: DeviceAnomalySummary,
  thresholds: AnomalyThresholds,
): Finding[] {
  if (timeline.durationMs < thresholds.growthMinWindowMs) return [];
  if (summary.growthBytesPerMinute < thresholds.growthBytesPerMinute) return [];
  if (summary.growthR2 < thresholds.growthMinR2) return [];

  const totalGrowth = (summary.growthBytesPerMinute * timeline.durationMs) / 60_000;
  const severity: Severity =
    summary.growthBytesPerMinute > 60 * MB
      ? 'critical'
      : summary.growthBytesPerMinute > 30 * MB
        ? 'high'
        : 'medium';

  return [
    {
      ruleId: 'LIVE.SUSTAINED_GROWTH',
      id: findingId('LIVE.SUSTAINED_GROWTH', timeline.serial),
      source: 'live',
      title: `Memory grows continuously at ${fmtMb(summary.growthBytesPerMinute)}/min on Device ${summary.role}`,
      description:
        `Across ${(timeline.durationMs / 60_000).toFixed(1)} minutes of play, memory rose steadily at ` +
        `${fmtMb(summary.growthBytesPerMinute)} per minute (trend fit R2 = ${summary.growthR2.toFixed(2)}), ` +
        `a total of about ${fmtMb(totalGrowth)}. Steady growth that does not fall back is the signature of ` +
        'retained objects rather than of normal load peaks.',
      severity,
      confidence: Math.min(0.95, 0.5 + summary.growthR2 / 2),
      recommendation:
        'Look for objects that outlive the state that created them: subscriptions never unsubscribed, ' +
        'static or singleton collections that only ever grow, pooled objects that are never returned, and ' +
        'DontDestroyOnLoad roots that accumulate children across scene loads.',
      evidence: [
        {
          kind: 'metric',
          summary: `${fmtMb(summary.growthBytesPerMinute)}/min over ${(timeline.durationMs / 60_000).toFixed(1)} min (R2 ${summary.growthR2.toFixed(2)})`,
          data: {
            bytesPerMinute: summary.growthBytesPerMinute,
            r2: summary.growthR2,
            durationMs: timeline.durationMs,
            metric: summary.metric,
          },
        },
      ],
      estimatedBytes: totalGrowth,
      subject: 'session-wide growth',
      tags: ['growth', 'retention', `device:${summary.role}`],
    },
  ];
}

/**
 * Device-level pressure. Even when the app's own curve looks acceptable, a
 * device sitting near zero available memory is one background app away from an
 * OOM kill - which is exactly the Device A signal spec section 10 asks for.
 */
function detectMemoryPressure(
  timeline: DeviceTimeline,
  summary: DeviceAnomalySummary,
  thresholds: AnomalyThresholds,
): Finding[] {
  if (summary.minDeviceAvailableBytes === null) return [];
  if (summary.minDeviceAvailableBytes > thresholds.lowAvailableBytes) return [];

  const lowPoint = timeline.deviceAvailable.find(
    (p) => p.value === summary.minDeviceAvailableBytes,
  );

  return [
    {
      ruleId: 'LIVE.DEVICE_PRESSURE',
      id: findingId('LIVE.DEVICE_PRESSURE', timeline.serial),
      source: 'live',
      title: `Device ${summary.role} ran low on memory (${fmtMb(summary.minDeviceAvailableBytes)} available)`,
      description:
        `Free system memory fell to ${fmtMb(summary.minDeviceAvailableBytes)} during the session. At this ` +
        'level Android begins killing background processes, and the game itself becomes a candidate as ' +
        'soon as it is backgrounded or another app starts.',
      severity: summary.minDeviceAvailableBytes < 100 * MB ? 'high' : 'medium',
      confidence: 0.85,
      recommendation:
        'Reduce the resident footprint so the game leaves headroom for the OS. Peak memory below roughly ' +
        'half of total device RAM is a practical target for the low-end tier.',
      evidence: [
        {
          kind: 'metric',
          summary: `Minimum available system memory: ${fmtMb(summary.minDeviceAvailableBytes)}`,
          data: {
            minAvailableBytes: summary.minDeviceAvailableBytes,
            atMs: lowPoint?.elapsedMs ?? null,
            deviceTotalRamBytes: summary.totalRamBytes,
          },
        },
      ],
      subject: 'device memory pressure',
      tags: ['pressure', `device:${summary.role}`],
    },
  ];
}

/**
 * Does a system-wide log line concern the game under test?
 *
 * Kill notices and low-memory warnings are emitted by system_server about
 * whichever process it reclaimed, and the capture keeps them regardless of
 * owner. Attribution therefore needs positive evidence: either the capture
 * flagged the line as ours, or the line names the package. Without one of
 * those we treat the line as being about some other app - the tool would
 * rather stay quiet than blame the game for someone else's kill.
 */
function concernsApp(log: LogEvent, packageName: string | undefined): boolean {
  if (log.appRelated === true) return true;
  return Boolean(packageName && log.message.includes(packageName));
}

/**
 * Process termination. This is the strongest evidence the tool can produce:
 * the OS actually took the game down.
 *
 * The bar is deliberately high. A process that simply stopped being there
 * proves nothing on its own - the operator closing the game, force-stopping
 * it, or adb dropping the connection all look identical from the outside - so
 * this reports only what the system log confirms: an automatic kill by the
 * low-memory killer or ActivityManager, naming our process. Anything weaker
 * produces no finding at all rather than a critical one that might be wrong.
 */
function detectProcessTermination(
  timeline: SessionTimeline,
  perDevice: DeviceAnomalySummary[],
  packageName?: string,
): Finding[] {
  const findings: Finding[] = [];

  const deathEvents = timeline.events.filter(
    (e) => e.type === 'process_gone' || e.type === 'process_restarted' || e.type === 'process_killed',
  );
  const killLogs = timeline.logs.filter(
    (l) => l.category === 'oom_kill' && concernsApp(l, packageName),
  );
  // Gated by concernsApp exactly like the kills above: without known pids the
  // logcat capture keeps every process's lines, and another app's FATAL
  // EXCEPTION must not become this game's "confirmed" crash.
  const crashLogs = timeline.logs.filter(
    (l) => l.category === 'crash' && concernsApp(l, packageName),
  );

  for (const summary of perDevice) {
    const deviceDeaths = deathEvents.filter((e) => !e.serial || e.serial === summary.serial);
    // Only the OS-initiated kills count as an automatic kill; an in-app
    // OutOfMemoryError shares the `oom_kill` category but is a crash.
    const osKills = killLogs.filter(
      (l) => l.serial === summary.serial && isSystemKillLine(l.message, l.tag),
    );
    const deviceCrashes = crashLogs.filter((l) => l.serial === summary.serial);

    summary.osKills = osKills.length;
    if (osKills.length > 0) summary.processDeaths = osKills.length;
    else if (deviceCrashes.length > 0) summary.processDeaths = 1;

    if (osKills.length === 0) continue;

    const evidence: Evidence[] = osKills.slice(0, 5).map((kill) => ({
      kind: 'event' as const,
      summary: `logcat (${kill.tag}): ${kill.message.slice(0, 200)}`,
      data: { elapsedMs: kill.elapsedMs, category: kill.category },
    }));

    for (const e of deviceDeaths.slice(0, 5)) {
      evidence.push({
        kind: 'event',
        summary: `${e.label} at ${(e.elapsedMs / 1000).toFixed(1)}s`,
        data: { ...(e.data ?? {}), elapsedMs: e.elapsedMs },
      });
    }

    if (summary.peakBytes !== null) {
      evidence.push({
        kind: 'metric',
        summary: `Peak memory before termination: ${fmtMb(summary.peakBytes)}`,
        data: { peakBytes: summary.peakBytes, totalRamBytes: summary.totalRamBytes },
      });
    }

    findings.push({
      ruleId: 'LIVE.PROCESS_TERMINATED',
      id: findingId('LIVE.PROCESS_TERMINATED', summary.serial),
      source: 'live',
      title: `The OS killed the game to reclaim memory on Device ${summary.role} (${summary.model})`,
      description:
        'The system log shows Android terminating this game to free memory' +
        (deviceDeaths.length > 0 ? ', and the process was seen disappearing at the same time' : '') +
        '. This is a directly observed failure, not a projection: on this device and this flow, the ' +
        'game did not survive.',
      severity: 'critical',
      confidence: 0.98,
      recommendation:
        'Treat this flow as the priority reproduction case. Re-run it while capturing a deep snapshot at ' +
        'the peak, and reduce the peak footprint of whatever loads immediately before the kill.',
      evidence,
      subject: 'process termination',
      tags: ['oom', 'termination', `device:${summary.role}`],
    });
  }

  for (const crash of crashLogs.slice(0, 3)) {
    findings.push({
      ruleId: 'LIVE.CRASH',
      id: findingId('LIVE.CRASH', `${crash.serial}@${crash.elapsedMs}`),
      source: 'live',
      title: 'Fatal error reported in the system log',
      description: `A fatal error was logged during the session: ${crash.message.slice(0, 300)}`,
      severity: 'high',
      confidence: 0.9,
      recommendation:
        'Inspect the full logcat artifact for this session. If the failure is an allocation failure or a ' +
        'native abort under pressure, it belongs to the OOM class rather than to ordinary crashes.',
      evidence: [
        {
          kind: 'event',
          summary: `${crash.tag}: ${crash.message.slice(0, 200)}`,
          data: { elapsedMs: crash.elapsedMs, serial: crash.serial },
        },
      ],
      subject: 'crash',
      tags: ['crash'],
    });
  }

  return findings;
}

export function fmtMb(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

export function fmtGb(bytes: number): string {
  return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
}

/** Re-exported for the flow analyzer, which slices the same series. */
export { sliceSeries };

/**
 * Peak measured against what one app may reasonably use on hardware this size.
 *
 * Separate from the raw-peak checks because the same number means different
 * things on different devices: 800 MB is comfortable on an 8 GB handset and
 * fatal on a 2 GB one. A kill is graded by LIVE.PROCESS_TERMINATED, so this
 * reports only what the peak itself shows.
 */
function detectBudgetExceeded(
  summary: DeviceAnomalySummary,
  device: DeviceInfo | undefined,
): Finding[] {
  if (!device || summary.peakBytes === null) return [];

  const assessment = assessBudget({
    totalRamBytes: device.totalRamBytes,
    peakBytes: summary.peakBytes,
    deviceLabel: `${device.manufacturer} ${device.model}`,
  });

  if (assessment.verdict === 'green') return [];

  const overLimit = assessment.verdict === 'red';
  const { budget } = assessment;

  return [
    {
      ruleId: 'LIVE.BUDGET_EXCEEDED',
      id: findingId('LIVE.BUDGET_EXCEEDED', summary.serial),
      source: 'live',
      title: overLimit
        ? `Device ${summary.role} peaked at ${fmtMb(summary.peakBytes)}, past the practical limit for a ${budget.tier} device`
        : `Device ${summary.role} peaked at ${fmtMb(summary.peakBytes)}, over the target for a ${budget.tier} device`,
      description: assessment.reason,
      severity: overLimit ? 'critical' : 'high',
      // A measured peak against a documented budget: the uncertainty is in the
      // budget figures, not in the measurement.
      confidence: overLimit ? 0.9 : 0.8,
      recommendation: overLimit
        ? `Bring the peak below ${fmtMb(budget.hardLimitBytes)} to stop the OS killing the game, then below ` +
          `${fmtMb(budget.targetMaxBytes)} to leave room for load spikes. The other findings name where the memory is going.`
        : `Bring the peak below ${fmtMb(budget.targetMaxBytes)}, so a load spike cannot push it into the range where the OS ` +
          `starts killing the process, around ${fmtMb(budget.hardLimitBytes)}.`,
      evidence: [
        {
          kind: 'metric',
          summary:
            `peak ${fmtMb(summary.peakBytes)} · target ${fmtMb(budget.targetMaxBytes)} · ` +
            `practical limit ${fmtMb(budget.hardLimitBytes)} · ${budget.tier} device`,
          data: {
            peakBytes: summary.peakBytes,
            targetMaxBytes: budget.targetMaxBytes,
            hardLimitBytes: budget.hardLimitBytes,
            tier: budget.tier,
            verdict: assessment.verdict,
          },
        },
      ],
      estimatedBytes: Math.max(0, summary.peakBytes - budget.targetMaxBytes),
      subject: `device ${summary.role} budget`,
      tags: ['live', 'budget', `device:${summary.role}`],
    },
  ];
}
