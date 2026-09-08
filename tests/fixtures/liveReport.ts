/**
 * A measured session, as a report object.
 *
 * The end-to-end fixture in this suite is static-only - no device, no frame
 * rate, no heat - so nothing in it can exercise a summary whose entire job is to
 * present measured numbers. This is the session the summary redesign was drawn
 * against, rebuilt from its figures: 41/100 moderate at 35% confidence, 938 MB
 * peak, 59 fps, 32.2 °C, 6 janks, and a 505.1 MB spike over 9.2 seconds ranked
 * high.
 *
 * Returned fresh from a function rather than shared as a constant, so a test can
 * push it into a different shape - a healthy game, a failing one - without the
 * next test inheriting the change.
 */
import { validateReport, type AnalysisReport } from '../../src/report/model.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

export function liveSessionReport(): AnalysisReport {
  return validateReport(REPORT);
}

const REPORT = {
  schemaVersion: 1 as const,
  analysisId: 'prison-riot_20260903-141200_ab12cd',
  gameId: 'prison-riot',
  generatedAt: '2026-09-03T14:16:44.000Z',
  toolVersion: '0.1.0',

  subject: {
    gameName: 'Prison Riot: Guard Simulator',
    studio: 'Game District',
    packageName: 'com.gamedistrict.prisonriot',
    versionName: '1.8.0',
    versionCode: 180,
    unityVersion: '2022.3.20f1',
    scriptingBackend: 'IL2CPP',
    abis: ['arm64-v8a'],
    apkSizeBytes: 412 * MB,
    repository: null,
  },

  verdict: {
    headline:
      'Moderate OOM risk (score 41/100): one large memory jump was measured during play, and the ' +
      'session was too short to confirm whether it is released again.',
    budgetVerdict: 'green' as const,
    combinedRisk: {
      value: 41,
      band: 'moderate' as const,
      contributors: [{ findingId: 'f-spike', title: 'Memory spike', impact: 28 }],
    },
    staticRisk: { value: 0, band: 'low' as const, contributors: [] },
    liveRisk: { value: 41, band: 'moderate' as const, contributors: [] },
    confidence: {
      value: 0.35,
      factors: [
        { name: 'Live device session captured', present: true, weight: 0.25 },
        { name: 'Unity project source analyzed', present: false, weight: 0.2 },
        { name: 'Two or more devices', present: false, weight: 0.1 },
      ],
      caveats: [
        'Only one device was tested, so device-specific behaviour cannot be separated from the build.',
        'The project source was not available, so no cause could be traced.',
      ],
    },
  },

  devices: [
    {
      serial: 'R5CX41ABCDE',
      role: 'A',
      model: 'SM-A366B',
      manufacturer: 'Samsung',
      androidVersion: '15',
      sdkInt: 35,
      totalRamBytes: Math.round(7.21 * GB),
      abi: 'arm64-v8a',
      risk: { value: 41, band: 'moderate' as const, contributors: [] },
      peakBytes: 938 * MB,
      peakRamFraction: 0.127,
      baselineBytes: 402 * MB,
      averageBytes: 731 * MB,
      finalBytes: 905 * MB,
      growthBytesPerMinute: 12 * MB,
      processDeaths: 0,
      minDeviceAvailableBytes: 2411 * MB,
      metric: 'pss',
      fps: {
        averageFps: 59,
        medianFps: 60,
        typicalFrameFps: 60,
        minFrameFps: 9.6,
        maxFrameFps: 61,
        low1PercentFps: 22.4,
        longestFrameMs: 104,
        smallJanks: 41,
        janks: 6,
        bigJanks: 0,
        janksPerMinute: 1.6,
        totalFrames: 13_204,
        displayHz: 60,
        matchesDisplayRate: true,
        minFps: 41,
        lowPercentileFps: 47,
        percentiles: { p01: 41, p05: 52, p25: 59, p50: 60, p75: 60, p95: 60, p99: 60 },
        sampleCount: 228,
        jankPercent: 0.05,
        worstFrameMs: 104,
        source: 'surfaceflinger',
      },
      thermal: {
        peakBatteryC: 32.2,
        startC: 30.0,
        endC: 32.0,
        peakC: 32.2,
        riseC: 2.2,
        hottestZone: 'cpu-0-0',
        worstStatus: 'none',
        throttlingMs: 0,
        verdict: 'cool' as const,
      },
      fpsSeries: [
        { elapsedMs: 0, fps: 60, janks: 0 },
        { elapsedMs: 60_000, fps: 59, janks: 2 },
        { elapsedMs: 120_000, fps: 58, janks: 3 },
        { elapsedMs: 180_000, fps: 60, janks: 1 },
      ],
      freshStart: null,
      battery: {
        startPercent: 84,
        endPercent: 84,
        startTemperatureC: 30.0,
        endTemperatureC: 32.0,
        drainPercent: null,
        drainPercentPerHour: null,
        drainMah: null,
        netChargeMah: 12.5,
        startChargeUah: 4_100_000,
        endChargeUah: 4_112_500,
        wasCharging: true,
        unavailableReason: 'device was charging over USB',
      },
      budget: {
        verdict: 'green' as const,
        tier: 'high-memory',
        targetMinBytes: 700 * MB,
        targetMaxBytes: 1200 * MB,
        hardLimitBytes: 1800 * MB,
        targetRatio: 0.78,
        limitRatio: 0.52,
        summary: 'Peak 938 MB is within the 1.17 GB one app should use on a 7.21 GB device.',
        reason: 'Peak sits below the target ceiling for this RAM tier.',
      },

      /*
       * The subsystems beyond memory.
       *
       * Shaped as a run where the phone answered for GPU load and per-core CPU,
       * the build carried the Unity reporter, and the app was debuggable enough
       * for the disk counters - i.e. the best case, so the renderers get
       * exercised. Individual tests null out whichever one they need absent.
       *
       * The figures tell one coherent story: the GPU is close to saturated and
       * takes the longest of the three stages, so the session is GPU-bound; a
       * scene load reads hard and drops frames while it does; and the audio
       * mixer missed a handful of buffers.
       */
      gpu: {
        averageUtilizationPercent: 78.4,
        peakUtilizationPercent: 97.2,
        saturatedSamplePercent: 18.6,
        averageClockMhz: 720,
        peakClockMhz: 940,
        maxClockMhz: 940,
        clockPinnedPercent: 22.4,
        source: 'kgsl-busy',
        sampleCount: 46,
        unavailableReason: null,
      },
      render: {
        averageDrawCalls: 812,
        peakDrawCalls: 2140,
        averageBatches: 274,
        averageSetPassCalls: 96,
        peakSetPassCalls: 231,
        averageTriangles: 214_000,
        peakTriangles: 688_000,
        averageVertices: 168_000,
        peakVertices: 502_000,
        peakUsedTextureBytes: 412 * MB,
        peakRenderTextureBytes: 46 * MB,
        peakUsedTextureCount: 231,
        averageMainThreadMs: 9.4,
        peakMainThreadMs: 41.2,
        averageRenderThreadMs: 6.1,
        peakRenderThreadMs: 22.8,
        averageGpuFrameMs: 13.8,
        peakGpuFrameMs: 58.4,
        sampleCount: 228,
        unavailable: [],
      },
      cpu: {
        averageAppCpuPercentOfCore: 164.2,
        peakAppCpuPercentOfCore: 312.5,
        averageAppCpuPercentOfDevice: 20.5,
        averageSystemCpuPercentOfDevice: 34.1,
        averageOtherCpuPercentOfDevice: 13.6,
        peakOtherCpuPercentOfDevice: 29.4,
        clusters: [
          {
            cluster: 'big' as const,
            coreCount: 2,
            averageUsagePercent: 61.2,
            peakUsagePercent: 94.0,
            averageFreqMhz: 2210,
            maxFreqMhz: 2400,
            clockPinnedPercent: 31.5,
          },
          {
            cluster: 'little' as const,
            coreCount: 6,
            averageUsagePercent: 28.4,
            peakUsagePercent: 71.0,
            averageFreqMhz: 1440,
            maxFreqMhz: 2000,
            clockPinnedPercent: 4.2,
          },
        ],
        threads: [
          {
            name: 'UnityMain',
            role: 'main' as const,
            averageCpuPercent: 62.4,
            peakCpuPercent: 98.1,
            saturatedSamplePercent: 8.7,
            dominantCluster: 'big' as const,
            clusterConsistencyPercent: 91.3,
          sampleCount: 46,
          },
          {
            name: 'UnityGfxDeviceW',
            role: 'render' as const,
            averageCpuPercent: 38.9,
            peakCpuPercent: 74.2,
            saturatedSamplePercent: 0,
            dominantCluster: 'big' as const,
            clusterConsistencyPercent: 84.1,
            sampleCount: 46,
          },
        ],
        mainThread: {
          name: 'UnityMain',
          role: 'main' as const,
          averageCpuPercent: 62.4,
          peakCpuPercent: 98.1,
          saturatedSamplePercent: 8.7,
          dominantCluster: 'big' as const,
          clusterConsistencyPercent: 91.3,
          sampleCount: 46,
        },
        renderThread: {
          name: 'UnityGfxDeviceW',
          role: 'render' as const,
          averageCpuPercent: 38.9,
          peakCpuPercent: 74.2,
          saturatedSamplePercent: 0,
          dominantCluster: 'big' as const,
          clusterConsistencyPercent: 84.1,
          sampleCount: 46,
        },
        averageThreadCount: 84.2,
        sampleCount: 46,
        unavailableReason: null,
      },
      io: {
        totalReadBytes: 604 * MB,
        totalWriteBytes: 18 * MB,
        totalStorageReadBytes: 214 * MB,
        totalStorageWriteBytes: 6 * MB,
        peakReadBytesPerSecond: 96 * MB,
        peakStorageReadBytesPerSecond: 61 * MB,
        averageReadBytesPerSecond: 3 * MB,
        cacheHitPercent: 64.6,
        bursts: [
          {
            elapsedMs: 76_000,
            readBytesPerSecond: 96 * MB,
            storageReadBytesPerSecond: 61 * MB,
            nearestMarker: 'Riot starts',
            fps: 18,
            janks: 4,
          },
        ],
        burstsWithStutter: 1,
        fpsDuringBursts: 24.5,
        fpsOutsideBursts: 59.4,
        sampleCount: 46,
        unavailableReason: null,
      },
      audio: {
        peakActiveTracks: 11,
        averageActiveTracks: 6.4,
        underrunsDuringSession: 3,
        underrunsPerMinute: 0.8,
        sampleRateHz: 48_000,
        bufferFrames: 960,
        bufferMs: 20,
        peakPlayingSources: 24,
        averagePlayingSources: 11.2,
        peakAudioVoices: 28,
        averageAudioCpuPercent: 4.1,
        peakAudioCpuPercent: 9.6,
        averageDspCpuPercent: 2.8,
        peakAudioMemoryBytes: 34 * MB,
        peakClipCount: 62,
        verdict: 'occasional-dropouts' as const,
        sampleCount: 46,
        unavailableReason: null,
      },
      bottleneck: {
        kind: 'gpu' as const,
        headline: 'Frames are limited by the GPU.',
        reason: 'It took 13.8 ms per frame against 9.4 ms for the main thread (game logic and physics).',
        confidence: 0.85,
        frameBudget: {
          targetMs: 16.67,
          actualMs: 16.67,
          mainThreadMs: 9.4,
          renderThreadMs: 6.1,
          gpuFrameMs: 13.8,
        },
        contributors: [
          {
            kind: 'storage',
            note: "1 of the session's heavy reads landed in a window that also dropped frames.",
          },
        ],
        fillRatePressure: 'likely' as const,
        basis: 'engine-thread-times' as const,
      },
      tier: {
        tier: 'high' as const,
        label: 'high-end (7.2 GB of RAM, fastest core 2.4 GHz, 8 cores, 60 Hz panel)',
        reason: 'Tiered on 7.2 GB of RAM, fastest core 2.4 GHz, 8 cores, 60 Hz panel.',
        minMedianFps: 54,
        minLow1PercentFps: 27,
        maxJanksPerMinute: 6,
        maxPeakBytes: 1200 * MB,
        maxThermalRiseC: 8,
        maxDrawCalls: 1500,
        maxTriangles: 1_500_000,
        maxUnderrunsPerMinute: 0.5,
      },
    },
  ],

  session: {
    sessionId: 's-1',
    startedAt: '2026-09-03T14:12:00.000Z',
    durationMs: 228_000,
    markerCount: 4,
    sampleCounts: { deep: 46, light: 228 },
    cycles: [],
    screenVisits: [],
    timeline: [],
    startedAtLocal: '2026-09-03 19:12',
    endedAt: '2026-09-03T14:15:48.000Z',
    spikes: [
      {
        role: 'A',
        letter: 'A',
        fromMs: 74_000,
        toMs: 83_200,
        deltaBytes: Math.round(505.1 * MB),
        totalBytes: 938 * MB,
        kind: 'scene load',
        nearestMarker: 'Riot starts',
        categories: [{ label: 'Graphics', deltaBytes: 320 * MB }],
        mappings: [],
        engine: [],
      },
    ],
    timelineSeries: [
      {
        role: 'A',
        points: [
          { elapsedMs: 0, totalBytes: 402 * MB, categories: {} },
          { elapsedMs: 80_000, totalBytes: 938 * MB, categories: {} },
          { elapsedMs: 228_000, totalBytes: 905 * MB, categories: {} },
        ],
      },
    ],
  },

  project: null,

  priority: [
    {
      rank: 1,
      priorityScore: 3.4,
      reason:
        'directly measured on a real device; the size at stake is large enough to matter on its own',
      finding: {
        ruleId: 'LIVE.SPIKE',
        id: 'f-spike',
        source: 'live' as const,
        title: 'Memory spike of 505.1 MB on Device A',
        description:
          'Memory rose by 505.1 MB in 9.2 seconds right after "Riot starts", reaching 938.0 MB ' +
          "(12.7% of this device's 7.21 GB of RAM).",
        severity: 'high' as const,
        confidence: 0.9,
        recommendation:
          'Identify what loads at this moment and stream or split it. Large single-shot loads are ' +
          'the usual cause.',
        evidence: [
          {
            kind: 'metric' as const,
            summary: '432.9 MB to 938.0 MB in 9.2s',
            data: { deltaBytes: Math.round(505.1 * MB), windowMs: 9200, metric: 'pss' },
          },
          {
            kind: 'event' as const,
            summary: 'Player state at the time: "Riot starts"',
            data: { marker: 'Riot starts' },
          },
        ],
        estimatedBytes: Math.round(505.1 * MB),
        subject: 'Riot starts',
        tags: ['spike', 'device:A'],
      },
    },
    {
      rank: 2,
      priorityScore: 1.1,
      reason: 'directly measured on a real device',
      finding: {
        ruleId: 'LIVE.SUSTAINED_GROWTH',
        id: 'f-growth',
        source: 'live' as const,
        title: 'Memory grows continuously at 12.0 MB/min on Device A',
        description: 'Memory rose steadily across the session.',
        severity: 'medium' as const,
        confidence: 0.5,
        recommendation: 'Check what is retained between rounds.',
        evidence: [],
        estimatedBytes: 45 * MB,
        subject: 'unknown state',
        tags: ['growth'],
      },
    },
  ],

  findings: { correlated: [], live: [], static: [] },
  correlations: [],

  /*
   * One diagnosed frame collapse, and one that could not be explained.
   *
   * Both shapes matter to the renderers. The first is the correlation engine
   * working - a frame drop with a memory jump, a draw-call spike and a disk read
   * in the same window. The second is it declining to guess, which the summary
   * has to present just as plainly.
   */
  diagnostics: [
    {
      id: 'diag_A_1',
      role: 'A',
      atMs: 76_000,
      toleranceMs: 5000,
      symptom: 'Frame rate fell to 18 fps at 1:16 and stayed down for about 4 s',
      fps: 18,
      janks: 4,
      severity: 'high' as const,
      confidence: 0.79,
      causes: [
        {
          subsystem: 'gpu',
          statement: 'the GPU took 58.4 ms for that frame',
          weight: 0.8,
        },
        {
          subsystem: 'memory',
          statement: 'memory rose 505.1 MB to 938.0 MB (Graphics +320.0 MB)',
          weight: 0.75,
        },
        {
          subsystem: 'rendering',
          statement: 'draw calls rose 2.6x to 2,140 (session median 812)',
          weight: 0.68,
        },
        {
          subsystem: 'storage',
          statement: 'the app read 96.0 MB/s, 61.0 MB/s of it from flash rather than cache',
          weight: 0.66,
        },
      ],
      conclusion:
        'Frame rate fell to 18 fps at 1:16 and stayed down for about 4 s. In the same window ' +
        '(±5 s): the GPU took 58.4 ms for that frame; memory rose 505.1 MB to 938.0 MB ' +
        '(Graphics +320.0 MB); draw calls rose 2.6x to 2,140 (session median 812); the app read ' +
        '96.0 MB/s, 61.0 MB/s of it from flash rather than cache. Most likely cause: the GPU ' +
        'running out of headroom for that frame. These readings coincide; the tool does not prove ' +
        'one caused the other.',
      recommendation:
        'Reduce per-pixel cost first - full-screen transparent layers, stacked particles and ' +
        'expensive fragment shaders - before reducing geometry.',
      nearestMarker: 'Riot starts',
    },
    {
      id: 'diag_A_2',
      role: 'A',
      atMs: 149_000,
      toleranceMs: 5000,
      symptom: 'Frame rate fell to 34 fps at 2:29',
      fps: 34,
      janks: 1,
      severity: 'low' as const,
      confidence: 0.2,
      causes: [],
      conclusion:
        'Frame rate fell to 34 fps at 2:29. Nothing in the other subsystems moved in the same ' +
        'window, so this drop is unexplained by the data collected.',
      recommendation:
        'Re-run with the Unity reporter component in the build so per-frame thread and GPU times ' +
        'are available for this window.',
      nearestMarker: 'Riot starts',
    },
  ],

  /*
   * The CI gate, with one failure, one warning and one skip.
   *
   * Deliberately mixed: a gate fixture where everything passes would never
   * exercise the wording that matters most, and a skipped check is the case the
   * renderers must not quietly present as a pass.
   */
  qualityGate: {
    gateVersion: 1,
    status: 'fail' as const,
    passed: false,
    exitCode: 1,
    analysisId: 'prison-riot_20260903-141200_ab12cd',
    gameName: 'Prison Riot: Guard Simulator',
    packageName: 'com.gamedistrict.prisonriot',
    versionName: '1.8.0',
    commit: null,
    generatedAt: '2026-09-03T14:16:44.000Z',
    summary: {
      failed: 1,
      warned: 1,
      passed: 6,
      skipped: 1,
      failedChecks: ['audio.underruns_per_minute'],
      skippedChecks: ['fps.low1'],
    },
    devices: [
      {
        serial: 'R5CX41ABCDE',
        role: 'A',
        model: 'Samsung SM-A366B',
        tier: 'high-end (7.2 GB of RAM, fastest core 2.4 GHz, 8 cores, 60 Hz panel)',
        tierReason: 'Tiered on 7.2 GB of RAM, fastest core 2.4 GHz, 8 cores, 60 Hz panel.',
        status: 'fail' as const,
        checks: [
          {
            id: 'stability.process_deaths',
            label: 'Process survived the session',
            status: 'pass' as const,
            value: 0,
            threshold: 0,
            direction: 'at-most' as const,
            unit: 'deaths',
            message: 'The process stayed alive for the whole session.',
          },
          {
            id: 'memory.peak',
            label: 'Peak memory',
            status: 'pass' as const,
            value: 938 * MB,
            threshold: 1200 * MB,
            direction: 'at-most' as const,
            unit: 'bytes',
            message: '938 MB, within the 1200 MB allowed.',
          },
          {
            id: 'fps.median',
            label: 'Median frame rate',
            status: 'pass' as const,
            value: 60,
            threshold: 54,
            direction: 'at-least' as const,
            unit: 'fps',
            message: '60 fps, at or above the 54 fps required.',
          },
          {
            id: 'fps.low1',
            label: 'Worst 1% frame rate',
            status: 'skipped' as const,
            value: null,
            threshold: 27,
            direction: 'at-least' as const,
            unit: 'fps',
            message: 'Per-frame times were not available, so the worst 1% is unknown.',
          },
          {
            id: 'fps.janks_per_minute',
            label: 'Stutter rate',
            status: 'warn' as const,
            value: 6.4,
            threshold: 6,
            direction: 'at-most' as const,
            unit: 'janks/min',
            message: '6.4 janks/min, over the 6 janks/min allowed.',
          },
          {
            id: 'thermal.rise',
            label: 'Temperature rise',
            status: 'pass' as const,
            value: 2.2,
            threshold: 8,
            direction: 'at-most' as const,
            unit: '°C',
            message: '2.2 °C, within the 8 °C allowed.',
          },
          {
            id: 'render.draw_calls',
            label: 'Draw calls per frame',
            status: 'pass' as const,
            value: 812,
            threshold: 1500,
            direction: 'at-most' as const,
            unit: 'calls',
            message: '812 calls, within the 1,500 calls allowed.',
          },
          {
            id: 'audio.underruns_per_minute',
            label: 'Audio dropouts',
            status: 'fail' as const,
            value: 0.8,
            threshold: 0.5,
            direction: 'at-most' as const,
            unit: 'underruns/min',
            message: '0.8 underruns/min, over the 0.5 underruns/min allowed.',
          },
          {
            id: 'storage.stalling_reads',
            label: 'Reads that cost frames',
            status: 'warn' as const,
            value: 1,
            threshold: 0,
            direction: 'at-most' as const,
            unit: 'bursts',
            message: '1 heavy read(s) landed in a window that also dropped frames.',
          },
        ],
      },
    ],
  },

  artifacts: [],
  limitations: [
    'Only one device was tested.',
    'The Unity project was not supplied, so no static analysis ran.',
  ],
};
