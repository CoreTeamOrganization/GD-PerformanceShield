/**
 * What was holding the frame up.
 *
 * A frame rate on its own tells a studio that something is wrong. This says
 * which subsystem to open first, which is the difference between a week of
 * guessing and an afternoon of work.
 *
 * The method, in order of how much it can be trusted:
 *
 *  1. Engine thread times. Unity reports main-thread, render-thread and GPU
 *     time per frame. Whichever is closest to the frame interval is the one
 *     setting the pace, and this is a direct measurement rather than an
 *     inference. Requires the reporter component in the build.
 *  2. OS signals. Failing that, a pinned main thread with an idle GPU is
 *     CPU-bound; a saturated GPU with a main thread that has headroom is
 *     GPU-bound. Weaker, because per-core load is sampled every few seconds and
 *     a frame lasts sixteen milliseconds, but it is what a release build allows.
 *  3. Nothing. Where neither is available this says so. An unattributed frame
 *     drop reported as "CPU-bound" because that is the common case would be a
 *     guess wearing a measurement's clothes.
 *
 * Storage and heat are handled as *contributors* rather than as the primary
 * bound: a disk stall is a few frames rather than a steady state, and thermal
 * throttling lowers the ceiling on everything at once instead of competing for
 * one frame.
 */
import type { CpuSummary } from '../telemetry/cpuThreads.js';
import type { DiskIoSummary } from '../telemetry/diskIo.js';
import type { FpsSummary, ThermalSummary } from '../telemetry/deviceHealth.js';
import type { GpuSummary, RenderSummary } from '../telemetry/gpu.js';

export type BottleneckKind =
  | 'cpu-main'
  | 'cpu-render'
  | 'gpu'
  | 'storage'
  | 'thermal'
  | 'balanced'
  | 'unknown';

/**
 * Whether pixel cost looks like the problem.
 *
 * Named as the inference it is. Neither Unity nor Android exposes an overdraw
 * counter - Android's overdraw debugging is a screen tint with no readable
 * output - so nothing here is a measurement of overdraw. What it does measure is
 * a GPU that is busy while the geometry it was given is trivial, and on a mobile
 * game that combination is nearly always fill rate: full-screen transparent
 * layers, stacked particle systems, or an expensive fragment shader.
 */
export type FillRatePressure = 'likely' | 'unlikely' | 'unknown';

export interface FrameBudget {
  /** Milliseconds one frame is allowed, from the panel's refresh rate. */
  targetMs: number | null;
  /** What a frame actually took, from the measured typical frame time. */
  actualMs: number | null;
  mainThreadMs: number | null;
  renderThreadMs: number | null
  gpuFrameMs: number | null;
}

export interface BottleneckVerdict {
  kind: BottleneckKind;
  /** One line a producer can read. */
  headline: string;
  /** Why this verdict, naming the figures it rests on. */
  reason: string;
  /** 0..1. Direct thread timing scores high; an OS-signal inference does not. */
  confidence: number;
  frameBudget: FrameBudget;
  /** Subsystems that cost frames without being the primary bound. */
  contributors: Array<{ kind: BottleneckKind; note: string }>;
  fillRatePressure: FillRatePressure;
  /** How the verdict was reached, so a reader can weigh it. */
  basis: 'engine-thread-times' | 'os-signals' | 'none';
}

export interface BottleneckInput {
  fps: FpsSummary | null;
  render: RenderSummary | null;
  gpu: GpuSummary | null;
  cpu: CpuSummary | null;
  io: DiskIoSummary | null;
  thermal: ThermalSummary | null;
}

/**
 * Geometry below this is not what is costing GPU time on a phone.
 *
 * A modern mobile GPU chews through a few hundred thousand triangles without
 * noticing. When it is busy anyway, the cost is per-pixel rather than
 * per-vertex - which is what makes this the threshold for the fill-rate
 * inference rather than a quality bar for triangle counts.
 */
const LOW_GEOMETRY_TRIANGLES = 350_000;

