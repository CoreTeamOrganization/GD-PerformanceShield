/**
 * Step 14 - the report data model.
 *
 * Structured JSON is the source of truth; Markdown (and later HTML/PDF) are
 * renderings of this object and must never contain information that is not in
 * it. The zod schema is here so that a report written by one version can be
 * validated before being read by another, and so that a rendering bug cannot
 * silently ship a malformed report to a studio.
 */
import { z } from 'zod';

export const REPORT_SCHEMA_VERSION = 1;

const severitySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
const bandSchema = z.enum(['low', 'moderate', 'high', 'critical']);

const evidenceSchema = z.object({
  kind: z.enum(['file', 'code', 'asset', 'setting', 'metric', 'event', 'timeline', 'artifact', 'note']),
  summary: z.string(),
  path: z.string().optional(),
  line: z.number().optional(),
  excerpt: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});

const findingSchema = z.object({
  ruleId: z.string(),
  id: z.string(),
  source: z.enum(['static', 'live', 'correlated']),
  title: z.string(),
  description: z.string(),
  severity: severitySchema,
  confidence: z.number(),
  recommendation: z.string(),
  evidence: z.array(evidenceSchema),
  estimatedBytes: z.number().optional(),
  subject: z.string().optional(),
  tags: z.array(z.string()),
});

const riskScoreSchema = z.object({
  value: z.number(),
  band: bandSchema,
  contributors: z.array(
    z.object({ findingId: z.string(), title: z.string(), impact: z.number() }),
  ),
});

/*
 * Subsystem schemas.
 *
 * Every one of them is `.nullable().optional()` at its point of use, and every
 * figure inside is nullable. That is not defensiveness for its own sake: a
 * report is kept on disk and compared against another one months later, so a
 * newly required field would make every older session unreadable. And a null
 * here carries information - it means the device or the build could not produce
 * the figure, which is a different statement from zero.
 */
const nullableNumber = z.number().nullable();

const gpuSummarySchema = z.object({
  averageUtilizationPercent: nullableNumber,
  peakUtilizationPercent: nullableNumber,
  /** Share of samples above 90%, where the GPU is what sets the pace. */
  saturatedSamplePercent: nullableNumber,
  averageClockMhz: nullableNumber,
  peakClockMhz: nullableNumber,
  maxClockMhz: nullableNumber,
  clockPinnedPercent: nullableNumber,
  source: z.string().nullable(),
  sampleCount: z.number(),
  unavailableReason: z.string().nullable(),
});

const renderSummarySchema = z.object({
  averageDrawCalls: nullableNumber,
  peakDrawCalls: nullableNumber,
  averageBatches: nullableNumber,
  averageSetPassCalls: nullableNumber,
  peakSetPassCalls: nullableNumber,
  averageTriangles: nullableNumber,
  peakTriangles: nullableNumber,
  averageVertices: nullableNumber,
  peakVertices: nullableNumber,
  peakUsedTextureBytes: nullableNumber,
  peakRenderTextureBytes: nullableNumber,
  peakUsedTextureCount: nullableNumber,
  averageMainThreadMs: nullableNumber,
  peakMainThreadMs: nullableNumber,
  averageRenderThreadMs: nullableNumber,
  peakRenderThreadMs: nullableNumber,
  averageGpuFrameMs: nullableNumber,
  peakGpuFrameMs: nullableNumber,
  sampleCount: z.number(),
  unavailable: z.array(z.string()),
});

const threadLoadSchema = z.object({
  name: z.string(),
  role: z.enum(['main', 'render', 'worker', 'audio', 'gc', 'io', 'other']),
  averageCpuPercent: z.number(),
  peakCpuPercent: z.number(),
  saturatedSamplePercent: z.number(),
  dominantCluster: z.enum(['little', 'mid', 'big', 'uniform']).nullable(),
  clusterConsistencyPercent: nullableNumber,
  sampleCount: z.number(),
});

