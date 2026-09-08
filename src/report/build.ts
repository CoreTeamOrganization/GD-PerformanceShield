/**
 * Assembles the structured report from every stage's output.
 *
 * This is the only place that knows how the pieces fit together, which keeps
 * the analysis stages independent of the report format.
 */
import type { ApkInfo } from '../apk/inspector.js';
import { TOOL_VERSION } from '../core/job.js';
import type { Finding, StudioIntakeInput } from '../core/types.js';
import type { DeviceInfo } from '../devices/deviceManager.js';
import type { CloneResult } from '../intake/git.js';
import type { DeviceAnomalySummary } from '../analysis/anomaly.js';
import { assessBudget, worstVerdict, type BudgetVerdict } from '../analysis/memoryBudget.js';
import type { CorrelationLink } from '../analysis/correlation.js';
import type { DeviceFlowAnalysis, ScreenVisit } from '../analysis/flow.js';
import type { ScoringResult } from '../analysis/scoring.js';
import { buildTimelineSeries, detectSpikes } from '../analysis/spikes.js';
import type {
  BatterySummary,
  FpsSummary,
  ThermalSummary,
} from '../telemetry/deviceHealth.js';
import type { SessionTimeline } from '../analysis/timeline.js';
import { valueAt } from '../analysis/timeline.js';
import type { StaticSummary } from '../static/index.js';
import { classifyBottleneck } from '../analysis/bottleneck.js';
import { classifyDeviceTier } from '../analysis/deviceTier.js';
import { diagnose, type Diagnosis } from '../analysis/diagnostics.js';
import { detectFpsEvents } from '../analysis/fpsEvents.js';
import { analyseMemoryGrowth } from '../analysis/memoryGrowth.js';
import type { CpuReading, CpuSummary } from '../telemetry/cpuThreads.js';
import type { DiskIoSample, DiskIoSummary } from '../telemetry/diskIo.js';
import type { AudioSample, AudioSummary } from '../telemetry/audio.js';
import type { EngineRender } from '../telemetry/engineProfile.js';
import type { GpuReading, GpuSummary, RenderSummary } from '../telemetry/gpu.js';
import { buildQualityGate } from './qualityGate.js';
import { REPORT_SCHEMA_VERSION, type AnalysisReport } from './model.js';

export interface BuildReportInput {
  analysisId: string;
  gameId: string;
  input: StudioIntakeInput;
  apk: ApkInfo | null;
  clone: CloneResult | null;
  unityVersion: string | null;
  devices: DeviceInfo[];
  staticSummary: StaticSummary | null;
  staticFindings: Finding[];
  liveFindings: Finding[];
  correlatedFindings: Finding[];
  correlations: CorrelationLink[];
  scoring: ScoringResult;
  anomalySummaries: DeviceAnomalySummary[];
  flowAnalyses: DeviceFlowAnalysis[];
  screenVisits: ScreenVisit[];
  timeline: SessionTimeline | null;
  sessionDurationMs: number;
  /** Version read off the device, for a run with no APK to inspect. */
  installedVersionName?: string | null;
  /**
   * Frame rate, heat and battery per device, reduced by the capture session.
   *
   * Passed in rather than recomputed here because only the session saw every
   * reading; re-deriving them from the sample files could disagree with what the
   * console showed live.
   */
  /** serial -> what was cleared before the run, when it was. */
  freshStarts?: Record<string, {
    availableBeforeBytes: number | null;
    availableAfterBytes: number | null;
    freedBytes: number | null;
    stopped: string[];
    skipped: Array<{ packageName: string; reason: string }>;
    killAllRan: boolean;
  }>;
  health?: Array<{
    serial: string;
    role: string;
    fps: FpsSummary;
    fpsSeries: Array<{ elapsedMs: number; fps: number; janks: number }>;
    thermal: ThermalSummary;
    battery: BatterySummary;
  }>;
  /**
   * GPU, rendering, CPU threading, storage and audio per device, with the raw
   * series the diagnostic engine needs.
   *
   * The summaries could be recomputed here from the sample files, and the raw
   * series could not - the diagnostic engine has to look at one moment across
   * five subsystems at once, and that is only possible while the points are
   * still indexed by time. So both arrive from the session together.
   */
  subsystems?: Array<{
    serial: string;
    role: string;
    gpu: GpuSummary;
    render: RenderSummary;
    cpu: CpuSummary;
    io: DiskIoSummary;
    audio: AudioSummary;
    series: {
      gpu: Array<{ elapsedMs: number; reading: GpuReading }>;
      cpu: Array<{ elapsedMs: number; reading: CpuReading }>;
      render: Array<{ elapsedMs: number; reading: EngineRender }>;
      io: DiskIoSample[];
      audio: AudioSample[];
    };
  }>;
  /**
   * Turn every gate failure into a warning.
   *
   * For a studio adopting the CI gate: they get the red checks without a broken
   * pipeline on the first run.
   */
  gateWarnOnly?: boolean;
  artifacts: Array<{ kind: string; path: string; description: string }>;
  extraLimitations?: string[];
}

