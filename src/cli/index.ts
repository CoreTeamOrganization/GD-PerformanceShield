#!/usr/bin/env node
/**
 * Command line interface.
 *
 * Two ways to run an analysis:
 *   `gdshield analyze`  - full pipeline with an interactive terminal marker prompt
 *   `gdshield serve`    - operator UI in the browser (better for real sessions)
 *
 * Plus the small utilities an operator actually needs on a bench: `devices`,
 * `inspect-apk`, `scan` and `report`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { Command } from 'commander';

import { inspectApk, describeApk } from '../apk/inspector.js';
import { loadConfig } from '../core/config.js';
import { describeError } from '../core/errors.js';
import { findJob, listJobs, TOOL_VERSION } from '../core/job.js';
import { createLogger, setLogLevel, type LogLevel } from '../core/logger.js';
import { MB } from '../core/types.js';
import { Adb } from '../devices/adb.js';
import { DeviceManager, describeDevice } from '../devices/deviceManager.js';
import { MARKERS } from '../events/markers.js';
import { FpsSampler } from '../telemetry/fps.js';
import { compareSessions, deriveNoiseFloor } from '../analysis/compareSessions.js';
import { renderComparisonMarkdown } from '../report/comparison.js';
import type { AnalysisReport } from '../report/model.js';
import { AnalysisPipeline } from '../pipeline/pipeline.js';
import { AUDIENCES, renderMarkdown } from '../report/markdown.js';
import { safeValidateReport } from '../report/model.js';
import { renderPrintableHtml } from '../report/html.js';
import { openInBrowser } from '../server/nativeDialog.js';
import { startServer } from '../server/server.js';
import { isPackagedExecutable } from '../server/uiAssets.js';

const log = createLogger('cli');
const program = new Command();

program
  .name('gdshield')
  .description('GD-PerformanceShield - Unity mobile memory risk analyzer')
  .version(TOOL_VERSION)
  .option('--log-level <level>', 'trace|debug|info|warn|error', 'info')
  .hook('preAction', (thisCommand) => {
    const level = thisCommand.opts()['logLevel'] as LogLevel;
    if (level) setLogLevel(level);
  });

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

program
  .command('devices')
  .description('List connected Android devices and their assigned A/B roles')
  .action(async () => {
    const config = loadConfig();
    const adb = new Adb(config.adbPath, log.child('adb'));
    try {
      const manager = new DeviceManager(adb, log);
      const devices = await manager.detect({ logger: log });
      console.log();
      for (const device of devices) {
        console.log(`  [${device.role}] ${describeDevice(device)}`);
        console.log(
          `       heap limit ${device.heapGrowthLimit ?? '?'}, /proc readable: ${device.procReadable}, ` +
            `free storage ${device.storageFreeBytes ? `${(device.storageFreeBytes / (1024 * MB)).toFixed(1)} GB` : '?'}`,
        );
      }
      console.log();
      console.log('  Role A = lowest RAM (OOM canary). Role B = highest RAM (headroom reference).');
      console.log();
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------------------
// inspect-apk
// ---------------------------------------------------------------------------

program
  .command('inspect-apk <apk>')
  .description('Inspect an APK without running a full analysis')
  .option('--json', 'Print the full inspection as JSON')
  .action(async (apkPath: string, opts: { json?: boolean }) => {
    try {
      const config = loadConfig();
      const info = await inspectApk({ apkPath, aapt2Path: config.aapt2Path, logger: log });
      if (opts.json) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      console.log();
      console.log(`  ${describeApk(info)}`);
      console.log(`  Launch component : ${info.launchComponent ?? 'unknown'}`);
      console.log(`  SDK              : min ${info.minSdkVersion ?? '?'}, target ${info.targetSdkVersion ?? '?'}`);
      console.log(`  Debuggable       : ${info.debuggable}   largeHeap: ${info.largeHeap}`);
      console.log(`  Unity data       : ${info.unity.dataFolder ?? 'not found'}`);
      console.log(`  Asset payload    : ${(info.unity.assetPayloadBytes / MB).toFixed(1)} MB uncompressed`);
      console.log();
      if (info.contents.largestEntries.length > 0) {
        console.log('  Largest entries:');
        for (const entry of info.contents.largestEntries.slice(0, 10)) {
          console.log(`    ${(entry.uncompressedBytes / MB).toFixed(1).padStart(8)} MB  ${entry.name}`);
        }
        console.log();
      }
      for (const warning of info.warnings) console.log(`  ! ${warning}`);
      console.log();
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------------------
// scan (static only)
// ---------------------------------------------------------------------------

program
  .command('scan')
  .description('Static analysis only - no devices required')
  .requiredOption('--name <name>', 'Game name')
  .option('--studio <studio>', 'Studio name')
  .option('--repo <url>', 'Git repository URL')
  .option('--branch <branch>', 'Branch to analyze')
  .option('--local <path>', 'Analyze an already-checked-out project directory')
  .option('--apk <path>', 'APK file to inspect alongside the project')
  .option('--apk-url <url>', 'APK download URL')
  .action(async (opts: Record<string, string>) => {
    try {
      const pipeline = new AnalysisPipeline({
        input: {
          gameName: opts['name'] ?? 'unknown',
          ...(opts['studio'] ? { studio: opts['studio'] } : {}),
          ...(opts['repo'] ? { repoUrl: opts['repo'] } : {}),
          ...(opts['branch'] ? { branch: opts['branch'] } : {}),
          ...(opts['apk'] ? { apkPath: opts['apk'] } : {}),
          ...(opts['apkUrl'] ? { apkUrl: opts['apkUrl'] } : {}),
        },
        staticOnly: true,
      });

      if (opts['local']) {
        // A local checkout skips the clone stage entirely.
        await runLocalScan(pipeline, opts['local']);
      } else {
        await pipeline.runIntakeAndStatic();
      }

      const report = await pipeline.finish();
      printReportSummary(report, pipeline);
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------------------
// analyze (full pipeline with interactive markers)
// ---------------------------------------------------------------------------

program
  .command('analyze')
  .description('Full analysis: intake, static scan, device capture, report')
  .requiredOption('--name <name>', 'Game name')
  .option('--studio <studio>', 'Studio name')
  .option('--repo <url>', 'Git repository URL')
  .option('--branch <branch>', 'Branch to analyze')
  .option('--apk <path>', 'APK file')
  .option('--apk-url <url>', 'APK download URL')
  .option('--device <serial...>', 'Restrict to these device serials')
  .option('--fresh-install', 'Uninstall any existing build first')
  .option(
    '--kill-background',
    'Close other apps before launching, so the peak is measured on a quiet phone',
  )
  .option('--fresh-state', 'Clear app data before launch (cold-launch test)')
  .option('--duration <seconds>', 'Run unattended for N seconds instead of prompting')
  .action(async (opts: Record<string, string | string[] | boolean>) => {
    const pipeline = new AnalysisPipeline({
      input: {
        gameName: String(opts['name']),
        ...(opts['studio'] ? { studio: String(opts['studio']) } : {}),
        ...(opts['repo'] ? { repoUrl: String(opts['repo']) } : {}),
        ...(opts['branch'] ? { branch: String(opts['branch']) } : {}),
        ...(opts['apk'] ? { apkPath: String(opts['apk']) } : {}),
        ...(opts['apkUrl'] ? { apkUrl: String(opts['apkUrl']) } : {}),
        ...(opts['device'] ? { deviceSerials: opts['device'] as string[] } : {}),
      },
      freshInstall: Boolean(opts['freshInstall']),
      killBackgroundApps: Boolean(opts['killBackground']),
      freshState: Boolean(opts['freshState']),
    });

    try {
      await pipeline.runIntakeAndStatic();
      const session = await pipeline.prepareCapture();

      const durationOpt = opts['duration'];
      if (durationOpt) {
        const seconds = Number(durationOpt);
        console.log(`\n  Capturing for ${seconds}s. Play the game now.\n`);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      } else {
        await interactiveMarkerLoop(session);
      }

      await pipeline.stopCapture();
      const report = await pipeline.finish();
      printReportSummary(report, pipeline);
    } catch (err) {
      await pipeline.dispose();
      fail(err);
    }
  });

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

program
  .command('gui', { isDefault: false })
  .description('Open the desktop console (starts the server and opens your browser)')
  .option('-p, --port <port>', 'Port to listen on')
  .option('--no-open', 'Start the server without opening a browser')
  .action(async (opts: { port?: string; open?: boolean }) => {
    try {
      const port = opts.port ? Number(opts.port) : loadConfig().port;
      await startServer(port);
      const url = `http://localhost:${port}`;

      if (opts.open !== false) {
        const opened = await openInBrowser(url, log);
        if (!opened) console.log(`
  Open ${url} in your browser.
`);
      }

      console.log();
      console.log(`  GD-PerformanceShield is running at ${url}`);
      console.log('  Leave this window open while you work. Press Ctrl+C to quit.');
      console.log();
    } catch (err) {
      fail(err);
    }
  });

program
  .command('serve')
  .description('Start the operator console (recommended for real sessions)')
  .option('-p, --port <port>', 'Port to listen on')
  .action(async (opts: { port?: string }) => {
    try {
      const port = opts.port ? Number(opts.port) : undefined;
      await startServer(port);
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------------------
// list / report
// ---------------------------------------------------------------------------

program
  .command('list')
  .description('List previous analyses')
  .action(() => {
    const jobs = listJobs(loadConfig(), 30);
    if (jobs.length === 0) {
      console.log('\n  No analyses found.\n');
      return;
    }
    console.log();
    for (const job of jobs) {
      console.log(
        `  ${job.analysisId.padEnd(46)} ${job.status.padEnd(18)} ${job.input.gameName}`,
      );
    }
    console.log();
  });

program
  .command('report <analysisId>')
  .description('Print or rewrite a stored report (regenerated from report.json)')
  .option('--json', 'Print the raw JSON instead')
  .option(
    '--write',
    'Rewrite every audience cut in place. Use after a tool update to bring an old ' +
      'report up to the current layout without re-running the analysis.',
  )
  .option('--html', 'With --write, also write the print-ready HTML for each cut')
  .action((analysisId: string, opts: { json?: boolean; write?: boolean; html?: boolean }) => {
    const job = findJob(analysisId, loadConfig());
    if (!job) fail(new Error(`No analysis found with id ${analysisId}`));

    const path = job!.workspace.file('reports', 'report.json');
    if (!existsSync(path)) fail(new Error(`No report exists for ${analysisId}`));

    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const validated = safeValidateReport(raw);
    if (!validated.ok) {
      log.warn('Stored report does not match the current schema', {
        errors: validated.errors?.slice(0, 3).join('; '),
      });
    }

    if (!opts.write) {
      console.log(opts.json ? JSON.stringify(raw, null, 2) : renderMarkdown(raw));
      return;
    }

    // Rewriting from report.json rather than re-running: the measurements are
    // already recorded and are not what changed, so re-measuring would risk
    // a different result for no reason.
    for (const profile of AUDIENCES) {
      const written = job!.workspace.writeText(
        'reports',
        profile.fileName,
        renderMarkdown(raw, profile.id),
      );
      console.log(`  ${written}`);

      if (opts.html) {
        const htmlName = profile.fileName.replace(/\.md$/, '.html');
        console.log(
          `  ${job!.workspace.writeText('reports', htmlName, renderPrintableHtml(raw, profile.id))}`,
        );
      }
    }
  });

program
  .command('compare <beforeId> <afterId>')
  .description('Compare two recorded gameplay sessions, joined by marked screen')
  .option(
    '--baseline <a,b>',
    'Two runs of the same build, used to measure run-to-run variance. Without one, ' +
      'every difference is reported at face value.',
  )
  .option(
    '--target-fps <before,after>',
    'The frame rate each run was aiming for. Per-session, because two runs with ' +
      'different targets cannot have their measured rates subtracted.',
  )
  .option('--json', 'Print the comparison as JSON instead of Markdown')
  .option('--fail-on-regression', 'Exit non-zero if any screen retains more than before (for CI)')
  .action(
    (
      beforeId: string,
      afterId: string,
      opts: {
        baseline?: string;
        targetFps?: string;
        json?: boolean;
        failOnRegression?: boolean;
      },
    ) => {
      const config = loadConfig();
      const before = loadStoredReport(beforeId, config);
      const after = loadStoredReport(afterId, config);

      let noiseFloor = null;
      if (opts.baseline) {
        const [oneId, twoId] = opts.baseline.split(',').map((s) => s.trim());
        if (!oneId || !twoId) {
          fail(new Error('--baseline takes two analysis ids separated by a comma'));
        }
        noiseFloor = deriveNoiseFloor(
          loadStoredReport(oneId!, config),
          loadStoredReport(twoId!, config),
        );
        if (!noiseFloor) {
          log.warn('The baseline pair shares no screen, so no noise floor could be measured');
        }
      }

      let targetFps: { before?: number; after?: number } | undefined;
      if (opts.targetFps) {
        const [x, y] = opts.targetFps.split(',').map((v) => Number(v.trim()));
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          fail(new Error('--target-fps takes two numbers separated by a comma, e.g. 30,60'));
        }
        targetFps = { before: x, after: y };
      }

      const comparison = compareSessions(before, after, { noiseFloor, ...(targetFps ? { targetFps } : {}) });
      console.log(
        opts.json ? JSON.stringify(comparison, null, 2) : renderComparisonMarkdown(comparison),
      );

      // CI wants a signal, not prose. A blocked comparison is also a failure:
      // it means the run under test was not comparable to its baseline.
      if (opts.failOnRegression) {
        if (comparison.blocked) process.exitCode = 2;
        else if (
          comparison.kills.direction === 'regressed' ||
          comparison.screens.some((s) => s.direction === 'regressed')
        ) {
          process.exitCode = 1;
        }
      }
    },
  );

program
  .command('route <analysisId>')
  .description('Print the marker route a past session took, for repeating it')
  .action((analysisId: string) => {
    const report = loadStoredReport(analysisId, loadConfig());
    const steps = (report.session?.timeline ?? []).filter((e) => e.source === 'operator');

    if (steps.length === 0) {
      console.log('That session recorded no operator markers, so there is no route to repeat.');
      return;
    }

    console.log(`Route from ${report.subject.gameName} ${report.subject.versionName ?? ''}`.trim());
    console.log('');
    steps.forEach((step, i) => {
      const at = new Date(step.elapsedMs).toISOString().slice(14, 19);
      console.log(`  ${String(i + 1).padStart(2)}. [${at}] ${step.label}`);
    });
  });

program
  .command('fps-check <packageName>')
  .description('Show which frame-rate strategies this device supports, and why')
  .option('--serial <serial>', 'Device to check, when more than one is attached')
  .action(async (packageName: string, opts: { serial?: string }) => {
    const config = loadConfig();
    const adb = new Adb(config.adbPath, log.child('adb'));
    const manager = new DeviceManager(adb, log.child('devices'));
    const devices = await manager.detect({
      ...(opts.serial ? { onlySerials: [opts.serial] } : {}),
      logger: log.child('devices'),
    });

    if (devices.length === 0) fail(new Error('No usable device is connected.'));

    for (const device of devices[0] ? devices : []) {
      const adbDevice = adb.device(device.serial);
      console.log('');
      console.log(
        `${device.manufacturer} ${device.model} · Android ${device.androidVersion} · ${device.serial}`,
      );
      console.log('-'.repeat(64));

      const pid = await adbDevice.getPid(packageName);
      if (pid === null) {
        console.log(`  ${packageName} is not running. Launch it first: the layer only exists`);
        console.log('  while the game is on screen, and frame rate cannot be measured without it.');
        continue;
      }
      console.log(`  ${packageName} is running as pid ${pid}`);
      console.log('');

      const sampler = new FpsSampler(adbDevice, packageName, log.child('fps'));
      const source = await sampler.prepare();

      for (const attempt of sampler.diagnostics) {
        console.log(`  ${attempt.ok ? 'WORKS  ' : 'no     '}${attempt.strategy}`);
        console.log(`          ${attempt.detail}`);
      }

      if (!source) {
        console.log('');
        console.log('  No strategy works on this device, so frame rate cannot be reported.');
        continue;
      }

      // One reading proves the whole path, not just availability.
      console.log('');
      console.log(`  Selected: ${source}. Taking two readings five seconds apart...`);
      await sampler.sample();
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const reading = await sampler.sample();

      if (reading) {
        console.log(
          `  ${reading.fps} fps over ${(reading.windowMs / 1000).toFixed(1)}s ` +
            `(${reading.frameCount} frames` +
            (reading.jankPercent !== null ? `, ${reading.jankPercent}% dropped` : '') +
            ')',
        );
      } else {
        console.log('  The strategy is available but returned no frames. Is the game on screen');
        console.log('  and drawing? A game sitting on a static screen may present nothing.');
      }

      await sampler.release();
    }
  });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Load a finished report, or exit saying which id had none. */
