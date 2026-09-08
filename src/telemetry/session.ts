/**
 * Capture session - the runtime half of the pipeline.
 *
 * Owns, for the duration of one gameplay session:
 *   - a memory sampler per device (Step 6)
 *   - a logcat monitor per device
 *   - a process watcher per device (restart / OOM-kill detection)
 *   - the operator event log (Step 7)
 *   - deep-capture triggers (Step 16)
 *
 * Everything is streamed to JSONL as it happens. If the operator's machine dies
 * mid-session, every sample taken before that point is already on disk.
 */
import { EventEmitter } from 'node:events';

import { JsonlWriter } from '../core/jsonl.js';
import type { Logger } from '../core/logger.js';
import { shortId } from '../core/ids.js';
import type { Workspace } from '../core/workspace.js';
import type { AdbDevice } from '../devices/adb.js';
import { ProcessWatcher, type ProcessLifecycleEvent } from '../devices/appController.js';
import type { DeviceInfo } from '../devices/deviceManager.js';
import { markerLabel } from '../events/markers.js';
import { EngineMemoryTracker } from './engineMetrics.js';
import { EngineProfileTracker } from './engineProfile.js';
import {
  summarizeBattery,
  summarizeFps,
  summarizeThermal,
  type BatterySummary,
  type FpsSummary,
  type HealthSample,
  type ThermalSummary,
} from './deviceHealth.js';
import type { FpsReading } from './fps.js';
import { summarizeGpu, summarizeRender, type GpuReading, type GpuSummary, type RenderSummary } from './gpu.js';
import { summarizeCpu, type CpuReading, type CpuSummary } from './cpuThreads.js';
import { summarizeDiskIo, type DiskIoSample, type DiskIoSummary } from './diskIo.js';
import { summarizeAudio, type AudioSample, type AudioSummary } from './audio.js';
import { LogcatMonitor } from './logcat.js';
import { MemorySampler } from './sampler.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  type LogEvent,
  type MemorySample,
  type SessionManifest,
  type TimelineEvent,
} from './types.js';

export interface CaptureTarget {
  device: DeviceInfo;
  adb: AdbDevice;
  pid: number;
}

export interface CaptureSessionOptions {
  analysisId: string;
  packageName: string;
  workspace: Workspace;
  targets: CaptureTarget[];
  fastIntervalMs?: number;
  deepIntervalMs?: number;
  logger?: Logger;
  /** Enables deep-capture artifacts on anomaly (Step 16). */
  deepCapture?: boolean;
}

interface DeviceRuntime {
  target: CaptureTarget;
  sampler: MemorySampler;
  logcat: LogcatMonitor;
  /** Engine allocation totals, when the build carries the reporter component. */
  engine: EngineMemoryTracker;
  /** Engine render and audio counters, from the same reporter component. */
  engineProfile: EngineProfileTracker;
  watcher: ProcessWatcher;
  samplesWriter: JsonlWriter<MemorySample>;
  logWriter: JsonlWriter<LogEvent>;
  /**
   * Frame-rate readings, on disk.
   *
   * Moving frame rate onto its own timer took it out of the memory samples, and
   * with it the frame-time histograms those samples used to carry. Without them
   * a finished session cannot be re-analysed - which is exactly what comparing
   * against another tool requires - so they get their own file.
   */
  fpsWriter: JsonlWriter<{ t: number; elapsedMs: number; serial: string; role: string } & Record<string, unknown>>;
  /**
   * Frame rate and health readings, kept in memory for the session summary.
   *
   * They are already on disk inside each sample; these are the same values
   * indexed for the reduction the report needs, so the analysis does not have to
   * re-read a JSONL file it just wrote.
   */
  fpsReadings: FpsReading[];
  /** Frame rate over time, one point per sampled window. */
  fpsSeries: Array<{ elapsedMs: number; fps: number; janks: number }>;
  healthSamples: HealthSample[];
  /**
   * The subsystem readings, indexed for the session summary.
   *
   * Kept in memory alongside the on-disk samples for the same reason the health
   * readings are: only the session saw every one of them, and re-reading the
   * JSONL file to recompute what was just in memory could disagree with what
   * the console showed live.
   *
   * The GPU and CPU series carry their elapsed time because the diagnostic
   * engine has to line them up against the frame-rate curve, which ticks five
   * times as often.
   */
  gpuReadings: GpuReading[];
  gpuSeries: Array<{ elapsedMs: number; reading: GpuReading }>;
  cpuReadings: CpuReading[];
  cpuSeries: Array<{ elapsedMs: number; reading: CpuReading }>;
  ioSamples: DiskIoSample[];
  audioSamples: AudioSample[];
  /** Render readings paired with our clock, not the engine's. */
  renderSeries: Array<{ elapsedMs: number; reading: ReturnType<EngineProfileTracker['currentRender']> }>;
  /** Most recent PSS, used for live UI and deep-capture triggers. */
  lastPss: number | null;
  lastRss: number | null;
  peakPss: number;
}

