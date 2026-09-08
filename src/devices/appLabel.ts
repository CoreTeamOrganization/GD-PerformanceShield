/**
 * Resolve an installed app's real display name - the one shown under its icon.
 *
 * `android:label` in the manifest is almost always a resource reference, and
 * Android reports it unresolved: `dumpsys` gives `nonLocalizedLabel=null` and a
 * numeric `labelRes`. So the name a person recognises
 * ("Wedding Rush Draw Puzzle") only exists inside the APK's resource table.
 *
 * Pulling the APK to read it is not viable - they are hundreds of megabytes and
 * the app list needs many of them. Instead this reads just the parts it needs
 * straight off the device, using the fact that a ZIP is randomly addressable:
 *
 *   1. read the last 64 KB           -> find the end-of-central-directory record
 *   2. read the central directory    -> locate AndroidManifest.xml and resources.arsc
 *   3. read those two entries only   -> typically well under 2 MB combined
 *
 * Usually a few hundred kilobytes per app rather than the whole file.
 *
 * Every failure path returns null: a display name is a convenience, and no APK
 * quirk should be able to break the app list.
 */
import { inflateRawSync } from 'node:zlib';

import { parseResourceTable } from '../apk/arsc.js';
import { attr, findElements, parseAndroidManifest } from '../apk/axml.js';
import type { Logger } from '../core/logger.js';
import type { AdbDevice } from './adb.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** How much of the file end to read when hunting for the EOCD record. */
const TAIL_BYTES = 64 * 1024;
/** Guard against a pathological resource table. */
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface AppLabelResult {
  packageName: string;
  /** The resolved display name, or null when it could not be read. */
  label: string | null;
  /** Why it could not be read, for the log rather than the operator. */
  reason?: string;
}

/**
 * Read the display name for one installed app.
 *
 * `apkPath` is the on-device path reported by `pm list packages -f`.
 */
export async function resolveAppLabel(
  device: AdbDevice,
  packageName: string,
  apkPath: string,
  logger?: Logger,
): Promise<AppLabelResult> {
  const fail = (reason: string): AppLabelResult => {
    logger?.debug('Could not resolve app label', { packageName, reason });
    return { packageName, label: null, reason };
  };

  try {
    const size = await device.fileSize(apkPath);
    if (!size) return fail('APK size unreadable');

    // ---- 1. the tail, to find the central directory --------------------
    const tailLength = Math.min(TAIL_BYTES, size);
    const tail = await device.readFileRange(apkPath, size - tailLength, tailLength);

    const eocd = findEocd(tail);
    if (!eocd) return fail('no end-of-central-directory record');

    // ---- 2. the central directory --------------------------------------
    const central =
      eocd.directoryOffset >= size - tailLength
        ? tail.subarray(eocd.directoryOffset - (size - tailLength))
        : await device.readFileRange(apkPath, eocd.directoryOffset, eocd.directorySize);

    const entries = readCentralDirectory(central, eocd.entryCount);
    const manifestEntry = entries.get('AndroidManifest.xml');
    const arscEntry = entries.get('resources.arsc');
    if (!manifestEntry) return fail('AndroidManifest.xml not listed');

    // ---- 3. the manifest, to learn which resource holds the label -------
    const manifestBytes = await readEntry(device, apkPath, manifestEntry);
    if (!manifestBytes) return fail('AndroidManifest.xml unreadable');

    const manifest = parseAndroidManifest(manifestBytes);
    const application = findElements(manifest, 'application')[0];
    const rawLabel = application ? attr(application, 'label') : null;

    // A literal label needs no resource lookup at all.
    if (rawLabel && !isResourceReference(rawLabel)) return { packageName, label: rawLabel };
    if (!rawLabel) return fail('application has no label attribute');
    if (!arscEntry) return fail('label is a resource but resources.arsc is not listed');

    // ---- 4. the resource table -----------------------------------------
    const arscBytes = await readEntry(device, apkPath, arscEntry);
    if (!arscBytes) return fail('resources.arsc unreadable');

    const table = parseResourceTable(arscBytes);
    if (!table) return fail('resources.arsc could not be parsed');

    const resourceId = parseResourceReference(rawLabel);
    if (resourceId === null) return fail(`label reference not numeric: ${rawLabel}`);

    const resolved = table.resolveString(resourceId);
    if (!resolved) return fail(`resource 0x${resourceId.toString(16)} held no string`);

    return { packageName, label: resolved };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Resolve several apps, a few at a time.
 *
 * Bounded concurrency: each app is several device round trips, and saturating
 * adb makes every one of them slower rather than faster.
 */
export async function resolveAppLabels(
  device: AdbDevice,
  apps: Array<{ packageName: string; apkPath: string | null }>,
  opts: { concurrency?: number; logger?: Logger } = {},
): Promise<Map<string, string>> {
  const concurrency = opts.concurrency ?? 3;
  const targets = apps.filter((a): a is { packageName: string; apkPath: string } =>
    Boolean(a.apkPath),
  );
  const resolved = new Map<string, string>();

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const target = targets[index];
      if (!target) return;

      const result = await resolveAppLabel(
        device,
        target.packageName,
        target.apkPath,
        opts.logger,
      );
      if (result.label) resolved.set(result.packageName, result.label);
    }
  });

  await Promise.all(workers);

  opts.logger?.info('App labels resolved', {
    requested: targets.length,
    resolved: resolved.size,
  });

  return resolved;
}

