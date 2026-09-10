/**
 * Step 13 - Scoring Engine.
 *
 * The spec is explicit: do not simply average rule counts. Two reasons that
 * matters, both handled here:
 *
 *  1. Averaging rewards noise. A project with one critical leak and no other
 *     findings would score *better* than one with the same leak plus twenty
 *     cosmetic warnings. So scores accumulate impact and saturate rather than
 *     average.
 *  2. Static and live evidence are not equally trustworthy. A measured process
 *     kill outranks any number of static hypotheses, and static findings alone
 *     carry an explicit uncertainty discount because nothing has been observed.
 *
 * Every score is reported alongside the confidence in the *data* that produced
 * it, so a studio can tell "this game is fine" from "we could not measure it".
 */
import { FEATURES } from '../core/features.js';
import { SEVERITY_WEIGHT, type Finding, type Severity } from '../core/types.js';

export type RiskBand = 'low' | 'moderate' | 'high' | 'critical';

export interface RiskScore {
  /** 0-100. */
  value: number;
  band: RiskBand;
  /** What drove the score, for the report. */
  contributors: Array<{ findingId: string; title: string; impact: number }>;
}

export interface DataConfidence {
  /** 0-1: how much of the intended evidence we actually gathered. */
  value: number;
  factors: Array<{ name: string; present: boolean; weight: number; note?: string }>;
  /** Plain-language caveats to print near the headline score. */
  caveats: string[];
}

export interface DeviceRisk {
  serial: string;
  role: string;
  model: string;
  totalRamBytes: number;
  score: RiskScore;
  peakBytes: number | null;
  peakRamFraction: number | null;
  processDeaths: number;
  /** Terminations the OS initiated, as opposed to fatal crashes. */
  osKills: number;
}

export interface ScoringInput {
  staticFindings: Finding[];
  liveFindings: Finding[];
  correlatedFindings: Finding[];
  context: {
    hasRepository: boolean;
    hasApk: boolean;
    hasMetaFiles: boolean;
    liveSessionRan: boolean;
    deviceCount: number;
    sessionDurationMs: number;
    cycleCount: number;
    markerCount: number;
  };
  /** Per-device summaries from the anomaly stage. */
  devices?: Array<{
    serial: string;
    role: string;
    model: string;
    totalRamBytes: number;
    peakBytes: number | null;
    peakRamFraction: number | null;
    processDeaths: number;
    osKills?: number;
  }>;
}

export interface ScoringResult {
  staticRisk: RiskScore;
  liveRisk: RiskScore;
  combinedRisk: RiskScore;
  confidence: DataConfidence;
  perDevice: DeviceRisk[];
  /** Findings ordered by what a studio should fix first. */
  priority: PrioritizedFinding[];
  headline: string;
}

export interface PrioritizedFinding {
  finding: Finding;
  /** Composite of severity, confidence, evidence strength and size. */
  priorityScore: number;
  rank: number;
  reason: string;
}

/**
 * Saturation constants.
 *
 * `K` is the accumulated impact at which a score reaches ~63 of 100. Live
 * evidence saturates faster because an observed failure needs less
 * corroboration than a predicted one: at LIVE_K a single confirmed critical
 * finding already lands in the "high" band, while it takes several static
 * criticals to get there on prediction alone.
 */
const STATIC_K = 25;
const LIVE_K = 12;

/**
 * Floor applied when a critical problem was actually observed on hardware.
 *
 * Without it the arithmetic can report "moderate" for a session in which the
 * OS killed the game - technically consistent with the curve, and useless to a
 * studio. A confirmed critical runtime failure is critical risk by definition.
 */
const CONFIRMED_CRITICAL_FLOOR = 75;
const CONFIRMED_CRITICAL_CONFIDENCE = 0.9;

export function score(input: ScoringInput): ScoringResult {
  const staticRisk = scoreFindings(input.staticFindings, STATIC_K);
  // Correlated findings are live observations with a cause attached, so they
  // belong to the live score.
  const observed = [...input.liveFindings, ...input.correlatedFindings];
  const liveRisk = applyConfirmedCriticalFloor(scoreFindings(observed, LIVE_K), observed);

  const confidence = computeConfidence(input.context);
  const combinedRisk = combine(staticRisk, liveRisk, input.context.liveSessionRan);

  const perDevice = (input.devices ?? []).map((device) => {
    const deviceFindings = [...input.liveFindings, ...input.correlatedFindings].filter((f) =>
      f.tags.includes(`device:${device.role}`),
    );
    return {
      ...device,
      osKills: device.osKills ?? 0,
      score: scoreFindings(deviceFindings, LIVE_K),
    };
  });

  const priority = prioritize([
    ...input.correlatedFindings,
    ...input.liveFindings,
    ...input.staticFindings,
  ]);

  return {
    staticRisk,
    liveRisk,
    combinedRisk,
    confidence,
    perDevice,
    priority,
    headline: buildHeadline(combinedRisk, confidence, perDevice, input.context),
  };
}

