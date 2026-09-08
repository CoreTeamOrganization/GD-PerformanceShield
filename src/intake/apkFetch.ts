/**
 * Step 2 (part 3) - APK acquisition.
 *
 * Accepts either a local path or a download URL. Studios frequently hand over
 * Google Drive / Dropbox share links, so we normalise the common ones into
 * direct-download form instead of silently saving an HTML landing page.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { IntakeError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export interface AcquiredApk {
  path: string;
  sizeBytes: number;
  sha256: string;
  origin: 'local' | 'download';
  sourceUrl?: string;
}

/** ZIP local-file-header magic. Every APK must start with it. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface AcquireApkOptions {
  apkPath?: string;
  apkUrl?: string;
  destDir: string;
  logger?: Logger;
  timeoutMs?: number;
}

export async function acquireApk(opts: AcquireApkOptions): Promise<AcquiredApk> {
  const { apkPath, apkUrl, destDir, logger, timeoutMs = 30 * 60_000 } = opts;
  await mkdir(destDir, { recursive: true });

  if (apkPath) {
    if (!existsSync(apkPath)) {
      throw new IntakeError(`APK not found at ${apkPath}`, {
        hint: 'Pass an existing file with --apk, or use --apk-url to download one.',
      });
    }
    const dest = join(destDir, basename(apkPath));
    if (dest !== apkPath) await copyFile(apkPath, dest);
    logger?.info('APK taken from local path', { path: dest });
    return finalize(dest, 'local');
  }

  if (!apkUrl) {
    throw new IntakeError('No APK supplied', {
      hint: 'Provide either --apk <file> or --apk-url <url>.',
    });
  }

  const url = normalizeShareUrl(apkUrl);
  const dest = join(destDir, deriveFilename(url));
  logger?.info('Downloading APK', { url: url.slice(0, 160) });
  await download(url, dest, timeoutMs, logger);
  return finalize(dest, 'download', apkUrl);
}

async function finalize(
  path: string,
  origin: 'local' | 'download',
  sourceUrl?: string,
): Promise<AcquiredApk> {
  await assertLooksLikeApk(path);
  const sizeBytes = statSync(path).size;
  const sha256 = await hashFile(path);
  return { path, sizeBytes, sha256, origin, ...(sourceUrl ? { sourceUrl } : {}) };
}

/**
 * Guard against the classic failure: a share link returns an HTML interstitial
 * and we happily "download" a 4 KB web page named game.apk.
 */
async function assertLooksLikeApk(path: string): Promise<void> {
  const handle = await readFile(path, { flag: 'r' }).catch(() => null);
  if (!handle || handle.length < 4) {
    throw new IntakeError(`Downloaded file is empty or unreadable: ${path}`);
  }
  if (!handle.subarray(0, 4).equals(ZIP_MAGIC)) {
    const preview = handle.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ');
    throw new IntakeError(`File at ${path} is not a valid APK (ZIP) archive.`, {
      hint:
        'The URL probably returned an HTML page rather than the binary. Use a direct-download link. ' +
        `First bytes: ${preview.slice(0, 120)}`,
    });
  }
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function download(
  url: string,
  dest: string,
  timeoutMs: number,
  logger?: Logger,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const tmp = `${dest}.part`;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'gd-performance-shield/0.1' },
    });
    if (!res.ok || !res.body) {
      throw new IntakeError(`Download failed: HTTP ${res.status} ${res.statusText}`, {
        hint: 'Check that the link is publicly reachable and points directly at the APK.',
      });
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
    await rm(dest, { force: true });
    await rename(tmp, dest);
    logger?.info('APK downloaded', {
      bytes: statSync(dest).size,
      declaredBytes: total || 'unknown',
    });
  } catch (err) {
    await rm(tmp, { force: true });
    if (err instanceof IntakeError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new IntakeError(`APK download timed out after ${timeoutMs}ms`);
    }
    throw new IntakeError(`APK download failed: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Turn common share links into direct-download URLs. */
export function normalizeShareUrl(input: string): string {
  const driveId =
    /drive\.google\.com\/file\/d\/([^/]+)/.exec(input)?.[1] ??
    /drive\.google\.com\/open\?id=([^&]+)/.exec(input)?.[1];
  if (driveId) return `https://drive.google.com/uc?export=download&id=${driveId}`;

  if (input.includes('dropbox.com')) {
    return input.replace(/[?&]dl=0/, '').concat(input.includes('?') ? '&dl=1' : '?dl=1');
  }

  if (/github\.com\/.+\/blob\//.test(input)) {
    return input.replace('/blob/', '/raw/');
  }

  return input;
}

function deriveFilename(url: string): string {
  try {
    const name = basename(new URL(url).pathname);
    if (name && /\.(apk|aab)$/i.test(name)) return name;
  } catch {
    /* fall through to default */
  }
  return 'app.apk';
}
