/**
 * Preload bridge.
 *
 * Exposes only a handful of narrow, named operations to the console. The
 * renderer has no Node access and no general IPC channel, so a bug in the UI
 * cannot reach the filesystem beyond what these allow.
 *
 * `window.oomDesktop` doubles as the console's feature test: when it is absent
 * the console is running in a plain browser and falls back to the server's own
 * dialog endpoint. The console checks the individual functions too, not just
 * `isDesktop` - a packaged app whose asar predates a new operation would
 * otherwise take the browser fallback while running inside Electron, and that
 * fallback opens a print-preview window instead of writing a file.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oomDesktop', {
  /** True whenever the console is running inside the desktop app. */
  isDesktop: true,

  /** Open a native folder picker. `target` is 'project' or 'apk'. */
  pick: (target) => ipcRenderer.invoke('oom:pick', target),

  /** Export a session comparison as a single PDF. */
  exportComparisonPdf: (request) => ipcRenderer.invoke('oom:exportComparisonPdf', request),

  /** Save text to a file the operator picks. Returns the path written. */
  saveText: (fileName, text) => ipcRenderer.invoke('oom:saveText', { fileName, text }),

  /** Select a file in Explorer/Finder. Returns `{ ok, path }` or `{ ok, error }`. */
  reveal: (path) => ipcRenderer.invoke('oom:reveal', path),

  /**
   * Open a folder in Explorer/Finder.
   *
   * Separate from `reveal` because the console's "Show files" button points at
   * the session's reports folder, and `showItemInFolder` needs a file to
   * highlight rather than a directory.
   */
  openFolder: (path) => ipcRenderer.invoke('oom:openFolder', path),

  /**
   * Export the chosen audience cuts as PDF files.
   *
   * Prompts for a destination folder and returns
   * `{ ok, outDir, written: [{ path, bytes, label }] }`. The paths are absolute
   * and are what the console displays - the operator has to be able to read
   * where the export landed without opening a file manager.
   */
  exportPdf: (request) => ipcRenderer.invoke('oom:exportPdf', request),

  /** Open a URL in the user's real browser rather than in the app window. */
  openExternal: (url) => ipcRenderer.invoke('oom:openExternal', url),
});
