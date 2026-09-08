/**
 * Operator UI + API server.
 *
 * The operator drives one analysis from here: start it, watch memory live on
 * both devices, press markers as they play, then stop and get the report. The
 * API is thin - all behaviour lives in the pipeline, so the CLI and the UI
 * cannot drift apart.
 */
import { existsSync, readFileSync } from 'node:fs';

import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import { loadConfig } from '../core/config.js';
import { describeError } from '../core/errors.js';
import { env } from '../core/env.js';
import { findJob, listJobs } from '../core/job.js';
import { createLogger } from '../core/logger.js';
import { Adb } from '../devices/adb.js';
import { DeviceManager } from '../devices/deviceManager.js';
import { listInstalledApps, resolveLaunchComponent } from '../devices/installedApps.js';
import { resolveAppLabels } from '../devices/appLabel.js';
import { AppController } from '../devices/appController.js';
import { MARKERS } from '../events/markers.js';
import { probeUnityProject } from '../intake/unityProject.js';
import { AnalysisPipeline } from '../pipeline/pipeline.js';
import type { AnalysisReport } from '../report/model.js';
import { renderPrintableHtml } from '../report/html.js';
import { buildSnapshot } from '../report/snapshot.js';
import { AUDIENCES, type ReportAudience } from '../report/markdown.js';
import { budgetForDevice, budgetTable } from '../analysis/memoryBudget.js';
import {
  compareSessions,
  deriveNoiseFloor,
  type NoiseFloor,
} from '../analysis/compareSessions.js';
import { renderComparisonMarkdown } from '../report/comparison.js';
import { renderComparisonHtml } from '../report/comparisonHtml.js';
import { pickPath, revealInFileManager } from './nativeDialog.js';
import { isPackagedExecutable, readUiAsset, uiAvailable, UI_FILES } from './uiAssets.js';

const log = createLogger('server');

/** Live pipelines, keyed by analysis id. One per in-flight analysis. */
const pipelines = new Map<string, AnalysisPipeline>();

const createAnalysisSchema = z.object({
  gameName: z.string().min(1),
  studio: z.string().optional(),
  packageName: z.string().optional(),
  projectPath: z.string().optional(),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  apkPath: z.string().optional(),
  apkUrl: z.string().optional(),
  deviceSerials: z.array(z.string()).optional(),
  notes: z.string().optional(),
  freshInstall: z.boolean().optional(),
  killBackgroundApps: z.boolean().optional(),
  freshState: z.boolean().optional(),
  staticOnly: z.boolean().optional(),
});

const appLabelsSchema = z.object({
  apps: z
    .array(z.object({ packageName: z.string().min(1), apkPath: z.string().min(1) }))
    .max(40),
});

const launchSchema = z.object({
  packageName: z.string().min(1),
});

const pickSchema = z.object({
  target: z.enum(['project', 'apk']),
});

const projectProbeSchema = z.object({
  path: z.string(),
});

const compareSchema = z.object({
  beforeId: z.string().min(1),
  afterId: z.string().min(1),
  /** Two runs of the same build, used to measure run-to-run variance. */
  baselineIds: z.array(z.string().min(1)).length(2).optional(),
  /**
   * The frame rate each run was aiming for. Per-session, because a 30 fps build
   * and a 60 fps build produce measured rates that cannot be subtracted.
   */
  targetFpsBefore: z.number().positive().max(240).optional(),
  targetFpsAfter: z.number().positive().max(240).optional(),
});

const markSchema = z.object({
  type: z.string().min(1),
  label: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});

