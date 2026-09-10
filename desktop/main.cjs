/**
 * GD-PerformanceShield desktop application (Electron main process).
 *
 * The analysis server runs in a separate utility process and the window points
 * at it over loopback. That keeps exactly one implementation of the pipeline -
 * the desktop app, the CLI and the browser console all drive the same code - and
 * it keeps the heavy, largely synchronous analysis work off Electron's UI
 * thread, which is what stops the window freezing mid-run.
 *
 * CommonJS deliberately - the server is bundled to CJS by scripts/build-desktop.mjs
 * so that Electron's main process loads it without an ESM loader hook.
 */
const { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess } = require('electron');
const { existsSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  AUDIENCE_FILE_LABEL,
  pdfFileName,
  safeFileName,
  withoutAutoPrint,
} = require('./exportNaming.cjs');

const isDev = !app.isPackaged;

/**
 * Where the console's static files live.
 *
 * Packaged, they sit in resources/ui (kept outside the asar so the server can
 * read them with plain fs). In development they come straight from the source
 * tree.
 */
const uiDir = isDev
  ? join(__dirname, '..', 'src', 'ui')
  : join(process.resourcesPath, 'ui');

/** The bundled server, produced by the desktop build. */
const serverBundle = join(__dirname, 'build', 'server.cjs');
const serverHost = join(__dirname, 'server-host.cjs');

let mainWindow = null;
let serverPort = null;
let serverProcess = null;

// Workspaces belong with the user's documents, not next to the binary, which
// may sit in Program Files where the app cannot write.
process.env.GDPS_WORKSPACE_ROOT ??=
  process.env.OOM_WORKSPACE_ROOT ?? join(app.getPath('documents'), 'GD-PerformanceShield');
process.env.GDPS_UI_DIR = uiDir;

/**
 * Start the analysis server in a utility process.
 *
 * Deliberately not in this process: static analysis is thousands of synchronous
 * file reads, which would block Electron's UI thread and make the window stop
 * repainting. Isolating it is what keeps the app responsive while an analysis
 * runs.
 */
function startAnalysisServer() {
  if (!existsSync(serverBundle)) {
    return Promise.reject(
      new Error(`The analysis server bundle is missing (${serverBundle}).
Run: npm run build:desktop`),
    );
  }

  return new Promise((resolve, reject) => {
    serverProcess = utilityProcess.fork(serverHost, [], {
      serviceName: 'gdps-analysis-server',
      stdio: 'pipe',
      env: {
        ...process.env,
        GDPS_WORKSPACE_ROOT: process.env.GDPS_WORKSPACE_ROOT,
        GDPS_UI_DIR: uiDir,
      },
    });

    // The server's own logs are useful when a studio reports a problem, so they
    // are forwarded rather than discarded.
    serverProcess.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    serverProcess.stderr?.on('data', (chunk) => process.stderr.write(chunk));

    let settled = false;

    serverProcess.on('message', (message) => {
      if (message?.type === 'ready' && !settled) {
        settled = true;
        resolve(message.port);
      } else if (message?.type === 'error') {
        if (!settled) {
          settled = true;
          reject(new Error(message.message));
        } else {
          dialog.showErrorBox('Analysis server error', message.message);
        }
      }
    });

    serverProcess.on('exit', (code) => {
      serverProcess = null;
      if (!settled) {
        settled = true;
        reject(new Error(`The analysis server exited during startup (code ${code}).`));
      } else if (code !== 0 && mainWindow) {
        dialog.showErrorBox(
          'Analysis server stopped',
          `The analysis server exited unexpectedly (code ${code}). Restart GD-PerformanceShield to continue.`,
        );
      }
    });

    // Startup is fast; a long hang means something is wrong and the operator
    // should be told rather than left looking at an empty window.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('The analysis server did not start within 30 seconds.'));
      }
    }, 30_000);
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 940,
    minHeight: 640,
    title: 'GD PerformanceShield',
    backgroundColor: '#0b0d12', // matches the console's dark --bg, so there is no white flash
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 127.0.0.1, not localhost: on Windows `localhost` resolves to ::1 first, and
  // the server listens on IPv4, so every request paid a ~2s IPv6 timeout before
  // falling back. The literal address skips resolution entirely.
  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  /*
   * The app owns exactly one window. Every `window.open` goes to the real
   * browser instead of opening a second Electron window.
   *
   * This used to allow same-origin URLs through, which is what produced the
   * export bug an operator reported as "it shows me report files in new windows
   * of this tool" and "showed print option with reports preview". The console's
   * browser fallback opens `report.html?print=1`, a page whose only script is
   * `window.print()`; allowed through, that became a real Electron window
   * carrying Chromium's print preview, with no file written anywhere. Denying it
   * here means no code path in the console - present or future, desktop branch
   * or browser branch - can put a print dialog on screen.
   *
   * `print` is stripped before handing the URL over so that even in the browser
   * the page opens as a report to read rather than as a print prompt; PDFs come
   * from `oom:exportPdf`, which writes files.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(withoutAutoPrint(url));
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Native dialogs
// ---------------------------------------------------------------------------

/**
 * Electron's own dialogs, exposed to the console through the preload bridge.
 *
 * These are properly parented to the window and are the reason the app feels
 * native: no PowerShell, no dialog appearing behind the window.
 */
