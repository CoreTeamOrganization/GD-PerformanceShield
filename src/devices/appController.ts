/**
 * Step 5 - APK install, launch, PID detection and restart detection.
 *
 * PID detection is the subtle part. Two facts drive the design:
 *  1. Unity games spawn helper processes (`:unityads`, `:gcm`, `:crashpad`).
 *     Profiling the wrong one produces a flat, meaningless memory curve.
 *  2. When the OS kills the app for memory pressure, Android may relaunch it
 *     with a new PID. A sampler that keeps polling the dead PID records a
 *     "clean" session and silently loses the single most important event.
 *
 * `ProcessWatcher` therefore tracks the main PID continuously and emits a
 * lifecycle event whenever it changes or disappears.
 */
import { EventEmitter } from 'node:events';

import { DeviceError } from '../core/errors.js';
import { sleep, waitFor } from '../core/exec.js';
import type { Logger } from '../core/logger.js';
import type { AdbDevice } from './adb.js';

export interface LaunchOptions {
  packageName: string;
  /** `package/activity`. When absent we fall back to monkey. */
  launchComponent?: string | null;
  /** Wipe app data first, for a true cold-launch test (spec Test A). */
  freshState?: boolean;
  /** Time allowed for the process to appear after `am start`. */
  pidTimeoutMs?: number;
  logger?: Logger;
}

/**
 * How many times to fight for the foreground before giving up and saying so.
 *
 * Two retries: the usual cause is a one-off (an ad activity, a resumed task)
 * that clears once the game is brought forward again. An app that wins three
 * times is not going to be beaten by a fourth attempt, and continuing would
 * only delay the warning that the session is not measuring what it claims.
 */
const FOREGROUND_ATTEMPTS = 3;

/** Long enough for the window transition to settle before reading it back. */
const FOREGROUND_SETTLE_MS = 1500;

export interface LaunchResult {
  packageName: string;
  pid: number;
  launchedAt: string;
  /** Wall time from `am start` to a resolved PID. */
  launchDurationMs: number;
  /** `am start -W` TotalTime, when the device reported it. */
  reportedTotalTimeMs: number | null;
  method: 'component' | 'monkey';
  /**
   * Whether the game actually reached the foreground.
   *
   * False means every frame-rate figure from this session is worthless: a Unity
   * app in the background keeps its PID and keeps reporting memory, but its
   * renderer is throttled or paused. The measurement looks entirely normal and
   * is not of the game running.
   */
  foregrounded: boolean;
  /** What held the foreground instead, when the game did not get it. */
  foregroundPackage: string | null;
  /** How many times the launch had to be repeated to win the foreground. */
  launchAttempts: number;
  helperProcesses: Array<{ pid: number; name: string }>;
}

export class AppController {
  constructor(
    private readonly device: AdbDevice,
    private readonly logger?: Logger,
  ) {}

  async install(
    apkPath: string,
    opts: { fresh?: boolean; packageName?: string } = {},
  ): Promise<{ reinstalled: boolean; durationMs: number }> {
    const started = Date.now();

    if (opts.fresh && opts.packageName) {
      if (await this.device.isInstalled(opts.packageName)) {
        this.logger?.info('Uninstalling previous build for a clean install', {
          package: opts.packageName,
        });
        await this.device.uninstall(opts.packageName);
      }
    }

    const wasInstalled = opts.packageName ? await this.device.isInstalled(opts.packageName) : false;
    this.logger?.info('Installing APK', { serial: this.device.serial, fresh: Boolean(opts.fresh) });
    await this.device.install(apkPath, { reinstall: true, grantAll: true });

    return { reinstalled: wasInstalled, durationMs: Date.now() - started };
  }