export function buildReport(input: BuildReportInput): AnalysisReport {
  const anomalyBySerial = new Map(input.anomalySummaries.map((a) => [a.serial, a]));
  const healthBySerial = new Map((input.health ?? []).map((h) => [h.serial, h]));

  /**
   * Grade each device's peak against what one app may reasonably use on hardware
   * that size. Done here rather than in scoring because it belongs to the device,
   * not to a finding, and the report leads with it.
   */
  const deviceByRole = new Map(input.devices.map((d) => [d.role as string, d]));

  const budgetBySerial = new Map(
    input.devices.map((device) => {
      const anomaly = anomalyBySerial.get(device.serial);
      const assessment = assessBudget({
        totalRamBytes: device.totalRamBytes,
        peakBytes: anomaly?.peakBytes ?? null,
        processDeaths: anomaly?.processDeaths ?? 0,
        deviceLabel: `${device.manufacturer} ${device.model}`,
      });
      return [device.serial, assessment];
    }),
  );

  // Only devices that were actually measured can carry a verdict.
  const measuredVerdicts: BudgetVerdict[] = input.devices
    .filter((d) => (anomalyBySerial.get(d.serial)?.peakBytes ?? null) !== null)
    .map((d) => budgetBySerial.get(d.serial)!.verdict);
  const riskBySerial = new Map(input.scoring.perDevice.map((d) => [d.serial, d.score]));
  const subsystemsBySerial = new Map((input.subsystems ?? []).map((s) => [s.serial, s]));

  /*
   * Memory spikes, computed once.
   *
   * They belong to the session section of the report, but the diagnostic engine
   * needs them too - a frame collapse next to a 400 MB jump is the single most
   * useful correlation this tool produces. Computing them twice would risk the
   * report's spike table and its diagnosis disagreeing about the same event.
   */
  const spikes = input.timeline
    ? input.timeline.devices.flatMap((d) =>
        detectSpikes({
          role: d.role,
          samples: d.samples,
          events: input.timeline!.events,
          ...(deviceByRole.get(d.role)?.totalRamBytes
            ? { totalRamBytes: deviceByRole.get(d.role)!.totalRamBytes }
            : {}),
        }),
      )
    : [];

  /*
   * Whether memory came back down, computed once per role.
   *
   * Next to the spikes and for the same reason: spike detection finds the jumps,
   * this decides whether they were given back, and a report whose growth finding
   * and whose spike table disagreed about one session would be worse than either
   * alone. Uses the same series the timeline chart draws, so what a reader sees
   * and what the verdict was computed from cannot diverge.
   */
  const growthByRole = new Map(
    (input.timeline?.devices ?? []).map((d) => {
      const series = buildTimelineSeries(d.role, d.samples);
      return [
        d.role,
        analyseMemoryGrowth(
          d.role,
          series.points.map((p) => ({ elapsedMs: p.elapsedMs, bytes: p.totalBytes })),
        ),
      ] as const;
    }),
  );

  /** Operator markers, for dating a diagnosis against what the player was doing. */
  const markers = (input.timeline?.events ?? [])
    .filter((e) => e.source === 'operator')
    .map((e) => ({ elapsedMs: e.elapsedMs, label: e.label }))
    .sort((a, b) => a.elapsedMs - b.elapsedMs);

  /*
   * Per-device performance tier, bottleneck attribution and diagnoses.
   *
   * Done here rather than in the analysis stages because all three need pieces
   * that only meet at this point: the device's hardware, the session's frame
   * curve, and every subsystem summary. Keyed by serial so a two-device run
   * cannot attribute one phone's bottleneck to the other.
   */
  const tierBySerial = new Map(
    input.devices.map((device) => {
      const sub = subsystemsBySerial.get(device.serial);
      const health = healthBySerial.get(device.serial);
      const fastestCore = sub?.cpu.clusters.reduce<number | null>(
        (best, c) => (c.maxFreqMhz != null && (best === null || c.maxFreqMhz > best) ? c.maxFreqMhz : best),
        null,
      );
      const coreCount = sub?.cpu.clusters.reduce((sum, c) => sum + c.coreCount, 0) ?? null;
      return [
        device.serial,
        classifyDeviceTier({
          totalRamBytes: device.totalRamBytes,
          coreCount: coreCount && coreCount > 0 ? coreCount : null,
          maxCoreMhz: fastestCore ?? null,
          displayHz: health?.fps.displayHz ?? null,
          androidSdkInt: device.sdkInt,
          label: `${device.manufacturer} ${device.model}`,
        }),
      ];
    }),
  );

  const bottleneckBySerial = new Map(
    input.devices.map((device) => {
      const sub = subsystemsBySerial.get(device.serial);
      const health = healthBySerial.get(device.serial);
      return [
        device.serial,
        classifyBottleneck({
          fps: health?.fps ?? null,
          render: sub?.render ?? null,
          gpu: sub?.gpu ?? null,
          cpu: sub?.cpu ?? null,
          io: sub?.io ?? null,
          thermal: health?.thermal ?? null,
        }),
      ];
    }),
  );

  const diagnostics: Diagnosis[] = input.devices.flatMap((device) => {
    const sub = subsystemsBySerial.get(device.serial);
    const health = healthBySerial.get(device.serial);
    const anomaly = anomalyBySerial.get(device.serial);
    // With no frame curve there is no symptom to diagnose, and a diagnosis of a
    // symptom nobody observed would be pure invention.
    if (!health || health.fpsSeries.length === 0) {
      if ((anomaly?.processDeaths ?? 0) === 0) return [];
    }

    return diagnose({
      role: device.role,
      durationMs: input.sessionDurationMs,
      fps: health?.fps ?? null,
      fpsSeries: health?.fpsSeries ?? [],
      memorySpikes: spikes.filter((s) => s.role === device.role),
      ioBursts: sub?.io.bursts ?? [],
      renderSeries: (sub?.series.render ?? []).map((p) => ({
        elapsedMs: p.elapsedMs,
        drawCalls: p.reading.drawCalls,
        setPassCalls: p.reading.setPassCalls,
        triangles: p.reading.triangles,
        gpuFrameMs: p.reading.gpuFrameMs,
        mainThreadMs: p.reading.mainThreadMs,
        renderThreadMs: p.reading.renderThreadMs,
        usedTextureBytes: p.reading.usedTextureBytes,
      })),
      gpuSeries: (sub?.series.gpu ?? []).map((p) => ({
        elapsedMs: p.elapsedMs,
        utilizationPercent: p.reading.utilizationPercent,
        clockMhz: p.reading.clockMhz,
      })),
      cpuSeries: (sub?.series.cpu ?? []).map((p) => ({
        elapsedMs: p.elapsedMs,
        appCpuPercentOfCore: p.reading.appCpuPercentOfCore,
        otherCpuPercentOfDevice: p.reading.otherCpuPercentOfDevice,
        threads: p.reading.threads,
      })),
      audioSeries: (sub?.series.audio ?? []).map((p) => ({
        elapsedMs: p.elapsedMs,
        activeTracks: p.reading.activeTracks,
        underrunCount: p.reading.underrunCount,
      })),
      thermal: health?.thermal ?? null,
      markers,
      processDeaths: anomaly?.processDeaths ?? 0,
    });
  });

  const qualityGate = buildQualityGate({
    analysisId: input.analysisId,
    gameName: input.input.gameName,
    packageName: input.apk?.packageName ?? input.input.packageName ?? null,
    versionName: input.apk?.versionName ?? input.installedVersionName ?? null,
    commit: input.clone?.commit ?? null,
    ...(input.gateWarnOnly ? { warnOnly: true } : {}),
    devices: input.devices.map((device) => {
      const sub = subsystemsBySerial.get(device.serial);
      const health = healthBySerial.get(device.serial);
      const anomaly = anomalyBySerial.get(device.serial);
      return {
        serial: device.serial,
        role: device.role,
        model: `${device.manufacturer} ${device.model}`,
        thresholds: tierBySerial.get(device.serial)!,
        peakBytes: anomaly?.peakBytes ?? null,
        processDeaths: anomaly?.processDeaths ?? 0,
        fps: health?.fps ?? null,
        thermal: health?.thermal ?? null,
        gpu: sub?.gpu ?? null,
        render: sub?.render ?? null,
        cpu: sub?.cpu ?? null,
        io: sub?.io ?? null,
        audio: sub?.audio ?? null,
      };
    }),
  });

  const report: AnalysisReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    analysisId: input.analysisId,
    gameId: input.gameId,
    generatedAt: new Date().toISOString(),
    toolVersion: TOOL_VERSION,

    subject: {
      gameName: input.input.gameName,
      ...(input.input.studio ? { studio: input.input.studio } : {}),
      // Fall back to the app the operator chose. With no APK to inspect these
      // were both null, so a report of an installed app could not say which app
      // it was about - which also made two sessions impossible to tell apart.
      packageName: input.apk?.packageName ?? input.input.packageName ?? null,
      versionName: input.apk?.versionName ?? input.installedVersionName ?? null,
      versionCode: input.apk?.versionCode ?? null,
      unityVersion: input.apk?.unity.engineVersion ?? input.unityVersion,
      scriptingBackend: input.apk?.unity.scriptingBackend ?? input.staticSummary?.scriptingBackend ?? null,
      abis: input.apk?.abis ?? [],
      apkSizeBytes: input.apk?.sizeBytes ?? null,
      repository: input.clone
        ? {
            url: input.clone.repoUrl,
            branch: input.clone.branch,
            commit: input.clone.commit,
            commitDate: input.clone.commitDate,
            commitSubject: input.clone.commitSubject,
          }
        : null,
    },

    verdict: {
      headline: input.scoring.headline,
      budgetVerdict: measuredVerdicts.length > 0 ? worstVerdict(measuredVerdicts) : null,
      combinedRisk: input.scoring.combinedRisk,
      staticRisk: input.scoring.staticRisk,
      liveRisk: input.scoring.liveRisk,
      confidence: input.scoring.confidence,
    },

    devices: input.devices.map((device) => {
      const anomaly = anomalyBySerial.get(device.serial);
      return {
        serial: device.serial,
        role: device.role,
        model: device.model,
        manufacturer: device.manufacturer,
        androidVersion: device.androidVersion,
        sdkInt: device.sdkInt,
        totalRamBytes: device.totalRamBytes,
        abi: device.abi,
        risk: riskBySerial.get(device.serial) ?? null,
        peakBytes: anomaly?.peakBytes ?? null,
        peakRamFraction: anomaly?.peakRamFraction ?? null,
        baselineBytes: anomaly?.baselineBytes ?? null,
        averageBytes: anomaly?.averageBytes ?? null,
        finalBytes: anomaly?.finalBytes ?? null,
        growthBytesPerMinute: anomaly?.growthBytesPerMinute ?? null,
        /*
         * The frame-rate events, lettered, so the chart can badge them and the
         * detail section can be pointed at by letter. Computed here rather than
         * taken from the diagnoses because a step is an event worth charting and
         * is deliberately not diagnosed - nothing "caused" the display to
         * switch to 60 Hz.
         */
        fpsEvents: detectFpsEvents(
          device.role,
          healthBySerial.get(device.serial)?.fpsSeries ?? [],
        ),
        /*
         * Whether memory came back down. Spike detection finds the jumps; this
         * is the only thing that separates a level load from a leak, and they
         * need opposite responses.
         */
        memoryGrowth: growthByRole.get(device.role) ?? null,
        processDeaths: anomaly?.processDeaths ?? 0,
        minDeviceAvailableBytes: anomaly?.minDeviceAvailableBytes ?? null,
        metric: anomaly?.metric ?? null,
        fps: healthBySerial.get(device.serial)?.fps ?? null,
        fpsSeries: healthBySerial.get(device.serial)?.fpsSeries ?? [],
        thermal: healthBySerial.get(device.serial)?.thermal ?? null,
        battery: healthBySerial.get(device.serial)?.battery ?? null,
        freshStart: input.freshStarts?.[device.serial] ?? null,
        budget: (() => {
          const a = budgetBySerial.get(device.serial);
          if (!a) return null;
          return {
            verdict: a.verdict,
            tier: a.budget.tier,
            targetMinBytes: a.budget.targetMinBytes,
            targetMaxBytes: a.budget.targetMaxBytes,
            hardLimitBytes: a.budget.hardLimitBytes,
            targetRatio: a.targetRatio,
            limitRatio: a.limitRatio,
            summary: a.summary,
            reason: a.reason,
          };
        })(),
        gpu: subsystemsBySerial.get(device.serial)?.gpu ?? null,
        render: subsystemsBySerial.get(device.serial)?.render ?? null,
        cpu: subsystemsBySerial.get(device.serial)?.cpu ?? null,
        io: subsystemsBySerial.get(device.serial)?.io ?? null,
        audio: subsystemsBySerial.get(device.serial)?.audio ?? null,
        bottleneck: bottleneckBySerial.get(device.serial) ?? null,
        tier: tierBySerial.get(device.serial) ?? null,
      };
    }),

    session: input.timeline
      ? {
          sessionId: input.timeline.sessionId,
          startedAt: new Date(input.timeline.startedAtEpochMs).toISOString(),
          durationMs: input.sessionDurationMs,
          markerCount: input.timeline.events.filter((e) => e.source === 'operator').length,
          sampleCounts: Object.fromEntries(
            input.timeline.devices.map((d) => [d.role, d.samples.length]),
          ),
          cycles: input.flowAnalyses.flatMap((analysis) =>
            analysis.cycles.map((cycle) => ({
              serial: analysis.serial,
              role: analysis.role,
              index: cycle.index,
              label: cycle.label,
              startBytes: cycle.startBytes,
              peakBytes: cycle.peakBytes,
              recoveredBytes: cycle.recoveredBytes,
              recoveryDeltaBytes: cycle.recoveryDeltaBytes,
            })),
          ),
          screenVisits: input.screenVisits.map((v) => ({
            screen: v.screen,
            role: v.role,
            openBytes: v.openBytes,
            peakBytes: v.peakBytes,
            closedBytes: v.closedBytes,
            retainedBytes: v.retainedBytes,
          })),
          timeline: buildAnnotatedTimeline(input.timeline),
          // Local time as well as UTC: a report is matched against a build, a
          // ticket or a device log from the same afternoon, and nobody reads
          // those in UTC.
          startedAtLocal: new Date(input.timeline.startedAtEpochMs).toString(),
          endedAt: new Date(
            input.timeline.startedAtEpochMs + input.sessionDurationMs,
          ).toISOString(),
          spikes,
          timelineSeries: input.timeline.devices.map((d) =>
            buildTimelineSeries(d.role, d.samples),
          ),
        }
      : null,

    project: input.staticSummary
      ? {
          assetCount: input.staticSummary.assetCount,
          scriptFileCount: input.staticSummary.scriptFileCount,
          sceneCount: input.staticSummary.sceneCount,
          buildSceneCount: input.staticSummary.buildSceneCount,
          textureCount: input.staticSummary.textureCount,
          audioCount: input.staticSummary.audioCount,
          estimatedTextureBytes: input.staticSummary.estimatedTextureBytes,
          estimatedAudioBytes: input.staticSummary.estimatedAudioBytes,
          usesAddressables: input.staticSummary.usesAddressables,
          metaFilesPresent: input.staticSummary.metaFilesPresent,
          heaviestScenes: input.staticSummary.heaviestScenes,
          largestTextures: input.staticSummary.largestTextures,
          limitations: input.staticSummary.limitations,
        }
      : null,

    priority: input.scoring.priority.slice(0, 25).map((p) => ({
      rank: p.rank,
      priorityScore: Number(p.priorityScore.toFixed(3)),
      reason: p.reason,
      finding: p.finding,
    })),

    findings: {
      correlated: input.correlatedFindings,
      live: input.liveFindings,
      static: input.staticFindings,
    },

    correlations: input.correlations,
    diagnostics,
    qualityGate,
    artifacts: input.artifacts,
    limitations: [
      ...(input.staticSummary?.limitations ?? []),
      ...input.scoring.confidence.caveats,
      ...(input.extraLimitations ?? []),
      ...(input.apk?.warnings ?? []),
      // What each subsystem could not see, in the reader's words rather than as
      // an absent field. A report that silently omits GPU load teaches a studio
      // that the tool does not measure it; one that says SELinux denied the read
      // tells them what to change.
      ...collectSubsystemLimitations(input.subsystems ?? []),
    ],
  };

  return report;
}

