import { describe, expect, it } from 'vitest';

import { detectAnomalies } from '../src/analysis/anomaly.js';
import { correlate } from '../src/analysis/correlation.js';
import { analyzeFlows, deriveCycleBoundaries } from '../src/analysis/flow.js';
import { prioritize, score, scoreFindings } from '../src/analysis/scoring.js';
import { buildDeviceTimeline, linearRegression } from '../src/analysis/timeline.js';
import type { Finding } from '../src/core/types.js';
import type { DeviceInfo } from '../src/devices/deviceManager.js';
import { parseDeviceMeminfo, parseMeminfo } from '../src/telemetry/probes.js';
import { classify, parseLogcatLine } from '../src/telemetry/logcat.js';
import type { LogEvent, MemorySample, TimelineEvent } from '../src/telemetry/types.js';

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Probe parsing
// ---------------------------------------------------------------------------

const DUMPSYS_SAMPLE = `Applications Memory Usage (in Kilobytes):
Uptime: 88012345 Realtime: 188012345

** MEMINFO in pid 9182 [com.fixture.game] **
                   Pss  Private  Private  SwapPss     Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty   Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap   412300   411800        0     2400   430000   460000   410000    50000
  Dalvik Heap    24500    24000        0      100    26000    38000    24000    14000
 Dalvik Other     8200     8100        0        0     8500
        Stack     2100     2100        0        0     2200
       Ashmem      450      400        0        0      500
      Gfx dev   180400   180400        0        0   180400
     .so mmap    42000     8000    20000      300    62000
    .apk mmap    31000        0    28000        0    58000
   Other mmap     5400      400     1200        0     6000
      Unknown    18000    18000        0      200    19000
        TOTAL   724350   653200    49200     3000   792600

 App Summary
                       Pss(KB)                        Rss(KB)
                        ------                        ------
           Java Heap:    24500                        26000
         Native Heap:   412300                       430000
                Code:    73000                       120000
               Stack:     2100                         2200
            Graphics:   180400                       180400
       Private Other:    14050
              System:    18000
             TOTAL PSS:   724350            TOTAL RSS:   792600      TOTAL SWAP PSS:     3000
`;

describe('dumpsys meminfo parsing', () => {
  it('extracts total PSS, RSS and swap', () => {
    const reading = parseMeminfo(DUMPSYS_SAMPLE);
    expect(reading.pssBytes).toBe(724350 * 1024);
    expect(reading.rssBytes).toBe(792600 * 1024);
    expect(reading.swapPssBytes).toBe(3000 * 1024);
  });

  it('extracts the per-category breakdown', () => {
    const reading = parseMeminfo(DUMPSYS_SAMPLE);
    expect(reading.breakdown?.nativeHeap).toBe(412300 * 1024);
    expect(reading.breakdown?.dalvikHeap).toBe(24500 * 1024);
    expect(reading.breakdown?.gfxDev).toBe(180400 * 1024);
    expect(reading.breakdown?.apkMmap).toBe(31000 * 1024);
  });

  it('extracts the App Summary section', () => {
    const reading = parseMeminfo(DUMPSYS_SAMPLE);
    expect(reading.summary?.graphics).toBe(180400 * 1024);
    expect(reading.summary?.javaHeap).toBe(24500 * 1024);
    expect(reading.summary?.code).toBe(73000 * 1024);
  });

  it('returns nulls rather than throwing on unrecognised output', () => {
    const reading = parseMeminfo('some unrelated shell output');
    expect(reading.pssBytes).toBeNull();
  });
});

describe('/proc/meminfo parsing', () => {
  it('reads device-wide availability', () => {
    const reading = parseDeviceMeminfo(
      'MemTotal:        3872164 kB\nMemFree:          204800 kB\nMemAvailable:     512000 kB\nCached:          890000 kB\n',
    );
    expect(reading.availableBytes).toBe(512000 * 1024);
    expect(reading.freeBytes).toBe(204800 * 1024);
    expect(reading.cachedBytes).toBe(890000 * 1024);
  });
});

