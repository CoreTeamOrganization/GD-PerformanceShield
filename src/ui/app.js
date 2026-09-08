/**
 * GD-PerformanceShield desktop console.
 *
 * Dependency-free by design: this runs on a test bench that may be offline, so
 * there is no bundler and no CDN. The chart is drawn directly on a canvas, which
 * is also what lets it keep up with two devices sampling at 1 Hz for a long
 * session without a charting library retaining every point twice.
 *
 * File paths come from the *server's* native dialogs rather than from a browser
 * file input, because a browser deliberately hides the real path and a Unity
 * project is far too large to upload.
 */

const MB = 1024 * 1024;

/** Device colours come from the theme so they stay legible in light and dark. */
function roleColor(role) {
  if (role === 'A') return themeColor('--device-a', '#f0883e');
  if (role === 'B') return themeColor('--device-b', '#58a6ff');
  return themeColor('--muted', '#8b98a5');
}

import { chooseGameName, chooseSubmittedName } from './naming.js';

/**
 * Features built but not currently exposed.
 *
 * Mirrors `FEATURES` in src/core/features.ts, which is the source of truth and
 * carries the reasoning. Duplicated rather than imported because that is
 * TypeScript compiled for the server and this is plain JavaScript the browser
 * loads directly - the same arrangement as the percentile formula. Both have to
 * be flipped together.
 */
const FEATURES = {
  projectAnalysis: false,
};

const state = {
  analysisId: null,
  socket: null,
  markers: [],
  events: [],
  sessionStart: null,
  capturing: false,
  /** Derived from the inputs, not chosen: see derivedMode(). */
  mode: 'apk',
  /** Serial of the device the game is read from and launched on. */
  deviceSerial: '',
  /**
   * Whether the comparison panel is open.
   *
   * The panel and the offer that opens it are the two states of one thing, so
   * this decides which is on screen. Starts closed: a fresh console shows the
   * offer, not the form.
   */
  compareOpen: false,
  /**
   * The title we last filled in ourselves.
   *
   * Needed to tell our own text from the operator's. The title field was only
   * ever filled when empty, to avoid overwriting a name someone had typed - but
   * that also meant a name *we* had filled in from a previous choice survived
   * changing the app. Selecting "Wedding Rush Draw Puzzle" and then switching to
   * `com.gdm.prison.guard` filed the session, its report and its folder under
   * the wedding game, which is worse than leaving it blank: a wrong name looks
   * like a real one.
   */
  autofilledName: '',
  /** Result of /api/project/probe, or null when no folder is given. */
  project: null,
  /** Path currently being probed, so a stale reply can be dropped. */
  projectProbing: '',
  apps: [],
  /** Apps matching the current search. */
  filtered: [],
  selectedPackage: '',
  listOpen: false,
  /** packageName -> resolved display name (null while in flight) */
  labels: new Map(),
  devices: [],
  view: 'breakdown',
  /** role -> { line: [...], stacks: [...] } */
  byRole: new Map(),
  /** role -> hover x, in canvas pixels */
  hover: new Map(),
  /** role -> the most recent live status for that device */
  liveByRole: new Map(),
  /**
   * The frame-rate series per role, accumulated as the session runs.
   *
   * The status stream carries one current figure per device, not a history, so
   * the chart's data has to be kept here. Without it the frame rate was a
   * number in the corner of the panel: a stutter had to be caught as it went
   * past, and there was nothing to click afterwards.
   */
  fpsByRole: new Map(),
  /** Which lettered frame-rate drop is open, per role. */
  selectedFpsEvent: new Map(),
  /**
   * The memory step behind the open frame-rate moment, per role.
   *
   * Held so the breakdown can be re-rendered when a category is opened without
   * re-deriving which two samples the step ran between - the same reason the
   * memory panel keeps its own selected event.
   */
  fpsMemoryStep: new Map(),
  /** Which category is expanded in the frame-rate panel, per role. */
  fpsExpandedCategory: new Map(),
  /** Which mapping row is expanded inside that category, per role. */
  fpsExpandedRow: new Map(),
  /** Hover position over the frame-rate canvas, per role. */
  fpsHover: new Map(),
  /** Last cumulative jank count seen, so per-sample deltas can be derived. */
  janksSeenByRole: new Map(),
  panels: new Map(),
  /** role -> detected memory events */
  memoryEvents: new Map(),
  /** role -> the event whose details are open */
  selectedEvent: new Map(),
  /** role -> which category inside that event is expanded */
  expandedCategory: new Map(),
  /** role -> which row inside that category is expanded */
  expandedRow: new Map(),
  /** Elapsed ms at which capture ended, so the axis stops growing. */
  captureEndedMs: null,
  /** Guards the automatic launch so it fires once per analysis. */
  autoStarted: false,
  /** Past runs that carry a finished report, for repeat and compare. */
  sessions: [],
  /** The route being repeated, with the steps ticked off so far. */
  repeat: null,
  /** The most recent comparison, kept so it can be exported. */
  comparison: null,
  /** The ids it was built from, which the PDF renderer needs. */
  comparisonIds: null,
  /** every logcat line, for annotating an event */
  logs: [],
  reportShown: false,
  reportPath: null,
  reportDir: null,
  /**
   * Everything written for this run, as absolute paths.
   *
   * `automatic` is what the pipeline wrote by itself when the run finished;
   * `exported` is what a PDF export added. Both are kept so the report panel can
   * name them: an operator reported not knowing "where they're saved or even
   * saved or not", which was true - nothing on screen said.
   */
  outputs: { automatic: [], exported: [] },
  report: null,
  /**
   * The summary snapshot, derived server-side.
   *
   * Fetched rather than computed here: the ratings, the biggest issue and the
   * bottom line are the same derivation the Markdown cut and the PDF use, and a
   * second copy of it in the browser would be a second set of answers.
   */
  snapshot: null,
  audience: 'lead',
  audiences: [],
};

const $ = (id) => document.getElementById(id);

/**
 * The desktop app injects `window.oomDesktop` through its preload bridge. When
 * it is absent we are in a plain browser and fall back to the server's own
 * dialog endpoint, which shells out to the OS instead.
 */
const desktop = typeof window !== 'undefined' ? window.oomDesktop : undefined;

init().catch((err) => showError(err.message));

async function init() {
  initTheme();

  const [markers, health, audiences] = await Promise.all([
    fetchJson('/api/markers'),
    fetchJson('/api/health').catch(() => null),
    fetchJson('/api/audiences').catch(() => []),
  ]);
  state.markers = markers;
  state.audiences = audiences;
  renderMarkers();
  renderAudienceSwitch();

  if (health) {
    $('env-note').textContent =
      `adb ${health.adbPath ? 'found' : 'missing'} · workspace ${health.workspaceRoot}`;
  }

  $('setup-form').addEventListener('submit', onAnalyze);
  $('refresh-devices').addEventListener('click', () => void loadDevices());
  $('start-capture').addEventListener('click', onStartCapture);
  $('stop-capture').addEventListener('click', onStopCapture);
  $('finish').addEventListener('click', onFinish);
  $('reveal').addEventListener('click', onReveal);
  $('output-reveal').addEventListener('click', onShowFiles);
  $('export-pdf').addEventListener('click', openExportPanel);
  $('export-confirm').addEventListener('click', onExportConfirm);
  $('export-cancel').addEventListener('click', closeExportPanel);
  $('new-analysis').addEventListener('click', () => void resetEverything({ confirm: false }));
  $('reset-all').addEventListener('click', () => void resetEverything({ confirm: true }));

  for (const button of document.querySelectorAll('.browse')) {
    button.addEventListener('click', () => onBrowse(button));
  }

  initTimelineView();
  initAppList();
  $('deviceSelect').addEventListener('change', onDeviceChange);
  $('refresh-apps').addEventListener('click', () => void loadInstalledApps());
  $('appSearch').addEventListener('input', filterApps);

  // Validated as it is typed, so a wrong folder is caught here rather than
  // after the analysis has already started.
  $('projectPath').addEventListener('input', onProjectPathInput);

  /*
   * The project folder is hidden or shown by `renderProjectStatus`, which
   * enforces the flag itself. The input listeners above stay wired: a hidden
   * field cannot be typed into, so they never fire, and leaving them means
   * turning the feature back on needs no change here.
   */
  renderProjectStatus();
  refreshDisclosure();
  void loadDevices();

  $('repeatSession').addEventListener('change', () => void onRepeatChange());
  $('run-compare').addEventListener('click', () => void onCompare());
  $('close-compare').addEventListener('click', () => setCompareOpen(false));
  $('goto-compare').addEventListener('click', () => setCompareOpen(true));
  $('compareBefore').addEventListener('change', updateTargetPlaceholders);
  $('compareAfter').addEventListener('change', updateTargetPlaceholders);
  $('refresh-sessions').addEventListener('click', () => void loadSessionList());
  $('export-comparison').addEventListener('click', () => void onExportComparison());
  $('export-comparison-pdf').addEventListener('click', () => void onExportComparisonPdf());
  void loadSessionList();

  document.addEventListener('keydown', onHotkey);
  setInterval(tickClock, 500);
  window.addEventListener('resize', drawChart);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Three choices: light, dark, or follow the operating system.
 *
 * The chosen mode is stored; what gets applied to the document is always a
 * resolved 'light' or 'dark', so the canvas chart can read the same tokens the
 * stylesheet uses rather than duplicating a palette.
 */
function initTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const stored = () => {
    try {
      return localStorage.getItem('oom.theme') || 'system';
    } catch {
      return 'system';
    }
  };

  const apply = (mode) => {
    const dark = mode === 'dark' || (mode === 'system' && media.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === mode));
    }
    drawChart();
  };

  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.addEventListener('click', () => {
      const mode = button.dataset.themeChoice;
      try {
        localStorage.setItem('oom.theme', mode);
      } catch {
        /* private browsing - the choice just will not persist */
      }
      apply(mode);
    });
  }

  // Follow the OS live, but only while 'system' is the chosen mode.
  media.addEventListener('change', () => {
    if (stored() === 'system') apply('system');
  });

  apply(stored());
}

/** Read a CSS custom property so the canvas matches the active theme. */
function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

