/**
 * How much memory one app may reasonably use on a given device.
 *
 * A peak of 800 MB means nothing on its own: it is comfortable on an 8 GB
 * handset and fatal on a 2 GB one. This turns the raw figure into a verdict by
 * comparing it against the budget for the device's RAM tier.
 *
 * Two numbers per tier:
 *
 *   target      what a shipping mobile game should stay under. Staying here
 *               leaves room for the OS, other apps, and the memory spikes that
 *               come with scene loads.
 *   hardLimit   roughly where Android's low-memory killer starts choosing this
 *               process. Crossing it does not always crash immediately - it
 *               means the app dies whenever the user takes a call or switches
 *               away and back.
 *
 * The figures are industry practice rather than anything Android publishes, so
 * they are stated as a documented table that a studio can disagree with, and
 * every report says which tier was applied.
 */
import { MB } from '../core/types.js';

const GB = 1024 * MB;

export type BudgetVerdict = 'green' | 'yellow' | 'red';

export interface MemoryBudget {
  /** Marketed RAM the device was matched to, e.g. "4 GB". */
  tier: string;
  /** Lower end of the sensible target range. */
  targetMinBytes: number;
  /** Upper end of the target - the number to stay under. */
  targetMaxBytes: number;
  /** Where the OS realistically starts killing the process. */
  hardLimitBytes: number;
  /** True for the Android Go class, where the budget is tightest. */
  isLowEnd: boolean;
}

interface Tier extends MemoryBudget {
  /** Upper bound of measured MemTotal that maps to this tier. */
  maxTotalRamBytes: number;
}

/**
 * Tier table, keyed by *measured* MemTotal rather than marketed RAM.
 *
 * The distinction matters: a "4 GB" phone reports around 3.7 GB, because the
 * kernel and reserved regions never appear in MemTotal. Matching on the marketed
 * figure would push most devices into the tier below and hand out a budget that
 * is too tight.
 */
const TIERS: Tier[] = [
  {
    tier: '1 GB (Android Go)',
    maxTotalRamBytes: 1.4 * GB,
    targetMinBytes: 150 * MB,
    targetMaxBytes: 250 * MB,
    hardLimitBytes: 350 * MB,
    isLowEnd: true,
  },
  {
    tier: '2 GB',
    maxTotalRamBytes: 2.4 * GB,
    targetMinBytes: 300 * MB,
    targetMaxBytes: 450 * MB,
    hardLimitBytes: 600 * MB,
    isLowEnd: true,
  },
  {
    tier: '3 GB',
    maxTotalRamBytes: 3.4 * GB,
    targetMinBytes: 450 * MB,
    targetMaxBytes: 600 * MB,
    hardLimitBytes: 900 * MB,
    isLowEnd: false,
  },
  {
    tier: '4 GB',
    maxTotalRamBytes: 5 * GB,
    targetMinBytes: 600 * MB,
    targetMaxBytes: 800 * MB,
    hardLimitBytes: 1200 * MB,
    isLowEnd: false,
  },
  {
    tier: '6 GB',
    maxTotalRamBytes: 7 * GB,
    targetMinBytes: 900 * MB,
    targetMaxBytes: 1200 * MB,
    hardLimitBytes: 1800 * MB,
    isLowEnd: false,
  },
  {
    tier: '8 GB or more',
    maxTotalRamBytes: Number.POSITIVE_INFINITY,
    targetMinBytes: 1200 * MB,
    targetMaxBytes: 1500 * MB,
    hardLimitBytes: 2500 * MB,
    isLowEnd: false,
  },
];

/** Budget for a device, matched on its measured total RAM. */
export function budgetForDevice(totalRamBytes: number): MemoryBudget {
  const tier = TIERS.find((t) => totalRamBytes <= t.maxTotalRamBytes) ?? TIERS[TIERS.length - 1]!;
  const { maxTotalRamBytes: _unused, ...budget } = tier;
  return budget;
}

export interface BudgetAssessment {
  budget: MemoryBudget;
  verdict: BudgetVerdict;
  peakBytes: number | null;
  /** Peak as a fraction of the target ceiling. 1.0 means exactly at target. */
  targetRatio: number | null;
  /** Peak as a fraction of the hard limit. */
  limitRatio: number | null;
  /** One sentence a non-specialist can act on. */
  summary: string;
  /** Why this verdict, for the report to quote. */
  reason: string;
}

export interface AssessBudgetInput {
  totalRamBytes: number;
  peakBytes: number | null;
  /** A kill overrides everything: it is proof the budget was exceeded. */
  processDeaths?: number;
  deviceLabel?: string;
}

