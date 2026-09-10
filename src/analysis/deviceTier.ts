/**
 * Device spec tiers, and what "acceptable" means on each.
 *
 * A regression threshold that ignores hardware is useless in both directions:
 * 45 fps on a 2 GB budget handset is a good result, and the same 45 fps on a
 * flagship is a bug. So every performance budget here is per tier, and the
 * report always says which tier was applied and why.
 *
 * Tiering is separate from the memory tier in `memoryBudget.ts` on purpose.
 * That one is keyed on RAM alone, because RAM is what decides when the
 * low-memory killer fires. Performance depends on the SoC as well, and a phone
 * can pair 8 GB of RAM with a mid-range chip - which is exactly the device that
 * a RAM-only tier would grade against the wrong bar.
 *
 * The numbers are industry practice, not anything a platform publishes. They
 * are stated as a table a studio can override, and the applied thresholds
 * travel in the report so a disagreement is about the table rather than about
 * what the tool secretly assumed.
 */
import { MB } from '../core/types.js';
import { budgetForDevice } from './memoryBudget.js';

const GB = 1024 * MB;

export type SpecTier = 'low' | 'mid' | 'high';

export interface TierThresholds {
  tier: SpecTier;
  /** Human label for the report: "mid-tier (6 GB, 8 cores at 2.4 GHz)". */
  label: string;
  /** Why this device landed in this tier. */
  reason: string;

  /** Median frame rate at or above which the build passes. */
  minMedianFps: number;
  /** Worst-1% frame rate floor - what the stutter feels like at its worst. */
  minLow1PercentFps: number;
  /** Janks per minute at or below which the build passes. */
  maxJanksPerMinute: number;
  /** Peak memory ceiling, taken from the RAM tier so the two never disagree. */
  maxPeakBytes: number;
  /** Temperature rise over the session, in degrees. */
  maxThermalRiseC: number;
  /** Draw calls per frame, where the engine reports them. */
  maxDrawCalls: number;
  /** Triangles per frame. */
  maxTriangles: number;
  /** Audio buffer underruns per minute. */
  maxUnderrunsPerMinute: number;
}

export interface DeviceSpec {
  totalRamBytes: number;
  /** Cores the kernel exposed, when per-core detail was readable. */
  coreCount?: number | null;
  /** Fastest core's ceiling in MHz - the single best proxy for SoC class. */
  maxCoreMhz?: number | null;
  /** Panel refresh rate. A 120 Hz panel is a flagship signal on its own. */
  displayHz?: number | null;
  androidSdkInt?: number | null;
  label?: string;
}

/**
 * Place a device in a tier.
 *
 * RAM is the primary axis because it is always known - every run reads
 * MemTotal, while per-core clocks need a sysfs read that some devices refuse.
 * The CPU ceiling then moves a device one tier when it plainly disagrees with
 * its RAM: 8 GB paired with a 2.0 GHz ceiling is a mid-range chip in a
 * generous shell, and grading it as a flagship would fail a build for running
 * exactly as well as that phone can run.
 */
export function classifyDeviceTier(spec: DeviceSpec): TierThresholds {
  const gb = spec.totalRamBytes / GB;
  const mhz = spec.maxCoreMhz ?? null;

  let tier: SpecTier = gb <= 3.4 ? 'low' : gb <= 7 ? 'mid' : 'high';
  const reasons: string[] = [`${gb.toFixed(1)} GB of RAM`];

  if (mhz !== null) {
    reasons.push(`fastest core ${(mhz / 1000).toFixed(1)} GHz`);
    // A slow SoC drops the tier; a fast one can raise a mid device but never
    // lifts a 3 GB phone to flagship, because memory pressure will decide that
    // device's fate whatever the chip can do.
    if (mhz < 2000 && tier === 'high') tier = 'mid';
    if (mhz < 1900 && tier === 'mid') tier = 'low';
    if (mhz >= 2900 && tier === 'mid' && gb > 5) tier = 'high';
  }

  if (spec.coreCount != null) reasons.push(`${spec.coreCount} cores`);
  if (spec.displayHz != null) reasons.push(`${spec.displayHz} Hz panel`);

  const memoryBudget = budgetForDevice(spec.totalRamBytes);
  const base = THRESHOLDS[tier];

  // The frame-rate bar is against the panel, not an absolute. A 30 fps floor
  // means something different on a 60 Hz screen than on a 120 Hz one, and a
  // game that tracks a 90 Hz panel should not be graded as though 60 were the
  // ceiling.
  const panelHz = spec.displayHz ?? 60;
  const minMedianFps = Math.min(base.minMedianFps, Math.round(panelHz * base.panelFraction));

  return {
    tier,
    label: `${TIER_LABEL[tier]} (${reasons.join(', ')})`,
    reason:
      `Tiered on ${reasons.join(', ')}. ` +
      `Thresholds for the ${TIER_LABEL[tier]} class were applied.`,
    minMedianFps,
    minLow1PercentFps: Math.round(minMedianFps * 0.5),
    maxJanksPerMinute: base.maxJanksPerMinute,
    // Reuse the memory tier's ceiling rather than inventing a second one: two
    // memory limits in one report is one too many.
    maxPeakBytes: memoryBudget.targetMaxBytes,
    maxThermalRiseC: base.maxThermalRiseC,
    maxDrawCalls: base.maxDrawCalls,
    maxTriangles: base.maxTriangles,
    maxUnderrunsPerMinute: base.maxUnderrunsPerMinute,
  };
}

export const TIER_LABEL: Record<SpecTier, string> = {
  low: 'low-end',
  mid: 'mid-range',
  high: 'high-end',
};

interface TierBase {
  minMedianFps: number;
  /** Floor as a fraction of the panel's refresh rate. */
  panelFraction: number;
  maxJanksPerMinute: number;
  maxThermalRiseC: number;
  maxDrawCalls: number;
  maxTriangles: number;
  maxUnderrunsPerMinute: number;
}

/**
 * The table.
 *
 * Draw-call and triangle ceilings are the loosest numbers here and are meant as
 * "this is unusual for the tier", not as a hard budget - a 2D game with 40 draw
 * calls and a stylised 3D game with 900 can both be correct. They earn their
 * place because a build that jumps from 300 to 1,900 draw calls between two
 * releases has regressed whatever the absolute is, and the comparison report is
 * where that shows up.
 */
const THRESHOLDS: Record<SpecTier, TierBase> = {
  low: {
    minMedianFps: 30,
    panelFraction: 0.5,
    maxJanksPerMinute: 20,
    maxThermalRiseC: 12,
    maxDrawCalls: 300,
    maxTriangles: 150_000,
    maxUnderrunsPerMinute: 2,
  },
  mid: {
    minMedianFps: 45,
    panelFraction: 0.75,
    maxJanksPerMinute: 12,
    maxThermalRiseC: 10,
    maxDrawCalls: 700,
    maxTriangles: 500_000,
    maxUnderrunsPerMinute: 1,
  },
  high: {
    minMedianFps: 55,
    panelFraction: 0.9,
    maxJanksPerMinute: 6,
    maxThermalRiseC: 8,
    maxDrawCalls: 1500,
    maxTriangles: 1_500_000,
    maxUnderrunsPerMinute: 0.5,
  },
};

/** The table itself, for the report to print so the bar is auditable. */
export function tierTable(): Array<TierBase & { tier: SpecTier; label: string }> {
  return (Object.keys(THRESHOLDS) as SpecTier[]).map((tier) => ({
    tier,
    label: TIER_LABEL[tier],
    ...THRESHOLDS[tier],
  }));
}