export function classifyBottleneck(input: BottleneckInput): BottleneckVerdict {
  const { fps, render, gpu, cpu, io, thermal } = input;

  const targetMs = fps?.displayHz ? round2(1000 / fps.displayHz) : null;
  // The typical frame, not the average frame rate: one over the median gap
  // between frames is what the game achieved when it was rendering, and it is
  // the figure the thread times have to be compared against.
  const actualMs =
    fps?.typicalFrameFps != null && fps.typicalFrameFps > 0
      ? round2(1000 / fps.typicalFrameFps)
      : fps?.medianFps != null && fps.medianFps > 0
        ? round2(1000 / fps.medianFps)
        : null;

  const frameBudget: FrameBudget = {
    targetMs,
    actualMs,
    mainThreadMs: render?.averageMainThreadMs ?? null,
    renderThreadMs: render?.averageRenderThreadMs ?? null,
    gpuFrameMs: render?.averageGpuFrameMs ?? null,
  };

  const contributors = collectContributors(io, thermal, cpu);
  const fillRatePressure = assessFillRate(render, gpu);

  // 1. Engine thread times: a measurement rather than an inference.
  const timed = classifyFromThreadTimes(frameBudget);
  if (timed) {
    return { ...timed, frameBudget, contributors, fillRatePressure, basis: 'engine-thread-times' };
  }

  // 2. OS signals.
  const inferred = classifyFromOsSignals(gpu, cpu);
  if (inferred) {
    return { ...inferred, frameBudget, contributors, fillRatePressure, basis: 'os-signals' };
  }

  // 3. Nothing measurable. A thermal or storage contributor can still be the
  // whole story, so it is promoted rather than reported alongside a shrug.
  const promoted = contributors[0];
  if (promoted) {
    return {
      kind: promoted.kind,
      headline: promoted.note,
      reason:
        'Neither the engine reporter nor per-core load was available, so this is the one ' +
        'subsystem that could be measured - not necessarily the largest cost.',
      confidence: 0.4,
      frameBudget,
      contributors: contributors.slice(1),
      fillRatePressure,
      basis: 'none',
    };
  }

  return {
    kind: 'unknown',
    headline: 'What limited the frame rate could not be determined.',
    reason:
      'This needs either the Unity reporter component in the build, which gives main-thread, ' +
      'render-thread and GPU time per frame, or a device that lets an adb shell read per-core ' +
      'load. Neither was available on this run.',
    confidence: 0,
    frameBudget,
    contributors,
    fillRatePressure,
    basis: 'none',
  };
}

/**
 * Attribute the frame to whichever stage took longest.
 *
 * Unity's three figures are not additive - the render thread and GPU work on
 * the previous frame while the main thread works on the current one, which is
 * the point of a threaded renderer - so the frame costs roughly the *longest*
 * of the three, not their sum. That is why this compares them rather than
 * apportioning a total between them.
 *
 * A stage has to be more than 15% ahead of the next to be called the bound.
 * Inside that margin the pipeline is balanced, and telling a studio to optimise
 * the main thread when the GPU is 3% behind it would send them after a frame
 * they cannot win.
 */
