/**
 * Frame rate, thermal and battery tests.
 *
 * Two properties matter more than the arithmetic. First, a placeholder must
 * never become a measurement: SurfaceFlinger fills unused rows with 0 and
 * pending ones with INT64_MAX, and treating either as a timestamp would
 * manufacture an enormous frame interval. Second, a charging device has no drain
 * to measure, and the summary has to say so rather than report a number.
 */
import { describe, expect, it } from 'vitest';

import {
  parseBatteryDump,
  parseThermalStatus,
  parseThermalZones,
  summarizeBattery,
  summarizeFps,
  summarizeThermal,
  type HealthSample,
} from '../src/telemetry/deviceHealth.js';
import {
  layerBelongsTo,
  parseGfxInfo,
  parseSurfaceFlingerLatency,
  parseDisplayHz,
  parseTimeStats,
  pickGameLayer,
} from '../src/telemetry/fps.js';

// ---------------------------------------------------------------------------
// Frame rate
// ---------------------------------------------------------------------------

/** 60 Hz worth of frame timestamps, in the three-column layout SF emits. */
function latency(intervalsNs: number[], refreshNs = 16_666_666): string {
  let t = 1_000_000_000;
  const rows = [String(refreshNs)];
  rows.push(`${t} ${t} ${t}`);
  for (const gap of intervalsNs) {
    t += gap;
    rows.push(`${t} ${t} ${t}`);
  }
  return rows.join('\n');
}

describe('SurfaceFlinger frame timing', () => {
  it('derives 60 fps from 16.67 ms intervals', () => {
    const text = latency(new Array(59).fill(16_666_666));
    const reading = parseSurfaceFlingerLatency(text)!;

    expect(reading.fps).toBeCloseTo(60, 0);
    expect(reading.frameCount).toBe(60);
    expect(reading.source).toBe('surfaceflinger');
    expect(reading.jankPercent).toBe(0);
  });

  it('derives 30 fps from doubled intervals', () => {
    const reading = parseSurfaceFlingerLatency(latency(new Array(29).fill(33_333_333)))!;
    expect(reading.fps).toBeCloseTo(30, 0);
  });

  it('ignores unfilled and pending rows rather than treating them as times', () => {
    // This is the bug worth guarding: a 0 or INT64_MAX read as a timestamp turns
    // one window into a multi-second frame and destroys the average.
    const text = [
      '16666666',
      '1000000000 1000000000 1000000000',
      '0 0 0',
      '1016666666 1016666666 1016666666',
      '9223372036854775807 9223372036854775807 9223372036854775807',
      '1033333332 1033333332 1033333332',
    ].join('\n');

    const reading = parseSurfaceFlingerLatency(text)!;
    expect(reading.frameCount).toBe(3);
    expect(reading.fps).toBeCloseTo(60, 0);
  });

  it('counts a stall as jank against the panel’s own refresh rate', () => {
    // A 120 Hz panel has a different frame budget, so jank is relative to it.
    const text = latency([8_333_333, 8_333_333, 50_000_000, 8_333_333], 8_333_333);
    const reading = parseSurfaceFlingerLatency(text)!;

    expect(reading.jankPercent).toBe(25);
    expect(reading.worstFrameMs).toBeCloseTo(50, 0);
  });

  it('returns nothing for output it cannot use', () => {
    expect(parseSurfaceFlingerLatency('')).toBeNull();
    expect(parseSurfaceFlingerLatency('16666666')).toBeNull();
    // A single frame bounds no interval.
    expect(parseSurfaceFlingerLatency('16666666\n1000 1000 1000')).toBeNull();
    // Some vendors keep the command but return a zero refresh period.
    expect(parseSurfaceFlingerLatency('0\n1 1 1\n2 2 2')).toBeNull();
  });
});

