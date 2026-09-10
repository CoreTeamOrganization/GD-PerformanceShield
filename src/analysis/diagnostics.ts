/**
 * Automated root-cause correlation.
 *
 * Every other module in this tool measures one subsystem. This one is the only
 * part that answers the question a studio actually asks: *why did it stutter
 * there?* It does that by finding the moments the frame rate collapsed and then
 * asking every other subsystem what it was doing at that moment.
 *
 * The output is deliberately shaped as a sentence with its evidence attached:
 *
 *   "Frame rate fell to 18 fps at 3:12. In the same window texture memory rose
 *    412 MB and draw calls tripled to 2,140. Most likely cause: an unbudgeted
 *    asset load during Level 3 start."
 *
 * Three rules keep this from becoming a machine that invents causes:
 *
 *  1. Correlation is stated as correlation. A cause is ranked by how well it
 *     lines up and how large it is, never asserted as proven. The wording says
 *     "in the same window", not "because of".
 *  2. A symptom with no coincident evidence is reported with no cause rather
 *     than assigned the most common one. "We do not know why this frame dropped"
 *     is a useful sentence; a confident wrong answer is not.
 *  3. Every cause names the figure it rests on, so a developer can check it.
 *
 * Windowing: subsystems are sampled on different cadences - frame rate every
 * second, memory and GPU every few seconds, the engine reporter at whatever
 * interval the build sets. Everything is therefore matched within a tolerance
 * rather than on equality, and the tolerance is stated in the output.
 */
import type { Severity } from '../core/types.js';
import type { ThermalSummary, FpsSummary } from '../telemetry/deviceHealth.js';
import type { IoBurst } from '../telemetry/diskIo.js';
import type { ThreadReading } from '../telemetry/cpuThreads.js';
import { formatBytes } from './correlation.js';
import { confidenceLevel, type ConfidenceLevel } from './confidence.js';
import { detectFpsEvents, type FpsEvent, type FpsEventKind } from './fpsEvents.js';

/** Which subsystem a candidate cause came from. */
export type Subsystem =
  | 'memory'
  | 'gpu'
  | 'rendering'
  | 'cpu'
  | 'storage'
  | 'audio'
  | 'thermal'
  | 'system';

export interface DiagnosticCause {
  subsystem: Subsystem;
  /** What that subsystem was doing, with the figure it rests on. */
  statement: string;
  /** 0..1 - how strongly this explains the symptom. Ranking only. */
  weight: number;
}

export interface Diagnosis {
  id: string;
  role: string;
  /**
   * A, B, C... shared with the chart badge and the event table.
   *
   * The letter is what lets three parts of the report point at one moment: the
   * badge on the frame-rate chart, the row in the event timeline, and the
   * detail section underneath. Empty for a diagnosis with no frame-rate event
   * behind it, such as a process kill.
   */
  letter: string;
  /** Which kind of moment this explains. */
  kind: FpsEventKind | 'process-death';
  /** Where in the session, in milliseconds from the start. */
  atMs: number;
  /** When the event began and ended, for a timeline that shows extent. */
  fromMs: number;
  toMs: number;
  durationMs: number;
  /** How wide a window the evidence was gathered from. */
  toleranceMs: number;
  /** The symptom, in plain words. */
  symptom: string;
  /** Frame rate at the worst point of the episode. */
  fps: number;
  /** The rate before, the worst rate, and the rate once it settled. */
  beforeFps: number;
  lowestFps: number;
  afterFps: number;
  /** Signed change against `beforeFps`, as a percentage. */
  changePercent: number;
  /** How many one-second windows the event spanned. */
  windows: number;
  /** What `beforeFps` was measured against. */
  basis: string;
  janks: number;
  severity: Severity;
  /** 0..1. Rises with the number and strength of coincident signals. */
  confidence: number;
  /**
   * The same figure on the shared ladder.
   *
   * Stored rather than derived at render time so every surface - report, gate,
   * comparison - words it identically, and so the ceiling that stops
   * correlation ever reading as "Confirmed" is applied in exactly one place.
   */
  level: ConfidenceLevel;
  /** Ranked, strongest first. Empty when nothing lined up. */
  causes: DiagnosticCause[];
  /** The sentence a reader gets: symptom, coincidences, and the caveat. */
  conclusion: string;
  recommendation: string;
  /** Nearest operator marker at or before the episode. */
  nearestMarker: string | null;
}

