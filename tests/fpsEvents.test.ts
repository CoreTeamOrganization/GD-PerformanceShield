/**
 * Frame-rate events, memory retention, and the confidence ladder.
 *
 * These three decide what the performance sections of the report claim, so the
 * cases here are mostly about what the tool must *not* say: a steady slow game
 * is not collapsing, a level load is not a leak, and a coincidence is never
 * "confirmed".
 */
import { describe, expect, it } from 'vitest';

import { detectFpsEvents, formatFpsClock, medianOf } from '../src/analysis/fpsEvents.js';
import { analyseMemoryGrowth } from '../src/analysis/memoryGrowth.js';
import {
  CONFIDENCE_LABEL,
  confidenceLevel,
  confidenceText,
  observed,
} from '../src/analysis/confidence.js';

/** A steady curve at `fps`, one window per second. */
const steady = (fps: number, count: number, janks = 0) =>
  Array.from({ length: count }, (_, i) => ({ elapsedMs: i * 1000, fps, janks }));

const MB = 1024 * 1024;

describe('detecting frame-rate drops', () => {
  it('groups consecutive collapsed windows into one event dated by its worst', () => {
    const series = [
      ...steady(60, 20),
      { elapsedMs: 20_000, fps: 24, janks: 2 },
      { elapsedMs: 21_000, fps: 15, janks: 3 },
      { elapsedMs: 22_000, fps: 26, janks: 1 },
      ...Array.from({ length: 20 }, (_, i) => ({ elapsedMs: 23_000 + i * 1000, fps: 59, janks: 0 })),
    ];

    const drops = detectFpsEvents('A', series).filter((e) => e.kind === 'drop');
    expect(drops).toHaveLength(1);
    expect(drops[0]!.lowestFps).toBe(15);
    expect(drops[0]!.atMs).toBe(21_000);
    expect(drops[0]!.windows).toBe(3);
    expect(drops[0]!.janks).toBe(6);
  });

  it('records what the rate fell from and returned to', () => {
    // The figures that make a drop judgeable. 15 fps means nothing on its own.
    const series = [
      ...steady(60, 20),
      { elapsedMs: 20_000, fps: 15, janks: 1 },
      ...Array.from({ length: 15 }, (_, i) => ({ elapsedMs: 21_000 + i * 1000, fps: 58, janks: 0 })),
    ];
    const drop = detectFpsEvents('A', series).find((e) => e.kind === 'drop')!;

    expect(drop.beforeFps).toBe(60);
    expect(drop.afterFps).toBe(58);
    expect(drop.changePercent).toBeCloseTo(-75, 0);
    expect(drop.durationMs).toBe(1000);
  });

  it('does not call a steady 30 fps game a collapse', () => {
    // A budget phone holding its target must not have every window flagged.
    const wobbling = Array.from({ length: 30 }, (_, i) => ({
      elapsedMs: i * 1000,
      fps: 30 - (i % 2),
      janks: 0,
    }));
    expect(detectFpsEvents('A', wobbling)).toEqual([]);
  });

  it('measures against the recently achieved rate, not only the session median', () => {
    /*
     * Half the session at 60 and half at 30 puts the median near 30, so a fall
     * to 20 in the fast half is invisible to a median-only test. It was not
     * invisible to the player.
     */
    const series = [
      ...Array.from({ length: 12 }, (_, i) => ({ elapsedMs: i * 1000, fps: 60, janks: 0 })),
      { elapsedMs: 12_000, fps: 20, janks: 4 },
      ...Array.from({ length: 12 }, (_, i) => ({ elapsedMs: 13_000 + i * 1000, fps: 60, janks: 0 })),
      ...Array.from({ length: 24 }, (_, i) => ({ elapsedMs: 25_000 + i * 1000, fps: 30, janks: 0 })),
    ];

    const drop = detectFpsEvents('A', series).find((e) => e.kind === 'drop' && e.atMs === 12_000);
    expect(drop).toBeDefined();
    expect(drop!.beforeFps).toBe(60);
  });

  it('judges against the target when the build asked for less than the panel', () => {
    // A 30 fps build on a 60 Hz panel is not dropping 50% every frame.
    const series = steady(30, 40);
    expect(detectFpsEvents('A', series, { targetFps: 30 })).toEqual([]);
  });

  it('takes a configurable threshold', () => {
    const series = [
      ...steady(60, 20),
      { elapsedMs: 20_000, fps: 45, janks: 0 },
      ...Array.from({ length: 15 }, (_, i) => ({ elapsedMs: 21_000 + i * 1000, fps: 60, janks: 0 })),
    ];

    // 45 of 60 is 75% - above the default 65% floor, so not an event.
    expect(detectFpsEvents('A', series).filter((e) => e.kind === 'drop')).toHaveLength(0);
    // Raise the bar and the same dip qualifies.
    expect(
      detectFpsEvents('A', series, { collapseFraction: 0.8 }).filter((e) => e.kind === 'drop'),
    ).toHaveLength(1);
  });

  it('letters events worst first, so A is always the worst moment', () => {
    const series = [
      ...steady(60, 15),
      { elapsedMs: 15_000, fps: 30, janks: 1 },
      ...Array.from({ length: 15 }, (_, i) => ({ elapsedMs: 16_000 + i * 1000, fps: 60, janks: 0 })),
      { elapsedMs: 31_000, fps: 5, janks: 5 },
      ...Array.from({ length: 15 }, (_, i) => ({ elapsedMs: 32_000 + i * 1000, fps: 60, janks: 0 })),
    ];

    const drops = detectFpsEvents('A', series).filter((e) => e.kind === 'drop');
    expect(drops.map((d) => d.letter)).toEqual(['A', 'B']);
    expect(drops[0]!.lowestFps).toBe(5);
  });

  it('says nothing at all about a series too short to judge', () => {
    expect(detectFpsEvents('A', [{ elapsedMs: 0, fps: 60, janks: 0 }])).toEqual([]);
  });
});

