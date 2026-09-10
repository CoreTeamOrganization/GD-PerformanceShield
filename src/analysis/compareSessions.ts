/**
 * Comparing two gameplay sessions.
 *
 * The whole design rests on one fact: **time is not a comparable axis**. Sixty
 * seconds into one playthrough is a different game state from sixty seconds into
 * another, so overlaying two curves produces a picture that looks authoritative
 * and means nothing. Markers are comparable, because a marker names a game
 * state. Everything here therefore joins on the marker label and refuses to
 * compare anything that only lines up by clock.
 *
 * The second fact: a session-wide peak measures the tester, not the build. A
 * longer playthrough visits more screens and peaks higher. Peak is reported only
 * where the two runs actually covered the same screens, and labelled as
 * unusable when they did not.
 *
 * The third: run-to-run variance is real and unmeasured until someone measures
 * it. Rather than invent a threshold, a change smaller than the established
 * noise floor is reported as inconclusive, and with no floor established the
 * whole comparison says so.
 */
import type { AnalysisReport } from '../report/model.js';

// ---------------------------------------------------------------------------
// Gating - is this comparison meaningful at all?
// ---------------------------------------------------------------------------

export type GateLevel = 'block' | 'warn' | 'note';

export interface Gate {
  level: GateLevel;
  /** Short label for the UI chip. */
  key: string;
  message: string;
}

/**
 * Decide whether two runs may be compared, and how loudly to qualify it.
 *
 * `block` means the numbers are not commensurable and the tool must not put
 * them side by side. `warn` means they are comparable but something material
 * differs. `note` records a difference that is the *point* of the comparison -
 * a different build version, most obviously.
 */
export function gateComparison(a: AnalysisReport, b: AnalysisReport): Gate[] {
  const gates: Gate[] = [];

  const pkgA = a.subject.packageName;
  const pkgB = b.subject.packageName;
  if (pkgA && pkgB && pkgA !== pkgB) {
    gates.push({
      level: 'block',
      key: 'package',
      message: `Different apps: ${pkgA} and ${pkgB}. There is nothing to compare.`,
    });
  }

  const devA = a.devices[0];
  const devB = b.devices[0];

  if (!devA || !devB) {
    gates.push({
      level: 'block',
      key: 'device',
      message: 'One of these runs recorded no device, so there is no live capture to compare.',
    });
    return gates;
  }

  if (devA.model !== devB.model || devA.totalRamBytes !== devB.totalRamBytes) {
    gates.push({
      level: 'block',
      key: 'device',
      message:
        `Different hardware: ${devA.manufacturer} ${devA.model} and ${devB.manufacturer} ${devB.model}. ` +
        'GPU drivers attribute memory differently and the per-app budget changes with RAM, so the ' +
        'figures are not commensurable.',
    });
  } else if (devA.serial !== devB.serial) {
    gates.push({
      level: 'warn',
      key: 'device',
      message:
        `Same model but a different handset (${devA.serial} and ${devB.serial}). Driver version and ` +
        'thermal state can differ; treat small changes as noise.',
    });
  }

  if (devA.androidVersion !== devB.androidVersion || devA.sdkInt !== devB.sdkInt) {
    gates.push({
      level: 'warn',
      key: 'android',
      message:
        `Different Android versions (${devA.androidVersion} and ${devB.androidVersion}). The memory ` +
        'categories are aggregated differently between releases, so category-level changes may be ' +
        'the OS rather than the build.',
    });
  }

  // One run on a cleared phone and one on a busy phone are not comparable
  // measurements: the low-memory killer decides from everything resident, so
  // the same build gets a different result.
  const freshA = Boolean(devA.freshStart);
  const freshB = Boolean(devB.freshStart);
  if (freshA !== freshB) {
    gates.push({
      level: 'warn',
      key: 'freshStart',
      message:
        `One run started on a cleared phone and the other did not (${freshA ? 'earlier' : 'later'} ` +
        'was cleared). Memory available at launch differed, so part of any change here is the ' +
        'state of the device rather than the build. Clear the phone in both runs, or neither.',
    });
  }

  const verA = a.subject.versionName ?? '?';
  const verB = b.subject.versionName ?? '?';
  if (verA !== verB) {
    gates.push({
      level: 'note',
      key: 'build',
      message: `Comparing build ${verA} against ${verB}.`,
    });
  } else {
    gates.push({
      level: 'note',
      key: 'build',
      message:
        `Both runs are build ${verA}. Differences here are run-to-run variance, which makes this ` +
        'pair usable as a noise-floor baseline.',
    });
  }

  return gates;
}

