/**
 * The summary cut, as data.
 *
 * The summary answers six questions in the order a reader asks them: is the game
 * healthy, how bad is the risk, how much of it did we actually check, what are
 * the headline numbers, what is the single biggest problem, and what did playing
 * it feel like. Everything that explains those answers belongs in the complete
 * report.
 *
 * This module derives nothing new. Every figure here already exists in the
 * report - the risk score, the confidence, the budget verdict, the frame-rate
 * ratings, the priority ordering - and it only chooses which of them the summary
 * shows and what word goes beside each one. Thresholds come from `deviceHealth`
 * and `memoryBudget`, so a rating in the summary and the same rating in the
 * complete report can never disagree.
 *
 * It is shared by the print/PDF renderer and the Markdown renderer for the same
 * reason the two cuts share the report itself: two renderers deriving the same
 * headline separately is two chances to say different things.
 */
import { rateFps, rateJanks, type Rating } from '../telemetry/deviceHealth.js';
import { VERDICT_LABEL } from '../analysis/memoryBudget.js';
import { formatClock } from '../analysis/diagnostics.js';
import { CONFIDENCE_LABEL, type ConfidenceLevel } from '../analysis/confidence.js';
import { fmt, formatDuration } from './markdown.js';
import { subsystemRows, type SubsystemStatus } from './performance.js';
import type { AnalysisReport } from './model.js';

type Finding = AnalysisReport['findings']['static'][number];

/** Traffic light. `unknown` means not measured, which is not the same as fine. */
export type Tone = 'good' | 'watch' | 'bad' | 'unknown';

export interface SnapshotKpi {
  key: 'memory' | 'fps' | 'heat' | 'stutter';
  /** The card heading: MEMORY, FPS, HEAT, STUTTER. */
  label: string;
  /** The big number, already formatted. Null where the run did not measure it. */
  value: string | null;
  /** What the number is: Peak, Average, Janks. */
  caption: string;
  /** The word beside the number, from the tool's existing ratings. */
  status: string;
  tone: Tone;
  /** The plain-English area this card speaks for, used to word the conclusions. */
  area: string;
}

export interface SnapshotIssue {
  /** The size at stake, when the finding carries one. */
  headline: string | null;
  /** A short name for the problem - "Memory spike", not the full finding title. */
  kind: string;
  /** One short supporting phrase: how fast, or where. */
  detail: string | null;
  /** "HIGH PRIORITY", from the finding's own severity. */
  priority: string;
  tone: Tone;
}

export interface SnapshotExperience {
  /** Short facts: "59 FPS average", "6 janks", "60 Hz display". */
  facts: string[];
  /** SMOOTH / UNEVEN / CHOPPY, from the frame-rate and stutter ratings. */
  verdict: string;
  tone: Tone;
}

/**
 * One subsystem, in as few words as a one-page summary can afford.
 *
 * The status and the figure both come from `performance.ts`, which is the one
 * place that decides when 62% GPU utilisation is worth flagging. The long
 * "against what" text it also produces is deliberately dropped here - the
 * summary states what, and the complete report explains it.
 */
export interface SnapshotSubsystem {
  name: string;
  /** The figure, a few words. Null where the run could not measure it. */
  value: string | null;
  status: string;
  tone: Tone;
}

/**
 * What was holding the frame up, in one line.
 *
 * The single most actionable sentence the tool produces, so it earns a place on
 * a page that has room for very little. `basis` is not decoration: a verdict
 * from the engine's own per-frame timings and one inferred from five-second CPU
 * samples deserve different amounts of trust, and a reader cannot tell them
 * apart unless the page says which it is.
 */
export interface SnapshotLimit {
  headline: string;
  tone: Tone;
  /** "Measured" or "Inferred", so the confidence is legible at a glance. */
  basis: string;
}

/**
 * The worst frame collapse and what coincided with it.
 *
 * One entry only. The complete report lists every episode; a summary that
 * listed six would stop being a summary, and the worst one is the one a player
 * noticed.
 */
