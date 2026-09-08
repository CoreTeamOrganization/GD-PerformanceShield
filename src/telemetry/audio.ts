/**
 * Audio subsystem load: voices, mixer state and buffer underruns.
 *
 * Two sources, and they answer different halves of the question:
 *
 *   `dumpsys media.audio_flinger`   the platform mixer - how many tracks the
 *                                   audio server has, how many are active, and
 *                                   how many times it missed a buffer deadline.
 *   engine counters (OOMI/SND)      the game's own view - playing sources,
 *                                   allocated voices, and the CPU the audio
 *                                   thread spent on DSP, streaming and decode.
 *
 * The platform view is the one that proves a crackle happened: an underrun is
 * the audio thread failing to fill a buffer before the hardware needed it, and
 * it is audible. The engine view is the one that says why - 60 voices with DSP
 * effects on each is a different problem from one streaming clip decoding on
 * the main thread.
 *
 * An honest caveat about the mixer dump: its format is not a stable interface.
 * AudioFlinger's dump text has changed shape across Android releases and vendor
 * forks, and the underrun counters in particular are printed by whichever mixer
 * implementation the device uses. So the parser matches a small number of
 * durable phrases, reports what it found, and does not pretend a device that
 * printed nothing about underruns had none. `unavailableReason` says which
 * happened.
 */
import type { AdbDevice } from '../devices/adb.js';
import type { Logger } from '../core/logger.js';

export interface AudioReading {
  /** Tracks the audio server holds for any app, and how many were mixing. */
  totalTracks: number | null;
  activeTracks: number | null;
  /** Cumulative underrun count as the mixer reports it. Null when it does not. */
  underrunCount: number | null;
  /** Output sample rate, for reading the buffer figures against. */
  sampleRateHz: number | null;
  /** Mixer buffer size in frames - the deadline the audio thread has to meet. */
  bufferFrames: number | null;
}

/**
 * Parse `dumpsys media.audio_flinger`.
 *
 * The phrases matched here were chosen for durability rather than richness:
 *
 *   "N Tracks of which M are active"   printed by ThreadBase::dumpTracks on
 *                                      every release this tool supports
 *   "underruns=N" / "N underruns"      printed by the fast mixer and by track
 *                                      dumps, in varying spellings
 *   "sampleRate=N" / "Sample rate: N"  output thread configuration
 *
 * Every count is summed across output threads, because a phone has several
 * (a mixer, a fast mixer, sometimes an offload thread) and the game's audio can
 * be on any of them.
 */
