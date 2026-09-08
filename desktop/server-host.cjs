/**
 * The analysis server, hosted in a separate Electron utility process.
 *
 * Why it is not in the main process: static analysis reads thousands of files
 * synchronously, and `adb` work runs for minutes. Anything blocking on the main
 * process blocks Electron's UI thread, which makes the window stop repainting
 * and Windows mark it "Not Responding". Running here means the analysis can peg
 * a core for a minute and the window stays smooth throughout.
 *
 * Communicates with the main process over `parentPort`:
 *   -> { type: 'ready', port }   server is listening
 *   -> { type: 'error', message } startup failed
 */
const { createServer: createNetServer } = require('node:net');
const { join } = require('node:path');

/** Ask the OS for a free port so two copies of the app cannot collide. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function post(message) {
  // `parentPort` exists only inside a utility process; guard so this file can
  // also be run directly with plain node while debugging.
  if (process.parentPort) process.parentPort.postMessage(message);
  else console.log('[server-host]', JSON.stringify(message));
}

async function main() {
  const { startServer } = require(join(__dirname, 'build', 'server.cjs'));
  const port = await findFreePort();
  await startServer(port);
  post({ type: 'ready', port });
}

main().catch((err) => {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  // Give the message a tick to reach the parent before the process ends.
  setTimeout(() => process.exit(1), 100);
});

// A crash here must not take the window down silently - report it instead.
process.on('uncaughtException', (err) => {
  post({ type: 'error', message: `Analysis server crashed: ${err.message}` });
});
process.on('unhandledRejection', (reason) => {
  post({ type: 'error', message: `Analysis server error: ${String(reason)}` });
});