ipcMain.handle('oom:pick', async (_event, target) => {
  const isProject = target === 'project';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isProject ? 'Select the Unity project folder' : 'Select the APK to analyze',
    buttonLabel: 'Select',
    properties: isProject ? ['openDirectory'] : ['openFile'],
    ...(isProject
      ? {}
      : { filters: [{ name: 'Android package', extensions: ['apk'] }, { name: 'All files', extensions: ['*'] }] }),
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { path: null, cancelled: true };
  }
  return { path: result.filePaths[0], cancelled: false };
});

/**
 * A window that renders a report but can never be seen.
 *
 * Both PDF exports use one. Three things make "invisible" true by construction
 * rather than by hope:
 *
 *   - `show: false`, and nothing here ever calls `show()`. A `show` listener
 *     hides it again in case some future code path does, because a report
 *     window flashing up mid-export is the visible half of the reported bug.
 *   - `window.open` is denied, so a page cannot spawn a visible sibling.
 *   - `window.print` is replaced with a no-op as soon as the DOM exists. The
 *     printable page only calls it when the server was asked for `?print=1`,
 *     which this app never does, but a print preview is unrecoverable once it
 *     appears - it blocks the export and leaves no file - so the guard is worth
 *     the two lines. `dom-ready` fires well before the page's own `load` +
 *     250ms timer, so the override always wins the race.
 */
function createPrintWindow() {
  const printer = new BrowserWindow({
    show: false,
    webPreferences: { javascript: true },
  });

  printer.on('show', () => printer.hide());
  printer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  printer.webContents.on('dom-ready', () => {
    void printer.webContents
      .executeJavaScript('window.print = function () {};', true)
      .catch(() => {
        // A page that navigated away before the injection landed is about to be
        // replaced anyway; the next dom-ready covers it.
      });
  });

  return printer;
}

/**
 * Snapshot the current page as an A4 PDF and write it to `file`.
 *
 * Returns the size on disk rather than nothing, because "the export said it
 * saved and I cannot find the files" was half of the reported bug: the only
 * honest way to report a path back to the operator is to stat it afterwards.
 * A zero-byte file means `printToPDF` returned an empty buffer, which has to
 * read as a failure rather than as a saved report.
 */
async function printPageToFile(printer, file) {
  // The page is static, but let the layout settle before the snapshot so late
  // font metrics do not shift a table across a page break.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const pdf = await printer.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });

  writeFileSync(file, pdf);
  const bytes = statSync(file).size;
  if (bytes === 0) {
    throw new Error(`Chromium produced an empty PDF for ${file}.`);
  }
  return bytes;
}

/**
 * Export one or more audience cuts as PDF.
 *
 * Rendered with Chromium's own print engine via `printToPDF`, which is why this
 * lives in the main process and needs no PDF library. Each cut is loaded into an
 * invisible window, printed, and written to a folder the operator chooses.
 *
 * The resulting files are meant to leave this machine - they are what gets sent
 * to a studio - so they are named after the game rather than the analysis id.
 *
 * Every return carries the absolute paths actually written, including on
 * failure. The console shows them verbatim: an operator reported exporting and
 * then having "no idea where they're saved or even saved or not", and a status
 * line that says "Saved 3 PDFs" without naming a single path is indistinguishable
 * from one that saved nothing.
 */