/**
 * Grade an app's measured peak against its device's budget.
 *
 * A process death forces red regardless of the numbers - if the OS killed the
 * app, the budget was exceeded by definition, whatever the last sample said. The
 * sampler can easily miss the true peak in the moment before a kill.
 */
export function assessBudget(input: AssessBudgetInput): BudgetAssessment {
  const budget = budgetForDevice(input.totalRamBytes);
  const { peakBytes } = input;
  const device = input.deviceLabel ?? 'this device';

  if (input.processDeaths && input.processDeaths > 0) {
    return {
      budget,
      verdict: 'red',
      peakBytes,
      targetRatio: peakBytes === null ? null : peakBytes / budget.targetMaxBytes,
      limitRatio: peakBytes === null ? null : peakBytes / budget.hardLimitBytes,
      summary: `The operating system killed the game on ${device}.`,
      reason:
        `A ${budget.tier} device gives one app roughly ${fmtMb(budget.targetMaxBytes)} to work with ` +
        `before it becomes a kill candidate around ${fmtMb(budget.hardLimitBytes)}. The process was ` +
        'terminated during the session, which settles the question regardless of the sampled peak.',
    };
  }

  if (peakBytes === null) {
    return {
      budget,
      verdict: 'green',
      peakBytes: null,
      targetRatio: null,
      limitRatio: null,
      summary: `No memory was measured on ${device}, so its budget could not be assessed.`,
      reason:
        `A ${budget.tier} device should keep one app under about ${fmtMb(budget.targetMaxBytes)}, ` +
        `with trouble starting near ${fmtMb(budget.hardLimitBytes)}. Nothing was recorded to compare.`,
    };
  }

  const targetRatio = peakBytes / budget.targetMaxBytes;
  const limitRatio = peakBytes / budget.hardLimitBytes;

  if (peakBytes > budget.hardLimitBytes) {
    return {
      budget,
      verdict: 'red',
      peakBytes,
      targetRatio,
      limitRatio,
      summary: `${fmtMb(peakBytes)} on ${device} is past the point where Android starts killing the app.`,
      reason:
        `A ${budget.tier} device should keep one app under about ${fmtMb(budget.targetMaxBytes)}, ` +
        `and the practical ceiling is around ${fmtMb(budget.hardLimitBytes)}. The measured peak of ` +
        `${fmtMb(peakBytes)} is ${Math.round((limitRatio - 1) * 100)}% above that ceiling, so the ` +
        'game will be killed whenever the player takes a call or switches away and back.',
    };
  }

  if (peakBytes > budget.targetMaxBytes) {
    return {
      budget,
      verdict: 'yellow',
      peakBytes,
      targetRatio,
      limitRatio,
      summary: `${fmtMb(peakBytes)} on ${device} is over the target, with limited headroom left.`,
      reason:
        `A ${budget.tier} device should keep one app under about ${fmtMb(budget.targetMaxBytes)}. ` +
        `The measured peak of ${fmtMb(peakBytes)} is ${Math.round((targetRatio - 1) * 100)}% above that ` +
        `and ${Math.round((1 - limitRatio) * 100)}% below the ${fmtMb(budget.hardLimitBytes)} point where ` +
        'the OS starts killing the process. It will survive a clean run but has little room for a spike.',
    };
  }

  return {
    budget,
    verdict: 'green',
    peakBytes,
    targetRatio,
    limitRatio,
    summary: `${fmtMb(peakBytes)} on ${device} is within budget.`,
    reason:
      `A ${budget.tier} device gives one app a target of ${fmtMb(budget.targetMinBytes)} to ` +
      `${fmtMb(budget.targetMaxBytes)}. The measured peak of ${fmtMb(peakBytes)} stays inside that, ` +
      `leaving headroom before the ${fmtMb(budget.hardLimitBytes)} point where the OS starts killing ` +
      'the process.',
  };
}

/** Worst verdict across devices - the one the report leads with. */
export function worstVerdict(verdicts: BudgetVerdict[]): BudgetVerdict {
  if (verdicts.includes('red')) return 'red';
  if (verdicts.includes('yellow')) return 'yellow';
  return 'green';
}

export const VERDICT_LABEL: Record<BudgetVerdict, string> = {
  green: 'Within budget',
  yellow: 'Over target',
  red: 'Over the practical limit',
};

function fmtMb(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

/** The table itself, so the report and the console can show what was applied. */
export function budgetTable(): Array<{
  tier: string;
  target: string;
  hardLimit: string;
}> {
  return TIERS.map((t) => ({
    tier: t.tier,
    target: `${fmtMb(t.targetMinBytes)} – ${fmtMb(t.targetMaxBytes)}`,
    hardLimit: `~${fmtMb(t.hardLimitBytes)}`,
  }));
}
