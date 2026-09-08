/**
 * Per-app memory budget tests.
 *
 * These pin the two things that would quietly produce wrong verdicts: the tier
 * a device maps to (measured MemTotal is always below the marketed RAM), and the
 * boundaries between green, yellow and red.
 */
import { describe, expect, it } from 'vitest';

import { assessBudget, budgetForDevice, budgetTable, worstVerdict } from '../src/analysis/memoryBudget.js';
import { MB } from '../src/core/types.js';

const GB = 1024 * MB;

describe('device tier matching', () => {
  it('matches on measured MemTotal, which is always below the marketed RAM', () => {
    // Real MemTotal values reported by devices of each marketed size.
    const cases: Array<[number, string]> = [
      [925 * MB, '1 GB (Android Go)'],
      [1.85 * GB, '2 GB'],
      [2.8 * GB, '3 GB'],
      [3.72 * GB, '4 GB'],
      [5.6 * GB, '6 GB'],
      [7.5 * GB, '8 GB or more'],
      [11.4 * GB, '8 GB or more'],
    ];
    for (const [memTotal, expected] of cases) {
      expect(budgetForDevice(memTotal).tier).toBe(expected);
    }
  });

  it('does not push a 4 GB phone into the 3 GB tier', () => {
    // The trap: 3.72 GB is numerically under 4 GB. Matching on the marketed
    // figure would hand this device a 600 MB ceiling instead of 800 MB.
    const budget = budgetForDevice(3.72 * GB);
    expect(budget.tier).toBe('4 GB');
    expect(budget.targetMaxBytes).toBe(800 * MB);
    expect(budget.hardLimitBytes).toBe(1200 * MB);
  });

  it('flags the low-end tiers, where the budget is tightest', () => {
    expect(budgetForDevice(925 * MB).isLowEnd).toBe(true);
    expect(budgetForDevice(1.85 * GB).isLowEnd).toBe(true);
    expect(budgetForDevice(3.72 * GB).isLowEnd).toBe(false);
  });
});

describe('verdict boundaries', () => {
  const fourGb = { totalRamBytes: 3.72 * GB, deviceLabel: 'Pixel 4a' };

  it('is green inside the target range', () => {
    expect(assessBudget({ ...fourGb, peakBytes: 700 * MB }).verdict).toBe('green');
    // Exactly at the ceiling still counts as within budget.
    expect(assessBudget({ ...fourGb, peakBytes: 800 * MB }).verdict).toBe('green');
  });

  it('is yellow above the target but below the practical limit', () => {
    expect(assessBudget({ ...fourGb, peakBytes: 801 * MB }).verdict).toBe('yellow');
    expect(assessBudget({ ...fourGb, peakBytes: 1200 * MB }).verdict).toBe('yellow');
  });

  it('is red above the practical limit', () => {
    expect(assessBudget({ ...fourGb, peakBytes: 1201 * MB }).verdict).toBe('red');
    expect(assessBudget({ ...fourGb, peakBytes: 2 * GB }).verdict).toBe('red');
  });

  it('grades the same peak differently on different devices', () => {
    // 500 MB is the whole point of having tiers.
    const peak = 500 * MB;
    expect(assessBudget({ totalRamBytes: 925 * MB, peakBytes: peak }).verdict).toBe('red');
    expect(assessBudget({ totalRamBytes: 1.85 * GB, peakBytes: peak }).verdict).toBe('yellow');
    expect(assessBudget({ totalRamBytes: 3.72 * GB, peakBytes: peak }).verdict).toBe('green');
  });
});

describe('a process kill overrides the numbers', () => {
  it('is red even when the sampled peak looked comfortable', () => {
    // The sampler can easily miss the true peak in the moment before a kill, so
    // the kill itself is the stronger evidence.
    const result = assessBudget({
      totalRamBytes: 3.72 * GB,
      peakBytes: 400 * MB,
      processDeaths: 1,
      deviceLabel: 'Pixel 4a',
    });
    expect(result.verdict).toBe('red');
    expect(result.summary).toContain('killed');
    expect(result.reason).toContain('terminated');
  });
});

describe('reporting fields', () => {
  it('reports how far over budget the peak was', () => {
    const result = assessBudget({ totalRamBytes: 3.72 * GB, peakBytes: 1600 * MB });
    expect(result.targetRatio).toBeCloseTo(2, 1); // twice the 800 MB target
    expect(result.limitRatio).toBeCloseTo(1.33, 1); // a third over the 1.2 GB limit
    expect(result.reason).toContain('1.2 GB');
  });

  it('names the tier and both thresholds in plain language', () => {
    const result = assessBudget({ totalRamBytes: 1.85 * GB, peakBytes: 700 * MB });
    expect(result.reason).toContain('2 GB');
    expect(result.reason).toContain('450 MB');
    expect(result.reason).toContain('600 MB');
  });

  it('handles a device with no measurement rather than guessing', () => {
    const result = assessBudget({ totalRamBytes: 3.72 * GB, peakBytes: null });
    expect(result.verdict).toBe('green');
    expect(result.targetRatio).toBeNull();
    expect(result.summary).toContain('could not be assessed');
  });
});

describe('cross-device rollup', () => {
  it('leads with the worst verdict', () => {
    expect(worstVerdict(['green', 'yellow'])).toBe('yellow');
    expect(worstVerdict(['green', 'yellow', 'red'])).toBe('red');
    expect(worstVerdict(['green', 'green'])).toBe('green');
    expect(worstVerdict([])).toBe('green');
  });
});

describe('the published table', () => {
  it('exposes every tier for the report to show', () => {
    const table = budgetTable();
    expect(table).toHaveLength(6);
    expect(table[0]).toEqual({
      tier: '1 GB (Android Go)',
      target: '150 MB – 250 MB',
      hardLimit: '~350 MB',
    });
    expect(table.at(-1)!.tier).toBe('8 GB or more');
  });
});