export interface LiveStatus {
  sessionId: string;
  running: boolean;
  startedAt: string;
  elapsedMs: number;
  packageName: string;
  eventCount: number;
  devices: Array<{
    serial: string;
    role: string;
    model: string;
    pid: number | null;
    lastPssBytes: number | null;
    lastRssBytes: number | null;
    peakPssBytes: number;
    fastSamples: number;
    deepSamples: number;
    alive: boolean;
    /** Most recent frame rate, or null where it cannot be measured. */
    fps: number | null;
    /** The panel's refresh rate, for comparison with the app's own. */
    fpsDisplayHz: number | null;
    /** Median frame rate in the last window. */
    fpsMedian: number | null;
    /** Janks counted so far this session. */
    janks: number;
    /** True when the app is tracking the panel - a frame cap is not applying. */
    fpsMatchesDisplayRate: boolean | null;
    /** How frame rate is being measured on this device. */
    fpsSource: string | null;
    /** When it cannot be measured, what was tried and what came back. */
    fpsDiagnostics: Array<{ strategy: string; ok: boolean; detail: string }>;
    /** Hottest zone right now, and whether the framework is throttling. */
    temperatureC: number | null;
    throttling: boolean;
    batteryPercent: number | null;
    batteryCharging: boolean;
  }>;
}

/**
 * Emits: `sample` (MemorySample), `event` (TimelineEvent), `log` (LogEvent),
 * `lifecycle` (ProcessLifecycleEvent + serial), `status` (LiveStatus).
 */
export class CaptureSession extends EventEmitter {
  readonly sessionId: string;
  readonly startedAtMs: number;
  private readonly runtimes: DeviceRuntime[] = [];
  private readonly eventsWriter: JsonlWriter<TimelineEvent>;
  private eventCount = 0;
  private running = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private manifest: SessionManifest | null = null;

  constructor(private readonly opts: CaptureSessionOptions) {
    super();
    this.sessionId = `s_${shortId(4)}`;
    this.startedAtMs = Date.now();
    this.eventsWriter = new JsonlWriter<TimelineEvent>(
      opts.workspace.file('events', `${this.sessionId}.jsonl`),
    );
  }

  get isRunning(): boolean {
    return this.running;
  }

  get manifestData(): SessionManifest | null {
    return this.manifest;
  }

