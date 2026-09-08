/**
 * What the performance sections say, decided once.
 *
 * The Markdown cut and the printed page have to state the same thing about GPU
 * load, threading, storage and audio. If each renderer decided for itself when
 * 62% GPU utilisation is worth flagging, the two documents from one report would
 * eventually disagree - which is the one failure a report cannot survive. So the
 * *content* lives here as plain rows and verdicts, and each renderer only
 * decides how to draw them.
 *
 * Nothing in this file measures anything. It reads the summaries the telemetry
 * layer produced and turns them into sentences, including the sentences that
 * say a figure was not measurable and what to change to measure it.
 */
import { MB } from '../core/types.js';
import type { AnalysisReport } from './model.js';
import { fmt } from './format.js';

type Device = AnalysisReport['devices'][number];

/** One label/value line in a summary table. */
export interface PerfRow {
  label: string;
  value: string;
  /** Context: what the figure is measured against, or why it is missing. */
  note?: string;
}

/**
 * How a subsystem came out.
 *
 * `unmeasured` is a first-class outcome and never collapses into `ok`. A report
 * that shows a green tick for a probe that never ran teaches a studio that the
 * green ticks mean nothing.
 */
export type SubsystemStatus = 'ok' | 'watch' | 'problem' | 'unmeasured';

export interface SubsystemRow {
  subsystem: string;
  status: SubsystemStatus;
  /** The figure, in a few words. */
  headline: string;
  /** What it is measured against, or what to change to measure it. */
  detail: string;
}

export const STATUS_MARK: Record<SubsystemStatus, string> = {
  ok: '🟢',
  watch: '🟡',
  problem: '🔴',
  unmeasured: '⚪',
};

export const STATUS_LABEL: Record<SubsystemStatus, string> = {
  ok: 'OK',
  watch: 'Watch',
  problem: 'Problem',
  unmeasured: 'Not measured',
};

// ---------------------------------------------------------------------------
// Where the frame went
// ---------------------------------------------------------------------------

/**
 * The frame budget, as a table.
 *
 * The three stage times are deliberately not summed. Unity's renderer works on
 * the previous frame while the main thread works on the current one, so a frame
 * costs roughly the longest of the three rather than their total, and a "total"
 * row would invite a reader to add up numbers that do not add up.
 */
export function frameBudgetRows(device: Device): PerfRow[] {
  const b = device.bottleneck;
  if (!b) return [];

  const rows: PerfRow[] = [];
  const budget = b.frameBudget;

  if (budget.targetMs !== null) {
    rows.push({
      label: 'One frame is allowed',
      value: `${budget.targetMs} ms`,
      note: device.fps?.displayHz ? `the screen refreshes at ${device.fps.displayHz} Hz` : '',
    });
  }
  if (budget.actualMs !== null) {
    rows.push({
      label: 'A typical frame took',
      value: `${budget.actualMs} ms`,
      note:
        budget.targetMs !== null && budget.actualMs > budget.targetMs
          ? `${round1(budget.actualMs - budget.targetMs)} ms over budget`
          : 'within budget',
    });
  }

  const stage = (label: string, ms: number | null, note: string) => {
    if (ms === null) return;
    rows.push({ label, value: `${ms} ms`, note });
  };
  stage('— main thread', budget.mainThreadMs, 'game logic, physics, script updates');
  stage('— render thread', budget.renderThreadMs, 'submitting draw calls to the driver');
  stage('— GPU', budget.gpuFrameMs, 'shading the pixels');

  return rows;
}

/**
 * The bottleneck as a sentence plus its caveat.
 *
 * The caveat is not optional decoration. A verdict from the engine's own
 * per-frame timings and one inferred from five-second CPU samples deserve very
 * different amounts of trust, and a reader cannot tell them apart unless the
 * report says which it is.
 */
export function bottleneckStatement(device: Device): { headline: string; reason: string; basis: string } | null {
  const b = device.bottleneck;
  if (!b) return null;

  const basis =
    b.basis === 'engine-thread-times'
      ? 'Measured from the engine’s own per-frame main-thread, render-thread and GPU times.'
      : b.basis === 'os-signals'
        ? 'Inferred from GPU utilisation and per-thread CPU load, which are sampled every few ' +
          'seconds while a frame lasts milliseconds — so this shows a limit that persisted, not ' +
          'one that lasted a single frame.'
        : 'No direct measurement was available on this run.';

  return { headline: b.headline, reason: b.reason, basis };
}

// ---------------------------------------------------------------------------
// The subsystem check
// ---------------------------------------------------------------------------

