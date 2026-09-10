import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { env } from './env.js';

export interface AppConfig {
  /** Root under which every analysis workspace lives. */
  workspaceRoot: string;
  adbPath: string;
  /** Resolved aapt2 path, or null when unavailable (we fall back to our own parser). */
  aapt2Path: string | null;
  port: number;
  githubToken?: string;
  /** Cheap-probe sampling interval (ms). */
  fastSampleIntervalMs: number;
  /** `dumpsys meminfo` sampling interval (ms) — expensive, so much slower. */
  deepSampleIntervalMs: number;
}

const WINDOWS = process.platform === 'win32';
const EXE = WINDOWS ? '.exe' : '';

function androidSdkRoot(): string | null {
  for (const envVar of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const v = process.env[envVar];
    if (v && existsSync(v)) return v;
  }
  const guesses = WINDOWS
    ? [join(homedir(), 'AppData', 'Local', 'Android', 'Sdk')]
    : [join(homedir(), 'Library', 'Android', 'sdk'), join(homedir(), 'Android', 'Sdk')];
  return guesses.find((g) => existsSync(g)) ?? null;
}

function resolveAdb(): string {
  const explicit = env('ADB_PATH');
  if (explicit) return explicit;
  const sdk = androidSdkRoot();
  if (sdk) {
    const candidate = join(sdk, 'platform-tools', `adb${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  /*
   * Well-known install locations, checked before trusting PATH.
   *
   * A desktop app launched from Finder or the Dock gets the system's minimal
   * PATH - /usr/bin:/bin:/usr/sbin:/sbin - which contains neither Homebrew's
   * /opt/homebrew/bin nor /usr/local/bin. So "brew install android-platform-
   * tools" fixed the terminal and left the packaged app still reporting adb
   * as missing, which reads to an operator like the install did not work.
   */
  const known = WINDOWS
    ? []
    : ['/opt/homebrew/bin/adb', '/usr/local/bin/adb', '/opt/local/bin/adb'];
  const found = known.find((k) => existsSync(k));
  if (found) return found;
  return 'adb'; // rely on PATH
}

/** Pick the highest-versioned build-tools aapt2, if the SDK has one. */
function resolveAapt2(): string | null {
  const explicit = env('AAPT2_PATH');
  if (explicit) return existsSync(explicit) ? explicit : null;
  const sdk = androidSdkRoot();
  if (!sdk) return null;
  const buildTools = join(sdk, 'build-tools');
  if (!existsSync(buildTools)) return null;
  const versions = readdirSync(buildTools)
    .filter((d) => /^\d+/.test(d))
    .sort(compareVersionDesc);
  for (const v of versions) {
    const candidate = join(buildTools, v, `aapt2${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let cached: AppConfig | null = null;

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  if (!cached) {
    const rawRoot = env('WORKSPACE_ROOT') ?? 'analysis';
    cached = {
      workspaceRoot: isAbsolute(rawRoot) ? rawRoot : resolve(process.cwd(), rawRoot),
      adbPath: resolveAdb(),
      aapt2Path: resolveAapt2(),
      port: Number(env('PORT') ?? 7845),
      githubToken: env('GITHUB_TOKEN') || undefined,
      fastSampleIntervalMs: Number(env('FAST_SAMPLE_MS') ?? 1000),
      deepSampleIntervalMs: Number(env('DEEP_SAMPLE_MS') ?? 5000),
    };
  }
  return { ...cached, ...overrides };
}

/** Test hook — forget the memoized config. */
export function resetConfig(): void {
  cached = null;
}