  /** Set up probes, open the streams and begin sampling. */
  async start(): Promise<SessionManifest> {
    const log = this.opts.logger;
    const activeProbes: Record<string, string[]> = {};

    for (const target of this.opts.targets) {
      const deviceLog = log?.child(target.device.role);

      const sampler = new MemorySampler({
        device: target.adb,
        serial: target.device.serial,
        role: target.device.role,
        pid: target.pid,
        packageName: this.opts.packageName,
        sessionStartMs: this.startedAtMs,
        fastIntervalMs: this.opts.fastIntervalMs,
        deepIntervalMs: this.opts.deepIntervalMs,
        logger: deviceLog,
      });

      activeProbes[target.device.serial] = await sampler.prepare();

      const logcat = new LogcatMonitor({
        device: target.adb,
        serial: target.device.serial,
        sessionStartMs: this.startedAtMs,
        pids: [target.pid],
        packageName: this.opts.packageName,
        logger: deviceLog,
      });

      const watcher = new ProcessWatcher(
        target.adb,
        this.opts.packageName,
        target.pid,
        deviceLog,
      );

      const runtime: DeviceRuntime = {
        target,
        sampler,
        logcat,
        watcher,
        engine: new EngineMemoryTracker(deviceLog),
        engineProfile: new EngineProfileTracker(deviceLog),
        fpsReadings: [],
        fpsSeries: [],
        healthSamples: [],
        gpuReadings: [],
        gpuSeries: [],
        cpuReadings: [],
        cpuSeries: [],
        ioSamples: [],
        audioSamples: [],
        renderSeries: [],
        samplesWriter: new JsonlWriter<MemorySample>(
          this.opts.workspace.file('telemetry', `${this.sessionId}_${target.device.serial}.jsonl`),
        ),
        logWriter: new JsonlWriter<LogEvent>(
          this.opts.workspace.file('logs', `${this.sessionId}_${target.device.serial}_logcat.jsonl`),
        ),
        fpsWriter: new JsonlWriter(
          this.opts.workspace.file('telemetry', `${this.sessionId}_${target.device.serial}_fps.jsonl`),
        ),
        lastPss: null,
        lastRss: null,
        peakPss: 0,
      };

      this.wire(runtime);
      this.runtimes.push(runtime);
    }

    this.manifest = {
      schema: TELEMETRY_SCHEMA_VERSION,
      sessionId: this.sessionId,
      analysisId: this.opts.analysisId,
      packageName: this.opts.packageName,
      startedAt: new Date(this.startedAtMs).toISOString(),
      startedAtEpochMs: this.startedAtMs,
      devices: this.opts.targets.map((t) => ({
        serial: t.device.serial,
        role: t.device.role,
        model: t.device.model,
        totalRamBytes: t.device.totalRamBytes,
        initialPid: t.pid,
      })),
      fastIntervalMs: this.opts.fastIntervalMs ?? 1000,
      deepIntervalMs: this.opts.deepIntervalMs ?? 5000,
      activeProbes,
    };
    this.opts.workspace.writeJson('telemetry', `${this.sessionId}_manifest.json`, this.manifest);

    for (const runtime of this.runtimes) {
      await runtime.logcat.start();
      runtime.watcher.start();
      runtime.sampler.start();
    }

    this.running = true;
    this.statusTimer = setInterval(() => this.emit('status', this.status()), 1000);

    // The session's own t=0 marker, so the timeline always has an anchor.
    this.mark('session_start', { source: 'system', label: 'Session started' });

    log?.info('Capture session started', {
      sessionId: this.sessionId,
      devices: this.runtimes.length,
      package: this.opts.packageName,
    });

    return this.manifest;
  }