async function onBrowse(button) {
  const target = button.dataset.target;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Choosing…';

  try {
    const result = desktop?.isDesktop
      ? await desktop.pick(target)
      : await fetchJson('/api/pick', { method: 'POST', body: { target } });

    if (result.unsupported) {
      showError(result.unsupported);
    } else if (result.path) {
      $('projectPath').value = result.path;
      autofillGameName();
    }
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function autofillGameName() {
  const nameField = $('gameName');
  if (nameField.value.trim()) return;
  const path = $('projectPath').value.trim();
  if (!path) return;
  const leaf = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  if (leaf) nameField.value = leaf;
}

/**
 * Stop everything and start over.
 *
 * Reloading the page alone would not do it. The samplers, the logcat readers,
 * the Unity profiler port forward and SurfaceFlinger's frame collection all live
 * on the server and on the device, so a reload would leave them running against
 * a session nobody is watching - burning battery on the handset and holding a
 * port that the next run needs.
 *
 * So the server is told to release the run first, and only then is the console
 * reloaded. Reloading rather than clearing state by hand is deliberate: there is
 * a lot of state now (charts, per-role panels, comparison results, the event
 * log) and a reload cannot leave any of it behind, where a hand-written reset
 * eventually would.
 *
 * Nothing already written to disk is deleted. A finished report is still worth
 * comparing against later; this resets the console, not past work.
 */
async function resetEverything(opts = {}) {
  const running = state.capturing || (state.analysisId && !state.reportShown);

  if (opts.confirm && running) {
    const message = state.capturing
      ? 'Recording is still running. Resetting will discard this session and everything ' +
        'measured so far. Continue?'
      : 'An analysis is still in progress. Resetting will discard it. Continue?';
    if (!window.confirm(message)) return;
  }

  const button = $('reset-all');
  button.disabled = true;
  button.textContent = 'Resetting…';

  // Release the device and the server before the page goes away. Best effort:
  // a failure here must not leave the operator stuck on a console they asked to
  // reset, so the reload happens either way.
  if (state.analysisId) {
    try {
      await fetchJson(`/api/analysis/${state.analysisId}/abandon`, { method: 'POST' });
    } catch (err) {
      console.warn('Could not release the analysis cleanly:', err.message);
    }
  }

  // Close the live stream explicitly rather than letting the reload race it.
  try {
    state.socket?.close();
  } catch {
    /* already closed */
  }

  location.reload();
}

// ---------------------------------------------------------------------------
// Running an analysis
// ---------------------------------------------------------------------------

async function onAnalyze(event) {
  event.preventDefault();
  const form = new FormData(event.target);

  const projectPath = (form.get('projectPath') || '').trim();
  const packageName = (form.get('packageName') || '').trim();

  // The inputs say what to analyze; there is no separate mode to contradict
  // them. Only a folder the probe accepted is sent, so a half-typed path can
  // never turn into a failed intake stage.
  const mode = derivedMode();
  const usesProject = mode === 'apk_code';
  const usesDevice = true;

  if (!packageName) {
    showError('Choose the game to profile from the list of apps installed on the device.');
    return;
  }
  if (projectPath && !state.project?.valid) {
    showError(state.project?.reason ?? 'That folder is not a Unity project.');
    return;
  }

  state.mode = mode;
  state.usesDevice = usesDevice;

  /*
   * Last chance at a real name.
   *
   * The field is filled the moment the app's display name is known, but the
   * operator can press Analyze before that lands. Reading the label out of state
   * here costs nothing and is the difference between a report titled
   * "Prison Riot: Guard Simulator" and one titled "Unnamed game" - which also
   * names the folder every future comparison looks for.
   */
  const typedName = (form.get('gameName') || '').trim();

  /*
   * If the name is still unknown, wait for it. Reading one app's label off the
   * device takes about 770 ms, measured, and clicking an app you have just
   * searched for takes far less - so pressing Analyze immediately after
   * choosing beat the lookup and submitted an empty title. That is how a
   * session of `com.gdm.prison.guard` came out filed under `unnamed-game`,
   * while the run before it, on the same package and phone, was named
   * correctly. Under a second, only in that narrow window, and it decides both
   * the report title and the folder every future comparison looks for.
   */
  // Our own autofill is not a typed name, so it must not stop the lookup below
  // or win the choice at the end of it.
  const operatorTyped = typedName !== '' && typedName !== state.autofilledName;

  if (!operatorTyped && packageName && !state.apps.find((a) => a.packageName === packageName)?.label) {
    await ensureLabelFor(packageName);
  }
  const knownLabel = state.apps.find((a) => a.packageName === packageName)?.label;

  const body = {
    gameName: chooseSubmittedName(typedName, state.autofilledName, knownLabel),
    studio: (form.get('studio') || '').trim() || undefined,
    projectPath: usesProject ? projectPath : undefined,
    packageName,
    deviceSerials: state.deviceSerial ? [state.deviceSerial] : undefined,
    staticOnly: false,
    killBackgroundApps: form.get('killBackgroundApps') === 'on',
    freshState: form.get('freshState') === 'on',
  };

  const button = $('analyze-btn');
  button.disabled = true;
  button.textContent = 'Analyzing…';

  try {
    const result = await fetchJson('/api/analysis', { method: 'POST', body });
    state.analysisId = result.analysisId;
    $('analysis-id').textContent = result.analysisId;
    $('progress-panel').hidden = false;
    closeExportPanel();
    if (usesDevice) $('capture-panel').hidden = false;
    $('progress-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    connectStream();
    pollAnalysis();
  } catch (err) {
    button.disabled = false;
    refreshDisclosure();
    showError(err.message);
  }
}

function connectStream() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/api/stream?analysis=${state.analysisId}`);
  state.socket = socket;

  socket.addEventListener('open', () => setConnection('live', true));
  socket.addEventListener('close', () => setConnection('disconnected', false));
  socket.addEventListener('message', (message) => {
    const { type, payload } = JSON.parse(message.data);
    if (type === 'job') onJob(payload);
    else if (type === 'sample') onSample(payload);
    else if (type === 'event') onEvent(payload);
    /*
     * Both carry `session.status()`, so both go to the same handler.
     *
     * They were split, and only `session` reached `onSessionStatus` - but the
     * server sends that one exactly once, when the capture session attaches,
     * and every update after it as `status`. So everything that handler does
     * beyond rendering the cards happened once and then never again: the
     * frame-rate series stayed one sample long (which is why the live chart
     * said it was still waiting), and `state.capturing` and `state.sessionStart`
     * kept whatever they were at attach time for the rest of the run.
     */
    else if (type === 'status' || type === 'session') onSessionStatus(payload);
    else if (type === 'log') onLog(payload);
  });
}

function onJob(job) {
  renderStages(job);
  maybeAutoStartCapture(job.status);

  if (job.status === 'failed') {
    $('analyze-btn').disabled = false;
    refreshDisclosure();
    showError(job.error || 'The analysis failed. See the stage list for details.');
    return;
  }

  // A static run finishes on its own; fetch and show the report the moment it does.
  if (job.status === 'completed' && !state.reportShown) {
    state.reportShown = true;
    void loadReport();
  }
}

function setConnection(text, live) {
  const el = $('connection');
  el.textContent = text;
  el.classList.toggle('connected', live);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function onStartCapture() {
  const button = $('start-capture');
  if (button.disabled && state.capturing) return;

  button.disabled = true;
  button.textContent = 'Launching the game…';
  try {
    const result = await fetchJson(`/api/analysis/${state.analysisId}/capture/start`, { method: 'POST' });
    state.capturing = true;
    state.sessionStart = Date.now();
    button.textContent = 'Recording';
    $('stop-capture').disabled = false;
    $('finish').disabled = false;
    renderDeviceCards(result.status);

    // The panel that matters is now the one with the game running in it.
    $('capture-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Launch & start recording';
    showError(err.message);
  }
}

/**
 * Launch the game and start recording as soon as the pipeline is ready.
 *
 * Pressing Analyze is the operator saying "profile this game"; making them find
 * and press a second button once the preparation finished only added a place to
 * get stuck. `awaiting_gameplay` is the pipeline's own signal that the device is
 * set up and it is waiting on a human, so that is what triggers the launch.
 *
 * The button stays, because a launch can fail and the retry has to live
 * somewhere - it is just no longer the normal route.
 */
function maybeAutoStartCapture(status) {
  if (status !== 'awaiting_gameplay') return;
  if (!state.usesDevice || state.autoStarted || state.capturing) return;

  state.autoStarted = true;
  void onStartCapture();
}

async function onStopCapture() {
  await fetchJson(`/api/analysis/${state.analysisId}/capture/stop`, { method: 'POST' });
  state.capturing = false;
  $('stop-capture').disabled = true;
}

async function onFinish() {
  const button = $('finish');
  button.disabled = true;
  button.textContent = 'Analyzing…';
  try {
    const result = await fetchJson(`/api/analysis/${state.analysisId}/finish`, { method: 'POST' });
    // Take the paths from the finish response rather than waiting for the next
    // status poll. This used to be left to polling, which stops as soon as it
    // sees a terminal job status - so for up to two seconds after the report
    // appeared the console did not know its own report folder, and pressing
    // "Export PDF..." in that window opened the folder picker on Documents
    // instead of the session's reports folder. That is how an export ended up
    // somewhere the operator could not find.
    adoptReportPaths(result.paths);
    // Recording is over: freeze the chart and retire the controls that act on a
    // live session, so nothing on screen still looks like it is running.
    state.capturing = false;
    state.captureEndedMs = state.sessionStart ? Date.now() - state.sessionStart : null;
    $('start-capture').disabled = true;
    $('stop-capture').disabled = true;
    state.reportShown = true;
    drawChart();
    renderReport(result.report);
    // This run is now comparable, so it belongs in the pickers.
    void loadSessionList();
  } catch (err) {
    showError(err.message);
  } finally {
    button.textContent = 'Finish & build report';
  }
}

async function loadReport() {
  try {
    const report = await fetchJson(`/api/analysis/${state.analysisId}/report`);
    renderReport(report);
  } catch (err) {
    showError(`The analysis finished but the report could not be loaded: ${err.message}`);
  }
}

/**
 * Record where this run's files are.
 *
 * Called from both the finish response and the status poll, whichever arrives
 * first, because the two disagree on timing: `finish` returns the paths the
 * instant they exist, while polling stops on the first terminal status and may
 * never report them at all.
 *
 * `reportPaths` carries the audience cuts in `byAudience`, so the list below is
 * built from what the pipeline actually wrote rather than from names guessed
 * here - a cut that failed to render must not be advertised as saved.
 */
function adoptReportPaths(paths) {
  if (!paths?.markdown) return;

  state.reportPath = paths.markdown;
  // Strip the file name, leaving the reports folder. Handles both separators
  // because the same console runs on Windows and macOS.
  state.reportDir = paths.markdown.replace(/[^\\\/]*$/, '');

  const automatic = [];
  const cuts = paths.byAudience ?? {};
  for (const profile of state.audiences) {
    if (cuts[profile.id]) automatic.push({ path: cuts[profile.id], what: `${profile.label} (Markdown)` });
  }
  // A cut the audience list does not know about still gets listed, so the panel
  // never quietly omits a file that is on disk.
  for (const [audience, file] of Object.entries(cuts)) {
    if (!automatic.some((entry) => entry.path === file)) {
      automatic.push({ path: file, what: `${audience} (Markdown)` });
    }
  }
  if (paths.json) automatic.push({ path: paths.json, what: 'Full data (JSON)' });

  state.outputs.automatic = automatic;
  renderOutputs();
}

/**
 * Note the PDFs an export produced.
 *
 * Appended rather than replaced, and de-duplicated by path, because exporting
 * twice into the same folder overwrites the file rather than adding one.
 */
function adoptExportedPaths(written) {
  if (!Array.isArray(written) || written.length === 0) return;

  for (const entry of written) {
    const path = typeof entry === 'string' ? entry : entry?.path;
    if (!path) continue;
    const what = typeof entry === 'string' ? 'PDF' : `${entry.label ?? 'PDF'} (PDF)`;
    const existing = state.outputs.exported.findIndex((e) => e.path === path);
    const record = { path, what, bytes: typeof entry === 'object' ? entry.bytes : undefined };
    if (existing === -1) state.outputs.exported.push(record);
    else state.outputs.exported[existing] = record;
  }
  renderOutputs();
}

/**
 * The list of files, with their full paths.
 *
 * Full paths, not file names: the point of this panel is to answer "where did
 * it go", and a bare `report.md` answers nothing. The sizes are shown for the
 * PDFs because they are the ones whose creation can half-fail - a report that
 * rendered as an empty page still produces a file.
 */
function renderOutputs() {
  const block = $('output-block');
  const list = $('output-files');
  if (!block || !list) return;

  const entries = [...state.outputs.automatic, ...state.outputs.exported];
  if (entries.length === 0) {
    block.hidden = true;
    return;
  }

  const rows = [];
  if (state.reportDir) {
    rows.push(
      '<li class="folder">' +
        `<span class="path">${escapeHtml(state.reportDir)}</span>` +
        '<span class="what">session folder</span>' +
        '</li>',
    );
  }
  for (const entry of entries) {
    rows.push(
      '<li>' +
        `<span class="path">${escapeHtml(entry.path)}</span>` +
        `<span class="what">${escapeHtml(entry.what)}${entry.bytes ? ` · ${kb(entry.bytes)}` : ''}</span>` +
        '</li>',
    );
  }

  list.innerHTML = rows.join('');
  block.hidden = false;
  setOutputStatus('');
}

/** Kilobytes, because a report PDF is hundreds of them and never megabytes. */
function kb(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function setOutputStatus(text, kind) {
  const el = $('output-status');
  if (!el) return;
  el.textContent = text;
  el.className = `muted small${kind ? ' ' + kind : ''}`;
}

/**
 * Open the session's reports folder.
 *
 * The folder rather than one file: whoever presses this wants to see everything
 * the run produced. Failures are shown - a button that silently does nothing is
 * how this panel came to be distrusted in the first place.
 */
async function onShowFiles() {
  return revealFolder(state.reportDir);
}

/**
 * Open a folder in the file manager.
 *
 * Split out of the button so a finished export can call it too: an export that
 * printed the paths and stopped there still left the operator to go and find
 * them, which was the substance of the original complaint about saving.
 */
async function revealFolder(dir) {
  if (!dir) {
    setOutputStatus('The report folder is not known yet.', 'err');
    return;
  }
  try {
    if (typeof desktop?.openFolder === 'function') {
      const result = await desktop.openFolder(dir);
      if (result && result.ok === false) setOutputStatus(result.error ?? 'The folder could not be opened.', 'err');
      else setOutputStatus('');
      return;
    }
    // Browser, or a packaged asar older than `openFolder`: the server sits on
    // this same machine and can open the file manager itself.
    await fetchJson(`/api/analysis/${state.analysisId}/reveal`, { method: 'POST' });
    setOutputStatus('');
  } catch (err) {
    setOutputStatus(err.message, 'err');
  }
}

async function onReveal() {
  try {
    if (typeof desktop?.openFolder === 'function' && state.reportDir) {
      const result = await desktop.openFolder(state.reportDir);
      if (result && result.ok === false) throw new Error(result.error ?? 'The folder could not be opened.');
      return;
    }
    if (typeof desktop?.reveal === 'function' && state.reportPath) {
      const result = await desktop.reveal(state.reportPath);
      if (result && result.ok === false) throw new Error(result.error ?? 'The file could not be shown.');
      return;
    }
    await fetchJson(`/api/analysis/${state.analysisId}/reveal`, { method: 'POST' });
  } catch (err) {
    showError(err.message);
  }
}

/**
 * Fold one sample into the per-device series.
 *
 * Two series per device, because the tiers carry different things: the fast tier
 * gives a total only, while the deep tier carries the category breakdown. They
 * are kept apart rather than merged - a stack built from a total would be an
 * invention.
 */
function onSample(sample) {
  const role = sample.role;
  if (!state.byRole.has(role)) state.byRole.set(role, { line: [], stacks: [] });
  const data = state.byRole.get(role);

  const total = sample.pssBytes ?? sample.rssBytes;
  if (total != null) data.line.push({ elapsedMs: sample.elapsedMs, value: total });

  const stackPoint = OomChart.toStackPoint(sample);
  if (stackPoint) {
    data.stacks.push(stackPoint);
    // Recomputed rather than appended: a threshold relative to the device means
    // the whole series has to agree on what counts as an event.
    const device = state.devices.find((d) => d.role === role);
    state.memoryEvents.set(
      role,
      OomChart.detectEvents(data.stacks, {
        minDeltaBytes: Math.max(20 * MB, (device?.totalRamBytes ?? 0) * 0.01),
      }),
    );
  }

  // Bound memory on long sessions by thinning the older half of the fast series.
  // The deep series is 5x sparser and does not need it.
  if (data.line.length > 6000) {
    data.line = data.line.filter((_, i) => i % 2 === 0 || i > data.line.length / 2);
  }

  drawChart();
}

function onEvent(event) {
  state.events.push(event);
  const danger = ['process_gone', 'process_killed', 'process_crash', 'probe_lost'].includes(event.type);
  appendLog(event.elapsedMs, event.label, danger ? 'danger' : event.source === 'system' ? 'system' : '');
  drawChart();
}

function onLog(entry) {
  // Every line is kept: an event's detail panel shows what the system logged
  // during that step, which is often the only clue about what triggered it.
  state.logs.push(entry);
  if (state.logs.length > 4000) state.logs.splice(0, 1000);

  if (entry.category !== 'oom_kill' && entry.category !== 'crash') return;
  appendLog(entry.elapsedMs, `[${entry.tag}] ${entry.message.slice(0, 120)}`, 'danger');
}

function appendLog(elapsedMs, text, className) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML =
    `<span class="t">${formatDuration(elapsedMs)}</span>` +
    `<span class="${className}">${escapeHtml(text)}</span>`;
  $('event-log').prepend(row);
}

function onSessionStatus(status) {
  // Kept per role so the timeline header can show the same live figures as the
  // device card without a second request.
  for (const d of status?.devices ?? []) {
    state.liveByRole.set(d.role, d);

    /*
     * Append to the frame-rate series.
     *
     * Guarded against a repeated timestamp because status messages can arrive
     * more than once for the same instant when the stream reconnects, and a
     * duplicated sample would show as a vertical spike the device never had.
     */
    if (d.fps != null) {
      const series = state.fpsByRole.get(d.role) ?? [];
      const elapsedMs = status.elapsedMs ?? 0;
      const last = series[series.length - 1];
      if (!last || elapsedMs > last.elapsedMs) {
        /*
         * `d.janks` is cumulative for the whole session, so the per-sample
         * figure is the difference. Storing the running total would put a jank
         * tick under every sample after the first one, which would read as a
         * game that stuttered continuously from the moment it first hitched.
         */
        const cumulative = d.janks ?? 0;
        const janks = Math.max(0, cumulative - (state.janksSeenByRole.get(d.role) ?? 0));
        state.janksSeenByRole.set(d.role, cumulative);

        series.push({ elapsedMs, fps: d.fps, janks });
        state.fpsByRole.set(d.role, series);
      }
    }
  }
  state.sessionStart = Date.now() - status.elapsedMs;
  // Never back to true: a status message in flight when the report was built
  // would otherwise put the chart back on the wall clock.
  state.capturing = status.running && state.captureEndedMs === null;
  renderDeviceCards(status);
}

async function mark(type, label) {
  if (!state.analysisId) return;
  try {
    await fetchJson(`/api/analysis/${state.analysisId}/mark`, {
      method: 'POST',
      body: { type, label },
    });
    // Only after the server accepted it: a step ticked off for a marker that
    // was never recorded would make the route look covered when it is not.
    notePressedMarker(label);
  } catch (err) {
    showError(err.message);
  }
}

/**
 * Is the operator typing, rather than pressing a marker key?
 *
 * The marker hotkeys are bare letters and digits - b, g, h, c, f, x, 1-4 - so
 * anything that swallows a keystroke intended for a text field is felt
 * immediately: the app search stops accepting exactly those characters and
 * appears broken rather than hijacked.
 *
 * The old test named two tag names, which missed the case that actually bites.
 * The installed-app list is a `div` with `tabindex="0"` so it can be arrowed
 * through, and focus lands on it whenever a row is clicked or ArrowDown is
 * pressed. Its tag name is DIV, so every letter typed after that fired a marker
 * and was swallowed - which is why searching worked before a session and not
 * during one.
 */
function isTypingTarget(target) {
  if (!target) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  if (target.isContentEditable) return true;
  // Anything reachable by Tab that is not a button: a listbox being arrowed
  // through is being operated, and a marker key would interrupt it.
  return target.matches?.('[tabindex]:not([tabindex="-1"])') ?? false;
}

function onHotkey(event) {
  // Escape closes the comparison panel, which is what a panel with a close
  // button is expected to do. Not while focus is in a field, where Escape can
  // mean "undo what I just typed".
  if (event.key === 'Escape' && state.compareOpen && !isTypingTarget(event.target)) {
    setCompareOpen(false);
    return;
  }

  if (!state.capturing) return;
  if (isTypingTarget(event.target)) return;

  /*
   * An open dropdown owns the keyboard.
   *
   * Even with focus nowhere in particular, a marker key pressed while the app
   * picker is open is far more likely to be someone searching than someone
   * marking a moment in the session.
   */
  if (state.listOpen) return;

  // Modified keys belong to the browser and the OS, never to a marker.
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const marker = state.markers.find((m) => m.hotkey === event.key.toLowerCase());
  if (!marker) return;
  event.preventDefault();
  handleMarkerPress(marker);
}

function handleMarkerPress(marker) {
  if (marker.type === 'custom') {
    const label = prompt('Label for this event:');
    if (!label) return;
    mark('custom', label);
  } else {
    mark(marker.type);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderMarkers() {
  const container = $('markers');
  container.innerHTML = '';
  for (const marker of state.markers) {
    const button = document.createElement('button');
    button.className = `marker-btn ${marker.group}`;
    button.title = marker.description;
    button.innerHTML =
      escapeHtml(marker.label) +
      (marker.hotkey ? `<span class="key">${escapeHtml(marker.hotkey)}</span>` : '');
    button.addEventListener('click', () => handleMarkerPress(marker));
    container.appendChild(button);
  }
}

const STAGE_LABELS = {
  'intake.repository': 'Read Unity project',
  'intake.apk': 'Locate APK',
  'apk.inspect': 'Inspect APK',
  'static.analysis': 'Analyze assets, scenes and code',
  'device.detect': 'Detect devices',
  'device.install': 'Install APK',
  'device.freshStart': 'Free memory on the device',
  'device.launch': 'Launch and find process',
  'device.profiler': 'Connect Unity profiler',
  'live.capture': 'Record memory',
  'analysis.anomaly': 'Detect anomalies',
  'analysis.flow': 'Compare repeated flows',
  'analysis.correlation': 'Correlate with project causes',
  'analysis.scoring': 'Score risk',
  'report.generate': 'Generate report',
};

function renderStages(job) {
  const icons = { ok: '✓', running: '◐', failed: '✕', skipped: '−', pending: '·' };
  $('stages').innerHTML = job.stages
    .map(
      (s) => `
      <li class="stage ${s.status}">
        <span class="icon">${icons[s.status] ?? '·'}</span>
        <span>${escapeHtml(STAGE_LABELS[s.name] ?? s.name)}</span>
        ${s.error ? `<span class="err">${escapeHtml(s.error.slice(0, 110))}</span>` : ''}
      </li>`,
    )
    .join('');
}

function renderDeviceCards(status) {
  if (!status?.devices) return;
  $('device-cards').innerHTML = status.devices
    .map((d) => {
      const current = d.lastPssBytes ?? d.lastRssBytes;
      return `
      <div class="device-card ${d.alive ? '' : 'dead'}">
        <div class="head">
          <span><span class="role-badge role-${d.role}">${d.role}</span>${escapeHtml(d.model)}</span>
          <span class="muted small">${d.alive ? `pid ${d.pid}` : 'PROCESS GONE'}</span>
        </div>
        <div class="value" style="color:${roleColor(d.role)}">
          ${current != null ? (current / MB).toFixed(0) : '—'} <span class="muted small">MB</span>
        </div>
        <div class="live-stats">
          ${liveStat('FPS', d.fps != null ? d.fps.toFixed(0) : '\u2014', fpsTone(d.fps))}
          ${liveStat('Temp', d.temperatureC != null ? d.temperatureC.toFixed(0) + '\u00b0' : '\u2014', d.throttling ? 'bad' : heatTone(d.temperatureC))}
          ${liveStat('Janks', String(d.janks ?? 0), jankTone(d.janks))}
          ${liveStat('Batt', d.batteryPercent != null ? d.batteryPercent + '%' : '\u2014', d.batteryCharging ? 'charging' : '')}
        </div>
        ${d.throttling ? '<div class="throttle-flag">device is throttling &mdash; performance is being limited</div>' : ''}
        ${
          d.fpsMatchesDisplayRate === true && d.fpsDisplayHz != null
            ? `<div class="stat-missing">at the screen's ${d.fpsDisplayHz} Hz &mdash; any frame cap is not applying</div>`
            : ''
        }
        ${fpsNote(d)}
        <div class="meta">
          <span>Peak: ${(d.peakPssBytes / MB).toFixed(0)} MB</span>
          <span>Samples: ${d.deepSamples} deep / ${d.fastSamples} fast</span>
        </div>
      </div>`;
    })
    .join('');
}

/**
 * One live figure on a device card.
 *
 * Deliberately terse and fixed-width: these update every few seconds while
 * someone is playing, and a card that reflows as the digits change is harder to
 * read than one that holds its shape.
 */
function liveStat(label, value, tone) {
  return (
    `<div class="live-stat ${tone}">` +
    `<span class="ls-label">${label}</span>` +
    `<span class="ls-value">${escapeHtml(value)}</span>` +
    '</div>'
  );
}

/**
 * Why frame rate is missing, when it is.
 *
 * "Not measurable" on its own is not something anyone can act on, so the
 * strategies that were tried and what each one reported are shown instead. The
 * usual answer is that this device's Android build dropped the legacy interface
 * and the game had not drawn a frame yet when the newer one was first read.
 */
function fpsNote(d) {
  if (d.fps != null) return '';

  // Measurable, just nothing yet: the first window has not closed.
  if (d.fpsSource) {
    return '<div class="stat-missing">waiting for the first frame-rate window</div>';
  }

  const tried = (d.fpsDiagnostics ?? [])
    .map((a) => `<li>${escapeHtml(a.strategy)} — ${escapeHtml(a.detail)}</li>`)
    .join('');

  return (
    '<details class="stat-why"><summary>frame rate not measurable on this device</summary>' +
    (tried ? `<ul>${tried}</ul>` : '<p>No frame-rate strategy reported anything.</p>') +
    '</details>'
  );
}

/**
 * Frame-rate colour.
 *
 * Judged against 30 fps rather than 60: a mobile game targeting 30 is normal,
 * and colouring it red for hitting its own target would be noise. What matters
 * is dropping below playable.
 */
function fpsTone(fps) {
  if (fps == null) return '';
  if (fps < 20) return 'bad';
  if (fps < 28) return 'warn';
  return 'ok';
}

/**
 * Stutter colour.
 *
 * A count rather than a rate, because live the session is still running and a
 * per-minute figure would swing wildly in the first minute. Any jank at all is
 * worth noticing; a handful is a problem.
 */
function jankTone(janks) {
  if (janks == null) return '';
  if (janks === 0) return 'ok';
  if (janks <= 3) return 'warn';
  return 'bad';
}

/**
 * Heat colour.
 *
 * Absolute temperature here, unlike the report's summary, because live there is
 * no baseline yet to measure a rise against. Most phones start limiting
 * performance around 45 degrees.
 */
function heatTone(celsius) {
  if (celsius == null) return '';
  if (celsius >= 45) return 'bad';
  if (celsius >= 40) return 'warn';
  return 'ok';
}

async function pollAnalysis() {
  if (!state.analysisId) return;
  try {
    const info = await fetchJson(`/api/analysis/${state.analysisId}`);
    const parts = [];

    if (info.apk) {
      parts.push(
        `<div><strong>APK</strong> · ${escapeHtml(info.apk.packageName ?? '?')} v${escapeHtml(info.apk.versionName ?? '?')} · ` +
          `Unity ${escapeHtml(info.apk.unityVersion ?? 'unknown')} · ${escapeHtml(info.apk.scriptingBackend)} · ` +
          `${escapeHtml((info.apk.abis || []).join(', ') || 'no native libs')}</div>`,
      );
      for (const warning of info.apk.warnings ?? []) {
        parts.push(`<div class="muted small">⚠ ${escapeHtml(warning)}</div>`);
      }
    }
    if (info.project) {
      parts.push(
        `<div><strong>Project</strong> · Unity ${escapeHtml(info.project.unityVersion ?? '?')} · ` +
          `${info.project.buildScenes} build scene(s) · Addressables: ${info.project.usesAddressables ? 'yes' : 'no'}</div>`,
      );
      for (const warning of info.project.warnings ?? []) {
        parts.push(`<div class="muted small">⚠ ${escapeHtml(warning)}</div>`);
      }
    }
    if (info.staticFindings) {
      parts.push(`<div><strong>Findings so far</strong> · ${info.staticFindings}</div>`);
    }
    adoptReportPaths(info.reportPaths);
    $('summary').innerHTML = parts.join('');

    // Also checked here, so a websocket that dropped does not leave the run
    // waiting for a press that used to be required.
    maybeAutoStartCapture(info.job.status);

    const terminal = ['completed', 'failed', 'cancelled'].includes(info.job.status);
    if (!terminal) setTimeout(pollAnalysis, 2000);
  } catch {
    setTimeout(pollAnalysis, 4000);
  }
}

function renderReport(report) {
  state.report = report;
  state.snapshot = null;
  void loadSnapshot();
  $('report-panel').hidden = false;
  $('analyze-btn').disabled = false;
  $('analyze-btn').textContent = 'Analyze';
  renderAudienceSwitch();
  renderReportBody();
  $('report-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Detail-level switcher.
 *
 * The same report answers different questions for a lead, an engineer and an
 * analyst. Showing all three at once serves none of them well, so the reader
 * picks the depth they need and the download link follows that choice.
 */
function renderAudienceSwitch() {
  const container = $('audience-switch');
  if (!container || state.audiences.length === 0) return;

  container.innerHTML = '';
  for (const profile of state.audiences) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = profile.label;
    button.title = profile.description;
    button.setAttribute('aria-pressed', String(profile.id === state.audience));
    button.addEventListener('click', () => {
      state.audience = profile.id;
      renderAudienceSwitch();
      renderReportBody();
    });
    container.appendChild(button);
  }
}

/**
 * The summary snapshot, from the server.
 *
 * Failure is silent on purpose: the report itself is already on screen, and a
 * missing snapshot costs the reader a panel, not the result.
 */
async function loadSnapshot() {
  try {
    state.snapshot = await fetchJson(`/api/analysis/${state.analysisId}/summary`);
  } catch {
    state.snapshot = null;
  }
  if (state.audience === 'lead') renderReportBody();
}

function renderReportBody() {
  const report = state.report;
  if (!report) return;

  const profile = state.audiences.find((a) => a.id === state.audience);
  const isLead = state.audience === 'lead';
  const isComplete = state.audience === 'complete';

  /*
   * The summary is a snapshot, not a shorter report.
   *
   * It answers the six questions a producer opens with - is it healthy, how
   * risky, how sure are we, what are the numbers, what is the worst problem,
   * how did it play - and then stops. Everything that explains those answers is
   * one click away in the complete view.
   */
  if (isLead) {
    $('report-body').innerHTML = state.snapshot
      ? renderSnapshotPanel(state.snapshot)
      : '<p class="muted">Building the summary…</p>';
    updateReportLinks();
    return;
  }

  const risk = report.verdict.combinedRisk;
  const confidence = Math.round(report.verdict.confidence.value * 100);

  const deviceRows = report.devices
    .map(
      (d) =>
        '<tr>' +
        `<td><span class="role-badge role-${d.role}">${d.role}</span></td>` +
        `<td>${escapeHtml(d.manufacturer)} ${escapeHtml(d.model)}</td>` +
        `<td>${(d.totalRamBytes / (1024 * MB)).toFixed(1)} GB</td>` +
        `<td>${mb(d.peakBytes)}</td>` +
        `<td>${d.processDeaths > 0 ? '<strong class="sev-critical">yes</strong>' : 'no'}</td>` +
        (isLead ? '' : `<td>${d.risk ? d.risk.value + '/100' : '—'}</td>`) +
        '</tr>',
    )
    .join('');

  const devices = report.devices.length
    ? '<h3>Devices</h3><table class="report-table"><thead><tr>' +
      '<th>Device</th><th>Model</th><th>RAM</th><th>Peak</th><th>Crashed</th>' +
      (isLead ? '' : '<th>Risk</th>') +
      `</tr></thead><tbody>${deviceRows}</tbody></table>`
    : '';

  const cycleRows = (report.session?.cycles ?? [])
    .map(
      (c) =>
        '<tr>' +
        `<td>${escapeHtml(c.role)}</td>` +
        `<td>${escapeHtml(c.label)}</td>` +
        `<td>${mb(c.startBytes)}</td>` +
        `<td>${mb(c.peakBytes)}</td>` +
        `<td>${mb(c.recoveredBytes)}</td>` +
        `<td>${signedMb(c.recoveryDeltaBytes)}</td>` +
        '</tr>',
    )
    .join('');

  const cycles =
    !isLead && cycleRows
      ? '<h3>Repeated flow recovery</h3><table class="report-table"><thead><tr>' +
        '<th>Device</th><th>Cycle</th><th>Start</th><th>Peak</th><th>Returned to</th><th>Recovery delta</th>' +
        `</tr></thead><tbody>${cycleRows}</tbody></table>`
      : '';

  const findingLimit = isLead ? 6 : isComplete ? report.priority.length : 15;

  const findings = report.priority
    .slice(0, findingLimit)
    .map((p) => renderFinding(p.finding, { isLead, isComplete }))
    .join('');

  const limitationList = isLead
    ? report.verdict.confidence.caveats.slice(0, 5)
    : [...new Set(report.limitations)].slice(0, isComplete ? 50 : 10);

  const scoreLine = isLead
    ? `Confidence in this assessment: ${confidence}%`
    : `Static ${report.verdict.staticRisk.value} · Live ${report.verdict.liveRisk.value} · Evidence confidence ${confidence}%`;

  $('report-body').innerHTML =
    (profile ? `<p class="audience-hint">${escapeHtml(profile.description)}</p>` : '') +
    `<div class="risk-banner ${risk.band}">` +
    `<div class="score">${risk.value}<span class="muted" style="font-size:16px">/100 · ${risk.band}</span></div>` +
    `<div class="headline">${escapeHtml(report.verdict.headline)}</div>` +
    `<div class="muted small" style="margin-top:8px">${scoreLine}</div>` +
    '</div>' +
    devices +
    cycles +
    `<h3>${isLead ? 'What is wrong' : 'What to fix first'}</h3>` +
    (findings || '<p class="muted">No findings were produced.</p>') +
    (report.priority.length > findingLimit
      ? `<p class="muted small">${report.priority.length - findingLimit} further finding(s) are in the more detailed views.</p>`
      : '') +
    (limitationList.length
      ? `<h3>${isLead ? 'What would make this more certain' : 'Limitations'}</h3>` +
        `<ul class="limitations">${limitationList.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
      : '');

  updateReportLinks();
}

/** The download links follow whichever depth is being viewed. */
function updateReportLinks() {
  const mdUrl = `/api/analysis/${state.analysisId}/report.md?audience=${state.audience}`;
  const jsonUrl = `/api/analysis/${state.analysisId}/report`;
  $('report-md').href = mdUrl;
  $('report-json').href = jsonUrl;

  // Inside the desktop app these would navigate the single window away from the
  // console, so hand them to the real browser instead.
  if (desktop?.isDesktop) {
    for (const pair of [
      [$('report-md'), mdUrl],
      [$('report-json'), jsonUrl],
    ]) {
      const el = pair[0];
      const url = pair[1];
      el.onclick = (event) => {
        event.preventDefault();
        void desktop.openExternal(new URL(url, location.origin).href);
      };
    }
  }
}

/**
 * The summary, as a snapshot panel.
 *
 * Laid out to be looked at rather than read: status and score first, the four
 * numbers next, then the single worst problem, how it played, what it ran on,
 * and one sentence of conclusion. Every value comes from the server's snapshot,
 * so this panel and the exported PDF cannot drift apart.
 */
function renderSnapshotPanel(snap) {
  const kpis = snap.kpis
    .map(
      (k) =>
        `<div class="snap-kpi tone-${k.tone}">` +
        `<div class="snap-kpi-label">${escapeHtml(k.label)}</div>` +
        (k.value
          ? `<div class="snap-kpi-value">${escapeHtml(k.value)}</div>` +
            `<div class="snap-kpi-caption">${escapeHtml(k.caption)}</div>`
          : '<div class="snap-kpi-value none">—</div><div class="snap-kpi-caption">Not measured</div>') +
        `<div class="snap-kpi-status"><span class="snap-dot"></span>${escapeHtml(k.status)}</div>` +
        '</div>',
    )
    .join('');

  const issue = snap.issue
    ? `<div class="snap-block snap-issue tone-${snap.issue.tone}">` +
      '<h3>What is the biggest problem?</h3>' +
      (snap.issue.headline
        ? `<div class="snap-issue-headline">${escapeHtml(snap.issue.headline)}</div>`
        : '') +
      `<div class="snap-issue-kind">${escapeHtml(snap.issue.kind)}</div>` +
      (snap.issue.detail ? `<div class="snap-issue-detail">${escapeHtml(snap.issue.detail)}</div>` : '') +
      `<div class="snap-priority">${escapeHtml(snap.issue.priority)}</div>` +
      '</div>'
    : '<div class="snap-block snap-issue tone-good"><h3>Biggest issue</h3>' +
      '<div class="snap-issue-kind">No major performance issue detected</div></div>';

  const experience = snap.experience
    ? `<div class="snap-block tone-${snap.experience.tone}">` +
      '<h3>How did it play?</h3>' +
      `<ul class="snap-facts">${snap.experience.facts
        .map((f) => `<li>${escapeHtml(f)}</li>`)
        .join('')}</ul>` +
      `<div class="snap-verdict"><span class="snap-dot"></span>Overall: <strong>${escapeHtml(
        snap.experience.verdict,
      )}</strong></div>` +
      '</div>'
    : '<div class="snap-block tone-unknown"><h3>Game experience</h3>' +
      '<p class="muted">Frame rate was not measured in this session.</p></div>';

  return (
    `<div class="snap-hero tone-${snap.risk.tone}">` +
    '<div class="snap-hero-main">' +
    `<div class="snap-status"><span class="snap-dot"></span>${escapeHtml(snap.risk.label)}</div>` +
    `<div class="snap-concern">${escapeHtml(snap.concern)}</div>` +
    '<div class="snap-score-label">OOM risk</div>' +
    `<div class="snap-score">${snap.risk.value}<span>/ 100</span></div>` +
    '</div>' +
    // Confidence never borrows the band's colour: read as one, a low confidence
    // becomes a low risk, which is the opposite of what it means.
    '<div class="snap-conf">' +
    '<div class="snap-conf-label">Confidence</div>' +
    `<div class="snap-conf-value">${snap.confidence.percent}%</div>` +
    `<div class="snap-conf-bar"><span style="width:${Math.max(
      0,
      Math.min(100, snap.confidence.percent),
    )}%"></span></div>` +
    `<div class="muted small">${escapeHtml(snap.confidence.label)}</div>` +
    '</div>' +
    '</div>' +
    snap.alerts.map((a) => `<div class="snap-alert">${escapeHtml(a)}</div>`).join('') +
    `<div class="snap-kpis">${kpis}</div>` +
    `<div class="snap-split">${issue}${experience}</div>` +
    '<div class="snap-context">' +
    `<div><span>Device</span>${escapeHtml(snap.device ?? 'No device measured')}</div>` +
    `<div><span>Session</span>${escapeHtml(snap.session ?? 'No device session captured')}</div>` +
    '</div>' +
    '<div class="snap-bottom"><span>Bottom line</span>' +
    `<p>${escapeHtml(snap.bottomLine)}</p></div>` +
    '<p class="muted small snap-foot"><strong>Risk</strong> is how likely this game is to run out ' +
    'of memory. <strong>Confidence</strong> is how much of the intended testing actually happened ' +
    '— a low score with low confidence means “not yet shown to be a problem”, not “known to be ' +
    'fine”. The complete view carries the charts, the findings and the technical detail.</p>'
  );
}

/**
 * One finding.
 *
 * The lead view deliberately carries no file paths, no code and no confidence
 * arithmetic - just what is wrong, what it costs, and the one thing to do.
 */
function renderFinding(f, opts) {
  const measured = f.source === 'live' || f.source === 'correlated';
  const cost = f.estimatedBytes ? `<span class="muted small"> · ${mb(f.estimatedBytes)}</span>` : '';

  if (opts.isLead) {
    return (
      '<div class="finding lead">' +
      '<div class="finding-head">' +
      `<span class="sev sev-${f.severity}">${f.severity}</span> ` +
      `<strong>${escapeHtml(f.title)}</strong>${cost}` +
      (measured ? '<span class="badge-measured">measured on device</span>' : '') +
      '</div>' +
      `<p>${escapeHtml(firstSentences(f.description, 2))}</p>` +
      `<p class="rec"><strong>What to do:</strong> ${escapeHtml(firstSentences(f.recommendation, 1))}</p>` +
      '</div>'
    );
  }

  const evidence = opts.isComplete ? f.evidence : f.evidence.slice(0, 8);
  const evidenceHtml = evidence.length
    ? `<ul class="evidence">${evidence
        .map((e) => {
          const loc = e.path
            ? `<code>${escapeHtml(e.path)}${e.line ? ':' + e.line : ''}</code>`
            : '';
          const sep = loc && e.summary ? ' — ' : '';
          return `<li>${loc}${sep}${escapeHtml(e.summary)}</li>`;
        })
        .join('')}</ul>`
    : '';

  return (
    '<details class="finding">' +
    '<summary>' +
    `<span class="sev sev-${f.severity}">${f.severity}</span> ` +
    `<strong>${escapeHtml(f.title)}</strong>${cost}` +
    '</summary>' +
    `<p class="muted small">${Math.round(f.confidence * 100)}% confidence · ${escapeHtml(sourceLabel(f.source))}</p>` +
    `<p>${escapeHtml(f.description)}</p>` +
    `<p class="rec"><strong>Fix:</strong> ${escapeHtml(f.recommendation)}</p>` +
    evidenceHtml +
    '</details>'
  );
}

/**
 * First N sentences - the lead view shows a summary, not a full paragraph.
 *
 * A naive split on '.' mangles this text, which is full of decimals
 * ("85.3 MB"), file names ("hero_atlas.png") and dotted identifiers
 * ("Addressables.Release"). A boundary therefore requires the punctuation to be
 * followed by whitespace and a capital, or by end of text.
 */
function firstSentences(text, count) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();

  // Find where sentences *end* rather than matching their bodies: a pattern
  // like [^.!?]+[.!?] can never span "85.3", so it would start mid-number.
  const boundary = /[.!?]+(?=\s+[A-Z("']|\s*$)/g;
  const ends = [];
  let match;
  while ((match = boundary.exec(value)) !== null) {
    ends.push(match.index + match[0].length);
  }

  if (ends.length === 0) return value;
  return value.slice(0, ends[Math.min(count, ends.length) - 1]).trim();
}

function sourceLabel(source) {
  if (source === 'correlated') return 'measured on device, cause found in the project';
  if (source === 'live') return 'measured on device';
  return 'predicted from the project';
}

function mb(bytes) {
  return bytes == null ? '—' : `${(bytes / MB).toFixed(0)} MB`;
}

function signedMb(bytes) {
  if (bytes == null) return '—';
  const text = `${(bytes / MB).toFixed(0)} MB`;
  return bytes > 0 ? `<strong class="sev-high">+${text}</strong>` : text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tickClock() {
  if (!state.sessionStart || !state.capturing) return;
  $('session-clock').textContent = formatDuration(Date.now() - state.sessionStart);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function fetchJson(url, options = {}) {
  const init = { method: options.method ?? 'GET', headers: {} };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
}

function showError(message) {
  const box = document.createElement('div');
  box.className = 'error-box floating';
  box.textContent = message;
  box.addEventListener('click', () => box.remove());
  document.querySelector('main').prepend(box);
  setTimeout(() => box.remove(), 15000);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

/**
 * The chooser.
 *
 * Multi-select because the three cuts go to different people and a run usually
 * needs more than one: the lead gets the summary, the engineer gets the
 * developer report, both from the same analysis.
 */
function openExportPanel() {
  const panel = $('export-panel');
  const options = $('export-options');
  if (!panel || !options) return;

  options.innerHTML = '';
  for (const profile of state.audiences) {
    const id = `export-${profile.id}`;
    const wrap = document.createElement('label');
    wrap.className = 'export-option';
    wrap.setAttribute('for', id);
    wrap.innerHTML =
      `<input type="checkbox" id="${id}" value="${escapeHtml(profile.id)}"` +
      // Default to whichever cut is on screen, so the common case is one click.
      `${profile.id === state.audience ? ' checked' : ''}>` +
      '<span class="label">' +
      `<strong>${escapeHtml(profile.label)}</strong>` +
      `<span>${escapeHtml(profile.description)}</span>` +
      '</span>';
    options.appendChild(wrap);
  }

  setExportStatus('');
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeExportPanel() {
  const panel = $('export-panel');
  if (panel) panel.hidden = true;
}

function selectedAudiences() {
  return [...document.querySelectorAll('#export-options input:checked')].map((el) => el.value);
}

function setExportStatus(text, kind) {
  const el = $('export-status');
  if (!el) return;
  el.textContent = text;
  el.className = `muted small${kind ? ' ' + kind : ''}`;
}

async function onExportConfirm() {
  const audiences = selectedAudiences();
  if (audiences.length === 0) {
    setExportStatus('Select at least one report.', 'err');
    return;
  }

  const button = $('export-confirm');
  button.disabled = true;
  button.textContent = 'Exporting…';
  setExportStatus('');

  try {
    /*
     * Inside the desktop app the export always goes through the bridge, and the
     * function is checked rather than just `isDesktop`.
     *
     * The `else` branch below opens `report.html?print=1`, a page that calls
     * `window.print()` on load. Reached from inside Electron - which happened
     * whenever the bridge was there but incomplete, for instance a packaged
     * asar older than `exportPdf` - it produced exactly what was reported:
     * report windows carrying a print preview, and no file saved anywhere. It
     * is the browser's fallback and must stay unreachable from the app.
     */
    if (desktop?.isDesktop && typeof desktop.exportPdf !== 'function') {
      throw new Error(
        'This copy of GD-PerformanceShield cannot export PDFs (the desktop bridge is out of date). ' +
          'The Markdown and JSON reports are already saved - press "Show files" to open them.',
      );
    }

    if (desktop?.isDesktop) {
      const result = await desktop.exportPdf({
        baseUrl: location.origin,
        analysisId: state.analysisId,
        audiences,
        gameName: state.report?.subject?.gameName ?? 'OOM Report',
        defaultDir: state.reportDir ?? undefined,
      });

      // Whatever landed is recorded first, so a partial export still shows the
      // files that exist instead of only an error.
      adoptExportedPaths(result?.written);

      if (result?.cancelled) {
        setExportStatus('Export cancelled - nothing was written.');
      } else if (result?.ok) {
        // The paths, verbatim. "Saved 3 PDFs" was the old message, and it was
        // indistinguishable from having saved nothing.
        const paths = result.written.map((entry) => entry.path ?? entry);
        setExportStatus(`Saved to:\n${paths.join('\n')}`, 'ok');
        closeExportPanel();

        /*
         * Open the folder the files went into.
         *
         * A status line listing paths is still something to go and find by
         * hand, which was the original complaint about saving. `result.outDir`
         * rather than the session folder: the operator picks where to export,
         * and opening the wrong folder to prove the files exist would be worse
         * than opening none. Falls back to the directory of the first file.
         */
        const first = paths[0];
        // The fallback only holds if the path had a separator in it; a bare
        // file name yields itself, and opening a PDF is not showing a folder.
        const derived =
          typeof first === 'string' ? first.replace(/[\/][^\/]+$/, '') : null;
        const outDir = result.outDir ?? (derived && derived !== first ? derived : null);
        if (outDir) void revealFolder(outDir);
      } else {
        const partial = (result?.written ?? []).length;
        setExportStatus(
          `${result?.error ?? 'The export failed.'}` +
            (partial ? ` ${partial} of ${audiences.length} file(s) were written before it stopped.` : ''),
          'err',
        );
      }
    } else {
      // Browser mode cannot write a file directly, so each cut opens in its own
      // tab with the print dialog already up; the reader picks "Save as PDF".
      for (const audience of audiences) {
        window.open(
          `/api/analysis/${state.analysisId}/report.html?audience=${encodeURIComponent(audience)}&print=1`,
          '_blank',
          'noopener',
        );
      }
      setExportStatus('Choose "Save as PDF" in each print dialog.', 'ok');
    }
  } catch (err) {
    setExportStatus(err.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Export';
  }
}

// ---------------------------------------------------------------------------
// Choosing the game
// ---------------------------------------------------------------------------

/*
 * The game under test is always an app already installed on the device.
 *
 * There is deliberately no APK-file route in the console: the build is on the
 * handset by the time anyone wants to profile it, and installing one from here
 * only adds a way for the tool to profile something other than what the tester
 * is holding. `gdshield scan --apk` still takes a file, for the build-configuration
 * checks that need one.
 */

/**
 * Load the app list from the first connected device.
 *
 * Two adb calls for the whole list rather than one per app, so this stays fast
 * on a handset with a hundred apps installed.
 */
async function loadInstalledApps() {
  const list = $('appList');
  const hint = $('app-hint');

  const device = selectedDevice();
  const message = (text) => {
    list.innerHTML = `<div class="app-empty">${escapeHtml(text)}</div>`;
  };

  state.apps = [];
  state.filtered = [];
  selectApp('', { scroll: false });

  if (!device) {
    closeAppList();
    setHint(hint, 'Select a device first.', '');
    return;
  }

  message('Reading the app list from the device…');
  setHint(hint, '', 'busy');

  try {
    const result = await fetchJson(
      `/api/devices/${encodeURIComponent(device.serial)}/apps`,
    );

    if (result.error) {
      message('Could not read the app list.');
      setHint(hint, result.error, 'err');
      return;
    }

    state.apps = result.apps ?? [];
    if (state.apps.length === 0) {
      message('No user-installed apps found.');
      setHint(
        hint,
        'Only non-system apps are listed. Install the build, then press Refresh.',
        'err',
      );
      return;
    }

    // Applying the current search keeps a typed query alive across a refresh.
    filterApps();
    void resolveVisibleLabels();

    const named = state.apps.filter((a) => a.label).length;
    setHint(
      hint,
      `${state.apps.length} app(s) on ${device.model}, most recently updated first. ` +
        (named < state.apps.length
          ? 'A name in bold is derived from the package id, because Android only reports a ' +
            'literal app name when the manifest stored one. The package id is always exact.'
          : 'Nothing is installed or copied — the tool launches what is already there.'),
      '',
    );
  } catch (err) {
    message('Could not read the app list.');
    setHint(hint, err.message, 'err');
  } finally {
    refreshDisclosure();
  }
}



// ---------------------------------------------------------------------------
// App search and launch
// ---------------------------------------------------------------------------






// ---------------------------------------------------------------------------
// Memory timeline
// ---------------------------------------------------------------------------

function initTimelineView() {
  for (const button of document.querySelectorAll('.view-toggle button[data-view]')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      for (const b of document.querySelectorAll('.view-toggle button[data-view]')) {
        b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
      }
      $('timeline-hint').textContent =
        state.view === 'breakdown'
          ? 'Stacked by where the memory actually is. Hover the chart to see what was holding the most at that instant.'
          : 'Total memory per device, for comparing the low-RAM and high-RAM handsets against each other.';
      drawChart();
    });
  }
}

/**
 * One panel per device: current usage against device RAM, the chart, and a
 * legend that is always sorted largest-first.
 */
function ensureTimelinePanel(role) {
  const existing = state.panels.get(role);
  if (existing) return existing;

  const device = state.devices.find((d) => d.role === role);
  const ramLabel = device ? `${OomChart.fmt(device.totalRamBytes)} RAM` : '';
  const name = device ? `${device.manufacturer} ${device.model}` : `Device ${role}`;

  const container = document.createElement('div');
  container.className = 'device-timeline';
  container.innerHTML =
    '<div class="timeline-head">' +
    '<div class="timeline-title">' +
    `<span class="role-badge role-${escapeHtml(role)}">${escapeHtml(role)}</span>` +
    `<span>${escapeHtml(name)}</span>` +
    `<span class="muted small">${escapeHtml(ramLabel)}</span>` +
    '</div>' +
    // Frame rate sits in the timeline header, next to the memory figure, so the
    // operator watching the curve sees both without looking away.
    '<div class="panel-fps" data-fps hidden></div>' +
    '<div class="timeline-now"><strong data-now>—</strong> <span data-share></span></div>' +
    '</div>' +
    '<div class="ram-bar" data-rambar><span style="width:0%"></span></div>' +
    '<canvas class="timeline-canvas" data-canvas></canvas>' +
    '<div class="readout-at" data-at></div>' +
    '<div class="cat-legend" data-legend></div>' +
    /*
     * The drill-down sits directly beneath the chart it explains.
     *
     * It used to be the last element of a panel that also held the frame-rate
     * chart, so clicking the memory curve opened an explanation two charts
     * further down. Opening it now pushes whatever follows down, which is what
     * makes it read as belonging to the thing that was clicked.
     */
    '<div class="event-detail" data-detail hidden></div>';

  $('timelines').appendChild(container);

  /*
   * Frame rate lives in its own section, on the same clock.
   *
   * It was a strip inside the memory panel, which put a frame-rate chart and a
   * frame-rate drill-down under a heading that said "Memory timeline" - so it
   * read as a memory statistic, and its details appeared inside a panel about
   * something else. Adjacency is what lets a drop here be matched with a jump
   * there, and that survives being a sibling; nesting was never what provided
   * it.
   */
  const fpsContainer = document.createElement('div');
  fpsContainer.className = 'device-timeline';
  fpsContainer.innerHTML =
    '<div class="timeline-head">' +
    '<div class="timeline-title">' +
    `<span class="role-badge role-${escapeHtml(role)}">${escapeHtml(role)}</span>` +
    `<span>${escapeHtml(name)}</span>` +
    '</div>' +
    '<div class="timeline-now" data-fpsnote></div>' +
    '</div>' +
    '<canvas class="fps-canvas" data-fpscanvas></canvas>' +
    '<div class="event-detail" data-fpsdetail hidden></div>';

  $('fps-timelines').appendChild(fpsContainer);

  const canvas = container.querySelector('[data-canvas]');

  // Hover is tracked per panel, so each device has its own crosshair.
  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    state.hover.set(role, event.clientX - rect.left);
    drawChart();
  });
  canvas.addEventListener('mouseleave', () => {
    state.hover.delete(role);
    drawChart();
  });

  /*
   * Anywhere on the curve is clickable, not only the dots.
   *
   * Every deep sample already carries the full breakdown; a marked event is just
   * one the tool thought worth flagging. Restricting the drill-down to markers
   * hid the data behind the tool's own opinion of what mattered, so a click
   * resolves to the nearest sample and opens the same panel. Hitting a marker
   * exactly still returns that event, so the two never disagree.
   */
  canvas.addEventListener('click', (event) => {
    const marked = OomChart.hitTestEvent(canvas, event.clientX, event.clientY);
    showEventDetail(role, marked ?? OomChart.stepAtX(canvas, event.clientX));
  });

  canvas.addEventListener('mousemove', (event) => {
    canvas.style.cursor = OomChart.stepAtX(canvas, event.clientX) ? 'pointer' : 'crosshair';
  });

  /*
   * The frame-rate canvas, wired the same way as the memory one.
   *
   * Anywhere on the curve is clickable, not only the lettered dots: restricting
   * the drill-down to flagged moments would hide the data behind the tool's own
   * opinion of what mattered.
   */
  const fpsCanvas = fpsContainer.querySelector('[data-fpscanvas]');

  fpsCanvas.addEventListener('mousemove', (event) => {
    const rect = fpsCanvas.getBoundingClientRect();
    state.fpsHover.set(role, event.clientX - rect.left);
    fpsCanvas.style.cursor = OomChart.fpsAtX(fpsCanvas, event.clientX) ? 'pointer' : 'crosshair';
    drawChart();
  });
  fpsCanvas.addEventListener('mouseleave', () => {
    state.fpsHover.delete(role);
    drawChart();
  });
  fpsCanvas.addEventListener('click', (event) => {
    const marked = OomChart.hitTestFpsEvent(fpsCanvas, event.clientX, event.clientY);
    showFpsDetail(role, marked ?? OomChart.fpsAtX(fpsCanvas, event.clientX));
  });

  const panel = {
    container,
    fpsContainer,
    canvas,
    fpsCanvas,
    fpsNote: fpsContainer.querySelector('[data-fpsnote]'),
    fpsDetail: fpsContainer.querySelector('[data-fpsdetail]'),
    now: container.querySelector('[data-now]'),
    fps: container.querySelector('[data-fps]'),
    share: container.querySelector('[data-share]'),
    ramBar: container.querySelector('[data-rambar]'),
    at: container.querySelector('[data-at]'),
    legend: container.querySelector('[data-legend]'),
    detail: container.querySelector('[data-detail]'),
  };
  state.panels.set(role, panel);
  return panel;
}

/**
 * A one-line summary of the frame-rate samples so far.
 *
 * Percentiles need a few seconds of samples before they mean anything, so below
 * that it says what it is doing rather than printing a p01 computed from three
 * readings - a precise-looking number from too little data is worse than none.
 */
function fpsLadder(series, events) {
  if (series.length === 0) return '';
  if (series.length < 10) return `collecting samples (${series.length})`;

  const sorted = series.map((p) => p.fps).sort((a, b) => a - b);

  /*
   * GDPerfTracker's percentile formula, so the figure watched during a session,
   * the figure in the report and the figure in the analytics payload are all
   * the same measurement:
   *
   *     index = Clamp(RoundToInt((count - 1) * p), 0, count - 1)
   *
   * Kept in step with `fpsPercentile` in src/telemetry/deviceHealth.ts, which
   * is the source of truth and carries the reasoning. Duplicated rather than
   * imported because that is TypeScript compiled for the server and this is
   * plain JavaScript the browser loads directly.
   *
   * `roundHalfToEven` and not `Math.round`: Unity's RoundToInt is .NET's
   * `Math.Round`, which sends exact halves to the even neighbour - and an exact
   * half is what a percentile index lands on for even sample counts.
   */
  const roundHalfToEven = (value) => {
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (fraction > 0.5) return floor + 1;
    if (fraction < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
  };
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, roundHalfToEven((sorted.length - 1) * q)))];

  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;

  return (
    `avg ${mean.toFixed(0)} · p50 ${at(0.5).toFixed(0)} · p05 ${at(0.05).toFixed(0)} · ` +
    `p01 ${at(0.01).toFixed(0)} fps` +
    (events.length > 0 ? ` · ${events.length} drop(s), click one` : '')
  );
}

/** Redraw every device panel. Cheap enough to run on each sample at 1 Hz. */
/**
 * How wide the time axis should be.
 *
 * While recording it tracks the wall clock, so the curve advances into empty
 * space as it is drawn. Once capture ends it stops at the last sample: leaving
 * it on the clock kept stretching the axis after the report was built, which
 * drew an ever-growing empty gap and read as if the session were still running.
 */
function chartDurationMs(data) {
  const lastSample = Math.max(
    data.line.at(-1)?.elapsedMs ?? 0,
    data.stacks.at(-1)?.elapsedMs ?? 0,
  );
  if (!state.capturing) return lastSample;
  return state.sessionStart ? Math.max(Date.now() - state.sessionStart, lastSample) : lastSample;
}

function drawChart() {
  if (typeof OomChart === 'undefined') return;

  for (const [role, data] of state.byRole) {
    const panel = ensureTimelinePanel(role);
    const device = state.devices.find((d) => d.role === role);
    const ram = device?.totalRamBytes ?? null;

    const readout = OomChart.draw(panel.canvas, {
      mode: state.view,
      stacks: data.stacks,
      line: data.line,
      events: state.events,
      deviceRamBytes: ram,
      durationMs: chartDurationMs(data),
      hoverX: state.hover.get(role) ?? null,
      memoryEvents: state.memoryEvents.get(role) ?? [],
      selectedEvent: state.selectedEvent.get(role) ?? null,
    });

    // While hovering, the header shows the hovered instant rather than the live
    // value, so every number on screen describes the same moment as the crosshair.
    const latest = data.stacks.at(-1)?.total ?? data.line.at(-1)?.value ?? null;
    const shown = readout?.total ?? latest;

    panel.now.textContent = shown != null ? OomChart.fmt(shown) : '—';
    // The bar is scaled to the app's budget, not to device RAM: what matters is
    // how much of its allowance the app has used, and the colour is the verdict.
    const budget = device?.budget ?? null;
    if (budget && shown != null) {
      const pct = Math.min(100, (shown / budget.hardLimitBytes) * 100);
      const verdict =
        shown > budget.hardLimitBytes ? 'crit' : shown > budget.targetMaxBytes ? 'warn' : '';
      panel.ramBar.querySelector('span').style.width = `${pct}%`;
      panel.ramBar.className = `ram-bar${verdict ? ' ' + verdict : ''}`;
      panel.share.textContent =
        `of ${OomChart.fmt(budget.targetMaxBytes)} target` +
        (shown > budget.targetMaxBytes
          ? shown > budget.hardLimitBytes
            ? ' — over the practical limit'
            : ' — over target'
          : '');
    } else if (ram && shown != null) {
      const pct = Math.min(100, (shown / ram) * 100);
      panel.ramBar.querySelector('span').style.width = `${pct}%`;
      panel.ramBar.className = 'ram-bar';
    }

    /*
     * The frame-rate curve, on the same axis and the same clock as the memory
     * curve above it, with the drops lettered and clickable.
     */
    const fpsSeries = state.fpsByRole.get(role) ?? [];
    const fpsEvents = OomChart.detectFpsEvents(fpsSeries);
    const hovered = OomChart.drawFps(panel.fpsCanvas, {
      points: fpsSeries,
      // From the live status, which is the only place the refresh rate appears;
      // the device list from /api/devices does not carry it.
      displayHz: state.liveByRole.get(role)?.fpsDisplayHz ?? null,
      durationMs: chartDurationMs(data),
      hoverX: state.fpsHover.get(role) ?? null,
      events: fpsEvents,
      selectedEvent: state.selectedFpsEvent.get(role) ?? null,
    });

    if (panel.fpsNote) {
      /*
       * The percentile ladder, live.
       *
       * The same quantity the report uses - the rate over each one-second
       * sample, sorted - so a figure watched during the session and the figure
       * read afterwards are the same measurement. p01 is the one that matters
       * while playing: an average of 58 with a p01 of 12 is a game that
       * stutters, and the average alone hides it.
       */
      panel.fpsNote.textContent = hovered
        ? `${OomChart.formatClock(hovered.elapsedMs)} · ${hovered.fps.toFixed(0)} fps`
        : fpsLadder(fpsSeries, fpsEvents);
    }

    // Frame rate belongs beside the curve as well as on the card: the operator
    // is watching the graph, and a memory spike that coincides with a frame-rate
    // collapse is a different problem from one that does not.
    const live = state.liveByRole.get(role);
    if (panel.fps) {
      if (live && live.fps != null) {
        panel.fps.hidden = false;
        panel.fps.className = `panel-fps ${fpsTone(live.fps)}`;
        panel.fps.innerHTML =
          `${live.fps.toFixed(0)}<span class="unit">fps</span>` +
          (live.temperatureC != null
            ? ` <span class="sep">\u00b7</span> ${live.temperatureC.toFixed(0)}<span class="unit">\u00b0C</span>`
            : '') +
          (live.throttling ? ' <span class="thr">throttling</span>' : '');
      } else {
        panel.fps.hidden = true;
      }
    }

    panel.at.textContent = readout
      ? `at ${OomChart.formatClock(readout.elapsedMs)}`
      : latest != null
        ? 'latest sample'
        : '';

    renderLegend(panel.legend, readout, data);
  }
}

/** The legend doubles as the hover readout — same rows, same order. */
function renderLegend(el, readout, data) {
  const rows = readout?.rows?.length ? readout.rows : buildLegendRows(data.stacks.at(-1));

  if (!rows || rows.length === 0) {
    el.innerHTML = '';
    return;
  }

  const total = rows.reduce((sum, r) => sum + r.bytes, 0) || 1;
  el.innerHTML = rows
    .map(
      (r) =>
        '<div class="cat-row">' +
        `<span class="cat-swatch" style="background:${r.color}"></span>` +
        `<span class="cat-name">${escapeHtml(r.label)}</span>` +
        `<span class="cat-value">${OomChart.fmt(r.bytes)}</span>` +
        `<span class="cat-share">${Math.round((r.bytes / total) * 100)}%</span>` +
        '</div>',
    )
    .join('');
}

function buildLegendRows(stackPoint) {
  if (!stackPoint) return [];
  const root = getComputedStyle(document.documentElement);
  return OomChart.CATEGORIES.map((c) => ({
    label: c.label,
    color: root.getPropertyValue(c.varName).trim() || '#888',
    bytes: stackPoint.cats[c.key] ?? 0,
  }))
    .filter((r) => r.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// Installed-app list
// ---------------------------------------------------------------------------

/**
 * A readable name for an app.
 *
 * Android only reports a literal label when the manifest stored one; most apps
 * use a string resource, which needs resources.arsc to resolve and is not worth
 * pulling a 500 MB APK for. When there is no label, the name is derived from the
 * package's last segment - `com.studio.PenguinRush` reads as "Penguin Rush".
 *
 * The derivation is a guess, which is why the package id is always shown beside
 * it: the reader can see exactly what was matched.
 */
function deriveAppName(app) {
  if (app.label) return app.label;

  // Trailing segments that name a platform rather than the game.
  const GENERIC = new Set(['android', 'app', 'application', 'game', 'mobile', 'free', 'main']);

  const segments = app.packageName.split('.').filter(Boolean);
  let segment = segments.at(-1) ?? app.packageName;
  if (GENERIC.has(segment.toLowerCase()) && segments.length > 1) {
    segment = segments.at(-2) ?? segment;
  }

  // Split camelCase and separators: "PenguinRush" -> "Penguin Rush".
  const words = segment
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Filter as the operator types.
 *
 * The search box lives inside the dropdown, so its contents are always a query;
 * the chosen app is displayed on the closed dropdown button instead. That split
 * is what removes the old ambiguity between "this is my search" and "this is my
 * selection" living in the same field.
 */
function filterApps() {
  const query = ($('appSearch').value || '').trim().toLowerCase();

  state.filtered = query
    ? state.apps.filter(
        (a) =>
          a.packageName.toLowerCase().includes(query) ||
          deriveAppName(a).toLowerCase().includes(query),
      )
    : state.apps;

  renderAppList(query);

  // Names for newly visible rows, once typing pauses.
  clearTimeout(state.labelTimer);
  state.labelTimer = setTimeout(() => void resolveVisibleLabels(), 350);
}

/** The text shown in the search box while an app is selected. */
function selectedDisplayText() {
  const app = state.apps.find((a) => a.packageName === state.selectedPackage);
  if (!app) return '';
  // Prefer the real name; fall back to the package id rather than a guess, so
  // the box never displays something that is simply wrong.
  return app.label ?? app.packageName;
}

function renderAppList(query = '') {
  const list = $('appList');
  if (!list) return;

  if (state.filtered.length === 0) {
    list.innerHTML = `<div class="app-empty">${
      query
        ? `No app matches "${escapeHtml(query)}".`
        : 'No user-installed apps found. Install the build, then press Refresh.'
    }</div>`;
    return;
  }

  list.innerHTML = state.filtered.map((a) => renderAppRow(a)).join('');
}

/**
 * One row.
 *
 * The name is only shown once it is known. While a real name is still being read
 * off the device the package id takes the name slot, so a row never shows a
 * confident-looking name that is about to be replaced by a different one - the
 * derived guesses were genuinely wrong ("Games" for two different apps), and
 * watching them correct themselves reads as a bug.
 */
function renderAppRow(app) {
  const selected = app.packageName === state.selectedPackage;
  const status = state.labels.get(app.packageName);

  let nameCell;
  let packageCell;

  if (app.label) {
    // Read from the APK's resource table: the name shown under the app's icon.
    nameCell = `<span class="app-name">${escapeHtml(app.label)}</span>`;
    packageCell = `<span class="app-pkg">(${escapeHtml(app.packageName)})</span>`;
  } else if (status === null) {
    // In flight. The package id is always true, so it holds the slot.
    nameCell = `<span class="app-name pending">${escapeHtml(app.packageName)}</span>`;
    packageCell = '<span class="app-pkg">reading name…</span>';
  } else {
    // Resolution finished without a name, so the best guess is all there is -
    // marked as derived, with the exact id beside it.
    nameCell = `<span class="app-name derived">${escapeHtml(deriveAppName(app))}</span>`;
    packageCell = `<span class="app-pkg">(${escapeHtml(app.packageName)})</span>`;
  }

  return (
    `<div class="app-item" role="option" data-package="${escapeHtml(app.packageName)}"` +
    ` aria-selected="${selected}">` +
    nameCell +
    packageCell +
    (app.debuggable ? '<span class="app-flag">debuggable</span>' : '') +
    `<span class="app-ver">${app.versionName ? 'v' + escapeHtml(app.versionName) : ''}</span>` +
    '</div>'
  );
}

/**
 * Select an app.
 *
 * The single place selection changes. `collapse` closes the dropdown, which is
 * what a click or Enter means: selecting is a decision, not a preview. The
 * analysis launches the game itself, so there is nothing else to press.
 */
function selectApp(packageName, opts = {}) {
  state.selectedPackage = packageName;
  $('appSelect').value = packageName;

  // Awaited nowhere: the name lands in the field when it arrives, and the rest
  // of selection must not wait on a device round trip.
  if (packageName) void ensureLabelFor(packageName);
  // No app means no derived title. Reached when the device changes, which
  // clears the selection: the old game's name must not outlive it.
  else autofillFromPackage();

  if (opts.collapse && packageName) {
    closeAppList();
    renderChosenApp();
    refreshDisclosure();
    return;
  }

  for (const row of document.querySelectorAll('#appList .app-item')) {
    const isMatch = row.dataset.package === packageName;
    row.setAttribute('aria-selected', String(isMatch));
    if (isMatch && opts.scroll !== false) row.scrollIntoView({ block: 'nearest' });
  }
  renderChosenApp();
  refreshDisclosure();
}

function openAppList() {
  if ($('appToggle').disabled) return;
  state.listOpen = true;
  $('appPopup').hidden = false;
  $('appToggle').setAttribute('aria-expanded', 'true');
  filterApps();
  $('appSearch').focus();
  $('appSearch').select();
}

function closeAppList() {
  state.listOpen = false;
  $('appPopup').hidden = true;
  $('appToggle').setAttribute('aria-expanded', 'false');

  // Reopening after a choice nearly always means picking a *different* app, so
  // the spent query does not survive: the list comes back whole rather than
  // still filtered down to the app that was just chosen.
  $('appSearch').value = '';
  state.filtered = state.apps;

  renderToggleLabel();
}

function toggleAppList() {
  if (state.listOpen) closeAppList();
  else openAppList();
}

/**
 * What the closed dropdown reads.
 *
 * The package id rides along with the name because a derived name is a guess,
 * and the operator is about to profile whatever this says - the exact id is the
 * only part that cannot be wrong.
 */
function renderToggleLabel() {
  const el = $('appToggleLabel');
  const app = state.apps.find((a) => a.packageName === state.selectedPackage);

  if (!app) {
    el.textContent = selectedDevice() ? 'Select an installed app…' : 'No device';
    return;
  }
  el.innerHTML =
    `${escapeHtml(app.label ?? deriveAppName(app))}` +
    `<span class="pkg">${escapeHtml(app.packageName)}</span>`;
}

/**
 * Confirmation line under the dropdown.
 *
 * States the exact package and version, so a derived name in the button above
 * can never be mistaken for what is really being profiled.
 */
function renderChosenApp() {
  const el = $('app-hint');
  if (!el) return;

  renderToggleLabel();
  if (state.listOpen || !state.selectedPackage) return;

  const app = state.apps.find((a) => a.packageName === state.selectedPackage);
  if (!app) return;

  el.className = 'hint ok';
  el.innerHTML =
    `Will profile <code>${escapeHtml(app.packageName)}</code>` +
    (app.versionName ? ` v${escapeHtml(app.versionName)}` : '') +
    (app.debuggable ? ' <span class="app-flag">debuggable</span>' : '') +
    '. The analysis launches it on the device — nothing is installed or copied.';
}

function initAppList() {
  const list = $('appList');

  $('appToggle').addEventListener('click', toggleAppList);

  // Clicking anywhere outside closes it, the way a native dropdown does.
  document.addEventListener('mousedown', (event) => {
    if (state.listOpen && !$('appCombo').contains(event.target)) closeAppList();
  });

  // Delegated, so it keeps working after every re-render.
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.app-item');
    if (row?.dataset.package) selectApp(row.dataset.package, { collapse: true });
  });

  list.addEventListener('keydown', (event) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    // Enter confirms the highlighted row and closes the dropdown. It does not
    // start the game: that is the analysis's job.
    if (event.key === 'Enter') {
      if (state.selectedPackage) selectApp(state.selectedPackage, { collapse: true });
      return;
    }
    if (event.key === 'Escape') {
      closeAppList();
      $('appToggle').focus();
      return;
    }

    const index = state.filtered.findIndex((a) => a.packageName === state.selectedPackage);
    const last = state.filtered.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : Math.min(last, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));

    const target = state.filtered[next];
    if (target) selectApp(target.packageName);
  });

  const search = $('appSearch');

  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Confirm the top match without leaving the keyboard.
      const first = state.filtered[0];
      if (first) selectApp(first.packageName, { collapse: true });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAppList();
      $('appToggle').focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.focus();
      const first = state.filtered[0];
      if (first && !state.selectedPackage) selectApp(first.packageName);
    }
  });

  // With ~200 apps installed, reading every name would be hundreds of device
  // round trips. Names are read for what has actually been scrolled into view.
  list.addEventListener('scroll', () => {
    clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => void resolveVisibleLabels(), 200);
  });
}