/** A point on one subsystem's timeline. */
export interface RenderPoint {
  elapsedMs: number;
  drawCalls?: number | undefined;
  setPassCalls?: number | undefined;
  triangles?: number | undefined;
  gpuFrameMs?: number | undefined;
  mainThreadMs?: number | undefined;
  renderThreadMs?: number | undefined;
  usedTextureBytes?: number | undefined;
}

export interface GpuPoint {
  elapsedMs: number;
  utilizationPercent: number | null;
  clockMhz: number | null;
}

export interface CpuPoint {
  elapsedMs: number;
  appCpuPercentOfCore: number | null;
  otherCpuPercentOfDevice: number | null;
  threads: ThreadReading[];
}

export interface AudioPoint {
  elapsedMs: number;
  activeTracks: number | null;
  underrunCount: number | null;
}

export interface MemorySpikePoint {
  letter: string;
  fromMs: number;
  toMs: number;
  deltaBytes: number;
  totalBytes: number;
  kind: string;
  nearestMarker: string | null;
  categories: Array<{ label: string; deltaBytes: number }>;
  engine: Array<{ label: string; deltaBytes: number }>;
}

export interface FrameWindowPoint {
  elapsedMs: number;
  fps: number;
  janks: number;
}

export interface DiagnosticsInput {
  role: string;
  durationMs: number;
  fps: FpsSummary | null;
  fpsSeries: FrameWindowPoint[];
  memorySpikes: MemorySpikePoint[];
  ioBursts: IoBurst[];
  renderSeries: RenderPoint[];
  gpuSeries: GpuPoint[];
  cpuSeries: CpuPoint[];
  audioSeries: AudioPoint[];
  thermal: ThermalSummary | null;
  markers: Array<{ elapsedMs: number; label: string }>;
  /** Kills and crashes, which get their own diagnosis regardless of frame rate. */
  processDeaths: number;
  /**
   * The frame rate the build was aiming for, when the operator supplied it.
   *
   * Only used to stop a 30 fps build being judged against a 60 fps expectation
   * it never had. Absent for most sessions, because the cap is a project
   * setting the tool cannot read from outside the process.
   */
  targetFps?: number | null;
}

/**
 * How far apart two readings can be and still be called coincident.
 *
 * Five seconds, because that is the deep-sample interval: a memory figure and a
 * frame-rate figure taken from the same event can legitimately be that far
 * apart in the record, and a tighter window would reject genuine matches. It is
 * also loose enough to admit a coincidence, which is why the output says
 * "in the same window" rather than "caused by".
 */
export const COINCIDENCE_TOLERANCE_MS = 5000;

/*
 * The collapse thresholds moved to fpsEvents.ts, which owns event detection and
 * exposes them as overridable defaults. They lived here as fixed constants, and
 * the spec asks for a configurable threshold.
 */

export function diagnose(input: DiagnosticsInput): Diagnosis[] {
  const out: Diagnosis[] = [];

  /*
   * Events, not raw windows. The detector groups consecutive collapsed windows
   * into one episode and works out what the rate was before and after, which is
   * what turns "18 fps at 1:16" into "fell from 58 to 18 for three seconds" -
   * the difference between a number and something a reader can judge.
   */
  const events = detectFpsEvents(input.role, input.fpsSeries, { targetFps: input.targetFps });

  for (const event of events) {
    // A step is a change of level, usually the display cap moving. It is
    // reported on the chart and in the timeline, but it is not a fault and does
    // not get a root-cause hunt: asking which subsystem caused the screen to
    // switch to 60 Hz would invent a culprit for a setting.
    if (event.kind === 'step') continue;
    const causes = gatherCauses(input, event.atMs);
    out.push(buildDiagnosis(input, event, causes, out.length));
  }

  // A kill is a symptom in its own right and does not need a frame-rate dip to
  // be worth diagnosing - the process was gone, which is as bad as it gets.
  if (input.processDeaths > 0) {
    out.push(diagnoseProcessDeath(input, out.length));
  }

  // Strongest first: severity, then how badly the frame rate fell.
  const rank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  out.sort((a, b) => rank[b.severity] - rank[a.severity] || a.fps - b.fps);
  return out;
}


