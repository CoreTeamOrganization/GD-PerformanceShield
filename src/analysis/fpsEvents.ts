/**
 * Significant changes in frame rate, with the numbers needed to judge them.
 *
 * The frame-rate series is one sample per second, far too fine to put in a
 * report: a three-minute session is 180 numbers, most of them the same. What a
 * reader wants is the handful of moments where something happened, each with
 * enough context to say how bad it was and how long it lasted.
 *
 * Two kinds of moment qualify:
 *
 *  - a **drop**: the rate fell well below what the game had been achieving and
 *    then came back. This is what a player calls a stutter or a freeze.
 *  - a **step**: the rate moved to a different sustained level and stayed there.
 *    Usually the display cap changing (30 to 60 and back), occasionally a scene
 *    that is simply cheaper. Not a fault, but it changes what every figure after
 *    it means, and a reader who is not told will misread the rest of the chart.
 *
 * A step is deliberately not "the recovery at the end of a drop". Every drop
 * ends in a recovery, so reporting those would double the list and say nothing.
 * A step is reported only when the level before and the level after differ,
 * which is a different event from a dip that returned to where it started.
 *
 * Letters (A, B, C...) are assigned worst-first, the same way memory spikes are
 * lettered, so prose can say "look at B" and mean one thing on the chart, in the
 * event table and in the detail section.
 */
import type { Severity } from '../core/types.js';

/** What kind of change this was. */
export type FpsEventKind = 'drop' | 'step';

/** One window of the frame-rate series. */
export interface FpsWindow {
  elapsedMs: number;
  fps: number;
  janks: number;
  /** How long the window covered, when timestamps alone are too sparse. */
  windowMs?: number;
}

export interface FpsEvent {
  role: string;
  /** A, B, C... worst first, so one letter means one event everywhere. */
  letter: string;
  kind: FpsEventKind;
  /** The worst moment of the event - what the chart badge points at. */
  atMs: number;
  /** When it began, and when the rate came back. */
  fromMs: number;
  toMs: number;
  durationMs: number;
  /** The rate the game had been holding before this. */
  beforeFps: number;
  /** The worst single window inside the event. */
  lowestFps: number;
  /** The rate once it settled again. For a step, the new level. */
  afterFps: number;
  /** Signed, against `beforeFps`. Negative for a drop. */
  changePercent: number;
  /** How many windows the event spanned. */
  windows: number;
  janks: number;
  severity: Severity;
  /** What `beforeFps` was measured against, named so a reader can check it. */
  basis: string;
}

export interface FpsEventOptions {
  /**
   * Fraction of the expected rate below which a window counts as collapsed.
   *
   * Relative rather than absolute: a 30 fps build on a budget phone must not
   * have every window flagged, while a 120 Hz title falling to 70 has lost
   * something the player felt.
   */
  collapseFraction?: number;
  /**
   * Absolute floor, in fps, so a game sitting rock-steady at 30 does not have
   * its 29 fps windows called collapses.
   */
  minDropFps?: number;
  /** What the build was aiming for, when the caller knows it. */
  targetFps?: number | null;
  /** How many preceding windows form the "recently achieved" baseline. */
  baselineWindows?: number;
  /** How many events to report. Beyond this it is a log, not a report. */
  maxEvents?: number;
  /** A step must change the sustained level by at least this fraction... */
  stepFraction?: number;
  /** ...and by at least this many fps, so noise near the cap is not a step. */
  stepMinFps?: number;
}

/** Every threshold in one place, so a caller can override any of them. */
export const FPS_EVENT_DEFAULTS = {
  collapseFraction: 0.65,
  minDropFps: 5,
  baselineWindows: 10,
  maxEvents: 8,
  stepFraction: 0.25,
  stepMinFps: 8,
};

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The rate the game should be judged against at a given point.
 *
 * The higher of "what it was just achieving" and "what it normally achieves",
 * capped by the target when one is known. Taking the higher of the two catches a
 * fall from 60 to 30 in a session whose median is 35 because the whole second
 * half ran at 30 - judged against the median alone, that fall is invisible.
 * Capping at the target stops a 30 fps build being measured against a 60 fps
 * expectation it never had.
 */
