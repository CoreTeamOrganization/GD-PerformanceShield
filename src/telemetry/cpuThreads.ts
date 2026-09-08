/**
 * CPU cores, clusters and per-thread load.
 *
 * Everything here comes out of /proc and /sys, which on Android are readable
 * for your own app's process by an adb shell without root:
 *
 *   /proc/stat                                  per-core jiffies, whole device
 *   /proc/<pid>/stat                            the process's own jiffies
 *   /proc/<pid>/task/<tid>/stat                 per-thread jiffies, name, last core
 *   /sys/devices/system/cpu/cpuN/cpufreq/...    current and maximum clock
 *
 * Two design points that matter for correctness:
 *
 *  1. Every one of these counters is cumulative. A load figure is a difference
 *     between two reads divided by the wall-clock time between them, so the
 *     first sample of a session can only establish a baseline and reports null.
 *     A cumulative counter presented as an instantaneous load would read as
 *     "the main thread used 4% of a core" for a game that had been pinning it
 *     for twenty minutes.
 *
 *  2. Thread load is expressed as a percentage of **one** core, because that is
 *     the number that means something: a game's main thread cannot be spread
 *     across cores, so 100% is saturated and no amount of idle silicon
 *     elsewhere will help it. Whole-device figures are a percentage of all
 *     cores. Mixing the two bases is how "the CPU was 30% busy" gets written
 *     about a game that was completely main-thread bound.
 */
import type { AdbDevice } from '../devices/adb.js';
import type { Logger } from '../core/logger.js';

/**
 * What a thread is, in terms a Unity developer recognises.
 *
 * Deliberately coarse. The point is to separate the three that decide a frame -
 * game logic, render submission and job workers - from the noise of eighty
 * Binder and JIT threads, not to name every one of them.
 */
export type ThreadRole = 'main' | 'render' | 'worker' | 'audio' | 'gc' | 'io' | 'other';

/** Where a core sits in a big.LITTLE arrangement. */
export type CoreCluster = 'little' | 'mid' | 'big' | 'uniform';

export interface CoreReading {
  /** Index as the kernel numbers it: `cpu0`, `cpu1`... */
  cpu: number;
  cluster: CoreCluster;
  /** Percentage of this one core that was busy over the window. */
  usagePercent: number | null;
  freqMhz: number | null;
  maxFreqMhz: number | null;
  /** True when the core was offline - hotplugged out, so it read nothing. */
  offline: boolean;
}

export interface ThreadReading {
  tid: number;
  /** As the kernel has it, truncated to 15 characters: `UnityMain`, `UnityGfxDeviceW`. */
  name: string;
  role: ThreadRole;
  /** Percentage of one core. Over 100 is impossible and is clamped. */
  cpuPercent: number;
  /** The core it last ran on, which is what makes core affinity visible. */
  lastCpu: number | null;
  /** Which cluster that core belongs to. */
  lastCluster: CoreCluster | null;
}

export interface CpuReading {
  /** The game process, as a percentage of one core. Can exceed 100. */
  appCpuPercentOfCore: number | null;
  /** The game process, as a percentage of the whole device's capacity. */
  appCpuPercentOfDevice: number | null;
  /** Every process, as a percentage of the whole device's capacity. */
  systemCpuPercentOfDevice: number | null;
  /**
   * Everything that is not the game, as a share of device capacity.
   *
   * The figure that answers "is this the game or is this the phone?" - a
   * launcher indexing photos in the background will drop frames in a game that
   * is doing nothing wrong, and without this the game gets the blame.
   */
  otherCpuPercentOfDevice: number | null;
  cores: CoreReading[];
  /** The heaviest threads this window, biggest first. */
  threads: ThreadReading[];
  /** How many threads the process had, whether or not they were busy. */
  threadCount: number;
}

/** One acquisition strategy that was tried, and what came back. */
export interface CpuAttempt {
  strategy: string;
  ok: boolean;
  detail: string;
}

