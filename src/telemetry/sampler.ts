/**
 * Step 6 - continuous memory telemetry for one device.
 *
 * Design notes:
 *  - Two independent timers (fast/deep) rather than one loop, so a slow
 *    `dumpsys` never delays the cheap samples.
 *  - Self-scheduling `setTimeout` rather than `setInterval`: if a probe takes
 *    longer than the interval, we must not queue up overlapping adb calls.
 *  - The sampler follows PID changes. When the OS kills and relaunches the
 *    game, samples continue against the new PID and the discontinuity is
 *    recorded rather than silently averaged away.
 */
import { EventEmitter } from 'node:events';

import type { Logger } from '../core/logger.js';
import type { AdbDevice } from '../devices/adb.js';
import { DeviceHealthProbe } from './deviceHealth.js';
import { FpsSampler, type FpsAttempt } from './fps.js';
import { GpuProbe, type GpuAttempt } from './gpu.js';
import { CpuThreadProbe, type CpuAttempt } from './cpuThreads.js';
import { DiskIoProbe } from './diskIo.js';
import { AudioProbe } from './audio.js';
import {
  DeviceMemoryProbe,
  DumpsysMeminfoProbe,
  ProcStatusProbe,
  SmapsProbe,
  type MemoryProbe,
  type ProbeReading,
} from './probes.js';
import { TELEMETRY_SCHEMA_VERSION, type MemorySample } from './types.js';

export interface SamplerOptions {
  device: AdbDevice;
  serial: string;
  role: string;
  pid: number;
  /** Needed by the smaps probe, which reaches the file through `run-as`. */
  packageName?: string;
  /** Epoch ms marking t=0 for the whole session, shared across devices. */
  sessionStartMs: number;
  fastIntervalMs?: number;
  deepIntervalMs?: number;
  /**
   * How often frame rate is sampled, independently of the memory tiers.
   *
   * One second by default. Frame rate is the one metric where a five-second
   * window genuinely loses the shape of the session - a game that drops to 8 fps
   * twice looks identical to one that sat at 45 throughout once averaged that
   * coarsely - and a TimeStats read is far cheaper than `dumpsys meminfo`.
   */
  fpsIntervalMs?: number;
  logger?: Logger;
}

export interface SamplerStats {
  fastSamples: number;
  deepSamples: number;
  failures: number;
  lastPssBytes: number | null;
  lastRssBytes: number | null;
}

export class MemorySampler extends EventEmitter {
  private readonly fastProbes: MemoryProbe[] = [];
  private readonly deepProbes: MemoryProbe[] = [];
  private readonly deviceProbe = new DeviceMemoryProbe();
  /**
   * Frame rate and device health, both on the deep cadence.
   *
   * They belong on the slow tier: neither changes meaningfully within a second,
   * and each costs a shell round trip that would otherwise perturb the game we
   * are trying to measure.
   */
  private fps: FpsSampler | null = null;
  private health: DeviceHealthProbe | null = null;
  private fpsSource: string | null = null;
  private fpsDiagnostics: FpsAttempt[] = [];

  /**
   * GPU, per-core/per-thread CPU, disk I/O and the audio mixer.
   *
   * All on the deep tier alongside `dumpsys meminfo`, and for the same reason:
   * each costs a shell round trip, none changes meaningfully within a second,
   * and the point of the two-tier design is that the expensive reads do not run
   * at 1 Hz against the game we are trying not to disturb.
   *
   * Each is null when the device or build will not produce it, which is the
   * common case for disk I/O on a release build and for GPU load on almost any
   * retail handset. Null propagates all the way to the report as "not
   * measurable", never as zero.
   */
  private gpu: GpuProbe | null = null;
  private cpu: CpuThreadProbe | null = null;
  private io: DiskIoProbe | null = null;
  private audio: AudioProbe | null = null;
  private gpuDiagnostics: GpuAttempt[] = [];
  private cpuDiagnostics: CpuAttempt[] = [];
  private ioUnavailableReason: string | null = null;
  private audioUnavailableReason: string | null = null;

  private fastTimer: NodeJS.Timeout | null = null;
  private deepTimer: NodeJS.Timeout | null = null;
  private fpsTimer: NodeJS.Timeout | null = null;
  private running = false;
  private currentPid: number;
  private consecutiveFailures = 0;

  /** How frame rate was measured, for the session manifest. */
  get frameRateSource(): string | null {
    return this.fpsSource;
  }

  /** Which strategies were tried, and what each one reported. */
  get frameRateDiagnostics(): FpsAttempt[] {
    return this.fpsDiagnostics;
  }

