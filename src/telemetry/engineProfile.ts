/**
 * Engine-side rendering, threading and audio counters.
 *
 * The companion to `engineMetrics.ts`, and it exists for the same reason: the OS
 * cannot see inside the process. Android can say the GPU was busy 74% of the
 * time; it cannot say the game issued 2,400 draw calls to get there, and no
 * amount of sysfs reading will ever produce a triangle count. Draw calls,
 * batches, geometry, texture counts, per-thread frame time and audio voices are
 * engine facts, so they have to come from the engine.
 *
 * They arrive the same way the memory totals do - as logcat lines emitted by
 * `scripts/unity/PerformanceShieldReporter.cs`, which reads Unity's own
 * `ProfilerRecorder` counters. That API is documented and engine-authoritative,
 * which is why these figures are trustworthy enough to put in a report.
 *
 * Line format, one per emit:
 *   I Unity   : OOMI/GFX {"ms":12034,"dc":1840,"tri":412000,"main":11.2,...}
 *   I Unity   : OOMI/SND {"ms":12034,"voices":24,"cpu":6.1,...}
 *
 * What is *not* here, and why: overdraw. Unity exposes no overdraw counter on
 * any version, and Android's overdraw debugging is a screen tint with no
 * readable output. Claiming a number for it would mean inventing one, so the
 * analysis infers fill-rate pressure from GPU time against geometry instead and
 * says that is what it is doing. See `src/analysis/bottleneck.ts`.
 */
import type { Logger } from '../core/logger.js';

/** One reading of the engine's render counters. */
export interface EngineRender {
  /** Milliseconds since the game started, as the engine measured it. */
  engineMs?: number;
  /** Draw calls submitted for the last frame - CPU-to-GPU submissions. */
  drawCalls?: number;
  /** Batches after Unity's batching passes. Below draw calls when batching works. */
  batches?: number;
  /** Shader/material state changes. Often the real cost behind a draw call count. */
  setPassCalls?: number;
  triangles?: number;
  vertices?: number;
  shadowCasters?: number;
  /** Textures bound in the last frame, and what they cost. */
  usedTextureCount?: number;
  usedTextureBytes?: number;
  renderTextureCount?: number;
  renderTextureBytes?: number;
  vertexBufferBytes?: number;
  /**
   * Per-thread and GPU frame time in milliseconds, as the engine measured them.
   *
   * The only figures that can settle CPU-bound against GPU-bound: whichever of
   * the three is closest to the frame interval is the one holding the frame up.
   */
  mainThreadMs?: number;
  renderThreadMs?: number;
  gpuFrameMs?: number;
  /** Counters the running engine version did not expose. */
  unavailable?: string[];
}

/** One reading of the engine's audio counters. */
export interface EngineAudio {
  engineMs?: number;
  /** Audio sources currently playing - the voice count a designer recognises. */
  playingSources?: number;
  pausedSources?: number;
  /** Voices the mixer actually allocated, which is capped and can starve. */
  audioVoices?: number;
  /** Percentage of a core spent in the audio thread, by stage. */
  totalCpuPercent?: number;
  dspCpuPercent?: number;
  streamingCpuPercent?: number;
  otherCpuPercent?: number;
  audioMemoryBytes?: number;
  clipCount?: number;
  unavailable?: string[];
}

export const ENGINE_RENDER_TAG = 'OOMI/GFX';
export const ENGINE_AUDIO_TAG = 'OOMI/SND';

/**
 * Short keys the reporter emits, mapped to our field names.
 *
 * Short because a logcat line has a ~4 KB limit and a chatty device is already
 * using some of it. Longer spellings are accepted alongside them so a
 * hand-written test fixture can stay readable.
 */
const RENDER_FIELDS: Array<[string, keyof EngineRender]> = [
  ['ms', 'engineMs'],
  ['dc', 'drawCalls'],
  ['drawCalls', 'drawCalls'],
  ['batch', 'batches'],
  ['batches', 'batches'],
  ['setpass', 'setPassCalls'],
  ['sp', 'setPassCalls'],
  ['tri', 'triangles'],
  ['triangles', 'triangles'],
  ['vert', 'vertices'],
  ['vertices', 'vertices'],
  ['shadow', 'shadowCasters'],
  ['texN', 'usedTextureCount'],
  ['texB', 'usedTextureBytes'],
  ['rtN', 'renderTextureCount'],
  ['rtB', 'renderTextureBytes'],
  ['vbB', 'vertexBufferBytes'],
  ['main', 'mainThreadMs'],
  ['render', 'renderThreadMs'],
  ['gpu', 'gpuFrameMs'],
];