describe('picking the game’s compositor layer', () => {
  const listing = [
    'Dim Layer#0',
    'com.gdm.prison.guard/com.unity3d.player.UnityPlayerActivity#0',
    'SurfaceView[com.gdm.prison.guard/com.unity3d.player.UnityPlayerActivity]#0',
    'StatusBar#0',
  ].join('\n');

  it('prefers the SurfaceView, which is what Unity presents into', () => {
    expect(pickGameLayer(listing, 'com.gdm.prison.guard')).toContain('SurfaceView');
  });

  it('falls back to the activity window when there is no SurfaceView', () => {
    const noSurfaceView = 'com.gdm.prison.guard/com.unity3d.player.UnityPlayerActivity#0';
    expect(pickGameLayer(noSurfaceView, 'com.gdm.prison.guard')).toContain('UnityPlayerActivity');
  });

  it('never picks a layer that carries no frames', () => {
    // A dim layer belongs to the app but presents nothing.
    expect(pickGameLayer('Dim Layer#com.gdm.prison.guard', 'com.gdm.prison.guard')).toBeNull();
  });

  it('returns nothing when the app has no layer', () => {
    expect(pickGameLayer(listing, 'com.other.game')).toBeNull();
  });
});

describe('gfxinfo counters', () => {
  it('reads the cumulative frame counters', () => {
    const text = [
      'Applications Graphics Acceleration Info:',
      'Total frames rendered: 4821',
      'Janky frames: 219 (4.54%)',
      '50th percentile: 8ms',
    ].join('\n');

    expect(parseGfxInfo(text)).toEqual({ totalFrames: 4821, jankyFrames: 219 });
  });

  it('returns nothing when the app draws no HWUI frames', () => {
    // The normal Unity case: gfxinfo simply cannot see the game's surface.
    expect(parseGfxInfo('** Graphics info for pid 9241 **')).toBeNull();
  });
});