/**
 * One row per subsystem: the figure, and whether it is a problem.
 *
 * This is the table the summary leads with, because it is the only place a
 * reader sees all five modules at once and can tell which one to open.
 * Thresholds come from the device's tier where one applies, so the bar is the
 * same bar the CI gate uses.
 */
export function subsystemRows(device: Device): SubsystemRow[] {
  const rows: SubsystemRow[] = [];
  const tier = device.tier;

  rows.push(gpuRow(device));
  rows.push(renderRow(device, tier));
  rows.push(cpuRow(device));
  rows.push(storageRow(device));
  rows.push(audioRow(device, tier));

  return rows;
}

function gpuRow(device: Device): SubsystemRow {
  const g = device.gpu;
  if (!g || g.averageUtilizationPercent === null) {
    // The clock is worth reporting even with no load figure: a GPU that never
    // leaves its top frequency bin is being asked for everything it has.
    if (g?.clockPinnedPercent != null && g.averageClockMhz !== null) {
      return {
        subsystem: 'GPU',
        status: g.clockPinnedPercent >= 50 ? 'watch' : 'ok',
        headline: `${g.averageClockMhz} MHz average clock`,
        detail:
          `Load percentage was not readable on this device, but the clock was at its ceiling for ` +
          `${g.clockPinnedPercent}% of the session.`,
      };
    }
    return {
      subsystem: 'GPU',
      status: 'unmeasured',
      headline: 'not readable',
      detail:
        g?.unavailableReason ??
        'No GPU load interface answered. Most retail Android builds deny an adb shell read of the ' +
          'vendor sysfs nodes; a rooted or engineering device will report it.',
    };
  }

  const status: SubsystemStatus =
    g.averageUtilizationPercent >= 90 ? 'problem' : g.averageUtilizationPercent >= 75 ? 'watch' : 'ok';
  return {
    subsystem: 'GPU',
    status,
    headline: `${g.averageUtilizationPercent}% busy on average`,
    detail:
      `Peaked at ${g.peakUtilizationPercent}%` +
      (g.saturatedSamplePercent !== null
        ? `, and was above 90% for ${g.saturatedSamplePercent}% of the session.`
        : '.') +
      (status === 'ok' ? ' There is headroom here.' : ' The GPU is close to its limit.'),
  };
}

function renderRow(device: Device, tier: Device['tier']): SubsystemRow {
  const r = device.render;
  if (!r || r.averageDrawCalls === null) {
    return {
      subsystem: 'Rendering',
      status: 'unmeasured',
      headline: 'not available',
      detail:
        'Draw calls, batches and geometry counts can only be read from inside the engine. Add ' +
        'scripts/unity/PerformanceShieldReporter.cs to the project and make a development build.',
    };
  }

  const limit = tier?.maxDrawCalls ?? null;
  const status: SubsystemStatus =
    limit === null
      ? 'ok'
      : r.averageDrawCalls > limit
        ? 'problem'
        : r.averageDrawCalls > limit * 0.8
          ? 'watch'
          : 'ok';

  // Batching efficiency, when both figures exist: the gap between draw calls
  // and batches is what batching actually saved.
  const batching =
    r.averageBatches !== null && r.averageDrawCalls > 0
      ? ` Batching reduced them to ${r.averageBatches.toLocaleString()} batches.`
      : '';

  return {
    subsystem: 'Rendering',
    status,
    headline: `${r.averageDrawCalls.toLocaleString()} draw calls per frame`,
    detail:
      (limit !== null
        ? `Peak ${r.peakDrawCalls?.toLocaleString() ?? '?'}, against ${limit.toLocaleString()} for a ` +
          `${tier!.tier}-tier device.`
        : `Peak ${r.peakDrawCalls?.toLocaleString() ?? '?'}.`) + batching,
  };
}

function cpuRow(device: Device): SubsystemRow {
  const c = device.cpu;
  if (!c || c.averageAppCpuPercentOfCore === null) {
    return {
      subsystem: 'CPU',
      status: 'unmeasured',
      headline: 'not readable',
      detail:
        c?.unavailableReason ??
        'Per-core and per-thread CPU load could not be read on this device.',
    };
  }

  const busiest = c.mainThread ?? c.threads[0] ?? null;
  const pinned = busiest !== null && busiest.averageCpuPercent >= 85;
  const status: SubsystemStatus = pinned
    ? 'problem'
    : busiest !== null && busiest.averageCpuPercent >= 70
      ? 'watch'
      : 'ok';

  const background =
    c.averageOtherCpuPercentOfDevice !== null && c.averageOtherCpuPercentOfDevice >= 25
      ? ` Other apps used ${c.averageOtherCpuPercentOfDevice}% of the device — the phone was not idle.`
      : '';

  return {
    subsystem: 'CPU',
    status,
    headline: busiest
      ? `${busiest.name} at ${busiest.averageCpuPercent}% of one core`
      : `${c.averageAppCpuPercentOfCore}% of one core`,
    detail:
      (busiest
        ? `Peaked at ${busiest.peakCpuPercent}%` +
          (busiest.dominantCluster
            ? `, running mostly on the ${busiest.dominantCluster} cluster.`
            : '.') +
          (pinned
            ? ' A thread at this level is saturated: idle cores elsewhere cannot help it.'
            : '')
        : `The process averaged ${c.averageAppCpuPercentOfCore}% of one core.`) + background,
  };
}