/**
 * Ask every subsystem what it was doing at a moment.
 *
 * Each check produces at most one cause, with a weight standing for how well it
 * explains a frame collapse. The weights are ordinal - they order the list and
 * feed the confidence figure - and are not probabilities.
 */
function gatherCauses(input: DiagnosticsInput, atMs: number): DiagnosticCause[] {
  const causes: DiagnosticCause[] = [];
  const near = (ms: number) => Math.abs(ms - atMs) <= COINCIDENCE_TOLERANCE_MS;

  // Memory. A spike is already the largest jump between two deep samples, and
  // the engine breakdown inside it is what names the asset type.
  const spike = input.memorySpikes
    .filter((s) => near(s.toMs) || (s.fromMs <= atMs && s.toMs >= atMs))
    .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes))[0];
  if (spike && spike.deltaBytes > 0) {
    const engineDetail = spike.engine
      .filter((e) => e.deltaBytes > 0)
      .slice(0, 2)
      .map((e) => `${e.label} +${formatBytes(e.deltaBytes)}`)
      .join(', ');
    const categoryDetail = spike.categories
      .filter((c) => c.deltaBytes > 0)
      .slice(0, 2)
      .map((c) => `${c.label} +${formatBytes(c.deltaBytes)}`)
      .join(', ');
    causes.push({
      subsystem: 'memory',
      statement:
        `memory rose ${formatBytes(spike.deltaBytes)} to ${formatBytes(spike.totalBytes)}` +
        (engineDetail ? ` (${engineDetail})` : categoryDetail ? ` (${categoryDetail})` : ''),
      // Weighted by size: a 400 MB jump explains a stall far better than a 20 MB one.
      weight: clamp01(0.45 + Math.min(0.4, spike.deltaBytes / (500 * 1024 * 1024))),
    });
  }

  // Rendering. A draw-call or triangle jump against the session's own baseline,
  // because the absolute count is a design decision and the *change* is not.
  const renderAt = nearestBy(input.renderSeries, atMs, COINCIDENCE_TOLERANCE_MS);
  if (renderAt) {
    const drawJump = relativeJump(input.renderSeries, renderAt, (p) => p.drawCalls);
    if (drawJump && drawJump.ratio >= 1.5) {
      causes.push({
        subsystem: 'rendering',
        statement:
          `draw calls rose ${drawJump.ratio.toFixed(1)}x to ${drawJump.value.toLocaleString()} ` +
          `(session median ${Math.round(drawJump.baseline).toLocaleString()})`,
        weight: clamp01(0.4 + Math.min(0.35, (drawJump.ratio - 1.5) / 4)),
      });
    }

    const triangleJump = relativeJump(input.renderSeries, renderAt, (p) => p.triangles);
    if (triangleJump && triangleJump.ratio >= 1.8) {
      causes.push({
        subsystem: 'rendering',
        statement:
          `triangles rose ${triangleJump.ratio.toFixed(1)}x to ` +
          `${Math.round(triangleJump.value).toLocaleString()}`,
        weight: clamp01(0.35 + Math.min(0.3, (triangleJump.ratio - 1.8) / 5)),
      });
    }

    /*
     * Thread times at the moment: where the frame actually went.
     *
     * This is the most certain fact in the list - the engine measured it, and
     * it needs no inference. It is deliberately *not* the highest-weighted one,
     * because certainty is not explanatory power. "The GPU took 58 ms" is close
     * to a restatement of "the frame took 58 ms"; the answer a developer can act
     * on is what changed to make it so, which is why a large asset load or a
     * draw-call jump outranks it. The stage time's job here is to say which
     * stage to look at, and it is weighted to sit just below the changes it
     * points at rather than above them.
     */
    const stages: Array<[Subsystem, string, number | undefined]> = [
      ['cpu', 'the main thread', renderAt.mainThreadMs],
      ['rendering', 'the render thread', renderAt.renderThreadMs],
      ['gpu', 'the GPU', renderAt.gpuFrameMs],
    ];
    const worst = stages
      .filter((s): s is [Subsystem, string, number] => typeof s[2] === 'number')
      .sort((a, b) => b[2] - a[2])[0];
    if (worst && worst[2] >= 25) {
      causes.push({
        subsystem: worst[0],
        statement: `${worst[1]} took ${worst[2].toFixed(1)} ms for that frame`,
        weight: 0.8,
      });
    }
  }

  // Storage. A read that landed in this window is a strong candidate, because a
  // synchronous read blocks the thread that issued it outright.
  const burst = input.ioBursts
    .filter((b) => near(b.elapsedMs))
    .sort((a, b) => b.readBytesPerSecond - a.readBytesPerSecond)[0];
  if (burst) {
    const toFlash =
      burst.storageReadBytesPerSecond != null
        ? `, ${formatBytes(burst.storageReadBytesPerSecond)}/s of it from flash rather than cache`
        : '';
    causes.push({
      subsystem: 'storage',
      statement: `the app read ${formatBytes(burst.readBytesPerSecond)}/s${toFlash}`,
      weight: clamp01(0.5 + Math.min(0.3, burst.readBytesPerSecond / (100 * 1024 * 1024))),
    });
  }

  // GPU saturation at the moment.
  const gpuAt = nearestBy(input.gpuSeries, atMs, COINCIDENCE_TOLERANCE_MS);
  if (gpuAt?.utilizationPercent != null && gpuAt.utilizationPercent >= 90) {
    causes.push({
      subsystem: 'gpu',
      statement: `the GPU was ${gpuAt.utilizationPercent}% busy`,
      weight: 0.55,
    });
  }

  // CPU. Both halves matter: a pinned game thread and a busy phone are
  // different problems with the same symptom.
  const cpuAt = nearestBy(input.cpuSeries, atMs, COINCIDENCE_TOLERANCE_MS);
  if (cpuAt) {
    const busiest = cpuAt.threads[0];
    if (busiest && busiest.cpuPercent >= 90) {
      causes.push({
        subsystem: 'cpu',
        statement:
          `${busiest.name} was pinned at ${busiest.cpuPercent}% of one core` +
          (busiest.lastCluster ? ` on the ${busiest.lastCluster} cluster` : ''),
        weight: 0.6,
      });
    }
    if (cpuAt.otherCpuPercentOfDevice != null && cpuAt.otherCpuPercentOfDevice >= 35) {
      causes.push({
        subsystem: 'system',
        statement:
          `other processes were using ${cpuAt.otherCpuPercentOfDevice}% of the device's CPU, so ` +
          'the phone was busy with something other than the game',
        weight: 0.5,
      });
    }
  }

  // Audio starvation in the same window. Rarely the cause of a frame drop, but
  // often a symptom of the same thread starvation, which is worth pairing.
  const audioJump = audioUnderrunDelta(input.audioSeries, atMs);
  if (audioJump !== null && audioJump > 0) {
    causes.push({
      subsystem: 'audio',
      statement: `the audio mixer missed ${audioJump} buffer${audioJump === 1 ? '' : 's'}`,
      weight: 0.3,
    });
  }

  // Thermal throttling is a state, not an event, so it is attached to every
  // episode inside it - the clocks really were lower for all of them.
  if (input.thermal?.verdict === 'throttling') {
    causes.push({
      subsystem: 'thermal',
      statement:
        `the device was thermally throttled during the session (peak ${input.thermal.peakC ?? '?'} °C)`,
      weight: 0.45,
    });
  }

  causes.sort((a, b) => b.weight - a.weight);
  // Four is enough to name a cause and its context; more reads as a list of
  // everything that happened, which is what a raw log already is.
  return causes.slice(0, 4);
}