export function parseAudioFlinger(text: string): AudioReading | null {
  let totalTracks: number | null = null;
  let activeTracks: number | null = null;

  const trackRe = /(\d+)\s+Tracks?\s+of\s+which\s+(\d+)\s+(?:are|is)\s+active/gi;
  let m: RegExpExecArray | null;
  while ((m = trackRe.exec(text)) !== null) {
    totalTracks = (totalTracks ?? 0) + Number(m[1]);
    activeTracks = (activeTracks ?? 0) + Number(m[2]);
  }

  // Underruns, in whichever spelling this platform uses. Summed rather than
  // maximised: each output thread keeps its own counter.
  let underrunCount: number | null = null;
  const underrunPatterns = [
    /underruns?\s*[=:]\s*\(?(\d+)/gi,
    /(\d+)\s+underruns?\b/gi,
    /underrun\s+frames?\s*[=:]\s*(\d+)/gi,
  ];
  for (const pattern of underrunPatterns) {
    let u: RegExpExecArray | null;
    while ((u = pattern.exec(text)) !== null) {
      underrunCount = (underrunCount ?? 0) + Number(u[1]);
    }
    // First pattern that matched anything wins, so a device printing both
    // "underruns=3" and "3 underruns" for the same event is not counted twice.
    if (underrunCount !== null) break;
  }

  const sampleRateHz = firstNumber(text, [
    /sampleRate\s*[=:]\s*(\d+)/i,
    /Sample\s+rate:\s*(\d+)/i,
  ]);
  const bufferFrames = firstNumber(text, [
    /frameCount\s*[=:]\s*(\d+)/i,
    /Frame\s+count:\s*(\d+)/i,
    /HAL\s+frame\s+count\s*[=:]\s*(\d+)/i,
  ]);

  if (totalTracks === null && underrunCount === null && sampleRateHz === null) return null;

  return { totalTracks, activeTracks, underrunCount, sampleRateHz, bufferFrames };
}

function firstNumber(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const raw = pattern.exec(text)?.[1];
    if (raw !== undefined) {
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

/**
 * Samples the platform audio mixer for one device.
 *
 * The dump is a few kilobytes and costs a binder round trip to the audio
 * server, so it rides the deep cadence with the other dumpsys probes. Voice
 * counts do not change meaningfully within a second anyway.
 */
export class AudioProbe {
  private available = false;
  private unavailableReason: string | null = null;

  constructor(
    private readonly device: AdbDevice,
    private readonly logger?: Logger,
  ) {}

  get reason(): string | null {
    return this.unavailableReason;
  }

  async prepare(): Promise<boolean> {
    const res = await this.device.shell(['dumpsys', 'media.audio_flinger'], 20_000);
    if (res.code !== 0 || res.stdout.trim().length === 0) {
      this.unavailableReason =
        'The device did not answer `dumpsys media.audio_flinger`, so mixer load and buffer ' +
        'underruns could not be read.';
      this.logger?.info('Audio mixer dump is not available on this device');
      return false;
    }

    const parsed = parseAudioFlinger(res.stdout);
    if (!parsed) {
      this.unavailableReason =
        'The audio server answered, but in a format with none of the counters this tool reads. ' +
        'Voice counts from the engine reporter are unaffected.';
      return false;
    }

    this.available = true;
    return true;
  }

  async sample(): Promise<AudioReading | null> {
    if (!this.available) return null;
    const res = await this.device.shell(['dumpsys', 'media.audio_flinger'], 20_000);
    if (res.code !== 0) return null;
    return parseAudioFlinger(res.stdout);
  }
}

// ---------------------------------------------------------------------------
// Session-level summary
// ---------------------------------------------------------------------------

import type { EngineAudio } from './engineProfile.js';

export interface AudioSummary {
  /** Platform mixer, across the session. */
  peakActiveTracks: number | null;
  averageActiveTracks: number | null;
  /**
   * Underruns that happened during the session.
   *
   * A difference against the first reading, not the raw counter: the audio
   * server has been running since boot and its lifetime total says nothing
   * about this game.
   */
  underrunsDuringSession: number | null;
  /** Underruns per minute, for comparing sessions of different lengths. */
  underrunsPerMinute: number | null;
  sampleRateHz: number | null;
  bufferFrames: number | null;
  /** The buffer deadline in milliseconds, which is what an underrun missed. */
  bufferMs: number | null;

  /** Engine view, across the session. */
  peakPlayingSources: number | null;
  averagePlayingSources: number | null;
  peakAudioVoices: number | null;
  averageAudioCpuPercent: number | null;
  peakAudioCpuPercent: number | null;
  averageDspCpuPercent: number | null;
  peakAudioMemoryBytes: number | null;
  peakClipCount: number | null;

  verdict: 'clean' | 'occasional-dropouts' | 'starved' | 'unknown';
  sampleCount: number;
  unavailableReason: string | null;
}

export interface AudioSample {
  elapsedMs: number;
  reading: AudioReading;
}

export function summarizeAudio(
  samples: AudioSample[],
  engine: readonly EngineAudio[],
  durationMs: number,
  unavailableReason: string | null,
): AudioSummary {
  const active = samples
    .map((s) => s.reading.activeTracks)
    .filter((v): v is number => v !== null);

  // Underruns as a difference against the first reading. The counter is
  // lifetime-of-boot, so the raw value is meaningless for one session.
  const underrunSeries = samples
    .map((s) => s.reading.underrunCount)
    .filter((v): v is number => v !== null);
  const first = underrunSeries[0];
  const lastUnderrun = underrunSeries[underrunSeries.length - 1];
  const underruns =
    first !== undefined && lastUnderrun !== undefined ? Math.max(0, lastUnderrun - first) : null;

  const sampleRateHz = samples.find((s) => s.reading.sampleRateHz !== null)?.reading.sampleRateHz ?? null;
  const bufferFrames = samples.find((s) => s.reading.bufferFrames !== null)?.reading.bufferFrames ?? null;

  const enginePick = (field: keyof EngineAudio): number[] =>
    engine.map((r) => r[field]).filter((v): v is number => typeof v === 'number');

  const playing = enginePick('playingSources');
  const voices = enginePick('audioVoices');
  const cpu = enginePick('totalCpuPercent');
  const dsp = enginePick('dspCpuPercent');
  const memory = enginePick('audioMemoryBytes');
  const clips = enginePick('clipCount');

  const minutes = durationMs / 60_000;
  const perMinute = underruns !== null && minutes > 0 ? round1(underruns / minutes) : null;

  return {
    peakActiveTracks: active.length ? Math.max(...active) : null,
    averageActiveTracks: active.length ? round1(mean(active)) : null,
    underrunsDuringSession: underruns,
    underrunsPerMinute: perMinute,
    sampleRateHz,
    bufferFrames,
    bufferMs:
      sampleRateHz !== null && bufferFrames !== null
        ? round1((bufferFrames / sampleRateHz) * 1000)
        : null,
    peakPlayingSources: playing.length ? Math.max(...playing) : null,
    averagePlayingSources: playing.length ? round1(mean(playing)) : null,
    peakAudioVoices: voices.length ? Math.max(...voices) : null,
    averageAudioCpuPercent: cpu.length ? round1(mean(cpu)) : null,
    peakAudioCpuPercent: cpu.length ? round1(Math.max(...cpu)) : null,
    averageDspCpuPercent: dsp.length ? round1(mean(dsp)) : null,
    peakAudioMemoryBytes: memory.length ? Math.max(...memory) : null,
    peakClipCount: clips.length ? Math.max(...clips) : null,
    verdict: rateAudio(perMinute),
    sampleCount: samples.length,
    unavailableReason: samples.length > 0 ? null : unavailableReason,
  };
}

/**
 * Grade dropouts by rate rather than by total.
 *
 * A single underrun over twenty minutes is one click nobody reported; one every
 * few seconds is the crackling a QA ticket gets filed about. The boundary at
 * one per minute is deliberately forgiving - the aim is to separate "audible
 * and constant" from "happened once during a scene load", not to fail a build
 * for a click.
 */
export function rateAudio(underrunsPerMinute: number | null): AudioSummary['verdict'] {
  if (underrunsPerMinute === null) return 'unknown';
  if (underrunsPerMinute === 0) return 'clean';
  return underrunsPerMinute >= 6 ? 'starved' : 'occasional-dropouts';
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
