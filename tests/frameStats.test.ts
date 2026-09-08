/**
 * Frame-time and jank tests.
 *
 * The fixture is a histogram captured from a Samsung SM-A366B running
 * Android 16 while the game was in the foreground: 276 frames at 16 ms, then one
 * each at 50, 102 and 118 ms. Real data matters here because the whole point of
 * these figures is that an average over a five-second window cannot see a single
 * 118 ms stall, and that stall is what a player notices.
 */
import { describe, expect, it } from 'vitest';

import {
  parseFrameHistogram,
  summarizeFrames,
  type FrameStats,
} from '../src/telemetry/fps.js';
import {
  RATING_LABEL,
  rateFps,
  rateJanks,
  summarizeFps,
} from '../src/telemetry/deviceHealth.js';

/** Exactly as it came off the device. */
const REAL_WINDOW = [
  { ms: 16, count: 276 },
  { ms: 50, count: 1 },
  { ms: 102, count: 1 },
  { ms: 118, count: 1 },
];

describe('reading the frame-interval histogram', () => {
  it('pulls present2present out of a layer section', () => {
    const section = [
      'totalFrames = 279',
      'averageFPS = 62.500',
      'present2present histogram is as below:',
      '0ms=0 1ms=0 16ms=276 33ms=0 50ms=1 102ms=1 118ms=1',
      'latch2present histogram is as below:',
      '0ms=9 1ms=270',
    ].join('\n');

    // Only the frame *interval*, not the other histograms in the section: those
    // measure latency through the pipeline and would answer a different question.
    expect(parseFrameHistogram(section)).toEqual(REAL_WINDOW);
  });

  it('returns nothing when the section carries no histogram', () => {
    expect(parseFrameHistogram('totalFrames = 5')).toEqual([]);
    expect(parseFrameHistogram('')).toEqual([]);
  });
});

describe('frame-time figures from a real window', () => {
  let stats: FrameStats;

  it('counts every frame', () => {
    stats = summarizeFrames(REAL_WINDOW, 60);
    expect(stats.frameCount).toBe(279);
  });

  it('reports a median that a single stall cannot move', () => {
    // 276 of 279 frames are 16 ms, so the median is 16 ms whatever the tail does.
    expect(summarizeFrames(REAL_WINDOW, 60).medianFps).toBe(62.5);
  });

  it('reports the worst single frame as the minimum', () => {
    // One over the longest frame time, which is the definition that matters:
    // 118 ms is a visible hitch, and no average would show it.
    const s = summarizeFrames(REAL_WINDOW, 60);
    expect(s.longestFrameMs).toBe(118);
    expect(s.minFps).toBe(8.5);
  });

  it('reports the best frame as the maximum', () => {
    expect(summarizeFrames(REAL_WINDOW, 60).maxFps).toBe(62.5);
  });

  it('averages the worst 1% of frames rather than taking one outlier', () => {
    // 1% of 279 is 3 frames: 118, 102 and 50 ms. Mean 90 ms, so 11.1 fps.
    expect(summarizeFrames(REAL_WINDOW, 60).low1PercentFps).toBeCloseTo(11.1, 1);
  });

  it('counts a jank by the absolute threshold, and only that', () => {
    // Over 83 ms catches 102 and 118, and nothing else. The 50 ms frame is a
    // dropped frame - real, and counted under "missed a refresh" - but calling
    // it a jank is what inflated this figure twenty-five-fold against every
    // other tool.
    expect(summarizeFrames(REAL_WINDOW, 60).janks).toBe(2);
  });

  it('reserves a severe jank for a visible freeze', () => {
    // Nothing here passed 125 ms, so no frame counts as severe - even though
    // two counted as janks.
    expect(summarizeFrames(REAL_WINDOW, 60).bigJanks).toBe(0);
  });

  it('counts a missed refresh separately from a jank', () => {
    // Three frames took longer than one 60 Hz refresh period.
    expect(summarizeFrames(REAL_WINDOW, 60).smallJanks).toBe(3);
  });

  it('judges a missed refresh against the panel, not against 60 Hz', () => {
    // On a 120 Hz panel the budget per frame is 8.3 ms, so every 16 ms frame
    // has missed one. Hard-coding 60 Hz would report none.
    expect(summarizeFrames(REAL_WINDOW, 120).smallJanks).toBe(279);
    expect(summarizeFrames(REAL_WINDOW, 60).smallJanks).toBe(3);
  });

  it('never lets severe janks exceed janks', () => {
    // A frame cannot be a visible freeze without also being a stutter.
    const heavy = summarizeFrames([{ ms: 16, count: 100 }, { ms: 300, count: 5 }], 60);
    expect(heavy.bigJanks).toBeLessThanOrEqual(heavy.janks);
    expect(heavy.bigJanks).toBe(5);
  });

  it('reports nothing rather than zero for an empty window', () => {
    const empty = summarizeFrames([], 60);
    expect(empty.frameCount).toBe(0);
    expect(empty.medianFps).toBeNull();
    expect(empty.minFps).toBeNull();
    expect(empty.janks).toBe(0);
  });

  it('handles a window where every frame was slow', () => {
    // A game stuck at 5 fps: every frame is over both absolute thresholds.
    const stalled = summarizeFrames([{ ms: 200, count: 30 }], 60);
    expect(stalled.medianFps).toBe(5);
    expect(stalled.janks).toBe(30);
    expect(stalled.bigJanks).toBe(30);
  });
});

