/**
 * Lettered checkpoint tests.
 *
 * The letter is a cross-reference: prose and tables point a reader at "B" and
 * the chart has to agree. So the properties that matter are that letters go by
 * size (not by time), that they are unique, and that a release never gets one -
 * pointing someone at a peak that is actually a drop would mislead.
 */
import { describe, expect, it } from 'vitest';

import { buildTimelineSeries, detectSpikes } from '../src/analysis/spikes.js';
import type { MemorySample, TimelineEvent } from '../src/telemetry/types.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Deep samples whose totals follow the given megabyte figures. */
function samplesOf(totalsMb: number[]): MemorySample[] {
  return totalsMb.map(
    (total, i) =>
      ({
        tier: 'deep',
        elapsedMs: i * 5000,
        summary: {
          graphics: total * 0.5 * MB,
          privateOther: total * 0.3 * MB,
          code: total * 0.1 * MB,
          javaHeap: total * 0.04 * MB,
          nativeHeap: total * 0.04 * MB,
          system: total * 0.01 * MB,
          stack: total * 0.01 * MB,
        },
      }) as unknown as MemorySample,
  );
}

const noEvents: TimelineEvent[] = [];

describe('lettered checkpoints', () => {
  it('names the biggest jump A, wherever it happened', () => {
    // 400 -> 440 -> 740 -> 800 -> 1300: the +500 is fourth in time but largest.
    const spikes = detectSpikes({
      role: 'A',
      samples: samplesOf([400, 440, 740, 800, 1300]),
      events: noEvents,
      totalRamBytes: 4 * GB,
    });

    const a = spikes.find((s) => s.letter === 'A')!;
    expect(Math.round(a.deltaBytes / MB)).toBe(500);
    expect(a.toMs).toBe(20_000);
  });

  it('assigns letters by size, not by time', () => {
    const spikes = detectSpikes({
      role: 'A',
      samples: samplesOf([400, 440, 740, 800, 1300]),
      events: noEvents,
      totalRamBytes: 4 * GB,
    });

    const lettered = spikes.filter((s) => s.letter);
    for (let i = 1; i < lettered.length; i++) {
      expect(lettered[i - 1]!.deltaBytes).toBeGreaterThanOrEqual(lettered[i]!.deltaBytes);
    }
    // Three, not four: the +40 MB step is under this device's own threshold
    // (1% of 4 GB), so it never became a spike in the first place.
    expect(lettered.map((s) => s.letter).join('')).toBe('ABC');
  });

  it('never gives a release a letter', () => {
    // A drop is worth listing but is not a peak; pointing a reader at it as
    // though it were would be misleading.
    const spikes = detectSpikes({
      role: 'A',
      samples: samplesOf([400, 900, 400]),
      events: noEvents,
      totalRamBytes: 4 * GB,
    });

    const release = spikes.find((s) => s.deltaBytes < 0)!;
    expect(release.letter).toBe('');
    expect(spikes.find((s) => s.deltaBytes > 0)!.letter).toBe('A');
  });

  it('keeps letters unique', () => {
    const spikes = detectSpikes({
      role: 'A',
      samples: samplesOf([400, 500, 620, 780, 990, 1250, 1560]),
      events: noEvents,
      totalRamBytes: 4 * GB,
    });

    const letters = spikes.filter((s) => s.letter).map((s) => s.letter);
    expect(new Set(letters).size).toBe(letters.length);
  });

  it('attributes each jump to the marker that preceded it', () => {
    const events = [
      { elapsedMs: 1000, label: 'Main menu', type: 'screen_open', source: 'operator' },
      { elapsedMs: 12_000, label: 'Shop', type: 'screen_open', source: 'operator' },
    ] as TimelineEvent[];

    const spikes = detectSpikes({
      role: 'A',
      samples: samplesOf([400, 900, 950, 1500]),
      events,
      totalRamBytes: 4 * GB,
    });

    expect(spikes.find((s) => s.toMs === 5000)!.nearestMarker).toBe('Main menu');
    expect(spikes.find((s) => s.toMs === 15_000)!.nearestMarker).toBe('Shop');
  });

  it('scales the threshold with the device', () => {
    // 20 MB is a real event on a 2 GB phone and rounding error on a 12 GB one.
    const samples = samplesOf([400, 430]);
    expect(detectSpikes({ role: 'A', samples, events: noEvents, totalRamBytes: 2 * GB })).toHaveLength(1);
    expect(detectSpikes({ role: 'A', samples, events: noEvents, totalRamBytes: 12 * GB })).toHaveLength(0);
  });
});

describe('thinning the curve for a report', () => {
  it('keeps every local peak rather than sampling every Nth point', () => {
    // Dropping a peak would flatten the very spike the report is about.
    const totals = Array.from({ length: 600 }, (_, i) => (i === 301 ? 2000 : 400 + (i % 7)));
    const series = buildTimelineSeries('A', samplesOf(totals), 100);

    expect(series.points.length).toBeLessThanOrEqual(100);
    const peak = Math.max(...series.points.map((p) => p.totalBytes));
    expect(Math.round(peak / MB)).toBe(2000);
  });

  it('keeps the first and last point, so the axis spans the session', () => {
    const series = buildTimelineSeries('A', samplesOf(Array.from({ length: 500 }, () => 400)), 50);
    expect(series.points[0]!.elapsedMs).toBe(0);
    expect(series.points.at(-1)!.elapsedMs).toBe(499 * 5000);
  });

  it('leaves a short session untouched', () => {
    const series = buildTimelineSeries('A', samplesOf([400, 500, 600]), 240);
    expect(series.points).toHaveLength(3);
  });
});
