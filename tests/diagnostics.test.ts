/**
 * Bottleneck attribution, device tiers, root-cause correlation and the CI gate.
 *
 * These four are the parts of the tool that draw conclusions rather than take
 * measurements, so what is protected here is mostly restraint:
 *
 *  - a bottleneck is attributed from engine thread times where they exist and
 *    labelled as an inference where they do not, and reported as unknown when
 *    neither is available rather than defaulting to the common case;
 *  - a frame drop with nothing coincident is reported with no cause, because a
 *    confident wrong answer is worse than an admitted gap;
 *  - a gate check that could not be measured is skipped and never passed, or a
 *    team learns that green means nothing.
 */
import { describe, expect, it } from 'vitest';

import { classifyBottleneck } from '../src/analysis/bottleneck.js';
import { classifyDeviceTier, tierTable } from '../src/analysis/deviceTier.js';
import { diagnose, formatClock } from '../src/analysis/diagnostics.js';
import { detectFpsEvents } from '../src/analysis/fpsEvents.js';
import { buildQualityGate } from '../src/report/qualityGate.js';
import type { CpuSummary } from '../src/telemetry/cpuThreads.js';
import type { DiskIoSummary } from '../src/telemetry/diskIo.js';
import type { FpsSummary, ThermalSummary } from '../src/telemetry/deviceHealth.js';
import type { GpuSummary, RenderSummary } from '../src/telemetry/gpu.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

// ---------------------------------------------------------------------------
// Builders. Everything null by default, so each test states only what it means.
// ---------------------------------------------------------------------------

function fps(over: Partial<FpsSummary> = {}): FpsSummary {
  return {
    averageFps: 59,
    medianFps: 60,
    typicalFrameFps: 60,
    minFrameFps: null,
    maxFrameFps: null,
    low1PercentFps: 30,
    longestFrameMs: null,
    smallJanks: null,
    janks: 6,
    bigJanks: null,
    janksPerMinute: 1.6,
    totalFrames: null,
    displayHz: 60,
    matchesDisplayRate: true,
    minFps: null,
    lowPercentileFps: null,
    percentiles: null,
    sampleCount: 228,
    jankPercent: null,
    worstFrameMs: null,
    source: 'timestats',
    ...over,
  } as FpsSummary;
}

function render(over: Partial<RenderSummary> = {}): RenderSummary {
  return {
    averageDrawCalls: null,
    peakDrawCalls: null,
    averageBatches: null,
    averageSetPassCalls: null,
    peakSetPassCalls: null,
    averageTriangles: null,
    peakTriangles: null,
    averageVertices: null,
    peakVertices: null,
    peakUsedTextureBytes: null,
    peakRenderTextureBytes: null,
    peakUsedTextureCount: null,
    averageMainThreadMs: null,
    peakMainThreadMs: null,
    averageRenderThreadMs: null,
    peakRenderThreadMs: null,
    averageGpuFrameMs: null,
    peakGpuFrameMs: null,
    sampleCount: 0,
    unavailable: [],
    ...over,
  };
}

function gpu(over: Partial<GpuSummary> = {}): GpuSummary {
  return {
    averageUtilizationPercent: null,
    peakUtilizationPercent: null,
    saturatedSamplePercent: null,
    averageClockMhz: null,
    peakClockMhz: null,
    maxClockMhz: null,
    clockPinnedPercent: null,
    source: null,
    sampleCount: 0,
    unavailableReason: null,
    ...over,
  };
}

function cpu(over: Partial<CpuSummary> = {}): CpuSummary {
  return {
    averageAppCpuPercentOfCore: null,
    peakAppCpuPercentOfCore: null,
    averageAppCpuPercentOfDevice: null,
    averageSystemCpuPercentOfDevice: null,
    averageOtherCpuPercentOfDevice: null,
    peakOtherCpuPercentOfDevice: null,
    clusters: [],
    threads: [],
    mainThread: null,
    renderThread: null,
    averageThreadCount: null,
    sampleCount: 0,
    unavailableReason: null,
    ...over,
  };
}

