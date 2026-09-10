/**
 * End-to-end pipeline.
 *
 * Sequences the stages exactly as the spec's process diagram does, and is the
 * single implementation used by both the CLI and the operator UI - so a run
 * started from the terminal and one started from the browser are the same run.
 *
 * The gameplay phase is intentionally a pause point: `prepareCapture` gets the
 * devices ready and starts telemetry, then control returns to the operator, and
 * `finish` does the analysis once they stop. That is the MVP trade-off the spec
 * settles on - automate everything except playing the game.
 */
import { FEATURES } from '../core/features.js';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { inspectApk, type ApkInfo } from '../apk/inspector.js';
import { loadConfig, type AppConfig } from '../core/config.js';
import { describeError } from '../core/errors.js';
import { AnalysisJob } from '../core/job.js';
import type { Finding, StudioIntakeInput } from '../core/types.js';
import { Adb } from '../devices/adb.js';
import { AppController } from '../devices/appController.js';
import { DeviceManager, type DeviceInfo } from '../devices/deviceManager.js';
import {
  isUnityProcess,
  listInstalledApps,
  readInstalledVersion,
  resolveLaunchComponent,
} from '../devices/installedApps.js';
import { prepareFreshStart, type FreshStartResult } from '../devices/freshStart.js';
import {
  closePlayerConnection,
  openPlayerConnection,
  type PlayerConnectionInfo,
} from '../devices/playerConnection.js';
import { acquireApk, type AcquiredApk } from '../intake/apkFetch.js';
import { cloneRepository, type CloneResult } from '../intake/git.js';
import { validateUnityProject, type UnityProjectInfo } from '../intake/unityProject.js';
import { runStaticAnalysis, type StaticAnalysisResult } from '../static/index.js';
import { CaptureSession, type CaptureTarget } from '../telemetry/session.js';
import { detectAnomalies, type DeviceAnomalySummary } from '../analysis/anomaly.js';
import { correlate, type CorrelationLink } from '../analysis/correlation.js';
import { analyzeFlows, type DeviceFlowAnalysis, type ScreenVisit } from '../analysis/flow.js';
import { score, type ScoringResult } from '../analysis/scoring.js';
import { loadTimeline, type SessionTimeline } from '../analysis/timeline.js';
import { buildReport } from '../report/build.js';
import { attachPreviousRun } from '../report/previousRun.js';
import { renderAllAudiences } from '../report/markdown.js';
import { safeValidateReport, type AnalysisReport } from '../report/model.js';

export interface PipelineOptions {
  input: StudioIntakeInput;
  config?: AppConfig;
  /** Skip the device phase entirely (static-only run). */
  staticOnly?: boolean;
  /** Wipe app data before launch, for a true cold-launch baseline. */
  freshState?: boolean;
  /**
   * Free memory before launching, so the peak is measured on a quiet device.
   *
   * A peak reached with nine other games resident is a different result from one
   * reached on a fresh device: the low-memory killer decides what to reclaim
   * from everything running, not from our app alone.
   */
  killBackgroundApps?: boolean;
  /** Uninstall an existing build before installing. */
  freshInstall?: boolean;
  fastIntervalMs?: number;
  deepIntervalMs?: number;
}

export interface PipelineState {
  job: AnalysisJob;
  clone: CloneResult | null;
  project: UnityProjectInfo | null;
  apkFile: AcquiredApk | null;
  apk: ApkInfo | null;
  staticResult: StaticAnalysisResult | null;
  devices: DeviceInfo[];
  session: CaptureSession | null;
  report: AnalysisReport | null;
  reportPaths: { json?: string; markdown?: string; qualityGate?: string; byAudience?: Record<string, string> };
}

/** Emits `stage` and `error` so the UI can follow progress. */
export class AnalysisPipeline extends EventEmitter {
  readonly job: AnalysisJob;
  private readonly config: AppConfig;
  private readonly adb: Adb;

