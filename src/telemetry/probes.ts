/**
 * Memory probes.
 *
 * Deviation from the spec, and the reason for it:
 * `dumpsys meminfo <pid>` is the only reliable non-root source of PSS by
 * category, but it costs roughly 150-400 ms and briefly freezes the target
 * process. Polling it once per second - as a naive reading of "continuous
 * telemetry" would suggest - measurably perturbs the game we are trying to
 * measure and can itself provoke frame hitches.
 *
 * So probes are split into two tiers:
 *   fast (~1 Hz)  - `/proc/<pid>/statm` + `status`: near-zero cost, RSS only.
 *   deep (~0.2 Hz) - `dumpsys meminfo`: full PSS/SwapPSS breakdown.
 *
 * The fast tier is unavailable for release builds on devices that mount /proc
 * with hidepid, so each probe reports its own availability and the sampler
 * degrades gracefully to deep-only.
 */
import type { AdbDevice } from '../devices/adb.js';
import type { AppSummary, MappingKind, MappingUsage, MemoryBreakdown } from './types.js';
import type { BatteryReading, ThermalReading } from './deviceHealth.js';
import type { FpsReading } from './fps.js';
import type { GpuReading } from './gpu.js';
import type { CpuReading } from './cpuThreads.js';
import type { DiskIoReading } from './diskIo.js';
import type { AudioReading } from './audio.js';

export interface ProbeReading {
  pssBytes: number | null;
  rssBytes: number | null;
  swapPssBytes: number | null;
  breakdown?: MemoryBreakdown;
  breakdownPrivate?: MemoryBreakdown;
  summary?: AppSummary;
  mappings?: MappingUsage[];
  fps?: FpsReading;
  thermal?: ThermalReading;
  battery?: BatteryReading;
  /**
   * The subsystems beyond memory. No `MemoryProbe` produces these - they come
   * from their own probes and are merged into the same deep sample by the
   * sampler, so that one instant is described by one record.
   */
  gpu?: GpuReading;
  cpu?: CpuReading;
  io?: DiskIoReading;
  audio?: AudioReading;
  oomScoreAdj?: number | null;
}

export interface MemoryProbe {
  readonly name: string;
  readonly tier: 'fast' | 'deep';
  /** Verify the probe works on this device before the session starts. */
  isAvailable(device: AdbDevice, pid: number): Promise<boolean>;
  sample(device: AdbDevice, pid: number): Promise<ProbeReading | null>;
}

const KB = 1024;

// ---------------------------------------------------------------------------
// Fast tier
// ---------------------------------------------------------------------------

/**
 * Reads RSS and oom_score_adj straight out of /proc in a single shell round
 * trip. Cheap enough to run at 1 Hz without disturbing the game.
 */
export class ProcStatusProbe implements MemoryProbe {
  readonly name = 'proc_status';
  readonly tier = 'fast' as const;

  async isAvailable(device: AdbDevice, pid: number): Promise<boolean> {
    const res = await device.shell(['cat', `/proc/${pid}/status`], 10_000);
    return res.code === 0 && /VmRSS/.test(res.stdout);
  }

