/**
 * Session comparison tests.
 *
 * The failure this code exists to prevent is a confident-looking comparison of
 * two things that are not comparable, so most of these assert that the tool
 * *declines* rather than that it produces a number.
 */
import { describe, expect, it } from 'vitest';

import {
  compareSessions,
  deriveNoiseFloor,
  gateComparison,
  isConclusive,
  joinCycles,
  joinScreens,
} from '../src/analysis/compareSessions.js';
import type { AnalysisReport } from '../src/report/model.js';

const MB = 1024 * 1024;

interface RunSpec {
  id?: string;
  fps?: number;
  lowFps?: number;
  peakC?: number;
  riseC?: number;
  drainPerHour?: number | null;
  chargingNote?: string;
  risk?: number;
  version?: string;
  serial?: string;
  model?: string;
  ram?: number;
  android?: string;
  sdk?: number;
  packageName?: string;
  peak?: number;
  kills?: number;
  budget?: 'green' | 'yellow' | 'red';
  /** screen -> retained bytes */
  screens?: Record<string, number>;
  /** marker label -> recovery delta */
  cycles?: Record<string, number>;
}

/** A report with only the fields the comparison reads. */
function run(spec: RunSpec = {}): AnalysisReport {
  const {
    id = 'a1',
    version = '1.0.0',
    serial = 'R5CT10',
    model = 'SM-A346E',
    ram = 7.29 * 1024 * MB,
    android = '14',
    sdk = 34,
    packageName = 'com.gdm.prison.guard',
    peak = 1200 * MB,
    kills = 0,
    budget = 'yellow',
    screens = {},
    cycles = {},
    fps = 58,
    lowFps = 41,
    peakC = 39,
    riseC = 7,
    drainPerHour = 12,
    chargingNote,
    risk = 40,
  } = spec;

  return {
    analysisId: id,
    subject: { gameName: 'Prison Guard', packageName, versionName: version },
    generatedAt: '2026-09-01T10:00:00.000Z',
    devices: [
      {
        serial,
        role: 'A',
        model,
        manufacturer: 'samsung',
        androidVersion: android,
        sdkInt: sdk,
        totalRamBytes: ram,
        abi: 'arm64-v8a',
        peakBytes: peak,
        processDeaths: kills,
        budget: { verdict: budget },
        fps: { averageFps: fps, lowPercentileFps: lowFps, minFps: lowFps, sampleCount: 60,
               jankPercent: 3.1, worstFrameMs: 48, source: 'surfaceflinger' },
        thermal: { startC: peakC - riseC, peakC, riseC, hottestZone: 'gpuss-0',
                   worstStatus: 'light', throttlingMs: 0, verdict: 'warm' },
        battery: { startPercent: 80, endPercent: 78, drainPercent: 2,
                   drainPercentPerHour: drainPerHour, drainMah: 90,
                   wasCharging: Boolean(chargingNote),
                   unavailableReason: chargingNote ?? null },
      },
    ],
    session: {
      durationMs: 600_000,
      markerCount: Object.keys(screens).length,
      screenVisits: Object.entries(screens).map(([screen, retainedBytes]) => ({
        screen,
        role: 'A',
        retainedBytes,
        peakBytes: retainedBytes + 400 * MB,
      })),
      cycles: Object.entries(cycles).map(([label, recoveryDeltaBytes], index) => ({
        label,
        index,
        role: 'A',
        recoveryDeltaBytes,
      })),
    },
    verdict: {
      headline: 'x',
      budgetVerdict: budget,
      combinedRisk: { value: risk, band: 'moderate', contributors: [] },
      staticRisk: { value: 10, band: 'low', contributors: [] },
      liveRisk: { value: risk, band: 'moderate', contributors: [] },
      confidence: { value: 0.7, factors: [], caveats: [] },
    },
  } as unknown as AnalysisReport;
}