export function isBlocked(gates: Gate[]): boolean {
  return gates.some((g) => g.level === 'block');
}

// ---------------------------------------------------------------------------
// Noise floor
// ---------------------------------------------------------------------------

export interface NoiseFloor {
  /** Absolute floor in bytes. */
  bytes: number;
  /** Relative floor as a fraction of the earlier value. */
  fraction: number;
  /** How it was arrived at, stated so a reader can judge it. */
  source: string;
}

/**
 * Derive a noise floor from two runs of the *same* build.
 *
 * Everything those two runs disagree about is variance by definition, so the
 * largest per-screen disagreement is the smallest change a later comparison can
 * honestly call real. This is measured rather than assumed: a hard-coded
 * threshold would be a guess about someone else's device and driver.
 */
export function deriveNoiseFloor(a: AnalysisReport, b: AnalysisReport): NoiseFloor | null {
  const rows = joinScreens(a, b);
  const measurable = rows.filter(
    (r) => r.beforeRetained !== null && r.afterRetained !== null,
  );
  if (measurable.length === 0) return null;

  let worstBytes = 0;
  let worstFraction = 0;
  for (const row of measurable) {
    const delta = Math.abs((row.afterRetained ?? 0) - (row.beforeRetained ?? 0));
    worstBytes = Math.max(worstBytes, delta);
    const base = Math.abs(row.beforeRetained ?? 0);
    if (base > 0) worstFraction = Math.max(worstFraction, delta / base);
  }

  return {
    bytes: worstBytes,
    fraction: worstFraction,
    source:
      `Measured from two runs of the same build across ${measurable.length} shared screen(s). ` +
      'Any later change smaller than this cannot be told apart from run-to-run variance.',
  };
}

/** Is a change big enough to be worth reporting as a change? */
export function isConclusive(
  before: number | null,
  after: number | null,
  floor: NoiseFloor | null,
): boolean {
  if (before === null || after === null) return false;
  if (!floor) return true; // Nothing to judge against; the caller says so.

  const delta = Math.abs(after - before);
  const relative = Math.abs(before) > 0 ? delta / Math.abs(before) : Infinity;
  return delta > floor.bytes || relative > floor.fraction;
}

// ---------------------------------------------------------------------------
// Joining on markers
// ---------------------------------------------------------------------------

export interface ScreenRow {
  screen: string;
  /** Retained bytes after leaving the screen - the headline comparable. */
  beforeRetained: number | null;
  afterRetained: number | null;
  beforePeak: number | null;
  afterPeak: number | null;
  /** Present in both runs, or only one. */
  presence: 'both' | 'before-only' | 'after-only';
}

/**
 * Join screen visits by name.
 *
 * A screen is the unit of comparison because it is a closed loop: enter, peak,
 * leave, see what did not come back. That measurement does not care what the
 * tester did before or after it, which is exactly why it survives a different
 * playthrough when a session-wide figure does not.
 *
 * Repeat visits to one screen are reduced to the worst retention seen, because
 * the question being asked is whether the screen leaks, not how the tester's
 * particular route through it went.
 */