const cpuSummarySchema = z.object({
  averageAppCpuPercentOfCore: nullableNumber,
  peakAppCpuPercentOfCore: nullableNumber,
  averageAppCpuPercentOfDevice: nullableNumber,
  averageSystemCpuPercentOfDevice: nullableNumber,
  averageOtherCpuPercentOfDevice: nullableNumber,
  peakOtherCpuPercentOfDevice: nullableNumber,
  clusters: z.array(
    z.object({
      cluster: z.enum(['little', 'mid', 'big', 'uniform']),
      coreCount: z.number(),
      averageUsagePercent: nullableNumber,
      peakUsagePercent: nullableNumber,
      averageFreqMhz: nullableNumber,
      maxFreqMhz: nullableNumber,
      clockPinnedPercent: nullableNumber,
    }),
  ),
  threads: z.array(threadLoadSchema),
  mainThread: threadLoadSchema.nullable(),
  renderThread: threadLoadSchema.nullable(),
  averageThreadCount: nullableNumber,
  sampleCount: z.number(),
  unavailableReason: z.string().nullable(),
});

const diskIoSummarySchema = z.object({
  totalReadBytes: nullableNumber,
  totalWriteBytes: nullableNumber,
  totalStorageReadBytes: nullableNumber,
  totalStorageWriteBytes: nullableNumber,
  peakReadBytesPerSecond: nullableNumber,
  peakStorageReadBytesPerSecond: nullableNumber,
  averageReadBytesPerSecond: nullableNumber,
  cacheHitPercent: nullableNumber,
  bursts: z.array(
    z.object({
      elapsedMs: z.number(),
      readBytesPerSecond: z.number(),
      storageReadBytesPerSecond: nullableNumber,
      nearestMarker: z.string().nullable(),
      fps: nullableNumber,
      janks: nullableNumber,
    }),
  ),
  burstsWithStutter: z.number(),
  fpsDuringBursts: nullableNumber,
  fpsOutsideBursts: nullableNumber,
  sampleCount: z.number(),
  unavailableReason: z.string().nullable(),
});

const audioSummarySchema = z.object({
  peakActiveTracks: nullableNumber,
  averageActiveTracks: nullableNumber,
  underrunsDuringSession: nullableNumber,
  underrunsPerMinute: nullableNumber,
  sampleRateHz: nullableNumber,
  bufferFrames: nullableNumber,
  bufferMs: nullableNumber,
  peakPlayingSources: nullableNumber,
  averagePlayingSources: nullableNumber,
  peakAudioVoices: nullableNumber,
  averageAudioCpuPercent: nullableNumber,
  peakAudioCpuPercent: nullableNumber,
  averageDspCpuPercent: nullableNumber,
  peakAudioMemoryBytes: nullableNumber,
  peakClipCount: nullableNumber,
  verdict: z.enum(['clean', 'occasional-dropouts', 'starved', 'unknown']),
  sampleCount: z.number(),
  unavailableReason: z.string().nullable(),
});

const bottleneckSchema = z.object({
  kind: z.enum(['cpu-main', 'cpu-render', 'gpu', 'storage', 'thermal', 'balanced', 'unknown']),
  headline: z.string(),
  reason: z.string(),
  confidence: z.number(),
  frameBudget: z.object({
    targetMs: nullableNumber,
    actualMs: nullableNumber,
    mainThreadMs: nullableNumber,
    renderThreadMs: nullableNumber,
    gpuFrameMs: nullableNumber,
  }),
  contributors: z.array(z.object({ kind: z.string(), note: z.string() })),
  /** An inference from GPU time against geometry, not a measurement. */
  fillRatePressure: z.enum(['likely', 'unlikely', 'unknown']),
  basis: z.enum(['engine-thread-times', 'os-signals', 'none']),
});

const tierSchema = z.object({
  tier: z.enum(['low', 'mid', 'high']),
  label: z.string(),
  reason: z.string(),
  minMedianFps: z.number(),
  minLow1PercentFps: z.number(),
  maxJanksPerMinute: z.number(),
  maxPeakBytes: z.number(),
  maxThermalRiseC: z.number(),
  maxDrawCalls: z.number(),
  maxTriangles: z.number(),
  maxUnderrunsPerMinute: z.number(),
});