function loadStoredReport(analysisId: string, config = loadConfig()): AnalysisReport {
  const job = findJob(analysisId, config);
  if (!job) fail(new Error(`No analysis found with id ${analysisId}`));

  const path = job!.workspace.file('reports', 'report.json');
  if (!existsSync(path)) fail(new Error(`No report exists for ${analysisId}`));

  return JSON.parse(readFileSync(path, 'utf8')) as AnalysisReport;
}


/**
 * Terminal marker prompt.
 *
 * A minimal stand-in for the operator UI, useful when profiling over SSH or in
 * a script. The browser console is the better experience for a real session.
 */
async function interactiveMarkerLoop(session: {
  mark: (type: string, opts?: { label?: string }) => unknown;
  status: () => { devices: Array<{ role: string; lastPssBytes: number | null; alive: boolean }> };
}): Promise<void> {
  console.log('\n  Capture running. Press a key then Enter to mark an event:\n');
  for (const marker of MARKERS) {
    console.log(`    ${marker.hotkey ?? ' '}  ${marker.label.padEnd(16)} ${marker.description.slice(0, 70)}`);
  }
  console.log('    q  Finish and generate the report\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const statusTimer = setInterval(() => {
    const status = session.status();
    const line = status.devices
      .map(
        (d) =>
          `${d.role}: ${d.lastPssBytes !== null ? `${(d.lastPssBytes / MB).toFixed(0)} MB` : '...'}${d.alive ? '' : ' [DEAD]'}`,
      )
      .join('   ');
    process.stdout.write(`\r  ${line}${' '.repeat(20)}`);
  }, 2000);

  await new Promise<void>((resolve) => {
    rl.on('line', (input) => {
      const key = input.trim().toLowerCase();
      if (key === 'q') {
        rl.close();
        return;
      }
      const marker = MARKERS.find((m) => m.hotkey === key);
      if (!marker) {
        console.log('  Unknown key.');
        return;
      }
      if (marker.type === 'custom') {
        rl.question('  Label: ', (label) => {
          session.mark('custom', { label });
          console.log(`  Marked: ${label}`);
        });
        return;
      }
      session.mark(marker.type);
      console.log(`  Marked: ${marker.label}`);
    });
    rl.on('close', () => {
      clearInterval(statusTimer);
      console.log();
      resolve();
    });
  });
}