  /**
   * Force-stop, launch, and resolve the main PID.
   *
   * We always force-stop first: an already-running instance would give us a
   * warm process whose baseline memory is not a cold-launch baseline.
   */
  async launch(opts: LaunchOptions): Promise<LaunchResult> {
    const { packageName, launchComponent, freshState = false, pidTimeoutMs = 60_000 } = opts;
    const log = opts.logger ?? this.logger;

    if (!(await this.device.isInstalled(packageName))) {
      throw new DeviceError(`${packageName} is not installed on ${this.device.serial}`, {
        hint: 'Run the install step before launching.',
      });
    }

    await this.device.forceStop(packageName);
    if (freshState) {
      log?.info('Clearing app data for a cold-launch baseline', { package: packageName });
      await this.device.clearData(packageName);
    }
    await sleep(500);

    const started = Date.now();
    let method: LaunchResult['method'] = 'component';
    let reportedTotalTimeMs: number | null = null;

    if (launchComponent) {
      const res = await this.device.startActivity(launchComponent);
      const combined = `${res.stdout}\n${res.stderr}`;
      if (/Error|does not exist|Exception/i.test(combined)) {
        log?.warn('Launching by component failed; falling back to monkey', {
          component: launchComponent,
        });
        method = 'monkey';
        await this.device.startViaMonkey(packageName);
      } else {
        reportedTotalTimeMs = Number(/TotalTime:\s*(\d+)/.exec(combined)?.[1] ?? '') || null;
      }
    } else {
      method = 'monkey';
      await this.device.startViaMonkey(packageName);
    }

    const pid = await waitFor(() => this.device.getPid(packageName), {
      timeoutMs: pidTimeoutMs,
      intervalMs: 400,
      description: `the process of ${packageName} to appear`,
    }).catch(() => {
      throw new DeviceError(
        `${packageName} did not start within ${pidTimeoutMs}ms on ${this.device.serial}`,
        {
          hint:
            'The app may have crashed on launch. Check `adb logcat` for a fatal exception, or ' +
            'confirm the device is unlocked and the screen is on.',
        },
      );
    });

    /*
     * A PID is not a launch.
     *
     * `am start -W` reporting "Status: ok" means an activity was started, not
     * that it stayed in front. On a phone with other games resident, one
     * routinely takes the foreground straight back - observed on a real device:
     * the target reported a clean cold launch and three seconds later a
     * different Unity game held the foreground. Since a backgrounded app still
     * has a PID and still reports memory, nothing downstream noticed, and the
     * frame rate recorded was the frame rate of a paused renderer.
     *
     * So the foreground is checked, and the launch repeated a couple of times
     * if something else has it. Repeating is worth trying because the usual
     * cause is a one-off: an ad activity or a resumed task that goes away once
     * the game is brought forward again.
     */
    let foregroundPackage = await this.device.foregroundPackage();
    let launchAttempts = 1;

    while (
      foregroundPackage !== null &&
      foregroundPackage !== packageName &&
      launchAttempts < FOREGROUND_ATTEMPTS
    ) {
      log?.warn('Another app holds the foreground; bringing the game forward again', {
        holding: foregroundPackage,
        attempt: launchAttempts,
      });

      // Stop the interloper when it is not something the device needs. A game
      // that keeps grabbing the foreground will keep doing it otherwise.
      if (foregroundPackage !== packageName) {
        await this.device.shell(['am', 'force-stop', foregroundPackage], 20_000);
      }

      if (launchComponent) await this.device.startActivity(launchComponent);
      else await this.device.startViaMonkey(packageName);

      launchAttempts++;
      await sleep(FOREGROUND_SETTLE_MS);
      foregroundPackage = await this.device.foregroundPackage();
    }

    const foregrounded = foregroundPackage === null || foregroundPackage === packageName;
    if (!foregrounded) {
      log?.warn(
        'The game is not in the foreground - frame-rate figures from this session cannot be trusted',
        { holding: foregroundPackage, attempts: launchAttempts },
      );
    }

    const all = await this.device.getAllPids(packageName);
    const helperProcesses = all.filter((p) => p.pid !== pid);

    if (helperProcesses.length > 0) {
      log?.debug('Helper processes detected (excluded from primary telemetry)', {
        helpers: helperProcesses.map((h) => `${h.name}:${h.pid}`).join(','),
      });
    }

    log?.info('Game launched', {
      package: packageName,
      pid,
      method,
      launchMs: Date.now() - started,
    });

    return {
      packageName,
      pid,
      launchedAt: new Date().toISOString(),
      launchDurationMs: Date.now() - started,
      reportedTotalTimeMs,
      method,
      foregrounded,
      // Null when the game did get the foreground, so a reader is not shown a
      // package name next to a successful launch and left wondering.
      foregroundPackage: foregrounded ? null : foregroundPackage,
      launchAttempts,
      helperProcesses,
    };
  }

  watcher(packageName: string, initialPid: number): ProcessWatcher {
    return new ProcessWatcher(this.device, packageName, initialPid, this.logger);
  }
}

export type ProcessLifecycleEvent =
  | { type: 'alive'; pid: number; at: string }
  | { type: 'gone'; previousPid: number; at: string }
  | { type: 'restarted'; previousPid: number; pid: number; at: string };

/**
 * Polls the package's main PID and reports lifecycle transitions.
 *
 * A `gone` followed by `restarted` is the strongest possible runtime evidence
 * of an OOM kill, so this feeds the anomaly detector directly.
 */
export class ProcessWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private currentPid: number | null;
  private stopped = false;

  constructor(
    private readonly device: AdbDevice,
    readonly packageName: string,
    initialPid: number,
    private readonly logger?: Logger,
    private readonly intervalMs = 2000,
  ) {
    super();
    this.currentPid = initialPid;
  }

  get pid(): number | null {
    return this.currentPid;
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.stopped) return;
      try {
        const pid = await this.device.getPid(this.packageName);
        const at = new Date().toISOString();

        if (pid === null && this.currentPid !== null) {
          const previousPid = this.currentPid;
          this.currentPid = null;
          this.logger?.warn('Game process disappeared', { previousPid });
          this.emit('lifecycle', { type: 'gone', previousPid, at } satisfies ProcessLifecycleEvent);
        } else if (pid !== null && this.currentPid === null) {
          this.logger?.warn('Game process restarted with a new PID', { pid });
          this.emit('lifecycle', {
            type: 'restarted',
            previousPid: 0,
            pid,
            at,
          } satisfies ProcessLifecycleEvent);
          this.currentPid = pid;
        } else if (pid !== null && this.currentPid !== null && pid !== this.currentPid) {
          const previousPid = this.currentPid;
          this.currentPid = pid;
          this.logger?.warn('Game PID changed - the process was killed and relaunched', {
            previousPid,
            pid,
          });
          this.emit('lifecycle', {
            type: 'restarted',
            previousPid,
            pid,
            at,
          } satisfies ProcessLifecycleEvent);
        }
      } catch (err) {
        this.logger?.debug('PID poll failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
      }
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