function buildDiagnosis(
  input: DiagnosticsInput,
  event: FpsEvent,
  causes: DiagnosticCause[],
  index: number,
): Diagnosis {
  const at = formatClock(event.atMs);
  const seconds = Math.max(1, Math.round(event.durationMs / 1000));

  /*
   * The symptom names both ends of the fall, not just the bottom.
   *
   * "Frame rate fell to 18 fps" leaves the reader to find out for themselves
   * whether that was a collapse or a slow game. "Fell from 58 to 18 for 3 s"
   * is the same measurement with the judgement already possible.
   */
  const symptom =
    `Frame rate fell from ${event.beforeFps} to ${event.lowestFps} fps at ${at}` +
    (seconds > 1 ? ` and stayed down for about ${seconds} s` : '') +
    ` - a drop of ${Math.abs(event.changePercent).toFixed(0)}% against ${event.basis}`;

  // Severity is the detector's, which judged it against what the game had
  // actually been achieving rather than against the session median alone.
  const severity: Severity = event.severity;

  const conclusion =
    causes.length === 0
      ? `${symptom}. Nothing in the other subsystems moved in the same window, so this drop is ` +
        'unexplained by the data collected. Adding the Unity reporter component to the build ' +
        'would give per-frame thread and GPU times, which is what usually settles it.'
      : `${symptom}. In the same window (±${COINCIDENCE_TOLERANCE_MS / 1000} s): ` +
        `${causes.map((c) => c.statement).join('; ')}. ` +
        `Most likely cause: ${SUBSYSTEM_CAUSE[causes[0]!.subsystem]}. ` +
        'These readings coincide; the tool does not prove one caused the other.';

  const confidence =
    causes.length === 0
      ? 0.2
      : clamp01(0.35 + causes[0]!.weight * 0.4 + (causes.length - 1) * 0.05);

  return {
    id: `diag_${input.role}_${index + 1}`,
    role: input.role,
    letter: event.letter,
    kind: event.kind,
    atMs: event.atMs,
    fromMs: event.fromMs,
    toMs: event.toMs,
    durationMs: event.durationMs,
    toleranceMs: COINCIDENCE_TOLERANCE_MS,
    symptom,
    fps: event.lowestFps,
    beforeFps: event.beforeFps,
    lowestFps: event.lowestFps,
    afterFps: event.afterFps,
    changePercent: event.changePercent,
    windows: event.windows,
    basis: event.basis,
    janks: event.janks,
    severity,
    // Confidence rises with corroboration and with the strength of the best
    // signal, and is capped: this is correlation, and a number near 1 would
    // misrepresent what it is.
    confidence,
    level: confidenceLevel(confidence),
    causes,
    conclusion,
    recommendation:
      causes.length === 0
        ? 'Re-run with the Unity reporter component in the build so per-frame thread and GPU ' +
          'times are available for this window.'
        : SUBSYSTEM_FIX[causes[0]!.subsystem],
    nearestMarker: nearestMarkerLabel(input.markers, event.atMs),
  };
}

