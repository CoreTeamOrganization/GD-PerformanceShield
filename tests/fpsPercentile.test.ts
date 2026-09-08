/**
 * The tool's percentiles against GDPerfTracker's.
 *
 * The report has a section mapping its figures onto the in-game recorder's
 * `fps_p01`, `fps_p50` and the rest, so a studio can read a session and an
 * analytics payload side by side. That only works if both compute the same
 * thing, which makes this agreement a contract rather than a detail.
 *
 * The reference below is transcribed from the package the game actually ships
 * (`com.gamedistrict.performance-tracker`, Scripts/GDPerfTracker.cs):
 *
 *     static float Percentile(List<float> sortedAscending, float p)
 *     {
 *         int index = Mathf.Clamp(
 *             Mathf.RoundToInt((sortedAscending.Count - 1) * p), 0, sortedAscending.Count - 1);
 *         return sortedAscending[index];
 *     }
 *
 * The tool used a nearest-rank index before this. Both return a rate the game
 * actually ran at, but they pick a different sample about half the time.
 */
import { describe, expect, it } from 'vitest';

import { fpsPercentile } from '../src/telemetry/deviceHealth.js';

/**
 * `Mathf.RoundToInt`, which is `(int)Math.Round(f)` - round-half-to-even.
 *
 * Written out rather than using `Math.round` because that is the whole subtlety:
 * they differ only at exact halves, which is where an even sample count puts
 * the index.
 */
function mathfRoundToInt(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** GDPerfTracker.Percentile, transcribed. */
function trackerPercentile(sortedAscending: number[], p: number): number {
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, mathfRoundToInt((sortedAscending.length - 1) * p)),
  );
  return sortedAscending[index]!;
}

const LADDER = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99];

describe('agreeing with the in-game recorder', () => {
  it('matches the tracker at every published percentile, for every sample count', () => {
    // The sweep that found the divergence in the first place: a single spot
    // check passes on counts where the two formulas happen to coincide.
    for (let n = 1; n <= 400; n++) {
      const sorted = Array.from({ length: n }, (_, i) => i + 1);
      for (const p of LADDER) {
        expect(fpsPercentile(sorted, p), `n=${n} p=${p}`).toBe(trackerPercentile(sorted, p));
      }
    }
  });

  it('matches on a three-minute session, where five of seven used to differ', () => {
    const sorted = Array.from({ length: 180 }, (_, i) => i + 1);
    expect(LADDER.map((p) => fpsPercentile(sorted, p))).toEqual(
      LADDER.map((p) => trackerPercentile(sorted, p)),
    );
  });

  it('matches on real, uneven frame rates rather than only on a clean ramp', () => {
    // Shaped like a session that mostly holds 60 and occasionally collapses.
    const raw = Array.from({ length: 137 }, (_, i) =>
      i % 23 === 0 ? 12 + (i % 7) : 58 + ((i * 7) % 5) / 2,
    );
    const sorted = [...raw].sort((a, b) => a - b);
    for (const p of LADDER) {
      expect(fpsPercentile(sorted, p), `p=${p}`).toBe(trackerPercentile(sorted, p));
    }
  });

  it('rounds exact halves to even, the way Unity does', () => {
    /*
     * n=3 puts p50 at (3-1)*0.5 = 1.0, no ambiguity. n=2 puts it at 0.5, which
     * is the case that separates the two rounding rules: to-even gives index 0,
     * ordinary rounding gives 1.
     */
    expect(fpsPercentile([10, 20], 0.5)).toBe(10);
    expect(fpsPercentile([10, 20], 0.5)).toBe(trackerPercentile([10, 20], 0.5));
  });

  it('returns a value that is actually in the samples, never an interpolation', () => {
    // The property worth keeping from the old formula: "the worst second" has
    // to be a second that happened.
    const sorted = [11, 27, 43, 59];
    for (const p of LADDER) {
      expect(sorted).toContain(fpsPercentile(sorted, p));
    }
  });

  it('handles a single sample and an empty series without throwing', () => {
    expect(fpsPercentile([42], 0.01)).toBe(42);
    expect(fpsPercentile([42], 0.99)).toBe(42);
    expect(fpsPercentile([], 0.5)).toBe(0);
  });
});