export interface SnapshotRootCause {
  /** `m:ss` into the session. */
  at: string;
  /** The lettered badge on the frame-rate chart, when there is one. */
  letter: string | null;
  symptom: string;
  /** What the other subsystems were doing, joined into one phrase. */
  coincided: string | null;
  fix: string;
  tone: Tone;
  /** The marker the operator pressed, when there was one. */
  during: string | null;
  /**
   * The fall in one phrase: "58 to 18 fps for 3 s".
   *
   * The summary's whole account of the event is a sentence, so the numbers have
   * to be in it. "Frame rate fell to 18 fps" leaves a lead unable to tell a
   * collapse from a slow game; naming both ends and the duration is what makes
   * the one line decidable.
   */
  magnitude: string | null;
  /** How sure the tool is, in the shared wording. */
  confidence: string;
}

/** The CI gate, reduced to what a lead needs: did it pass, and what failed. */
export interface SnapshotGate {
  status: string;
  tone: Tone;
  headline: string;
  /** Names of the checks that failed, for the page to list. */
  failed: string[];
  /** How many checks could not be run - a green gate with gaps is not green. */
  skipped: number;
  /** Which device class the thresholds came from. */
  tier: string | null;
}

export interface Snapshot {
  gameName: string;
  eyebrow: string;
  risk: { value: number; band: string; label: string; tone: Tone };
  confidence: { percent: number; label: string; tone: Tone };
  /** One line under the status: which area the risk is about. */
  concern: string;
  kpis: SnapshotKpi[];
  /**
   * Pass/fail against this device class, when the gate ran.
   *
   * Near the top of the page because "did this build pass?" is the first
   * question a lead asks, and it is answerable in one word.
   */
  gate: SnapshotGate | null;
  /** Null when neither the engine nor the OS could say what limited the frame. */
  limit: SnapshotLimit | null;
  /** GPU, rendering, CPU, storage and audio - one line each. */
  subsystems: SnapshotSubsystem[];
  /** Null when the run found nothing worth acting on. */
  issue: SnapshotIssue | null;
  /** The worst frame collapse, with what coincided with it. */
  rootCause: SnapshotRootCause | null;
  /** Null when no frame-rate data was captured. */
  experience: SnapshotExperience | null;
  device: string | null;
  session: string | null;
  /** One or two short warnings that must not be lost to the summary's brevity. */
  alerts: string[];
  bottomLine: string;
}

const BAND_TONE: Record<string, Tone> = {
  low: 'good',
  moderate: 'watch',
  high: 'bad',
  critical: 'bad',
};

const RATING_TONE: Record<Rating, Tone> = {
  excellent: 'good',
  good: 'good',
  fair: 'watch',
  poor: 'bad',
  unknown: 'unknown',
};

const BUDGET_TONE: Record<string, Tone> = { green: 'good', yellow: 'watch', red: 'bad' };

const THERMAL_STATUS_WORD: Record<string, string> = {
  cool: 'Cool',
  warm: 'Warm',
  hot: 'Hot',
  throttling: 'Throttling',
  unknown: 'Not measured',
};

const THERMAL_TONE: Record<string, Tone> = {
  cool: 'good',
  warm: 'watch',
  hot: 'bad',
  throttling: 'bad',
  unknown: 'unknown',
};

/** Frame rate in words. The thresholds behind them are `rateFps`'s, not new ones. */
const FPS_WORD: Record<Rating, string> = {
  excellent: 'Very smooth',
  good: 'Smooth',
  fair: 'Uneven',
  poor: 'Choppy',
  unknown: 'Not measured',
};

/** Stutter in words, on `rateJanks`'s per-minute thresholds. */
const JANK_WORD: Record<Rating, string> = {
  excellent: 'Very rare',
  good: 'Good',
  fair: 'Noticeable',
  poor: 'Frequent',
  unknown: 'Not measured',
};

/**
 * A short name for a problem, per rule.
 *
 * The finding titles are written for a report that explains itself - "Memory
 * spike of 505.1 MB on Device A" - and repeating the size and the device beside
 * a figure that already states both is noise. Anything not named here falls back
 * to the title with the device and the size trimmed off.
 */