  async sample(device: AdbDevice, pid: number): Promise<ProbeReading | null> {
    // One script so a 1 Hz sample is one adb round trip, not three.
    const res = await device.script(
      `cat /proc/${pid}/status; echo ---; cat /proc/${pid}/oom_score_adj`,
      10_000,
    );
    if (res.code !== 0) return null;

    const [statusText = '', oomText = ''] = res.stdout.split('---');
    const rssKb = Number(/VmRSS:\s+(\d+)\s*kB/.exec(statusText)?.[1] ?? NaN);
    const swapKb = Number(/VmSwap:\s+(\d+)\s*kB/.exec(statusText)?.[1] ?? NaN);
    if (!Number.isFinite(rssKb)) return null;

    const oomScoreAdj = Number(oomText.trim());

    return {
      pssBytes: null, // /proc/self/smaps_rollup would give PSS but is not readable for foreign pids
      rssBytes: rssKb * KB,
      swapPssBytes: Number.isFinite(swapKb) ? swapKb * KB : null,
      oomScoreAdj: Number.isFinite(oomScoreAdj) ? oomScoreAdj : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Deep tier
// ---------------------------------------------------------------------------

/**
 * Full PSS breakdown from `dumpsys meminfo --local <pid>`.
 *
 * `--local` matters more than it looks. Without it, dumpsys makes a binder call
 * into the game and waits for the game to report its own Java heap, which stops
 * the game while it answers: 780 ms of device work, on a five-second cadence, on
 * a phone rendering a frame every 16 ms. Measured against an undisturbed
 * baseline that produced no janks at all, that one call was manufacturing about
 * eight janks a minute and costing 12% of the session's frames - so the tool was
 * reporting stutter it had caused itself. Collecting locally instead never
 * touches the game and costs 224 ms.
 *
 * The App Summary comes back with every category intact and the figures agree to
 * within 0.2%, with one exception: Java Heap is derived from the dalvik mappings
 * rather than reported by the runtime, so it reads a few MB low. That is a fair
 * trade for a number that is no longer partly an artefact of measuring it. The
 * `Objects` block is not in a local dump, and nothing reads it - the parser only
 * used it to know where the summary ended.
 */
export class DumpsysMeminfoProbe implements MemoryProbe {
  readonly name = 'dumpsys_meminfo';
  readonly tier = 'deep' as const;

  private static args(pid: number): string[] {
    return ['dumpsys', 'meminfo', '--local', String(pid)];
  }

  async isAvailable(device: AdbDevice, pid: number): Promise<boolean> {
    const res = await device.shell(DumpsysMeminfoProbe.args(pid), 30_000);
    return res.code === 0 && /MEMINFO|TOTAL/i.test(res.stdout);
  }

  async sample(device: AdbDevice, pid: number): Promise<ProbeReading | null> {
    const res = await device.shell(DumpsysMeminfoProbe.args(pid), 30_000);
    if (res.code !== 0 || res.stdout.trim().length === 0) return null;
    return parseMeminfo(res.stdout);
  }
}

/** Row label in dumpsys output -> field on MemoryBreakdown. */
const BREAKDOWN_KEYS: Array<[RegExp, keyof MemoryBreakdown]> = [
  [/^native heap$/i, 'nativeHeap'],
  [/^dalvik heap$/i, 'dalvikHeap'],
  [/^dalvik other$/i, 'dalvikOther'],
  [/^stack$/i, 'stack'],
  [/^ashmem$/i, 'ashmem'],
  [/^gfx dev$/i, 'gfxDev'],
  [/^other dev$/i, 'otherDev'],
  [/^\.so mmap$/i, 'soMmap'],
  [/^\.jar mmap$/i, 'jarMmap'],
  [/^\.apk mmap$/i, 'apkMmap'],
  [/^\.ttf mmap$/i, 'ttfMmap'],
  [/^\.dex mmap$/i, 'dexMmap'],
  [/^\.oat mmap$/i, 'oatMmap'],
  [/^\.art mmap$/i, 'artMmap'],
  [/^other mmap$/i, 'otherMmap'],
  [/^egl mtrack$/i, 'eglMtrack'],
  [/^gl mtrack$/i, 'glMtrack'],
  [/^unknown$/i, 'unknown'],
];

const SUMMARY_KEYS: Array<[RegExp, keyof AppSummary]> = [
  [/^java heap$/i, 'javaHeap'],
  [/^native heap$/i, 'nativeHeap'],
  [/^code$/i, 'code'],
  [/^stack$/i, 'stack'],
  [/^graphics$/i, 'graphics'],
  [/^private other$/i, 'privateOther'],
  [/^system$/i, 'system'],
  [/^total pss$/i, 'totalPss'],
  [/^total rss$/i, 'totalRss'],
  [/^total swap pss$/i, 'totalSwapPss'],
  [/^total swap \(kb\)$/i, 'totalSwapPss'],
];

/**
 * Parse `dumpsys meminfo <pid>`.
 *
 * The layout differs across Android versions (column counts, the presence of
 * Rss columns, "TOTAL SWAP PSS" vs "TOTAL SWAP"), so we key off row labels and
 * take the first numeric column (Pss Total) rather than fixed offsets.
 */
export function parseMeminfo(text: string): ProbeReading {
  const breakdown: MemoryBreakdown = {};
  const breakdownPrivate: MemoryBreakdown = {};
  const summary: AppSummary = {};
  let totalPssKb: number | null = null;
  let totalRssKb: number | null = null;
  let totalSwapKb: number | null = null;

  let inSummary = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s*App Summary/i.test(line)) {
      inSummary = true;
      continue;
    }
    if (/^\s*Objects\b/i.test(line) || /^\s*SQL\b/i.test(line)) {
      inSummary = false;
      continue;
    }

    if (inSummary) {
      // Summary rows look like `           Java Heap:    12345` and the TOTAL
      // line can carry several labelled values on one row.
      const pairs = [...line.matchAll(/([A-Za-z][A-Za-z ()]*?):\s*(\d+)/g)];
      for (const pair of pairs) {
        const label = (pair[1] ?? '').trim();
        const value = Number(pair[2]);
        if (!Number.isFinite(value)) continue;
        const key = SUMMARY_KEYS.find(([re]) => re.test(label))?.[1];
        if (key) summary[key] = value * KB;
        if (/^total pss$/i.test(label)) totalPssKb = value;
        if (/^total rss$/i.test(label)) totalRssKb = value;
        if (/^total swap/i.test(label)) totalSwapKb = value;
      }
      continue;
    }

    const row = /^\s*([A-Za-z.][A-Za-z0-9 ._/-]*?)\s{2,}(\d[\d\s]*)$/.exec(line);
    if (!row) continue;
    const label = (row[1] ?? '').trim();
    const numbers = (row[2] ?? '')
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const pssTotal = numbers[0];
    if (pssTotal === undefined) continue;

    if (/^total$/i.test(label)) {
      totalPssKb ??= pssTotal;
      // On newer builds the TOTAL row is: Pss Private Private SwapPss Rss ...
      if (numbers.length >= 5) {
        totalSwapKb ??= numbers[3] ?? null;
        totalRssKb ??= numbers[4] ?? null;
      }
      continue;
    }

    const key = BREAKDOWN_KEYS.find(([re]) => re.test(label))?.[1];
    if (key) {
      breakdown[key] = pssTotal * KB;
      // Columns are Pss / Private Dirty / Private Clean on every layout we have
      // seen; later columns move around but these three do not.
      const privateDirty = numbers[1] ?? 0;
      const privateClean = numbers[2] ?? 0;
      breakdownPrivate[key] = (privateDirty + privateClean) * KB;
    }
  }

  return {
    pssBytes: totalPssKb !== null ? totalPssKb * KB : (summary.totalPss ?? null),
    rssBytes: totalRssKb !== null ? totalRssKb * KB : (summary.totalRss ?? null),
    swapPssBytes: totalSwapKb !== null ? totalSwapKb * KB : (summary.totalSwapPss ?? null),
    breakdown: Object.keys(breakdown).length > 0 ? breakdown : undefined,
    breakdownPrivate: Object.keys(breakdownPrivate).length > 0 ? breakdownPrivate : undefined,
    summary: Object.keys(summary).length > 0 ? summary : undefined,
  };
}

// ---------------------------------------------------------------------------
// Device-wide memory
// ---------------------------------------------------------------------------

export interface DeviceMemoryReading {
  availableBytes: number | null;
  freeBytes: number | null;
  cachedBytes: number | null;
}

/**
 * Device-wide pressure. `MemAvailable` is what the low-memory killer actually
 * reacts to, so it explains *why* a process died when PSS alone looks benign.
 */
export class DeviceMemoryProbe {
  readonly name = 'device_meminfo';