describe('logcat parsing', () => {
  it('parses the threadtime format', () => {
    const parsed = parseLogcatLine(
      '03-14 09:21:44.512  1234  1300 I ActivityManager: Killing 9182:com.fixture.game/u0a231 (adj 905): empty #17',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.pid).toBe(1234);
    expect(parsed!.level).toBe('I');
    expect(parsed!.tag).toBe('ActivityManager');
  });

  it('classifies kill, crash and low-memory lines', () => {
    expect(classify('ActivityManager: Killing 9182:com.x (adj 905)', 'ActivityManager')).toBe('oom_kill');
    expect(classify('java.lang.OutOfMemoryError: Failed to allocate', 'AndroidRuntime')).toBe('oom_kill');
    expect(classify('FATAL EXCEPTION: main', 'AndroidRuntime')).toBe('crash');
    expect(classify('onTrimMemory level 80', 'Unity')).toBe('low_memory');
  });

  it('ignores ordinary chatter', () => {
    expect(classify('Setting up render pipeline', 'Renderer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Synthetic telemetry helpers
// ---------------------------------------------------------------------------

function sample(elapsedMs: number, pssBytes: number, role = 'A'): MemorySample {
  return {
    schema: 1,
    t: 1_700_000_000_000 + elapsedMs,
    elapsedMs,
    serial: `serial-${role}`,
    role,
    pid: 100,
    tier: 'deep',
    pssBytes,
    rssBytes: pssBytes + 20 * MB,
    swapPssBytes: 0,
    deviceAvailableBytes: 900 * MB,
    probeDurationMs: 120,
  };
}

function marker(elapsedMs: number, type: string, label = type): TimelineEvent {
  return {
    schema: 1,
    t: 1_700_000_000_000 + elapsedMs,
    elapsedMs,
    type,
    label,
    source: 'operator',
  };
}

const DEVICE_A: DeviceInfo = {
  serial: 'serial-A',
  role: 'A',
  model: 'Budget Phone',
  manufacturer: 'Test',
  brand: 'test',
  device: 'test',
  androidVersion: '11',
  sdkInt: 30,
  abi: 'arm64-v8a',
  supportedAbis: ['arm64-v8a'],
  totalRamBytes: 4 * 1024 * MB,
  availableRamBytes: 900 * MB,
  heapGrowthLimit: '256m',
  heapSize: '512m',
  procReadable: true,
  storageFreeBytes: 8 * 1024 * MB,
  isEmulator: false,
  screen: '1080x2400',
  isDebugBuild: false,
};

describe('regression statistics', () => {
  it('reports a high fit for a clean linear trend', () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      t: i,
      elapsedMs: i * 1000,
      value: 100 * MB + i * MB,
    }));
    const regression = linearRegression(points);
    expect(regression.r2).toBeGreaterThan(0.99);
    expect(regression.slopePerMinute / MB).toBeCloseTo(60, 0);
  });

  it('reports a low fit for noise around a flat line', () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      t: i,
      elapsedMs: i * 1000,
      value: 100 * MB + (i % 2 === 0 ? 4 * MB : -4 * MB),
    }));
    expect(linearRegression(points).r2).toBeLessThan(0.2);
  });
});