const ISSUE_KIND: Record<string, string> = {
  'LIVE.SPIKE': 'Memory spike',
  'LIVE.SUSTAINED_GROWTH': 'Memory keeps climbing',
  'LIVE.BASELINE_CLIMB': 'Memory not released between runs',
  'LIVE.RECOVERY_FAILURE': 'Memory not released after closing',
  'LIVE.SCREEN_RETENTION': 'A screen holds its memory after closing',
  'LIVE.DEVICE_PRESSURE': 'The device ran low on memory',
  'LIVE.PROCESS_TERMINATED': 'The system killed the game',
  'LIVE.CRASH': 'Crash during play',
  'LIVE.BUDGET_EXCEEDED': 'Over the memory budget',
  'BUILD.32BIT_ONLY': '32-bit build ceiling',
  'BUILD.LARGE_HEAP': 'Large heap not requested',
  'BUILD.MONO_BACKEND': 'Mono scripting backend',
  'BUILD.CONTENT_BUDGET': 'Content over budget',
  'UNITY.SCENE.HEAVY': 'Heavy scene',
};

/** Prefix fallbacks, so a new rule in a known family still gets a short name. */
const ISSUE_KIND_PREFIX: Array<[string, string]> = [
  ['UNITY.TEXTURE', 'Texture memory'],
  ['UNITY.AUDIO', 'Audio memory'],
  ['UNITY.MESH', 'Mesh memory'],
  ['UNITY.RENDER_TEXTURE', 'Render texture memory'],
  ['CODE.', 'Memory held by code'],
];

/** The area a finding speaks for, so the conclusions can name it in plain words. */
const RULE_AREA: Record<string, string> = {
  'LIVE.CRASH': 'Stability',
  'LIVE.PROCESS_TERMINATED': 'Stability',
};

export function buildSnapshot(report: AnalysisReport): Snapshot {
  const device = report.devices[0] ?? null;
  const session = report.session;
  const risk = report.verdict.combinedRisk;
  const confidenceValue = report.verdict.confidence.value;

  const kpis = buildKpis(report);
  const issue = buildIssue(report);
  const experience = buildExperience(report);
  const gate = buildGate(report);

  const measured = kpis.filter((k) => k.tone !== 'unknown');
  const problems = measured.filter((k) => k.tone === 'bad').map((k) => k.area);
  const healthy = measured.filter((k) => k.tone === 'good').map((k) => k.area);

  // The area the risk is about comes from the finding the tool itself ranked
  // first, not from the cards: a game can sit inside every budget and still
  // carry a moderate score because of one jump the run caught.
  const topArea = report.priority[0] ? areaOf(report.priority[0].finding) : null;
  const concernAreas = unique([...(topArea ? [topArea] : []), ...problems]).slice(0, 2);

  return {
    gameName: report.subject.gameName,
    eyebrow: 'Performance Snapshot · Android',
    risk: {
      value: risk.value,
      band: risk.band,
      label: `${risk.band.toUpperCase()} RISK`,
      tone: BAND_TONE[risk.band] ?? 'unknown',
    },
    confidence: {
      percent: Math.round(confidenceValue * 100),
      label: confidenceWord(confidenceValue),
      tone: confidenceValue >= 0.6 ? 'good' : confidenceValue >= 0.4 ? 'watch' : 'bad',
    },
    concern: concernLine(concernAreas, measured.length > 0),
    kpis,
    gate,
    limit: buildLimit(report),
    subsystems: buildSubsystems(report),
    issue,
    rootCause: buildRootCause(report),
    experience,
    device: device
      ? `${device.manufacturer} ${device.model} · ${fmt(device.totalRamBytes)} RAM`
      : null,
    session: session
      ? `${formatDuration(session.durationMs)} gameplay · ${report.devices.length} ` +
        `device${report.devices.length === 1 ? '' : 's'} tested`
      : null,
    alerts: buildAlerts(report),
    bottomLine: bottomLine(report, concernAreas, problems, healthy, confidenceValue, gate),
  };
}

/* -------------------------------------------------------------------------- */
/* The four cards                                                             */
/* -------------------------------------------------------------------------- */