/** Fill in the game name from the chosen app, if the field is still empty. */
function autofillFromPackage() {
  const nameField = $('gameName');
  const chosen = state.apps.find((a) => a.packageName === state.selectedPackage);
  // Only a name actually read from the APK. A derived guess would end up as the
  // title of a report sent to a studio.
  const next = chooseGameName(nameField.value, state.autofilledName, chosen?.label ?? '');
  if (next === null) return;

  nameField.value = next;
  state.autofilledName = next;
}

/**
 * Read the chosen app's display name now, rather than waiting for the sweep.
 *
 * Names are otherwise fetched only for the rows on screen, which is right while
 * the operator is scrolling and wrong the moment they choose one: choosing is
 * exactly when the name is needed. Selecting an app before its row's name had
 * arrived left the title field empty, and an empty title is submitted as
 * "Unnamed game" - which is how a session of `com.gdm.prison.guard` came out
 * filed under a folder called `unnamed-game`, while an earlier session of the
 * same package on the same phone was named correctly. It was a race, and it
 * resolved differently depending on how fast the operator picked.
 *
 * Cheap: one app, and only when its name is not already known.
 */
async function ensureLabelFor(packageName) {
  if (!packageName || !state.deviceSerial) return;

  /*
   * Drop our own stale text first. Reading a label takes about 770 ms, and for
   * that whole window the field would otherwise still show the name of the app
   * chosen before this one - which is exactly long enough for the operator to
   * press Analyze and file the session under the wrong game.
   */
  autofillFromPackage();

  const app = state.apps.find((a) => a.packageName === packageName);
  if (!app || app.label || !app.apkPath) {
    autofillFromPackage();
    return;
  }

  try {
    const serial = state.deviceSerial;
    const result = await fetchJson(`/api/devices/${encodeURIComponent(serial)}/app-labels`, {
      method: 'POST',
      body: { apps: [{ packageName, apkPath: app.apkPath }] },
    });
    const label = (result.labels ?? {})[packageName];
    if (label) {
      state.labels.set(packageName, label);
      app.label = label;
      renderChosenApp();
    }
  } catch (err) {
    // A name is a convenience, not a blocker. The operator can still type one.
    console.warn('Could not read the name of the chosen app:', err.message);
  } finally {
    // Either way, fill the field from whatever is known now.
    autofillFromPackage();
  }
}