interface Jiffies {
  /** Busy jiffies. */
  busy: number;
  /** Busy + idle. Absent for per-thread counters, which have no idle. */
  total?: number;
}

/**
 * Samples core and thread load for one process on one device.
 *
 * Stateful: every counter it reads is cumulative, so it holds the previous read
 * to difference against, and the clock ticks per second and cluster layout are
 * resolved once rather than re-read every sample.
 */
export class CpuThreadProbe {
  private clockTick = 100;
  private clusterByCpu = new Map<number, CoreCluster>();
  private maxFreqByCpu = new Map<number, number>();
  private available = false;
  private threadsReadable = false;
  private readonly attempts: CpuAttempt[] = [];

  private lastAt: number | null = null;
  private lastProcess: Jiffies | null = null;
  private lastPerCore = new Map<number, Jiffies>();
  private lastPerThread = new Map<number, number>();

  constructor(
    private readonly device: AdbDevice,
    private readonly logger?: Logger,
  ) {}

  get diagnostics(): CpuAttempt[] {
    return this.attempts;
  }

  /** True when per-thread detail is readable, not just whole-process load. */
  get hasThreadDetail(): boolean {
    return this.threadsReadable;
  }

  async prepare(pid: number): Promise<boolean> {
    // getconf is present in Android's toybox. The value has been 100 on every
    // Android kernel ever shipped, but reading it beats assuming it.
    const tick = await this.device.shell(['getconf', 'CLK_TCK'], 10_000);
    const parsed = Number(tick.stdout.trim());
    if (Number.isFinite(parsed) && parsed > 0) this.clockTick = parsed;

    const stat = await this.device.shell(['cat', '/proc/stat'], 10_000);
    this.available = stat.code === 0 && /^cpu\s/m.test(stat.stdout);
    this.note('/proc/stat', this.available, this.available ? 'per-core jiffies readable' : 'not readable');

    const threads = await this.device.shell(['cat', `/proc/${pid}/task/${pid}/stat`], 10_000);
    this.threadsReadable = threads.code === 0 && threads.stdout.includes('(');
    this.note(
      '/proc/<pid>/task',
      this.threadsReadable,
      this.threadsReadable
        ? 'per-thread counters readable'
        : 'hidepid or SELinux is hiding the thread list; only whole-process load will be reported',
    );

    await this.readTopology();

    if (!this.available) {
      this.logger?.info('CPU load is not readable on this device', {
        consequence:
          'The report will say CPU load was not measurable rather than assume the device was idle.',
      });
    }

    return this.available;
  }

  /**
   * Cluster layout, from each core's maximum frequency.
   *
   * This is how big.LITTLE is actually detectable without a vendor table: cores
   * in the same cluster share a ceiling, and the distinct ceilings on a phone
   * are its clusters. A 1+3+4 arrangement reads as three distinct maxima, which
   * is exactly the little/mid/big split.
   */
  private async readTopology(): Promise<void> {
    const script =
      'for c in /sys/devices/system/cpu/cpu[0-9]*; do ' +
      'n=${c##*/cpu}; printf "%s:%s\\n" "$n" "$(cat $c/cpufreq/cpuinfo_max_freq 2>/dev/null)"; done';
    const res = await this.device.script(script, 15_000);
    if (res.code !== 0) {
      this.note('cpufreq topology', false, 'maximum frequencies not readable; clusters unknown');
      return;
    }

    const maxima = parseCpuMaxFreq(res.stdout);
    this.maxFreqByCpu = new Map([...maxima].map(([cpu, khz]) => [cpu, Math.round(khz / 1000)]));
    this.clusterByCpu = classifyClusters(maxima);
    this.note(
      'cpufreq topology',
      maxima.size > 0,
      maxima.size > 0
        ? `${maxima.size} cores, ${new Set(maxima.values()).size} cluster(s)`
        : 'no cores reported a maximum frequency',
    );
  }

