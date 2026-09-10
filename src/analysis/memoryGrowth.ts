/**
 * Memory that goes up and does not come back.
 *
 * Spike detection already finds the moments memory jumped. It cannot tell the
 * difference between the two things a jump might mean, and they need opposite
 * responses:
 *
 *  - memory rose to load a level and fell again when the level ended. Normal.
 *    A report that flags this trains its reader to ignore it.
 *  - memory rose and stayed up, again and again, so the floor kept climbing.
 *    That is the shape of something not being released, and it is the one that
 *    ends in a kill twenty minutes into a session nobody profiled.
 *
 * The difference is not in any single jump - it is in the trend and in where the
 * session finished relative to where it started. So this looks at the whole
 * series: the slope, how much was still held at the end, and whether the low
 * points themselves moved up over time.
 *
 * What it will not do is call anything a confirmed leak. Proving a leak needs
 * allocation ownership, which is inside the process and not visible from here. A
 * three-minute session that ends 200 MB up may be leaking or may simply not have
 * reached its steady state yet, and the honest output says which of those the
 * data can and cannot separate.
 */

/** One reading of the app's memory over time. */
export interface GrowthPoint {
  elapsedMs: number;
  bytes: number;
}

export type GrowthVerdict =
  /** The floor kept rising; memory was not being returned. */
  | 'retained'
  /** It grew and gave it back - the usual shape of loading a level. */
  | 'released'
  /** Flat within noise for the whole session. */
  | 'flat'
  /** Too short or too sparse to say anything. */
  | 'insufficient';

export interface MemoryGrowth {
  role: string;
  verdict: GrowthVerdict;
  /** Least-squares slope over the session. Signed. */
  bytesPerMinute: number;
  baselineBytes: number;
  finalBytes: number;
  peakBytes: number;
  /** Still held at the end, against where it started. Signed. */
  retainedBytes: number;
  /** `retainedBytes` as a share of the baseline. */
  retainedFraction: number;
  /**
   * How much of the peak was still held at the end.
   *
   * The figure that separates the two cases: near 1 means it never came down,
   * near 0 means it did.
   */
  heldAtEndFraction: number;
  /**
   * Whether the troughs themselves climbed.
   *
   * Compares the lowest reading in the first third of the session with the
   * lowest in the last third. A rising floor is the strongest signal available
   * from outside the process, because it survives the loading spikes on top.
   */
  floorRoseBytes: number;
  durationMs: number;
  samples: number;
  /** What a reader should take from it, in one or two sentences. */
  summary: string;
  /** What to look at, when there is something to look at. */
  recommendation: string | null;
  /** 0..1, for the shared confidence ladder. */
  confidence: number;
}

/** Below this there is not enough session to comment on a trend. */
const MIN_DURATION_MS = 60_000;
const MIN_SAMPLES = 10;

/**
 * How much of the start to ignore, because launching is not retaining.
 *
 * A game measured from launch climbs steeply while it loads its first scene -
 * one real session went from 333 MB to 832 MB in nine seconds and then sat
 * nearly flat for three minutes. Measured from the first sample, that reads as
 * 569 MB of retention with a floor 518 MB higher, which is the loudest possible
 * way to be wrong: it is the launch, and every session would report it.
 *
 * Thirty seconds is enough for a Unity title to get through its first scene on
 * a mid-range phone. Sessions too short to give that up and still have a
 * minute of steady state left are reported as insufficient rather than guessed
 * at, because there is genuinely no way to separate the two from outside.
 */
const WARMUP_MS = 30_000;

/** Growth smaller than this share of the baseline is not worth a finding. */
const RETAINED_FRACTION = 0.15;

/** Above this share of the peak still held at the end, it never came down. */
const HELD_AT_END = 0.9;

const MB = 1024 * 1024;