export async function createServer(): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  await app.register(websocket);

  // The console is three static files, served explicitly rather than through
  // @fastify/static so the same code path works when they are embedded in a
  // single executable and there is no directory to serve from.
  if (uiAvailable()) {
    app.get('/', async (_req, reply) => sendUiAsset(reply, 'index.html'));
    for (const file of UI_FILES) {
      app.get(`/${file}`, async (_req, reply) => sendUiAsset(reply, file));
    }
  } else {
    log.warn('Operator console assets not found; running in API-only mode');
  }

  // ---- Reference data -----------------------------------------------------

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0',
    adbPath: config.adbPath,
    aapt2: config.aapt2Path ? 'available' : 'not found (using built-in manifest parser)',
    workspaceRoot: config.workspaceRoot,
    packaging: isPackagedExecutable() ? 'single-executable' : 'node',
    console: uiAvailable() ? 'available' : 'api-only',
  }));

  app.get('/api/markers', async () => MARKERS);

  /** The per-app memory budget table, so the console shows the same rubric. */
  app.get('/api/budget-table', async () => budgetTable());

  app.get('/api/devices', async (_req, reply) => {
    try {
      const adb = new Adb(config.adbPath, log.child('adb'));
      const manager = new DeviceManager(adb, log.child('devices'));
      const devices = await manager.detect({ logger: log.child('devices') });
      // Attach the per-app budget so the console can show the target and limit
      // beside the device RAM without duplicating the tier table.
      return devices.map((d) => ({ ...d, budget: budgetForDevice(d.totalRamBytes) }));
    } catch (err) {
      return reply.status(200).send({ error: describeError(err), devices: [] });
    }
  });

  /**
   * Apps installed on a device.
   *
   * This is how a live analysis normally starts: the build under test is already
   * on the device, so the operator picks it from a list rather than locating its
   * APK. System apps are excluded.
   */
  app.get('/api/devices/:serial/apps', async (req, reply) => {
    const { serial } = req.params as { serial: string };
    try {
      const adb = new Adb(config.adbPath, log.child('adb'));
      const apps = await listInstalledApps(adb.device(serial), { logger: log.child('apps') });
      return { serial, apps };
    } catch (err) {
      return reply.status(200).send({ serial, apps: [], error: describeError(err) });
    }
  });

  /**
   * Launch an installed app on the device, before any analysis starts.
   *
   * Lets the operator confirm they picked the right game - and get it past a
   * splash screen or login - without the tool having to guess. Independent of the
   * capture session, which launches the app itself when recording begins.
   */
  app.post('/api/devices/:serial/launch', async (req, reply) => {
    const { serial } = req.params as { serial: string };
    const parsed = launchSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'A package name is required.' });

    try {
      const adb = new Adb(config.adbPath, log.child('adb'));
      const device = adb.device(serial);
      const controller = new AppController(device, log.child('launch'));

      const launchComponent = await resolveLaunchComponent(device, parsed.data.packageName);
      const result = await controller.launch({
        packageName: parsed.data.packageName,
        ...(launchComponent ? { launchComponent } : {}),
        freshState: false,
      });

      return { ok: true, pid: result.pid, launchComponent };
    } catch (err) {
      return reply.status(400).send({ error: describeError(err) });
    }
  });

  /**
   * Resolve the display names shown under app icons.
   *
   * An app's real name lives in its APK resource table, not anywhere adb will
   * report - so this reads the few hundred kilobytes it needs off the device per
   * app. Requested for the rows on screen rather than the whole list, because
   * each one is several device round trips.
   */
  app.post('/api/devices/:serial/app-labels', async (req, reply) => {
    const { serial } = req.params as { serial: string };
    const parsed = appLabelsSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request' });

    try {
      const adb = new Adb(config.adbPath, log.child('adb'));
      const labels = await resolveAppLabels(adb.device(serial), parsed.data.apps, {
        logger: log.child('labels'),
      });
      return { labels: Object.fromEntries(labels) };
    } catch (err) {
      // A missing display name must never break the app list.
      return reply.status(200).send({ labels: {}, error: describeError(err) });
    }
  });

  app.get('/api/jobs', async () => listJobs(config, 50));

  /**
   * Past runs that carry a finished report, which is what a comparison or a
   * repeat needs. A job that never got to a report has nothing to offer either.
   */
  app.get('/api/sessions', async () => {
    const out = [];
    for (const meta of listJobs(config, 200)) {
      const report = loadReport(meta.analysisId);
      if (!report?.session) continue;
      const device = report.devices[0];
      out.push({
        analysisId: meta.analysisId,
        gameName: report.subject.gameName,
        packageName: report.subject.packageName,
        versionName: report.subject.versionName,
        generatedAt: report.generatedAt,
        // When the game was actually played, which is what distinguishes two
        // runs recorded on the same afternoon.
        startedAt: report.session.startedAtLocal ?? report.session.startedAt,
        device: device ? `${device.manufacturer} ${device.model}` : null,
        serial: device?.serial ?? null,
        androidVersion: device?.androidVersion ?? null,
        durationMs: report.session.durationMs,
        markerCount: report.session.markerCount,
        screens: [...new Set(report.session.screenVisits.map((v) => v.screen))],
        peakBytes: device?.peakBytes ?? null,
        averageFps: device?.fps?.averageFps ?? null,
        budgetVerdict: device?.budget?.verdict ?? null,
        processDeaths: device?.processDeaths ?? 0,
      });
    }
    return out;
  });

  /**
   * The marker route a past session took, for repeat mode.
   *
   * Operator markers only, in the order they were pressed. System events are
   * excluded: a kill notice is something that happened *to* the run, not a step
   * the tester can choose to repeat.
   */
  app.get('/api/sessions/:id/route', async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = loadReport(id);
    if (!report?.session) return reply.status(404).send({ error: 'No recorded session for that id' });

    const steps = report.session.timeline
      .filter((e) => e.source === 'operator')
      .map((e, index) => ({ index, label: e.label, type: e.type, elapsedMs: e.elapsedMs }));

    return {
      analysisId: id,
      gameName: report.subject.gameName,
      versionName: report.subject.versionName,
      durationMs: report.session.durationMs,
      steps,
    };
  });

  /**
   * Compare two recorded sessions.
   *
   * `baseline` names a second pair of same-build runs whose disagreement
   * measures run-to-run variance; without one the comparison says so rather than
   * quietly treating every difference as real.
   */
  app.post('/api/compare', async (req, reply) => {
    const parsed = compareSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid comparison request' });

    const { beforeId, afterId, baselineIds } = parsed.data;

    const before = loadReport(beforeId);
    const after = loadReport(afterId);
    if (!before?.session) return reply.status(404).send({ error: `No recorded session for ${beforeId}` });
    if (!after?.session) return reply.status(404).send({ error: `No recorded session for ${afterId}` });

    let noiseFloor: NoiseFloor | null = null;
    if (baselineIds && baselineIds.length === 2) {
      const one = loadReport(baselineIds[0]!);
      const two = loadReport(baselineIds[1]!);
      if (one && two) noiseFloor = deriveNoiseFloor(one, two);
    }

    const comparison = compareSessions(before, after, {
      noiseFloor,
      targetFps: {
        before: parsed.data.targetFpsBefore ?? null,
        after: parsed.data.targetFpsAfter ?? null,
      },
    });
    return { comparison, markdown: renderComparisonMarkdown(comparison) };
  });

  /**
   * The comparison as a print-ready page.
   *
   * Served rather than returned as a string because the desktop app prints it
   * with Chromium's own engine, which needs a URL to load. Ids travel in the
   * query string so the page can be opened directly in a browser too.
   */
  app.get('/api/compare.html', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const parsed = compareSchema.safeParse({
      beforeId: q.before,
      afterId: q.after,
      ...(q.baseline ? { baselineIds: q.baseline.split(',').slice(0, 2) } : {}),
      ...(q.targetBefore ? { targetFpsBefore: Number(q.targetBefore) } : {}),
      ...(q.targetAfter ? { targetFpsAfter: Number(q.targetAfter) } : {}),
    });
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid comparison request' });

    const before = loadReport(parsed.data.beforeId);
    const after = loadReport(parsed.data.afterId);
    if (!before?.session || !after?.session) {
      return reply.status(404).send({ error: 'One of those runs has no recorded session' });
    }

    let noiseFloor: NoiseFloor | null = null;
    const ids = parsed.data.baselineIds;
    if (ids && ids.length === 2) {
      const one = loadReport(ids[0]!);
      const two = loadReport(ids[1]!);
      if (one && two) noiseFloor = deriveNoiseFloor(one, two);
    }

    const comparison = compareSessions(before, after, {
      noiseFloor,
      targetFps: {
        before: parsed.data.targetFpsBefore ?? null,
        after: parsed.data.targetFpsAfter ?? null,
      },
    });
    return reply
      .type('text/html; charset=utf-8')
      .send(renderComparisonHtml(comparison, { autoPrint: q.print === '1' }));
  });

  /** Read a finished report off disk, or null if the run never produced one. */
  function loadReport(analysisId: string): AnalysisReport | null {
    try {
      const job = findJob(analysisId, config);
      if (!job) return null;
      return job.workspace.readJson<AnalysisReport>('reports', 'report.json');
    } catch {
      return null;
    }
  }

  /**
   * Native file/folder picker.
   *
   * A browser cannot hand the server a real filesystem path, and a Unity project
   * is far too large to upload - so the local server opens the operating
   * system's own dialog and returns the path the operator chose.
   */
  app.post('/api/pick', async (req, reply) => {
    const parsed = pickSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid pick request' });

    const { target } = parsed.data;
    const result = await pickPath({
      kind: target === 'project' ? 'folder' : 'file',
      title:
        target === 'project'
          ? 'Select the Unity project folder'
          : 'Select the APK to analyze',
      ...(target === 'apk'
        ? { filters: [{ name: 'Android package', extensions: ['apk'] }] }
        : {}),
      logger: log.child('pick'),
    });

    return result;
  });

  /**
   * Is the folder the operator typed actually a Unity project?
   *
   * The console asks this as they type, so it must stay cheap - hence the probe
   * rather than the full validation, which counts every asset in the project.
   */
  app.post('/api/project/probe', async (req, reply) => {
    const parsed = projectProbeSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid probe request' });

    try {
      return probeUnityProject(parsed.data.path);
    } catch (err) {
      // A probe must never be the thing that breaks the console.
      return reply.status(200).send({
        valid: false,
        reason: describeError(err),
        unityVersion: null,
        scriptingBackend: null,
        productName: null,
        sceneCount: 0,
        usesAddressables: false,
        hasPackages: false,
      });
    }
  });

  // ---- Analysis lifecycle -------------------------------------------------

  app.post('/api/analysis', async (req, reply) => {
    const parsed = createAnalysisSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const body = parsed.data;

    if (!body.projectPath && !body.repoUrl && !body.apkPath && !body.apkUrl && !body.packageName) {
      return reply.status(400).send({
        error:
          'Supply at least a Unity project folder, a repository URL, an APK, or an app installed ' +
          'on the device.',
      });
    }

    // Fail fast on a mistyped path rather than surfacing it minutes later as a
    // skipped stage the operator has to go looking for.
    for (const [label, path] of [
      ['Unity project folder', body.projectPath],
      ['APK file', body.apkPath],
    ] as const) {
      if (path && !existsSync(path)) {
        return reply.status(400).send({ error: `${label} does not exist: ${path}` });
      }
    }

    const pipeline = new AnalysisPipeline({
      input: {
        gameName: body.gameName,
        ...(body.studio ? { studio: body.studio } : {}),
        ...(body.packageName ? { packageName: body.packageName } : {}),
        ...(body.projectPath ? { projectPath: body.projectPath } : {}),
        ...(body.repoUrl ? { repoUrl: body.repoUrl } : {}),
        ...(body.branch ? { branch: body.branch } : {}),
        ...(body.apkPath ? { apkPath: body.apkPath } : {}),
        ...(body.apkUrl ? { apkUrl: body.apkUrl } : {}),
        ...(body.deviceSerials ? { deviceSerials: body.deviceSerials } : {}),
        ...(body.notes ? { notes: body.notes } : {}),
      },
      config,
      ...(body.staticOnly !== undefined ? { staticOnly: body.staticOnly } : {}),
      ...(body.freshInstall !== undefined ? { freshInstall: body.freshInstall } : {}),
      ...(body.killBackgroundApps !== undefined
        ? { killBackgroundApps: body.killBackgroundApps }
        : {}),
      ...(body.freshState !== undefined ? { freshState: body.freshState } : {}),
    });

    pipelines.set(pipeline.job.id, pipeline);

    // Intake and static analysis take minutes; run them in the background and
    // let the UI follow progress over the websocket.
    void pipeline
      .runIntakeAndStatic()
      .then(async () => {
        // A static-only run has nothing to wait for, so produce the report
        // immediately rather than making the operator ask for it.
        if (body.staticOnly) {
          await pipeline.finish();
        } else {
          pipeline.job.setStatus('awaiting_gameplay');
        }
      })
      .catch((err) => {
        log.error('Analysis failed', { analysisId: pipeline.job.id, error: describeError(err) });
        pipeline.job.setStatus('failed', describeError(err));
      });

    return reply.status(201).send({ analysisId: pipeline.job.id, gameId: pipeline.job.gameId });
  });

  app.get('/api/analysis/:id', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    if (!pipeline) return reply.status(404).send({ error: 'Unknown analysis id' });

    const state = pipeline.state;
    return {
      job: pipeline.job.meta,
      apk: state.apk
        ? {
            packageName: state.apk.packageName,
            versionName: state.apk.versionName,
            unityVersion: state.apk.unity.engineVersion,
            scriptingBackend: state.apk.unity.scriptingBackend,
            abis: state.apk.abis,
            sizeBytes: state.apk.sizeBytes,
            launchComponent: state.apk.launchComponent,
            warnings: state.apk.warnings,
          }
        : null,
      project: state.project
        ? {
            unityVersion: state.project.unityVersion,
            buildScenes: state.project.buildScenes.length,
            usesAddressables: state.project.usesAddressables,
            warnings: state.project.warnings,
          }
        : null,
      staticFindings: state.staticResult?.findings.length ?? 0,
      devices: state.devices,
      session: state.session?.status() ?? null,
      reportPaths: state.reportPaths,
    };
  });

  app.post('/api/analysis/:id/capture/start', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    if (!pipeline) return reply.status(404).send({ error: 'Unknown analysis id' });
    try {
      const session = await pipeline.prepareCapture();
      return { sessionId: session.sessionId, status: session.status() };
    } catch (err) {
      return reply.status(400).send({ error: describeError(err) });
    }
  });

  app.post('/api/analysis/:id/mark', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    if (!pipeline?.captureSession) {
      return reply.status(400).send({ error: 'No capture session is running' });
    }
    const parsed = markSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid marker' });

    const event = pipeline.captureSession.mark(parsed.data.type, {
      source: 'operator',
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
      ...(parsed.data.data ? { data: parsed.data.data } : {}),
    });
    return event;
  });

  app.post('/api/analysis/:id/capture/stop', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    if (!pipeline) return reply.status(404).send({ error: 'Unknown analysis id' });
    await pipeline.stopCapture();
    return { ok: true };
  });

  /**
   * Abandon a run and release everything it holds.
   *
   * Reloading the console is not enough on its own: the samplers, the logcat
   * readers, the profiler port forward and SurfaceFlinger's frame collection all
   * live on the server and the device, and a reload would leave them running
   * against a session nobody is watching. This stops them and drops the
   * pipeline.
   *
   * Artifacts already written stay on disk. A finished report is still worth
   * comparing against later, and this is a reset of the console rather than a
   * delete of past work.
   */
  app.post('/api/analysis/:id/abandon', async (req, reply) => {
    const { id } = req.params as { id: string };
    const pipeline = pipelines.get(id);

    // Already gone is the desired end state, so it is a success, not a 404.
    if (!pipeline) return { abandoned: false, alreadyGone: true };

    try {
      // Closes the capture session, which releases the frame-rate collection
      // and the Unity profiler forward.
      await pipeline.stopCapture();
    } catch (err) {
      log.warn('Could not cleanly stop the session while abandoning it', {
        analysisId: id,
        error: describeError(err),
      });
    }

    pipelines.delete(id);
    log.info('Analysis abandoned and released', { analysisId: id });
    return { abandoned: true, alreadyGone: false };
  });

  app.post('/api/analysis/:id/finish', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    if (!pipeline) return reply.status(404).send({ error: 'Unknown analysis id' });
    try {
      await pipeline.stopCapture();
      const report = await pipeline.finish();
      return {
        report,
        paths: pipeline.state.reportPaths,
      };
    } catch (err) {
      return reply.status(500).send({ error: describeError(err) });
    }
  });

  app.get('/api/analysis/:id/report', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    const path = pipeline?.state.reportPaths.json;
    if (!path || !existsSync(path)) {
      return reply.status(404).send({ error: 'No report has been generated yet' });
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  });

  app.get('/api/analysis/:id/report.md', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    const paths = pipeline?.state.reportPaths;
    if (!paths) return reply.status(404).send({ error: 'Unknown analysis id' });

    const requested = (req.query as { audience?: string }).audience ?? 'complete';
    const path = paths.byAudience?.[requested] ?? paths.markdown;
    if (!path || !existsSync(path)) {
      return reply.status(404).send({ error: 'No report has been generated yet' });
    }
    return reply.type('text/markdown; charset=utf-8').send(readFileSync(path, 'utf8'));
  });

  /**
   * Print-ready HTML for one audience cut - the source Electron turns into a
   * PDF, and the page a plain browser prints from.
   *
   * `?print=1` makes the page open its own print dialog, which is the fallback
   * when there is no desktop app to drive Chromium directly.
   */
  app.get('/api/analysis/:id/report.html', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    const report = pipeline?.state.report ?? loadStoredReport(pipeline);
    if (!report) {
      return reply.status(404).send({ error: 'No report has been generated yet' });
    }

    const query = req.query as { audience?: string; print?: string };
    const audience = (AUDIENCES.find((a) => a.id === query.audience)?.id ??
      'complete') as ReportAudience;

    return reply
      .type('text/html; charset=utf-8')
      .send(renderPrintableHtml(report, audience, { autoPrint: query.print === '1' }));
  });

  /**
   * The summary snapshot, as data.
   *
   * The console draws the summary itself rather than embedding the printed page,
   * and the figures on it - the ratings, the biggest issue, the bottom line -
   * are derived, not stored. Serving the derivation means the browser never
   * reimplements it: a threshold that moves in `snapshot.ts` moves in the
   * console, the Markdown cut and the PDF at the same time.
   */
  app.get('/api/analysis/:id/summary', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    const report = pipeline?.state.report ?? loadStoredReport(pipeline);
    if (!report) {
      return reply.status(404).send({ error: 'No report has been generated yet' });
    }
    return buildSnapshot(report);
  });

  /** The audience cuts the console offers, so the UI does not hardcode them. */
  app.get('/api/audiences', async () => AUDIENCES);

  /** Open the report's folder in the operator's file manager. */
  app.post('/api/analysis/:id/reveal', async (req, reply) => {
    const pipeline = pipelines.get((req.params as { id: string }).id);
    const target = pipeline?.state.reportPaths.markdown ?? pipeline?.job.workspace.root;
    if (!target) return reply.status(404).send({ error: 'Nothing to reveal yet' });
    const ok = await revealInFileManager(target, log);
    return { ok, path: target };
  });

  // ---- Live stream --------------------------------------------------------

  app.get('/api/stream', { websocket: true }, (socket, req) => {
    const analysisId = (req.query as { analysis?: string }).analysis;
    const pipeline = analysisId ? pipelines.get(analysisId) : null;

    if (!pipeline) {
      socket.send(JSON.stringify({ type: 'error', message: 'Unknown analysis id' }));
      socket.close();
      return;
    }

    const send = (type: string, payload: unknown) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type, payload }));
      }
    };

    send('job', pipeline.job.meta);

    const unsubscribeJob = pipeline.job.onChange((meta) => send('job', meta));

    // The capture session may not exist yet when the socket opens, so poll
    // briefly for it rather than requiring the client to reconnect.
    let attached: (() => void) | null = null;
    const attach = () => {
      const session = pipeline.captureSession;
      if (!session || attached) return;

      const onSample = (s: unknown) => send('sample', s);
      const onEvent = (e: unknown) => send('event', e);
      const onLog = (l: unknown) => send('log', l);
      const onStatus = (s: unknown) => send('status', s);

      session.on('sample', onSample);
      session.on('event', onEvent);
      session.on('log', onLog);
      session.on('status', onStatus);

      attached = () => {
        session.off('sample', onSample);
        session.off('event', onEvent);
        session.off('log', onLog);
        session.off('status', onStatus);
      };
      send('session', session.status());
    };

    attach();
    const attachTimer = setInterval(attach, 1000);

    socket.on('close', () => {
      clearInterval(attachTimer);
      unsubscribeJob();
      attached?.();
    });
  });

  return app;
}