describe('anomaly detection', () => {
  it('detects a sudden spike and names the marker that preceded it', () => {
    const samples = [
      ...Array.from({ length: 20 }, (_, i) => sample(i * 1000, 400 * MB)),
      ...Array.from({ length: 10 }, (_, i) => sample(20_000 + i * 1000, 400 * MB + (i + 1) * 40 * MB)),
    ];
    const timeline = {
      sessionId: 's1',
      startedAtEpochMs: 0,
      devices: [buildDeviceTimeline('serial-A', 'A', samples)],
      events: [marker(19_000, 'gameplay_start', 'Gameplay Start')],
      logs: [],
    };

    const result = detectAnomalies({ timeline, devices: [DEVICE_A] });
    const spike = result.findings.find((f) => f.ruleId === 'LIVE.SPIKE');
    expect(spike).toBeDefined();
    expect(spike!.description).toContain('Gameplay Start');
    expect(result.perDevice[0]?.peakBytes).toBe(800 * MB);
  });

  it('detects sustained growth only when the trend actually fits', () => {
    const growing = Array.from({ length: 180 }, (_, i) => sample(i * 1000, 300 * MB + i * 0.4 * MB));
    const timeline = {
      sessionId: 's1',
      startedAtEpochMs: 0,
      devices: [buildDeviceTimeline('serial-A', 'A', growing)],
      events: [],
      logs: [],
    };
    const findings = detectAnomalies({ timeline, devices: [DEVICE_A] }).findings;
    const growth = findings.find((f) => f.ruleId === 'LIVE.SUSTAINED_GROWTH');
    expect(growth).toBeDefined();
    // 0.4 MB/s = 24 MB/min: real growth, but below the 30 MB/min "high" band.
    expect(growth!.severity).toBe('medium');
    expect(growth!.evidence[0]?.data?.['bytesPerMinute']).toBeGreaterThan(20 * MB);
  });

  it('escalates severity as the growth rate rises', () => {
    const fast = Array.from({ length: 180 }, (_, i) => sample(i * 1000, 300 * MB + i * 1.2 * MB));
    const findings = detectAnomalies({
      timeline: {
        sessionId: 's1',
        startedAtEpochMs: 0,
        devices: [buildDeviceTimeline('serial-A', 'A', fast)],
        events: [],
        logs: [],
      },
      devices: [DEVICE_A],
    }).findings;
    // 1.2 MB/s = 72 MB/min
    expect(findings.find((f) => f.ruleId === 'LIVE.SUSTAINED_GROWTH')?.severity).toBe('critical');
  });

  it('does not report growth for a flat session', () => {
    const flat = Array.from({ length: 180 }, (_, i) =>
      sample(i * 1000, 300 * MB + (i % 3) * MB),
    );
    const timeline = {
      sessionId: 's1',
      startedAtEpochMs: 0,
      devices: [buildDeviceTimeline('serial-A', 'A', flat)],
      events: [],
      logs: [],
    };
    const findings = detectAnomalies({ timeline, devices: [DEVICE_A] }).findings;
    expect(findings.find((f) => f.ruleId === 'LIVE.SUSTAINED_GROWTH')).toBeUndefined();
  });

  const PROCESS_GONE: TimelineEvent = {
    schema: 1,
    t: 2000,
    elapsedMs: 2000,
    type: 'process_gone',
    label: 'Game process disappeared',
    source: 'system',
    serial: 'serial-A',
  };

  const killLog = (message: string, tag = 'ActivityManager'): LogEvent => ({
    schema: 1,
    t: 2000,
    elapsedMs: 2000,
    serial: 'serial-A',
    level: 'I',
    tag,
    message,
    category: 'oom_kill',
  });

  const terminationTimeline = (events: TimelineEvent[], logs: LogEvent[]) => ({
    sessionId: 's1',
    startedAtEpochMs: 0,
    devices: [buildDeviceTimeline('serial-A', 'A', [sample(0, 400 * MB), sample(1000, 900 * MB)])],
    events,
    logs,
  });

  it('reports process termination as critical when the OS kills the game', () => {
    const timeline = terminationTimeline(
      [PROCESS_GONE],
      [killLog('Killing 100:com.fixture.game (adj 905)')],
    );
    const result = detectAnomalies({
      timeline,
      devices: [DEVICE_A],
      packageName: 'com.fixture.game',
    });
    const kill = result.findings.find((f) => f.ruleId === 'LIVE.PROCESS_TERMINATED');
    expect(kill?.severity).toBe('critical');
    expect(kill?.confidence).toBeGreaterThan(0.9);
    expect(result.perDevice[0]?.processDeaths).toBe(1);
    expect(result.perDevice[0]?.osKills).toBe(1);
  });

  // The operator closing the game, a force-stop and a dropped adb connection
  // all look like this. Reporting a critical OOM kill here would be a guess.
  it('stays silent when the process disappears with no kill notice', () => {
    const result = detectAnomalies({
      timeline: terminationTimeline([PROCESS_GONE], []),
      devices: [DEVICE_A],
      packageName: 'com.fixture.game',
    });
    expect(result.findings.some((f) => f.ruleId === 'LIVE.PROCESS_TERMINATED')).toBe(false);
    expect(result.perDevice[0]?.processDeaths).toBe(0);
    expect(result.perDevice[0]?.osKills).toBe(0);
  });

  it('ignores a kill notice that names another app', () => {
    const result = detectAnomalies({
      timeline: terminationTimeline(
        [PROCESS_GONE],
        [killLog('Killing 77:com.other.app (adj 905)')],
      ),
      devices: [DEVICE_A],
      packageName: 'com.fixture.game',
    });
    expect(result.findings.some((f) => f.ruleId === 'LIVE.PROCESS_TERMINATED')).toBe(false);
    expect(result.perDevice[0]?.osKills).toBe(0);
  });

  // An in-app OutOfMemoryError shares the oom_kill category but is a crash of
  // our own making, so it must not be reported as an automatic kill.
  it('does not treat an in-app allocation failure as an OS kill', () => {
    const result = detectAnomalies({
      timeline: terminationTimeline(
        [PROCESS_GONE],
        [killLog('java.lang.OutOfMemoryError: Failed to allocate a 24 MB allocation', 'art')],
      ),
      devices: [DEVICE_A],
      packageName: 'com.fixture.game',
    });
    expect(result.findings.some((f) => f.ruleId === 'LIVE.PROCESS_TERMINATED')).toBe(false);
    expect(result.perDevice[0]?.osKills).toBe(0);
  });
});