function fmt(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
  if (abs >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Least-squares slope in bytes per millisecond. */
function slopePerMs(points: GrowthPoint[]): number {
  const n = points.length;
  if (n < 2) return 0;

  const meanT = points.reduce((sum, p) => sum + p.elapsedMs, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.bytes, 0) / n;

  let num = 0;
  let den = 0;
  for (const p of points) {
    const dt = p.elapsedMs - meanT;
    num += dt * (p.bytes - meanY);
    den += dt * dt;
  }
  return den === 0 ? 0 : num / den;
}

/** The lowest reading within a slice, which is the floor for that stretch. */
function floorOf(points: GrowthPoint[]): number {
  return points.reduce((low, p) => Math.min(low, p.bytes), Number.POSITIVE_INFINITY);
}

/**
 * Judge one device's memory series.
 *
 * Always returns a verdict, including `insufficient`, because "we could not tell"
 * is a result a report should carry rather than an absence a reader has to
 * notice.
 */
export function analyseMemoryGrowth(role: string, series: GrowthPoint[]): MemoryGrowth {
  const points = [...series]
    .filter((p) => Number.isFinite(p.bytes) && p.bytes > 0)
    .sort((a, b) => a.elapsedMs - b.elapsedMs);

  const durationMs = points.length > 0 ? points[points.length - 1]!.elapsedMs - points[0]!.elapsedMs : 0;

  const empty = (summary: string): MemoryGrowth => ({
    role,
    verdict: 'insufficient',
    bytesPerMinute: 0,
    baselineBytes: points[0]?.bytes ?? 0,
    finalBytes: points[points.length - 1]?.bytes ?? 0,
    peakBytes: points.reduce((hi, p) => Math.max(hi, p.bytes), 0),
    retainedBytes: 0,
    retainedFraction: 0,
    heldAtEndFraction: 0,
    floorRoseBytes: 0,
    durationMs,
    samples: points.length,
    summary,
    recommendation: null,
    confidence: 0,
  });

  if (points.length < MIN_SAMPLES || durationMs < MIN_DURATION_MS) {
    return empty(
      `Too little of the session was sampled to judge a trend (${points.length} reading(s) over ` +
        `${Math.round(durationMs / 1000)} s). A minute of play with memory sampled throughout is ` +
        'the least this needs.',
    );
  }

  /*
   * Everything below is measured after the warm-up, not from the first sample.
   * See WARMUP_MS: judging from launch turns every session into a leak report.
   */
  const startMs = points[0]!.elapsedMs;
  const settled = points.filter((p) => p.elapsedMs - startMs >= WARMUP_MS);
  const settledMs =
    settled.length > 0 ? settled[settled.length - 1]!.elapsedMs - settled[0]!.elapsedMs : 0;

  if (settled.length < MIN_SAMPLES || settledMs < MIN_DURATION_MS) {
    return empty(
      `The session is too short to separate loading from retention. Memory is measured from ` +
        `${Math.round(WARMUP_MS / 1000)} s in, once the first scene has loaded, and that leaves ` +
        `only ${Math.round(settledMs / 1000)} s of steady play here. Record two or three minutes ` +
        'of the same route to get an answer.',
    );
  }

  const baselineBytes = settled[0]!.bytes;
  const finalBytes = settled[settled.length - 1]!.bytes;
  const peakBytes = settled.reduce((hi, p) => Math.max(hi, p.bytes), 0);
  const retainedBytes = finalBytes - baselineBytes;
  const retainedFraction = baselineBytes > 0 ? retainedBytes / baselineBytes : 0;
  const growthAbovePeak = peakBytes - baselineBytes;
  const heldAtEndFraction = growthAbovePeak > 0 ? retainedBytes / growthAbovePeak : 0;

  const third = Math.max(1, Math.floor(settled.length / 3));
  const firstFloor = floorOf(settled.slice(0, third));
  const lastFloor = floorOf(settled.slice(settled.length - third));
  const floorRoseBytes = lastFloor - firstFloor;

  const bytesPerMinute = slopePerMs(settled) * 60_000;

  const clock = `${Math.floor(settledMs / 60000)}m ${Math.round((settledMs % 60000) / 1000)}s`;
  const trail =
    `Measured over ${clock} of steady play - the first ${Math.round(WARMUP_MS / 1000)} s are ` +
    `excluded so loading the first scene is not counted as growth - from ${fmt(baselineBytes)} to ` +
    `${fmt(finalBytes)}, peaking at ${fmt(peakBytes)}.`;

  /*
   * Either of two shapes counts as retention, and the second is the stronger.
   *
   * The end-point test - it grew and was still holding almost all of it - only
   * fires when the session happens to finish near its peak. A sawtooth that
   * climbs steadily but ends mid-trough fails it while being exactly the thing
   * this module exists to catch, so a rising *floor* is an independent trigger:
   * the troughs are what survive the loading spikes on top of them, which is
   * why the doc comment above calls them the strongest signal available from
   * outside the process. Judging on the end point alone made that claim untrue.
   */
  const floorRose = firstFloor > 0 && floorRoseBytes / firstFloor >= RETAINED_FRACTION;
  const endedHigh = retainedFraction >= RETAINED_FRACTION && heldAtEndFraction >= HELD_AT_END;

  if (endedHigh || floorRose) {
    /*
     * Confidence rises with the evidence that survives the loading spikes: a
     * rising floor is worth more than a rising end point, and a longer session
     * is worth more than a short one. Capped below the top of the ladder,
     * because a leak cannot be proved from outside the process.
     */
    const floorSignal = floorRoseBytes > 0 && baselineBytes > 0 ? floorRoseBytes / baselineBytes : 0;
    const confidence = Math.min(
      0.8,
      0.4 + Math.min(0.25, retainedFraction) + Math.min(0.15, floorSignal) + (durationMs > 300_000 ? 0.1 : 0),
    );

    return {
      role,
      verdict: 'retained',
      bytesPerMinute,
      baselineBytes,
      finalBytes,
      peakBytes,
      retainedBytes,
      retainedFraction,
      heldAtEndFraction,
      floorRoseBytes,
      durationMs: settledMs,
      samples: settled.length,
      summary:
        (endedHigh
          ? `Memory grew ${fmt(retainedBytes)} over the session and was still held at the end - ` +
            `${Math.round(heldAtEndFraction * 100)}% of everything it gained was never given back, ` +
            `a climb of about ${fmt(bytesPerMinute)} a minute. `
          : `Memory climbed about ${fmt(bytesPerMinute)} a minute across the session. It ended ` +
            `below its peak, so no single jump looks retained - but the floor underneath the ` +
            `loading spikes rose ${fmt(floorRoseBytes)}, which is the part that does not come back. `) +
        (endedHigh && floorRoseBytes > 0
          ? `The quiet moments rose too, by ${fmt(floorRoseBytes)}, so this is the floor moving and ` +
            'not just a load that had not finished. '
          : '') +
        trail +
        ' This is the shape of something not being released, but it is not proof: allocation ' +
        'ownership lives inside the process, and a short session may simply not have reached a ' +
        'steady state. Play the same route for twice as long - if the figure roughly doubles, it is real.',
      recommendation:
        'Check what the previous screen left behind: object lifetimes and retained references, ' +
        'asset unloading, Addressables release calls, and texture and audio handles held past the ' +
        'scene that needed them.',
      confidence,
    };
  }

  // Grew and gave it back. Worth saying so, because silence reads as an omission.
  if (growthAbovePeak > baselineBytes * RETAINED_FRACTION) {
    return {
      role,
      verdict: 'released',
      bytesPerMinute,
      baselineBytes,
      finalBytes,
      peakBytes,
      retainedBytes,
      retainedFraction,
      heldAtEndFraction,
      floorRoseBytes,
      durationMs: settledMs,
      samples: settled.length,
      summary:
        `Memory rose to ${fmt(peakBytes)} during the session and came back down: only ` +
        `${fmt(retainedBytes)} was still held at the end, ${Math.round(Math.max(0, heldAtEndFraction) * 100)}% ` +
        `of what it gained. ${trail} That is the normal shape of loading and releasing content, ` +
        'and nothing here suggests memory is being retained.',
      recommendation: null,
      confidence: 0.7,
    };
  }

  return {
    role,
    verdict: 'flat',
    bytesPerMinute,
    baselineBytes,
    finalBytes,
    peakBytes,
    retainedBytes,
    retainedFraction,
    heldAtEndFraction,
    floorRoseBytes,
    durationMs: settledMs,
    samples: settled.length,
    summary: `Memory stayed level for the whole session. ${trail}`,
    recommendation: null,
    confidence: 0.7,
  };
}