export async function startServer(port?: number, host?: string): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = await createServer();
  const listenPort = port ?? config.port;

  /**
   * Loopback by default, for two reasons.
   *
   * Security: this API lists analyses, serves reports, starts runs and opens
   * native file dialogs on this machine. On 0.0.0.0 every one of those is
   * reachable by anyone on the same network, with no authentication.
   *
   * Speed: the address is also literal IPv4. Binding 0.0.0.0 listens on IPv4
   * only, while `localhost` on Windows resolves to ::1 first - so every request
   * spent ~2 seconds failing over IPv6 before retrying IPv4.
   *
   * Set GDPS_HOST=0.0.0.0 to expose it deliberately (an operator driving the
   * console from another machine).
   */
  const listenHost = host ?? env('HOST') ?? '127.0.0.1';
  await app.listen({ port: listenPort, host: listenHost });
  log.info(`Operator UI ready at http://${listenHost}:${listenPort}`);
  return app;
}

/**
 * Read a finished report back from disk.
 *
 * The in-memory copy is the fast path; this covers the case where the report
 * was written but the pipeline object no longer holds it.
 */
function loadStoredReport(pipeline: AnalysisPipeline | null | undefined): AnalysisReport | null {
  const path = pipeline?.state.reportPaths.json;
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AnalysisReport;
  } catch {
    return null;
  }
}

/** Send one console asset, from disk or from the embedded blob. */
function sendUiAsset(reply: FastifyReply, name: string): FastifyReply {
  const asset = readUiAsset(name);
  if (!asset) return reply.status(404).send({ error: `Unknown asset: ${name}` });
  return reply.type(asset.contentType).send(asset.body);
}