  private wire(runtime: DeviceRuntime): void {
    runtime.sampler.on('sample', (sample: MemorySample) => {
      runtime.samplesWriter.write(sample);
      if (sample.pssBytes !== null) {
        runtime.lastPss = sample.pssBytes;
        if (sample.pssBytes > runtime.peakPss) runtime.peakPss = sample.pssBytes;
      }
      if (sample.rssBytes !== null) runtime.lastRss = sample.rssBytes;

      // Attached to the deep sample only. The fast tier carries a total and no
      // breakdown, and pinning an engine reading to it would imply the two were
      // measured together when they were not.
      if (sample.tier === 'deep') {
        const engine = runtime.engine.current();
        if (engine) sample.engine = engine;

        // The engine's render and audio counters arrive on the reporter's
        // cadence, not ours, so a sample takes whatever the latest reading was.
        // Attached to the deep sample only, for the same reason the memory
        // totals are: pinning them to a fast sample would imply they were
        // measured together with a figure they were not.
        const render = runtime.engineProfile.currentRender();
        if (render) {
          sample.render = render;
          runtime.renderSeries.push({ elapsedMs: sample.elapsedMs, reading: render });
        }
        const engineAudio = runtime.engineProfile.currentAudio();
        if (engineAudio) sample.engineAudio = engineAudio;

        if (sample.thermal || sample.battery) {
          runtime.healthSamples.push({
            elapsedMs: sample.elapsedMs,
            ...(sample.thermal ? { thermal: sample.thermal } : {}),
            ...(sample.battery ? { battery: sample.battery } : {}),
          });
        }

        if (sample.gpu) {
          runtime.gpuReadings.push(sample.gpu);
          runtime.gpuSeries.push({ elapsedMs: sample.elapsedMs, reading: sample.gpu });
        }
        if (sample.cpu) {
          runtime.cpuReadings.push(sample.cpu);
          runtime.cpuSeries.push({ elapsedMs: sample.elapsedMs, reading: sample.cpu });
        }
        if (sample.io) {
          runtime.ioSamples.push({ elapsedMs: sample.elapsedMs, reading: sample.io });
        }
        if (sample.audio) {
          runtime.audioSamples.push({ elapsedMs: sample.elapsedMs, reading: sample.audio });
        }
      }

      this.emit('sample', sample);
    });

    // Frame rate arrives on its own event at 1 Hz, separately from the memory
    // samples, so the curve has the resolution the shape of a session needs.
    runtime.sampler.on(
      'fps',
      (e: { t: number; elapsedMs: number; serial: string; role: string; reading: FpsReading }) => {
        runtime.fpsWriter.write({ ...e, ...e.reading, reading: undefined });
        runtime.fpsReadings.push(e.reading);
        runtime.fpsSeries.push({
          elapsedMs: e.elapsedMs,
          fps: e.reading.fps,
          janks: e.reading.frames?.janks ?? 0,
        });
      },
    );

    runtime.logcat.on('log', (event: LogEvent) => {
      runtime.logWriter.write(event);

      // The reporter's lines are data, not log noise: they carry the only
      // per-asset-type figures that exist, and the OS cannot produce them.
      const reading = runtime.engine.ingest(event.message);
      if (reading) return;
      // Same for the render and audio channels: they are data on the same
      // transport, and letting them through to the log stream would fill an
      // operator's console with a line a second of JSON.
      if (runtime.engineProfile.ingest(event.message)) return;

      this.emit('log', event);

      // A kill notice in the log is a first-class timeline event - but only when
      // it is about our process. The OS reclaiming some other app during the
      // session is background noise, not a failure of the game under test.
      if ((event.category === 'oom_kill' || event.category === 'crash') && event.appRelated) {
        this.mark(event.category === 'crash' ? 'process_crash' : 'process_killed', {
          source: 'system',
          label: event.category === 'crash' ? 'Crash detected in logcat' : 'Process kill detected in logcat',
          serial: event.serial,
          data: { tag: event.tag, message: event.message.slice(0, 300) },
        });
      }
    });

    runtime.watcher.on('lifecycle', (event: ProcessLifecycleEvent) => {
      this.emit('lifecycle', { ...event, serial: runtime.target.device.serial });

      if (event.type === 'gone') {
        this.mark('process_gone', {
          source: 'system',
          label: 'Game process disappeared',
          serial: runtime.target.device.serial,
          data: { previousPid: event.previousPid },
        });
      } else if (event.type === 'restarted') {
        runtime.sampler.setPid(event.pid);
        this.mark('process_restarted', {
          source: 'system',
          label: 'Game process restarted with a new PID',
          serial: runtime.target.device.serial,
          data: { previousPid: event.previousPid, pid: event.pid },
        });
      }
    });

    runtime.sampler.on('probe_lost', () => {
      this.mark('probe_lost', {
        source: 'system',
        label: 'Memory probes stopped responding',
        serial: runtime.target.device.serial,
      });
    });
  }

  /**
   * Record a timeline marker. Called by the operator UI (Step 7) and by the
   * system for lifecycle events.
   */
  mark(
    type: string,
    opts: {
      source?: TimelineEvent['source'];
      label?: string;
      serial?: string;
      data?: Record<string, unknown>;
    } = {},
  ): TimelineEvent {
    const t = Date.now();
    const event: TimelineEvent = {
      schema: TELEMETRY_SCHEMA_VERSION,
      t,
      elapsedMs: t - this.startedAtMs,
      type,
      label: opts.label ?? markerLabel(type, opts.data?.['label'] as string | undefined),
      source: opts.source ?? 'operator',
      ...(opts.serial ? { serial: opts.serial } : {}),
      ...(opts.data ? { data: opts.data } : {}),
    };
    this.eventsWriter.write(event);
    this.eventCount++;
    this.opts.logger?.info(`Marker: ${event.label}`, {
      type,
      atMs: event.elapsedMs,
      source: event.source,
    });
    this.emit('event', event);
    return event;
  }