describe('gating', () => {
  it('blocks two different apps', () => {
    const gates = gateComparison(run(), run({ packageName: 'com.other.game' }));
    expect(gates.find((g) => g.key === 'package')?.level).toBe('block');
  });

  it('blocks different hardware, because the accounting differs', () => {
    // Adreno and Mali attribute GPU memory differently and the budget tier
    // changes with RAM, so these numbers are not commensurable.
    const gates = gateComparison(run(), run({ model: 'Pixel 4a', ram: 5.7 * 1024 * MB }));
    const device = gates.find((g) => g.key === 'device');

    expect(device?.level).toBe('block');
    expect(device?.message).toMatch(/not commensurable/);
  });

  it('warns rather than blocks on a second handset of the same model', () => {
    const gates = gateComparison(run({ serial: 'R5CT10' }), run({ serial: 'R5CT99' }));
    expect(gates.find((g) => g.key === 'device')?.level).toBe('warn');
  });

  it('warns when Android versions differ', () => {
    const gates = gateComparison(run({ android: '13', sdk: 33 }), run({ android: '14', sdk: 34 }));
    expect(gates.find((g) => g.key === 'android')?.level).toBe('warn');
  });

  it('treats a different build as the point, not a problem', () => {
    const gates = gateComparison(run({ version: '1.0.0' }), run({ version: '1.1.0' }));
    const build = gates.find((g) => g.key === 'build');

    expect(build?.level).toBe('note');
    expect(build?.message).toContain('1.1.0');
  });

  it('points out that a same-build pair can serve as a baseline', () => {
    const gates = gateComparison(run({ version: '1.0.0' }), run({ version: '1.0.0' }));
    expect(gates.find((g) => g.key === 'build')?.message).toMatch(/noise-floor baseline/);
  });

  it('blocks when a run has no device at all', () => {
    const noDevice = { ...run(), devices: [] } as AnalysisReport;
    expect(gateComparison(noDevice, run()).some((g) => g.level === 'block')).toBe(true);
  });
});

describe('joining on markers', () => {
  it('pairs screens by name, not by position', () => {
    // The tester visited them in a different order the second time, which must
    // not shift the pairing.
    const a = run({ screens: { Shop: 100 * MB, Level1: 20 * MB } });
    const b = run({ screens: { Level1: 25 * MB, Shop: 40 * MB } });

    const rows = joinScreens(a, b);
    const shop = rows.find((r) => r.screen === 'Shop')!;

    expect(shop.beforeRetained).toBe(100 * MB);
    expect(shop.afterRetained).toBe(40 * MB);
    expect(rows.every((r) => r.presence === 'both')).toBe(true);
  });

  it('marks a screen only one run visited', () => {
    const rows = joinScreens(run({ screens: { Shop: 10 * MB } }), run({ screens: { Boss: 90 * MB } }));

    expect(rows.find((r) => r.screen === 'Shop')?.presence).toBe('before-only');
    expect(rows.find((r) => r.screen === 'Boss')?.presence).toBe('after-only');
  });

  it('keeps the worst visit when a screen was entered twice', () => {
    // A screen that leaked once leaks, so the worst case is the honest figure.
    const a = { ...run() } as AnalysisReport;
    (a.session as { screenVisits: unknown[] }).screenVisits = [
      { screen: 'Shop', role: 'A', retainedBytes: 10 * MB, peakBytes: 400 * MB },
      { screen: 'Shop', role: 'A', retainedBytes: 180 * MB, peakBytes: 600 * MB },
    ];

    expect(joinScreens(a, run({ screens: { Shop: 20 * MB } }))[0]!.beforeRetained).toBe(180 * MB);
  });

  it('joins marker cycles the same way', () => {
    const rows = joinCycles(
      run({ cycles: { 'shop loop': 50 * MB } }),
      run({ cycles: { 'shop loop': 5 * MB } }),
    );
    expect(rows[0]).toMatchObject({ beforeRecovery: 50 * MB, afterRecovery: 5 * MB, presence: 'both' });
  });
});