  async sample(device: AdbDevice): Promise<DeviceMemoryReading> {
    const res = await device.shell(['cat', '/proc/meminfo'], 10_000);
    if (res.code !== 0) return { availableBytes: null, freeBytes: null, cachedBytes: null };
    return parseDeviceMeminfo(res.stdout);
  }
}

export function parseDeviceMeminfo(text: string): DeviceMemoryReading {
  const read = (key: string): number | null => {
    const m = new RegExp(String.raw`^${key}:\s+(\d+)\s*kB`, 'm').exec(text);
    return m?.[1] ? Number(m[1]) * KB : null;
  };
  return {
    availableBytes: read('MemAvailable'),
    freeBytes: read('MemFree'),
    cachedBytes: read('Cached'),
  };
}

// ---------------------------------------------------------------------------
// Deep tier - per-mapping detail
// ---------------------------------------------------------------------------

/**
 * Per-mapping memory from `/proc/<pid>/smaps`.
 *
 * `dumpsys meminfo` says a category grew; this says *which mapping* grew, by
 * name - `libil2cpp.so`, `base.apk`, `/dev/kgsl-3d0`. That is the difference
 * between "graphics went up 137 MB" and "the GPU driver's allocations went up
 * 137 MB", which is the first fact a Unity developer can act on.
 *
 * It is best-effort by necessity. Another process's smaps is readable only when
 * the app is debuggable (via `run-as`) or the device is rooted; on a release
 * build on a stock handset it is denied by SELinux. The probe therefore reports
 * itself unavailable rather than failing the session, and the console says so
 * instead of quietly showing less.
 */
export class SmapsProbe implements MemoryProbe {
  readonly name = 'smaps';
  readonly tier = 'deep' as const;