  status(): LiveStatus {
    return {
      sessionId: this.sessionId,
      running: this.running,
      startedAt: new Date(this.startedAtMs).toISOString(),
      elapsedMs: Date.now() - this.startedAtMs,
      packageName: this.opts.packageName,
      eventCount: this.eventCount,
      devices: this.runtimes.map((r) => {
        const stats = r.sampler.getStats();
        return {
          serial: r.target.device.serial,
          role: r.target.device.role,
          model: r.target.device.model,
          pid: r.watcher.pid,
          lastPssBytes: r.lastPss,
          lastRssBytes: r.lastRss,
          peakPssBytes: r.peakPss,
          fastSamples: stats.fastSamples,
          deepSamples: stats.deepSamples,
          alive: r.watcher.pid !== null,
          fps: r.fpsReadings.at(-1)?.fps ?? null,
          fpsDisplayHz: r.fpsReadings.at(-1)?.displayHz ?? null,
          fpsMedian: r.fpsReadings.at(-1)?.frames?.medianFps ?? null,
          // Cumulative, so the operator sees stutter accumulate rather than only
          // whatever happened in the last five seconds.
          janks: r.fpsSeries.reduce((sum, p) => sum + p.janks, 0),
          fpsMatchesDisplayRate: r.fpsReadings.at(-1)?.matchesDisplayRate ?? null,
          fpsSource: r.sampler.frameRateSource,
          fpsDiagnostics: r.sampler.frameRateDiagnostics,
          temperatureC:
            r.healthSamples.at(-1)?.thermal?.maxZoneC ??
            r.healthSamples.at(-1)?.battery?.temperatureC ??
            null,
          throttling: r.healthSamples.at(-1)?.thermal?.throttling ?? false,
          batteryPercent: r.healthSamples.at(-1)?.battery?.levelPercent ?? null,
          batteryCharging: r.healthSamples.at(-1)?.battery?.charging ?? false,
        };
      }),
    };
  }

  /**
   * Frame rate and device health for the whole session, per device.
   *
   * Reduced here rather than in the report because only the session saw every
   * reading: the sample files carry them, but re-reading a JSONL file to
   * recompute what was just in memory would be wasteful and could disagree.
   */
  healthByDevice(): Array<{
    serial: string;
    role: string;
    fps: FpsSummary;
    /** Frame rate over time, for the report's chart. */
    fpsSeries: Array<{ elapsedMs: number; fps: number; janks: number }>;
    thermal: ThermalSummary;
    battery: BatterySummary;
  }> {
    const durationMs = Date.now() - this.startedAtMs;
    return this.runtimes.map((r) => ({
      serial: r.target.device.serial,
      role: r.target.device.role,
      fps: summarizeFps(
        r.fpsReadings.map((f) => ({
          fps: f.fps,
          displayHz: f.displayHz,
          matchesDisplayRate: f.matchesDisplayRate,
          frames: f.frames,
          frameCount: f.frameCount,
          windowMs: f.windowMs,
          jankPercent: f.jankPercent,
          worstFrameMs: f.worstFrameMs,
          source: f.source,
        })),
        durationMs,
      ),
      // One point per sampled window, each carrying the janks counted in it, so
      // the chart can mark stutter where it happened rather than only totalling it.
      fpsSeries: r.fpsSeries,
      thermal: summarizeThermal(r.healthSamples),
      battery: summarizeBattery(r.healthSamples, durationMs),
    }));
  }

