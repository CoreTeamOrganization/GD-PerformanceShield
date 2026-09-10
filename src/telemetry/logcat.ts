/**
 * Logcat monitor.
 *
 * The kernel and framework announce the events that matter most for OOM work -
 * lowmemorykiller decisions, `am_kill`, `ActivityManager: Killing`, Java OOM
 * exceptions, native abort - and none of those are visible in a PSS curve.
 * A session without these lines can tell you memory grew; with them it can tell
 * you the OS took the app down and why.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { Logger } from '../core/logger.js';
import type { AdbDevice } from '../devices/adb.js';
import { TELEMETRY_SCHEMA_VERSION, type LogEvent } from './types.js';

interface Matcher {
  re: RegExp;
  category: LogEvent['category'];
  /**
   * True for the lines where the OS itself reclaimed a process. The remaining
   * `oom_kill` patterns are in-app allocation failures - a crash of our own
   * making rather than an automatic kill.
   */
  systemKill?: boolean;
}

/** Ordered: the first match wins, so specific patterns precede general ones. */
const MATCHERS: Matcher[] = [
  {
    re: /lowmemorykiller|lmkd|Kill(ing|ed)? '?[^']*'? \(\d+\).*(adj|because)/i,
    category: 'oom_kill',
    systemKill: true,
  },
  {
    re: /am_kill|ActivityManager:\s*Killing\b|Process .* has died/i,
    category: 'oom_kill',
    systemKill: true,
  },
  { re: /OutOfMemoryError|Out of memory|failed to allocate|Abort message.*OOM/i, category: 'oom_kill' },
  { re: /onTrimMemory|onLowMemory|LowMemoryDetector|memory pressure/i, category: 'low_memory' },
  { re: /FATAL EXCEPTION|Fatal signal \d+|libc\s*:\s*Fatal|tombstone/i, category: 'crash' },
  { re: /ANR in |Input dispatching timed out/i, category: 'anr' },
  { re: /\bGC_|Explicit concurrent .*GC|Background .*GC .*freed/i, category: 'gc' },
  { re: /^Unity\b|UnityEngine|Unity\s*:/i, category: 'unity' },
  // Activity starts, for the context lines on the charts: ads are separate
  // activities with recognizable SDK classes, and home/return are the same
  // announcement. Emitted by system_server, so it must count as a system
  // signal below or a pid filter would drop every one of them.
  { re: /Activity(Task)?Manager: START u\d/, category: 'activity' },
];

export interface LogcatMonitorOptions {
  device: AdbDevice;
  serial: string;
  sessionStartMs: number;
  /** Only keep lines belonging to these PIDs, plus system-wide kill notices. */
  pids?: number[];
  /** Used to tell whether a system-wide kill notice names the game under test. */
  packageName?: string;
  logger?: Logger;
}

export class LogcatMonitor extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopped = false;
  private lineCount = 0;
  private keptCount = 0;

  constructor(private readonly opts: LogcatMonitorOptions) {
    super();
  }

  get stats(): { lines: number; kept: number } {
    return { lines: this.lineCount, kept: this.keptCount };
  }

  /**
   * Start streaming. We clear the buffer first so the session only contains
   * lines produced during this run, and use the threadtime format because it is
   * the one format present on every Android version we target.
   */
  async start(): Promise<void> {
    await this.opts.device.clearLogcat().catch(() => {
      this.opts.logger?.debug('logcat -c failed; continuing with the existing buffer');
    });

    this.child = this.opts.device.spawnStream(['logcat', '-v', 'threadtime']);
    this.child.on('error', (err) => {
      this.opts.logger?.warn('logcat stream error', { error: err.message });
    });
    this.child.on('close', () => {
      if (!this.stopped) this.opts.logger?.warn('logcat stream closed unexpectedly');
    });

    if (!this.child.stdout) return;
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill('SIGKILL');
    this.child = null;
  }

  private handleLine(line: string): void {
    this.lineCount++;
    const parsed = parseLogcatLine(line);
    if (!parsed) return;

    const category = classify(line, parsed.tag);
    if (!category) return;

    // Keep app-scoped lines plus any system line that names our package/pids -
    // a kill notice is emitted by system_server, not by the game process.
    const namesPackage = Boolean(this.opts.packageName && line.includes(this.opts.packageName));
    let appRelated = namesPackage;
    if (this.opts.pids?.length) {
      const belongsToApp = this.opts.pids.includes(parsed.pid);
      const mentionsApp = this.opts.pids.some((p) => line.includes(String(p)));
      appRelated = appRelated || belongsToApp || mentionsApp;
      const isSystemSignal =
        category === 'oom_kill' || category === 'low_memory' || category === 'anr' ||
        category === 'activity';
      if (!appRelated && !isSystemSignal) return;
    }

    this.keptCount++;
    const t = Date.now();
    const event: LogEvent = {
      schema: TELEMETRY_SCHEMA_VERSION,
      t,
      elapsedMs: t - this.opts.sessionStartMs,
      serial: this.opts.serial,
      level: parsed.level,
      tag: parsed.tag,
      message: parsed.message.slice(0, 1000),
      category,
      appRelated,
    };
    this.emit('log', event);
  }
}

export interface ParsedLogLine {
  pid: number;
  tid: number;
  level: string;
  tag: string;
  message: string;
}

/**
 * threadtime format:
 * `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message`
 */
export function parseLogcatLine(line: string): ParsedLogLine | null {
  const m = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*?):\s?(.*)$/.exec(
    line,
  );
  if (!m) return null;
  return {
    pid: Number(m[1]),
    tid: Number(m[2]),
    level: m[3] ?? 'I',
    tag: (m[4] ?? '').trim(),
    message: m[5] ?? '',
  };
}

export function classify(line: string, tag: string): LogEvent['category'] | null {
  for (const matcher of MATCHERS) {
    if (matcher.re.test(line) || matcher.re.test(tag)) return matcher.category;
  }
  return null;
}

/**
 * Whether a stored log line is the OS announcing that it reclaimed a process -
 * a lowmemorykiller or ActivityManager kill - rather than an in-app allocation
 * failure. Reconstructs the `tag: message` shape `classify` sees, because the
 * tag is stored separately but some patterns match on it.
 */
export function isSystemKillLine(message: string, tag: string): boolean {
  const line = `${tag}: ${message}`;
  return MATCHERS.some((m) => m.systemKill && (m.re.test(line) || m.re.test(tag)));
}