const AUDIO_FIELDS: Array<[string, keyof EngineAudio]> = [
  ['ms', 'engineMs'],
  ['playing', 'playingSources'],
  ['paused', 'pausedSources'],
  ['voices', 'audioVoices'],
  ['cpu', 'totalCpuPercent'],
  ['dsp', 'dspCpuPercent'],
  ['stream', 'streamingCpuPercent'],
  ['other', 'otherCpuPercent'],
  ['mem', 'audioMemoryBytes'],
  ['clips', 'clipCount'],
];

/**
 * Parse one tagged reporter line into a reading.
 *
 * Returns null for anything that is not one of these lines, so it can be handed
 * every logcat line without filtering first. A malformed payload also returns
 * null rather than a partly-filled reading: half a frame's counters displayed as
 * though they were whole is exactly the failure this tool exists to avoid.
 */
function parseTagged<T extends { engineMs?: number; unavailable?: string[] }>(
  line: string,
  tag: string,
  fields: Array<[string, keyof T]>,
): T | null {
  const at = line.indexOf(tag);
  if (at === -1) return null;

  const payload = line.slice(at + tag.length).trim();
  if (!payload.startsWith('{')) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }

  const reading = {} as T;
  for (const [key, field] of fields) {
    const value = parsed[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      (reading[field] as unknown as number) = value;
    }
  }

  const missing = parsed['na'];
  if (Array.isArray(missing)) {
    reading.unavailable = missing.filter((m): m is string => typeof m === 'string');
  }

  // A reading with no counter in it says nothing; treat it as noise.
  const hasCounter = Object.keys(reading).some((k) => k !== 'engineMs' && k !== 'unavailable');
  return hasCounter ? reading : null;
}

export function parseEngineRenderLine(line: string): EngineRender | null {
  return parseTagged<EngineRender>(line, ENGINE_RENDER_TAG, RENDER_FIELDS);
}

export function parseEngineAudioLine(line: string): EngineAudio | null {
  return parseTagged<EngineAudio>(line, ENGINE_AUDIO_TAG, AUDIO_FIELDS);
}

/**
 * Watches logcat for render and audio reporter lines.
 *
 * Keeps the latest reading of each and, unlike the memory tracker, also keeps
 * every reading. A peak draw-call count and a peak voice count are the figures
 * that matter, and a sampler that only ever saw "the latest" would miss the
 * spike between two of its own ticks. The engine emits at 1 Hz by default, so a
 * twenty-minute session holds roughly 1,200 small objects per channel.
 */
export class EngineProfileTracker {
  private latestRender: EngineRender | null = null;
  private latestAudio: EngineAudio | null = null;
  private readonly renderHistory: EngineRender[] = [];
  private readonly audioHistory: EngineAudio[] = [];
  private announced = false;

  constructor(private readonly logger?: Logger) {}

  /** Feed one logcat line. Returns true when the line was one of ours. */
  ingest(line: string): boolean {
    const render = parseEngineRenderLine(line);
    if (render) {
      this.latestRender = render;
      this.renderHistory.push(render);
      this.announce(render.unavailable ?? []);
      return true;
    }

    const audio = parseEngineAudioLine(line);
    if (audio) {
      this.latestAudio = audio;
      this.audioHistory.push(audio);
      return true;
    }

    return false;
  }

  private announce(unavailable: string[]): void {
    if (this.announced) return;
    this.announced = true;
    this.logger?.info('Unity render/audio reporter detected', { unavailable });
  }

  currentRender(): EngineRender | null {
    return this.latestRender;
  }

  currentAudio(): EngineAudio | null {
    return this.latestAudio;
  }

  get renderReadings(): readonly EngineRender[] {
    return this.renderHistory;
  }

  get audioReadings(): readonly EngineAudio[] {
    return this.audioHistory;
  }

  get seen(): number {
    return this.renderHistory.length + this.audioHistory.length;
  }
}