function thread(name: string, role: 'main' | 'render', average: number) {
  return {
    name,
    role,
    averageCpuPercent: average,
    peakCpuPercent: Math.min(100, average + 10),
    saturatedSamplePercent: average >= 85 ? 60 : 0,
    dominantCluster: 'big' as const,
    clusterConsistencyPercent: 90,
    sampleCount: 40,
  };
}

function io(over: Partial<DiskIoSummary> = {}): DiskIoSummary {
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
    unavailableReason: null,
    ...over,
  };
}

function thermal(over: Partial<ThermalSummary> = {}): ThermalSummary {
  return {
    peakBatteryC: 32,
    startC: 30,
    endC: 32,
    peakC: 32,
    riseC: 2,
    hottestZone: null,
    worstStatus: null,
    throttlingMs: 0,
    verdict: 'cool',
    ...over,
  } as ThermalSummary;
}

const nothing = { fps: null, render: null, gpu: null, cpu: null, io: null, thermal: null };

// ---------------------------------------------------------------------------
// Bottleneck
// ---------------------------------------------------------------------------

describe('bottleneck attribution', () => {
  it('attributes the frame to the longest stage when the engine reported them', () => {
    const verdict = classifyBottleneck({
      ...nothing,
      fps: fps(),
      render: render({ averageMainThreadMs: 9.4, averageRenderThreadMs: 6.1, averageGpuFrameMs: 13.8 }),
    });

    expect(verdict.kind).toBe('gpu');
    expect(verdict.basis).toBe('engine-thread-times');
    expect(verdict.headline).toContain('the GPU');
    // The three stage times travel with the verdict so a reader can check it.
    expect(verdict.frameBudget.gpuFrameMs).toBe(13.8);
    expect(verdict.frameBudget.targetMs).toBe(16.67);
    expect(verdict.confidence).toBeGreaterThan(0.8);
  });

  it('calls the pipeline balanced when no stage is clearly ahead', () => {
    // Within 15% of each other. Telling a studio to optimise the main thread
    // when the GPU is 3% behind it would send them after a frame they cannot win.
    const verdict = classifyBottleneck({
      ...nothing,
      fps: fps(),
      render: render({ averageMainThreadMs: 12.0, averageRenderThreadMs: 11.4, averageGpuFrameMs: 12.6 }),
    });

    expect(verdict.kind).toBe('balanced');
    expect(verdict.reason).toContain('Within 15%');
  });

  it('falls back to OS signals, and says that is what it did', () => {
    const verdict = classifyBottleneck({
      ...nothing,
      fps: fps({ medianFps: 34, typicalFrameFps: 34 }),
      gpu: gpu({ averageUtilizationPercent: 42 }),
      cpu: cpu({ mainThread: thread('UnityMain', 'main', 96) }),
    });

    expect(verdict.kind).toBe('cpu-main');
    expect(verdict.basis).toBe('os-signals');
    // Lower confidence than a per-frame measurement, because per-core load is
    // sampled every few seconds while a frame lasts milliseconds.
    expect(verdict.confidence).toBeLessThan(0.8);
    expect(verdict.reason).toContain('96%');
  });

  it('reports the frame rate as capped rather than limited when nothing is saturated', () => {
    const verdict = classifyBottleneck({
      ...nothing,
      fps: fps({ medianFps: 30, typicalFrameFps: 30 }),
      gpu: gpu({ averageUtilizationPercent: 31 }),
      cpu: cpu({ averageAppCpuPercentOfCore: 60, mainThread: thread('UnityMain', 'main', 34) }),
    });

    expect(verdict.kind).toBe('balanced');
    expect(verdict.reason).toContain('frame cap');
  });

  it('says it does not know rather than guessing the common case', () => {
    const verdict = classifyBottleneck({ ...nothing, fps: fps() });

    expect(verdict.kind).toBe('unknown');
    expect(verdict.confidence).toBe(0);
    // "Not measurable" is only actionable with the reason attached.
    expect(verdict.reason).toContain('reporter component');
  });

  it('keeps storage and heat as contributors rather than as the steady-state limit', () => {
    const verdict = classifyBottleneck({
      ...nothing,
      fps: fps(),
      render: render({ averageMainThreadMs: 4, averageRenderThreadMs: 3, averageGpuFrameMs: 14 }),
      io: io({ burstsWithStutter: 2, fpsDuringBursts: 24, fpsOutsideBursts: 59 }),
      thermal: thermal({ verdict: 'throttling', throttlingMs: 42_000 }),
    });

    // A disk stall is a few frames and throttling lowers every ceiling at once;
    // neither competes for one frame the way the three stages do.
    expect(verdict.kind).toBe('gpu');
    expect(verdict.contributors.map((c) => c.kind)).toEqual(['thermal', 'storage']);
    expect(verdict.contributors[1]!.note).toContain('24 fps');
  });

  it('promotes a contributor when nothing else could be measured at all', () => {
    const verdict = classifyBottleneck({
      ...nothing,
      fps: fps(),
      thermal: thermal({ verdict: 'throttling', throttlingMs: 60_000 }),
    });

    expect(verdict.kind).toBe('thermal');
    expect(verdict.basis).toBe('none');
    expect(verdict.reason).toContain('not necessarily the largest cost');
  });

  it('infers fill-rate pressure only from a busy GPU with trivial geometry', () => {
    const likely = classifyBottleneck({
      ...nothing,
      fps: fps(),
      render: render({ averageGpuFrameMs: 14, averageTriangles: 120_000, averageMainThreadMs: 5 }),
    });
    expect(likely.fillRatePressure).toBe('likely');

    // Heavy geometry with a busy GPU is a vertex problem, not a pixel one.
    const heavy = classifyBottleneck({
      ...nothing,
      fps: fps(),
      render: render({ averageGpuFrameMs: 14, averageTriangles: 2_400_000, averageMainThreadMs: 5 }),
    });
    expect(heavy.fillRatePressure).toBe('unlikely');

    // With no measurement it stays unknown rather than becoming good news.
    expect(classifyBottleneck({ ...nothing, fps: fps() }).fillRatePressure).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Device tiers
// ---------------------------------------------------------------------------

describe('device spec tiers', () => {
  it('tiers on RAM, and lets a slow SoC drop a generous shell a tier', () => {
    const flagship = classifyDeviceTier({ totalRamBytes: 12 * GB, maxCoreMhz: 3200 });
    expect(flagship.tier).toBe('high');

    // 8 GB paired with a 2.0 GHz ceiling is a mid-range chip in a generous
    // shell. Grading it as a flagship would fail a build for running exactly as
    // well as that phone can run.
    const generousShell = classifyDeviceTier({ totalRamBytes: 8 * GB, maxCoreMhz: 1900 });
    expect(generousShell.tier).toBe('mid');

    const budget = classifyDeviceTier({ totalRamBytes: 3 * GB, maxCoreMhz: 1800 });
    expect(budget.tier).toBe('low');
    // A fast chip never lifts a 3 GB phone to flagship: memory pressure decides
    // that device's fate whatever the silicon can do.
    expect(classifyDeviceTier({ totalRamBytes: 3 * GB, maxCoreMhz: 3200 }).tier).toBe('low');
  });

  it('grades the frame-rate floor against the panel rather than an absolute', () => {
    // A 30 fps floor means something different on a 60 Hz screen than on a
    // 120 Hz one, and a game tracking a 90 Hz panel should not be graded as
    // though 60 were the ceiling.
    const sixtyHz = classifyDeviceTier({ totalRamBytes: 12 * GB, maxCoreMhz: 3200, displayHz: 60 });
    expect(sixtyHz.minMedianFps).toBe(54);

    const oneTwentyHz = classifyDeviceTier({
      totalRamBytes: 12 * GB,
      maxCoreMhz: 3200,
      displayHz: 120,
    });
    // The class floor of 55 wins over 90% of 120, because it is the lower bar.
    expect(oneTwentyHz.minMedianFps).toBe(55);

    const fortyFiveHz = classifyDeviceTier({ totalRamBytes: 3 * GB, displayHz: 45 });
    expect(fortyFiveHz.minMedianFps).toBe(23);
  });

  it('takes its memory ceiling from the RAM tier, so the two never disagree', () => {
    const tier = classifyDeviceTier({ totalRamBytes: 4 * GB });
    expect(tier.maxPeakBytes).toBe(800 * MB);
    expect(tier.reason).toContain('4.0 GB of RAM');
  });

  it('publishes the table it graded against', () => {
    const table = tierTable();
    expect(table.map((r) => r.tier)).toEqual(['low', 'mid', 'high']);
    // Stricter as the hardware gets better, in every dimension.
    expect(table[0]!.maxJanksPerMinute).toBeGreaterThan(table[2]!.maxJanksPerMinute);
    expect(table[0]!.maxDrawCalls).toBeLessThan(table[2]!.maxDrawCalls);
  });
});

// ---------------------------------------------------------------------------
// Root-cause correlation
// ---------------------------------------------------------------------------

/** A frame curve that holds 60 and collapses once, for four seconds. */
const COLLAPSING_CURVE = [
  { elapsedMs: 0, fps: 60, janks: 0 },
  { elapsedMs: 60_000, fps: 59, janks: 0 },
  { elapsedMs: 74_000, fps: 22, janks: 2 },
  { elapsedMs: 76_000, fps: 18, janks: 4 },
  { elapsedMs: 78_000, fps: 25, janks: 1 },
  { elapsedMs: 120_000, fps: 60, janks: 0 },
  { elapsedMs: 180_000, fps: 59, janks: 0 },
];

const EMPTY_INPUT = {
  role: 'A',
  durationMs: 228_000,
  fps: fps(),
  fpsSeries: [],
  memorySpikes: [],
  ioBursts: [],
  renderSeries: [],
  gpuSeries: [],
  cpuSeries: [],
  audioSeries: [],
  thermal: null,
  markers: [],
  processDeaths: 0,
};

describe('root-cause correlation', () => {
  it('groups consecutive collapsed windows into one event, dated by its worst', () => {
    const events = detectFpsEvents('A', COLLAPSING_CURVE);
    const drops = events.filter((e) => e.kind === 'drop');

    // One loading hitch spans three windows. Three diagnoses of it would read
    // as three separate problems.
    expect(drops).toHaveLength(1);
    expect(drops[0]!.lowestFps).toBe(18);
    expect(drops[0]!.atMs).toBe(76_000);
    expect(drops[0]!.windows).toBe(3);
    expect(drops[0]!.janks).toBe(7);
  });

  it('reports what the rate fell from and returned to, not only the bottom', () => {
    // The figure that makes a drop judgeable: 18 fps means nothing until the
    // reader knows the game had been holding 59.
    const drop = detectFpsEvents('A', COLLAPSING_CURVE).find((e) => e.kind === 'drop')!;
    expect(drop.beforeFps).toBe(59);
    expect(drop.afterFps).toBe(60);
    expect(drop.changePercent).toBeCloseTo(-69.5, 0);
    expect(drop.letter).toBe('A');
  });

  it('does not call a steady 30 fps game a collapse', () => {
    const steady = Array.from({ length: 10 }, (_, i) => ({
      elapsedMs: i * 5000,
      fps: 30 - (i % 2),
      janks: 0,
    }));
    expect(detectFpsEvents('A', steady)).toEqual([]);
  });

  it('names what every subsystem was doing in the same window', () => {
    const [worst] = diagnose({
      ...EMPTY_INPUT,
      fpsSeries: COLLAPSING_CURVE,
      markers: [{ elapsedMs: 70_000, label: 'Riot starts' }],
      memorySpikes: [
        {
          letter: 'A',
          fromMs: 74_000,
          toMs: 78_000,
          deltaBytes: 505 * MB,
          totalBytes: 938 * MB,
          kind: 'scene load',
          nearestMarker: 'Riot starts',
          categories: [{ label: 'Graphics', deltaBytes: 320 * MB }],
          engine: [{ label: 'textures', deltaBytes: 412 * MB }],
        },
      ],
      renderSeries: [
        { elapsedMs: 0, drawCalls: 300, gpuFrameMs: 8 },
        { elapsedMs: 40_000, drawCalls: 310, gpuFrameMs: 8 },
        { elapsedMs: 60_000, drawCalls: 290, gpuFrameMs: 9 },
        { elapsedMs: 76_000, drawCalls: 2140, gpuFrameMs: 58.4 },
        { elapsedMs: 120_000, drawCalls: 305, gpuFrameMs: 8 },
      ],
      ioBursts: [
        {
          elapsedMs: 76_000,
          readBytesPerSecond: 96 * MB,
          storageReadBytesPerSecond: 61 * MB,
          nearestMarker: 'Riot starts',
          fps: 18,
          janks: 4,
        },
      ],
    })!;

    expect(worst.fps).toBe(18);
    expect(worst.nearestMarker).toBe('Riot starts');
    expect(worst.severity).toBe('critical');

    const causes = worst.causes.map((c) => c.subsystem);
    expect(causes).toContain('memory');
    expect(causes).toContain('rendering');
    expect(causes).toContain('storage');

    // The change outranks the stage time. "The GPU took 58 ms" is close to a
    // restatement of "the frame took 58 ms"; what a developer can act on is
    // what changed to make it so, so the 505 MB load leads and the stage time
    // sits below it saying which stage to look at.
    expect(worst.causes[0]!.subsystem).toBe('memory');
    expect(worst.causes[0]!.statement).toContain('505.0 MB');
    expect(worst.causes.find((c) => c.subsystem === 'gpu')!.statement).toContain('58.4 ms');

    // Draw calls are judged against the session's own median, because the
    // absolute count is a design decision and the change is not.
    const rendering = worst.causes.find((c) => c.subsystem === 'rendering')!;
    expect(rendering.statement).toContain('2,140');
    expect(rendering.statement).toContain('session median 305');

    expect(worst.conclusion).toContain('In the same window');
    // Correlation stated as correlation, every time.
    expect(worst.conclusion).toContain('does not prove one caused the other');
    expect(worst.confidence).toBeLessThan(0.9);
  });

  it('reports a drop with no cause rather than assigning it the likeliest one', () => {
    const [only] = diagnose({ ...EMPTY_INPUT, fpsSeries: COLLAPSING_CURVE })!;

    expect(only.causes).toEqual([]);
    expect(only.conclusion).toContain('unexplained by the data collected');
    expect(only.confidence).toBe(0.2);
    // The recommendation is what to add to the build to find out next time.
    expect(only.recommendation).toContain('reporter component');
  });

  it('diagnoses a kill even with no frame drop, because the process was gone', () => {
    const diagnoses = diagnose({ ...EMPTY_INPUT, processDeaths: 2 });

    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]!.severity).toBe('critical');
    expect(diagnoses[0]!.symptom).toContain('died 2 times');
    // Observed directly rather than inferred, so it is the one diagnosis that
    // does not depend on a correlation being right.
    expect(diagnoses[0]!.confidence).toBe(0.95);
    expect(diagnoses[0]!.conclusion).toContain('low-memory killer');
  });

  it('dates a moment the way an operator refers to it', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(76_000)).toBe('1:16');
    expect(formatClock(605_000)).toBe('10:05');
  });
});