describe('repeated flow analysis', () => {
  // Three menu -> gameplay -> menu cycles, each returning to a baseline 150 MB
  // higher than the one before: the worked example from spec section 9.
  const cycleEvents = [
    marker(0, 'baseline', 'Baseline'),
    marker(10_000, 'gameplay_start', 'Gameplay Start'),
    marker(45_000, 'gameplay_end', 'Gameplay End'),
    marker(55_000, 'flow_complete', 'Flow Complete'),
    marker(70_000, 'gameplay_start', 'Gameplay Start'),
    marker(105_000, 'gameplay_end', 'Gameplay End'),
    marker(115_000, 'flow_complete', 'Flow Complete'),
    marker(130_000, 'gameplay_start', 'Gameplay Start'),
    marker(165_000, 'gameplay_end', 'Gameplay End'),
    marker(175_000, 'flow_complete', 'Flow Complete'),
  ];

  /**
   * Per 60 s cycle: 10 s settled menu, 20 s load ramp, 10 s at peak, 10 s
   * decay, then 10 s settled at the new (higher) baseline. Sampling continues
   * past the final marker, as it does in a real session.
   */
  function buildCycleSamples(): MemorySample[] {
    const points: MemorySample[] = [];
    const baselineFor = (cycle: number) => 500 * MB + cycle * 150 * MB;

    for (let t = 0; t <= 200_000; t += 1000) {
      const cycle = Math.floor(t / 60_000);
      const within = t % 60_000;
      const base = baselineFor(cycle);
      const next = baselineFor(cycle + 1);
      const peak = base + 450 * MB;

      let value: number;
      if (within < 10_000) value = base;
      else if (within < 30_000) value = base + ((within - 10_000) / 20_000) * 450 * MB;
      else if (within < 40_000) value = peak;
      else if (within < 50_000) value = peak - ((within - 40_000) / 10_000) * (peak - next);
      else value = next;

      points.push(sample(t, Math.round(value)));
    }
    return points;
  }

  it('derives one cycle per flow_complete marker', () => {
    const boundaries = deriveCycleBoundaries(cycleEvents);
    expect(boundaries).toHaveLength(3);
    expect(boundaries[0]?.startMs).toBe(0);
    expect(boundaries[0]?.endMs).toBe(55_000);
  });

  it('computes recovery deltas that grow across repeats', () => {
    const timeline = {
      sessionId: 's1',
      startedAtEpochMs: 0,
      devices: [buildDeviceTimeline('serial-A', 'A', buildCycleSamples())],
      events: cycleEvents,
      logs: [],
    };
    const result = analyzeFlows({ timeline, devices: [DEVICE_A] });
    const analysis = result.perDevice[0]!;

    expect(analysis.cycleCount).toBe(3);
    expect(analysis.meanRecoveryDeltaBytes).toBeGreaterThan(100 * MB);
    expect(analysis.baselineSlopeBytesPerCycle / MB).toBeCloseTo(150, -1);
    expect(analysis.baselineSlopeR2).toBeGreaterThan(0.95);
  });

  it('raises both a recovery-failure and a baseline-climb finding', () => {
    const timeline = {
      sessionId: 's1',
      startedAtEpochMs: 0,
      devices: [buildDeviceTimeline('serial-A', 'A', buildCycleSamples())],
      events: cycleEvents,
      logs: [],
    };
    const ids = analyzeFlows({ timeline, devices: [DEVICE_A] }).findings.map((f) => f.ruleId);
    expect(ids).toContain('LIVE.RECOVERY_FAILURE');
    expect(ids).toContain('LIVE.BASELINE_CLIMB');
  });

  it('measures memory retained after a screen is closed', () => {
    const events = [
      marker(0, 'main_menu', 'Main Menu'),
      marker(10_000, 'shop', 'Shop'),
      marker(30_000, 'screen_close', 'Close Screen'),
    ];
    const samples: MemorySample[] = [];
    for (let t = 0; t <= 45_000; t += 1000) {
      let value = 500 * MB;
      if (t >= 10_000 && t < 30_000) value = 720 * MB; // shop open
      else if (t >= 30_000) value = 680 * MB; // 180 MB never released
      samples.push(sample(t, value));
    }

    const result = analyzeFlows({
      timeline: {
        sessionId: 's1',
        startedAtEpochMs: 0,
        devices: [buildDeviceTimeline('serial-A', 'A', samples)],
        events,
        logs: [],
      },
      devices: [DEVICE_A],
    });

    const shopVisit = result.screenVisits.find((v) => v.screen === 'Shop');
    expect(shopVisit).toBeDefined();
    expect(shopVisit!.retainedBytes! / MB).toBeCloseTo(180, -1);

    const finding = result.findings.find((f) => f.ruleId === 'LIVE.SCREEN_RETENTION');
    expect(finding?.title).toContain('Shop');
  });
});