function storageRow(device: Device): SubsystemRow {
  const io = device.io;
  if (!io || io.sampleCount === 0) {
    return {
      subsystem: 'Storage',
      status: 'unmeasured',
      headline: 'not readable',
      detail:
        io?.unavailableReason ??
        'Disk I/O counters need a debuggable build or a rooted device; a release build on a stock ' +
          'handset denies the read.',
    };
  }

  const status: SubsystemStatus =
    io.burstsWithStutter >= 3 ? 'problem' : io.burstsWithStutter > 0 ? 'watch' : 'ok';

  const cache =
    io.cacheHitPercent !== null
      ? ` ${io.cacheHitPercent}% of it was served from the page cache rather than flash.`
      : '';
  const cost =
    io.burstsWithStutter > 0 && io.fpsDuringBursts !== null && io.fpsOutsideBursts !== null
      ? ` Frame rate averaged ${io.fpsDuringBursts} fps during heavy reads against ` +
        `${io.fpsOutsideBursts} fps outside them.`
      : '';

  return {
    subsystem: 'Storage',
    status,
    /*
     * The headline says why the row is flagged, not just how much was read.
     *
     * A total is the right figure when nothing went wrong - it says the loading
     * was measured and cost nothing. But "604 MB read" beside an amber light
     * leaves a reader to guess which of those two facts is the problem, and the
     * problem is never the size: it is the reads that landed on a frame.
     */
    headline:
      io.burstsWithStutter > 0
        ? `${io.burstsWithStutter} read${io.burstsWithStutter === 1 ? '' : 's'} cost frames`
        : io.totalReadBytes !== null
          ? `${fmt(io.totalReadBytes)} read during the session`
          : 'measured',
    detail:
      (io.burstsWithStutter === 0
        ? 'No heavy read landed in a window that dropped frames.'
        : `${io.burstsWithStutter} heavy read${io.burstsWithStutter === 1 ? '' : 's'} coincided with ` +
          'dropped frames.') +
      cache +
      cost,
  };
}

function audioRow(device: Device, tier: Device['tier']): SubsystemRow {
  const a = device.audio;
  if (!a || (a.underrunsPerMinute === null && a.peakPlayingSources === null)) {
    return {
      subsystem: 'Audio',
      status: 'unmeasured',
      headline: 'not measured',
      detail:
        a?.unavailableReason ??
        'The audio mixer did not report the counters this tool reads, and the engine reporter was ' +
          'not present to supply voice counts.',
    };
  }

  const limit = tier?.maxUnderrunsPerMinute ?? null;
  const status: SubsystemStatus =
    a.underrunsPerMinute === null
      ? a.peakPlayingSources !== null
        ? 'ok'
        : 'unmeasured'
      : limit !== null && a.underrunsPerMinute > limit
        ? a.verdict === 'starved'
          ? 'problem'
          : 'watch'
        : 'ok';

  /*
   * Dropouts lead when there were any; the voice count leads when there were
   * not.
   *
   * Same reasoning as storage: a voice count beside an amber light does not
   * say what is wrong with it, and what is wrong is that the audio thread
   * missed its deadline - which the player heard as a click.
   */
  const dropouts =
    a.underrunsPerMinute !== null && a.underrunsPerMinute > 0
      ? `${a.underrunsDuringSession} dropout${a.underrunsDuringSession === 1 ? '' : 's'} ` +
        `(${a.underrunsPerMinute}/min)`
      : null;

  const voices =
    dropouts ??
    (a.peakPlayingSources !== null
      ? `${a.peakPlayingSources} voices at peak`
      : a.peakActiveTracks !== null
        ? `${a.peakActiveTracks} mixer tracks at peak`
        : 'measured');

  const cpu =
    a.peakAudioCpuPercent !== null
      ? ` Audio cost up to ${a.peakAudioCpuPercent}% of a core` +
        (a.averageDspCpuPercent !== null ? ` (${a.averageDspCpuPercent}% average in DSP).` : '.')
      : '';

  // When dropouts took the headline, the voice count moves into the detail -
  // it is the figure that usually explains them.
  const voiceDetail =
    dropouts !== null && a.peakPlayingSources !== null
      ? `Peaked at ${a.peakPlayingSources} playing voices. `
      : '';

  return {
    subsystem: 'Audio',
    status,
    headline: voices,
    detail:
      voiceDetail +
      (a.underrunsPerMinute === null
        ? 'Buffer underruns were not reported by this device’s mixer, so dropouts could not be counted.'
        : a.underrunsPerMinute === 0
          ? 'No buffer underruns, so nothing crackled.'
          : `${a.underrunsDuringSession} buffer underrun${a.underrunsDuringSession === 1 ? '' : 's'} ` +
            `(${a.underrunsPerMinute} per minute) — audible as clicks or crackle.`) + cpu,
  };
}