/**
 * Fetch the real display names for the rows currently on screen.
 *
 * Each name costs several device round trips, so only what is visible is
 * requested, results are cached for the session, and rows update in place as
 * they arrive rather than blocking the list.
 */
async function resolveVisibleLabels() {
  if (!state.deviceSerial) return;

  const pending = visibleApps()
    .filter((a) => a.apkPath && !state.labels.has(a.packageName))
    .map((a) => ({ packageName: a.packageName, apkPath: a.apkPath }));

  if (pending.length === 0) return;

  // Mark as in-flight so a re-render while typing does not request them again.
  for (const a of pending) state.labels.set(a.packageName, null);

  const hint = $('app-hint');
  const previousHint = { html: hint.innerHTML, className: hint.className };
  const restoreHint = () => {
    hint.innerHTML = previousHint.html;
    hint.className = previousHint.className;
  };
  setHint(hint, `Reading app names from ${pending.length} app(s) on the device…`, 'busy');

  try {
    const serial = state.deviceSerial;
    const result = await fetchJson(`/api/devices/${encodeURIComponent(serial)}/app-labels`, {
      method: 'POST',
      body: { apps: pending },
    });

    for (const [packageName, label] of Object.entries(result.labels ?? {})) {
      state.labels.set(packageName, label);
      const app = state.apps.find((a) => a.packageName === packageName);
      if (app) app.label = label;
    }

    // A name that arrives after the app was chosen still belongs in the title
    // field. Without this the field kept whatever it had when the click landed.
    autofillFromPackage();

    // Anything not returned failed: mark it so the row falls back to a derived
    // name instead of waiting forever.
    for (const a of pending) {
      if (state.labels.get(a.packageName) === null) state.labels.set(a.packageName, false);
    }

    const found = Object.keys(result.labels ?? {}).length;
    if (found === pending.length) restoreHint();
    else {
      setHint(
        hint,
        `${pending.length - found} app(s) did not report a display name; their package id is shown instead.`,
        '',
      );
    }

    renderAppList(($('appSearch').value || '').trim().toLowerCase());
  } catch (err) {
    restoreHint();
    for (const a of pending) {
      if (state.labels.get(a.packageName) === null) state.labels.set(a.packageName, false);
    }
    renderAppList(($('appSearch').value || '').trim().toLowerCase());
    // A name is a convenience: log it and leave the derived one in place.
    console.warn('Could not read app names:', err.message);
  }
}