// ---------------------------------------------------------------------------
// Scoring and correlation
// ---------------------------------------------------------------------------

function finding(overrides: Partial<Finding>): Finding {
  return {
    ruleId: 'TEST.RULE',
    id: `f_${Math.random().toString(16).slice(2, 10)}`,
    source: 'static',
    title: 'Test finding',
    description: 'desc',
    severity: 'medium',
    confidence: 0.8,
    recommendation: 'do something about it in a reasonably long sentence',
    evidence: [],
    tags: [],
    ...overrides,
  };
}

describe('scoring', () => {
  it('does not average: many trivial findings never outrank one critical', () => {
    const manyLow = Array.from({ length: 30 }, () =>
      finding({ severity: 'low', confidence: 0.6 }),
    );
    const oneCritical = [finding({ severity: 'critical', confidence: 0.95 })];

    const lowScore = scoreFindings(manyLow, 45).value;
    const criticalScore = scoreFindings(oneCritical, 22).value;
    expect(criticalScore).toBeGreaterThan(lowScore);
  });

  it('saturates rather than growing without bound', () => {
    const huge = Array.from({ length: 200 }, () =>
      finding({ severity: 'critical', confidence: 1 }),
    );
    expect(scoreFindings(huge, 22).value).toBeLessThanOrEqual(100);
  });

  it('weights measured evidence above predicted evidence', () => {
    const result = score({
      staticFindings: [finding({ severity: 'low', confidence: 0.5 })],
      liveFindings: [finding({ source: 'live', severity: 'critical', confidence: 0.98 })],
      correlatedFindings: [],
      context: {
        hasRepository: true,
        hasApk: true,
        hasMetaFiles: true,
        liveSessionRan: true,
        deviceCount: 2,
        sessionDurationMs: 300_000,
        cycleCount: 3,
        markerCount: 12,
      },
    });
    expect(result.combinedRisk.value).toBeGreaterThanOrEqual(result.liveRisk.value * 0.9);
    expect(result.combinedRisk.band).toBe('critical');
  });

  it('discounts a static-only run and says so in the headline', () => {
    const result = score({
      staticFindings: [finding({ severity: 'critical', confidence: 0.9 })],
      liveFindings: [],
      correlatedFindings: [],
      context: {
        hasRepository: true,
        hasApk: false,
        hasMetaFiles: true,
        liveSessionRan: false,
        deviceCount: 0,
        sessionDurationMs: 0,
        cycleCount: 0,
        markerCount: 0,
      },
    });
    expect(result.headline).toContain('static analysis only');
    expect(result.confidence.value).toBeLessThan(0.6);
    expect(result.confidence.caveats.length).toBeGreaterThan(0);
  });

  it('leads with a process kill when one occurred', () => {
    const result = score({
      staticFindings: [],
      liveFindings: [finding({ source: 'live', severity: 'critical', confidence: 0.98 })],
      correlatedFindings: [],
      context: {
        hasRepository: true,
        hasApk: true,
        hasMetaFiles: true,
        liveSessionRan: true,
        deviceCount: 2,
        sessionDurationMs: 300_000,
        cycleCount: 3,
        markerCount: 10,
      },
      devices: [
        {
          serial: 'serial-A',
          role: 'A',
          model: 'Budget Phone',
          totalRamBytes: 4 * 1024 * MB,
          peakBytes: 900 * MB,
          peakRamFraction: 0.22,
          processDeaths: 1,
          osKills: 1,
        },
      ],
    });
    expect(result.headline).toContain('terminated by the OS');
    expect(result.headline).toContain('Budget Phone');
  });

  it('ranks a correlated finding above an equally severe static one', () => {
    const ranked = prioritize([
      finding({ source: 'static', severity: 'high', confidence: 0.8, title: 'static one' }),
      finding({ source: 'correlated', severity: 'high', confidence: 0.8, title: 'correlated one' }),
    ]);
    expect(ranked[0]?.finding.title).toBe('correlated one');
  });
});