function buildKpis(report: AnalysisReport): SnapshotKpi[] {
  const device = report.devices[0] ?? null;
  const fps = device?.fps ?? null;
  const thermal = device?.thermal ?? null;
  const durationMs = report.session?.durationMs ?? 0;

  // Memory: the peak, judged by the budget the tool already computed for this
  // handset's RAM tier. No threshold is introduced here.
  const budget = device?.budget ?? null;
  const memory: SnapshotKpi = {
    key: 'memory',
    label: 'Memory',
    value: device?.peakBytes != null ? fmt(device.peakBytes) : null,
    caption: 'Peak',
    status: budget ? VERDICT_LABEL[budget.verdict] : 'Not measured',
    tone: budget ? (BUDGET_TONE[budget.verdict] ?? 'unknown') : 'unknown',
    area: 'Memory',
  };

  // Frame rate, rated as a share of what the panel allows - `rateFps`'s rule.
  const fpsRating: Rating =
    fps?.averageFps != null ? rateFps(fps.averageFps, fps.displayHz) : 'unknown';
  const frame: SnapshotKpi = {
    key: 'fps',
    label: 'FPS',
    value: fps?.averageFps != null ? `${num(fps.averageFps)} FPS` : null,
    caption: 'Average',
    status: FPS_WORD[fpsRating],
    tone: RATING_TONE[fpsRating],
    area: 'Rendering',
  };

  const heat: SnapshotKpi = {
    key: 'heat',
    label: 'Heat',
    value: thermal?.peakC != null ? `${thermal.peakC.toFixed(1)}°C` : null,
    caption: 'Peak',
    status: THERMAL_STATUS_WORD[thermal?.verdict ?? 'unknown'] ?? 'Not measured',
    tone: thermal?.peakC != null ? (THERMAL_TONE[thermal.verdict] ?? 'unknown') : 'unknown',
    area: 'Heat',
  };

  // Stutter, rated per minute rather than as a total - `rateJanks`'s rule.
  const jankRating: Rating =
    fps?.janks != null && durationMs > 0 ? rateJanks(fps.janks, durationMs) : 'unknown';
  const stutter: SnapshotKpi = {
    key: 'stutter',
    label: 'Stutter',
    value: fps?.janks != null ? String(fps.janks) : null,
    caption: 'Janks',
    status: JANK_WORD[jankRating],
    tone: RATING_TONE[jankRating],
    area: 'Smoothness',
  };

  return [memory, frame, heat, stutter];
}

/* -------------------------------------------------------------------------- */
/* Build check, the limiting subsystem, and the five subsystem lines           */
/* -------------------------------------------------------------------------- */

const GATE_TONE: Record<string, Tone> = { pass: 'good', warn: 'watch', fail: 'bad' };

function buildGate(report: AnalysisReport): SnapshotGate | null {
  const gate = report.qualityGate;
  if (!gate) return null;

  // Nothing measured is not a pass. A gate whose every check was skipped would
  // otherwise print "PASS" for a run that tested nothing, which is the single
  // most damaging thing this page could say.
  const measured = gate.summary.failed + gate.summary.warned + gate.summary.passed;
  if (measured === 0) {
    return {
      status: 'NOT CHECKED',
      tone: 'unknown',
      headline: `None of the ${gate.summary.skipped} checks could be run on this session.`,
      failed: [],
      skipped: gate.summary.skipped,
      tier: gate.devices[0]?.tier ?? null,
    };
  }

  const failedLabels = gate.devices
    .flatMap((d) => d.checks)
    .filter((c) => c.status === 'fail')
    .map((c) => c.label);

  return {
    status: gate.status.toUpperCase(),
    tone: GATE_TONE[gate.status] ?? 'unknown',
    headline:
      gate.status === 'fail'
        ? `${gate.summary.failed} check${gate.summary.failed === 1 ? '' : 's'} failed for this device class.`
        : gate.status === 'warn'
          ? `Nothing failed, but ${gate.summary.warned} check${gate.summary.warned === 1 ? ' is' : 's are'} close to its limit.`
          : `All ${gate.summary.passed} checks that could be measured passed.`,
    failed: unique(failedLabels).slice(0, 4),
    skipped: gate.summary.skipped,
    tier: gate.devices[0]?.tier ?? null,
  };
}

const LIMIT_TONE: Record<string, Tone> = {
  'cpu-main': 'watch',
  'cpu-render': 'watch',
  gpu: 'watch',
  storage: 'watch',
  thermal: 'bad',
  balanced: 'good',
  unknown: 'unknown',
};