  /**
   * What each subsystem probe managed, for the manifest and the report's
   * limitations section.
   *
   * Surfaced rather than logged and forgotten: "GPU utilisation is missing" is
   * not actionable, and "SELinux denied /sys/class/kgsl on this device, so run
   * on a debuggable build or a rooted phone" is.
   */
  get subsystemDiagnostics(): {
    gpu: GpuAttempt[];
    cpu: CpuAttempt[];
    ioReason: string | null;
    audioReason: string | null;
  } {
    return {
      gpu: this.gpuDiagnostics,
      cpu: this.cpuDiagnostics,
      ioReason: this.ioUnavailableReason,
      audioReason: this.audioUnavailableReason,
    };
  }

  private stats: SamplerStats = {
    fastSamples: 0,
    deepSamples: 0,
    failures: 0,
    lastPssBytes: null,
    lastRssBytes: null,
  };

  /** Cached device-wide reading, refreshed on the deep cadence only. */
  private deviceMemory: { availableBytes: number | null; freeBytes: number | null; cachedBytes: number | null } = {
    availableBytes: null,
    freeBytes: null,
    cachedBytes: null,
  };

  constructor(private readonly opts: SamplerOptions) {
    super();
    this.currentPid = opts.pid;
  }

  get pid(): number {
    return this.currentPid;
  }

  /** Called by the process watcher after an OOM kill + relaunch. */
  setPid(pid: number): void {
    this.opts.logger?.info('Sampler retargeted to new PID', { from: this.currentPid, to: pid });
    this.currentPid = pid;
    this.consecutiveFailures = 0;
    // The I/O counters belong to the dead process. Keeping its baseline would
    // make the new process's first read look like a negative rate, or worse,
    // fold the two processes' totals together into one figure for neither.
    this.io?.resetBaseline();
  }

  getStats(): SamplerStats {
    return { ...this.stats };
  }

  /**
   * Probe capability check. Runs once so the session manifest records exactly
   * which probes produced the data - important when comparing runs across
   * devices with different /proc restrictions.
   */
  async prepare(): Promise<string[]> {
    const candidates: MemoryProbe[] = [new ProcStatusProbe(), new DumpsysMeminfoProbe()];

    // Per-mapping detail is what names the cause of a spike, but it is readable
    // only on a debuggable build or a rooted device. It is added as a candidate
    // and drops out on its own when the device refuses.
    if (this.opts.packageName) candidates.push(new SmapsProbe(this.opts.packageName));

    this.health = new DeviceHealthProbe(this.opts.device, this.opts.logger);

    // Frame rate needs the package to find the app's compositor layer.
    if (this.opts.packageName) {
      this.fps = new FpsSampler(this.opts.device, this.opts.packageName, this.opts.logger);
      this.fpsSource = await this.fps.prepare();
      // Kept even when no strategy worked: the reasons are the only thing that
      // makes "not measurable" actionable, and the console shows them.
      this.fpsDiagnostics = this.fps.diagnostics;
      if (!this.fpsSource) this.fps = null;
    }

    // GPU, CPU, disk and audio. Each resolves its own access once here rather
    // than re-probing every tick against a device that will keep refusing, and
    // each drops out on its own without failing the session - a run that can
    // only measure memory and frame rate is still a useful run.
    const gpu = new GpuProbe(this.opts.device, this.opts.logger);
    if (await gpu.prepare()) this.gpu = gpu;
    this.gpuDiagnostics = gpu.diagnostics;

    const cpu = new CpuThreadProbe(this.opts.device, this.opts.logger);
    if (await cpu.prepare(this.currentPid)) this.cpu = cpu;
    this.cpuDiagnostics = cpu.diagnostics;

    if (this.opts.packageName) {
      const io = new DiskIoProbe(this.opts.device, this.opts.packageName, this.opts.logger);
      if (await io.prepare(this.currentPid)) this.io = io;
      else {
        this.ioUnavailableReason =
          'Disk I/O counters (/proc/<pid>/io) were not readable, so asset streaming and ' +
          'I/O-caused stutter could not be measured. This needs a debuggable build or a rooted device.';
      }
    }

    const audio = new AudioProbe(this.opts.device, this.opts.logger);
    if (await audio.prepare()) this.audio = audio;
    else this.audioUnavailableReason = audio.reason;

    const active: string[] = [];

    for (const probe of candidates) {
      let ok = false;
      try {
        ok = await probe.isAvailable(this.opts.device, this.currentPid);
      } catch {
        ok = false;
      }
      if (!ok) {
        this.opts.logger?.warn(`Probe unavailable on this device: ${probe.name}`, {
          consequence:
            probe.tier === 'fast'
              ? 'High-resolution sampling disabled; falling back to the dumpsys cadence.'
              : 'PSS breakdown unavailable; only RSS will be recorded.',
        });
        continue;
      }
      if (probe.tier === 'fast') this.fastProbes.push(probe);
      else this.deepProbes.push(probe);
      active.push(probe.name);
    }

    if (active.length === 0) {
      throw new Error(
        `No memory probe works for pid ${this.currentPid} on ${this.opts.serial}. ` +
          'The process may have exited, or the device restricts both /proc and dumpsys.',
      );
    }

    // Without a fast probe, run dumpsys more often so the timeline stays usable.
    if (this.fastProbes.length === 0) {
      this.opts.logger?.info('Running deep-only sampling at a tightened cadence');
    }

    // Record the subsystem probes in the manifest too, so a finished session
    // says what it was able to see rather than leaving a reader to infer it
    // from which fields happen to be populated.
    if (this.gpu) active.push('gpu');
    if (this.cpu) active.push(this.cpu.hasThreadDetail ? 'cpu_threads' : 'cpu_cores');
    if (this.io) active.push('disk_io');
    if (this.audio) active.push('audio_flinger');

    return active;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const fastInterval = this.opts.fastIntervalMs ?? 1000;
    const deepInterval =
      this.fastProbes.length === 0
        ? Math.min(this.opts.deepIntervalMs ?? 5000, 2000)
        : (this.opts.deepIntervalMs ?? 5000);

    if (this.fastProbes.length > 0) {
      this.scheduleFast(fastInterval);
    }
    // Frame rate on its own cadence. It used to ride the deep tier at five
    // seconds, which cannot show the shape of a session: a game that collapses
    // to 8 fps twice averages to the same figure as one that sat at 45
    // throughout. A TimeStats read is far cheaper than `dumpsys meminfo`, so it
    // can afford a second.
    if (this.fps) {
      this.scheduleFps(this.opts.fpsIntervalMs ?? 1000);
    }

    if (this.deepProbes.length > 0) {
      // Fire the first deep sample immediately so the baseline has a full
      // breakdown rather than an RSS-only point.
      void this.deepTick(deepInterval, true);
    }
  }