/**
 * Accumulate impact, then map through a saturating curve.
 *
 * impact = severity weight x confidence. Summing means many small problems can
 * still add up to a real risk; saturating means they can never eclipse a
 * genuine critical finding, and the score stays interpretable at the top end.
 */
export function scoreFindings(findings: Finding[], k: number): RiskScore {
  const contributors = findings
    .map((f) => ({
      findingId: f.id,
      title: f.title,
      impact: SEVERITY_WEIGHT[f.severity] * clamp01(f.confidence),
    }))
    .filter((c) => c.impact > 0)
    .sort((a, b) => b.impact - a.impact);

  const total = contributors.reduce((acc, c) => acc + c.impact, 0);
  const value = Math.round(100 * (1 - Math.exp(-total / k)));

  return {
    value,
    band: bandFor(value),
    contributors: contributors.slice(0, 10),
  };
}

/** Raise the live score to the critical band when a critical was confirmed. */
function applyConfirmedCriticalFloor(risk: RiskScore, findings: Finding[]): RiskScore {
  const confirmed = findings.some(
    (f) => f.severity === 'critical' && f.confidence >= CONFIRMED_CRITICAL_CONFIDENCE,
  );
  if (!confirmed || risk.value >= CONFIRMED_CRITICAL_FLOOR) return risk;
  return { ...risk, value: CONFIRMED_CRITICAL_FLOOR, band: bandFor(CONFIRMED_CRITICAL_FLOOR) };
}

/**
 * Blend static and live.
 *
 * When a live session ran, measurement dominates - but static findings still
 * matter, because they describe risk the particular session may not have
 * exercised. Without a live session the static score is discounted, since
 * nothing has been confirmed.
 *
 * The combined score is floored at the live score: static findings can only
 * *raise* the estimate. A clean static scan is not evidence against something
 * we watched happen, so it must never pull a measured result downwards.
 */
function combine(staticRisk: RiskScore, liveRisk: RiskScore, liveSessionRan: boolean): RiskScore {
  if (!liveSessionRan) {
    const value = Math.round(staticRisk.value * 0.8);
    return {
      value,
      band: bandFor(value),
      contributors: staticRisk.contributors,
    };
  }

  const blended = 0.65 * liveRisk.value + 0.35 * staticRisk.value;
  const value = Math.round(Math.max(blended, liveRisk.value));

  return {
    value,
    band: bandFor(value),
    contributors: [...liveRisk.contributors, ...staticRisk.contributors]
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 10),
  };
}

function computeConfidence(ctx: ScoringInput['context']): DataConfidence {
  /*
   * The project-side factors are dropped when the project is not on offer.
   *
   * They exist to explain what is missing, and with the field hidden nothing is
   * missing: telling a reader that causes "cannot be identified" without a
   * project would be reporting the absence of something the tool never asked
   * them for, and docking the confidence score for it would be worse.
   */
  const factors: DataConfidence['factors'] = [
    ...(FEATURES.projectAnalysis
      ? [
          {
            name: 'Unity project source analyzed',
            present: ctx.hasRepository,
            weight: 0.2,
            note: ctx.hasRepository ? undefined : 'Without the project, causes cannot be identified.',
          },
          {
            name: 'Import settings (.meta) available',
            present: ctx.hasMetaFiles,
            weight: 0.1,
            note: ctx.hasMetaFiles ? undefined : 'Texture and audio memory could not be estimated.',
          },
        ]
      : []),
    {
      name: 'APK inspected',
      present: ctx.hasApk,
      weight: 0.1,
    },
    {
      name: 'Live device session captured',
      present: ctx.liveSessionRan,
      weight: 0.25,
      note: ctx.liveSessionRan ? undefined : 'All findings are unverified predictions.',
    },
    {
      name: 'Two or more devices',
      present: ctx.deviceCount >= 2,
      weight: 0.1,
      note:
        ctx.deviceCount >= 2
          ? undefined
          : 'Cannot separate genuine retention from a single device budget.',
    },
    {
      name: 'Repeated flow cycles (3 or more)',
      present: ctx.cycleCount >= 3,
      weight: 0.15,
      note:
        ctx.cycleCount >= 3
          ? undefined
          : 'Recovery deltas need repeats before they are trustworthy.',
    },
    {
      name: 'Session long enough for a growth trend (2 min or more)',
      present: ctx.sessionDurationMs >= 120_000,
      weight: 0.1,
      note:
        ctx.sessionDurationMs >= 120_000
          ? undefined
          : 'Short sessions cannot distinguish growth from load peaks.',
    },
  ];

  /*
   * A share of the weight that was available, not a sum of absolute weights.
   *
   * The weights were chosen to total 1.0 across every factor, so dropping the
   * two project-side ones capped every possible session at 0.7 - a run that
   * captured everything the console asks for read as 70% confident, and the
   * missing 30% was an input nobody was offered.
   *
   * Dividing by the total on offer makes the figure mean "of what could be
   * known here, how much is known", which is what a reader takes it for. With
   * every factor present the total is 1.0 and this is arithmetically identical
   * to the old sum, so nothing changes for a run that does supply a project.
   */
  const available = factors.reduce((acc, f) => acc + f.weight, 0);
  const earned = factors.reduce((acc, f) => acc + (f.present ? f.weight : 0), 0);
  const value = available > 0 ? earned / available : 0;

  const caveats = factors
    .filter((f) => !f.present && f.note)
    .map((f) => `${f.name}: missing. ${f.note}`);

  return { value: clamp01(value), factors, caveats };
}

