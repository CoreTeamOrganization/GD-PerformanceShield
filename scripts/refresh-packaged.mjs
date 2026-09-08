/**
 * Refresh the packaged desktop app in place, without a full electron-builder run.
 *
 * A full `dist:win` takes minutes because it re-resolves dependencies, re-copies
 * the Electron runtime and tries to sign. None of that changes when only our own
 * source changes. This updates the four things that do:
 *
 *   desktop/main.cjs, preload.cjs, exportNaming.cjs,
 *   server-host.cjs                                  inside app.asar
 *   desktop/build/server.cjs (the bundled server)    inside app.asar
 *   resources/ui/*                                   outside the asar
 *
 * The asar's node_modules are extracted once into a staging directory and
 * reused, so a refresh is a repack rather than a rebuild.
 *
 * Exits 0 and does nothing when there is no packaged app yet - it is a refresh,
 * not a substitute for the first `npm run dist:win`.
 */
import asar from '@electron/asar';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = join(root, 'dist-desktop', 'win-unpacked');
const resources = join(unpacked, 'resources');
const archive = join(resources, 'app.asar');
const stage = join(root, 'dist-desktop', '.asar-stage');

const APP_FILES = [
  ['desktop/main.cjs', 'desktop/main.cjs'],
  ['desktop/preload.cjs', 'desktop/preload.cjs'],
  ['desktop/exportNaming.cjs', 'desktop/exportNaming.cjs'],
  ['desktop/server-host.cjs', 'desktop/server-host.cjs'],
  ['desktop/build/server.cjs', 'desktop/build/server.cjs'],
  ['package.json', 'package.json'],
];

const shouldLaunch = process.argv.includes('--launch');
const started = Date.now();

if (!existsSync(archive)) {
  console.log('No packaged app yet — run `npm run dist:win` once first.');
  process.exit(0);
}

// 1. Rebuild the bundled server from current sources.
execFileSync(process.execPath, [join(root, 'scripts', 'build-desktop.mjs')], {
  cwd: root,
  stdio: 'pipe',
});

// 2. The console's assets live outside the asar, so they are a plain copy.
cpSync(join(root, 'src', 'ui'), join(resources, 'ui'), { recursive: true });

// 3. Extract the archive once; afterwards only our own files are overwritten.
//    Re-extract if the stage looks incomplete, so a half-finished run self-heals.
const stageOk = existsSync(join(stage, 'desktop', 'main.cjs')) && existsSync(join(stage, 'node_modules'));
if (!stageOk) {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  asar.extractAll(archive, stage);
}

for (const [from, to] of APP_FILES) {
  const src = join(root, from);
  if (!existsSync(src)) continue;
  const dest = join(stage, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

// 4. Repack.
await asar.createPackage(stage, archive);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const size = (statSync(archive).size / (1024 * 1024)).toFixed(1);
console.log(`Packaged app refreshed in ${seconds}s (app.asar ${size} MB).`);

if (shouldLaunch) relaunch();

/**
 * Restart the packaged app so the window shows the build we just made.
 *
 * The running copy is stopped first: Electron holds a single-instance lock, so
 * launching while the old one lives just focuses the stale window.
 */
function relaunch() {
  const exe = readdirSync(unpacked).find((f) => f.endsWith('.exe'));
  if (!exe) {
    console.log('No .exe found in win-unpacked; skipping launch.');
    return;
  }
  const exePath = join(unpacked, exe);
  const appName = exe.replace(/\.exe$/i, '');

  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Name '${appName}' -ErrorAction SilentlyContinue | Stop-Process -Force`,
      ],
      { stdio: 'pipe' },
    );
  } catch {
    // Nothing was running - that is the normal case on a first launch.
  }

  // ELECTRON_RUN_AS_NODE is set inside Claude Code / VS Code and is inherited by
  // anything spawned from it. With it set, Electron silently runs as plain Node:
  // no window, no error. It must not reach the app.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(exePath, [], { detached: true, stdio: 'ignore', env });
  child.unref();
  console.log(`Launched ${exe}.`);
}