function diagnoseProcessDeath(input: DiagnosticsInput, index: number): Diagnosis {
  const worstSpike = [...input.memorySpikes].sort((a, b) => b.totalBytes - a.totalBytes)[0];
  const causes: DiagnosticCause[] = worstSpike
    ? [
        {
          subsystem: 'memory',
          statement:
            `the session's highest memory point was ${formatBytes(worstSpike.totalBytes)}, reached ` +
            `after a ${formatBytes(worstSpike.deltaBytes)} rise`,
          weight: 0.85,
        },
      ]
    : [];

  return {
    id: `diag_${input.role}_${index + 1}`,
    role: input.role,
    // No letter: there is no point on the frame-rate chart to badge. The
    // process was gone, which is not a dip in a curve.
    letter: '',
    kind: 'process-death',
    atMs: input.durationMs,
    fromMs: input.durationMs,
    toMs: input.durationMs,
    durationMs: 0,
    toleranceMs: COINCIDENCE_TOLERANCE_MS,
    symptom: `The game process died ${input.processDeaths} time${input.processDeaths === 1 ? '' : 's'} during the session`,
    fps: 0,
    beforeFps: 0,
    lowestFps: 0,
    afterFps: 0,
    changePercent: 0,
    windows: 0,
    basis: 'the process was observed to exit',
    janks: 0,
    severity: 'critical',
    // A kill is observed directly rather than inferred, so this is the one
    // diagnosis that does not depend on correlation being right - and the only
    // one allowed to say "Confirmed".
    confidence: 0.95,
    level: 'confirmed',
    causes,
    conclusion:
      `The process was killed or crashed ${input.processDeaths} time${input.processDeaths === 1 ? '' : 's'}. ` +
      'On Android this is almost always the low-memory killer choosing this process, which means ' +
      'the memory budget was exceeded regardless of what the last sample recorded - the sampler ' +
      'can miss the true peak in the moment before a kill.' +
      (causes.length > 0 ? ` ${causes[0]!.statement}.` : ''),
    recommendation:
      'Treat the memory peak as the first thing to fix. Everything else in this report is ' +
      'secondary while the app is being killed.',
    nearestMarker: null,
  };
}