describe('correlation', () => {
  it('joins a runtime shop retention finding to the shop assets that explain it', () => {
    const live = finding({
      ruleId: 'LIVE.SCREEN_RETENTION',
      source: 'live',
      severity: 'high',
      confidence: 0.85,
      title: 'Shop keeps 180 MB after being closed',
      subject: 'Shop',
      tags: ['retention', 'screen', 'screen:shop'],
      estimatedBytes: 180 * MB,
    });
    const staticFinding = finding({
      ruleId: 'UNITY.TEXTURE.OVERSIZED',
      severity: 'high',
      confidence: 0.8,
      title: 'Texture shop_banner.png costs about 64 MB',
      subject: 'Assets/UI/Shop/shop_banner.png',
      evidence: [{ kind: 'asset', summary: 'shop banner', path: 'Assets/UI/Shop/shop_banner.png' }],
      estimatedBytes: 64 * MB,
    });

    const result = correlate({ staticFindings: [staticFinding], liveFindings: [live] });

    expect(result.correlated).toHaveLength(1);
    expect(result.links[0]?.reason).toContain('shop');
    // Agreement between an independent prediction and a measurement is
    // stronger than either alone.
    expect(result.correlated[0]!.confidence).toBeGreaterThan(live.confidence);
    expect(result.correlated[0]!.source).toBe('correlated');
    expect(result.consumedLiveIds.has(live.id)).toBe(true);
  });

  it('joins retention at runtime to a lifetime bug in code', () => {
    const live = finding({
      ruleId: 'LIVE.BASELINE_CLIMB',
      source: 'live',
      severity: 'critical',
      confidence: 0.9,
      title: 'Each repeat starts 150 MB higher',
      subject: 'baseline climb',
      tags: ['retention', 'leak'],
    });
    const staticFinding = finding({
      ruleId: 'CODE.ADDRESSABLES_LIFETIME',
      severity: 'critical',
      confidence: 0.9,
      title: 'Addressables loaded without release',
      subject: 'addressables lifetime',
    });

    const result = correlate({ staticFindings: [staticFinding], liveFindings: [live] });
    expect(result.correlated).toHaveLength(1);
    expect(result.correlated[0]!.recommendation).toContain('Addressables');
  });

  it('does not invent a link when nothing plausibly matches', () => {
    const live = finding({
      ruleId: 'LIVE.SPIKE',
      source: 'live',
      severity: 'medium',
      title: 'Memory spike of 400 MB',
      subject: 'unknown state',
      estimatedBytes: 400 * MB,
      tags: ['spike'],
    });
    const staticFinding = finding({
      ruleId: 'BUILD.LARGE_HEAP',
      severity: 'low',
      title: 'largeHeap requested',
      subject: 'manifest',
    });

    const result = correlate({ staticFindings: [staticFinding], liveFindings: [live] });
    expect(result.correlated).toHaveLength(0);
  });
});