describe('noise floor', () => {
  it('measures the floor from two runs of the same build', () => {
    // Whatever two identical builds disagree about is variance by definition.
    const floor = deriveNoiseFloor(
      run({ screens: { Shop: 100 * MB, Level1: 50 * MB } }),
      run({ screens: { Shop: 108 * MB, Level1: 47 * MB } }),
    )!;

    expect(floor.bytes).toBe(8 * MB);
    expect(floor.fraction).toBeCloseTo(0.08, 2);
    expect(floor.source).toMatch(/two runs of the same build/);
  });

  it('returns nothing when the pair shares no screen', () => {
    expect(deriveNoiseFloor(run({ screens: { A: 1 } }), run({ screens: { B: 1 } }))).toBeNull();
  });

  it('calls a change smaller than the floor inconclusive', () => {
    const floor = { bytes: 10 * MB, fraction: 0.1, source: 'test' };

    expect(isConclusive(100 * MB, 105 * MB, floor)).toBe(false);
    expect(isConclusive(100 * MB, 130 * MB, floor)).toBe(true);
    // Relative and absolute are both escapes: a small absolute change on a small
    // base is still a large relative one.
    expect(isConclusive(20 * MB, 25 * MB, floor)).toBe(true);
  });

  it('reports everything when no floor is established', () => {
    expect(isConclusive(100 * MB, 101 * MB, null)).toBe(true);
  });
});

describe('comparing', () => {
  const floor = { bytes: 10 * MB, fraction: 0.1, source: 'test' };

  it('calls more retention a regression', () => {
    // Retention rising means more stayed behind after leaving the screen.
    const result = compareSessions(
      run({ screens: { Shop: 20 * MB } }),
      run({ screens: { Shop: 180 * MB } }),
      { noiseFloor: floor },
    );

    expect(result.screens[0]!.direction).toBe('regressed');
    expect(result.screens[0]!.deltaBytes).toBe(160 * MB);
    expect(result.headline).toContain('Shop');
  });

  it('calls less retention an improvement', () => {
    const result = compareSessions(
      run({ screens: { Shop: 180 * MB } }),
      run({ screens: { Shop: 20 * MB } }),
      { noiseFloor: floor },
    );

    expect(result.screens[0]!.direction).toBe('improved');
    expect(result.headline).toMatch(/none got worse/);
  });

  it('refuses to compare peaks when the runs covered different ground', () => {
    // The whole trap: a longer playthrough peaks higher, and that is the tester
    // rather than the build.
    const result = compareSessions(
      run({ screens: { Shop: 10 * MB }, peak: 900 * MB }),
      run({ screens: { Shop: 10 * MB, Boss: 10 * MB }, peak: 1400 * MB }),
      { noiseFloor: floor },
    );

    expect(result.peak.direction).toBe('unknown');
    expect(result.peak.note).toMatch(/different playthroughs rather than different builds/);
  });

  it('compares peaks when both runs covered the same screens', () => {
    const result = compareSessions(
      run({ screens: { Shop: 10 * MB }, peak: 900 * MB }),
      run({ screens: { Shop: 10 * MB }, peak: 1400 * MB }),
      { noiseFloor: floor },
    );

    expect(result.peak.direction).toBe('regressed');
    expect(result.peak.note).toMatch(/same workload/);
  });

  it('treats a process kill as decisive, above any screen change', () => {
    // A kill is binary and is the outcome the whole tool is about.
    const result = compareSessions(
      run({ screens: { Shop: 100 * MB }, kills: 0 }),
      run({ screens: { Shop: 10 * MB }, kills: 1 }),
      { noiseFloor: floor },
    );

    expect(result.kills.direction).toBe('regressed');
    expect(result.headline).toMatch(/killed by the OS/);
  });

  it('never applies the noise floor to a kill count', () => {
    const result = compareSessions(run({ kills: 0 }), run({ kills: 1 }), { noiseFloor: floor });
    expect(result.kills.direction).toBe('regressed');
  });

  it('reports a budget verdict moving the right way', () => {
    expect(
      compareSessions(run({ budget: 'red' }), run({ budget: 'green' })).budget.direction,
    ).toBe('improved');
    expect(
      compareSessions(run({ budget: 'green' }), run({ budget: 'red' })).budget.direction,
    ).toBe('regressed');
  });

  it('says so when the two runs share no screens', () => {
    const result = compareSessions(run({ screens: { A: 1 } }), run({ screens: { B: 1 } }));

    expect(result.markerOverlap).toEqual({ shared: 0, beforeOnly: 1, afterOnly: 1 });
    expect(result.headline).toMatch(/share no screens/);
    expect(result.headline).toMatch(/repeat mode/);
  });

  it('reports coverage so the reader knows what the comparison covered', () => {
    const result = compareSessions(
      run({ screens: { Shop: 1, Level1: 1 } }),
      run({ screens: { Shop: 1, Boss: 1 } }),
    );
    expect(result.markerOverlap).toEqual({ shared: 1, beforeOnly: 1, afterOnly: 1 });
  });

  it('blocks and says why, rather than producing numbers', () => {
    const result = compareSessions(run(), run({ model: 'Pixel 4a', ram: 5.7 * 1024 * MB }));

    expect(result.blocked).toBe(true);
    expect(result.headline).toMatch(/Different hardware/);
  });

  it('admits when no floor is established', () => {
    const result = compareSessions(
      run({ screens: { Shop: 100 * MB } }),
      run({ screens: { Shop: 100 * MB } }),
    );
    expect(result.headline).toMatch(/No noise floor is established/);
  });

  it('marks a sub-floor change inconclusive rather than as a change', () => {
    const result = compareSessions(
      run({ screens: { Shop: 100 * MB } }),
      run({ screens: { Shop: 104 * MB } }),
      { noiseFloor: floor },
    );

    expect(result.screens[0]!.direction).toBe('inconclusive');
    expect(result.headline).toMatch(/No change larger than the measured run-to-run variance/);
  });

  it('never invents a direction for a screen only one run visited', () => {
    const result = compareSessions(run({ screens: { Shop: 10 * MB } }), run({ screens: {} }));
    const shop = result.screens.find((s) => s.label === 'Shop')!;

    expect(shop.direction).toBe('unknown');
    expect(shop.deltaBytes).toBeNull();
    expect(shop.note).toMatch(/nothing to compare it with/);
  });
});