  private clone: CloneResult | null = null;
  private project: UnityProjectInfo | null = null;
  private apkFile: AcquiredApk | null = null;
  private apk: ApkInfo | null = null;
  private staticResult: StaticAnalysisResult | null = null;
  private devices: DeviceInfo[] = [];
  /** serial -> Unity profiler forward, when the build is a development build. */
  private readonly playerConnections = new Map<string, PlayerConnectionInfo>();
  /** serial -> what was freed before the run, when the operator asked for it. */
  private readonly freshStarts = new Map<string, FreshStartResult>();
  /** Version as installed, for a run with no APK to inspect. */
  private installedVersionName: string | null = null;
  private targets: CaptureTarget[] = [];
  /**
   * Devices where the game never reached the foreground.
   *
   * Collected rather than thrown, because the memory measurement is still
   * valid and worth having; it is the frame-rate half that has to be disowned.
   */
  private backgroundedLaunches: Array<{
    role: string;
    model: string;
    holding: string | null;
  }> = [];
  private session: CaptureSession | null = null;
  private report: AnalysisReport | null = null;
  private reportPaths: { json?: string; markdown?: string; qualityGate?: string; byAudience?: Record<string, string> } = {};
  /** Set by `runLocalIntakeAndStatic`; takes precedence over the input. */
  private localProjectPath: string | null = null;

  constructor(private readonly opts: PipelineOptions) {
    super();
    this.config = opts.config ?? loadConfig();
    this.job = AnalysisJob.create(opts.input, this.config);
    this.adb = new Adb(this.config.adbPath, this.job.log.child('adb'));
    this.job.onChange((meta) => this.emit('stage', meta));
  }

  get state(): PipelineState {
    return {
      job: this.job,
      clone: this.clone,
      project: this.project,
      apkFile: this.apkFile,
      apk: this.apk,
      staticResult: this.staticResult,
      devices: this.devices,
      session: this.session,
      report: this.report,
      reportPaths: this.reportPaths,
    };
  }

  get captureSession(): CaptureSession | null {
    return this.session;
  }

  // -------------------------------------------------------------------------
  // Phase 1 - intake and static analysis
  // -------------------------------------------------------------------------

  async runIntakeAndStatic(): Promise<void> {
    const log = this.job.log;
    this.job.setStatus('intake');

    // Project source: optional, because an APK-only analysis is still useful -
    // it just cannot identify causes. Two ways in, and a local folder wins when
    // both are given: if the operator pointed at a checkout on disk, that is
    // the code they mean, not whatever the remote branch currently holds.
    await this.job.runStage(
      'intake.repository',
      async () => {
        const localPath = this.localProjectPath ?? this.opts.input.projectPath;

        if (localPath) {
          this.project = validateUnityProject(localPath, log.child('unity'));
          this.job.updateStage('intake.repository', {
            message: `Local project at ${localPath} (not cloned)`,
          });
        } else if (this.opts.input.repoUrl) {
          this.clone = await cloneRepository({
            repoUrl: this.opts.input.repoUrl,
            branch: this.opts.input.branch,
            targetDir: join(this.job.workspace.dir('source'), 'repo'),
            githubToken: this.config.githubToken,
            logger: log.child('git'),
          });
          this.project = validateUnityProject(this.clone.path, log.child('unity'));
          this.job.saveArtifact('metadata', 'repository.json', this.clone);
        } else {
          throw new Error('No Unity project supplied (need a project folder or a repository URL)');
        }

        this.job.saveArtifact('static', 'project.json', this.project);
      },
      { optional: true },
    );

    // When the operator picked an app already on the device, there is no APK to
    // fetch or install - the package name and its launch component are all the
    // profiling phase needs. An APK still adds build-configuration detail, so it
    // is used when supplied, but never required.
    const usingInstalledApp = Boolean(this.opts.input.packageName);
    const apkSupplied = Boolean(this.opts.input.apkPath || this.opts.input.apkUrl);

    if (usingInstalledApp && !apkSupplied) {
      this.job.updateStage('intake.apk', {
        status: 'skipped',
        message: `Analyzing ${this.opts.input.packageName} already installed on the device`,
      });
      this.job.updateStage('apk.inspect', {
        status: 'skipped',
        message: 'No APK file; build configuration was not inspected',
      });
    }

    // APK: also optional, so a source-only review can run before a build exists.
    if (apkSupplied) await this.job.runStage(
      'intake.apk',
      async () => {
        this.apkFile = await acquireApk({
          apkPath: this.opts.input.apkPath,
          apkUrl: this.opts.input.apkUrl,
          destDir: this.job.workspace.dir('apk'),
          logger: log.child('apk'),
        });
        this.job.saveArtifact('apk', 'source.json', this.apkFile);
      },
      { optional: true },
    );

    if (this.apkFile) {
      await this.job.runStage(
        'apk.inspect',
        async () => {
          this.apk = await inspectApk({
            apkPath: this.apkFile!.path,
            aapt2Path: this.config.aapt2Path,
            logger: log.child('apk'),
          });
          this.job.saveArtifact('apk', 'inspection.json', this.apk);
        },
        { optional: true },
      );
    } else {
      this.job.updateStage('apk.inspect', { status: 'skipped', message: 'No APK supplied' });
    }

    if (!this.project && !this.apk && !usingInstalledApp) {
      const message =
        'Nothing to analyze. Supply a Unity project, an APK, or the package name of an app ' +
        'already installed on the device.';
      this.job.setStatus('failed', message);
      throw new Error(message);
    }

    // Detect devices before static analysis so rules can express thresholds
    // relative to the actual weakest target device.
    if (!this.opts.staticOnly) {
      await this.job.runStage(
        'device.detect',
        async () => {
          const manager = new DeviceManager(this.adb, log.child('devices'));
          this.devices = await manager.detect({
            onlySerials: this.opts.input.deviceSerials,
            logger: log.child('devices'),
          });
          this.job.saveArtifact('devices', 'devices.json', this.devices);
        },
        { optional: true },
      );
    }

    this.job.setStatus('static_analysis');
    if (this.project) {
      await this.job.runStage(
        'static.analysis',
        async () => {
          this.staticResult = await runStaticAnalysis({
            project: this.project!,
            apk: this.apk,
            devices: this.devices,
            logger: log.child('static'),
          });
          this.job.saveArtifact('static', 'findings.json', this.staticResult.findings);
          this.job.saveArtifact('static', 'summary.json', this.staticResult.summary);
        },
        { optional: true },
      );
    } else {
      this.job.updateStage('static.analysis', {
        status: 'skipped',
        message: 'No Unity project available',
      });
    }
  }