// ---------------------------------------------------------------------------
// Detail tables, for the complete cut
// ---------------------------------------------------------------------------

export function gpuDetailRows(device: Device): PerfRow[] {
  const g = device.gpu;
  if (!g) return [];
  const rows: PerfRow[] = [];

  if (g.averageUtilizationPercent !== null) {
    rows.push({ label: 'Utilisation, average', value: `${g.averageUtilizationPercent}%` });
    rows.push({ label: 'Utilisation, peak', value: `${g.peakUtilizationPercent}%` });
  }
  if (g.saturatedSamplePercent !== null) {
    rows.push({
      label: 'Time above 90% busy',
      value: `${g.saturatedSamplePercent}% of samples`,
      note: 'where the GPU is what sets the pace',
    });
  }
  if (g.averageClockMhz !== null) {
    rows.push({
      label: 'Clock, average',
      value: `${g.averageClockMhz} MHz`,
      note: g.maxClockMhz !== null ? `ceiling ${g.maxClockMhz} MHz` : '',
    });
  }
  if (g.clockPinnedPercent !== null) {
    rows.push({
      label: 'Time at the clock ceiling',
      value: `${g.clockPinnedPercent}% of samples`,
    });
  }
  if (g.source) {
    rows.push({
      label: 'Read from',
      value: g.source,
      note: 'vendor sysfs; Android publishes no GPU load API',
    });
  }
  return rows;
}

export function renderDetailRows(device: Device): PerfRow[] {
  const r = device.render;
  if (!r) return [];
  const rows: PerfRow[] = [];

  const pair = (label: string, avg: number | null, peak: number | null, note = '') => {
    if (avg === null && peak === null) return;
    rows.push({
      label,
      value:
        avg !== null && peak !== null
          ? `${avg.toLocaleString()} average, ${peak.toLocaleString()} peak`
          : `${(avg ?? peak)!.toLocaleString()}`,
      note,
    });
  };

  pair('Draw calls per frame', r.averageDrawCalls, r.peakDrawCalls, 'CPU-to-GPU submissions');
  pair('Batches per frame', r.averageBatches, null, 'after Unity’s batching passes');
  pair(
    'SetPass calls per frame',
    r.averageSetPassCalls,
    r.peakSetPassCalls,
    'shader and material state changes — often the real cost behind a draw call',
  );
  pair('Triangles per frame', r.averageTriangles, r.peakTriangles);
  pair('Vertices per frame', r.averageVertices, r.peakVertices);

  if (r.peakUsedTextureBytes !== null) {
    rows.push({
      label: 'Texture memory bound, peak',
      value: fmt(r.peakUsedTextureBytes),
      note:
        r.peakUsedTextureCount !== null
          ? `${r.peakUsedTextureCount.toLocaleString()} textures in use`
          : '',
    });
  }
  if (r.peakRenderTextureBytes !== null) {
    rows.push({
      label: 'Render texture memory, peak',
      value: fmt(r.peakRenderTextureBytes),
      note: 'off-screen buffers: post-processing, shadow maps, UI canvases',
    });
  }

  return rows;
}