  /** How the file turned out to be readable, decided once in isAvailable(). */
  private accessor: 'direct' | 'run-as' | 'su' | null = null;

  constructor(private readonly packageName: string) {}

  async isAvailable(device: AdbDevice, pid: number): Promise<boolean> {
    // Cheapest first. `smaps_rollup` is a one-line proxy for the same
    // permission, so availability costs a few hundred bytes rather than megabytes.
    const attempts: Array<['direct' | 'run-as' | 'su', string[]]> = [
      ['direct', ['cat', `/proc/${pid}/smaps_rollup`]],
      ['run-as', ['run-as', this.packageName, 'cat', `/proc/${pid}/smaps_rollup`]],
      ['su', ['su', '-c', `cat /proc/${pid}/smaps_rollup`]],
    ];

    for (const [accessor, argv] of attempts) {
      const res = await device.shell(argv, 10_000);
      if (res.code === 0 && /Pss:/i.test(res.stdout)) {
        this.accessor = accessor;
        return true;
      }
    }
    return false;
  }

  async sample(device: AdbDevice, pid: number): Promise<ProbeReading | null> {
    if (!this.accessor) return null;

    const path = `/proc/${pid}/smaps`;
    const argv =
      this.accessor === 'direct'
        ? ['cat', path]
        : this.accessor === 'run-as'
          ? ['run-as', this.packageName, 'cat', path]
          : ['su', '-c', `cat ${path}`];

    // A big game's smaps runs to a few MB of text, so the timeout is generous.
    const res = await device.shell(argv, 45_000);
    if (res.code !== 0 || res.stdout.length === 0) return null;

    const mappings = parseSmaps(res.stdout);
    return mappings.length > 0 ? { pssBytes: null, rssBytes: null, swapPssBytes: null, mappings } : null;
  }
}

/** A mapping header: `7f8a00000-7f8a10000 rw-p 00000000 00:00 12345  /path/to/lib.so` */
const MAPPING_HEADER = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S{4})\s+\S+\s+\S+\s+\S+\s*(.*)$/i;

/**
 * Fold smaps into one row per distinct mapping name.
 *
 * A process has thousands of VMAs but only dozens of distinct *things*: the same
 * library appears once per segment, and the allocator's arenas appear hundreds
 * of times. Grouping by name is what turns the file into a list a person can
 * read, and the VMA count is kept because "412 regions" is itself a signal.
 */