// ---------------------------------------------------------------------------
// CI gate
// ---------------------------------------------------------------------------

function gateFor(over: Record<string, unknown> = {}) {
  return buildQualityGate({
    analysisId: 'a1',
    gameName: 'Test Game',
    packageName: 'com.test.game',
    versionName: '1.0.0',
    commit: null,
    devices: [
      {
        serial: 'S1',
        role: 'A',
        model: 'Pixel 7',
        thresholds: classifyDeviceTier({ totalRamBytes: 8 * GB, maxCoreMhz: 2850, displayHz: 60 }),
        peakBytes: 900 * MB,
        processDeaths: 0,
        fps: fps(),
        thermal: thermal(),
        gpu: null,
        render: null,
        cpu: null,
        io: null,
        audio: null,
        ...over,
      },
    ],
  });
}

describe('the CI quality gate', () => {
  it('gives a pipeline one field to gate on', () => {
    const gate = gateFor();

    expect(gate.gateVersion).toBe(1);
    expect(['pass', 'warn', 'fail']).toContain(gate.status);
    expect(gate.exitCode).toBe(gate.status === 'fail' ? 1 : 0);
    expect(gate.passed).toBe(gate.status !== 'fail');
  });

  it('skips a check it could not measure, and never passes it', () => {
    const gate = gateFor();
    const byId = Object.fromEntries(gate.devices[0]!.checks.map((c) => [c.id, c]));

    // No engine reporter in this run, so draw calls and triangles are unknown.
    expect(byId['render.draw_calls']!.status).toBe('skipped');
    expect(byId['render.draw_calls']!.value).toBeNull();
    expect(byId['render.draw_calls']!.message).toContain('reporter component');
    expect(byId['audio.underruns_per_minute']!.status).toBe('skipped');

    // Counted and named, so a green gate cannot be read as full coverage.
    expect(gate.summary.skipped).toBeGreaterThan(0);
    expect(gate.summary.skippedChecks).toContain('render.draw_calls');
  });

  it('fails a kill outright, with no threshold to argue about', () => {
    const gate = gateFor({ processDeaths: 1 });

    expect(gate.status).toBe('fail');
    expect(gate.summary.failedChecks).toContain('stability.process_deaths');
    expect(gate.devices[0]!.checks[0]!.message).toContain('low-memory killer');
  });

  it('warns rather than fails inside measurement noise of a threshold', () => {
    // Two runs of the same build on the same phone differ by a few percent, and
    // a gate that flips red on that is a gate a team turns off.
    const marginal = gateFor({ fps: fps({ medianFps: 51 }) });
    const clearlyBad = gateFor({ fps: fps({ medianFps: 32 }) });

    const idOf = (g: ReturnType<typeof gateFor>) =>
      g.devices[0]!.checks.find((c) => c.id === 'fps.median')!.status;

    expect(idOf(marginal)).toBe('warn');
    expect(marginal.status).toBe('warn');
    expect(idOf(clearlyBad)).toBe('fail');
    expect(clearlyBad.status).toBe('fail');
  });

  it('carries the threshold and the tier that produced it', () => {
    const gate = gateFor();
    const check = gate.devices[0]!.checks.find((c) => c.id === 'memory.peak')!;

    expect(check.direction).toBe('at-most');
    expect(check.threshold).toBe(1500 * MB);
    expect(check.message).toContain('within');
    // So the first question after a red build is answerable from the artifact.
    expect(gate.devices[0]!.tier).toContain('high-end');
    expect(gate.devices[0]!.tierReason).toContain('8.0 GB of RAM');
  });

  it('gates storage on reads that cost frames, not on how much was read', () => {
    const heavyButFree = gateFor({
      io: io({ totalReadBytes: 900 * MB, burstsWithStutter: 0, sampleCount: 40 }),
    });
    const stalling = gateFor({
      io: io({ totalReadBytes: 200 * MB, burstsWithStutter: 4, sampleCount: 40 }),
    });

    const status = (g: ReturnType<typeof gateFor>) =>
      g.devices[0]!.checks.find((c) => c.id === 'storage.stalling_reads')!.status;

    // Reading a lot is not a defect; reading in a way that drops frames is.
    expect(status(heavyButFree)).toBe('pass');
    expect(status(stalling)).toBe('fail');
  });

  it('turns every failure into a warning when a team is adopting the gate', () => {
    const strict = gateFor({ processDeaths: 1 });
    const lenient = buildQualityGate({
      analysisId: 'a1',
      gameName: 'Test Game',
      packageName: null,
      versionName: null,
      commit: null,
      warnOnly: true,
      devices: [
        {
          serial: 'S1',
          role: 'A',
          model: 'Pixel 7',
          thresholds: classifyDeviceTier({ totalRamBytes: 8 * GB }),
          peakBytes: 900 * MB,
          processDeaths: 1,
          fps: fps(),
          thermal: thermal(),
          gpu: null,
          render: null,
          cpu: null,
          io: null,
          audio: null,
        },
      ],
    });

    expect(strict.status).toBe('fail');
    expect(strict.exitCode).toBe(1);
    // The red check is still red; only the pipeline's verdict softens.
    expect(lenient.status).toBe('warn');
    expect(lenient.exitCode).toBe(0);
    expect(lenient.summary.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression pins for the review fixes: each of these was a claim the
// surrounding comment promised and the arithmetic did not deliver.
// ---------------------------------------------------------------------------

describe('review regression pins', () => {
  it('does not name a bound when every stage has frame-budget headroom', () => {
    // A healthy 30 fps-capped game on a 60 Hz panel: main 6 ms, render 4 ms,
    // GPU 3 ms against a 16.67 ms budget. Naming the tallest of three idle
    // stages sent a studio after a frame they already had - the finding is the
    // cap, not the main thread.
    const verdict = classifyBottleneck({
      ...nothing,
      fps: fps({ medianFps: 30, typicalFrameFps: 30 }),
      render: render({ averageMainThreadMs: 6, averageRenderThreadMs: 4, averageGpuFrameMs: 3 }),
    });

    expect(verdict.kind).toBe('balanced');
    expect(verdict.headline).toContain('cap or vsync');
  });

  it('a slow SoC demotes one tier, not two', () => {
    // 8 GB of RAM whose sysfs read returns 1.8 GHz: mid-range in a generous
    // shell. Sequential demotion ifs once dropped it high -> mid -> low, and a
    // regressed build then passed the quality gate against a 30 fps bar.
    const tier = classifyDeviceTier({ totalRamBytes: 8 * GB, maxCoreMhz: 1800 });
    expect(tier.tier).toBe('mid');
  });

  it('a draw-call jump outranks the stage time even with no memory spike', () => {
    // The stage time is a restatement of the symptom; the change is the cause a
    // developer can act on. With nothing else moving, the 7x draw-call jump
    // must lead and the stage line sits under it saying where to look.
    const [worst] = diagnose({
      ...EMPTY_INPUT,
      fpsSeries: COLLAPSING_CURVE,
      renderSeries: [
        { elapsedMs: 0, drawCalls: 300, gpuFrameMs: 8 },
        { elapsedMs: 40_000, drawCalls: 310, gpuFrameMs: 8 },
        { elapsedMs: 60_000, drawCalls: 290, gpuFrameMs: 9 },
        { elapsedMs: 76_000, drawCalls: 2140, gpuFrameMs: 58.4 },
        { elapsedMs: 120_000, drawCalls: 305, gpuFrameMs: 8 },
      ],
    })!;

    expect(worst.causes[0]!.subsystem).toBe('rendering');
    expect(worst.causes[0]!.statement).toContain('draw calls');
    const stage = worst.causes.find((c) => c.subsystem === 'gpu');
    expect(stage).toBeDefined();
    expect(stage!.weight).toBeLessThan(worst.causes[0]!.weight);
  });
});