// ---------------------------------------------------------------------------
// Partial ZIP reading
// ---------------------------------------------------------------------------

interface Eocd {
  entryCount: number;
  directoryOffset: number;
  directorySize: number;
}

/** Scan backwards for the EOCD signature - it sits behind a variable comment. */
export function findEocd(tail: Buffer): Eocd | null {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    return {
      entryCount: tail.readUInt16LE(i + 10),
      directorySize: tail.readUInt32LE(i + 12),
      directoryOffset: tail.readUInt32LE(i + 16),
    };
  }
  return null;
}

/** Read central-directory headers into a name-keyed map. */
export function readCentralDirectory(central: Buffer, entryCount: number): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let offset = 0;

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > central.length) break;
    if (central.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;

    const compressionMethod = central.readUInt16LE(offset + 10);
    const compressedSize = central.readUInt32LE(offset + 20);
    const uncompressedSize = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const localHeaderOffset = central.readUInt32LE(offset + 42);

    const name = central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.set(name, {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Read and decompress one ZIP entry from the device.
 *
 * The local header repeats the name and extra field with its own lengths, so it
 * has to be read before the data offset is known.
 */
async function readEntry(
  device: AdbDevice,
  apkPath: string,
  entry: ZipEntry,
): Promise<Buffer | null> {
  if (entry.compressedSize > MAX_ENTRY_BYTES) return null;

  const header = await device.readFileRange(apkPath, entry.localHeaderOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) return null;

  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;

  const data = await device.readFileRange(apkPath, dataOffset, entry.compressedSize);

  if (entry.compressionMethod === 0) return data; // stored
  if (entry.compressionMethod === 8) {
    try {
      return inflateRawSync(data);
    } catch {
      return null;
    }
  }
  return null; // an unusual method is not worth handling for a label
}

// ---------------------------------------------------------------------------
// Resource references
// ---------------------------------------------------------------------------

/**
 * Whether an attribute value is a resource reference rather than a literal name.
 *
 * The AXML parser renders a reference as `@` followed by *bare* hex - the form
 * `@7f120028`, with no `0x`. Missing that is what let an unresolved id reach the
 * app list as if it were the app's name.
 */
export function isResourceReference(value: string): boolean {
  const text = value.trim();

  // The form the AXML parser actually produces, plus the 0x-prefixed variant.
  if (/^@(0x)?[0-9a-f]+$/i.test(text)) return true;
  if (/^0x[0-9a-f]+$/i.test(text)) return true;

  // A bare integer, but only if it is large enough to be a resource id -
  // otherwise a game genuinely called "2048" would be treated as a reference.
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10) >= 0x01000000;

  // Deliberately no bare-hex case: "Face" and "Decade" are all hex characters
  // and are perfectly good app names. Without an @ or 0x marker it is a name.
  return false;
}

export function parseResourceReference(value: string): number | null {
  let text = value.trim();
  let radix = 10;

  if (text.startsWith('@')) {
    // An @ always introduces hex, with or without an explicit 0x.
    text = text.slice(1);
    radix = 16;
  }
  if (/^0x/i.test(text)) {
    text = text.slice(2);
    radix = 16;
  }

  const parsed = Number.parseInt(text, radix);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