describe('detecting a change of level', () => {
  it('reports a sustained step, which is usually the display cap moving', () => {
    const series = [
      ...Array.from({ length: 15 }, (_, i) => ({ elapsedMs: i * 1000, fps: 30, janks: 0 })),
      ...Array.from({ length: 15 }, (_, i) => ({ elapsedMs: 15_000 + i * 1000, fps: 60, janks: 0 })),
    ];

    const steps = detectFpsEvents('A', series).filter((e) => e.kind === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.beforeFps).toBe(30);
    expect(steps[0]!.afterFps).toBe(60);
    // Context, not a fault: rating it as a problem would put a display setting
    // at the top of a list of bugs.
    expect(steps[0]!.severity).toBe('info');
  });

  it('does not report the recovery at the end of a drop as a step', () => {
    /*
     * Every drop ends in a recovery. Reporting those would double the list and
     * say nothing - a dip that returned to where it started is one event.
     */
    const series = [
      ...steady(60, 20),
      ...Array.from({ length: 4 }, (_, i) => ({ elapsedMs: 20_000 + i * 1000, fps: 12, janks: 2 })),
      ...Array.from({ length: 20 }, (_, i) => ({ elapsedMs: 24_000 + i * 1000, fps: 60, janks: 0 })),
    ];

    const events = detectFpsEvents('A', series);
    expect(events.filter((e) => e.kind === 'drop')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'step')).toHaveLength(0);
  });

  it('ignores wobble near the cap', () => {
    const jittery = Array.from({ length: 40 }, (_, i) => ({
      elapsedMs: i * 1000,
      fps: 58 + (i % 3),
      janks: 0,
    }));
    expect(detectFpsEvents('A', jittery).filter((e) => e.kind === 'step')).toHaveLength(0);
  });
});