describe('frame rate summary', () => {
  it('averages over time, so a stall counts for as long as it lasted', () => {
    // Two windows: 120 frames across 2 s, then a stall of 4 frames in 0.4 s.
    const summary = summarizeFps([
      { fps: 60, frameCount: 120, windowMs: 2000, jankPercent: 0, worstFrameMs: 17, source: 'surfaceflinger' },
      { fps: 10, frameCount: 4, windowMs: 400, jankPercent: 75, worstFrameMs: 300, source: 'surfaceflinger' },
    ]);

    // 124 frames over 2.4 s of measured time.
    expect(summary.averageFps).toBeCloseTo(51.7, 1);
    // Weighting each window by its own frame count instead gave 58.4 - the fast
    // window got more say precisely because it was fast, which is the same thing
    // as discounting the stall. On a real session that read 41.0 fps where the
    // true average was 38.6.
    expect(summary.averageFps).toBeLessThan(58.4);
    // The stall still shows, in the figures meant to carry it.
    expect(summary.minFps).toBe(10);
    expect(summary.worstFrameMs).toBe(300);
  });

  it('falls back to the mean of the samples when no window reported its length', () => {
    // Nothing to divide by, and with equal-length windows the mean of the rates
    // is the same answer anyway.
    const summary = summarizeFps([
      { fps: 60, frameCount: 60, jankPercent: 0, worstFrameMs: 17, source: 'surfaceflinger' },
      { fps: 30, frameCount: 30, jankPercent: 0, worstFrameMs: 34, source: 'surfaceflinger' },
    ]);

    expect(summary.averageFps).toBeCloseTo(45, 1);
  });

  it('reports nothing rather than zero when frame rate was never measured', () => {
    const summary = summarizeFps([]);
    expect(summary.averageFps).toBeNull();
    expect(summary.source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Thermal
// ---------------------------------------------------------------------------

describe('battery dump', () => {
  it('reads level, charging state and temperature', () => {
    const text = [
      'Current Battery Service state:',
      '  AC powered: false',
      '  USB powered: true',
      '  Wireless powered: false',
      '  level: 78',
      '  temperature: 351',
      '  voltage: 4012',
      '  Charge counter: 3120000',
    ].join('\n');

    expect(parseBatteryDump(text)).toEqual({
      levelPercent: 78,
      charging: true,
      temperatureC: 35.1,
      voltageMv: 4012,
      chargeCounterUah: 3_120_000,
    });
  });

  it('treats a wireless pad as charging too', () => {
    const text = ['  AC powered: false', '  USB powered: false', '  Wireless powered: true', '  level: 50'].join('\n');
    expect(parseBatteryDump(text).charging).toBe(true);
  });
});

describe('thermal state', () => {
  it('reads Android’s own thermal severity', () => {
    expect(parseThermalStatus('Thermal Status: 0')).toEqual({ status: 'none', throttling: false });
    expect(parseThermalStatus('Thermal Status: 2')).toEqual({ status: 'moderate', throttling: true });
    expect(parseThermalStatus('Thermal Status: 4')).toEqual({ status: 'critical', throttling: true });
  });

  it('reports "not measured" rather than "not hot" when absent', () => {
    // Older releases have no thermalservice, and the two claims are different.
    expect(parseThermalStatus('unknown service thermalservice')).toEqual({
      status: null,
      throttling: false,
    });
  });

  it('reads zones in millidegrees and in degrees', () => {
    const text = 'cpu-0-0|48200###gpuss-0|52100###battery|31.5###';
    expect(parseThermalZones(text)).toEqual({ maxZoneC: 52.1, maxZoneName: 'gpuss-0' });
  });

  it('discards sensor faults rather than reporting them as heat', () => {
    // A zone reading 0 or 300 °C is broken, not information.
    const text = 'cpu-0-0|38000###broken|0###alsoBroken|300000###';
    expect(parseThermalZones(text)).toEqual({ maxZoneC: 38, maxZoneName: 'cpu-0-0' });
  });

  it('returns nothing when no zone is readable', () => {
    expect(parseThermalZones('')).toEqual({ maxZoneC: null, maxZoneName: null });
  });
});

describe('thermal summary', () => {
  const sample = (elapsedMs: number, c: number, throttling = false): HealthSample => ({
    elapsedMs,
    thermal: {
      maxZoneC: c,
      maxZoneName: 'gpuss-0',
      status: throttling ? 'moderate' : 'none',
      throttling,
    },
  });

  it('reports the rise, which is what compares across sessions', () => {
    // Phones idle anywhere from 24 to 35 °C depending on ambient, so "rose 14
    // degrees" travels between sessions where "reached 41" does not.
    const summary = summarizeThermal([sample(0, 31), sample(60_000, 38), sample(120_000, 45)]);

    expect(summary.startC).toBe(31);
    expect(summary.peakC).toBe(45);
    expect(summary.riseC).toBe(14);
    expect(summary.verdict).toBe('hot');
  });

  it('measures throttling as a window rather than counting samples', () => {
    const summary = summarizeThermal([
      sample(0, 40),
      sample(30_000, 46, true),
      sample(60_000, 47, true),
    ]);

    expect(summary.throttlingMs).toBe(60_000);
    expect(summary.verdict).toBe('throttling');
    expect(summary.worstStatus).toBe('moderate');
  });

  it('calls a cool session cool', () => {
    expect(summarizeThermal([sample(0, 28), sample(60_000, 31)]).verdict).toBe('cool');
  });

  it('says unknown rather than cool when nothing was measured', () => {
    expect(summarizeThermal([]).verdict).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

describe('battery summary', () => {
  const reading = (level: number, charging: boolean, uah = 3_000_000) => ({
    levelPercent: level,
    charging,
    temperatureC: 33,
    voltageMv: 4000,
    chargeCounterUah: uah,
  });

  it('measures drain over a discharging session', () => {
    const summary = summarizeBattery(
      [
        { elapsedMs: 0, battery: reading(80, false, 3_200_000) },
        { elapsedMs: 1_800_000, battery: reading(74, false, 2_960_000) },
      ],
      1_800_000,
    );

    expect(summary.drainPercent).toBe(6);
    // Normalised, so a 4-minute session and a 40-minute one can be compared.
    expect(summary.drainPercentPerHour).toBe(12);
    expect(summary.drainMah).toBe(240);
    expect(summary.unavailableReason).toBeNull();
  });

  it('refuses to report drain for a session that was charging', () => {
    // Over USB adb this is the usual case, and a figure derived from a charging
    // device would look like a measurement and mean nothing.
    const summary = summarizeBattery(
      [
        { elapsedMs: 0, battery: reading(80, false) },
        { elapsedMs: 600_000, battery: reading(83, true) },
      ],
      600_000,
    );

    expect(summary.drainPercent).toBeNull();
    expect(summary.drainMah).toBeNull();
    expect(summary.wasCharging).toBe(true);
    expect(summary.unavailableReason).toMatch(/charging over USB/);
    // The levels are still reported - they are facts, just not a drain.
    expect(summary.startPercent).toBe(80);
    expect(summary.endPercent).toBe(83);
  });

  it('says so when battery state could not be read at all', () => {
    const summary = summarizeBattery([], 60_000);
    expect(summary.drainPercent).toBeNull();
    expect(summary.unavailableReason).toMatch(/could not be read/);
  });
});

describe('SurfaceFlinger TimeStats', () => {
  /** The shape `dumpsys SurfaceFlinger --timestats -dump` actually emits. */
  const dump = [
    'SurfaceFlinger TimeStats:',
    'Legacy stats are as follows:',
    'statsStart = 1725360000',
    'statsEnd = 1725360030',
    'totalFrames = 1800',
    'missedFrames = 12',
    'clientCompositionFrames = 0',
    'displayOnTime = 30000 ms',
    'Layer name: StatusBar#0',
    'totalFrames = 40',
    'droppedFrames = 0',
    'averageFPS = 1.330',
    'Layer name: SurfaceView[com.gdm.prison.guard/com.unity3d.player.UnityPlayerActivity]#0',
    'totalFrames = 892',
    'droppedFrames = 17',
    'averageFPS = 29.730',
    'present2present histogram is as follows:',
    '32ms=400 33ms=490',
  ].join('\n');

  it('reads per-layer frame stats', () => {
    const layers = parseTimeStats(dump);
    const game = layers.find((l) => layerBelongsTo(l.layer, 'com.gdm.prison.guard'))!;

    expect(game.totalFrames).toBe(892);
    expect(game.droppedFrames).toBe(17);
    expect(game.averageFps).toBe(29.73);
  });

  it('never reports the global total as the game’s frame rate', () => {
    // The global `totalFrames = 1800` counts every layer on the display,
    // including the status bar and the launcher.
    const layers = parseTimeStats(dump);
    expect(layers.every((l) => l.totalFrames !== 1800)).toBe(true);
    expect(layers).toHaveLength(2);
  });

  it('tells the game’s layer from every other one', () => {
    expect(layerBelongsTo('SurfaceView[com.gdm.prison.guard/x]#0', 'com.gdm.prison.guard')).toBe(true);
    expect(layerBelongsTo('StatusBar#0', 'com.gdm.prison.guard')).toBe(false);
    expect(layerBelongsTo('com.other.game/MainActivity#0', 'com.gdm.prison.guard')).toBe(false);
  });

  it('survives a build that omits averageFPS', () => {
    // Then the caller counts frames over the window instead, so the absence has
    // to be reported rather than defaulted to zero.
    const text = [
      'Layer name: SurfaceView[com.gdm.prison.guard/x]#0',
      'totalFrames = 300',
      'droppedFrames = 2',
    ].join('\n');

    const layer = parseTimeStats(text)[0]!;
    expect(layer.totalFrames).toBe(300);
    expect(layer.averageFps).toBeNull();
  });

  it('returns nothing for output with no layer sections', () => {
    expect(parseTimeStats('')).toEqual([]);
    expect(parseTimeStats('SurfaceFlinger TimeStats:\ntotalFrames = 5')).toEqual([]);
    // An unsupported option makes SurfaceFlinger print its usage instead.
    expect(parseTimeStats('usage: dumpsys SurfaceFlinger --timestats')).toEqual([]);
  });
});

describe('application frame rate, not the screen refresh rate', () => {
  /**
   * Measured on a Samsung SM-A366B running Android 16, with the game in the
   * foreground: it submitted 243 frames in 4.08 s (59.6 fps) and 482 in 8.07 s
   * (59.7 fps). SurfaceFlinger's own `averageFPS` field claimed 62.5 for the
   * same windows, because it is one over the mean gap between frames and every
   * gap lands in its whole-millisecond "16ms" bucket.
   *
   * So the count over a window we timed is what gets reported. The difference
   * looks small until it is the number a developer checks a frame cap against.
   */
  it('reports the rate the app produced, not the panel rate', () => {
    const summary = summarizeFps([
      { fps: 59.6, displayHz: 60, matchesDisplayRate: true, frameCount: 243,
        jankPercent: 0, worstFrameMs: null, source: 'timestats' },
    ]);

    expect(summary.averageFps).toBe(59.6);
    expect(summary.displayHz).toBe(60);
  });

  it('flags a game tracking the panel, which is a cap that is not applying', () => {
    // The actionable case: a project sets Application.targetFrameRate = 30 and
    // the game still runs at 60 because vSyncCount is non-zero.
    const summary = summarizeFps([
      { fps: 59.6, displayHz: 60, matchesDisplayRate: true, frameCount: 243, jankPercent: 0, worstFrameMs: null, source: 'timestats' },
      { fps: 59.7, displayHz: 60, matchesDisplayRate: true, frameCount: 482, jankPercent: 0, worstFrameMs: null, source: 'timestats' },
    ]);

    expect(summary.matchesDisplayRate).toBe(true);
  });

  it('does not flag a game that genuinely holds a lower rate', () => {
    const summary = summarizeFps([
      { fps: 30.1, displayHz: 60, matchesDisplayRate: false, frameCount: 120, jankPercent: 0, worstFrameMs: null, source: 'timestats' },
      { fps: 29.8, displayHz: 60, matchesDisplayRate: false, frameCount: 119, jankPercent: 0, worstFrameMs: null, source: 'timestats' },
    ]);

    expect(summary.averageFps).toBeCloseTo(30, 0);
    expect(summary.matchesDisplayRate).toBe(false);
  });

  it('needs most of the session at the panel rate, not one window', () => {
    // A single window at 60 during a loading screen is not the same claim as a
    // game that never left it.
    const readings = [
      { fps: 60, displayHz: 60, matchesDisplayRate: true, frameCount: 300, jankPercent: 0, worstFrameMs: null, source: 'timestats' },
      { fps: 30, displayHz: 60, matchesDisplayRate: false, frameCount: 150, jankPercent: 0, worstFrameMs: null, source: 'timestats' },
      { fps: 30, displayHz: 60, matchesDisplayRate: false, frameCount: 150, jankPercent: 0, worstFrameMs: null, source: 'timestats' },
      { fps: 30, displayHz: 60, matchesDisplayRate: false, frameCount: 150, jankPercent: 0, worstFrameMs: null, source: 'timestats' },
    ];

    expect(summarizeFps(readings).matchesDisplayRate).toBe(false);
  });

  it('says nothing about the panel when the source cannot report it', () => {
    // gfxinfo gives a count and nothing else; absent must not become false.
    const summary = summarizeFps([
      { fps: 42, displayHz: null, matchesDisplayRate: null, frameCount: 100, jankPercent: null, worstFrameMs: null, source: 'gfxinfo' },
    ]);

    expect(summary.displayHz).toBeNull();
    expect(summary.matchesDisplayRate).toBeNull();
  });
});

describe('the panel refresh rate', () => {
  it('is read from the dump rather than assumed to be 60', () => {
    // A 120 Hz phone would otherwise be graded against the wrong ceiling.
    expect(parseDisplayHz('displayRefreshRate = 120 fps')).toBe(120);
    expect(parseDisplayHz('displayRefreshRate = 60 fps' + String.fromCharCode(10) + 'renderRate = 60 fps')).toBe(60);
  });

  it('returns nothing when the dump does not say', () => {
    expect(parseDisplayHz('SurfaceFlinger TimeStats:')).toBeNull();
  });
});