function classifyFromThreadTimes(
  budget: FrameBudget,
): Omit<BottleneckVerdict, 'frameBudget' | 'contributors' | 'fillRatePressure' | 'basis'> | null {
  const stages: Array<{ kind: BottleneckKind; label: string; ms: number }> = [];
  if (budget.mainThreadMs != null) {
    stages.push({ kind: 'cpu-main', label: 'the main thread (game logic and physics)', ms: budget.mainThreadMs });
  }
  if (budget.renderThreadMs != null) {
    stages.push({ kind: 'cpu-render', label: 'the render thread (draw submission)', ms: budget.renderThreadMs });
  }
  if (budget.gpuFrameMs != null) {
    stages.push({ kind: 'gpu', label: 'the GPU', ms: budget.gpuFrameMs });
  }
  if (stages.length === 0) return null;

  stages.sort((a, b) => b.ms - a.ms);
  const worst = stages[0]!;
  const runnerUp = stages[1];

  /*
   * A stage can only be the bound if it comes near to filling the frame.
   *
   * The header says the pace-setter is whichever stage is closest to the frame
   * interval, and this is where that comparison actually happens. Without it, a
   * healthy 30 fps-capped game averaging main 6 ms / render 4 ms / GPU 3 ms was
   * reported as "limited by the main thread" at high confidence - naming the
   * tallest of three idle stages, and sending a studio after a frame they
   * already had. Everything well under the budget means the rate is being set
   * by a cap, vsync or a sleep, and that is the finding.
   */
  if (budget.targetMs != null && worst.ms < budget.targetMs * 0.7) {
    return {
      kind: 'balanced',
      headline: 'No stage fills the frame - the rate is set by a cap or vsync, not the hardware.',
      reason:
        `The longest stage, ${worst.label}, took ${worst.ms} ms of the ${budget.targetMs} ms one ` +
        'frame is allowed - every stage has headroom. A rate below the panel with this much ' +
        'headroom usually means a frame cap, vsync, or a sleep in the game loop.',
      confidence: 0.7,
    };
  }

  // One stage and nothing to compare it to - neither a runner-up nor a frame
  // budget. Naming it the bound would be a claim with no comparison behind it,
  // so fall through to the OS signals instead.
  if (!runnerUp && budget.targetMs == null) return null;

  const overTarget =
    budget.targetMs != null && worst.ms > budget.targetMs
      ? ` That is over the ${budget.targetMs} ms one frame is allowed at this refresh rate.`
      : '';

  if (runnerUp && worst.ms < runnerUp.ms * 1.15) {
    return {
      kind: 'balanced',
      headline: 'No single stage is the bottleneck - the pipeline is evenly loaded.',
      reason:
        `${stages.map((s) => `${s.label} ${s.ms} ms`).join(', ')}. ` +
        'Within 15% of each other, so cutting work from one stage will mostly expose the next.' +
        overTarget,
      confidence: 0.7,
    };
  }

  const margin = runnerUp ? ` against ${runnerUp.ms} ms for ${runnerUp.label}` : '';
  return {
    kind: worst.kind,
    headline: `Frames are limited by ${worst.label}.`,
    reason: `It took ${worst.ms} ms per frame${margin}.${overTarget}`,
    // High, because these are the engine's own per-frame measurements. Not
    // total: they are averages over the session, so a bound that only existed
    // during one scene can be averaged into the background.
    confidence: 0.85,
  };
}

/**
 * Fall back to whole-core load and GPU utilisation.
 *
 * Much weaker than thread timing and labelled as such. Per-core load is
 * sampled every few seconds while a frame lasts sixteen milliseconds, so this
 * can only see a bound that persisted - which, fortunately, is the kind worth
 * reporting.
 */
function classifyFromOsSignals(
  gpu: GpuSummary | null,
  cpu: CpuSummary | null,
): Omit<BottleneckVerdict, 'frameBudget' | 'contributors' | 'fillRatePressure' | 'basis'> | null {
  const gpuSaturated =
    gpu?.averageUtilizationPercent != null && gpu.averageUtilizationPercent >= 85;
  const gpuIdle = gpu?.averageUtilizationPercent != null && gpu.averageUtilizationPercent < 60;

  const main = cpu?.mainThread ?? null;
  const renderThread = cpu?.renderThread ?? null;
  const mainPinned = main != null && main.averageCpuPercent >= 85;
  const renderPinned = renderThread != null && renderThread.averageCpuPercent >= 85;

  if (mainPinned && !gpuSaturated) {
    return {
      kind: 'cpu-main',
      headline: 'Frames are limited by the main thread.',
      reason:
        `${main!.name} averaged ${main!.averageCpuPercent}% of one core` +
        (main!.dominantCluster ? ` on the ${main!.dominantCluster} cluster` : '') +
        (gpu?.averageUtilizationPercent != null
          ? `, while the GPU averaged ${gpu.averageUtilizationPercent}%.`
          : '. GPU load was not readable, so this rests on the CPU side alone.'),
      confidence: 0.6,
    };
  }

  if (renderPinned && !gpuSaturated) {
    return {
      kind: 'cpu-render',
      headline: 'Frames are limited by the render thread.',
      reason:
        `${renderThread!.name} averaged ${renderThread!.averageCpuPercent}% of one core. ` +
        'That thread does draw submission, so the cost is the number of draw calls and state ' +
        'changes rather than the work inside the shaders.',
      confidence: 0.6,
    };
  }

  if (gpuSaturated && !mainPinned) {
    return {
      kind: 'gpu',
      headline: 'Frames are limited by the GPU.',
      reason:
        `GPU utilisation averaged ${gpu!.averageUtilizationPercent}%` +
        (gpu!.saturatedSamplePercent != null
          ? ` and was above 90% for ${gpu!.saturatedSamplePercent}% of the session`
          : '') +
        (main ? `, while ${main.name} averaged ${main.averageCpuPercent}% of a core.` : '.'),
      confidence: 0.6,
    };
  }

  if (gpuSaturated && mainPinned) {
    return {
      kind: 'balanced',
      headline: 'Both the CPU and the GPU are saturated.',
      reason:
        `The GPU averaged ${gpu!.averageUtilizationPercent}% and ${main!.name} averaged ` +
        `${main!.averageCpuPercent}% of a core. Reducing either alone will not raise the frame ` +
        'rate much, because the other will take over as the limit.',
      confidence: 0.55,
    };
  }

  // Everything has headroom. That is a real, useful finding: the frame rate is
  // being set by a cap or by vsync, not by the hardware running out.
  if (gpuIdle && cpu?.averageAppCpuPercentOfCore != null && !mainPinned && main != null) {
    return {
      kind: 'balanced',
      headline: 'Neither the CPU nor the GPU ran out of headroom.',
      reason:
        `The GPU averaged ${gpu!.averageUtilizationPercent}% and the busiest thread ` +
        `(${main.name}) averaged ${main.averageCpuPercent}% of a core. A frame rate below the ` +
        'panel with headroom on both sides usually means a frame cap, vsync, or a sleep in the ' +
        'game loop rather than a hardware limit.',
      confidence: 0.5,
    };
  }

  return null;
}