export function joinScreens(a: AnalysisReport, b: AnalysisReport): ScreenRow[] {
  const before = worstByScreen(a);
  const after = worstByScreen(b);

  const names = [...new Set([...before.keys(), ...after.keys()])].sort();

  return names.map((screen) => {
    const x = before.get(screen);
    const y = after.get(screen);
    return {
      screen,
      beforeRetained: x?.retainedBytes ?? null,
      afterRetained: y?.retainedBytes ?? null,
      beforePeak: x?.peakBytes ?? null,
      afterPeak: y?.peakBytes ?? null,
      presence: x && y ? 'both' : x ? 'before-only' : 'after-only',
    };
  });
}

function worstByScreen(
  report: AnalysisReport,
): Map<string, { retainedBytes: number | null; peakBytes: number | null }> {
  const out = new Map<string, { retainedBytes: number | null; peakBytes: number | null }>();

  for (const visit of report.session?.screenVisits ?? []) {
    const existing = out.get(visit.screen);
    if (!existing) {
      out.set(visit.screen, {
        retainedBytes: visit.retainedBytes,
        peakBytes: visit.peakBytes,
      });
      continue;
    }
    // Worst case wins: a screen that leaked once leaks.
    if ((visit.retainedBytes ?? -Infinity) > (existing.retainedBytes ?? -Infinity)) {
      existing.retainedBytes = visit.retainedBytes;
    }
    if ((visit.peakBytes ?? -Infinity) > (existing.peakBytes ?? -Infinity)) {
      existing.peakBytes = visit.peakBytes;
    }
  }

  return out;
}

export interface CycleRow {
  label: string;
  beforeRecovery: number | null;
  afterRecovery: number | null;
  presence: 'both' | 'before-only' | 'after-only';
}