/**
 * Turn each subsystem's "why not" into a limitation a reader can act on.
 *
 * Deduplicated across devices: two phones of the same model refusing the same
 * sysfs node is one fact, and printing it twice makes the limitations list look
 * like the report's main content.
 */
function collectSubsystemLimitations(
  subsystems: NonNullable<BuildReportInput['subsystems']>,
): string[] {
  const out = new Set<string>();

  for (const s of subsystems) {
    if (s.gpu.unavailableReason) out.add(s.gpu.unavailableReason);
    if (s.cpu.unavailableReason) out.add(s.cpu.unavailableReason);
    if (s.io.unavailableReason) out.add(s.io.unavailableReason);
    if (s.audio.unavailableReason) out.add(s.audio.unavailableReason);

    // The engine reporter is the only source for draw calls, geometry and
    // per-thread frame time, so its absence is the single most consequential
    // gap in a run - it is what turns "GPU-bound" from a measurement into a
    // guess. Said once, plainly, with the fix.
    if (s.render.sampleCount === 0) {
      out.add(
        'Draw calls, triangle and vertex counts, texture memory and per-frame main-thread, ' +
          'render-thread and GPU times were not available: they can only be read from inside the ' +
          'engine. Add scripts/unity/PerformanceShieldReporter.cs to the project and make a ' +
          'development build to collect them.',
      );
    } else if (s.render.unavailable.length > 0) {
      out.add(
        `The engine reporter ran, but this Unity version does not expose these counters: ` +
          `${s.render.unavailable.join(', ')}.`,
      );
    }
  }

  return [...out];
}

/**
 * Marker timeline with the memory level at each marker, per device role.
 *
 * This is the table the spec sketches in section 5 - the one a studio reads
 * first, because it maps memory to what the player was doing.
 */
function buildAnnotatedTimeline(
  timeline: SessionTimeline,
): AnalysisReport['session'] extends null ? never : NonNullable<AnalysisReport['session']>['timeline'] {
  return timeline.events
    .filter((e) => e.source === 'operator' || isNotableSystemEvent(e.type))
    .map((event) => {
      const memoryByRole: Record<string, number | null> = {};
      for (const device of timeline.devices) {
        memoryByRole[device.role] = valueAt(device.primary, event.elapsedMs)?.value ?? null;
      }
      return {
        elapsedMs: event.elapsedMs,
        label: event.label,
        type: event.type,
        source: event.source,
        memoryByRole,
      };
    });
}

function isNotableSystemEvent(type: string): boolean {
  return [
    'session_start',
    'session_end',
    'process_gone',
    'process_restarted',
    'process_killed',
    'process_crash',
  ].includes(type);
}