export const reportSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  analysisId: z.string(),
  gameId: z.string(),
  generatedAt: z.string(),
  toolVersion: z.string(),

  subject: z.object({
    gameName: z.string(),
    studio: z.string().optional(),
    packageName: z.string().nullable(),
    versionName: z.string().nullable(),
    versionCode: z.number().nullable(),
    unityVersion: z.string().nullable(),
    scriptingBackend: z.string().nullable(),
    abis: z.array(z.string()),
    apkSizeBytes: z.number().nullable(),
    repository: z
      .object({
        url: z.string(),
        branch: z.string(),
        commit: z.string(),
        commitDate: z.string(),
        commitSubject: z.string(),
      })
      .nullable(),
  }),

  verdict: z.object({
    headline: z.string(),
    /** Worst per-device budget verdict across the session. */
    budgetVerdict: z.enum(['green', 'yellow', 'red']).nullable(),
    combinedRisk: riskScoreSchema,
    staticRisk: riskScoreSchema,
    liveRisk: riskScoreSchema,
    confidence: z.object({
      value: z.number(),
      factors: z.array(
        z.object({
          name: z.string(),
          present: z.boolean(),
          weight: z.number(),
          note: z.string().optional(),
        }),
      ),
      caveats: z.array(z.string()),
    }),
  }),

  devices: z.array(
    z.object({
      serial: z.string(),
      role: z.string(),
      model: z.string(),
      manufacturer: z.string(),
      androidVersion: z.string(),
      sdkInt: z.number(),
      totalRamBytes: z.number(),
      abi: z.string(),
      risk: riskScoreSchema.nullable(),
      peakBytes: z.number().nullable(),
      peakRamFraction: z.number().nullable(),
      baselineBytes: z.number().nullable(),
      /**
       * Mean over the session - a peak alone cannot say whether it was held.
       *
       * Optional so a report written before this field existed still validates.
       * Reports are kept on disk and compared against each other months later;
       * a required new field would make every older session unreadable.
       */
      averageBytes: z.number().nullable().optional(),
      finalBytes: z.number().nullable(),
      growthBytesPerMinute: z.number().nullable(),

      /**
       * The frame-rate drops and level changes, lettered worst-first.
       *
       * Optional: sessions recorded before this existed are still read and
       * compared months later, and a required field would make them unloadable.
       */
      fpsEvents: z
        .array(
          z.object({
            role: z.string(),
            letter: z.string(),
            kind: z.enum(['drop', 'step']),
            atMs: z.number(),
            fromMs: z.number(),
            toMs: z.number(),
            durationMs: z.number(),
            beforeFps: z.number(),
            lowestFps: z.number(),
            afterFps: z.number(),
            changePercent: z.number(),
            windows: z.number(),
            janks: z.number(),
            severity: severitySchema,
            /** What `beforeFps` was measured against, so a reader can check it. */
            basis: z.string(),
          }),
        )
        .optional(),

      /**
       * Whether memory was given back, which spike detection cannot tell.
       *
       * A jump that returned to baseline is a level load; one that did not is
       * the shape of a retention bug. The two need opposite responses, so the
       * verdict is carried explicitly rather than left to the reader.
       */
      memoryGrowth: z
        .object({
          role: z.string(),
          verdict: z.enum(['retained', 'released', 'flat', 'insufficient']),
          bytesPerMinute: z.number(),
          baselineBytes: z.number(),
          finalBytes: z.number(),
          peakBytes: z.number(),
          retainedBytes: z.number(),
          retainedFraction: z.number(),
          heldAtEndFraction: z.number(),
          floorRoseBytes: z.number(),
          durationMs: z.number(),
          samples: z.number(),
          summary: z.string(),
          recommendation: z.string().nullable(),
          confidence: z.number(),
        })
        .nullable()
        .optional(),
      processDeaths: z.number(),
      minDeviceAvailableBytes: z.number().nullable(),
      metric: z.string().nullable(),
      /**
       * Presented frame rate over the session. Measured from the compositor, so
       * it is what the player saw rather than what the engine intended.
       */
      fps: z
        .object({
          averageFps: z.number().nullable(),
          /** Median of the per-second samples - the figure other tools call median FPS. */
          medianFps: z.number().nullable(),
          /** One over the median gap between frames: how fast it renders when it renders. */
          typicalFrameFps: z.number().nullable(),
          /** One over the longest single frame in the session. */
          minFrameFps: z.number().nullable(),
          maxFrameFps: z.number().nullable(),
          /** Average frame rate of the worst 1% of frames. */
          low1PercentFps: z.number().nullable(),
          longestFrameMs: z.number().nullable(),
          /** Frames over one display refresh period. */
          smallJanks: z.number().nullable(),
          /** Frames over 83 ms - a stall a player felt. */
          janks: z.number().nullable(),
          bigJanks: z.number().nullable(),
          /**
           * GameBench-comparable estimate: frames over twice the typical
           * interval. Optional: older stored reports do not carry it.
           */
          crossToolJanks: z.number().nullable().optional(),
          janksPerMinute: z.number().nullable(),
          totalFrames: z.number().nullable(),
          /** The panel's refresh rate - a device property, not the game's. */
          displayHz: z.number().nullable(),
          /** True when the game tracked the panel, so a frame cap is not applying. */
          matchesDisplayRate: z.boolean().nullable(),
          minFps: z.number().nullable(),
          /**
           * Share of session time within ±20% of the median rate, 0-100.
           * Over 75 reads as stable around the median; 80 as good.
           * Optional: reports written before it existed do not carry it.
           */
          stabilityPercent: z.number().nullable().optional(),
          lowPercentileFps: z.number().nullable(),
          /**
           * The percentile ladder over the per-second samples, named to match
           * the studio's in-game recorder so the two can be read together.
           */
          percentiles: z
            .object({
              p01: z.number(),
              p05: z.number(),
              p25: z.number(),
              p50: z.number(),
              p75: z.number(),
              p95: z.number(),
              p99: z.number(),
            })
            .nullable()
            .optional(),
          sampleCount: z.number(),
          jankPercent: z.number().nullable(),
          worstFrameMs: z.number().nullable(),
          source: z.string().nullable(),
        })
        .nullable(),
      /** Heat over the session. The rise matters more than the absolute. */
      thermal: z
        .object({
          /** Peak battery temperature - a different sensor from `peakC`. */
          peakBatteryC: z.number().nullable(),
          startC: z.number().nullable(),
          endC: z.number().nullable(),
          peakC: z.number().nullable(),
          riseC: z.number().nullable(),
          hottestZone: z.string().nullable(),
          worstStatus: z.string().nullable(),
          throttlingMs: z.number(),
          verdict: z.enum(['cool', 'warm', 'hot', 'throttling', 'unknown']),
        })
        .nullable(),
      /**
       * Frame rate over time, one point per sampled window.
       *
       * Carried so the report can draw the curve rather than only state an
       * average: a session that held 60 and dropped to 8 twice reads very
       * differently from one that sat at 45 throughout, and both average alike.
       */
      fpsSeries: z.array(
        z.object({
          elapsedMs: z.number(),
          fps: z.number(),
          /** Janks counted in this window, so stutter can be marked in place. */
          janks: z.number(),
        }),
      ),
      /**
       * What was cleared before the run, when the operator asked for it.
       *
       * Recorded because it changes what the peak means: the same build on the
       * same phone can survive a fresh start and be killed on a busy device, and
       * a reader has to know which condition produced the number.
       */
      freshStart: z
        .object({
          availableBeforeBytes: z.number().nullable(),
          availableAfterBytes: z.number().nullable(),
          freedBytes: z.number().nullable(),
          stopped: z.array(z.string()),
          skipped: z.array(z.object({ packageName: z.string(), reason: z.string() })),
          killAllRan: z.boolean(),
          /**
           * What held the foreground before the run, when it was not the game.
           *
           * The app `am kill-all` is guaranteed not to touch, so the one most
           * likely to have distorted the measurement. Optional for reports
           * written before it was recorded.
           */
          foregroundBefore: z.string().nullable().optional(),
        })
        .nullable(),
      /** Battery. Drain is null whenever the device was charging. */
      battery: z
        .object({
          startPercent: z.number().nullable(),
          endPercent: z.number().nullable(),
          startTemperatureC: z.number().nullable(),
          endTemperatureC: z.number().nullable(),
          drainPercent: z.number().nullable(),
          drainPercentPerHour: z.number().nullable(),
          drainMah: z.number().nullable(),
          /** Signed net change in the fuel gauge - resolves what whole percent cannot. */
          netChargeMah: z.number().nullable().optional(),
          startChargeUah: z.number().nullable().optional(),
          endChargeUah: z.number().nullable().optional(),
          wasCharging: z.boolean(),
          unavailableReason: z.string().nullable(),
        })
        .nullable(),
      /**
       * How the measured peak compares with what one app may reasonably use on a
       * device of this size. `green` within target, `yellow` over target but
       * under the practical ceiling, `red` past it.
       */
      budget: z
        .object({
          verdict: z.enum(['green', 'yellow', 'red']),
          tier: z.string(),
          targetMinBytes: z.number(),
          targetMaxBytes: z.number(),
          hardLimitBytes: z.number(),
          targetRatio: z.number().nullable(),
          limitRatio: z.number().nullable(),
          summary: z.string(),
          reason: z.string(),
        })
        .nullable(),

      /** GPU load and clock, from vendor sysfs where the device allows it. */
      gpu: gpuSummarySchema.nullable().optional(),
      /**
       * Rendering work per frame, from the engine.
       *
       * Draw calls, geometry and per-thread frame time cannot be observed from
       * outside the process, so this is populated only when the build carries
       * the reporter component.
       */
      render: renderSummarySchema.nullable().optional(),
      /** Per-cluster and per-thread CPU load. */
      cpu: cpuSummarySchema.nullable().optional(),
      /** Storage bandwidth, and which reads cost frames. */
      io: diskIoSummarySchema.nullable().optional(),
      /** Voices, audio-thread CPU and buffer underruns. */
      audio: audioSummarySchema.nullable().optional(),
      /** What was holding the frame up, and on what evidence. */
      bottleneck: bottleneckSchema.nullable().optional(),
      /**
       * The performance thresholds applied to this device, and why.
       *
       * Carried in the report so a failed check is arguable: the reader can see
       * the bar, the measurement and the tier that produced the bar without
       * having to know the tool's internal table.
       */
      tier: tierSchema.nullable().optional(),
    }),
  ),

  session: z
    .object({
      sessionId: z.string(),
      startedAt: z.string(),
      durationMs: z.number(),
      markerCount: z.number(),
      sampleCounts: z.record(z.number()),
      cycles: z.array(
        z.object({
          serial: z.string(),
          role: z.string(),
          index: z.number(),
          label: z.string(),
          startBytes: z.number().nullable(),
          peakBytes: z.number().nullable(),
          recoveredBytes: z.number().nullable(),
          recoveryDeltaBytes: z.number().nullable(),
        }),
      ),
      screenVisits: z.array(
        z.object({
          screen: z.string(),
          role: z.string(),
          openBytes: z.number().nullable(),
          peakBytes: z.number().nullable(),
          closedBytes: z.number().nullable(),
          retainedBytes: z.number().nullable(),
        }),
      ),
      timeline: z.array(
        z.object({
          elapsedMs: z.number(),
          label: z.string(),
          type: z.string(),
          source: z.string(),
          memoryByRole: z.record(z.number().nullable()),
        }),
      ),
      /**
       * Wall-clock start and end, so a session can be located in time - which
       * is what lets a report be matched against a build, a QA ticket or a
       * device log from the same afternoon.
       */
      startedAtLocal: z.string().nullable(),
      endedAt: z.string().nullable(),
      /**
       * The largest memory jumps in the session, biggest first.
       *
       * Detail for a developer: which categories moved, and what the OS could
       * name inside them. Deliberately absent from the summary cut, where a list
       * of mappings is noise rather than information.
       */
      spikes: z.array(
        z.object({
          role: z.string(),
          /** A, B, C... by size. The same letter marks the point on the chart. */
          letter: z.string(),
          fromMs: z.number(),
          toMs: z.number(),
          deltaBytes: z.number(),
          totalBytes: z.number(),
          kind: z.string(),
          /** Nearest operator marker at or before the spike, if any. */
          nearestMarker: z.string().nullable(),
          categories: z.array(z.object({ label: z.string(), deltaBytes: z.number() })),
          /** Named mappings that moved, when smaps was readable. */
          mappings: z.array(z.object({ name: z.string(), deltaBytes: z.number() })),
          /** Unity's own buckets, when the reporter component was present. */
          engine: z.array(z.object({ label: z.string(), deltaBytes: z.number() })),
        }),
      ),
      /**
       * The memory curve, thinned for the report.
       *
       * Enough points to draw the shape of the session without carrying every
       * sample into a document that gets emailed.
       */
      timelineSeries: z.array(
        z.object({
          role: z.string(),
          points: z.array(
            z.object({
              elapsedMs: z.number(),
              totalBytes: z.number(),
              categories: z.record(z.number()),
            }),
          ),
        }),
      ),
    })
    .nullable(),

  project: z
    .object({
      assetCount: z.number(),
      scriptFileCount: z.number(),
      sceneCount: z.number(),
      buildSceneCount: z.number(),
      textureCount: z.number(),
      audioCount: z.number(),
      estimatedTextureBytes: z.number(),
      estimatedAudioBytes: z.number(),
      usesAddressables: z.boolean(),
      metaFilesPresent: z.boolean(),
      heaviestScenes: z.array(
        z.object({ path: z.string(), estimatedBytes: z.number(), objectCount: z.number() }),
      ),
      largestTextures: z.array(
        z.object({
          path: z.string(),
          estimatedBytes: z.number(),
          dimensions: z.string().nullable(),
        }),
      ),
      limitations: z.array(z.string()),
    })
    .nullable(),

  priority: z.array(
    z.object({
      rank: z.number(),
      priorityScore: z.number(),
      reason: z.string(),
      finding: findingSchema,
    }),
  ),

  findings: z.object({
    correlated: z.array(findingSchema),
    live: z.array(findingSchema),
    static: z.array(findingSchema),
  }),

  correlations: z.array(
    z.object({
      liveFindingId: z.string(),
      staticFindingId: z.string(),
      reason: z.string(),
      strength: z.number(),
    }),
  ),

  /**
   * Automated root-cause correlation: the moments the frame rate collapsed,
   * and what every other subsystem was doing at the same instant.
   *
   * The one part of the report that answers "why did it stutter there?" rather
   * than "how much did it stutter". Each entry states its evidence and says
   * plainly that coincidence is not proof.
   */
  diagnostics: z
    .array(
      z.object({
        id: z.string(),
        role: z.string(),
        /**
         * A, B, C... shared with the frame-rate chart badge and the event table.
         *
         * Optional so a report written before these existed still validates -
         * sessions are kept and compared months later.
         */
        letter: z.string().optional(),
        kind: z.enum(['drop', 'step', 'process-death']).optional(),
        atMs: z.number(),
        fromMs: z.number().optional(),
        toMs: z.number().optional(),
        durationMs: z.number().optional(),
        toleranceMs: z.number(),
        symptom: z.string(),
        fps: z.number(),
        /** What the rate fell from, the worst of it, and where it settled. */
        beforeFps: z.number().optional(),
        lowestFps: z.number().optional(),
        afterFps: z.number().optional(),
        changePercent: z.number().optional(),
        windows: z.number().optional(),
        basis: z.string().optional(),
        janks: z.number(),
        severity: severitySchema,
        confidence: z.number(),
        /** The confidence figure on the shared five-step ladder. */
        level: z
          .enum(['confirmed', 'high', 'medium', 'possible', 'insufficient'])
          .optional(),
        causes: z.array(
          z.object({ subsystem: z.string(), statement: z.string(), weight: z.number() }),
        ),
        conclusion: z.string(),
        recommendation: z.string(),
        nearestMarker: z.string().nullable(),
      }),
    )
    .optional(),

  /**
   * Pass/fail payload for a build pipeline.
   *
   * Deliberately duplicated out of the device entries rather than derived by
   * the caller: a CI job reads one field and gets a verdict, and the thresholds
   * that produced it travel with it so a red build is explainable from the
   * artifact alone.
   */
  qualityGate: z
    .object({
      gateVersion: z.number(),
      status: z.enum(['pass', 'warn', 'fail']),
      passed: z.boolean(),
      exitCode: z.number(),
      analysisId: z.string(),
      gameName: z.string(),
      packageName: z.string().nullable(),
      versionName: z.string().nullable(),
      commit: z.string().nullable(),
      generatedAt: z.string(),
      summary: z.object({
        failed: z.number(),
        warned: z.number(),
        passed: z.number(),
        skipped: z.number(),
        failedChecks: z.array(z.string()),
        skippedChecks: z.array(z.string()),
      }),
      devices: z.array(
        z.object({
          serial: z.string(),
          role: z.string(),
          model: z.string(),
          tier: z.string(),
          tierReason: z.string(),
          status: z.enum(['pass', 'warn', 'fail', 'skipped']),
          checks: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              status: z.enum(['pass', 'warn', 'fail', 'skipped']),
              value: z.number().nullable(),
              threshold: z.number().nullable(),
              direction: z.enum(['at-least', 'at-most']),
              unit: z.string(),
              message: z.string(),
            }),
          ),
        }),
      ),
    })
    .nullable()
    .optional(),

  artifacts: z.array(z.object({ kind: z.string(), path: z.string(), description: z.string() })),

  /** Everything the run could not do, stated plainly. */
  limitations: z.array(z.string()),
});

export type AnalysisReport = z.infer<typeof reportSchema>;

export function validateReport(value: unknown): AnalysisReport {
  return reportSchema.parse(value);
}

export function safeValidateReport(value: unknown): {
  ok: boolean;
  report?: AnalysisReport;
  errors?: string[];
} {
  const result = reportSchema.safeParse(value);
  if (result.success) return { ok: true, report: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}