  /**
   * Static analysis against a project directory already on disk.
   *
   * Used by `gdshield scan --local`, the desktop console, and CI setups that check
   * the repository out themselves. Delegates to the normal intake path with the
   * clone stage short-circuited, so there is only one implementation of the
   * sequence to keep correct.
   */
  async runLocalIntakeAndStatic(localPath: string): Promise<void> {
    this.localProjectPath = localPath;
    await this.runIntakeAndStatic();
  }

  // -------------------------------------------------------------------------
  // Phase 2 - device setup and telemetry
  // -------------------------------------------------------------------------

  /**
   * Install, launch, resolve PIDs and start sampling on every device. Returns
   * once telemetry is flowing; the operator then plays the game.
   */
  async prepareCapture(): Promise<CaptureSession> {
    // The package under test comes either from the APK we inspected, or from the
    // app the operator picked off the device.
    const packageName = this.opts.input.packageName ?? this.apk?.packageName;
    if (!packageName) {
      throw new Error(
        'No app to profile. Choose an app installed on the device, or supply an APK to install.',
      );
    }

    if (this.devices.length === 0) {
      const manager = new DeviceManager(this.adb, this.job.log.child('devices'));
      this.devices = await manager.detect({
        onlySerials: this.opts.input.deviceSerials,
        logger: this.job.log.child('devices'),
      });
      this.job.saveArtifact('devices', 'devices.json', this.devices);
    }

    this.job.setStatus('device_setup');

    // Install only when we actually have an APK. Profiling an app already on the
    // device is the common case and needs no install at all.
    if (this.apkFile) {
      await this.job.runStage('device.install', async () => {
        for (const device of this.devices) {
          const controller = new AppController(
            this.adb.device(device.serial),
            this.job.log.child(`install:${device.role}`),
          );
          await controller.install(this.apkFile!.path, {
            fresh: this.opts.freshInstall ?? false,
            packageName,
          });
        }
      });
    } else {
      this.job.updateStage('device.install', {
        status: 'skipped',
        message: `${packageName} is already installed`,
      });
    }

    // The launch component may not be known yet: with no APK to read it from, ask
    // the device which activity its launcher would start.
    let launchComponent = this.apk?.launchComponent ?? null;
    if (!launchComponent) {
      launchComponent = await resolveLaunchComponent(
        this.adb.device(this.devices[0]!.serial),
        packageName,
      );
      if (launchComponent) {
        this.job.log.info('Resolved launch component from the device', { launchComponent });
      }
    }

    // Without an APK there is no version in the report, which makes two sessions
    // of different builds indistinguishable - and telling them apart is the whole
    // point of a comparison.
    if (!this.apk && this.devices[0]) {
      this.installedVersionName = await readInstalledVersion(
        this.adb.device(this.devices[0].serial),
        packageName,
      );
      if (this.installedVersionName) {
        this.job.log.info('Read the installed version from the device', {
          packageName,
          versionName: this.installedVersionName,
        });
      }
    }

    // Before launching, not after: the point is that the game starts on a quiet
    // device, and clearing memory once it is already resident would prove nothing.
    if (this.opts.killBackgroundApps) {
      await this.job.runStage('device.freshStart', async () => {
        for (const device of this.devices) {
          const adbDevice = this.adb.device(device.serial);
          const installed = await listInstalledApps(adbDevice);
          const result = await prepareFreshStart({
            device: adbDevice,
            targetPackage: packageName,
            installedThirdParty: installed.map((a) => a.packageName),
            logger: this.job.log.child(`fresh:${device.role}`),
          });
          this.freshStarts.set(device.serial, result);
          this.job.saveArtifact('devices', `freshStart_${device.serial}.json`, result);
        }
      });
    }

    this.targets = [];
    await this.job.runStage('device.launch', async () => {
      for (const device of this.devices) {
        const adbDevice = this.adb.device(device.serial);
        const controller = new AppController(adbDevice, this.job.log.child(`launch:${device.role}`));
        const result = await controller.launch({
          packageName,
          ...(launchComponent ? { launchComponent } : {}),
          freshState: this.opts.freshState ?? false,
        });
        this.targets.push({ device, adb: adbDevice, pid: result.pid });

        /*
         * Kept, because a game that never reached the foreground makes every
         * frame-rate figure in the report worthless while looking normal - a
         * backgrounded Unity app keeps its PID and keeps reporting memory, but
         * its renderer is throttled or paused. Silently shipping that is worse
         * than failing.
         */
        if (!result.foregrounded) {
          this.backgroundedLaunches.push({
            role: device.role,
            model: `${device.manufacturer} ${device.model}`,
            holding: result.foregroundPackage,
          });
        }

        // With no APK to inspect, this is the only reliable Unity check: the
        // running process's memory map names every library it actually loaded.
        const unity = await isUnityProcess(adbDevice, result.pid);
        if (unity === false) {
          this.job.log.warn(
            'libunity.so is not mapped in the running process - this may not be a Unity game',
            { packageName, pid: result.pid },
          );
        }

        this.job.saveArtifact('devices', `launch_${device.serial}.json`, {
          ...result,
          unityDetected: unity,
        });
      }
    });

    // Forwarding the Unity profiler socket is what tells us whether this is a
    // development build at all, which decides whether per-asset-type figures are
    // obtainable. It never blocks the run: a release build simply has no socket.
    await this.job.runStage('device.profiler', async () => {
      for (const target of this.targets) {
        const info = await openPlayerConnection({
          device: target.adb,
          packageName,
          logger: this.job.log.child(`profiler:${target.device.role}`),
        });
        this.playerConnections.set(target.device.serial, info);
        this.job.saveArtifact('devices', `profiler_${target.device.serial}.json`, info);

        if (info.available) {
          this.job.log.info(
            'Unity profiler port forwarded - the Unity Editor can attach at this address too',
            { localPort: info.localPort, socket: info.socketName },
          );
        } else {
          this.job.log.info('No Unity profiler connection', { reason: info.reason });
        }
      }
    });

    this.session = new CaptureSession({
      analysisId: this.job.id,
      packageName,
      workspace: this.job.workspace,
      targets: this.targets,
      fastIntervalMs: this.opts.fastIntervalMs ?? this.config.fastSampleIntervalMs,
      deepIntervalMs: this.opts.deepIntervalMs ?? this.config.deepSampleIntervalMs,
      logger: this.job.log.child('capture'),
    });

    await this.job.runStage('live.capture', async () => {
      await this.session!.start();
    });

    this.job.setStatus('live_capture');
    return this.session;
  }