export function parseSmaps(text: string, opts: { limit?: number } = {}): MappingUsage[] {
  const groups = new Map<string, MappingUsage>();
  let current: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    const header = MAPPING_HEADER.exec(line);
    if (header) {
      current = normalizeMappingName((header[4] ?? '').trim());
      let entry = groups.get(current);
      if (!entry) {
        entry = {
          name: current,
          kind: classifyMapping(current),
          pssBytes: 0,
          privateBytes: 0,
          regions: 0,
        };
        groups.set(current, entry);
      }
      entry.regions++;
      continue;
    }

    if (!current) continue;
    const entry = groups.get(current);
    if (!entry) continue;

    const field = /^(Pss|Private_Clean|Private_Dirty):\s+(\d+)\s*kB/i.exec(line);
    if (!field) continue;
    const bytes = Number(field[2]) * KB;
    if (/^Pss$/i.test(field[1] ?? '')) entry.pssBytes += bytes;
    else entry.privateBytes += bytes;
  }

  const rows = [...groups.values()]
    .filter((m) => m.pssBytes > 0)
    .sort((a, b) => b.pssBytes - a.pssBytes);

  // Everything below the cut is real memory, so it is kept as one honest row
  // rather than dropped - a list that does not add up invites the wrong
  // conclusion about where the memory went.
  const limit = opts.limit ?? 40;
  if (rows.length <= limit) return rows;

  const kept = rows.slice(0, limit);
  const rest = rows.slice(limit);
  kept.push({
    name: `${rest.length} smaller mappings`,
    kind: 'other',
    pssBytes: rest.reduce((sum, m) => sum + m.pssBytes, 0),
    privateBytes: rest.reduce((sum, m) => sum + m.privateBytes, 0),
    regions: rest.reduce((sum, m) => sum + m.regions, 0),
  });
  return kept;
}

/**
 * Collapse per-process paths so the same thing groups across samples and devices.
 *
 * The APK directory carries a random suffix (`/data/app/~~aB3.../base.apk`), and
 * anonymous regions carry addresses. Neither is information; both would split
 * one thing into many rows.
 */
export function normalizeMappingName(path: string): string {
  if (path.length === 0) return '[anonymous]';

  // `[anon:libc_malloc]`, `[anon:scudo:primary]`, `[stack]`, `[heap]`
  if (path.startsWith('[')) return path.replace(/:\d+$/, '');

  // Keep the leaf for libraries and archives; keep the device node whole.
  if (path.startsWith('/dev/')) return path.replace(/\d+$/, '');
  if (path.startsWith('/memfd:')) return path.replace(/:\d+$/, '');
  if (path.startsWith('/dmabuf')) return '/dmabuf';

  const leaf = path.split('/').pop() ?? path;
  return leaf.length > 0 ? leaf : path;
}

/**
 * What a mapping is, in Unity's vocabulary.
 *
 * The point of the whole feature: the OS names a file, and a developer needs to
 * know that `libil2cpp.so` is their own C# and `/dev/kgsl-3d0` is their
 * textures. Anything unrecognised stays 'other' rather than being guessed at.
 */
export function classifyMapping(name: string): MappingKind {
  const n = name.toLowerCase();

  if (/^libunity\.so|^libmain\.so/.test(n)) return 'unity-engine';
  if (/^libil2cpp\.so|^libmono|^libmonobdwgc/.test(n)) return 'game-code';
  if (/\.so$/.test(n)) return 'native-library';
  if (/\.(apk|obb)$/.test(n)) return 'app-package';
  if (/\.(dex|odex|vdex|oat|art)$/.test(n)) return 'android-runtime';
  if (/kgsl|mali|pvr|nvmap|dmabuf|ion|memfd|gpu/.test(n)) return 'graphics';
  if (/dalvik/.test(n)) return 'java-heap';
  if (/libc_malloc|scudo|jemalloc|^\[heap\]/.test(n)) return 'native-alloc';
  if (/^\[stack/.test(n)) return 'stack';
  if (/ashmem/.test(n)) return 'shared';
  if (/\.(bundle|unity3d|assets|resource|res[Ss])/.test(n)) return 'unity-content';

  return 'other';
}