  /** Undo anything a strategy switched on, so the device is left as found. */
  async release(): Promise<void> {
    await this.fps?.release();
  }

  stop(): void {
    if (this.fpsTimer) clearTimeout(this.fpsTimer);
    this.fpsTimer = null;

    this.running = false;
    if (this.fastTimer) clearTimeout(this.fastTimer);
    if (this.deepTimer) clearTimeout(this.deepTimer);
    this.fastTimer = null;
    this.deepTimer = null;
  }

  private scheduleFast(intervalMs: number): void {
    this.fastTimer = setTimeout(() => void this.fastTick(intervalMs), intervalMs);
  }

  private async fastTick(intervalMs: number): Promise<void> {
    if (!this.running) return;
    const started = Date.now();
    try {
      for (const probe of this.fastProbes) {
        const reading = await probe.sample(this.opts.device, this.currentPid);
        if (!reading) {
          this.noteFailure();
          break;
        }
        this.consecutiveFailures = 0;
        this.stats.fastSamples++;
        this.stats.lastRssBytes = reading.rssBytes;
        this.emitSample({
          tier: 'fast',
          pssBytes: reading.pssBytes,
          rssBytes: reading.rssBytes,
          swapPssBytes: reading.swapPssBytes,
          oomScoreAdj: reading.oomScoreAdj ?? null,
          probeDurationMs: Date.now() - started,
        });
      }
    } catch (err) {
      this.noteFailure(err);
    } finally {
      if (this.running) this.scheduleFast(intervalMs);
    }
  }

  /**
   * Self-scheduling rather than an interval, so a slow read cannot queue up
   * overlapping adb calls against the game we are trying to measure.
   */
  private scheduleFps(intervalMs: number): void {
    this.fpsTimer = setTimeout(() => void this.fpsTick(intervalMs), intervalMs);
  }

  private async fpsTick(intervalMs: number): Promise<void> {
    if (!this.running) return;

    try {
      const reading = await this.fps?.sample();
      if (reading) {
        // Emitted on its own event rather than as a memory sample: it carries no
        // memory figures, and a memory series with holes in it would be worse
        // than one that simply ticks more slowly.
        this.emit('fps', {
          t: Date.now(),
          elapsedMs: Date.now() - this.opts.sessionStartMs,
          serial: this.opts.serial,
          role: this.opts.role,
          reading,
        });
      }
    } catch (err) {
      this.opts.logger?.debug('Frame-rate sample failed', { error: String(err) });
    } finally {
      if (this.running) this.scheduleFps(intervalMs);
    }
  }