function buildLimit(report: AnalysisReport): SnapshotLimit | null {
  const b = report.devices[0]?.bottleneck ?? null;
  // Nothing useful to say beats a section whose content is a shrug - the
  // complete report's limitations already explain what was missing.
  if (!b || (b.kind === 'unknown' && b.contributors.length === 0)) return null;

  return {
    headline: b.headline,
    tone: LIMIT_TONE[b.kind] ?? 'unknown',
    basis:
      b.basis === 'engine-thread-times'
        ? 'Measured from the engine’s own per-frame timings'
        : b.basis === 'os-signals'
          ? 'Inferred from CPU and GPU load, not measured per frame'
          : 'Only partially measurable on this run',
  };
}

const SUBSYSTEM_TONE: Record<SubsystemStatus, Tone> = {
  ok: 'good',
  watch: 'watch',
  problem: 'bad',
  unmeasured: 'unknown',
};

const SUBSYSTEM_WORD: Record<SubsystemStatus, string> = {
  ok: 'OK',
  watch: 'Watch',
  problem: 'Problem',
  unmeasured: 'Not measured',
};

/**
 * The five subsystems, one line each.
 *
 * The rows and their verdicts come from `performance.ts` so the summary and the
 * complete report grade them identically; only the long explanation is dropped.
 * Rows that could not be measured stay in the list and say so - removing them
 * would make a run that measured two subsystems look like a run where three
 * were fine.
 */
function buildSubsystems(report: AnalysisReport): SnapshotSubsystem[] {
  const device = report.devices[0];
  if (!device) return [];

  return subsystemRows(device).map((row) => ({
    name: row.subsystem,
    value: row.status === 'unmeasured' ? null : row.headline,
    status: SUBSYSTEM_WORD[row.status],
    tone: SUBSYSTEM_TONE[row.status],
  }));
}

/**
 * The worst frame collapse, and what coincided with it.
 *
 * Worded as coincidence throughout, because that is all a correlation across
 * subsystems can support - the page says "at the same moment", never "because
 * of". A diagnosis with nothing coincident still appears: "the frame rate fell
 * and we cannot say why" is a useful sentence and the recommendation says what
 * to add to the build to find out.
 */
function buildRootCause(report: AnalysisReport): SnapshotRootCause | null {
  // Already ranked worst-first by the diagnostic engine, so taking the head is
  // taking the tool's own judgement rather than forming a second one.
  const worst = report.diagnostics?.[0];
  if (!worst) return null;

  const coincided =
    worst.causes.length > 0
      ? worst.causes.slice(0, 2).map((c) => c.statement).join(', and ')
      : null;

  const seconds = worst.durationMs ? Math.max(1, Math.round(worst.durationMs / 1000)) : null;
  const magnitude =
    worst.beforeFps != null && worst.lowestFps != null
      ? `${worst.beforeFps} to ${worst.lowestFps} fps` + (seconds ? ` for about ${seconds} s` : '')
      : null;

  return {
    at: formatClock(worst.atMs),
    letter: worst.letter || null,
    symptom: worst.symptom,
    coincided,
    fix: worst.recommendation,
    tone: worst.severity === 'critical' || worst.severity === 'high' ? 'bad' : 'watch',
    during: worst.nearestMarker,
    magnitude,
    confidence: worst.level
      ? CONFIDENCE_LABEL[worst.level as ConfidenceLevel]
      : CONFIDENCE_LABEL.insufficient,
  };
}

/* -------------------------------------------------------------------------- */
/* The biggest issue                                                          */
/* -------------------------------------------------------------------------- */

function buildIssue(report: AnalysisReport): SnapshotIssue | null {
  // The tool has already decided what to fix first. Taking anything other than
  // its own top-ranked finding would be a second, competing judgement.
  const top = report.priority[0];
  if (!top) return null;

  const f = top.finding;

  return {
    headline: f.estimatedBytes && f.estimatedBytes > 0 ? `+${fmt(f.estimatedBytes)}` : null,
    kind: issueKind(f),
    detail: issueDetail(f, top.reason),
    priority: `${f.severity.toUpperCase()} PRIORITY`,
    tone:
      f.severity === 'critical' || f.severity === 'high'
        ? 'bad'
        : f.severity === 'medium'
          ? 'watch'
          : 'good',
  };
}