/** What a subsystem being the top signal usually means, in plain words. */
const SUBSYSTEM_CAUSE: Record<Subsystem, string> = {
  memory: 'an asset load that was not budgeted for',
  gpu: 'the GPU running out of headroom for that frame',
  rendering: 'a jump in rendering work submitted for that frame',
  cpu: 'the CPU thread that builds the frame running out of time',
  storage: 'a blocking read from storage',
  audio: 'the audio thread being starved, which usually means the CPU was oversubscribed',
  thermal: 'the device limiting its own clocks because it was hot',
  system: 'something other than the game using the phone',
};

const SUBSYSTEM_FIX: Record<Subsystem, string> = {
  memory:
    'Load the assets for this moment ahead of time or in smaller pieces, and check whether the ' +
    'previous screen released what it allocated.',
  gpu:
    'Reduce per-pixel cost first - full-screen transparent layers, stacked particles and ' +
    'expensive fragment shaders - before reducing geometry.',
  rendering:
    'Look at what starts rendering at this moment. Batching breaks on per-object material ' +
    'instances, and UI canvases rebuild the whole canvas when one element changes.',
  cpu:
    'Profile this moment on the main thread. Instantiation, physics and deserialisation are the ' +
    'usual causes of a spike this shape.',
  storage:
    'Move this read off the frame: load asynchronously, or preload during a screen the player is ' +
    'already waiting on.',
  audio:
    'Cap simultaneous voices and move decoding off the main thread. Streaming clips that are ' +
    'short enough to load fully are the common culprit.',
  thermal:
    'Reduce sustained load rather than peak load. A frame cap that holds the device cool will ' +
    'often produce a higher and steadier frame rate than an uncapped one that throttles.',
  system:
    'Re-run on a quiet device before acting on this. Close background apps, and use a fresh-start ' +
    'run so the measurement is of the build rather than of the phone.',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Nearest point on a series to a moment, within a tolerance. */
function nearestBy<T extends { elapsedMs: number }>(
  series: T[],
  atMs: number,
  toleranceMs: number,
): T | null {
  let best: T | null = null;
  let bestGap = Infinity;
  for (const point of series) {
    const gap = Math.abs(point.elapsedMs - atMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = point;
    }
  }
  return bestGap <= toleranceMs ? best : null;
}

/**
 * How far a value at one point sits above the session's own median.
 *
 * Against the median rather than the previous sample, because the reporter's
 * cadence and the frame-rate cadence differ and "the previous sample" can be
 * inside the same event. The median is the game's normal, which is the only
 * baseline that makes "tripled" mean anything.
 */
function relativeJump(
  series: RenderPoint[],
  at: RenderPoint,
  pick: (p: RenderPoint) => number | undefined,
): { value: number; baseline: number; ratio: number } | null {
  const value = pick(at);
  if (typeof value !== 'number' || value <= 0) return null;

  const all = series.map(pick).filter((v): v is number => typeof v === 'number' && v > 0);
  if (all.length < 4) return null;

  const baseline = medianOf(all);
  if (baseline <= 0) return null;
  return { value, baseline, ratio: value / baseline };
}

/** Underruns that accumulated across the window around a moment. */
function audioUnderrunDelta(series: AudioPoint[], atMs: number): number | null {
  const window = series.filter((p) => Math.abs(p.elapsedMs - atMs) <= COINCIDENCE_TOLERANCE_MS);
  const counts = window
    .map((p) => p.underrunCount)
    .filter((v): v is number => v !== null);
  if (counts.length < 2) return null;
  return Math.max(0, counts[counts.length - 1]! - counts[0]!);
}

function nearestMarkerLabel(
  markers: Array<{ elapsedMs: number; label: string }>,
  elapsedMs: number,
): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const marker of markers) {
    if (marker.elapsedMs <= elapsedMs && marker.elapsedMs > bestMs) {
      bestMs = marker.elapsedMs;
      best = marker.label;
    }
  }
  return best;
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/** `m:ss` from the start of the session - how an operator refers to a moment. */
export function formatClock(elapsedMs: number): string {
  const total = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