  /**
   * One sample: one adb round trip for everything.
   *
   * Four files in one shell script rather than four `cat` calls, because this
   * runs against a game we are trying not to perturb and each round trip is
   * tens of milliseconds of adb and shell startup.
   */
  async sample(pid: number): Promise<CpuReading | null> {
    if (!this.available) return null;

    const script =
      `cat /proc/stat; echo '###'; ` +
      `cat /proc/${pid}/stat; echo '###'; ` +
      `cat /proc/${pid}/task/*/stat 2>/dev/null; echo '###'; ` +
      `for c in /sys/devices/system/cpu/cpu[0-9]*; do ` +
      `n=\${c##*/cpu}; printf "%s:%s\\n" "$n" "$(cat $c/cpufreq/scaling_cur_freq 2>/dev/null)"; done`;

    const res = await this.device.script(script, 20_000);
    if (res.code !== 0) return null;

    const [statText = '', processText = '', threadText = '', freqText = ''] =
      res.stdout.split('###');

    const now = Date.now();
    const elapsedMs = this.lastAt === null ? null : now - this.lastAt;
    // Full capacity for the window, in jiffies of one core.
    const windowJiffies = elapsedMs === null ? null : (elapsedMs / 1000) * this.clockTick;

    const perCore = parseProcStat(statText);
    const process = parseProcessJiffies(processText);
    const threads = parseThreadStats(threadText);
    const freqs = parseCpuCurFreq(freqText);

    // Cores first, because the device-wide figures are a sum over them.
    const cores: CoreReading[] = [];
    let deviceBusyDelta = 0;
    let deviceTotalDelta = 0;

    for (const [cpu, current] of perCore) {
      const previous = this.lastPerCore.get(cpu);
      let usagePercent: number | null = null;
      if (previous && current.total !== undefined && previous.total !== undefined) {
        const busyDelta = current.busy - previous.busy;
        const totalDelta = current.total - previous.total;
        if (totalDelta > 0 && busyDelta >= 0) {
          usagePercent = round1(Math.min(100, (busyDelta / totalDelta) * 100));
          deviceBusyDelta += busyDelta;
          deviceTotalDelta += totalDelta;
        }
      }

      const khz = freqs.get(cpu);
      cores.push({
        cpu,
        cluster: this.clusterByCpu.get(cpu) ?? 'uniform',
        usagePercent,
        // A core that is hotplugged out reports nothing, which is a real state
        // and not a missing reading - phones park their big cores when idle.
        freqMhz: khz !== undefined ? Math.round(khz / 1000) : null,
        maxFreqMhz: this.maxFreqByCpu.get(cpu) ?? null,
        offline: khz === undefined && usagePercent === null,
      });
    }
    cores.sort((a, b) => a.cpu - b.cpu);

    // Process load, as a share of one core and of the whole device.
    let appOfCore: number | null = null;
    if (process && this.lastProcess && windowJiffies !== null && windowJiffies > 0) {
      const delta = process.busy - this.lastProcess.busy;
      if (delta >= 0) appOfCore = round1((delta / windowJiffies) * 100);
    }

    const coreCount = cores.length > 0 ? cores.length : null;
    const appOfDevice =
      appOfCore !== null && coreCount ? round1(Math.min(100, appOfCore / coreCount)) : null;
    const systemOfDevice =
      deviceTotalDelta > 0 ? round1((deviceBusyDelta / deviceTotalDelta) * 100) : null;

    // Threads, with the ones that decide a frame named.
    const threadReadings: ThreadReading[] = [];
    for (const t of threads) {
      const previous = this.lastPerThread.get(t.tid);
      this.lastPerThread.set(t.tid, t.busy);
      if (previous === undefined || windowJiffies === null || windowJiffies <= 0) continue;

      const delta = t.busy - previous;
      if (delta < 0) continue; // tid reused after the thread exited
      const cpuPercent = round1(Math.min(100, (delta / windowJiffies) * 100));
      if (cpuPercent <= 0) continue; // an idle thread is not information

      threadReadings.push({
        tid: t.tid,
        name: t.name,
        role: classifyThread(t.name),
        cpuPercent,
        lastCpu: t.lastCpu,
        lastCluster: t.lastCpu === null ? null : this.clusterByCpu.get(t.lastCpu) ?? null,
      });
    }
    threadReadings.sort((a, b) => b.cpuPercent - a.cpuPercent);

    // Forget threads that have gone, so a long session does not accumulate a
    // map entry for every short-lived Binder thread the app ever spawned.
    const liveTids = new Set(threads.map((t) => t.tid));
    for (const tid of [...this.lastPerThread.keys()]) {
      if (!liveTids.has(tid)) this.lastPerThread.delete(tid);
    }

    this.lastAt = now;
    if (process) this.lastProcess = process;
    this.lastPerCore = perCore;

    return {
      appCpuPercentOfCore: appOfCore,
      appCpuPercentOfDevice: appOfDevice,
      systemCpuPercentOfDevice: systemOfDevice,
      otherCpuPercentOfDevice:
        systemOfDevice !== null && appOfDevice !== null
          ? round1(Math.max(0, systemOfDevice - appOfDevice))
          : null,
      cores,
      // Twelve is enough to hold main, render, every job worker and the audio
      // thread on any handset, and short enough to put in a report.
      threads: threadReadings.slice(0, 12),
      threadCount: threads.length,
    };
  }