/**
 * The rows currently within the scrolled viewport, plus a screen of lookahead.
 *
 * Reading a name costs several device round trips, so the work follows the
 * operator's attention rather than the whole list.
 */
function visibleApps() {
  const list = $('appList');
  if (!list || state.filtered.length === 0) return [];

  const rowHeight = list.querySelector('.app-item')?.offsetHeight || 36;
  const first = Math.floor(list.scrollTop / rowHeight);
  const onScreen = Math.ceil(list.clientHeight / rowHeight) || 6;

  return state.filtered.slice(Math.max(0, first - 2), first + onScreen * 2 + 2);
}

// ---------------------------------------------------------------------------
// Memory event details
// ---------------------------------------------------------------------------

/**
 * The likely cause of a frame-rate drop, from what the live view can see.
 *
 * Deliberately weaker than the report's diagnosis, and says so. The report has
 * the GPU, CPU threads, storage and audio sampled on one clock; this has two
 * curves and the device sensors. What it can do honestly is the one correlation
 * that matters most and is available here - a memory jump at the same instant -
 * plus the two device-level explanations that need no extra sampling.
 *
 * The order is by how much the evidence actually supports the claim, and the
 * last branch says nothing rather than picking the most common answer. A
 * confident wrong cause during a session is worse than none: it sends someone
 * to the wrong part of the project before the report even exists.
 */