describe('whether memory came back down', () => {
  /** A series climbing from `from` to `to` with a loading bump in the middle. */
  const climbing = (fromMb: number, toMb: number, count = 30) =>
    Array.from({ length: count }, (_, i) => ({
      elapsedMs: i * 5000,
      bytes: (fromMb + ((toMb - fromMb) * i) / (count - 1)) * MB,
    }));

  it('calls out memory that grew and stayed up', () => {
    const g = analyseMemoryGrowth('A', climbing(500, 900));

    expect(g.verdict).toBe('retained');
    expect(g.bytesPerMinute).toBeGreaterThan(0);
    // Less than the full 400 MB span: the first 30 s are excluded, so the
    // figure describes steady play rather than the climb through loading.
    expect(g.retainedBytes).toBeGreaterThan(300 * MB);
    expect(g.retainedBytes).toBeLessThan(400 * MB);
    // Never "confirmed": ownership of an allocation is not visible from here.
    expect(g.confidence).toBeLessThan(0.85);
    expect(g.recommendation).not.toBeNull();
  });

  it('does not report launching the game as retention', () => {
    /*
     * The failure this guards against, taken from a real session: the app went
     * from 333 MB to 832 MB in the nine seconds it took to load its first
     * scene, then sat nearly flat for three minutes. Measured from the first
     * sample that reads as 569 MB retained with the floor 518 MB higher - the
     * loudest possible way to be wrong, and true of every session ever
     * recorded. Loading is not retaining.
     */
    const launchThenFlat = [
      { elapsedMs: 6_000, bytes: 333 * MB },
      { elapsedMs: 15_000, bytes: 832 * MB },
      ...Array.from({ length: 24 }, (_, i) => ({
        elapsedMs: 23_000 + i * 8_000,
        bytes: (845 + (i % 5) * 6) * MB,
      })),
    ];

    const g = analyseMemoryGrowth('A', launchThenFlat);
    expect(g.verdict).not.toBe('retained');
    expect(g.summary).toContain('excluded');
  });

  it('says so rather than guessing when the session is all warm-up', () => {
    // Under a minute of steady play once loading is dropped: there is no way to
    // separate the two from outside the process, so it must not pick one.
    // 85 s in total, so it passes the "is there a session at all" guard; only
    // 55 s of it survives the warm-up cut, which is what this exercises.
    const shortRun = Array.from({ length: 18 }, (_, i) => ({
      elapsedMs: i * 5_000,
      bytes: (300 + i * 25) * MB,
    }));

    const g = analyseMemoryGrowth('A', shortRun);
    expect(g.verdict).toBe('insufficient');
    expect(g.summary).toContain('too short to separate loading from retention');
  });

  it('does not call a level load a leak', () => {
    // Up 400 MB and back down again is the normal shape of loading content.
    const series = [
      ...Array.from({ length: 10 }, (_, i) => ({ elapsedMs: i * 5000, bytes: 500 * MB })),
      ...Array.from({ length: 10 }, (_, i) => ({ elapsedMs: 50_000 + i * 5000, bytes: 900 * MB })),
      ...Array.from({ length: 10 }, (_, i) => ({ elapsedMs: 100_000 + i * 5000, bytes: 510 * MB })),
    ];

    const g = analyseMemoryGrowth('A', series);
    expect(g.verdict).toBe('released');
    expect(g.recommendation).toBeNull();
  });

  it('reports a flat session as flat rather than staying silent', () => {
    const g = analyseMemoryGrowth(
      'A',
      Array.from({ length: 30 }, (_, i) => ({ elapsedMs: i * 5000, bytes: 500 * MB })),
    );
    expect(g.verdict).toBe('flat');
  });

  it('refuses to judge a session too short to have a trend', () => {
    const g = analyseMemoryGrowth('A', [
      { elapsedMs: 0, bytes: 500 * MB },
      { elapsedMs: 10_000, bytes: 900 * MB },
    ]);
    expect(g.verdict).toBe('insufficient');
    expect(g.summary).toContain('Too little of the session');
    expect(g.recommendation).toBeNull();
  });

  it('notices the floor rising, which survives the loading spikes on top', () => {
    // Sawtooth: each cycle returns lower than its peak but higher than the last
    // trough. The troughs are the evidence.
    const series = Array.from({ length: 50 }, (_, i) => ({
      elapsedMs: i * 5000,
      bytes: (500 + i * 5 + (i % 4 === 0 ? 80 : 0)) * MB,
    }));
    const g = analyseMemoryGrowth('A', series);
    expect(g.verdict).toBe('retained');
    expect(g.floorRoseBytes).toBeGreaterThan(0);
  });
});

describe('the confidence ladder', () => {
  it('never reaches "confirmed" from a number, however high', () => {
    /*
     * The rule that keeps the word meaning something: correlation tops out at
     * "high", and only a caller that watched the thing happen may assert
     * "confirmed".
     */
    expect(confidenceLevel(1)).toBe('high');
    expect(confidenceLevel(0.99)).toBe('high');
    expect(observed()).toBe('confirmed');
  });

  it('maps the bands as documented', () => {
    expect(confidenceLevel(0.9)).toBe('high');
    expect(confidenceLevel(0.7)).toBe('medium');
    expect(confidenceLevel(0.5)).toBe('possible');
    expect(confidenceLevel(0.2)).toBe('insufficient');
  });

  it('treats a missing figure as insufficient rather than as zero confidence', () => {
    expect(confidenceLevel(Number.NaN)).toBe('insufficient');
  });

  it('has wording for every level', () => {
    for (const level of ['confirmed', 'high', 'medium', 'possible', 'insufficient'] as const) {
      expect(CONFIDENCE_LABEL[level]).toBeTruthy();
    }
    expect(confidenceText(0.7)).toBe('Medium confidence');
  });
});

describe('helpers', () => {
  it('formats the clock as m:ss', () => {
    expect(formatFpsClock(0)).toBe('0:00');
    expect(formatFpsClock(76_000)).toBe('1:16');
    expect(formatFpsClock(605_000)).toBe('10:05');
  });

  it('takes the median of an even-length series without picking a side', () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([])).toBe(0);
  });
});