export function cpuDetailRows(device: Device): PerfRow[] {
  const c = device.cpu;
  if (!c) return [];
  const rows: PerfRow[] = [];

  if (c.averageAppCpuPercentOfCore !== null) {
    rows.push({
      label: 'The game, average',
      value: `${c.averageAppCpuPercentOfCore}% of one core`,
      note:
        c.averageAppCpuPercentOfDevice !== null
          ? `${c.averageAppCpuPercentOfDevice}% of the whole device`
          : '',
    });
  }
  if (c.peakAppCpuPercentOfCore !== null) {
    rows.push({ label: 'The game, peak', value: `${c.peakAppCpuPercentOfCore}% of one core` });
  }
  if (c.averageOtherCpuPercentOfDevice !== null) {
    rows.push({
      label: 'Everything else on the phone',
      value: `${c.averageOtherCpuPercentOfDevice}% of the device`,
      note:
        c.averageOtherCpuPercentOfDevice >= 25
          ? 'high enough to affect the result — re-run on a quiet device'
          : 'background load was low',
    });
  }
  if (c.averageThreadCount !== null) {
    rows.push({ label: 'Threads in the process', value: `${c.averageThreadCount} on average` });
  }
  return rows;
}

export function storageDetailRows(device: Device): PerfRow[] {
  const io = device.io;
  if (!io || io.sampleCount === 0) return [];
  const rows: PerfRow[] = [];

  if (io.totalReadBytes !== null) {
    rows.push({
      label: 'Read by the app',
      value: fmt(io.totalReadBytes),
      note: 'every read the game issued, cache hits included',
    });
  }
  if (io.totalStorageReadBytes !== null) {
    rows.push({
      label: 'Read from flash',
      value: fmt(io.totalStorageReadBytes),
      note: 'the part the page cache could not serve — this is the expensive kind',
    });
  }
  if (io.cacheHitPercent !== null) {
    rows.push({
      label: 'Served from cache',
      value: `${io.cacheHitPercent}%`,
      note: 'a high figure means the reads were cheap even when they were large',
    });
  }
  if (io.peakReadBytesPerSecond !== null) {
    rows.push({
      label: 'Peak read rate',
      value: `${(io.peakReadBytesPerSecond / MB).toFixed(1)} MB/s`,
    });
  }
  if (io.totalWriteBytes !== null && io.totalWriteBytes > 0) {
    rows.push({ label: 'Written by the app', value: fmt(io.totalWriteBytes) });
  }
  return rows;
}

export function audioDetailRows(device: Device): PerfRow[] {
  const a = device.audio;
  if (!a) return [];
  const rows: PerfRow[] = [];

  if (a.peakPlayingSources !== null) {
    rows.push({
      label: 'Playing audio sources, peak',
      value: `${a.peakPlayingSources}`,
      note: a.averagePlayingSources !== null ? `${a.averagePlayingSources} on average` : '',
    });
  }
  if (a.peakAudioVoices !== null) {
    rows.push({
      label: 'Mixer voices allocated, peak',
      value: `${a.peakAudioVoices}`,
      note: 'the voice pool is capped; a game at the cap drops sounds silently',
    });
  }
  if (a.peakActiveTracks !== null) {
    rows.push({
      label: 'Platform mixer tracks, peak',
      value: `${a.peakActiveTracks}`,
      note: 'as the Android audio server saw them, all apps included',
    });
  }
  if (a.peakAudioCpuPercent !== null) {
    rows.push({
      label: 'Audio CPU, peak',
      value: `${a.peakAudioCpuPercent}% of a core`,
      note:
        a.averageDspCpuPercent !== null ? `${a.averageDspCpuPercent}% average in DSP effects` : '',
    });
  }
  if (a.underrunsDuringSession !== null) {
    rows.push({
      label: 'Buffer underruns',
      value: `${a.underrunsDuringSession}`,
      note:
        a.bufferMs !== null
          ? `each one missed a ${a.bufferMs} ms deadline, audible as a click`
          : 'audible as clicks or crackle',
    });
  }
  if (a.peakAudioMemoryBytes !== null) {
    rows.push({ label: 'Audio memory, peak', value: fmt(a.peakAudioMemoryBytes) });
  }
  return rows;
}

/**
 * The fill-rate inference, spelled out.
 *
 * Returned as a sentence rather than a row because the caveat is longer than
 * the claim, and a two-word cell reading "likely" without it would be read as a
 * measurement of overdraw - which nothing here is.
 */
export function fillRateNote(device: Device): string | null {
  const b = device.bottleneck;
  if (!b || b.fillRatePressure !== 'likely') return null;

  const triangles = device.render?.averageTriangles;
  return (
    'Pixel cost, not geometry, is the likely explanation for the GPU time: the GPU was busy while ' +
    (triangles != null
      ? `the geometry it was given was modest (${triangles.toLocaleString()} triangles per frame). `
      : 'the geometry it was given was modest. ') +
    'On a mobile game that combination is usually full-screen transparent layers, stacked particle ' +
    'systems, or an expensive fragment shader. This is an inference — neither Unity nor Android ' +
    'exposes an overdraw counter, so no tool can measure overdraw directly on a device.'
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