function explainFpsMoment(event, memoryStep, live, context) {
  const MB = 1024 * 1024;

  /*
   * A point picked off the curve, not a drop the tool flagged.
   *
   * Clicking anywhere is allowed on purpose, so most clicks land on ordinary
   * seconds - and answering those with statistics and no verdict was the
   * complaint: the memory chart explains wherever it is clicked, and this did
   * not. A rate holding near what the game had been achieving is itself the
   * answer, and saying so is more useful than leaving the reader to compare two
   * numbers themselves.
   */
  const reference = context?.reference ?? null;
  const isFlaggedDrop = event.kind === 'drop';

  if (!isFlaggedDrop && reference !== null && reference > 0) {
    const share = event.lowestFps / reference;
    if (share >= 0.9) {
      return {
        tone: 'good',
        headline: 'Running normally at this moment',
        reason:
          `${event.lowestFps} fps against the ${reference.toFixed(0)} fps this session has been ` +
          'holding, so nothing was going wrong here. The figures above are what every subsystem ' +
          'was doing while it was going right, which is what a drop elsewhere gets compared to.',
      };
    }
    // Below the reference but not enough to be flagged: fall through to the
    // same evidence chain a flagged drop uses, since the question is the same.
  }

  // A memory jump in the same window, which is what an unbudgeted asset load
  // looks like from outside the process.
  if (memoryStep && memoryStep.delta >= 40 * MB) {
    const top = (memoryStep.moved ?? []).filter((m) => m.delta > 0).slice(0, 2);
    const named = top.length > 0
      ? top.map((m) => `${m.label} +${OomChart.fmt(m.delta)}`).join(', ')
      : null;
    return {
      tone: 'bad',
      headline: 'Loading — memory grew at the same moment',
      reason:
        `Memory rose ${OomChart.fmt(memoryStep.delta)} between the samples either side of this ` +
        `drop${named ? ` (${named})` : ''}. Allocating and uploading assets stalls the frame that ` +
        'does it, so a jump this size beside a drop this size is usually the same event.',
    };
  }

  // Heat, which the device reports directly and which no other explanation
  // should be allowed to outrank: a throttled phone cannot hit its frame rate
  // however well the game is written.
  if (live?.throttling) {
    return {
      tone: 'bad',
      headline: 'Thermal throttling',
      reason:
        `The device reported it was limiting its own performance` +
        (live.temperatureC != null ? ` at ${live.temperatureC.toFixed(1)} °C` : '') +
        '. Frame rate cannot be judged against the build while this is happening - the hardware ' +
        'is not giving the game the clocks it had at the start.',
    };
  }

  if (live?.temperatureC != null && live.temperatureC >= 45) {
    return {
      tone: 'watch',
      headline: 'The device is hot',
      reason:
        `${live.temperatureC.toFixed(1)} °C, which is hot enough that the phone may be reducing ` +
        'clocks without having declared it. Worth re-running from cold to see whether the drop ' +
        'survives.',
    };
  }

  /*
   * A single long frame against a run of slow ones. The distinction is the
   * useful half: one stalled frame is a hitch to hunt down, a stretch of slow
   * ones is a scene that costs more than the device can give.
   */
  if (isFlaggedDrop && event.durationMs && event.durationMs <= 1500 && event.janks <= 2) {
    return {
      tone: 'watch',
      headline: 'A single stalled frame',
      reason:
        'The rate recovered within about a second, so this is one frame that took far too long ' +
        'rather than a stretch the device could not keep up with. Usually a synchronous load, a ' +
        'shader compiled on first use, or a garbage collection.',
    };
  }

  if (isFlaggedDrop && event.windows >= 3) {
    return {
      tone: 'watch',
      headline: 'Sustained — the scene cost more than the device could give',
      reason:
        `The rate stayed down for about ${Math.round((event.durationMs ?? 0) / 1000)} s rather than ` +
        'dipping once, which points at what is on screen rather than at a one-off stall. The ' +
        'report separates CPU from GPU for this window.',
    };
  }

  return {
    tone: 'flat',
    headline: 'Not clear from the live view',
    reason:
      `Neither memory nor the device sensors moved ${isFlaggedDrop ? 'with this drop' : 'at this moment'}. ` +
      'That does not make it unexplained - the report correlates the GPU, the CPU threads, storage ' +
      'and audio for this moment, and one of those is where an answer is most likely to be.',
  };
}

/**
 * What happened at a frame-rate drop, opened by clicking it.
 *
 * The live counterpart of the report's spike detail: the same figures, in the
 * same order, while the session is still running. Memory is read off the memory
 * curve at the same instant, which is the one correlation worth making here -
 * a drop that lines up with a jump is one event, and the operator can see that
 * before the report exists.
 *
 * It stops short of naming a culprit. The report has five subsystems sampled on
 * one clock to draw from; this has two curves, and guessing from two would
 * produce a confident answer the report might then contradict.
 */
function showFpsDetail(role, event) {
  const panel = state.panels.get(role);
  if (!panel || !panel.fpsDetail) return;

  state.selectedFpsEvent.set(role, event);
  // Opening a different moment starts a fresh drill-down.
  state.fpsExpandedCategory.delete(role);
  state.fpsExpandedRow.delete(role);

  if (!event) {
    panel.fpsDetail.hidden = true;
    state.fpsMemoryStep.delete(role);
    drawChart();
    return;
  }

  const isDrop = event.kind === 'drop';
  const heading = isDrop
    ? `${event.letter ? event.letter + ' · ' : ''}Frame-rate drop at ${OomChart.formatClock(event.atMs)}`
    : `Frame rate at ${OomChart.formatClock(event.atMs)}`;

  const rows = [];
  if (event.beforeFps != null) {
    rows.push([
      'Frame rate',
      `${event.beforeFps} → ${event.lowestFps} fps` +
        (event.afterFps != null ? `, back to ${event.afterFps}` : ''),
    ]);
  } else {
    rows.push(['Frame rate', `${event.lowestFps} fps`]);
  }
  if (event.changePercent) {
    rows.push(['Drop', `${Math.abs(event.changePercent).toFixed(0)}%`]);
  }
  if (event.durationMs) {
    rows.push(['Lasted', `${(event.durationMs / 1000).toFixed(1)} s`]);
  }
  if (event.janks) rows.push(['Stutter', `${event.janks} jank(s)`]);

  /*
   * Memory at the same instant, from the curve above.
   *
   * `stepAtX` needs a click position, so the sample is found directly instead:
   * the two charts share a clock, so the nearest memory sample to this moment
   * is the memory reading for it.
   */
  const data = state.byRole.get(role);
  const stacks = data?.stacks ?? [];
  let memoryStep = null;
  let sharedEvent = null;

  /*
   * The memory event at this moment, when there is one.
   *
   * Preferred over the nearest pair of samples because it is *lettered*: the
   * same badge is on the memory chart above, so naming it here is what turns
   * two charts into one finding. A reader who is told this drop is memory
   * event B can look at B and see the same jump, rather than being left to
   * line up two timelines by eye.
   */
  for (const candidate of state.memoryEvents.get(role) ?? []) {
    if (!candidate.letter) continue;
    const within =
      (event.atMs >= candidate.fromMs - 2000 && event.atMs <= candidate.elapsedMs + 4000) ||
      Math.abs(candidate.elapsedMs - event.atMs) <= 6000;
    if (within) {
      sharedEvent = candidate;
      memoryStep = candidate;
      break;
    }
  }

  if (stacks.length > 0) {
    const near = stacks.reduce((best, p) =>
      Math.abs(p.elapsedMs - event.atMs) < Math.abs(best.elapsedMs - event.atMs) ? p : best,
    );
    // Only when the samples are genuinely close: memory is sampled every few
    // seconds, and a reading half a minute away is not "at the same moment".
    if (Math.abs(near.elapsedMs - event.atMs) <= 6000) {
      // Falls back to the plain step between samples where no event was
      // flagged, so an ordinary second still gets its breakdown.
      if (!memoryStep) {
        const previous = stacks.filter((p) => p.elapsedMs < near.elapsedMs).at(-1);
        if (previous) memoryStep = OomChart.buildStep(previous, near);
      }
      rows.push([
        'Memory',
        OomChart.fmt(near.total) +
          (memoryStep
            ? ` (${memoryStep.delta > 0 ? '+' : ''}${OomChart.fmt(memoryStep.delta)} over the step)`
            : ''),
      ]);
    }
  }

  state.fpsMemoryStep.set(role, memoryStep);

  const live = state.liveByRole.get(role);
  if (live?.temperatureC != null) {
    rows.push(['Device heat', `${live.temperatureC.toFixed(1)} °C${live.throttling ? ' — throttling' : ''}`]);
  }

  /*
   * What the game had been achieving, so a clicked second can be judged.
   *
   * The median of the samples rather than the panel rate: a 30 fps build on a
   * 60 Hz screen is doing what it was asked, and measuring every click against
   * 60 would call the whole session a problem.
   */
  const series = state.fpsByRole.get(role) ?? [];
  const sortedFps = series.map((p) => p.fps).sort((a, b) => a - b);
  const reference =
    sortedFps.length > 0 ? sortedFps[Math.floor(sortedFps.length / 2)] : null;

  const cause = explainFpsMoment(event, memoryStep, live, { reference });

  const marker = [...state.events]
    .filter((e) => e.source === 'operator' && e.elapsedMs <= event.atMs)
    .sort((a, b) => b.elapsedMs - a.elapsedMs)[0];

  // The same head and close control the memory detail panel uses, so the two
  // drill-downs look like one feature rather than two.
  panel.fpsDetail.hidden = false;
  panel.fpsDetail.innerHTML =
    '<div class="event-head">' +
    `<strong>${escapeHtml(heading)}</strong>` +
    (event.changePercent
      ? `<span class="event-delta up">${Math.abs(event.changePercent).toFixed(0)}%</span>`
      : '') +
    '<button type="button" class="event-close" aria-label="Close">&times;</button>' +
    '</div>' +
    (marker
      ? `<p class="small">Most recent marker: <strong>${escapeHtml(marker.label)}</strong> at ${OomChart.formatClock(marker.elapsedMs)}.</p>`
      : '<p class="muted small">No operator marker before this point, so what the game was doing is unrecorded.</p>') +
    '<div class="fps-rows">' +
    rows
      .map(
        ([k, v]) =>
          `<div class="fps-row"><span class="muted">${escapeHtml(k)}</span>` +
          `<strong>${escapeHtml(String(v))}</strong></div>`,
      )
      .join('') +
    '</div>' +
    // The verdict, for every click and not only for flagged drops: it is what
    // the panel was opened for, and the memory chart has always done this.
    `<div class="fps-cause ${cause.tone}">` +
    `<strong>${isDrop ? 'Most likely' : 'Reading'}:</strong> ${escapeHtml(cause.headline)}` +
    `<div class="muted small">${escapeHtml(cause.reason)}</div></div>` +
    /*
     * The same breakdown the memory panel gives, on the same step.
     *
     * This panel used to stop at a one-line verdict, so the question it left
     * open - *what* was loading - had to be answered by finding the moment
     * again on the memory chart and clicking it there. Both charts share a
     * clock, so the categories that moved here are the categories that moved
     * there: it is one set of numbers, and showing it twice is cheaper for the
     * reader than making them join it up.
     */
    (memoryStep
      ? '<div class="event-breakdown">' +
        '<div class="ev-head">' +
        (sharedEvent
          ? `Memory event <span class="shared-letter">${escapeHtml(sharedEvent.letter)}</span> ` +
            'is at this moment' +
            '<span class="muted"> — the same jump, marked on the chart above</span>'
          : 'What memory did over this step') +
        '<span class="muted"> — open a row to see inside it</span>' +
        '</div>' +
        '<div class="cat-rows" data-fpscatrows></div>' +
        '</div>'
      : '<p class="muted small">No memory sample close enough to this moment to break down. ' +
        'Memory is read every few seconds, so a frame that dropped between two of them has no ' +
        'reading of its own.</p>') +
    '<p class="muted small">Judged from the two live curves and the device sensors. The report ' +
    'reaches a fuller verdict, because it also has the GPU, the CPU threads, storage and audio ' +
    'on the same clock.</p>';

  renderFpsMovedRows(role);

  panel.fpsDetail.querySelector('.event-close').addEventListener('click', () => {
    showFpsDetail(role, null);
  });

  drawChart();
}

/**
 * Show what happened at a point on the curve.
 *
 * The category that moved says what *kind* of work it was; the nearest marker
 * says what the player was doing. What it deliberately does not claim is which
 * asset or which line of code - Android reports memory by mapping, not by engine
 * object, so naming the asset is the static analysis's job. Saying so keeps a
 * plausible guess from being read as a measurement.
 */
function showEventDetail(role, event) {
  const panel = state.panels.get(role);
  if (!panel) return;

  state.selectedEvent.set(role, event);
  // Opening a different point starts a fresh drill-down.
  state.expandedCategory.delete(role);
  state.expandedRow.delete(role);

  if (!event) {
    panel.detail.hidden = true;
    drawChart();
    return;
  }

  // A step the tool marked is described by what it was; one the operator picked
  // off the curve is described by when it was, because nothing about it is
  // necessarily notable and saying "Asset upload" over a 2 MB drift would be an
  // invention.
  const notable = event.notable !== false;
  const kind = OomChart.describeEventKind(event.kind);
  const heading = notable
    ? kind.label
    : `Memory at ${OomChart.formatClock(event.elapsedMs)}`;
  const rising = event.delta > 0;

  // What the operator marked most recently before this point.
  const marker = [...state.events]
    .filter((e) => e.source === 'operator' && e.elapsedMs <= event.elapsedMs)
    .sort((a, b) => b.elapsedMs - a.elapsedMs)[0];

  // Anything the system logged during the step.
  const logs = state.logs
    .filter((l) => l.elapsedMs >= event.fromMs - 500 && l.elapsedMs <= event.elapsedMs + 500)
    .slice(-4);

  panel.detail.hidden = false;
  panel.detail.innerHTML =
    '<div class="event-head">' +
    `<strong>${escapeHtml(heading)}</strong>` +
    `<span class="event-delta ${rising ? 'up' : 'down'}">${rising ? '+' : ''}${OomChart.fmt(event.delta)}</span>` +
    `<span class="muted small">${OomChart.formatClock(event.fromMs)} → ${OomChart.formatClock(event.elapsedMs)}</span>` +
    '<button type="button" class="event-close" aria-label="Close">&times;</button>' +
    '</div>' +
    (notable
      ? `<p class="muted small">${escapeHtml(kind.means)}</p>`
      : '<p class="muted small">A sample you picked off the curve, not a step the tool flagged. ' +
        'The figures below are the change since the previous deep sample.</p>') +
    (marker
      ? `<p class="small">Most recent marker: <strong>${escapeHtml(marker.label)}</strong> at ${OomChart.formatClock(marker.elapsedMs)}.</p>`
      : '<p class="muted small">No operator marker before this point, so what the game was doing is unrecorded.</p>') +
    '<div class="event-breakdown">' +
    '<div class="ev-head">What moved <span class="muted">— open a row to see inside it</span></div>' +
    '<div class="cat-rows" id="cat-rows"></div>' +
    '</div>' +
    (logs.length
      ? '<div class="event-logs"><div class="ev-head">System log during this step</div>' +
        logs
          .map(
            (l) =>
              `<div class="row"><span class="t">${OomChart.formatClock(l.elapsedMs)}</span>` +
              `<span>[${escapeHtml(l.tag)}] ${escapeHtml(String(l.message).slice(0, 110))}</span></div>`,
          )
          .join('') +
        '</div>'
      : '') +
    '<p class="event-caveat">' +
    'Everything here is measured by the operating system, which reports memory by mapping rather ' +
    'than by engine object. It can name the kind of memory, the driver, and the file — never the ' +
    'individual texture or line of code. Pair it with the static findings in the report: where a ' +
    'measured jump and a predicted cost agree, the report names the asset.' +
    '</p>';

  panel.detail.querySelector('.event-close').addEventListener('click', () => {
    showEventDetail(role, null);
  });

  renderMovedRows(role);
  drawChart();
}

// ---------------------------------------------------------------------------
// Drilling into a category
// ---------------------------------------------------------------------------

/**
 * The category breakdown inside the frame-rate panel.
 *
 * Deliberately the same rows, swatches and drill-down the memory panel uses:
 * they are the same numbers over the same step, and giving them a different
 * appearance in the two places would suggest they were different measurements.
 *
 * It keeps its own expansion state rather than sharing the memory panel's, so
 * opening Graphics here does not silently open it there - both panels can be
 * on screen at once, and a click in one should not move the other.
 */