  /** Stop telemetry. Safe to call when no session is running. */
  async stopCapture(): Promise<void> {
    if (!this.session) return;
    await this.session.stop();

    // Leaving a forward behind would block the next run's port, and would let a
    // later Unity Editor attach to a game we are no longer profiling.
    for (const [serial, info] of this.playerConnections) {
      if (info.localPort !== null) {
        await closePlayerConnection(this.adb.device(serial), info.localPort, this.job.log);
      }
    }
    this.playerConnections.clear();

    this.job.setStatus('analyzing');
  }

  // -------------------------------------------------------------------------
  // Phase 3 - analysis and report
  // -------------------------------------------------------------------------

  async finish(): Promise<AnalysisReport> {
    const log = this.job.log;
    this.job.setStatus('analyzing');

    let timeline: SessionTimeline | null = null;
    let anomalySummaries: DeviceAnomalySummary[] = [];
    let flowAnalyses: DeviceFlowAnalysis[] = [];
    let screenVisits: ScreenVisit[] = [];
    let liveFindings: Finding[] = [];
    let sessionDurationMs = 0;

    if (this.session) {
      const artifacts = this.session.artifacts();
      const manifest = this.session.manifestData;

      await this.job.runStage(
        'analysis.anomaly',
        async () => {
          timeline = await loadTimeline({
            sessionId: this.session!.sessionId,
            startedAtEpochMs: manifest?.startedAtEpochMs ?? this.session!.startedAtMs,
            telemetryPaths: artifacts.telemetryPaths,
            eventsPath: artifacts.eventsPath,
            logPaths: artifacts.logPaths,
          });

          sessionDurationMs = Math.max(
            0,
            ...timeline.devices.map((d) => d.durationMs),
            ...timeline.events.map((e) => e.elapsedMs),
          );

          const anomalies = detectAnomalies({
            timeline,
            devices: this.devices,
            packageName:
              manifest?.packageName ??
              this.opts.input.packageName ??
              this.apk?.packageName ??
              undefined,
          });
          anomalySummaries = anomalies.perDevice;
          liveFindings.push(...anomalies.findings);
          this.job.saveArtifact('telemetry', 'anomalies.json', anomalies.perDevice);
        },
        { optional: true },
      );

      if (timeline) {
        await this.job.runStage(
          'analysis.flow',
          async () => {
            const flows = analyzeFlows({ timeline: timeline!, devices: this.devices });
            flowAnalyses = flows.perDevice;
            screenVisits = flows.screenVisits;
            liveFindings.push(...flows.findings);
            this.job.saveArtifact('telemetry', 'flows.json', flows.perDevice);
          },
          { optional: true },
        );
      }
    } else {
      this.job.updateStage('analysis.anomaly', {
        status: 'skipped',
        message: 'No live session captured',
      });
      this.job.updateStage('analysis.flow', {
        status: 'skipped',
        message: 'No live session captured',
      });
    }

    const staticFindings = this.staticResult?.findings ?? [];

    let correlations: CorrelationLink[] = [];
    let correlatedFindings: Finding[] = [];
    await this.job.runStage(
      'analysis.correlation',
      async () => {
        const result = correlate({
          staticFindings,
          liveFindings,
          ...(this.staticResult ? { assets: this.staticResult.indexes.assets } : {}),
          ...(this.staticResult ? { scenes: this.staticResult.indexes.scenes } : {}),
        });
        correlations = result.links;
        correlatedFindings = result.correlated;

        // Inputs that were folded into a correlated finding are removed from
        // their original lists so the report does not say the same thing twice.
        liveFindings = liveFindings.filter((f) => !result.consumedLiveIds.has(f.id));
        this.job.saveArtifact('static', 'correlations.json', result.links);
      },
      { optional: true },
    );

    const remainingStatic = staticFindings.filter(
      (f) => !correlations.some((c) => c.staticFindingId === f.id),
    );

    let scoring: ScoringResult | null = null;
    await this.job.runStage('analysis.scoring', async () => {
      scoring = score({
        staticFindings: remainingStatic,
        liveFindings,
        correlatedFindings,
        context: {
          hasRepository: Boolean(this.project),
          hasApk: Boolean(this.apk),
          hasMetaFiles: this.project?.hasMetaFiles ?? false,
          liveSessionRan: Boolean(this.session),
          deviceCount: this.devices.length,
          sessionDurationMs,
          cycleCount: Math.max(0, ...flowAnalyses.map((f) => f.cycleCount)),
          markerCount: timeline
            ? (timeline as SessionTimeline).events.filter((e) => e.source === 'operator').length
            : 0,
        },
        devices: anomalySummaries.map((a) => ({
          serial: a.serial,
          role: a.role,
          model: a.model,
          totalRamBytes: a.totalRamBytes,
          peakBytes: a.peakBytes,
          peakRamFraction: a.peakRamFraction,
          processDeaths: a.processDeaths,
          osKills: a.osKills,
        })),
      });
    });

    if (!scoring) throw new Error('Scoring failed; cannot produce a report.');

    this.job.setStatus('reporting');
    await this.job.runStage('report.generate', async () => {
      const report = buildReport({
        analysisId: this.job.id,
        gameId: this.job.gameId,
        // Frame rate, heat and battery as the session itself reduced them.
        ...(this.session ? { health: this.session.healthByDevice() } : {}),
        // GPU, rendering, CPU threading, storage and audio, with the raw series
        // the diagnostic engine needs. Markers are passed in so an I/O burst can
        // be named after whatever the operator was doing at the time.
        ...(this.session
          ? {
              subsystems: this.session.subsystemsByDevice(
                (timeline?.events ?? [])
                  .filter((e) => e.source === 'operator')
                  .map((e) => ({ elapsedMs: e.elapsedMs, label: e.label })),
              ),
            }
          : {}),
        ...(this.freshStarts.size > 0
          ? { freshStarts: Object.fromEntries(this.freshStarts) }
          : {}),
        ...(this.installedVersionName
          ? { installedVersionName: this.installedVersionName }
          : {}),
        input: this.opts.input,
        apk: this.apk,
        clone: this.clone,
        unityVersion: this.project?.unityVersion ?? null,
        devices: this.devices,
        staticSummary: this.staticResult?.summary ?? null,
        staticFindings: remainingStatic,
        liveFindings,
        correlatedFindings,
        correlations,
        scoring: scoring!,
        anomalySummaries,
        flowAnalyses,
        screenVisits,
        timeline,
        sessionDurationMs,
        artifacts: this.collectArtifacts(),
        extraLimitations: this.collectLimitations(),
      });

      // The five-line "did the update make it better?" block, when an earlier
      // run of this game exists. Incapable of failing the run by design.
      attachPreviousRun(report, this.config, log);

      const validation = safeValidateReport(report);
      if (!validation.ok) {
        // A schema mismatch is a bug in us, not in the studio's game - fail
        // loudly rather than shipping a malformed report.
        log.error('Generated report failed schema validation', {
          errors: validation.errors?.slice(0, 5).join('; '),
        });
        throw new Error(`Report failed schema validation: ${validation.errors?.slice(0, 3).join('; ')}`);
      }

      this.report = report;
      this.reportPaths.json = this.job.workspace.writeJson('reports', 'report.json', report);

      // The CI gate as its own small file. A build pipeline should not have to
      // parse a multi-megabyte report to find out whether it passed, and a
      // separate artifact is what lets a Jenkins or Actions step read one field.
      if (report.qualityGate) {
        this.reportPaths.qualityGate = this.job.workspace.writeJson(
          'reports',
          'quality-gate.json',
          report.qualityGate,
        );
      }

      // Three audience cuts of the same data: a lead, the engineer who fixes it,
      // and an analyst who wants the whole evidence trail.
      const byAudience: Record<string, string> = {};
      for (const cut of renderAllAudiences(report)) {
        byAudience[cut.audience] = this.job.workspace.writeText(
          'reports',
          cut.fileName,
          cut.markdown,
        );
      }
      this.reportPaths.byAudience = byAudience;
      this.reportPaths.markdown = byAudience['complete'];

      log.info('Report generated', {
        json: this.reportPaths.json,
        audiences: Object.keys(byAudience).join(', '),
        risk: report.verdict.combinedRisk.value,
      });
    });

    this.job.setStatus('completed');
    return this.report!;
  }