/**
 * Priority ordering.
 *
 * Deliberately not the same as severity: a correlated finding with a concrete
 * reproduction is more actionable than an equally severe static hypothesis, so
 * it ranks higher even at identical severity.
 */
export function prioritize(findings: Finding[]): PrioritizedFinding[] {
  const sourceWeight: Record<Finding['source'], number> = {
    correlated: 1.4,
    live: 1.2,
    static: 1.0,
  };

  const scored = findings.map((finding) => {
    const base = SEVERITY_WEIGHT[finding.severity] * clamp01(finding.confidence);
    const sizeBoost = finding.estimatedBytes ? Math.log10(1 + finding.estimatedBytes / (1024 * 1024)) / 3 : 0;
    const evidenceBoost = Math.min(0.3, finding.evidence.length * 0.03);
    const priorityScore = base * sourceWeight[finding.source] * (1 + sizeBoost + evidenceBoost);

    return {
      finding,
      priorityScore,
      rank: 0,
      reason: describePriority(finding, sizeBoost > 0),
    };
  });

  return scored
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function describePriority(finding: Finding, hasSize: boolean): string {
  const parts: string[] = [];
  if (finding.source === 'correlated') {
    parts.push('measured on device and explained by a specific cause in the project');
  } else if (finding.source === 'live') {
    parts.push('directly measured on a real device');
  } else {
    parts.push('predicted from the project, not yet confirmed on device');
  }
  parts.push(`${finding.severity} severity`);
  parts.push(`${Math.round(finding.confidence * 100)}% confidence`);
  if (hasSize && finding.estimatedBytes) {
    parts.push(`about ${(finding.estimatedBytes / (1024 * 1024)).toFixed(0)} MB at stake`);
  }
  return parts.join(', ');
}

function buildHeadline(
  combined: RiskScore,
  confidence: DataConfidence,
  perDevice: DeviceRisk[],
  ctx: ScoringInput['context'],
): string {
  // Only claim an OS kill where the system log actually recorded one; a fatal
  // crash is a different failure and a process that merely vanished is not a
  // failure at all.
  const killed = perDevice.filter((d) => d.osKills > 0);
  if (killed.length > 0) {
    const names = killed.map((d) => `Device ${d.role} (${d.model})`).join(' and ');
    return `Critical: the game was terminated by the OS on ${names} during testing.`;
  }

  const crashed = perDevice.filter((d) => d.processDeaths > 0);
  if (crashed.length > 0) {
    const names = crashed.map((d) => `Device ${d.role} (${d.model})`).join(' and ');
    return `Critical: the game stopped with a fatal error on ${names} during testing.`;
  }

  const bandText: Record<RiskBand, string> = {
    critical: 'Critical OOM risk',
    high: 'High OOM risk',
    moderate: 'Moderate OOM risk',
    low: 'Low OOM risk',
  };

  const base = `${bandText[combined.band]} (score ${combined.value}/100)`;
  if (!ctx.liveSessionRan) {
    return `${base}, based on static analysis only - no device session was captured, so nothing has been confirmed on hardware.`;
  }
  if (confidence.value < 0.6) {
    return `${base}, but the evidence base is incomplete (${Math.round(confidence.value * 100)}% of the intended checks ran).`;
  }
  return `${base}, based on static analysis plus a live device session.`;
}

export function bandFor(value: number): RiskBand {
  if (value >= 75) return 'critical';
  if (value >= 50) return 'high';
  if (value >= 25) return 'moderate';
  return 'low';
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function severityLabel(severity: Severity): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}