/**
 * Subsystems that cost frames without being the steady-state bound.
 *
 * Kept separate on purpose. A studio told "you are storage-bound" would go
 * looking for a loading problem that runs all session; what actually happened
 * is three scene loads that each stalled for 200 ms, and those are fixed
 * differently.
 */
function collectContributors(
  io: DiskIoSummary | null,
  thermal: ThermalSummary | null,
  cpu: CpuSummary | null,
): Array<{ kind: BottleneckKind; note: string }> {
  const out: Array<{ kind: BottleneckKind; note: string }> = [];

  if (thermal && (thermal.verdict === 'throttling' || (thermal.riseC ?? 0) >= 10)) {
    out.push({
      kind: 'thermal',
      note:
        thermal.verdict === 'throttling'
          ? `The device throttled for ${Math.round(thermal.throttlingMs / 1000)} s, so it was ` +
            'limiting its own clocks - every figure after that point is of a slower phone.'
          : `The device warmed ${thermal.riseC} °C, which is enough for the clocks to start ` +
            'dropping in a longer session than this one.',
    });
  }

  if (io && io.burstsWithStutter > 0) {
    const cost =
      io.fpsDuringBursts != null && io.fpsOutsideBursts != null
        ? ` Frame rate averaged ${io.fpsDuringBursts} fps during those reads against ` +
          `${io.fpsOutsideBursts} fps outside them.`
        : '';
    out.push({
      kind: 'storage',
      note:
        `${io.burstsWithStutter} of the session's heavy reads landed in a window that also ` +
        `dropped frames.${cost}`,
    });
  }

  // Background load is not a bottleneck in the game, but it changes what every
  // other figure means, so a reader has to know about it.
  if (cpu?.averageOtherCpuPercentOfDevice != null && cpu.averageOtherCpuPercentOfDevice >= 25) {
    out.push({
      kind: 'cpu-main',
      note:
        `Other processes used ${cpu.averageOtherCpuPercentOfDevice}% of the device's CPU during ` +
        'the session, so the game was not competing for an idle phone. Re-run on a quiet device ' +
        'before treating these numbers as the build’s own.',
    });
  }

  return out;
}

/**
 * Is pixel cost the likely explanation for GPU time?
 *
 * Only claimed when the GPU is genuinely busy *and* the geometry it was handed
 * is trivial. Both halves matter: heavy geometry with a busy GPU is a vertex
 * problem, and an idle GPU is not a fill-rate problem at all.
 */
function assessFillRate(render: RenderSummary | null, gpu: GpuSummary | null): FillRatePressure {
  const gpuMs = render?.averageGpuFrameMs ?? null;
  const utilization = gpu?.averageUtilizationPercent ?? null;
  const triangles = render?.averageTriangles ?? null;

  const gpuBusy = (gpuMs != null && gpuMs >= 8) || (utilization != null && utilization >= 80);
  if (!gpuBusy) {
    // "Unlikely" only when the GPU was actually measured to be idle. Absent
    // measurement it stays unknown rather than becoming good news.
    return gpuMs != null || utilization != null ? 'unlikely' : 'unknown';
  }
  if (triangles === null) return 'unknown';
  return triangles < LOW_GEOMETRY_TRIANGLES ? 'likely' : 'unlikely';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