function renderFpsMovedRows(role) {
  const panel = state.panels.get(role);
  const step = state.fpsMemoryStep.get(role);
  const container = panel?.fpsDetail?.querySelector('[data-fpscatrows]');
  if (!container || !step) return;

  const moved = step.moved ?? [];
  if (moved.length === 0) {
    container.innerHTML =
      '<p class="drill-note">No category moved by more than a megabyte over this step, so the ' +
      'memory that was already there is what the game was working with.</p>';
    return;
  }

  const openKey = state.fpsExpandedCategory.get(role) ?? null;

  container.innerHTML = moved
    .map((m) => {
      const isOpen = m.key === openKey;
      const canOpen = (OomChart.CATEGORY_DETAIL[m.key] ?? []).length > 0;
      return (
        `<div class="cat-row${canOpen ? ' expandable' : ''}${isOpen ? ' open' : ''}"` +
        (canOpen ? ` data-category="${escapeHtml(m.key)}" role="button" tabindex="0"` : '') +
        ` aria-expanded="${isOpen}">` +
        `<span class="cat-caret">${canOpen ? '▸' : ''}</span>` +
        `<span class="cat-swatch" style="background:${themeColor(m.varName, '#888')}"></span>` +
        `<span class="cat-name">${escapeHtml(m.label)}</span>` +
        `<span class="cat-value">${m.delta > 0 ? '+' : ''}${OomChart.fmt(m.delta)}</span>` +
        '</div>' +
        (isOpen ? `<div class="cat-drill">${renderFpsDrill(role, step, m)}</div>` : '')
      );
    })
    .join('');

  for (const row of container.querySelectorAll('.cat-row.expandable')) {
    const open = () => {
      const key = row.dataset.category;
      if (state.fpsExpandedCategory.get(role) === key) state.fpsExpandedCategory.delete(role);
      else state.fpsExpandedCategory.set(role, key);
      state.fpsExpandedRow.delete(role);
      renderFpsMovedRows(role);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  }

  for (const row of container.querySelectorAll('.drill-row')) {
    row.addEventListener('click', () => {
      const id = row.dataset.rowId;
      if (state.fpsExpandedRow.get(role) === id) state.fpsExpandedRow.delete(role);
      else state.fpsExpandedRow.set(role, id);
      renderFpsMovedRows(role);
    });
  }
}

/**
 * What is inside one category, for the frame-rate panel.
 *
 * `renderDrill` reads the memory panel's expansion state directly, so it cannot
 * be called from here without the two panels fighting over which row is open.
 * The expansion key is swapped for this panel's own and then restored, which
 * keeps one implementation of the drill-down rather than a second copy of it
 * that would drift.
 */
function renderFpsDrill(role, step, moved) {
  const memoryKey = state.expandedRow.get(role);
  const fpsKey = state.fpsExpandedRow.get(role);

  if (fpsKey === undefined) state.expandedRow.delete(role);
  else state.expandedRow.set(role, fpsKey);

  try {
    return renderDrill(role, step, moved);
  } finally {
    if (memoryKey === undefined) state.expandedRow.delete(role);
    else state.expandedRow.set(role, memoryKey);
  }
}

/**
 * The "What moved" list, with one category open at a time.
 *
 * One open row rather than many: the question being asked is "what caused *this*
 * spike", and two lists of sub-rows side by side invite comparing numbers that
 * belong to different categories.
 */
function renderMovedRows(role) {
  const panel = state.panels.get(role);
  const event = state.selectedEvent.get(role);
  const container = panel?.detail.querySelector('#cat-rows');
  if (!container || !event) return;

  const openKey = state.expandedCategory.get(role) ?? null;

  container.innerHTML = event.moved
    .map((m) => {
      const isOpen = m.key === openKey;
      const canOpen = (OomChart.CATEGORY_DETAIL[m.key] ?? []).length > 0;
      return (
        `<div class="cat-row${canOpen ? ' expandable' : ''}${isOpen ? ' open' : ''}"` +
        (canOpen ? ` data-category="${escapeHtml(m.key)}" role="button" tabindex="0"` : '') +
        ` aria-expanded="${isOpen}">` +
        `<span class="cat-caret">${canOpen ? '▸' : ''}</span>` +
        `<span class="cat-swatch" style="background:${themeColor(m.varName, '#888')}"></span>` +
        `<span class="cat-name">${escapeHtml(m.label)}</span>` +
        `<span class="cat-value">${m.delta > 0 ? '+' : ''}${OomChart.fmt(m.delta)}</span>` +
        '</div>' +
        (isOpen ? `<div class="cat-drill">${renderDrill(role, event, m)}</div>` : '')
      );
    })
    .join('');

  for (const row of container.querySelectorAll('.cat-row.expandable')) {
    const open = () => {
      const key = row.dataset.category;
      if (state.expandedCategory.get(role) === key) state.expandedCategory.delete(role);
      else state.expandedCategory.set(role, key);
      state.expandedRow.delete(role);
      renderMovedRows(role);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  }

  for (const row of container.querySelectorAll('.drill-row')) {
    row.addEventListener('click', () => {
      const id = row.dataset.rowId;
      if (state.expandedRow.get(role) === id) state.expandedRow.delete(role);
      else state.expandedRow.set(role, id);
      renderMovedRows(role);
    });
  }
}

/**
 * What is inside one category, over this step.
 *
 * Two layers, most specific first: the named mappings from smaps when the device
 * let us read them, then the dumpsys rows that are always available. They are
 * kept visually separate because they are different measurements, not two views
 * of one.
 */
function renderDrill(role, event, moved) {
  const categoryKey = moved.key;
  const detail = OomChart.explainCategoryDelta(event.from, event.to, categoryKey);
  const mapped = OomChart.explainMappingDelta(event.from, event.to, categoryKey);

  if (!detail.hasDetail && !mapped.available) {
    return (
      '<p class="drill-note">No breakdown for this step. The device reported the category total ' +
      'but not the rows behind it.</p>'
    );
  }

  const openId = state.expandedRow.get(role) ?? null;

  const section = (title, note, rows) =>
    rows.length === 0
      ? ''
      : `<div class="drill-section"><div class="drill-head">${escapeHtml(title)}` +
        (note ? `<span class="muted"> — ${escapeHtml(note)}</span>` : '') +
        '</div>' +
        `<div class="drill-list">${rows.join('')}</div></div>`;

  const drillRow = (id, name, bytes, delta, meaning, extra) => {
    const isOpen = id === openId;
    return (
      `<div class="drill-row${isOpen ? ' open' : ''}" data-row-id="${escapeHtml(id)}" ` +
      `role="button" tabindex="0" aria-expanded="${isOpen}">` +
      `<span class="drill-name">${escapeHtml(name)}</span>` +
      `<span class="drill-size">${OomChart.fmt(bytes)}</span>` +
      `<span class="drill-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">` +
      `${delta > 0 ? '+' : ''}${delta === 0 ? '—' : OomChart.fmt(delta)}</span>` +
      '</div>' +
      (isOpen
        ? '<div class="drill-detail">' +
          `<p>${escapeHtml(meaning)}</p>` +
          (extra ? `<p class="muted small">${extra}</p>` : '') +
          '</div>'
        : '')
    );
  };

  // Named mappings: the layer that actually says "libil2cpp.so".
  const mappingRows = mapped.rows.map((m) =>
    drillRow(
      `map:${m.name}`,
      m.name,
      m.bytes,
      m.delta,
      OomChart.describeMappingKind(m.kind),
      `${m.regions} memory region(s) · reported as private memory, which is the part that is ` +
        'freed when the process dies.',
    ),
  );

  // dumpsys rows: always available, coarser.
  const detailRows = detail.rows.map((r) =>
    drillRow(`cat:${r.key}`, r.label, r.bytes, r.delta, r.means, ''),
  );

  return (
    renderEngineSection(role, event, categoryKey, drillRow) +
    section(
      'Named mappings',
      mappingRows.length > 0 ? 'read from the process itself' : '',
      mappingRows,
    ) +
    section('Reported rows', 'from the system memory report', detailRows) +
    (!mapped.available
      ? '<p class="drill-note">Per-file detail (which library, which APK, which GPU buffer) needs ' +
        'to read the process’s own memory map. Android allows that only for a debuggable ' +
        'build or on a rooted device, so only the reported rows above are available for this run.</p>'
      : '')
  );
}

/** Categories where Unity's own allocations land, and so where its totals help. */
const ENGINE_CATEGORIES = ['privateOther', 'nativeHeap', 'graphics'];

/**
 * Unity's own accounting, shown beside the OS rows.
 *
 * This is the answer to "what is in Unattributed": the OS cannot divide Unity's
 * allocator, and the engine can. It leads the drill-down because it is the only
 * layer that names an asset *type* rather than a mapping.
 *
 * It is deliberately not presented as a decomposition of the row above it. The
 * two accountings overlap - Unity counts GPU texture memory that Android reports
 * under Graphics - so the numbers are stated as the engine's own view, and the
 * note says so.
 */
function renderEngineSection(role, event, categoryKey, drillRow) {
  if (!ENGINE_CATEGORIES.includes(categoryKey)) return '';

  const engine = OomChart.explainEngineDelta(event.from, event.to);

  if (!engine.available) {
    return (
      '<div class="drill-section engine"><div class="drill-head">Unity engine allocations</div>' +
      '<p class="drill-note">Not available for this build. Android reports Unity’s allocator as ' +
      'one anonymous mapping, so textures, meshes and audio cannot be told apart from outside ' +
      'the process — only the engine knows how its own bytes divide. To get them, add ' +
      '<code>PerformanceShieldReporter.cs</code> (shipped with this tool, under ' +
      '<code>scripts/unity/</code>) to one object in the first scene and make a Development ' +
      'Build. The figures then appear here automatically.</p></div>'
    );
  }

  const rows = engine.rows.map((r) =>
    drillRow(`engine:${r.key}`, r.label, r.bytes, r.delta, r.means, ''),
  );

  return (
    '<div class="drill-section engine">' +
    '<div class="drill-head">Unity engine allocations' +
    '<span class="muted"> — reported by the engine itself</span></div>' +
    `<div class="drill-list">${rows.join('')}</div>` +
    (engine.unavailable.length > 0
      ? `<p class="drill-note">This engine version does not expose: ${engine.unavailable
          .map((u) => escapeHtml(u))
          .join(', ')}.</p>`
      : '') +
    '<p class="drill-note">The engine’s own view, not a split of the row above: Unity counts GPU ' +
    'texture memory that Android reports under Graphics, so the two accountings overlap.</p>' +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
// Step 1 — what gets analyzed
// ---------------------------------------------------------------------------

/*
 * The panel asks for one thing at a time, in the order the operator decides:
 * device, then game, then whether to add the project. Nothing below a decision
 * is shown until that decision is made, and there is a single action button.
 *
 * What gets analyzed is *derived* from those inputs rather than chosen from a
 * list of modes: a mode radio that contradicts the fields above it is a way to
 * run the wrong analysis, and the fields already say everything the pipeline
 * needs to know.
 */

/** The device the app list is read from and the game is launched on. */
function selectedDevice() {
  return state.devices.find((d) => d.serial === state.deviceSerial) ?? null;
}

/**
 * Which analysis the current inputs describe.
 *
 *   apk       a game on a device, profiled live
 *   apk_code  the same, plus the Unity project, so a spike can be traced to a
 *             cause rather than only reported
 *
 * There is no project-only mode here: it needs neither device nor app, so it has
 * nothing to disclose progressively, and its use is CI. `gdshield scan` covers it.
 */
function derivedMode() {
  return state.project?.valid ? 'apk_code' : 'apk';
}

async function loadDevices() {
  const select = $('deviceSelect');
  const hint = $('device-hint');

  select.disabled = true;
  select.innerHTML = '<option>Looking…</option>';
  setHint(hint, 'Looking for connected devices…', 'busy');

  try {
    const result = await fetchJson('/api/devices');
    state.devices = Array.isArray(result) ? result : [];

    if (result.error) {
      select.innerHTML = '<option value="">No device</option>';
      setHint(hint, result.error, 'err');
      return;
    }
    if (state.devices.length === 0) {
      select.innerHTML = '<option value="">No device connected</option>';
      setHint(
        hint,
        'Connect a device over USB, enable Developer Options → USB debugging, accept the ' +
          'authorization prompt, then press Refresh.',
        'err',
      );
      return;
    }

    select.disabled = false;
    select.innerHTML = state.devices.map(deviceOption).join('');

    // One device is the normal case, so it is chosen rather than offered. With
    // several, the previous choice survives a refresh.
    const stillPresent = state.devices.some((d) => d.serial === state.deviceSerial);
    state.deviceSerial = stillPresent ? state.deviceSerial : state.devices[0].serial;
    select.value = state.deviceSerial;

    renderDeviceHint();
    await loadInstalledApps();
  } catch (err) {
    select.innerHTML = '<option value="">No device</option>';
    setHint(hint, err.message, 'err');
  } finally {
    refreshDisclosure();
  }
}

function deviceOption(d) {
  const label = `${d.manufacturer} ${d.model} · ${OomChart.fmt(d.totalRamBytes)} RAM · Android ${d.androidVersion}`;
  return `<option value="${escapeHtml(d.serial)}">${escapeHtml(label)}</option>`;
}

/**
 * What one app may use on the chosen device.
 *
 * Shown here rather than in the report alone because it is the number the whole
 * run is graded against, and it changes with the handset: a peak that is fine on
 * a 6 GB phone gets the app killed on a 2 GB one.
 */
function renderDeviceHint() {
  const hint = $('device-hint');
  const device = selectedDevice();
  if (!device) return;

  if (!device.budget) {
    setHint(hint, `${device.serial} · ${device.abi}`, '');
    return;
  }

  hint.className = 'hint';
  hint.innerHTML =
    `<strong>${escapeHtml(device.budget.tier)} class.</strong> One app should stay under ` +
    `${OomChart.fmt(device.budget.targetMaxBytes)}; the OS starts killing near ` +
    `${OomChart.fmt(device.budget.hardLimitBytes)}. ` +
    `<span class="muted">${escapeHtml(device.serial)} · ${escapeHtml(device.abi)}</span>`;
}

function onDeviceChange() {
  state.deviceSerial = $('deviceSelect').value;
  renderDeviceHint();
  state.apps = [];
  selectApp('', { scroll: false });
  void loadInstalledApps();
}

// ---- The Unity project folder ---------------------------------------------

/**
 * Check the folder as the operator types.
 *
 * Debounced, and the reply is dropped if the path changed while it was in
 * flight - otherwise a slow probe of a half-typed path lands after a good one
 * and reports the wrong verdict.
 */
function onProjectPathInput() {
  clearTimeout(state.projectTimer);
  const path = $('projectPath').value.trim();

  if (!path) {
    state.project = null;
    renderProjectStatus();
    return;
  }

  setHint($('project-hint'), 'Checking the folder…', 'busy');
  state.projectTimer = setTimeout(() => void probeProject(path), 400);
}

async function probeProject(path) {
  state.projectProbing = path;
  try {
    const result = await fetchJson('/api/project/probe', { method: 'POST', body: { path } });
    if (state.projectProbing !== path) return; // superseded by a later keystroke
    state.project = result;
  } catch (err) {
    if (state.projectProbing !== path) return;
    state.project = { valid: false, reason: err.message };
  }
  renderProjectStatus();
  autofillGameName();
}

function renderProjectStatus() {
  /*
   * The only place that un-hides `code-options`, so the flag is enforced here
   * rather than at each of the three call sites - one of which would eventually
   * be added without the guard.
   */
  if (!FEATURES.projectAnalysis) {
    $('project-folder-row').hidden = true;
    $('code-options').hidden = true;
    return;
  }

  const hint = $('project-hint');
  const probe = state.project;

  if (!probe) {
    hint.className = 'hint';
    hint.innerHTML =
      'Add it to trace a measured spike back to the asset or the line of code causing it. ' +
      'Leave it empty to profile the running app alone.';
  } else if (!probe.valid) {
    setHint(hint, probe.reason ?? 'That folder is not a Unity project.', 'err');
  } else {
    setHint(hint, 'Unity project confirmed.', 'ok');
  }

  // The code options only exist once there is a project to apply them to.
  $('code-options').hidden = !probe?.valid;
  if (probe?.valid) {
    $('code-facts').textContent = [
      probe.unityVersion ? `Unity ${probe.unityVersion}` : 'Unity version unknown',
      probe.scriptingBackend ?? 'scripting backend unknown',
      `${probe.sceneCount} scene(s) in Build Settings`,
      probe.usesAddressables ? 'Addressables in use' : 'no Addressables',
    ].join(' · ');
  }

  refreshDisclosure();
}

// ---- Disclosure -----------------------------------------------------------

/**
 * Show only what the current state has earned.
 *
 * Each step is absent until the one before it is answered, rather than present
 * and disabled. A disabled control still asks the operator to consider it, and
 * on a fresh console that meant a page of greyed-out choices - including a
 * primary Analyze button - describing work that could not be started yet.
 *
 * The chain is device, then app, then the options and Analyze. It is derived
 * from state on every call and never latched, so clearing the device collapses
 * everything below it back down instead of leaving a step on screen because its
 * prerequisite used to be satisfied.
 */
function refreshDisclosure() {
  const device = selectedDevice();
  const hasApp = Boolean(state.selectedPackage);

  // The app picker exists only once a device does.
  $('game-row').hidden = !device;
  $('appToggle').disabled = !device;
  $('refresh-apps').disabled = !device;

  // Everything about what to analyze, and the button that starts it, exist only
  // once there is an app to analyze.
  $('analysis-options').hidden = !hasApp;
  $('run-row').hidden = !hasApp;

  /*
   * A step that is no longer reachable must not keep its answer.
   *
   * A device unplugged mid-setup would otherwise leave the previous app
   * selected and its options open, and the next Analyze would run against a
   * device that is gone. Cleared here rather than through `selectApp`, which
   * calls back into this function - the two would recurse.
   */
  if (!device && state.selectedPackage) {
    state.selectedPackage = '';
    $('appSelect').value = '';
    state.listOpen = false;
    $('appPopup').hidden = true;
    $('appToggle').setAttribute('aria-expanded', 'false');
    renderChosenApp();
  }

  const blocked = !device
    ? 'Connect a device to start.'
    : !hasApp
      ? 'Choose the game to profile.'
      : state.project && !state.project.valid
        ? 'Fix the project folder, or clear it to profile the app alone.'
        : '';

  const button = $('analyze-btn');
  button.disabled = Boolean(blocked);
  button.title = blocked;
  renderRunSummary(blocked, device);
}

/**
 * Say which of the two runs the button is about to start.
 *
 * The project folder is optional, so the same button does two different things.
 * Naming the one it will do is what keeps an enabled Analyze from reading as
 * "enabled too early" - the state is deliberate, and the button should say so
 * rather than leaving the operator to infer it from an empty field.
 */
function renderRunSummary(blocked, device) {
  const button = $('analyze-btn');
  const summary = $('run-summary');
  const withCode = derivedMode() === 'apk_code';

  // Left alone mid-run, where the label is the progress indicator.
  if (!state.analysisId) {
    button.textContent = withCode ? 'Analyze APK + code' : 'Analyze APK only';
  }

  if (blocked) {
    setHint(summary, blocked, '');
    return;
  }

  const on = device ? ` on ${device.model}` : '';
  setHint(
    summary,
    withCode
      ? `Records memory${on} while you play, then reads the Unity project and traces each ` +
          'measured spike back to the asset, import setting or code that caused it.'
      : `Records memory${on} while you play and grades the peak against what one app may use ` +
          'on that hardware. Without a project folder, findings are measured but not traced to a ' +
          'cause — add one above if you want that.',
    '',
  );
}

/** Set a hint's text and state in one place, so the classes cannot drift. */
function setHint(el, text, kind) {
  el.textContent = text;
  el.className = `hint${kind ? ' ' + kind : ''}`;
}

// ---------------------------------------------------------------------------
// Repeat mode
// ---------------------------------------------------------------------------

/*
 * Two sessions can only be compared where they marked the same things, so the
 * reliability of a comparison is decided during capture, not afterwards. Repeat
 * mode turns a previous run's marker route into an ordered checklist the tester
 * follows, which makes the later join clean by construction.
 *
 * It never forces anything: the tester can press any marker at any time, and
 * skipped steps stay visible as skipped. A checklist that blocked the operator
 * would produce a tidy comparison of a session nobody actually played.
 */

async function loadSessionList() {
  try {
    state.sessions = await fetchJson('/api/sessions');
  } catch {
    state.sessions = [];
  }
  renderSessionPickers();
}

/**
 * One row in a session picker.
 *
 * Includes the time, not only the date: recording a baseline, changing
 * something and recording again all happen in one afternoon, and two options
 * that read identically are impossible to choose between.
 */
function sessionOption(s) {
  const build = s.versionName ? `v${s.versionName}` : 'unknown build';
  return (
    `<option value="${escapeHtml(s.analysisId)}">` +
    `${escapeHtml(s.gameName)} ${escapeHtml(build)} · ${escapeHtml(whenLabel(s.startedAt ?? s.generatedAt))} · ` +
    `${formatDuration(s.durationMs)} · ${s.markerCount} marker(s)</option>`
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date and time, to the minute, formatted the same everywhere. */
function whenLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function renderSessionPickers() {
  const options = state.sessions.map(sessionOption).join('');

  $('repeatSession').innerHTML =
    '<option value="">Not repeating — free play</option>' + options;

  // Newest first from the API, so the natural default is "the run before this
  // one" against "the most recent one".
  $('compareBefore').innerHTML = options || '<option value="">No recorded sessions yet</option>';
  $('compareAfter').innerHTML = options || '<option value="">No recorded sessions yet</option>';
  if (state.sessions.length >= 2) {
    $('compareBefore').value = state.sessions[1].analysisId;
    $('compareAfter').value = state.sessions[0].analysisId;
  }

  // The measured rate goes in the placeholder: the operator needs the target,
  // but seeing what the run actually did makes the field answerable.
  updateTargetPlaceholders();
  renderCompareOffer();

  const none = '<option value="">None</option>';
  $('baselineA').innerHTML = none + options;
  $('baselineB').innerHTML = none + options;
}

/**
 * Offer a comparison from the first screen, once there is something to compare.
 *
 * The offer and the panel it opens are mutually exclusive, which they were not:
 * reaching two recorded sessions revealed both at once, so the button inviting
 * the operator to compare sat directly above an already-open comparison form
 * saying the same thing. The offer is the closed state of the panel, so exactly
 * one of them is on screen.
 *
 * Below two sessions neither appears: an offer the tool cannot honour, pointing
 * at a form with nothing to put in it.
 */
function renderCompareOffer() {
  const enough = state.sessions.length >= 2;
  const open = enough && state.compareOpen === true;

  $('compare-offer').hidden = !enough || open;
  $('compare-panel').hidden = !open;

  if (enough) {
    $('compare-offer-count').textContent =
      `${state.sessions.length} recorded sessions are on this machine.`;
  }
}

/** Open or close the comparison panel, and put the offer back when it closes. */
function setCompareOpen(open) {
  state.compareOpen = open;
  renderCompareOffer();
  if (open) {
    $('compare-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    // Back to where the operator pressed the button, not left halfway down a
    // page whose content just disappeared.
    $('compare-offer').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Show each chosen run's measured frame rate as the input's placeholder.
 *
 * The target is the operator's to supply, but a blank box with no reference is
 * hard to answer. Seeing "measured 33.4" beside it makes clear which run is
 * which and whether 30 or 60 is the plausible answer.
 */
function updateTargetPlaceholders() {
  for (const [selectId, inputId] of [
    ['compareBefore', 'targetFpsBefore'],
    ['compareAfter', 'targetFpsAfter'],
  ]) {
    const chosen = state.sessions.find((s) => s.analysisId === $(selectId).value);
    $(inputId).placeholder =
      chosen?.averageFps != null ? `measured ${chosen.averageFps} fps` : 'e.g. 30';
  }
}

async function onRepeatChange() {
  const id = $('repeatSession').value;
  state.repeat = null;

  if (!id) {
    $('repeat-route').hidden = true;
    $('repeat-progress').textContent = '';
    return;
  }

  try {
    const route = await fetchJson(`/api/sessions/${encodeURIComponent(id)}/route`);
    if (route.steps.length === 0) {
      $('repeat-route').hidden = true;
      $('repeat-progress').textContent = 'That session recorded no markers, so there is no route.';
      return;
    }
    state.repeat = { ...route, done: new Set() };
    renderRepeatRoute();
  } catch (err) {
    $('repeat-progress').textContent = err.message;
  }
}

function renderRepeatRoute() {
  const list = $('repeat-route');
  const repeat = state.repeat;
  if (!repeat) return;

  list.hidden = false;
  list.innerHTML = repeat.steps
    .map((step) => {
      const done = repeat.done.has(step.index);
      const next = !done && step.index === nextRepeatStep()?.index;
      return (
        `<li class="repeat-step${done ? ' done' : ''}${next ? ' next' : ''}">` +
        `<span class="tick">${done ? '✓' : next ? '▸' : ''}</span>` +
        `<span>${escapeHtml(step.label)}</span>` +
        '</li>'
      );
    })
    .join('');

  const done = repeat.done.size;
  $('repeat-progress').textContent = `${done} of ${repeat.steps.length} steps marked`;
}

function nextRepeatStep() {
  return state.repeat?.steps.find((s) => !state.repeat.done.has(s.index)) ?? null;
}

/**
 * Tick off a route step when its marker is pressed.
 *
 * Matched on label rather than on order, so a tester who does two screens out of
 * sequence still ticks both. Order is a suggestion; coverage is what the
 * comparison actually needs.
 */
function notePressedMarker(label) {
  const repeat = state.repeat;
  if (!repeat) return;

  const step = repeat.steps.find((s) => !repeat.done.has(s.index) && s.label === label);
  if (!step) return;

  repeat.done.add(step.index);
  renderRepeatRoute();
}

// ---------------------------------------------------------------------------
// Comparing two sessions
// ---------------------------------------------------------------------------

async function onCompare() {
  const beforeId = $('compareBefore').value;
  const afterId = $('compareAfter').value;
  const result = $('compare-result');

  if (!beforeId || !afterId) {
    result.innerHTML = '<div class="error-box">Choose two recorded sessions.</div>';
    return;
  }
  if (beforeId === afterId) {
    result.innerHTML =
      '<div class="error-box">Those are the same run. Choose two different sessions.</div>';
    return;
  }

  const a = $('baselineA').value;
  const b = $('baselineB').value;
  const baselineIds = a && b && a !== b ? [a, b] : undefined;

  const targetBefore = Number($('targetFpsBefore').value) || undefined;
  const targetAfter = Number($('targetFpsAfter').value) || undefined;

  const button = $('run-compare');
  button.disabled = true;
  button.textContent = 'Comparing…';
  result.innerHTML = '<div class="muted small">Reading both sessions…</div>';

  try {
    const payload = await fetchJson('/api/compare', {
      method: 'POST',
      body: {
        beforeId,
        afterId,
        ...(baselineIds ? { baselineIds } : {}),
        ...(targetBefore ? { targetFpsBefore: targetBefore } : {}),
        ...(targetAfter ? { targetFpsAfter: targetAfter } : {}),
      },
    });
    state.comparison = payload;
    state.comparisonIds = { beforeId, afterId, baselineIds, targetBefore, targetAfter };
    renderComparison(payload.comparison);
    $('export-comparison').hidden = false;
    $('export-comparison-pdf').hidden = false;
  } catch (err) {
    result.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Compare';
  }
}

// A mark as well as a colour, matching the exported report.
const DIRECTION_CHIP = {
  improved: ['ok', '✓ better'],
  regressed: ['bad', '✕ worse'],
  unchanged: ['', 'same'],
  inconclusive: ['', 'within noise'],
  unknown: ['', 'not comparable'],
};

function renderComparison(c) {
  const out = [];

  out.push(`<div class="cmp-headline ${c.blocked ? 'blocked' : ''}">${escapeHtml(c.headline)}</div>`);

  // A blocked comparison prints no figures at all: showing them would present
  // two incompatible measurements as though one were a change in the other.
  if (c.blocked) {
    out.push(
      '<div class="cmp-gates">' +
        c.gates
          .filter((g) => g.level === 'block')
          .map((g) => `<p class="gate block">${escapeHtml(g.message)}</p>`)
          .join('') +
        '</div>',
    );
    $('compare-result').innerHTML = out.join('');
    // A blocked comparison prints no figures, so there is nothing to export.
    $('export-comparison').hidden = true;
    $('export-comparison-pdf').hidden = true;
    return;
  }

  const warns = c.gates.filter((g) => g.level === 'warn');
  const notes = c.gates.filter((g) => g.level === 'note');
  if (warns.length || notes.length) {
    out.push(
      '<div class="cmp-gates">' +
        warns.map((g) => `<p class="gate warn">⚠ ${escapeHtml(g.message)}</p>`).join('') +
        notes.map((g) => `<p class="gate note">${escapeHtml(g.message)}</p>`).join('') +
        '</div>',
    );
  }

  const { shared, beforeOnly, afterOnly } = c.markerOverlap;
  out.push(
    `<p class="cmp-coverage"><strong>${shared} screen(s)</strong> visited in both runs and ` +
      `compared. ${beforeOnly} only earlier, ${afterOnly} only later.` +
      (beforeOnly + afterOnly > 0
        ? ' <span class="muted">Use repeat mode to cover the same route in both.</span>'
        : '') +
      '</p>',
  );

  out.push(
    '<p class="cmp-floor">' +
      (c.noiseFloor
        ? `Changes under <strong>${OomChart.fmt(c.noiseFloor.bytes)}</strong> or ` +
          `<strong>${Math.round(c.noiseFloor.fraction * 100)}%</strong> are shown as noise. ` +
          escapeHtml(c.noiseFloor.source)
        : 'No noise baseline chosen, so every difference is shown at face value — including ones ' +
          'that may be run-to-run variance. Pick two runs of the same build above to measure it.') +
      '</p>',
  );

  out.push('<h3>Outcome</h3>');
  out.push(
    cmpTable('Measure', [
      { label: 'Process kills', before: c.kills.before, after: c.kills.after, raw: true, direction: c.kills.direction },
      { label: 'Budget verdict', before: c.budget.before, after: c.budget.after, raw: true, direction: c.budget.direction },
      { label: 'Session peak', before: c.peak.before, after: c.peak.after, deltaBytes: c.peak.deltaBytes, direction: c.peak.direction, note: c.peak.note },
    ]),
  );

  if (c.runtime.length > 0) {
    out.push('<h3>Frame rate, heat, battery and risk</h3>');
    out.push(
      '<p class="muted small">Whole-session figures, so they compare builds only as far as the ' +
        'two playthroughs were alike. The per-screen table below does not have that limit.</p>',
    );
    if (c.runtimeCaveat) {
      out.push(`<p class="cmp-caveat">${escapeHtml(c.runtimeCaveat)}</p>`);
    }
    out.push(cmpTable('Measure', c.runtime.map((m) => ({ ...toRow(m), plain: true }))));
  }

  out.push('<h3>Memory retained per screen</h3>');
  out.push(
    '<p class="muted small">What did <em>not</em> come back after leaving the screen. The most ' +
      'reliable figure here: a closed loop that does not depend on what the tester did before or ' +
      'after. Retention going up is a regression.</p>',
  );
  out.push(cmpTable('Screen', c.screens.map(toRow)));

  if (c.cycles.length > 0) {
    out.push('<h3>Memory recovered per marked flow</h3>');
    out.push(cmpTable('Flow', c.cycles.map(toRow)));
  }

  $('compare-result').innerHTML = out.join('');
}

function toRow(m) {
  return {
    label: m.label,
    plain: false,
    before: m.before,
    after: m.after,
    deltaBytes: m.deltaBytes,
    direction: m.direction,
    note: m.note,
  };
}

function cmpTable(header, rows) {
  if (rows.length === 0) return '<p class="muted small">Nothing recorded in either run.</p>';

  // Regressions first: the reader is looking for what got worse.
  const order = { regressed: 0, improved: 1, unchanged: 2, inconclusive: 3, unknown: 4 };
  const sorted = [...rows].sort(
    (a, b) =>
      order[a.direction] - order[b.direction] ||
      Math.abs(b.deltaBytes ?? 0) - Math.abs(a.deltaBytes ?? 0),
  );

  // Three kinds of value share this table: byte counts, plain numbers (fps,
  // degrees, a risk score) and verdict words. Formatting the wrong one as bytes
  // would turn 58 fps into "58 B".
  const cell = (v, row) => {
    if (v === null || v === undefined) return '—';
    if (row.raw) return escapeHtml(String(v));
    if (row.plain) return Number.isInteger(v) ? String(v) : v.toFixed(1);
    return OomChart.fmt(v);
  };

  const body = sorted
    .map((r) => {
      const [cls, text] = DIRECTION_CHIP[r.direction] ?? ['', ''];
      const delta =
        r.deltaBytes === null || r.deltaBytes === undefined
          ? '—'
          : `${r.deltaBytes > 0 ? '+' : ''}${
              r.plain
                ? Number.isInteger(r.deltaBytes)
                  ? r.deltaBytes
                  : r.deltaBytes.toFixed(1)
                : OomChart.fmt(r.deltaBytes)
            }`;
      return (
        '<tr>' +
        `<td>${escapeHtml(r.label)}</td>` +
        `<td class="num">${cell(r.before, r)}</td>` +
        `<td class="num">${cell(r.after, r)}</td>` +
        `<td class="num">${r.raw ? '' : delta}</td>` +
        `<td><span class="cmp-chip ${cls}">${text}</span></td>` +
        '</tr>' +
        (r.note ? `<tr class="cmp-note"><td colspan="5">${escapeHtml(r.note)}</td></tr>` : '')
      );
    })
    .join('');

  return (
    `<table class="cmp-table"><thead><tr><th>${escapeHtml(header)}</th>` +
    '<th class="num">Earlier</th><th class="num">Later</th><th class="num">Change</th><th></th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/**
 * Export the comparison as a PDF.
 *
 * Rendered by the server and printed by the desktop app's own Chromium - the
 * same path the analysis reports take, so a comparison that gets emailed looks
 * like the rest of the family rather than a different tool's output.
 */
async function onExportComparisonPdf() {
  if (!state.comparisonIds || !state.comparison) return;

  const { before, after } = state.comparison.comparison;

  if (desktop?.isDesktop && typeof desktop.exportComparisonPdf !== 'function') {
    // Same rule as the report export: the print-preview fallback below belongs
    // to the browser only. Opening it from inside the app is what put an
    // unexplained print dialog on screen.
    showError(
      'This copy of GD-PerformanceShield cannot export the comparison as PDF (the desktop bridge is ' +
        'out of date). "Save as Markdown" still works.',
    );
    return;
  }

  if (!desktop?.isDesktop) {
    // A plain browser cannot drive a print engine, so open the print-ready page
    // and let the browser's own Save as PDF do it.
    const params = new URLSearchParams({
      before: state.comparisonIds.beforeId,
      after: state.comparisonIds.afterId,
      print: '1',
    });
    if (state.comparisonIds.baselineIds) {
      params.set('baseline', state.comparisonIds.baselineIds.join(','));
    }
    if (state.comparisonIds.targetBefore) {
      params.set('targetBefore', String(state.comparisonIds.targetBefore));
    }
    if (state.comparisonIds.targetAfter) {
      params.set('targetAfter', String(state.comparisonIds.targetAfter));
    }
    window.open(`/api/compare.html?${params.toString()}`, '_blank');
    return;
  }

  const button = $('export-comparison-pdf');
  button.disabled = true;
  button.textContent = 'Building PDF...';
  try {
    const result = await desktop.exportComparisonPdf({
      baseUrl: location.origin,
      ...state.comparisonIds,
      fileName:
        `${before.gameName} - ${before.versionName ?? 'earlier'} vs ` +
        `${after.versionName ?? 'later'}.pdf`,
    });
    if (result.cancelled) return;
    if (!result.ok) throw new Error(result.error || 'The PDF could not be created.');
    setExportStatus(`Saved to ${result.path}`, 'ok');
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Save as PDF';
  }
}

async function onExportComparison() {
  if (!state.comparison) return;

  const { before, after } = state.comparison.comparison;
  const name = `comparison_${before.analysisId}_vs_${after.analysisId}.md`;

  if (typeof desktop?.saveText === 'function') {
    try {
      const result = await desktop.saveText(name, state.comparison.markdown);
      // Each outcome says something. Silence on cancel was previously
      // indistinguishable from silence on a failed write.
      if (result?.path) setExportStatus(`Saved to ${result.path}`, 'ok');
      else if (result?.error) setExportStatus(result.error, 'err');
      else if (result?.cancelled) setExportStatus('Not saved - the dialog was cancelled.');
      return;
    } catch (err) {
      showError(err.message);
      return;
    }
  }

  // In a plain browser there is no filesystem, so hand it over as a download.
  const blob = new Blob([state.comparison.markdown], { type: 'text/markdown' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