  private note(strategy: string, ok: boolean, detail: string): void {
    this.attempts.push({ strategy, ok, detail });
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Per-core jiffies out of /proc/stat.
 *
 * Fields after `cpuN` are user, nice, system, idle, iowait, irq, softirq,
 * steal, guest, guest_nice. Idle and iowait are the not-busy ones; everything
 * else is work. iowait counts as idle deliberately - a core waiting on the
 * flash is not executing anything, and counting it as busy would make a disk
 * stall look like a CPU bottleneck, which is the exact confusion the storage
 * module exists to resolve.
 */
export function parseProcStat(text: string): Map<number, Jiffies> {
  const out = new Map<number, Jiffies>();
  const re = /^cpu(\d+)\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cpu = Number(m[1]);
    const values = (m[2] ?? '').trim().split(/\s+/).map(Number);
    if (values.some((v) => !Number.isFinite(v))) continue;
    const total = values.reduce((a, b) => a + b, 0);
    const idle = (values[3] ?? 0) + (values[4] ?? 0);
    out.set(cpu, { busy: total - idle, total });
  }
  return out;
}

/**
 * utime + stime out of a `/proc/<pid>/stat` line.
 *
 * The comm field is field 2 and is wrapped in parentheses which may themselves
 * contain spaces and parentheses - `(Job.Worker 0)` does - so the line is split
 * at the *last* `)` rather than on whitespace. Splitting on whitespace is the
 * classic bug here and it silently shifts every subsequent field by one.
 */
export function parseProcessJiffies(text: string): Jiffies | null {
  const line = text.trim().split('\n')[0];
  if (!line) return null;
  const close = line.lastIndexOf(')');
  if (close === -1) return null;
  const fields = line.slice(close + 1).trim().split(/\s+/).map(Number);
  // After the comm field, field 3 is state; utime is field 14 and stime 15, so
  // they are index 11 and 12 of what remains.
  const utime = fields[11];
  const stime = fields[12];
  if (utime === undefined || stime === undefined) return null;
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { busy: utime + stime };
}

export interface RawThread {
  tid: number;
  name: string;
  busy: number;
  lastCpu: number | null;
}

/** Every `/proc/<pid>/task/*\/stat` line in one concatenated read. */
export function parseThreadStats(text: string): RawThread[] {
  const out: RawThread[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const open = trimmed.indexOf('(');
    const close = trimmed.lastIndexOf(')');
    if (open === -1 || close === -1 || close < open) continue;

    const tid = Number(trimmed.slice(0, open).trim());
    const name = trimmed.slice(open + 1, close);
    const fields = trimmed.slice(close + 1).trim().split(/\s+/).map(Number);
    const utime = fields[11];
    const stime = fields[12];
    // Field 39 is the last CPU the thread ran on: index 36 after comm.
    const lastCpu = fields[36];
    if (!Number.isFinite(tid) || utime === undefined || stime === undefined) continue;
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) continue;

    out.push({
      tid,
      name,
      busy: utime + stime,
      lastCpu: lastCpu !== undefined && Number.isFinite(lastCpu) ? lastCpu : null,
    });
  }
  return out;
}

