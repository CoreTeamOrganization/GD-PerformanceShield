/**
 * Native file and folder pickers, driven from the local server.
 *
 * Why this exists: a browser `<input type="file">` deliberately hides the real
 * filesystem path, and a Unity project is far too large to upload. Since the
 * server runs on the operator's own machine, it can open the operating system's
 * own dialog and hand back a genuine path - which is what makes the browser
 * window behave like a desktop application rather than a web page.
 *
 * Every platform gets its native dialog: Windows via WinForms through
 * PowerShell, macOS via AppleScript, Linux via zenity or kdialog.
 */
import { dirname } from 'node:path';

import { run } from '../core/exec.js';
import type { Logger } from '../core/logger.js';

export type PickKind = 'folder' | 'file';

export interface PickOptions {
  kind: PickKind;
  title: string;
  /** File dialogs only: e.g. `[{ name: 'Android package', extensions: ['apk'] }]`. */
  filters?: Array<{ name: string; extensions: string[] }>;
  logger?: Logger;
}

export interface PickResult {
  /** Absolute path, or null when the operator cancelled. */
  path: string | null;
  cancelled: boolean;
  /** Set when no dialog mechanism is available on this machine. */
  unsupported?: string;
}

/** Dialogs are modal to the user, so allow generous time before giving up. */
const DIALOG_TIMEOUT_MS = 5 * 60_000;

export async function pickPath(opts: PickOptions): Promise<PickResult> {
  try {
    switch (process.platform) {
      case 'win32':
        return await pickWindows(opts);
      case 'darwin':
        return await pickMac(opts);
      default:
        return await pickLinux(opts);
    }
  } catch (err) {
    opts.logger?.warn('Native picker failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      path: null,
      cancelled: false,
      unsupported: 'The system file dialog could not be opened. Type or paste the path instead.',
    };
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * WinForms dialogs require a single-threaded apartment, hence `-STA`. They also
 * open behind the browser unless given a topmost owner window, so one is
 * created purely to bring the dialog to the front.
 */
async function pickWindows(opts: PickOptions): Promise<PickResult> {
  const script =
    opts.kind === 'folder'
      ? `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = ${psString(opts.title)}
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
$owner.Dispose()
`
      : `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = ${psString(opts.title)}
$dialog.Filter = ${psString(windowsFilter(opts.filters))}
$dialog.Multiselect = $false
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
$owner.Dispose()
`;

  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    { timeoutMs: DIALOG_TIMEOUT_MS },
  );

  return toResult(result.stdout);
}

function windowsFilter(filters?: PickOptions['filters']): string {
  const parts = (filters ?? []).map(
    (f) => `${f.name} (${f.extensions.map((e) => `*.${e}`).join(';')})|${f.extensions.map((e) => `*.${e}`).join(';')}`,
  );
  parts.push('All files (*.*)|*.*');
  return parts.join('|');
}

/** Single-quoted PowerShell literal; internal quotes are doubled to escape. */
function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

async function pickMac(opts: PickOptions): Promise<PickResult> {
  const prompt = opts.title.replace(/"/g, '\\"');
  const extensions = opts.filters?.flatMap((f) => f.extensions) ?? [];
  const ofType =
    opts.kind === 'file' && extensions.length > 0
      ? ` of type {${extensions.map((e) => `"${e}"`).join(', ')}}`
      : '';

  const script =
    opts.kind === 'folder'
      ? `POSIX path of (choose folder with prompt "${prompt}")`
      : `POSIX path of (choose file with prompt "${prompt}"${ofType})`;

  const result = await run('osascript', ['-e', script], { timeoutMs: DIALOG_TIMEOUT_MS });
  // AppleScript signals cancellation with a non-zero exit and "User canceled".
  if (result.code !== 0) {
    if (/User canceled|-128/.test(result.stderr)) return { path: null, cancelled: true };
    throw new Error(result.stderr.trim());
  }
  return toResult(result.stdout);
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

async function pickLinux(opts: PickOptions): Promise<PickResult> {
  const zenityArgs = ['--file-selection', `--title=${opts.title}`];
  if (opts.kind === 'folder') zenityArgs.push('--directory');
  else if (opts.filters?.length) {
    for (const filter of opts.filters) {
      zenityArgs.push(`--file-filter=${filter.name} | ${filter.extensions.map((e) => `*.${e}`).join(' ')}`);
    }
  }

  const zenity = await run('zenity', zenityArgs, { timeoutMs: DIALOG_TIMEOUT_MS }).catch(() => null);
  if (zenity) {
    if (zenity.code === 0) return toResult(zenity.stdout);
    return { path: null, cancelled: true };
  }

  const kdialogArgs =
    opts.kind === 'folder'
      ? ['--getexistingdirectory', process.cwd()]
      : ['--getopenfilename', process.cwd()];
  const kdialog = await run('kdialog', kdialogArgs, { timeoutMs: DIALOG_TIMEOUT_MS }).catch(() => null);
  if (kdialog) {
    if (kdialog.code === 0) return toResult(kdialog.stdout);
    return { path: null, cancelled: true };
  }

  return {
    path: null,
    cancelled: false,
    unsupported:
      'No system file dialog is available (install zenity or kdialog). Type or paste the path instead.',
  };
}

function toResult(stdout: string): PickResult {
  const path = stdout.trim();
  if (!path) return { path: null, cancelled: true };
  return { path, cancelled: false };
}

// ---------------------------------------------------------------------------
// Reveal in file manager
// ---------------------------------------------------------------------------

/**
 * Open the operating system's file manager with `target` selected.
 *
 * Note on Windows: `explorer.exe` returns exit code 1 even when it succeeds, so
 * its exit status is deliberately ignored.
 */
export async function revealInFileManager(target: string, logger?: Logger): Promise<boolean> {
  try {
    switch (process.platform) {
      case 'win32':
        await run('explorer.exe', [`/select,${target}`], { timeoutMs: 15_000 });
        return true;
      case 'darwin':
        await run('open', ['-R', target], { timeoutMs: 15_000 });
        return true;
      default:
        // xdg-open has no "select this file" mode; open the containing folder.
        await run('xdg-open', [dirname(target)], { timeoutMs: 15_000 });
        return true;
    }
  } catch (err) {
    logger?.warn('Could not open the file manager', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Open a URL in the operator's default browser. */
export async function openInBrowser(url: string, logger?: Logger): Promise<boolean> {
  try {
    switch (process.platform) {
      case 'win32':
        // `start` is a cmd builtin; the empty string is the window title that
        // `start` would otherwise take from a quoted URL.
        await run('cmd.exe', ['/c', 'start', '', url], { timeoutMs: 15_000 });
        return true;
      case 'darwin':
        await run('open', [url], { timeoutMs: 15_000 });
        return true;
      default:
        await run('xdg-open', [url], { timeoutMs: 15_000 });
        return true;
    }
  } catch (err) {
    logger?.warn('Could not open the browser', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