  /** Convenience for a fully unattended static-only run. */
  async runStaticOnly(): Promise<AnalysisReport> {
    await this.runIntakeAndStatic();
    return this.finish();
  }

  private collectArtifacts(): Array<{ kind: string; path: string; description: string }> {
    const artifacts: Array<{ kind: string; path: string; description: string }> = [];
    const ws = this.job.workspace;

    artifacts.push({
      kind: 'workspace',
      path: ws.root,
      description: 'All raw data for this analysis',
    });
    if (this.staticResult) {
      artifacts.push({
        kind: 'static',
        path: ws.file('static', 'findings.json'),
        description: 'Raw static findings',
      });
    }
    if (this.session) {
      const sessionArtifacts = this.session.artifacts();
      artifacts.push({
        kind: 'telemetry',
        path: sessionArtifacts.manifestPath,
        description: 'Capture session manifest',
      });
      artifacts.push({
        kind: 'events',
        path: sessionArtifacts.eventsPath,
        description: 'Operator markers and system lifecycle events (JSONL)',
      });
      for (const t of sessionArtifacts.telemetryPaths) {
        artifacts.push({
          kind: 'telemetry',
          path: t.path,
          description: `Memory samples for Device ${t.role} (${t.serial}), JSONL`,
        });
      }
      for (const l of sessionArtifacts.logPaths) {
        artifacts.push({
          kind: 'logcat',
          path: l.path,
          description: `Filtered logcat for ${l.serial}, JSONL`,
        });
      }
    }
    return artifacts;
  }

