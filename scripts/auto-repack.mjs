/**
 * Keeps the packaged desktop app in step with the source, automatically.
 *
 * Run in two roles:
 *
 *   (no args)   Signal role. Reads the hook's JSON on stdin, decides whether the
 *               edited file matters, records that a rebuild is due, and starts a
 *               worker if one is not already running. Returns in milliseconds so
 *               it never delays the edit that triggered it.
 *
 *   --worker    Debounce role. Waits until edits have stopped for QUIET_MS, then
 *               rebuilds once and relaunches the app.
 *
 * The debounce is the point: a burst of twenty edits produces one rebuild, not
 * twenty. Without it a multi-file change would restart the app repeatedly and
 * fight the person using it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = join(root, 'dist-desktop', '.auto');
const pendingFile = join(stateDir, 'pending');
const lockFile = join(stateDir, 'worker.lock');
const logFile = join(stateDir, 'last-run.log');

/** How long edits must be quiet before rebuilding. */
const QUIET_MS = 15_000;
/** A worker that outlives this is presumed dead and replaceable. */
const LOCK_STALE_MS = 10 * 60_000;

/** Source that ends up inside the packaged app. */
const WATCHED = /^(src|desktop|scripts)[/\\].*\.(ts|js|cjs|mjs|html|css)$/i;
/** Generated output — rebuilding because of these would loop forever. */
const IGNORED = /(^|[/\\])(dist|dist-exe|dist-desktop|node_modules|analysis)[/\\]/i;

if (process.argv.includes('--worker')) await runWorker();
else await signal();

// ---------------------------------------------------------------------------

async function signal() {
  const payload = await readStdin();
  const filePath =
    payload?.tool_response?.filePath ?? payload?.tool_input?.file_path ?? '';
  if (!filePath) return;

  const rel = relative(root, filePath).split(sep).join('/');
  if (rel.startsWith('..')) return; // outside the project
  if (IGNORED.test(rel) || !WATCHED.test(rel)) return;

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pendingFile, String(Date.now()));

  if (workerAlive()) return;

  writeFileSync(lockFile, String(Date.now()));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function runWorker() {
  try {
    for (;;) {
      const last = Number(safeRead(pendingFile) ?? 0);
      if (!last) break;

      const waited = Date.now() - last;
      if (waited < QUIET_MS) {
        await sleep(Math.min(QUIET_MS - waited, 3000));
        // Refresh the lock so a long quiet period is not mistaken for a crash.
        writeFileSync(lockFile, String(Date.now()));
        continue;
      }

      // Claim this batch before building; anything edited during the build sets
      // pending again and is picked up on the next pass.
      rmSync(pendingFile, { force: true });
      await rebuild();
    }
  } finally {
    rmSync(lockFile, { force: true });
  }
}

function rebuild() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      // Deliberately no --launch: the packaged exe is kept current so a pinned
      // shortcut always starts the latest build, but a running window is never
      // closed out from under whoever is using it.
      [join(root, 'scripts', 'refresh-packaged.mjs')],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => {
      try {
        writeFileSync(logFile, `${new Date().toISOString()} exit=${code}\n${out}`);
      } catch {
        /* logging must never break the build */
      }
      resolve();
    });
    child.on('error', () => resolve());
  });
}

function workerAlive() {
  const raw = safeRead(lockFile);
  if (!raw) return false;
  return Date.now() - Number(raw) < LOCK_STALE_MS;
}

function safeRead(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(null), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