function referenceFor(
  index: number,
  series: FpsWindow[],
  sessionMedian: number,
  baselineWindows: number,
  targetFps: number | null | undefined,
): { fps: number; basis: string } {
  const from = Math.max(0, index - baselineWindows);
  const recent = series.slice(from, index).map((p) => p.fps);
  const recentMedian = recent.length >= 3 ? medianOf(recent) : 0;

  let fps = Math.max(recentMedian, sessionMedian);
  let basis = recentMedian > sessionMedian ? 'the recently achieved rate' : 'the session median';

  if (targetFps != null && targetFps > 0 && targetFps < fps) {
    fps = targetFps;
    basis = 'the target the build asked for';
  }
  return { fps, basis };
}

function severityFor(lowest: number, reference: number, windows: number): Severity {
  const ratio = reference > 0 ? lowest / reference : 1;
  if (ratio <= 0.35) return windows >= 3 ? 'critical' : 'high';
  if (ratio <= 0.55) return 'high';
  return windows >= 3 ? 'medium' : 'low';
}

/**
 * Find the drops and the level changes in one device's frame-rate series.
 *
 * Returned worst-first and lettered. The caller sorts by time to build a
 * timeline; the letter stays attached to the event, not to its position.
 */
export function detectFpsEvents(
  role: string,
  series: FpsWindow[],
  options: FpsEventOptions = {},
): FpsEvent[] {
  const opts = { ...FPS_EVENT_DEFAULTS, ...options };
  if (series.length < 3) return [];

  const points = [...series].sort((a, b) => a.elapsedMs - b.elapsedMs);
  const sessionMedian = medianOf(points.map((p) => p.fps));
  if (!Number.isFinite(sessionMedian) || sessionMedian <= 0) return [];

  const gap = points.length > 1 ? points[1]!.elapsedMs - points[0]!.elapsedMs : 1000;
  const windowMs = points[0]?.windowMs ?? (gap > 0 ? gap : 1000);

  const events: FpsEvent[] = [];

  // ---- drops -------------------------------------------------------------
  interface OpenDrop {
    fromMs: number;
    lowest: number;
    lowestAtMs: number;
    janks: number;
    windows: number;
    reference: number;
    basis: string;
  }
  let open: OpenDrop | null = null;

  const closeDrop = (endIndex: number) => {
    if (!open) return;
    const after = points[endIndex]?.fps ?? open.reference;
    const lastMs = points[Math.max(0, endIndex - 1)]?.elapsedMs ?? open.fromMs;

    events.push({
      role,
      letter: '',
      kind: 'drop',
      atMs: open.lowestAtMs,
      fromMs: open.fromMs,
      toMs: lastMs + windowMs,
      durationMs: Math.max(windowMs, lastMs - open.fromMs + windowMs),
      beforeFps: round1(open.reference),
      lowestFps: round1(open.lowest),
      afterFps: round1(after),
      changePercent:
        open.reference > 0
          ? Math.round(((open.lowest - open.reference) / open.reference) * 1000) / 10
          : 0,
      windows: open.windows,
      janks: open.janks,
      severity: severityFor(open.lowest, open.reference, open.windows),
      basis: open.basis,
    });
    open = null;
  };

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const ref = referenceFor(i, points, sessionMedian, opts.baselineWindows, opts.targetFps);
    const threshold = Math.min(ref.fps * opts.collapseFraction, ref.fps - opts.minDropFps);

    if (Number.isFinite(threshold) && threshold > 0 && point.fps <= threshold) {
      if (!open) {
        open = {
          fromMs: point.elapsedMs,
          lowest: point.fps,
          lowestAtMs: point.elapsedMs,
          janks: point.janks,
          windows: 1,
          reference: ref.fps,
          basis: ref.basis,
        };
      } else {
        open.windows++;
        open.janks += point.janks;
        if (point.fps < open.lowest) {
          open.lowest = point.fps;
          open.lowestAtMs = point.elapsedMs;
        }
      }
    } else if (open) {
      closeDrop(i);
    }
  }
  if (open) closeDrop(points.length);

  // ---- steps -------------------------------------------------------------
  // A sustained change of level, usually the display cap moving. Reported only
  // where both sides are long enough to be levels rather than noise.
  const span = opts.baselineWindows;
  if (points.length >= span * 2 + 1) {
    /*
     * Candidates first, then the strongest of each cluster.
     *
     * The two sliding medians disagree for a stretch of windows either side of
     * a real transition, so every window in that stretch looks like a step. A
     * fixed dedup distance cannot fix that - the stretch is as wide as the
     * window is long, and the first candidate is rarely the steepest. Gathering
     * them and keeping the local maximum reports one step per level change,
     * dated at the sharpest point, which is where the change actually happened.
     */
    interface Candidate {
      index: number;
      at: number;
      before: number;
      after: number;
      change: number;
    }
    const candidates: Candidate[] = [];

    for (let i = span; i <= points.length - span; i++) {
      const at = points[i]!.elapsedMs;
      const before = medianOf(points.slice(i - span, i).map((p) => p.fps));
      const after = medianOf(points.slice(i, i + span).map((p) => p.fps));
      if (before <= 0) continue;

      const change = after - before;
      if (Math.abs(change) < opts.stepMinFps) continue;
      if (Math.abs(change) / before < opts.stepFraction) continue;

      // Not the tail of a drop already reported: a dip that returned to the
      // same level is one event, not a step down followed by a step up.
      const insideDrop = events.some(
        (e) => e.kind === 'drop' && at >= e.fromMs - windowMs && at <= e.toMs + windowMs,
      );
      if (insideDrop) continue;

      candidates.push({ index: i, at, before, after, change });
    }

    // Strongest first, then suppress everything within a window's reach of one
    // already taken - both sides of a transition belong to the same event.
    candidates.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.at - b.at);
    const taken: Candidate[] = [];
    for (const c of candidates) {
      if (taken.some((t) => Math.abs(t.at - c.at) <= span * windowMs * 1.5)) continue;
      taken.push(c);
    }

    for (const c of taken) {
      const { index: i, at, before, after, change } = c;
      events.push({
        role,
        letter: '',
        kind: 'step',
        atMs: at,
        fromMs: points[i - span]!.elapsedMs,
        toMs: points[Math.min(points.length - 1, i + span)]!.elapsedMs,
        durationMs: span * windowMs,
        beforeFps: round1(before),
        lowestFps: round1(Math.min(before, after)),
        afterFps: round1(after),
        changePercent: Math.round((change / before) * 1000) / 10,
        windows: span,
        janks: 0,
        /*
         * Context, not a fault - even a step down, which is usually the display
         * dropping to 30 Hz rather than the game failing to keep up. Rating it
         * as a problem would put a display setting at the top of a list of bugs.
         */
        severity: 'info',
        basis: 'the sustained rate on each side',
      });
    }
  }

  // Worst first, and lettered in that order. Ties broken by how far it fell, so
  // the ordering is stable between runs over the same data.
  const rank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  events.sort(
    (a, b) => rank[b.severity] - rank[a.severity] || a.lowestFps - b.lowestFps || a.atMs - b.atMs,
  );

  const kept = events.slice(0, opts.maxEvents);
  for (let i = 0; i < kept.length; i++) kept[i]!.letter = String.fromCharCode(65 + i);
  return kept;
}

/** Clock as m:ss, for labels and prose. */
export function formatFpsClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