/** `N:frequency-in-kHz` lines, one per core, with blanks for offline cores. */
export function parseCpuCurFreq(text: string): Map<number, number> {
  return parseCpuKeyValue(text);
}

export function parseCpuMaxFreq(text: string): Map<number, number> {
  return parseCpuKeyValue(text);
}

function parseCpuKeyValue(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split('\n')) {
    const [left, right] = line.trim().split(':');
    if (left === undefined || right === undefined) continue;
    const cpu = Number(left);
    const khz = Number(right.trim());
    if (!Number.isFinite(cpu) || !Number.isFinite(khz) || khz <= 0) continue;
    out.set(cpu, khz);
  }
  return out;
}

/**
 * Group cores into clusters by their maximum frequency.
 *
 * One distinct maximum means a uniform SoC and saying "big" about all of it
 * would be a claim about hardware that is not there. Two means little/big.
 * Three or more - the 1+3+4 arrangement most current phones use - means the
 * lowest is little, the highest big, and everything between is mid.
 */
export function classifyClusters(maxFreqByCpu: Map<number, number>): Map<number, CoreCluster> {
  const out = new Map<number, CoreCluster>();
  const distinct = [...new Set(maxFreqByCpu.values())].sort((a, b) => a - b);
  if (distinct.length <= 1) {
    for (const cpu of maxFreqByCpu.keys()) out.set(cpu, 'uniform');
    return out;
  }

  const lowest = distinct[0]!;
  const highest = distinct[distinct.length - 1]!;
  for (const [cpu, khz] of maxFreqByCpu) {
    out.set(cpu, khz === lowest ? 'little' : khz === highest ? 'big' : 'mid');
  }
  return out;
}

/**
 * Name a thread by what it does.
 *
 * The kernel truncates `comm` to 15 characters, which is why the render thread
 * matches as `UnityGfxDeviceW` and not `UnityGfxDeviceWorker`. Matched on
 * prefixes rather than equality for that reason.
 */