function issueKind(f: Finding): string {
  const exact = ISSUE_KIND[f.ruleId];
  if (exact) return exact;

  for (const [prefix, label] of ISSUE_KIND_PREFIX) {
    if (f.ruleId.startsWith(prefix)) return label;
  }

  // Fall back to the title with the parts the summary already shows removed:
  // the device role, and any leading size.
  return f.title
    .replace(/\s+on Device [A-Z]\b/g, '')
    .replace(/\s+of\s+[\d.]+\s*(?:KB|MB|GB)\b/gi, '')
    .trim();
}

/**
 * One supporting phrase.
 *
 * Kept to a phrase on purpose: the summary states what and how big, and the
 * complete report explains it. Never the finding's `subject` where that is a
 * file path - the summary carries no paths.
 */
function issueDetail(f: Finding, reason: string): string | null {
  for (const e of f.evidence) {
    const windowMs = e.data?.['windowMs'];
    if (typeof windowMs === 'number' && windowMs > 0) {
      return `in ${(windowMs / 1000).toFixed(1)} seconds`;
    }
  }

  // A marker the operator pressed during play says where it happened, and is
  // the operator's own words rather than anything from the project tree.
  if ((f.source === 'live' || f.source === 'correlated') && f.subject) {
    const marker = f.subject;
    const looksLikePath =
      marker.includes('/') || marker.includes('\\') || marker.includes('@');
    if (!looksLikePath && marker !== 'unknown state') return `during “${marker}”`;
  }

  return firstClause(reason);
}

/* -------------------------------------------------------------------------- */
/* Gameplay experience                                                        */
/* -------------------------------------------------------------------------- */

function buildExperience(report: AnalysisReport): SnapshotExperience | null {
  const device = report.devices[0];
  const fps = device?.fps ?? null;
  if (!fps || (fps.averageFps == null && fps.janks == null)) return null;

  const durationMs = report.session?.durationMs ?? 0;
  const fpsRating: Rating =
    fps.averageFps != null ? rateFps(fps.averageFps, fps.displayHz) : 'unknown';
  const jankRating: Rating =
    fps.janks != null && durationMs > 0 ? rateJanks(fps.janks, durationMs) : 'unknown';

  const facts = [
    fps.averageFps != null ? `${num(fps.averageFps)} FPS average` : '',
    fps.janks != null ? `${fps.janks} jank${fps.janks === 1 ? '' : 's'}` : '',
    fps.displayHz != null ? `${fps.displayHz} Hz display` : '',
  ].filter(Boolean);

  // The worse of the two ratings decides the word: a steady average with
  // frequent stalls is not a smooth game, and neither is the reverse.
  const worst = worstRating([fpsRating, jankRating]);
  const verdict =
    worst === 'excellent' || worst === 'good'
      ? 'SMOOTH'
      : worst === 'fair'
        ? 'UNEVEN'
        : worst === 'poor'
          ? 'CHOPPY'
          : 'NOT MEASURED';

  return { facts, verdict, tone: RATING_TONE[worst] };
}

/* -------------------------------------------------------------------------- */
/* Words                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Warnings that brevity must not swallow.
 *
 * A summary that fits on a page is worth nothing if the page leaves out that the
 * game was killed, or that nobody ever ran it. Two at most, one line each.
 */
function buildAlerts(report: AnalysisReport): string[] {
  const alerts: string[] = [];

  const killed = report.devices.reduce((n, d) => n + d.processDeaths, 0);
  if (killed > 0) {
    alerts.push(
      `The system killed the game ${killed} time${killed === 1 ? '' : 's'} during this session.`,
    );
  }

  if (report.session === null) {
    alerts.push(
      'The game was never run on a device for this report, so every finding is a prediction.',
    );
  }

  const red = report.devices.find((d) => d.budget?.verdict === 'red');
  if (red) alerts.push('Memory went past what this phone can be relied on to give one app.');

  return alerts.slice(0, 2);
}

function concernLine(areas: string[], anythingMeasured: boolean): string {
  if (areas.length === 0) {
    return anythingMeasured
      ? 'No significant performance concerns were measured'
      : 'Nothing was measured on a device';
  }
  if (areas.length === 1) return `${areas[0]} is the main performance concern`;
  return `${areas[0]} and ${areas[1]!.toLowerCase()} are the main performance concerns`;
}