/** The same join for marker cycles, which cover flows rather than screens. */
export function joinCycles(a: AnalysisReport, b: AnalysisReport): CycleRow[] {
  const pick = (r: AnalysisReport) => {
    const out = new Map<string, number | null>();
    for (const cycle of r.session?.cycles ?? []) {
      const existing = out.get(cycle.label);
      const value = cycle.recoveryDeltaBytes;
      if (existing === undefined || (value ?? -Infinity) > (existing ?? -Infinity)) {
        out.set(cycle.label, value);
      }
    }
    return out;
  };

  const before = pick(a);
  const after = pick(b);
  const labels = [...new Set([...before.keys(), ...after.keys()])].sort();

  return labels.map((label) => ({
    label,
    beforeRecovery: before.get(label) ?? null,
    afterRecovery: after.get(label) ?? null,
    presence:
      before.has(label) && after.has(label) ? 'both' : before.has(label) ? 'before-only' : 'after-only',
  }));
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export type ChangeDirection = 'improved' | 'regressed' | 'unchanged' | 'inconclusive' | 'unknown';

export interface MetricChange {
  label: string;
  before: number | null;
  after: number | null;
  deltaBytes: number | null;
  direction: ChangeDirection;
  /** Why it reads the way it does, for a reader who was not there. */
  note?: string;
}

export interface SessionComparison {
  before: RunSummary;
  after: RunSummary;
  gates: Gate[];
  blocked: boolean;
  noiseFloor: NoiseFloor | null;
  /** Fraction of screens covered by both runs - the coverage of the comparison. */
  markerOverlap: { shared: number; beforeOnly: number; afterOnly: number };
  screens: MetricChange[];
  cycles: MetricChange[];
  /** Peak, reported only where the two runs actually covered the same screens. */
  peak: MetricChange;
  kills: MetricChange;
  /**
   * Frame rate, heat, battery and risk.
   *
   * Grouped as "runtime" because they share one property: unlike per-screen
   * retention these are whole-session figures, so they are only as comparable as
   * the two playthroughs were similar. Coverage above says how similar that was.
   */
  runtime: MetricChange[];
  /**
   * The one caveat that applies to every runtime row, stated once.
   *
   * It used to be attached to each row individually, on the reasoning that a
   * footnote goes unread. In practice it repeated identically under a dozen rows
   * and made the table unreadable, which is worse than being skipped - so it is
   * hoisted, and only genuinely row-specific notes stay inline.
   */
  runtimeCaveat: string | null;
  budget: { before: string | null; after: string | null; direction: ChangeDirection };
  headline: string;
}

export interface RunSummary {
  analysisId: string;
  gameName: string;
  versionName: string | null;
  generatedAt: string;
  device: string;
  deviceRamBytes: number | null;
  androidVersion: string;
  abi: string | null;
  /** Wall-clock start, so a run can be located against a build or a ticket. */
  startedAt: string | null;
  durationMs: number;
  markerCount: number;
}

const BUDGET_RANK: Record<string, number> = { green: 0, yellow: 1, red: 2 };

export interface CompareOptions {
  /** Established from a same-build pair; without it nothing can be called noise. */
  noiseFloor?: NoiseFloor | null;
  /**
   * The frame rate each run was *aiming* for, one per session.
   *
   * Asked of the operator rather than measured, because it is a build setting
   * and not something the device reports. It has to be per-session: a run of a
   * 30 fps build and a run of a 60 fps build produce measured rates that cannot
   * be subtracted from one another, and doing so would report a 30 fps
   * regression where the build simply changed its target.
   */
  targetFps?: { before?: number | null; after?: number | null };
}

export function compareSessions(
  a: AnalysisReport,
  b: AnalysisReport,
  opts: CompareOptions = {},
): SessionComparison {
  const gates = gateComparison(a, b);
  const targets = {
    before: opts.targetFps?.before ?? null,
    after: opts.targetFps?.after ?? null,
  };

  // Two runs aiming at different frame rates cannot have their measured rates
  // subtracted. Said as a warning rather than a block, because the comparison
  // is still valuable - it just has to be read through the achievement row.
  if (targets.before !== null && targets.after !== null && targets.before !== targets.after) {
    gates.push({
      level: 'warn',
      key: 'targetFps',
      message:
        `The two runs aimed at different frame rates (${targets.before} fps and ` +
        `${targets.after} fps). Their measured rates are not comparable directly - read "Frame ` +
        'rate against its own target" below instead, which is the same question asked of both.',
    });
  }
  const blocked = isBlocked(gates);
  const floor = opts.noiseFloor ?? null;

  const screenRows = joinScreens(a, b);
  const shared = screenRows.filter((r) => r.presence === 'both');

  const screens: MetricChange[] = screenRows.map((row) => ({
    label: row.screen,
    before: row.beforeRetained,
    after: row.afterRetained,
    deltaBytes:
      row.beforeRetained !== null && row.afterRetained !== null
        ? row.afterRetained - row.beforeRetained
        : null,
    direction: directionFor(row.beforeRetained, row.afterRetained, floor, row.presence),
    ...(row.presence !== 'both'
      ? {
          note:
            row.presence === 'before-only'
              ? 'Only the earlier run visited this screen, so there is nothing to compare it with.'
              : 'Only the later run visited this screen.',
        }
      : {}),
  }));

  const cycles: MetricChange[] = joinCycles(a, b).map((row) => ({
    label: row.label,
    before: row.beforeRecovery,
    after: row.afterRecovery,
    deltaBytes:
      row.beforeRecovery !== null && row.afterRecovery !== null
        ? row.afterRecovery - row.beforeRecovery
        : null,
    direction: directionFor(row.beforeRecovery, row.afterRecovery, floor, row.presence),
  }));

  const devA = a.devices[0];
  const devB = b.devices[0];

  // Peak is only meaningful when both runs covered the same ground. Otherwise it
  // measures how much of the game the tester walked through.
  const sameGround =
    shared.length > 0 &&
    screenRows.every((r) => r.presence === 'both');

  const peak: MetricChange = {
    label: 'Session peak',
    before: devA?.peakBytes ?? null,
    after: devB?.peakBytes ?? null,
    deltaBytes:
      devA?.peakBytes != null && devB?.peakBytes != null ? devB.peakBytes - devA.peakBytes : null,
    direction: sameGround
      ? directionFor(devA?.peakBytes ?? null, devB?.peakBytes ?? null, floor, 'both')
      : 'unknown',
    note: sameGround
      ? 'Both runs covered the same screens, so the peaks describe the same workload.'
      : 'The two runs did not visit the same screens, so their peaks describe different ' +
        'playthroughs rather than different builds. Use the per-screen rows instead.',
  };

  const killsBefore = devA?.processDeaths ?? null;
  const killsAfter = devB?.processDeaths ?? null;
  const kills: MetricChange = {
    label: 'Process kills',
    before: killsBefore,
    after: killsAfter,
    deltaBytes: killsBefore !== null && killsAfter !== null ? killsAfter - killsBefore : null,
    // A kill is binary and unambiguous; no noise floor applies.
    direction:
      killsBefore === null || killsAfter === null
        ? 'unknown'
        : killsAfter < killsBefore
          ? 'improved'
          : killsAfter > killsBefore
            ? 'regressed'
            : 'unchanged',
  };

  const budgetBefore = devA?.budget?.verdict ?? null;
  const budgetAfter = devB?.budget?.verdict ?? null;
  const budget = {
    before: budgetBefore,
    after: budgetAfter,
    direction:
      budgetBefore === null || budgetAfter === null
        ? ('unknown' as ChangeDirection)
        : BUDGET_RANK[budgetAfter]! < BUDGET_RANK[budgetBefore]!
          ? ('improved' as ChangeDirection)
          : BUDGET_RANK[budgetAfter]! > BUDGET_RANK[budgetBefore]!
            ? ('regressed' as ChangeDirection)
            : ('unchanged' as ChangeDirection),
  };

  return {
    before: summarize(a),
    after: summarize(b),
    runtime: compareRuntime(a, b, sameGround, targets),
    runtimeCaveat: sameGround
      ? null
      : 'The two runs did not cover the same screens, so part of every difference below is the ' +
        'playthrough rather than the build.',
    gates,
    blocked,
    noiseFloor: floor,
    markerOverlap: {
      shared: shared.length,
      beforeOnly: screenRows.filter((r) => r.presence === 'before-only').length,
      afterOnly: screenRows.filter((r) => r.presence === 'after-only').length,
    },
    screens,
    cycles,
    peak,
    kills,
    budget,
    headline: headlineFor({ blocked, gates, screens, kills, budget, shared: shared.length, floor }),
  };
}

/**
 * Frame rate, heat, battery and risk, side by side.
 *
 * Each carries its own sense of "better", which is why this is a set of
 * hand-written rows rather than a loop: more frames per second is better, more
 * degrees is worse, and a risk score moving down is an improvement.
 *
 * All of these are whole-session figures, so they inherit the peak's caveat -
 * they compare builds only to the extent the two playthroughs were alike. Where
 * the runs did not cover the same screens that is said on every row, rather than
 * once in a footnote nobody reads.
 */
function compareRuntime(
  a: AnalysisReport,
  b: AnalysisReport,
  _sameGround: boolean,
  targets: { before: number | null; after: number | null },
): MetricChange[] {
  const devA = a.devices[0];
  const devB = b.devices[0];
  const rows: MetricChange[] = [];

  // No per-row workload note: it is identical on every row and is stated once
  // above the table instead. See `runtimeCaveat`.
  const row = (
    label: string,
    before: number | null | undefined,
    after: number | null | undefined,
    higherIsBetter: boolean,
    note?: string,
  ) => {
    const x = before ?? null;
    const y = after ?? null;
    const delta = x !== null && y !== null ? y - x : null;

    let direction: ChangeDirection = 'unknown';
    if (delta !== null) {
      if (delta === 0) direction = 'unchanged';
      else direction = delta > 0 === higherIsBetter ? 'improved' : 'regressed';
    }

    rows.push({
      label,
      before: x,
      after: y,
      deltaBytes: delta,
      direction,
      ...(note ? { note } : {}),
    });
  };

  const fpsA = devA?.fps?.averageFps ?? null;
  const fpsB = devB?.fps?.averageFps ?? null;
  const differentTargets =
    targets.before !== null && targets.after !== null && targets.before !== targets.after;

  if (differentTargets) {
    // No verdict on this row: a green "better" beside a note saying the figures
    // are not comparable is a contradiction, and the reader would believe the
    // colour over the sentence.
    rows.push({
      label: 'Average frame rate (fps)',
      before: fpsA,
      after: fpsB,
      deltaBytes: fpsA !== null && fpsB !== null ? fpsB - fpsA : null,
      direction: 'unknown',
      note:
        `Not comparable directly: these runs aimed at ${targets.before} and ${targets.after} fps. ` +
        'The achievement row below asks the same question of both.',
    });
  } else {
    row('Average frame rate (fps)', fpsA, fpsB, true);
  }

  // A measured rate is only judgeable against what the build was aiming for.
  // A game holding 29 of a 30 target is doing its job; one holding 29 of a 60
  // target is missing half its frames.
  if (targets.before !== null || targets.after !== null) {
    rows.push({
      label: 'Target frame rate (fps)',
      before: targets.before,
      after: targets.after,
      deltaBytes: null,
      // A target is a decision, not an outcome, so neither value is "better".
      direction: 'unknown',
      note: 'What each build was aiming for, as supplied by the operator - not measured.',
    });

    const achieved = (fps: number | null, target: number | null) =>
      fps !== null && target !== null && target > 0 ? Math.round((fps / target) * 100) : null;

    const pctA = achieved(fpsA, targets.before);
    const pctB = achieved(fpsB, targets.after);

    // Closer to the target is better in *both* directions. Falling short is
    // stutter; overshooting a cap means the cap is not applying, which costs
    // battery, heat and GPU pressure for frames nobody asked for.
    let direction: ChangeDirection = 'unknown';
    if (pctA !== null && pctB !== null) {
      const missA = Math.abs(100 - pctA);
      const missB = Math.abs(100 - pctB);
      direction = missB === missA ? 'unchanged' : missB < missA ? 'improved' : 'regressed';
    }

    rows.push({
      label: 'Frame rate against its own target (%)',
      before: pctA,
      after: pctB,
      deltaBytes: pctA !== null && pctB !== null ? pctB - pctA : null,
      direction,
      note:
        'The comparable figure when the targets differ. 100% is the build doing exactly what it ' +
        'set out to do; below that is stutter, and above it means a frame-rate cap is not ' +
        'applying - which costs battery and heat for frames nobody asked for.',
    });
  }
  row('Median frame rate (fps)', devA?.fps?.medianFps, devB?.fps?.medianFps, true);
  row('Worst 1% of frames (fps)', devA?.fps?.low1PercentFps, devB?.fps?.low1PercentFps, true);
  row('Stutter (janks per minute)', devA?.fps?.janksPerMinute, devB?.fps?.janksPerMinute, false);
  row('Severe janks', devA?.fps?.bigJanks, devB?.fps?.bigJanks, false);
  row('Longest single frame (ms)', devA?.fps?.longestFrameMs, devB?.fps?.longestFrameMs, false);
  row('Screen refresh rate (Hz)', devA?.fps?.displayHz, devB?.fps?.displayHz, true,
    'A property of the phone, not of the build. Included so the frame rates above can be read ' +
      'against it.');
  row('Peak temperature (°C)', devA?.thermal?.peakC, devB?.thermal?.peakC, false);
  row('Temperature rise (°C)', devA?.thermal?.riseC, devB?.thermal?.riseC, false);

  // Battery drain is absent for any session that was charging, and the reason is
  // carried through rather than replaced by a zero.
  const batteryNote =
    devA?.battery?.unavailableReason ?? devB?.battery?.unavailableReason ?? undefined;
  row(
    'Battery used (% per hour)',
    devA?.battery?.drainPercentPerHour,
    devB?.battery?.drainPercentPerHour,
    false,
    batteryNote,
  );

  // Optional access throughout: these reports are read off disk, and one written
  // by an older build of the tool may not carry every field.
  row(
    'Free memory at launch (MB)',
    devA?.freshStart?.availableAfterBytes != null
      ? Math.round(devA.freshStart.availableAfterBytes / (1024 * 1024))
      : null,
    devB?.freshStart?.availableAfterBytes != null
      ? Math.round(devB.freshStart.availableAfterBytes / (1024 * 1024))
      : null,
    true,
    'How much room the game had when it started. Only recorded for a run where the phone was ' +
      'cleared first.',
  );
  row('Temperature at end (°C)', devA?.thermal?.endC, devB?.thermal?.endC, false);
  row('Battery at end (%)', devA?.battery?.endPercent, devB?.battery?.endPercent, true);
  row(
    'Combined risk score',
    a.verdict?.combinedRisk?.value,
    b.verdict?.combinedRisk?.value,
    false,
  );
  row(
    'Session duration (minutes)',
    a.session ? Math.round(a.session.durationMs / 60_000) : null,
    b.session ? Math.round(b.session.durationMs / 60_000) : null,
    true,
    'Longer or shorter is neither good nor bad - it is the context every whole-session figure ' +
      'above depends on.',
  );

  return rows;
}

/**
 * Retention going *up* is a regression: more memory stayed behind after leaving
 * the screen than before. The sign is not obvious from the number alone, which
 * is why it is decided in one place.
 */
function directionFor(
  before: number | null,
  after: number | null,
  floor: NoiseFloor | null,
  presence: 'both' | 'before-only' | 'after-only',
): ChangeDirection {
  if (presence !== 'both' || before === null || after === null) return 'unknown';
  if (!isConclusive(before, after, floor)) return floor ? 'inconclusive' : 'unchanged';
  if (after === before) return 'unchanged';
  return after > before ? 'regressed' : 'improved';
}

function summarize(report: AnalysisReport): RunSummary {
  const device = report.devices[0];
  return {
    analysisId: report.analysisId,
    gameName: report.subject.gameName,
    versionName: report.subject.versionName,
    generatedAt: report.generatedAt,
    device: device ? `${device.manufacturer} ${device.model}` : 'unknown device',
    deviceRamBytes: device?.totalRamBytes ?? null,
    androidVersion: device?.androidVersion ?? '?',
    abi: device?.abi ?? null,
    startedAt: report.session?.startedAtLocal ?? report.session?.startedAt ?? null,
    durationMs: report.session?.durationMs ?? 0,
    markerCount: report.session?.markerCount ?? 0,
  };
}

function headlineFor(input: {
  blocked: boolean;
  gates: Gate[];
  screens: MetricChange[];
  kills: MetricChange;
  budget: { direction: ChangeDirection };
  shared: number;
  floor: NoiseFloor | null;
}): string {
  if (input.blocked) {
    return (
      input.gates.find((g) => g.level === 'block')?.message ??
      'These two runs cannot be compared.'
    );
  }

  if (input.shared === 0) {
    return (
      'The two runs share no screens, so nothing can be compared. Use repeat mode to play the ' +
      'same route in both sessions.'
    );
  }

  if (input.kills.direction === 'regressed') {
    return 'The later run was killed by the OS where the earlier one was not. This is a regression.';
  }
  if (input.kills.direction === 'improved') {
    return 'The later run survived where the earlier one was killed by the OS.';
  }

  const regressed = input.screens.filter((s) => s.direction === 'regressed');
  const improved = input.screens.filter((s) => s.direction === 'improved');

  if (regressed.length > 0) {
    const worst = regressed.reduce((w, s) =>
      (s.deltaBytes ?? 0) > (w.deltaBytes ?? 0) ? s : w,
    );
    return (
      `${regressed.length} screen(s) retain more memory than before; the worst is ` +
      `"${worst.label}". ${improved.length} improved.`
    );
  }
  if (improved.length > 0) {
    return `${improved.length} screen(s) retain less memory than before, and none got worse.`;
  }

  return input.floor
    ? 'No change larger than the measured run-to-run variance across the shared screens.'
    : 'No change across the shared screens. No noise floor is established, so small ' +
        'differences cannot be told apart from variance.';
}