describe('ratings', () => {
  it('judges frame rate as a share of the target, not against a fixed number', () => {
    // 29 of a 30 target is a build doing its job; 29 of a 60 target is missing
    // half its frames. The same measured rate, two different verdicts.
    expect(rateFps(29, 30)).toBe('excellent');
    expect(rateFps(29, 60)).toBe('poor');
  });

  it('grades the range between', () => {
    expect(rateFps(53, 60)).toBe('good');
    expect(rateFps(44, 60)).toBe('fair');
    expect(rateFps(30, 60)).toBe('poor');
  });

  it('says nothing when there is no target to judge against', () => {
    expect(rateFps(45, null)).toBe('unknown');
    expect(rateFps(null, 60)).toBe('unknown');
    expect(RATING_LABEL[rateFps(null, 60)]).toBe('Not measured');
  });

  it('judges stutter per minute, so a longer session is not punished', () => {
    // Ten janks in ten minutes is one a minute; ten in one minute is ten.
    expect(rateJanks(10, 10 * 60_000)).toBe('good');
    expect(rateJanks(10, 60_000)).toBe('poor');
  });

  it('calls a session with no stutter excellent', () => {
    expect(rateJanks(0, 5 * 60_000)).toBe('excellent');
  });
});

describe('session-wide frame statistics', () => {
  /** One window's worth of readings, from a frame-time histogram. */
  const window = (buckets: Array<{ ms: number; count: number }>) => {
    const frames = summarizeFrames(buckets, 60);
    return {
      fps: frames.medianFps ?? 0,
      displayHz: 60,
      matchesDisplayRate: false,
      frames,
      frameCount: frames.frameCount,
      jankPercent: null,
      worstFrameMs: frames.longestFrameMs,
      source: 'timestats',
    };
  };

  it('takes the frame pace from a true median, not an average of window medians', () => {
    // 100 frames at 16 ms then 300 at 33 ms. Three quarters of the session ran
    // at 33 ms, so the median frame is 33 ms and the pace is 30.3 fps. Averaging
    // the two windows' medians by frame count gives 38.4 - a figure no frame in
    // the session actually had.
    const summary = summarizeFps(
      [window([{ ms: 16, count: 100 }]), window([{ ms: 33, count: 300 }])],
      60_000,
    );

    expect(summary.typicalFrameFps).toBeCloseTo(30.3, 1);
    expect(summary.totalFrames).toBe(400);
  });

  it('keeps the two medians apart', () => {
    // "Median FPS" is the middle of the per-second samples, which is what a chart
    // shows and what other tools report. The frame pace is one over the median
    // gap between frames. On a game that renders fast and then stalls these
    // diverge widely, and reporting either as though it were the other is how a
    // 58.8 gets compared against someone else's 41.
    const summary = summarizeFps(
      [window([{ ms: 16, count: 100 }]), window([{ ms: 33, count: 300 }])],
      60_000,
    );

    expect(summary.typicalFrameFps).toBeCloseTo(30.3, 1);
    expect(summary.medianFps).not.toBeCloseTo(summary.typicalFrameFps!, 1);
  });

  it('takes the worst 1% across the whole session, not the worst window', () => {
    // The published definition is "the worst 1% of frame times since the
    // beginning of the session". Taking the minimum of each window's own worst-1%
    // answers a different, more pessimistic question: it reports the single
    // worst window as though it were the session.
    const summary = summarizeFps(
      [
        window([{ ms: 16, count: 100 }]),
        window([{ ms: 16, count: 99 }, { ms: 500, count: 1 }]),
      ],
      60_000,
    );

    // 1% of 200 frames is 2: one at 500 ms and one at 16 ms, mean 258 ms.
    expect(summary.low1PercentFps).toBeCloseTo(3.9, 1);
    // Not 2.0 fps, which is what the worst window on its own would have said.
    expect(summary.low1PercentFps).not.toBeCloseTo(2, 1);
  });

  it('reports the worst single frame in the session', () => {
    const summary = summarizeFps(
      [
        window([{ ms: 16, count: 100 }, { ms: 250, count: 1 }]),
        window([{ ms: 16, count: 100 }, { ms: 700, count: 1 }]),
      ],
      60_000,
    );

    expect(summary.longestFrameMs).toBe(700);
    expect(summary.minFrameFps).toBeCloseTo(1.4, 1);
  });

  it('totals the janks across windows', () => {
    const summary = summarizeFps(
      [
        window([{ ms: 16, count: 50 }, { ms: 100, count: 3 }]),
        window([{ ms: 16, count: 50 }, { ms: 200, count: 2 }]),
      ],
      60_000,
    );

    expect(summary.janks).toBe(5);
    expect(summary.bigJanks).toBe(2);
  });

  it('reports nothing rather than zero when no window carried frame times', () => {
    const summary = summarizeFps(
      [
        {
          fps: 42,
          displayHz: 60,
          matchesDisplayRate: false,
          frameCount: 0,
          jankPercent: null,
          worstFrameMs: null,
          source: 'gfxinfo',
        },
      ],
      60_000,
    );

    // A sampled rate still exists - that came from the frame count over the
    // window - but nothing that needs per-frame times does.
    expect(summary.medianFps).toBe(42);
    expect(summary.typicalFrameFps).toBeNull();
    expect(summary.low1PercentFps).toBeNull();
    expect(summary.janks).toBeNull();
  });
});