export function classifyThread(name: string): ThreadRole {
  const n = name.toLowerCase();

  // Unity's main thread is `UnityMain`. On some builds the process's first
  // thread carries the package name instead, which the caller resolves by tid.
  if (n === 'unitymain' || n.startsWith('unitymain')) return 'main';
  if (n.startsWith('unitygfxdevice') || n === 'renderthread' || n.startsWith('gfxdevice')) {
    return 'render';
  }
  if (n.startsWith('unityworker') || n.startsWith('job.worker') || n.startsWith('worker')) {
    return 'worker';
  }
  if (
    n.startsWith('fmod') ||
    n.startsWith('audiotrack') ||
    n.includes('oboe') ||
    n.startsWith('unityaudio') ||
    n.startsWith('aaudio')
  ) {
    return 'audio';
  }
  if (n.startsWith('hea') || n.includes('gc') || n.startsWith('finalizer')) return 'gc';
  if (n.startsWith('unityprelo') || n.startsWith('asyncload') || n.includes('io')) return 'io';
  return 'other';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Session-level summary
// ---------------------------------------------------------------------------

export interface ThreadLoadSummary {
  name: string;
  role: ThreadRole;
  /** Mean percentage of one core over the samples this thread appeared in. */
  averageCpuPercent: number;
  peakCpuPercent: number;
  /** Share of samples where it was above 85% of a core - effectively pinned. */
  saturatedSamplePercent: number;
  /** Which cluster it ran on most often, and how consistently. */
  dominantCluster: CoreCluster | null;
  clusterConsistencyPercent: number | null;
  sampleCount: number;
}

export interface ClusterLoadSummary {
  cluster: CoreCluster;
  coreCount: number;
  averageUsagePercent: number | null;
  peakUsagePercent: number | null;
  averageFreqMhz: number | null;
  maxFreqMhz: number | null;
  /** Share of samples where the cluster's clock was within 5% of its ceiling. */
  clockPinnedPercent: number | null;
}

export interface CpuSummary {
  /** The game process, as a percentage of one core. Over 100 means it threads. */
  averageAppCpuPercentOfCore: number | null;
  peakAppCpuPercentOfCore: number | null;
  averageAppCpuPercentOfDevice: number | null;
  averageSystemCpuPercentOfDevice: number | null;
  /** Background load: the phone's contribution, not the game's. */
  averageOtherCpuPercentOfDevice: number | null;
  peakOtherCpuPercentOfDevice: number | null;
  clusters: ClusterLoadSummary[];
  /** The threads that did the work, heaviest first. */
  threads: ThreadLoadSummary[];
  /** Named for what they are, because these three decide a frame. */
  mainThread: ThreadLoadSummary | null;
  renderThread: ThreadLoadSummary | null;
  averageThreadCount: number | null;
  sampleCount: number;
  unavailableReason: string | null;
}

export function summarizeCpu(
  readings: CpuReading[],
  unavailableReason: string | null,
): CpuSummary {
  if (readings.length === 0) {
    return {
      averageAppCpuPercentOfCore: null,
      peakAppCpuPercentOfCore: null,
      averageAppCpuPercentOfDevice: null,
      averageSystemCpuPercentOfDevice: null,
      averageOtherCpuPercentOfDevice: null,
      peakOtherCpuPercentOfDevice: null,
      clusters: [],
      threads: [],
      mainThread: null,
      renderThread: null,
      averageThreadCount: null,
      sampleCount: 0,
      unavailableReason,
    };
  }

  const series = (pick: (r: CpuReading) => number | null): number[] =>
    readings.map(pick).filter((v): v is number => v !== null);

  const app = series((r) => r.appCpuPercentOfCore);
  const appDevice = series((r) => r.appCpuPercentOfDevice);
  const system = series((r) => r.systemCpuPercentOfDevice);
  const other = series((r) => r.otherCpuPercentOfDevice);

  return {
    averageAppCpuPercentOfCore: app.length ? round1(mean(app)) : null,
    peakAppCpuPercentOfCore: app.length ? round1(Math.max(...app)) : null,
    averageAppCpuPercentOfDevice: appDevice.length ? round1(mean(appDevice)) : null,
    averageSystemCpuPercentOfDevice: system.length ? round1(mean(system)) : null,
    averageOtherCpuPercentOfDevice: other.length ? round1(mean(other)) : null,
    peakOtherCpuPercentOfDevice: other.length ? round1(Math.max(...other)) : null,
    clusters: summarizeClusters(readings),
    threads: summarizeThreads(readings),
    mainThread: summarizeThreads(readings).find((t) => t.role === 'main') ?? null,
    renderThread: summarizeThreads(readings).find((t) => t.role === 'render') ?? null,
    averageThreadCount: round1(mean(readings.map((r) => r.threadCount))),
    sampleCount: readings.length,
    unavailableReason: app.length > 0 ? null : unavailableReason,
  };
}

function summarizeClusters(readings: CpuReading[]): ClusterLoadSummary[] {
  const byCluster = new Map<
    CoreCluster,
    { cpus: Set<number>; usage: number[]; freq: number[]; pinned: number; freqSamples: number; maxFreq: number }
  >();

  for (const reading of readings) {
    for (const core of reading.cores) {
      let bucket = byCluster.get(core.cluster);
      if (!bucket) {
        bucket = { cpus: new Set(), usage: [], freq: [], pinned: 0, freqSamples: 0, maxFreq: 0 };
        byCluster.set(core.cluster, bucket);
      }
      bucket.cpus.add(core.cpu);
      if (core.usagePercent !== null) bucket.usage.push(core.usagePercent);
      if (core.maxFreqMhz !== null) bucket.maxFreq = Math.max(bucket.maxFreq, core.maxFreqMhz);
      if (core.freqMhz !== null) {
        bucket.freq.push(core.freqMhz);
        bucket.freqSamples++;
        if (core.maxFreqMhz !== null && core.freqMhz >= core.maxFreqMhz * 0.95) bucket.pinned++;
      }
    }
  }

  const order: CoreCluster[] = ['big', 'mid', 'little', 'uniform'];
  return [...byCluster.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([cluster, b]) => ({
      cluster,
      coreCount: b.cpus.size,
      averageUsagePercent: b.usage.length ? round1(mean(b.usage)) : null,
      peakUsagePercent: b.usage.length ? round1(Math.max(...b.usage)) : null,
      averageFreqMhz: b.freq.length ? Math.round(mean(b.freq)) : null,
      maxFreqMhz: b.maxFreq > 0 ? b.maxFreq : null,
      clockPinnedPercent: b.freqSamples > 0 ? round1((b.pinned / b.freqSamples) * 100) : null,
    }));
}

/**
 * Reduce per-sample thread readings to one row per thread name.
 *
 * Keyed on name rather than tid, because Unity's job workers come and go and a
 * per-tid table would list "Job.Worker 3" eleven times with a different id and
 * mean nothing. The main and render threads live for the whole process, so
 * their rows are exact.
 */
function summarizeThreads(readings: CpuReading[]): ThreadLoadSummary[] {
  const byName = new Map<
    string,
    { role: ThreadRole; values: number[]; saturated: number; clusters: Map<CoreCluster, number> }
  >();

  for (const reading of readings) {
    for (const thread of reading.threads) {
      let bucket = byName.get(thread.name);
      if (!bucket) {
        bucket = { role: thread.role, values: [], saturated: 0, clusters: new Map() };
        byName.set(thread.name, bucket);
      }
      bucket.values.push(thread.cpuPercent);
      if (thread.cpuPercent >= 85) bucket.saturated++;
      if (thread.lastCluster) {
        bucket.clusters.set(thread.lastCluster, (bucket.clusters.get(thread.lastCluster) ?? 0) + 1);
      }
    }
  }

  const rows: ThreadLoadSummary[] = [];
  for (const [name, b] of byName) {
    const clusterTotal = [...b.clusters.values()].reduce((a, c) => a + c, 0);
    const dominant = [...b.clusters.entries()].sort((x, y) => y[1] - x[1])[0] ?? null;
    rows.push({
      name,
      role: b.role,
      averageCpuPercent: round1(mean(b.values)),
      peakCpuPercent: round1(Math.max(...b.values)),
      saturatedSamplePercent: round1((b.saturated / b.values.length) * 100),
      dominantCluster: dominant?.[0] ?? null,
      clusterConsistencyPercent:
        dominant && clusterTotal > 0 ? round1((dominant[1] / clusterTotal) * 100) : null,
      sampleCount: b.values.length,
    });
  }

  // By average, not peak: a thread that is busy every frame matters more than
  // one that spiked once during a scene load.
  rows.sort((a, b) => b.averageCpuPercent - a.averageCpuPercent);
  return rows.slice(0, 10);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