/**
 * The executive line.
 *
 * Two sentences at most, in words that need no knowledge of Android, Unity or
 * memory allocation. What needs looking at, what does not, and - only when it is
 * low - how much of the intended testing actually happened, because a low score
 * from a thin session must never read as a clean bill of health.
 */
function bottomLine(
  report: AnalysisReport,
  concernAreas: string[],
  problemAreas: string[],
  healthyAreas: string[],
  confidence: number,
  gate: SnapshotGate | null,
): string {
  const lowConfidence = confidence < 0.6;
  const caveat = lowConfidence ? ', but testing confidence is currently low' : '';

  const first =
    concernAreas.length > 0
      ? `${concernAreas[0]} is the main area requiring investigation.`
      : report.session === null
        ? 'Nothing was measured on a device, so this report cannot yet say whether the game is healthy.'
        : 'No significant problems were measured in this session.';

  // What else the reader has to know in one more sentence: the other areas that
  // are failing if there are any, otherwise the ones that are fine - and either
  // way, whether the run was thorough enough to be believed.
  const alsoBad = problemAreas.filter((a) => a !== concernAreas[0]);
  const stillGood = healthyAreas.filter((a) => !concernAreas.includes(a));

  /*
   * A failed build check outranks "these areas look healthy".
   *
   * The four cards grade memory, frame rate, heat and stutter against their own
   * ratings, and all four can sit inside them while the build still misses a
   * threshold for its device class - draw calls, audio dropouts and reads that
   * cost frames are not on any card. Letting the healthy clause win in that
   * case put "rendering, heat and smoothness look healthy" directly under a red
   * FAIL banner, which is the page contradicting itself.
   */
  const second = alsoBad.length
    ? `${sentenceList(alsoBad)} also need attention${caveat}.`
    : gate?.tone === 'bad'
      ? `The build also failed ${namedChecks(gate.failed)} for this device class${caveat}.`
      : stillGood.length
        ? `${sentenceList(stillGood)} look healthy${caveat}.`
        : lowConfidence
          ? 'Testing confidence is currently low, so treat this as an early indication rather than a verdict.'
          : '';

  return [first, second].filter(Boolean).join(' ');
}

/**
 * The failed checks, named.
 *
 * A count on its own - "missed 1 performance check" - tells a reader they have
 * a problem and not what it is, which on a page whose whole purpose is to be
 * acted on without opening the report is the one thing it must not do. The
 * names are quoted rather than folded into the grammar, because a check called
 * "Process survived the session" cannot be read as "the process survived the
 * session check".
 *
 * Two names at most. A third would push the bottom line past the two sentences
 * it is allowed, and the build check card above lists every one of them.
 */
function namedChecks(failed: string[]): string {
  if (failed.length === 0) return 'one or more performance checks';
  if (failed.length === 1) return `the “${failed[0]}” check`;
  if (failed.length === 2) return `the “${failed[0]}” and “${failed[1]}” checks`;
  return `the “${failed[0]}” check and ${failed.length - 1} others`;
}

function confidenceWord(value: number): string {
  if (value >= 0.8) return 'nearly everything intended was checked';
  if (value >= 0.6) return 'most of the intended checks ran';
  if (value >= 0.4) return 'a large part of the testing did not happen';
  return 'an early indication only';
}

function areaOf(f: Finding): string {
  return RULE_AREA[f.ruleId] ?? 'Memory';
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const RATING_ORDER: Rating[] = ['poor', 'fair', 'good', 'excellent'];

function worstRating(ratings: Rating[]): Rating {
  const known = ratings.filter((r) => r !== 'unknown');
  if (known.length === 0) return 'unknown';
  return known.reduce((worst, r) =>
    RATING_ORDER.indexOf(r) < RATING_ORDER.indexOf(worst) ? r : worst,
  );
}

/** A number that prints as a whole one when it is whole, and to a tenth when not. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sentenceList(items: string[]): string {
  const words = items.map((item, i) => (i === 0 ? item : item.toLowerCase()));
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The first clause of a reason, so a supporting line stays one line. */
function firstClause(text: string): string | null {
  const trimmed = text.split(/[;.]/)[0]?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : null;
}