ipcMain.handle('oom:exportPdf', async (_event, request) => {
  const { baseUrl, analysisId, audiences, gameName, defaultDir } = request ?? {};

  if (!Array.isArray(audiences) || audiences.length === 0) {
    return { ok: false, error: 'Choose at least one report to export.' };
  }

  const chosen = await dialog.showOpenDialog(mainWindow, {
    title: 'Where should the PDFs be saved?',
    buttonLabel: 'Save here',
    // The session's own reports folder, so the default lands beside the .md and
    // .json the pipeline already wrote there. It falls back to Documents only
    // when the console has not learned the report paths yet.
    defaultPath: defaultDir && existsSync(defaultDir) ? defaultDir : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (chosen.canceled || chosen.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }
  const outDir = chosen.filePaths[0];

  // One reusable window for the whole batch. Creating and destroying a window
  // per cut is unreliable - the second load intermittently fails with
  // ERR_FAILED - and it also spawns a renderer process per report.
  const printer = createPrintWindow();

  const written = [];
  try {
    for (const audience of audiences) {
      const url = `${baseUrl}/api/analysis/${analysisId}/report.html?audience=${encodeURIComponent(audience)}`;
      await printer.loadURL(url);

      const file = join(outDir, pdfFileName(gameName, audience));
      const bytes = await printPageToFile(printer, file);
      written.push({ path: file, bytes, label: AUDIENCE_FILE_LABEL[audience] ?? audience });
    }
  } catch (err) {
    // The paths that did land are still reported, so a partial export tells the
    // operator which cut failed rather than discarding the ones that worked.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      written,
      outDir,
    };
  } finally {
    if (!printer.isDestroyed()) printer.destroy();
  }

  return { ok: true, written, outDir };
});

/**
 * Export a session comparison as a PDF.
 *
 * Same Chromium print engine as the analysis reports, so a comparison looks
 * like the rest of the family. A save dialog rather than a folder picker,
 * because there is exactly one file.
 */
ipcMain.handle('oom:exportComparisonPdf', async (_event, request) => {
  const { baseUrl, beforeId, afterId, baselineIds, targetBefore, targetAfter, fileName } =
    request ?? {};
  if (!beforeId || !afterId) return { ok: false, error: 'Two sessions are needed.' };

  const chosen = await dialog.showSaveDialog(mainWindow, {
    title: 'Save the comparison as PDF',
    defaultPath: safeFileName(fileName || 'Session comparison.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true };

  const printer = createPrintWindow();
  try {
    const params = new URLSearchParams({ before: beforeId, after: afterId });
    if (Array.isArray(baselineIds) && baselineIds.length === 2) {
      params.set('baseline', baselineIds.join(','));
    }
    // The printed document has to match what was on screen, targets included.
    if (targetBefore) params.set('targetBefore', String(targetBefore));
    if (targetAfter) params.set('targetAfter', String(targetAfter));
    await printer.loadURL(`${baseUrl}/api/compare.html?${params.toString()}`);

    const bytes = await printPageToFile(printer, chosen.filePath);
    return { ok: true, path: chosen.filePath, bytes };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    if (!printer.isDestroyed()) printer.destroy();
  }
});

/**
 * Write text to a file the operator chooses.
 *
 * Used for the session comparison, which is Markdown rather than a rendered
 * report - a studio pastes it into a ticket, so a PDF would be the wrong shape.
 */
ipcMain.handle('oom:saveText', async (_event, request) => {
  const { fileName, text } = request ?? {};
  if (typeof text !== 'string' || text.length === 0) {
    return { path: null, error: 'Nothing to save' };
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save the comparison',
    defaultPath: safeFileName(fileName || 'comparison.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }],
  });

  if (result.canceled || !result.filePath) return { path: null, cancelled: true };

  // A throw here would reach the renderer as "Error invoking remote method
  // 'oom:saveText'", which tells the operator nothing about the real problem
  // (a read-only folder, usually). The message is returned instead.
  try {
    writeFileSync(result.filePath, text, 'utf8');
  } catch (err) {
    return {
      path: null,
      cancelled: false,
      error: `${result.filePath} could not be written: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { path: result.filePath, cancelled: false };
});

/**
 * Select a file in Explorer/Finder.
 *
 * Returns a result rather than a bare boolean so the console can say why
 * nothing happened. `showItemInFolder` is fire-and-forget in Electron - it
 * reports no failure at all - so the path is checked here instead; a file that
 * has been moved or deleted since the export used to look like a dead button.
 */
ipcMain.handle('oom:reveal', async (_event, target) => {
  if (!target) return { ok: false, error: 'There is no file to show yet.' };
  if (!existsSync(target)) {
    return { ok: false, error: `${target} is no longer there.` };
  }
  shell.showItemInFolder(target);
  return { ok: true, path: target };
});

/**
 * Open a folder itself, rather than selecting a file inside it.
 *
 * `showItemInFolder` needs a file to highlight, and the console's "Show files"
 * button has to work for the session's reports folder as a whole - the operator
 * pressing it wants to see everything the run produced, .md and .json included,
 * not one PDF picked out. `openPath` resolves to an empty string on success and
 * to the operating system's own message on failure, which is the message worth
 * showing.
 */
ipcMain.handle('oom:openFolder', async (_event, target) => {
  if (!target) return { ok: false, error: 'There is no folder to open yet.' };
  if (!existsSync(target)) {
    return { ok: false, error: `${target} is no longer there.` };
  }
  const problem = await shell.openPath(target);
  return problem ? { ok: false, error: problem } : { ok: true, path: target };
});

ipcMain.handle('oom:openExternal', async (_event, url) => {
  await shell.openExternal(url);
  return true;
});

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open workspace folder',
          click: () => shell.openPath(process.env.GDPS_WORKSPACE_ROOT),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Operator guide',
          click: () =>
            shell.openExternal(
              'https://github.com/gd-performance-shield/blob/main/docs/OPERATOR_GUIDE.md',
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// A second launch focuses the existing window instead of starting a rival
// server on another port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      const port = await startAnalysisServer();
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox(
        'GD-PerformanceShield could not start',
        `${err instanceof Error ? err.message : String(err)}`,
      );
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow(serverPort);
    });
  });

  // The utility process holds adb connections and open telemetry files; stop it
  // deliberately rather than leaving it orphaned.
  app.on('before-quit', () => {
    serverProcess?.kill();
    serverProcess = null;
  });

  app.on('window-all-closed', () => {
    // macOS convention keeps the app alive with no windows; everywhere else a
    // profiling tool with no window should exit and release its devices.
    if (process.platform !== 'darwin') app.quit();
  });
}