/** Run static analysis against a directory that is already on disk. */
async function runLocalScan(pipeline: AnalysisPipeline, localPath: string): Promise<void> {
  if (!existsSync(localPath)) throw new Error(`Path does not exist: ${localPath}`);
  await pipeline.runLocalIntakeAndStatic(localPath);
}

function printReportSummary(
  report: { verdict: { headline: string; combinedRisk: { value: number; band: string } }; priority: Array<{ rank: number; finding: { title: string; severity: string } }> },
  pipeline: AnalysisPipeline,
): void {
  console.log();
  console.log('  ' + '─'.repeat(72));
  console.log(`  ${report.verdict.headline}`);
  console.log('  ' + '─'.repeat(72));
  console.log();
  for (const item of report.priority.slice(0, 8)) {
    console.log(`  ${String(item.rank).padStart(2)}. [${item.finding.severity.toUpperCase().padEnd(8)}] ${item.finding.title}`);
  }
  console.log();
  console.log(`  JSON     : ${pipeline.state.reportPaths.json}`);
  console.log(`  Markdown : ${pipeline.state.reportPaths.markdown}`);
  console.log();
}

function fail(err: unknown): never {
  console.error(`\n  Error: ${describeError(err)}\n`);
  process.exit(1);
}

// Double-clicking the executable passes no arguments. Printing a help screen
// into a console window that closes immediately would be useless, so the
// packaged build opens the console instead.
const argv = process.argv.slice(2).length === 0 && isPackagedExecutable()
  ? [...process.argv, 'gui']
  : process.argv;

program.parseAsync(argv).catch((err) => fail(err));