describe('frame rate, heat, battery and risk', () => {
  const find = (rows: Array<{ label: string }>, needle: string) =>
    rows.find((r) => r.label.includes(needle))!;

  it('more frames per second is an improvement', () => {
    // Direction is per-metric: higher is better here, worse for temperature.
    const c = compareSessions(
      run({ fps: 34, screens: { Shop: 10 * MB } }),
      run({ fps: 57, screens: { Shop: 10 * MB } }),
    );

    expect(find(c.runtime, 'Average frame rate')).toMatchObject({
      before: 34,
      after: 57,
      deltaBytes: 23,
      direction: 'improved',
    });
  });

  it('a hotter device is a regression', () => {
    const c = compareSessions(
      run({ peakC: 38, riseC: 6, screens: { Shop: 10 * MB } }),
      run({ peakC: 47, riseC: 15, screens: { Shop: 10 * MB } }),
    );

    expect(find(c.runtime, 'Peak temperature').direction).toBe('regressed');
    expect(find(c.runtime, 'Temperature rise').deltaBytes).toBe(9);
  });

  it('a lower risk score is an improvement', () => {
    const c = compareSessions(
      run({ risk: 72, screens: { Shop: 10 * MB } }),
      run({ risk: 31, screens: { Shop: 10 * MB } }),
    );
    expect(find(c.runtime, 'Combined risk score').direction).toBe('improved');
  });

  it('carries through why battery drain is missing', () => {
    // A charging device has no drain, and the reason has to survive into the
    // comparison rather than being replaced by a zero.
    const c = compareSessions(
      run({ screens: { Shop: 10 * MB } }),
      run({ drainPerHour: null, chargingNote: 'The device was charging over USB.', screens: { Shop: 10 * MB } }),
    );

    const battery = find(c.runtime, 'Battery used');
    expect(battery.after).toBeNull();
    expect(battery.direction).toBe('unknown');
    expect(battery.note).toMatch(/charging over USB/);
  });

  it('states the workload caveat once, not on every row', () => {
    // It applies identically to every whole-session figure. Repeating it under a
    // dozen rows made the table unreadable, which is worse than a caveat a
    // reader might skip.
    const c = compareSessions(
      run({ screens: { Shop: 10 * MB } }),
      run({ screens: { Shop: 10 * MB, Boss: 20 * MB } }),
    );

    expect(c.runtimeCaveat).toMatch(/playthrough rather than the build/);
    // And no row repeats it.
    expect(c.runtime.filter((r) => r.note?.includes('playthrough rather than'))).toHaveLength(0);
  });

  it('raises no caveat when both runs covered the same screens', () => {
    const c = compareSessions(
      run({ screens: { Shop: 10 * MB } }),
      run({ screens: { Shop: 10 * MB } }),
    );

    expect(c.runtimeCaveat).toBeNull();
    expect(find(c.runtime, 'Average frame rate').note).toBeUndefined();
  });

  it('reports device details for both runs, for a reader who was not there', () => {
    const c = compareSessions(run(), run());
    expect(c.before.deviceRamBytes).toBeGreaterThan(0);
    expect(c.after.abi).toBe('arm64-v8a');
  });
});

