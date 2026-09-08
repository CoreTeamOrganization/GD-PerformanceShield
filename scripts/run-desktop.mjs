/**
 * Launch the desktop app in development.
 *
 * Exists for one reason: `ELECTRON_RUN_AS_NODE` is set in some environments -
 * notably inside VS Code's extension host, and therefore in terminals and tools
 * that inherit from it. When it is set, an Electron binary silently behaves as
 * plain Node: `require('electron')` returns the npm shim instead of the API,
 * `app` is undefined, and the process exits with no window and no useful error.
 *
 * Stripping it here means `npm run desktop` behaves the same everywhere.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('\n  Electron is not installed. Run: npm install\n');
  process.exit(1);
}

if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
  console.error(
    `\n  The Electron binary is missing (${electronPath}).\n` +
      '  Reinstall it with: node node_modules/electron/install.js\n',
  );
  process.exit(1);
}

if (!existsSync(join(root, 'desktop', 'build', 'server.cjs'))) {
  console.error('\n  The server bundle is missing. Run: npm run build:desktop\n');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`\n  Could not start the desktop app: ${err.message}\n`);
  process.exit(1);
});