  /**
   * GPU, CPU, storage and audio for the whole session, per device.
   *
   * Separate from `healthByDevice()` rather than folded into it because the two
   * are consumed differently: frame rate, heat and battery describe the device,
   * while these four describe where a frame went, and the report puts them in
   * different sections. Reduced here for the same reason as the health figures -
   * only the session saw every reading.
   *
   * The raw series come back alongside the summaries: the diagnostic engine
   * needs the points, not the averages, because its whole job is to look at one
   * moment across every subsystem at once.
   */
  subsystemsByDevice(
    markers: Array<{ elapsedMs: number; label: string }> = [],
  ): Array<{
    serial: string;
    role: string;
    gpu: GpuSummary;
    render: RenderSummary;
    cpu: CpuSummary;
    io: DiskIoSummary;
    audio: AudioSummary;
    series: {
      gpu: Array<{ elapsedMs: number; reading: GpuReading }>;
      cpu: Array<{ elapsedMs: number; reading: CpuReading }>;
      render: Array<{ elapsedMs: number; reading: NonNullable<ReturnType<EngineProfileTracker['currentRender']>> }>;
      io: DiskIoSample[];
      audio: AudioSample[];
    };
  }> {
    const durationMs = Date.now() - this.startedAtMs;

    return this.runtimes.map((r) => {
      const diagnostics = r.sampler.subsystemDiagnostics;

      // The reason a figure is missing is part of the figure. Assembled from
      // what each probe reported at prepare() so the report can say which node
      // the device refused rather than "GPU: unknown".
      const gpuReason =
        r.gpuReadings.length > 0
          ? null
          : `No GPU load interface answered on this device. Tried: ${diagnostics.gpu
              .map((a) => `${a.strategy} (${a.detail})`)
              .join('; ')}.`;
      const cpuReason =
        r.cpuReadings.length > 0
          ? null
          : `Per-core CPU load was not readable. Tried: ${diagnostics.cpu
              .map((a) => `${a.strategy} (${a.detail})`)
              .join('; ')}.`;

      return {
        serial: r.target.device.serial,
        role: r.target.device.role,
        gpu: summarizeGpu(r.gpuReadings, gpuReason),
        render: summarizeRender(r.engineProfile.renderReadings),
        cpu: summarizeCpu(r.cpuReadings, cpuReason),
        io: summarizeDiskIo(r.ioSamples, r.fpsSeries, markers, diagnostics.ioReason),
        audio: summarizeAudio(
          r.audioSamples,
          r.engineProfile.audioReadings,
          durationMs,
          diagnostics.audioReason,
        ),
        series: {
          gpu: r.gpuSeries,
          cpu: r.cpuSeries,
          render: r.renderSeries.filter(
            (p): p is { elapsedMs: number; reading: NonNullable<typeof p.reading> } =>
              p.reading !== null,
          ),
          io: r.ioSamples,
          audio: r.audioSamples,
        },
      };
    });
  }

  /** Paths of the artifacts this session produced, for the analysis stage. */
  artifacts(): {
    manifestPath: string;
    eventsPath: string;
    telemetryPaths: Array<{ serial: string; role: string; path: string }>;
    logPaths: Array<{ serial: string; path: string }>;
  } {
    return {
      manifestPath: this.opts.workspace.file('telemetry', `${this.sessionId}_manifest.json`),
      eventsPath: this.opts.workspace.file('events', `${this.sessionId}.jsonl`),
      telemetryPaths: this.runtimes.map((r) => ({
        serial: r.target.device.serial,
        role: r.target.device.role,
        path: r.samplesWriter.path,
      })),
      logPaths: this.runtimes.map((r) => ({
        serial: r.target.device.serial,
        path: r.logWriter.path,
      })),
    };
  }

  async stop(): Promise<SessionManifest | null> {
    if (!this.running) return this.manifest;
    this.running = false;

    this.mark('session_end', { source: 'system', label: 'Session ended' });

    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;

    for (const runtime of this.runtimes) {
      runtime.sampler.stop();
      // Frame-rate collection may have switched something on in SurfaceFlinger;
      // leave the device as we found it.
      void runtime.sampler.release();
      runtime.logcat.stop();
      runtime.watcher.stop();
    }

    await Promise.all([
      this.eventsWriter.close(),
      ...this.runtimes.flatMap((r) => [
        r.samplesWriter.close(),
        r.logWriter.close(),
        r.fpsWriter.close(),
      ]),
    ]);

    if (this.manifest) {
      this.manifest.finishedAt = new Date().toISOString();
      this.opts.workspace.writeJson('telemetry', `${this.sessionId}_manifest.json`, this.manifest);
    }

    this.opts.logger?.info('Capture session stopped', {
      sessionId: this.sessionId,
      durationMs: Date.now() - this.startedAtMs,
      events: this.eventCount,
    });

    return this.manifest;
  }
}