  private async deepTick(intervalMs: number, immediate = false): Promise<void> {
    if (!this.running && !immediate) return;
    const started = Date.now();
    try {
      this.deviceMemory = await this.deviceProbe.sample(this.opts.device);

      // The deep probes describe one instant from different angles, so their
      // readings are merged into a single sample. Emitting one sample per probe
      // would put a mapping list and the summary it explains on different points
      // of the timeline, where nothing could line them up again.
      const merged: ProbeReading = { pssBytes: null, rssBytes: null, swapPssBytes: null };
      let answered = false;

      // Frame rate is no longer read here - it has its own timer, and reading it
      // from two places would split each window's frames between them and halve
      // both counts.
      // Health and the four subsystem probes together. In parallel because they
      // are independent reads of independent kernel interfaces, and running them
      // in sequence would make one deep tick the sum of six round trips - long
      // enough on a slow USB link to overrun the interval.
      const [thermal, battery, gpu, cpu, io, audio] = await Promise.all([
        this.health?.thermal() ?? Promise.resolve(null),
        this.health?.battery() ?? Promise.resolve(null),
        this.gpu?.sample() ?? Promise.resolve(null),
        this.cpu?.sample(this.currentPid) ?? Promise.resolve(null),
        this.io?.sample(this.currentPid) ?? Promise.resolve(null),
        this.audio?.sample() ?? Promise.resolve(null),
      ]);
      if (thermal) merged.thermal = thermal;
      if (battery) merged.battery = battery;
      if (gpu) merged.gpu = gpu;
      if (cpu) merged.cpu = cpu;
      if (io) merged.io = io;
      if (audio) merged.audio = audio;
      if (thermal || battery || gpu || cpu || io || audio) answered = true;

      for (const probe of this.deepProbes) {
        const reading = await probe.sample(this.opts.device, this.currentPid);
        if (!reading) continue;

        answered = true;
        merged.pssBytes ??= reading.pssBytes;
        merged.rssBytes ??= reading.rssBytes;
        merged.swapPssBytes ??= reading.swapPssBytes;
        merged.breakdown ??= reading.breakdown;
        merged.breakdownPrivate ??= reading.breakdownPrivate;
        merged.summary ??= reading.summary;
        merged.mappings ??= reading.mappings;
        merged.oomScoreAdj ??= reading.oomScoreAdj;
      }

      if (!answered) {
        this.noteFailure();
      } else {
        this.consecutiveFailures = 0;
        this.stats.deepSamples++;
        this.stats.lastPssBytes = merged.pssBytes;
        if (merged.rssBytes !== null) this.stats.lastRssBytes = merged.rssBytes;
        this.emitSample({
          tier: 'deep',
          pssBytes: merged.pssBytes,
          rssBytes: merged.rssBytes,
          swapPssBytes: merged.swapPssBytes,
          breakdown: merged.breakdown,
          breakdownPrivate: merged.breakdownPrivate,
          summary: merged.summary,
          mappings: merged.mappings,
          thermal: merged.thermal,
          battery: merged.battery,
          gpu: merged.gpu,
          cpu: merged.cpu,
          io: merged.io,
          audio: merged.audio,
          oomScoreAdj: merged.oomScoreAdj ?? null,
          probeDurationMs: Date.now() - started,
        });
      }
    } catch (err) {
      this.noteFailure(err);
    } finally {
      if (this.running) {
        this.deepTimer = setTimeout(() => void this.deepTick(intervalMs), intervalMs);
      }
    }
  }

  private emitSample(
    partial: Pick<
      MemorySample,
      | 'tier'
      | 'pssBytes'
      | 'rssBytes'
      | 'swapPssBytes'
      | 'probeDurationMs'
      | 'oomScoreAdj'
    > &
      Partial<
        Pick<
          MemorySample,
          | 'breakdown'
          | 'breakdownPrivate'
          | 'summary'
          | 'mappings'
          | 'fps'
          | 'thermal'
          | 'battery'
          | 'gpu'
          | 'cpu'
          | 'io'
          | 'audio'
        >
      >,
  ): void {
    const t = Date.now();
    const sample: MemorySample = {
      schema: TELEMETRY_SCHEMA_VERSION,
      t,
      elapsedMs: t - this.opts.sessionStartMs,
      serial: this.opts.serial,
      role: this.opts.role,
      pid: this.currentPid,
      deviceAvailableBytes: this.deviceMemory.availableBytes,
      deviceFreeBytes: this.deviceMemory.freeBytes,
      deviceCachedBytes: this.deviceMemory.cachedBytes,
      ...partial,
    };
    this.emit('sample', sample);
  }

  /**
   * Repeated probe failures almost always mean the process died. We surface
   * that as an event instead of quietly emitting nothing, because a silent gap
   * in the timeline is exactly the signal we must not lose.
   */
  private noteFailure(err?: unknown): void {
    this.stats.failures++;
    this.consecutiveFailures++;
    if (err) {
      this.opts.logger?.debug('Probe error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (this.consecutiveFailures === 3) {
      this.opts.logger?.warn('Memory probes failing repeatedly - the process may have been killed', {
        pid: this.currentPid,
        serial: this.opts.serial,
      });
      this.emit('probe_lost', { pid: this.currentPid, serial: this.opts.serial });
    }
  }
}