  private collectLimitations(): string[] {
    const limitations: string[] = [];

    /*
     * The loudest limitation this tool can report.
     *
     * Every other entry says a figure is missing. This one says a figure is
     * present and wrong, which a reader has no way of noticing for themselves.
     */
    for (const launch of this.backgroundedLaunches) {
      limitations.push(
        `The game was not in the foreground on ${launch.model}` +
          (launch.holding ? ` - ${launch.holding} held it instead` : '') +
          '. Frame rate, stutter and every figure derived from them are not measurements of the ' +
          'game running: a backgrounded app keeps its process and its memory but its renderer is ' +
          'throttled or paused. Memory figures are still valid. Re-run with the phone unlocked, ' +
          'on the home screen, and with "Close other apps first" selected.',
      );
    }

    // Only worth saying when the project was something the operator could have
    // supplied. With the field hidden it is not a limitation, it is the design.
    if (!this.project && FEATURES.projectAnalysis) {
      limitations.push(
        'The Unity project was not available, so no static analysis was performed and runtime findings ' +
          'could not be traced to a cause in the source.',
      );
    }
    if (!this.apk) {
      limitations.push('No APK was inspected, so build configuration risks were not assessed.');
    }
    if (!this.session) {
      limitations.push(
        'No live device session was captured. All findings are predictions and none has been observed.',
      );
    }
    if (this.devices.length === 1) {
      limitations.push(
        'Only one device was used. Cross-device comparison, which separates genuine retention from a ' +
          'single device memory budget, was not possible.',
      );
    }
    /*
     * Skipped stages, except the ones skipped because there is no project.
     *
     * "Stage intake.repository was skipped: No Unity project supplied" is a
     * true sentence that tells the reader nothing while the field is hidden -
     * it names an input they were never asked for.
     */
    const projectStages = new Set(['intake.repository', 'static.analysis', 'analysis.correlation']);
    for (const stage of this.job.meta.stages) {
      if (stage.status !== 'skipped' || !stage.error) continue;
      if (!FEATURES.projectAnalysis && projectStages.has(stage.name)) continue;
      limitations.push(`Stage "${stage.name}" was skipped: ${stage.error}`);
    }
    return limitations;
  }

  /** Best-effort teardown. Never throws. */
  async dispose(): Promise<void> {
    try {
      await this.session?.stop();
    } catch (err) {
      this.job.log.debug('Error during teardown', { error: describeError(err) });
    }
  }
}
