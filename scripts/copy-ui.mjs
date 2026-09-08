/**
 * Copy the operator console assets into dist/.
 *
 * The UI is intentionally build-free (no bundler, no CDN) so it runs on an
 * offline test bench, which means tsc does not see it and it has to be copied.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'ui');
const to = join(root, 'dist', 'ui');

if (!existsSync(from)) {
  console.error(`No UI assets at ${from}`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`Copied operator console assets to ${to}`);