describe('frame rate against each run own target', () => {
  const find = (rows: Array<{ label: string }>, needle: string) =>
    rows.find((r) => r.label.includes(needle))!;

  it('warns rather than subtracting when the two targets differ', () => {
    // The case that prompted this: one run capped at 30, the next at 60.
    // Subtracting the measured rates would report a 30 fps regression where the
    // build simply changed what it was aiming for.
    const c = compareSessions(
      run({ fps: 29.5, screens: { Shop: 10 * MB } }),
      run({ fps: 59.4, screens: { Shop: 10 * MB } }),
      { targetFps: { before: 30, after: 60 } },
    );

    const gate = c.gates.find((g) => g.key === 'targetFps')!;
    expect(gate.level).toBe('warn');
    expect(gate.message).toContain('30 fps and 60 fps');
    expect(find(c.runtime, 'Average frame rate').note).toMatch(/Not comparable directly/);
  });

  it('compares each run against what it was aiming for', () => {
    // 29.5 of 30 is 98%; 59.4 of 60 is 99%. Both builds are doing their job, and
    // the raw 30 fps difference between them means nothing.
    const c = compareSessions(
      run({ fps: 29.5, screens: { Shop: 10 * MB } }),
      run({ fps: 59.4, screens: { Shop: 10 * MB } }),
      { targetFps: { before: 30, after: 60 } },
    );

    const achieved = find(c.runtime, 'against its own target');
    expect(achieved.before).toBe(98);
    expect(achieved.after).toBe(99);
    expect(achieved.direction).toBe('improved');
  });

  it('treats falling short of the target as a regression', () => {
    const c = compareSessions(
      run({ fps: 59, screens: { Shop: 10 * MB } }),
      run({ fps: 41, screens: { Shop: 10 * MB } }),
      { targetFps: { before: 60, after: 60 } },
    );

    expect(find(c.runtime, 'against its own target').direction).toBe('regressed');
  });

  it('treats overshooting a cap as a regression too', () => {
    // A 30-capped build running at 60 is not twice as good: the cap is not
    // applying, and it costs battery and heat for frames nobody asked for.
    const c = compareSessions(
      run({ fps: 30, screens: { Shop: 10 * MB } }),
      run({ fps: 60, screens: { Shop: 10 * MB } }),
      { targetFps: { before: 30, after: 30 } },
    );

    const achieved = find(c.runtime, 'against its own target');
    expect(achieved.after).toBe(200);
    expect(achieved.direction).toBe('regressed');
  });

  it('records the targets as supplied, not as measured', () => {
    const c = compareSessions(run(), run(), { targetFps: { before: 30, after: 60 } });
    const target = find(c.runtime, 'Target frame rate');

    expect(target).toMatchObject({ before: 30, after: 60, direction: 'unknown' });
    expect(target.note).toMatch(/supplied by the operator - not measured/);
  });

  it('asks nothing and adds nothing when no target is given', () => {
    // The comparison still works; it just cannot judge against an intent it was
    // never told about.
    const c = compareSessions(run(), run());

    expect(c.runtime.some((r) => r.label.includes('Target frame rate'))).toBe(false);
    expect(c.runtime.some((r) => r.label.includes('against its own target'))).toBe(false);
    expect(c.gates.some((g) => g.key === 'targetFps')).toBe(false);
  });

  it('does not warn when both runs aimed at the same rate', () => {
    const c = compareSessions(run(), run(), { targetFps: { before: 60, after: 60 } });

    expect(c.gates.some((g) => g.key === 'targetFps')).toBe(false);
    // Same target, so the raw rate is comparable and carries no disclaimer.
    expect(find(c.runtime, 'Average frame rate').note).toBeUndefined();
  });
});
